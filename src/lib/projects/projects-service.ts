import Decimal from 'decimal.js';
import { listAttachments } from '@/lib/attachments/attachment-service';
import type { DbExecutor } from '@/lib/db/tenant-client';
import {
  calculateLineAmounts,
  calculateProjectProfit,
  calculateQuotationSlip,
  computeMarginPercent,
  type CostCategory,
  type CostTaxMode,
  type RoundingMode,
  type TaxCalcPolicy,
  type TaxCode,
} from '@/lib/domain/calculations';
import {
  renderProjectLedgerPdf,
  renderProjectListPdf,
} from '@/lib/domain/pdf-renderer';
import { COST_CATEGORY_LABELS, type AttachmentDto } from '@/lib/estimates/types';
import { isFeatureEnabled, requireFeature } from '@/lib/feature-flags/gate';
import { mapPgConstraintError, MasterDataError } from '@/lib/masters/error-mapper';
import {
  COST_CATEGORY_LIST,
  PROJECT_STATUS_LABELS,
  type ProjectBudgetBreakdown,
  type ProjectCategoryComparisonItemDto,
  type ProjectCostDetailLineDto,
  type ProjectCostHeaderRefDto,
  type ProjectDetailDto,
  type ProjectInput,
  type ProjectListItemDto,
  type ProjectListSummaryDto,
  type ProjectPageDto,
  type ProjectRelatedOrderDto,
  type ProjectRelatedPurchaseDto,
  type ProjectRelatedQuotationDto,
  type ProjectRelatedSaleDto,
  type ProjectsLookupsDto,
  type ProjectStatus,
} from '@/lib/projects/types';

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DATE_REGEX = /^\d{4}-\d{2}-\d{2}$/;
const VALID_STATUSES = new Set<ProjectStatus>(['C1', 'C2', 'C3']);
const VALID_ROUNDING_MODES = new Set<RoundingMode>(['FLOOR', 'ROUND', 'CEIL']);
const VALID_TAX_CODES = new Set<TaxCode>(['A', 'B', 'C', 'D', 'E']);

export interface ProjectListFilter {
  keyword?: string | null;
  status?: ProjectStatus | null;
  orderKindCode?: string | null;
  employeeId?: string | null;
  dateFrom?: string | null;
  dateTo?: string | null;
  overBudgetOnly?: boolean;
  page?: number;
  pageSize?: number;
}

function validateUuid(id: string, label: string): void {
  if (!UUID_REGEX.test(id)) {
    throw new MasterDataError(400, 'INVALID_ID', `${label}IDの形式が不正です。`);
  }
}

function optTrimmed(val: string | null | undefined): string | null {
  if (val === null || val === undefined) {
    return null;
  }
  const trimmed = val.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function validateDateOnly(val: string, label: string): string {
  const trimmed = val.trim().slice(0, 10);
  if (!DATE_REGEX.test(trimmed)) {
    throw new MasterDataError(400, 'INVALID_DATE', `${label}は YYYY-MM-DD 形式で入力してください。`);
  }
  const parts = trimmed.split('-');
  const y = Number(parts[0]);
  const m = Number(parts[1]);
  const d = Number(parts[2]);
  const check = new Date(Date.UTC(y, m - 1, d));
  if (
    check.getUTCFullYear() !== y ||
    check.getUTCMonth() + 1 !== m ||
    check.getUTCDate() !== d
  ) {
    throw new MasterDataError(400, 'INVALID_DATE', `${label}の日付が存在しません。`);
  }
  return trimmed;
}

function validateOptionalDateOnly(val: string | null | undefined, label: string): string | null {
  const trimmed = optTrimmed(val);
  if (trimmed === null) {
    return null;
  }
  return validateDateOnly(trimmed, label);
}

function validateIntegerYen(val: number, label: string): number {
  if (!Number.isInteger(val) || Math.abs(val) > 999_999_999_999) {
    throw new MasterDataError(400, 'INVALID_AMOUNT', `${label}は整数円で入力してください。`);
  }
  return val;
}

function validateQuantity(val: number, label: string): string {
  if (!Number.isFinite(val) || Math.abs(val) > 99_999_999) {
    throw new MasterDataError(400, 'INVALID_QUANTITY', `${label}の数量が不正です。`);
  }
  return new Decimal(val).toDecimalPlaces(4, Decimal.ROUND_HALF_UP).toString();
}

function escapeCsvCell(value: string): string {
  const escaped = value.replace(/"/g, '""');
  return `"${escaped}"`;
}

function computeConsumptionPercent(actual: bigint, budget: bigint): string {
  if (budget <= 0n) {
    return actual > 0n ? '100.0' : '0.0';
  }
  return new Decimal(actual.toString())
    .div(budget.toString())
    .times('100')
    .toDecimalPlaces(1, Decimal.ROUND_HALF_UP)
    .toFixed(1);
}

export async function getProjectsLookups(
  tx: DbExecutor,
  tenantId: string,
): Promise<ProjectsLookupsDto> {
  const [
    constructionEnabled,
    constructionImageEnabled,
    budgetEnabled,
    costEnabled,
    purchaseEnabled,
    expenseFlag,
    laborFlag,
    materialFlag,
    outsourcingFlag,
    temporaryFlag,
    indirectFlag,
  ] = await Promise.all([
    isFeatureEnabled(tx, tenantId, 'construction'),
    isFeatureEnabled(tx, tenantId, 'constructionimage'),
    isFeatureEnabled(tx, tenantId, 'budget'),
    isFeatureEnabled(tx, tenantId, 'cost'),
    isFeatureEnabled(tx, tenantId, 'purchase'),
    isFeatureEnabled(tx, tenantId, 'expense'),
    isFeatureEnabled(tx, tenantId, 'labor'),
    isFeatureEnabled(tx, tenantId, 'material'),
    isFeatureEnabled(tx, tenantId, 'outsourcing'),
    isFeatureEnabled(tx, tenantId, 'temporary'),
    isFeatureEnabled(tx, tenantId, 'indirect'),
  ]);

  if (!constructionEnabled && !costEnabled) {
    await requireFeature(tx, tenantId, 'construction');
  }

  const settingsRows = await tx.query<{
    opening_balance_date: string;
    cost_tax_mode: CostTaxMode;
    tax_calc_policy: TaxCalcPolicy;
    default_rounding_mode: RoundingMode;
  }>(
    `SELECT opening_balance_date::text AS opening_balance_date,
            cost_tax_mode::text AS cost_tax_mode,
            tax_calc_policy::text AS tax_calc_policy,
            default_rounding_mode::text AS default_rounding_mode
       FROM tenant_settings
      WHERE tenant_id = $1::uuid
      LIMIT 1`,
    [tenantId],
  );
  const settings = settingsRows[0];
  if (settings === undefined) {
    throw new MasterDataError(404, 'TENANT_SETTINGS_NOT_FOUND', '自社設定が見つかりません。');
  }

  const [
    partnerRows,
    employeeRows,
    orderKindRows,
    subStatusRows,
    productRows,
    intelRows,
    unitRows,
    taxRows,
  ] = await Promise.all([
    tx.query<{
      id: string;
      partner_code: string;
      partner_name: string;
      is_individual_honorific: boolean;
      representative_name: string | null;
      is_client: boolean;
    }>(
      `SELECT bp.id, bp.partner_code, bp.partner_name, bp.is_individual_honorific,
              r.representative_name, bp.is_client
         FROM business_partners bp
         LEFT JOIN representatives r ON r.tenant_id = bp.tenant_id AND r.id = bp.representative_id
        WHERE bp.is_deleted = false
        ORDER BY bp.is_client DESC, bp.partner_code ASC`,
      [],
    ),
    tx.query<{ id: string; syain_code: string; syain_name: string }>(
      `SELECT id, syain_code, syain_name
         FROM employees
        WHERE is_retired = false
        ORDER BY syain_code ASC`,
      [],
    ),
    tx.query<{ code: string; name: string }>(
      `SELECT code, name
         FROM code_masters
        WHERE domain_key = 'ORDER_KIND' AND is_active = true
        ORDER BY display_order ASC, code ASC`,
      [],
    ),
    tx.query<{ code: string; name: string }>(
      `SELECT code, name
         FROM code_masters
        WHERE domain_key = 'PROJECT_SUB_STATUS' AND is_active = true
        ORDER BY display_order ASC, code ASC`,
      [],
    ),
    tx.query<{
      id: string;
      product_code: string;
      product_name: string;
      product_name_sub: string | null;
      unit_name: string | null;
      standard_unit_price: string;
      standard_cost_price: string;
      default_tax_code: TaxCode;
      is_heading: boolean;
    }>(
      `SELECT p.id, p.product_code, p.product_name, p.product_name_sub, u.unit_name,
              p.standard_unit_price::text AS standard_unit_price,
              p.standard_cost_price::text AS standard_cost_price,
              p.default_tax_code, p.is_heading
         FROM products p
         LEFT JOIN units u ON u.tenant_id = p.tenant_id AND u.id = p.unit_id
        WHERE p.is_deleted = false
        ORDER BY p.product_code ASC`,
      [],
    ),
    tx.query<{
      id: string;
      item_name: string;
      unit_name: string | null;
      unit_price: string;
      cost_price: string;
      tax_code: TaxCode;
    }>(
      `SELECT id, item_name, unit_name, unit_price::text AS unit_price,
              cost_price::text AS cost_price, tax_code
         FROM input_intelligences
        ORDER BY item_name ASC`,
      [],
    ),
    tx.query<{ id: string; unit_code: string; unit_name: string }>(
      `SELECT id, unit_code, unit_name
         FROM units
        WHERE is_deleted = false
        ORDER BY display_order ASC, unit_code ASC`,
      [],
    ),
    tx.query<{
      tax_code: TaxCode;
      tax_name: string;
      tax_rate: string;
      mark_symbol: string;
      is_internal: boolean;
    }>(
      `SELECT tax_code, tax_name, tax_rate::text AS tax_rate, mark_symbol, is_internal
         FROM tax_codes
        ORDER BY tax_code ASC`,
      [],
    ),
  ]);

  return {
    openingBalanceDate: settings.opening_balance_date.slice(0, 10),
    costTaxMode: settings.cost_tax_mode,
    taxCalcPolicy: settings.tax_calc_policy,
    defaultRoundingMode: settings.default_rounding_mode,
    constructionEnabled,
    constructionImageEnabled,
    budgetEnabled,
    costEnabled,
    purchaseEnabled,
    categoryFlags: {
      EXPENSE: expenseFlag,
      LABOR: laborFlag,
      MATERIAL: materialFlag,
      OUTSOURCING: outsourcingFlag,
      TEMPORARY: temporaryFlag,
      INDIRECT: indirectFlag,
    },
    partners: partnerRows.map((r) => ({
      id: r.id,
      partnerCode: r.partner_code,
      partnerName: r.partner_name,
      isIndividualHonorific: r.is_individual_honorific,
      representativeName: r.representative_name,
      isClient: r.is_client,
    })),
    employees: employeeRows.map((e) => ({
      id: e.id,
      syainCode: e.syain_code,
      syainName: e.syain_name,
    })),
    orderKinds: orderKindRows,
    subStatuses: subStatusRows,
    products: productRows.map((p) => ({
      id: p.id,
      productCode: p.product_code,
      productName: p.product_name,
      productNameSub: p.product_name_sub,
      unitName: p.unit_name,
      standardUnitPrice: Number(p.standard_unit_price),
      standardCostPrice: Number(p.standard_cost_price),
      defaultTaxCode: p.default_tax_code,
      isHeading: p.is_heading,
    })),
    intelligences: intelRows.map((i) => ({
      id: i.id,
      itemName: i.item_name,
      unitName: i.unit_name,
      unitPrice: Number(i.unit_price),
      costPrice: Number(i.cost_price),
      taxCode: i.tax_code,
    })),
    units: unitRows.map((u) => ({
      id: u.id,
      unitCode: u.unit_code,
      unitName: u.unit_name,
    })),
    taxCodes: taxRows.map((tc) => ({
      taxCode: tc.tax_code,
      taxName: tc.tax_name,
      taxRate: Number(tc.tax_rate),
      markSymbol: tc.mark_symbol,
      isInternal: tc.is_internal,
    })),
  };
}

interface CleanProjectPayload {
  projectNo: number | null;
  projectName: string;
  projectDate: string;
  sitePlace: string | null;
  partnerId: string;
  orderKindCode: string | null;
  subStatusCode: string | null;
  status: ProjectStatus;
  periodStartDate: string | null;
  periodEndDate: string | null;
  actualStartDate: string | null;
  tempFinishDate: string | null;
  finishDate: string | null;
  salesEmployeeId: string | null;
  siteEmployeeId: string | null;
  unitName: string;
  contractUnitPrice: number;
  contractQuantityStr: string;
  taxCode: TaxCode;
  roundingMode: RoundingMode;
  budgets: ProjectBudgetBreakdown;
  remarks: string | null;
}

function validateProjectInput(input: ProjectInput): CleanProjectPayload {
  const projectName = input.projectName.trim();
  if (projectName.length === 0 || projectName.length > 200) {
    throw new MasterDataError(400, 'INVALID_PROJECT_NAME', '案件名は1〜200文字で入力してください。');
  }
  const projectDate = validateDateOnly(input.projectDate, '受注日');
  validateUuid(input.partnerId, '発注元取引先');

  let salesEmployeeId: string | null = null;
  if (input.salesEmployeeId !== null && input.salesEmployeeId.trim() !== '') {
    validateUuid(input.salesEmployeeId.trim(), '営業担当者');
    salesEmployeeId = input.salesEmployeeId.trim();
  }
  let siteEmployeeId: string | null = null;
  if (input.siteEmployeeId !== null && input.siteEmployeeId.trim() !== '') {
    validateUuid(input.siteEmployeeId.trim(), '現場担当者');
    siteEmployeeId = input.siteEmployeeId.trim();
  }

  if (!VALID_STATUSES.has(input.status)) {
    throw new MasterDataError(400, 'INVALID_STATUS', '案件ステータスは C1〜C3 を指定してください。');
  }
  if (!VALID_TAX_CODES.has(input.taxCode)) {
    throw new MasterDataError(400, 'INVALID_TAX_CODE', '税区分は A〜E を指定してください。');
  }
  if (!VALID_ROUNDING_MODES.has(input.roundingMode)) {
    throw new MasterDataError(400, 'INVALID_ROUNDING_MODE', '端数処理が不正です。');
  }

  const unitName = input.unitName.trim();
  if (unitName.length === 0 || unitName.length > 30) {
    throw new MasterDataError(400, 'INVALID_UNIT_NAME', '契約単位は1〜30文字で入力してください。');
  }

  const contractUnitPrice = validateIntegerYen(input.contractUnitPrice, '契約単価');
  const contractQuantityStr = validateQuantity(input.contractQuantity, '契約数量');

  const budgets: ProjectBudgetBreakdown = {
    EXPENSE: validateIntegerYen(input.budgets.EXPENSE, '経費予算'),
    LABOR: validateIntegerYen(input.budgets.LABOR, '労務費予算'),
    MATERIAL: validateIntegerYen(input.budgets.MATERIAL, '材料費予算'),
    OUTSOURCING: validateIntegerYen(input.budgets.OUTSOURCING, '外注費予算'),
    TEMPORARY: validateIntegerYen(input.budgets.TEMPORARY, '仮設費予算'),
    INDIRECT: validateIntegerYen(input.budgets.INDIRECT, '間接費予算'),
  };

  return {
    projectNo:
      input.projectNo !== undefined && input.projectNo !== null ? Number(input.projectNo) : null,
    projectName,
    projectDate,
    sitePlace: optTrimmed(input.sitePlace),
    partnerId: input.partnerId.trim(),
    orderKindCode: optTrimmed(input.orderKindCode),
    subStatusCode: optTrimmed(input.subStatusCode),
    status: input.status,
    periodStartDate: validateOptionalDateOnly(input.periodStartDate, '工期開始日'),
    periodEndDate: validateOptionalDateOnly(input.periodEndDate, '工期終了日'),
    actualStartDate: validateOptionalDateOnly(input.actualStartDate, '着工日'),
    tempFinishDate: validateOptionalDateOnly(input.tempFinishDate, '仮完了日'),
    finishDate: validateOptionalDateOnly(input.finishDate, '完了日'),
    salesEmployeeId,
    siteEmployeeId,
    unitName,
    contractUnitPrice,
    contractQuantityStr,
    taxCode: input.taxCode,
    roundingMode: input.roundingMode,
    budgets,
    remarks: optTrimmed(input.remarks),
  };
}

export async function listProjects(
  tx: DbExecutor,
  tenantId: string,
  filter: ProjectListFilter = {},
): Promise<ProjectPageDto> {
  await requireFeature(tx, tenantId, 'construction');

  const tsRows = await tx.query<{ cost_tax_mode: CostTaxMode }>(
    'SELECT cost_tax_mode::text AS cost_tax_mode FROM tenant_settings WHERE tenant_id = $1::uuid LIMIT 1',
    [tenantId],
  );
  const costTaxMode: CostTaxMode =
    tsRows[0] !== undefined ? tsRows[0].cost_tax_mode : 'TAX_EXCLUDED';

  const kw = optTrimmed(filter.keyword);
  const status =
    filter.status !== undefined && filter.status !== null && VALID_STATUSES.has(filter.status)
      ? filter.status
      : null;
  const orderKindCode = optTrimmed(filter.orderKindCode);
  const rawEmployee = optTrimmed(filter.employeeId);
  if (rawEmployee !== null) {
    validateUuid(rawEmployee, '担当者');
  }
  const rawFrom = optTrimmed(filter.dateFrom);
  const dateFrom = rawFrom !== null && DATE_REGEX.test(rawFrom) ? rawFrom : null;
  const rawTo = optTrimmed(filter.dateTo);
  const dateTo = rawTo !== null && DATE_REGEX.test(rawTo) ? rawTo : null;
  const overBudgetOnly = filter.overBudgetOnly === true;

  const rawPage = filter.page === undefined ? 1 : filter.page;
  const rawSize = filter.pageSize === undefined ? 25 : filter.pageSize;
  const page = Number.isInteger(rawPage) && rawPage >= 1 ? rawPage : 1;
  const pageSize = Number.isInteger(rawSize) && rawSize >= 1 && rawSize <= 5000 ? rawSize : 25;

  const rows = await tx.query<{
    id: string;
    project_no: string;
    project_name: string;
    project_date: string;
    site_place: string | null;
    partner_id: string;
    partner_code: string;
    partner_name: string;
    order_kind_code: string | null;
    order_kind_name: string | null;
    sub_status_code: string | null;
    sub_status_name: string | null;
    status: ProjectStatus;
    sales_employee_id: string | null;
    sales_employee_name: string | null;
    site_employee_id: string | null;
    site_employee_name: string | null;
    period_start_date: string | null;
    period_end_date: string | null;
    contract_subtotal: string;
    contract_tax: string;
    contract_total: string;
    budget_expense: string;
    budget_labor: string;
    budget_material: string;
    budget_outsourcing: string;
    budget_temporary: string;
    budget_indirect: string;
    actual_excl_expense: string;
    actual_excl_labor: string;
    actual_excl_material: string;
    actual_excl_outsourcing: string;
    actual_excl_temporary: string;
    actual_excl_indirect: string;
    actual_incl_expense: string;
    actual_incl_labor: string;
    actual_incl_material: string;
    actual_incl_outsourcing: string;
    actual_incl_temporary: string;
    actual_incl_indirect: string;
    actual_excl_total: string;
    actual_incl_total: string;
    sales_excl_total: string;
    sales_incl_total: string;
    cost_header_count: number;
    updated_at: string;
  }>(
    `SELECT pj.id, pj.project_no::text AS project_no, pj.project_name,
            pj.project_date::text AS project_date, pj.site_place,
            pj.partner_id, bp.partner_code, bp.partner_name,
            pj.order_kind_code, cm_ok.name AS order_kind_name,
            pj.sub_status_code, cm_ss.name AS sub_status_name,
            pj.status::text AS status,
            pj.sales_employee_id, es.syain_name AS sales_employee_name,
            pj.site_employee_id, ef.syain_name AS site_employee_name,
            pj.period_start_date::text AS period_start_date,
            pj.period_end_date::text AS period_end_date,
            pj.contract_subtotal::text AS contract_subtotal,
            pj.contract_tax::text AS contract_tax,
            pj.contract_total::text AS contract_total,
            pj.budget_expense::text AS budget_expense,
            pj.budget_labor::text AS budget_labor,
            pj.budget_material::text AS budget_material,
            pj.budget_outsourcing::text AS budget_outsourcing,
            pj.budget_temporary::text AS budget_temporary,
            pj.budget_indirect::text AS budget_indirect,
            COALESCE(ch_agg.excl_expense, 0)::text AS actual_excl_expense,
            COALESCE(ch_agg.excl_labor, 0)::text AS actual_excl_labor,
            COALESCE(ch_agg.excl_material, 0)::text AS actual_excl_material,
            COALESCE(ch_agg.excl_outsourcing, 0)::text AS actual_excl_outsourcing,
            COALESCE(ch_agg.excl_temporary, 0)::text AS actual_excl_temporary,
            COALESCE(ch_agg.excl_indirect, 0)::text AS actual_excl_indirect,
            COALESCE(ch_agg.incl_expense, 0)::text AS actual_incl_expense,
            COALESCE(ch_agg.incl_labor, 0)::text AS actual_incl_labor,
            COALESCE(ch_agg.incl_material, 0)::text AS actual_incl_material,
            COALESCE(ch_agg.incl_outsourcing, 0)::text AS actual_incl_outsourcing,
            COALESCE(ch_agg.incl_temporary, 0)::text AS actual_incl_temporary,
            COALESCE(ch_agg.incl_indirect, 0)::text AS actual_incl_indirect,
            COALESCE(ch_agg.excl_total, 0)::text AS actual_excl_total,
            COALESCE(ch_agg.incl_total, 0)::text AS actual_incl_total,
            COALESCE(sh_agg.sales_excl, 0)::text AS sales_excl_total,
            COALESCE(sh_agg.sales_incl, 0)::text AS sales_incl_total,
            COALESCE(ch_agg.header_cnt, 0)::int AS cost_header_count,
            pj.updated_at::text AS updated_at
       FROM projects pj
       JOIN business_partners bp ON bp.tenant_id = pj.tenant_id AND bp.id = pj.partner_id
       LEFT JOIN code_masters cm_ok
         ON cm_ok.tenant_id = pj.tenant_id AND cm_ok.domain_key = 'ORDER_KIND' AND cm_ok.code = pj.order_kind_code
       LEFT JOIN code_masters cm_ss
         ON cm_ss.tenant_id = pj.tenant_id AND cm_ss.domain_key = 'PROJECT_SUB_STATUS' AND cm_ss.code = pj.sub_status_code
       LEFT JOIN employees es ON es.tenant_id = pj.tenant_id AND es.id = pj.sales_employee_id
       LEFT JOIN employees ef ON ef.tenant_id = pj.tenant_id AND ef.id = pj.site_employee_id
       LEFT JOIN (
         SELECT project_id,
                COUNT(*)::int AS header_cnt,
                COALESCE(SUM(subtotal_amount) FILTER (WHERE cost_category = 'EXPENSE'), 0) AS excl_expense,
                COALESCE(SUM(subtotal_amount) FILTER (WHERE cost_category = 'LABOR'), 0) AS excl_labor,
                COALESCE(SUM(subtotal_amount) FILTER (WHERE cost_category = 'MATERIAL'), 0) AS excl_material,
                COALESCE(SUM(subtotal_amount) FILTER (WHERE cost_category = 'OUTSOURCING'), 0) AS excl_outsourcing,
                COALESCE(SUM(subtotal_amount) FILTER (WHERE cost_category = 'TEMPORARY'), 0) AS excl_temporary,
                COALESCE(SUM(subtotal_amount) FILTER (WHERE cost_category = 'INDIRECT'), 0) AS excl_indirect,
                COALESCE(SUM(total_amount) FILTER (WHERE cost_category = 'EXPENSE'), 0) AS incl_expense,
                COALESCE(SUM(total_amount) FILTER (WHERE cost_category = 'LABOR'), 0) AS incl_labor,
                COALESCE(SUM(total_amount) FILTER (WHERE cost_category = 'MATERIAL'), 0) AS incl_material,
                COALESCE(SUM(total_amount) FILTER (WHERE cost_category = 'OUTSOURCING'), 0) AS incl_outsourcing,
                COALESCE(SUM(total_amount) FILTER (WHERE cost_category = 'TEMPORARY'), 0) AS incl_temporary,
                COALESCE(SUM(total_amount) FILTER (WHERE cost_category = 'INDIRECT'), 0) AS incl_indirect,
                COALESCE(SUM(subtotal_amount), 0) AS excl_total,
                COALESCE(SUM(total_amount), 0) AS incl_total
           FROM project_cost_headers
          GROUP BY project_id
       ) ch_agg ON ch_agg.project_id = pj.id
       LEFT JOIN (
         SELECT project_id,
                COALESCE(SUM(subtotal_amount) FILTER (WHERE entry_type = 'SALE'), 0) AS sales_excl,
                COALESCE(SUM(total_amount) FILTER (WHERE entry_type = 'SALE'), 0) AS sales_incl
           FROM sales_headers
          WHERE project_id IS NOT NULL
          GROUP BY project_id
       ) sh_agg ON sh_agg.project_id = pj.id
      WHERE ($1::text IS NULL OR pj.project_no::text = $1
             OR pj.project_name ILIKE '%' || $1 || '%'
             OR COALESCE(pj.site_place, '') ILIKE '%' || $1 || '%'
             OR bp.partner_name ILIKE '%' || $1 || '%'
             OR pj.partner_name_snap ILIKE '%' || $1 || '%')
        AND ($2::text IS NULL OR pj.status::text = $2)
        AND ($3::text IS NULL OR pj.order_kind_code = $3)
        AND ($4::uuid IS NULL OR pj.sales_employee_id = $4::uuid OR pj.site_employee_id = $4::uuid)
        AND ($5::date IS NULL OR pj.project_date >= $5::date)
        AND ($6::date IS NULL OR pj.project_date <= $6::date)
      ORDER BY pj.project_date DESC, pj.project_no DESC`,
    [kw, status, orderKindCode, rawEmployee, dateFrom, dateTo],
  );

  const allMapped: ProjectListItemDto[] = [];
  let sumContractSubtotal = 0n;
  let sumContractTotal = 0n;
  let sumBudgetTotal = 0n;
  let sumActualExclTotal = 0n;
  let sumActualInclTotal = 0n;
  let sumActualEvalTotal = 0n;
  let sumSalesIncl = 0n;
  let sumBudgetGrossProfit = 0n;
  let sumActualGrossProfit = 0n;
  let overBudgetCount = 0;

  for (const r of rows) {
    const profit = calculateProjectProfit({
      costTaxMode,
      contractSubtotal: BigInt(r.contract_subtotal),
      contractTotal: BigInt(r.contract_total),
      budgets: {
        EXPENSE: BigInt(r.budget_expense),
        LABOR: BigInt(r.budget_labor),
        MATERIAL: BigInt(r.budget_material),
        OUTSOURCING: BigInt(r.budget_outsourcing),
        TEMPORARY: BigInt(r.budget_temporary),
        INDIRECT: BigInt(r.budget_indirect),
      },
      actualCostsExcl: {
        EXPENSE: BigInt(r.actual_excl_expense),
        LABOR: BigInt(r.actual_excl_labor),
        MATERIAL: BigInt(r.actual_excl_material),
        OUTSOURCING: BigInt(r.actual_excl_outsourcing),
        TEMPORARY: BigInt(r.actual_excl_temporary),
        INDIRECT: BigInt(r.actual_excl_indirect),
      },
      actualCostsIncl: {
        EXPENSE: BigInt(r.actual_incl_expense),
        LABOR: BigInt(r.actual_incl_labor),
        MATERIAL: BigInt(r.actual_incl_material),
        OUTSOURCING: BigInt(r.actual_incl_outsourcing),
        TEMPORARY: BigInt(r.actual_incl_temporary),
        INDIRECT: BigInt(r.actual_incl_indirect),
      },
    });

    const isOverBudget = profit.budgetVarianceTotal < 0n;
    if (overBudgetOnly && !isOverBudget) {
      continue;
    }
    if (isOverBudget) {
      overBudgetCount += 1;
    }

    const actualExclTotal = BigInt(r.actual_excl_total);
    const actualInclTotal = BigInt(r.actual_incl_total);
    const salesExcl = BigInt(r.sales_excl_total);
    const salesIncl = BigInt(r.sales_incl_total);

    sumContractSubtotal += BigInt(r.contract_subtotal);
    sumContractTotal += BigInt(r.contract_total);
    sumBudgetTotal += profit.budgetTotal;
    sumActualExclTotal += actualExclTotal;
    sumActualInclTotal += actualInclTotal;
    sumActualEvalTotal += profit.actualCostTotal;
    sumSalesIncl += salesIncl;
    sumBudgetGrossProfit += profit.budgetGrossProfit;
    sumActualGrossProfit += profit.actualGrossProfit;

    allMapped.push({
      id: r.id,
      projectNo: Number(r.project_no),
      projectName: r.project_name,
      projectDate: r.project_date.slice(0, 10),
      sitePlace: r.site_place,
      partnerId: r.partner_id,
      partnerCode: r.partner_code,
      partnerName: r.partner_name,
      orderKindCode: r.order_kind_code,
      orderKindName: r.order_kind_name,
      subStatusCode: r.sub_status_code,
      subStatusName: r.sub_status_name,
      status: r.status,
      salesEmployeeId: r.sales_employee_id,
      salesEmployeeName: r.sales_employee_name,
      siteEmployeeId: r.site_employee_id,
      siteEmployeeName: r.site_employee_name,
      periodStartDate: r.period_start_date !== null ? r.period_start_date.slice(0, 10) : null,
      periodEndDate: r.period_end_date !== null ? r.period_end_date.slice(0, 10) : null,
      contractSubtotal: Number(r.contract_subtotal),
      contractTax: Number(r.contract_tax),
      contractTotal: Number(r.contract_total),
      budgetTotal: Number(profit.budgetTotal),
      actualCostExclTotal: Number(actualExclTotal),
      actualCostInclTotal: Number(actualInclTotal),
      actualCostEvalTotal: Number(profit.actualCostTotal),
      salesRecordedExcl: Number(salesExcl),
      salesRecordedIncl: Number(salesIncl),
      budgetGrossProfit: Number(profit.budgetGrossProfit),
      actualGrossProfit: Number(profit.actualGrossProfit),
      actualGrossMarginPercent: profit.actualGrossMarginPercent,
      budgetVarianceTotal: Number(profit.budgetVarianceTotal),
      isOverBudget,
      costHeaderCount: Number(r.cost_header_count),
      updatedAt: r.updated_at,
    });
  }

  const offset = (page - 1) * pageSize;
  const pagedItems = allMapped.slice(offset, offset + pageSize);

  const summary: ProjectListSummaryDto = {
    totalCount: allMapped.length,
    contractSubtotal: Number(sumContractSubtotal),
    contractTotal: Number(sumContractTotal),
    budgetTotal: Number(sumBudgetTotal),
    actualCostExclTotal: Number(sumActualExclTotal),
    actualCostInclTotal: Number(sumActualInclTotal),
    actualCostEvalTotal: Number(sumActualEvalTotal),
    salesRecordedIncl: Number(sumSalesIncl),
    budgetGrossProfit: Number(sumBudgetGrossProfit),
    actualGrossProfit: Number(sumActualGrossProfit),
    overBudgetCount,
  };

  return {
    items: pagedItems,
    summary,
    costTaxMode,
    page,
    pageSize,
  };
}

export async function getProjectDetail(
  tx: DbExecutor,
  tenantId: string,
  projectId: string,
): Promise<ProjectDetailDto> {
  validateUuid(projectId, '案件');
  await requireFeature(tx, tenantId, 'construction');

  const [tsRows, constructionImageEnabled] = await Promise.all([
    tx.query<{ cost_tax_mode: CostTaxMode }>(
      'SELECT cost_tax_mode::text AS cost_tax_mode FROM tenant_settings WHERE tenant_id = $1::uuid LIMIT 1',
      [tenantId],
    ),
    isFeatureEnabled(tx, tenantId, 'constructionimage'),
  ]);
  const costTaxMode: CostTaxMode =
    tsRows[0] !== undefined ? tsRows[0].cost_tax_mode : 'TAX_EXCLUDED';

  const rows = await tx.query<{
    id: string;
    project_no: string;
    project_name: string;
    project_date: string;
    site_place: string | null;
    partner_id: string;
    partner_code: string;
    partner_name: string;
    partner_name_snap: string;
    order_kind_code: string | null;
    order_kind_name: string | null;
    sub_status_code: string | null;
    sub_status_name: string | null;
    status: ProjectStatus;
    period_start_date: string | null;
    period_end_date: string | null;
    actual_start_date: string | null;
    temp_finish_date: string | null;
    finish_date: string | null;
    sales_employee_id: string | null;
    sales_employee_name: string | null;
    site_employee_id: string | null;
    site_employee_name: string | null;
    unit_name: string;
    contract_unit_price: string;
    contract_quantity: string;
    contract_subtotal: string;
    contract_tax: string;
    contract_total: string;
    tax_code: TaxCode;
    rounding_mode: RoundingMode;
    budget_expense: string;
    budget_labor: string;
    budget_material: string;
    budget_outsourcing: string;
    budget_temporary: string;
    budget_indirect: string;
    source_quotation_no: string | null;
    bill_no: string | null;
    bill_date: string | null;
    remarks: string | null;
    created_at: string;
    updated_at: string;
  }>(
    `SELECT pj.id, pj.project_no::text AS project_no, pj.project_name,
            pj.project_date::text AS project_date, pj.site_place,
            pj.partner_id, bp.partner_code, bp.partner_name, pj.partner_name_snap,
            pj.order_kind_code, cm_ok.name AS order_kind_name,
            pj.sub_status_code, cm_ss.name AS sub_status_name,
            pj.status::text AS status,
            pj.period_start_date::text AS period_start_date,
            pj.period_end_date::text AS period_end_date,
            pj.actual_start_date::text AS actual_start_date,
            pj.temp_finish_date::text AS temp_finish_date,
            pj.finish_date::text AS finish_date,
            pj.sales_employee_id, es.syain_name AS sales_employee_name,
            pj.site_employee_id, ef.syain_name AS site_employee_name,
            pj.unit_name,
            pj.contract_unit_price::text AS contract_unit_price,
            pj.contract_quantity::text AS contract_quantity,
            pj.contract_subtotal::text AS contract_subtotal,
            pj.contract_tax::text AS contract_tax,
            pj.contract_total::text AS contract_total,
            pj.tax_code, pj.rounding_mode::text AS rounding_mode,
            pj.budget_expense::text AS budget_expense,
            pj.budget_labor::text AS budget_labor,
            pj.budget_material::text AS budget_material,
            pj.budget_outsourcing::text AS budget_outsourcing,
            pj.budget_temporary::text AS budget_temporary,
            pj.budget_indirect::text AS budget_indirect,
            pj.source_quotation_no::text AS source_quotation_no,
            pj.bill_no::text AS bill_no,
            pj.bill_date::text AS bill_date,
            pj.remarks,
            pj.created_at::text AS created_at,
            pj.updated_at::text AS updated_at
       FROM projects pj
       JOIN business_partners bp ON bp.tenant_id = pj.tenant_id AND bp.id = pj.partner_id
       LEFT JOIN code_masters cm_ok
         ON cm_ok.tenant_id = pj.tenant_id AND cm_ok.domain_key = 'ORDER_KIND' AND cm_ok.code = pj.order_kind_code
       LEFT JOIN code_masters cm_ss
         ON cm_ss.tenant_id = pj.tenant_id AND cm_ss.domain_key = 'PROJECT_SUB_STATUS' AND cm_ss.code = pj.sub_status_code
       LEFT JOIN employees es ON es.tenant_id = pj.tenant_id AND es.id = pj.sales_employee_id
       LEFT JOIN employees ef ON ef.tenant_id = pj.tenant_id AND ef.id = pj.site_employee_id
      WHERE pj.id = $1::uuid
      LIMIT 1`,
    [projectId],
  );
  const p = rows[0];
  if (p === undefined) {
    throw new MasterDataError(404, 'PROJECT_NOT_FOUND', '対象の案件データが見つかりません。');
  }

  const [costHeaderRows, costLineRows, qRows, sRows, poRows, purRows] = await Promise.all([
    tx.query<{
      id: string;
      cost_category: CostCategory;
      slip_title: string;
      entry_date: string;
      status: ProjectStatus;
      subtotal_amount: string;
      tax_total: string;
      total_amount: string;
      line_count: number;
    }>(
      `SELECT h.id, h.cost_category::text AS cost_category, h.slip_title,
              h.entry_date::text AS entry_date, h.status::text AS status,
              h.subtotal_amount::text AS subtotal_amount,
              h.tax_total::text AS tax_total,
              h.total_amount::text AS total_amount,
              (SELECT COUNT(*)::int FROM project_cost_lines l WHERE l.cost_header_id = h.id) AS line_count
         FROM project_cost_headers h
        WHERE h.project_id = $1::uuid
        ORDER BY h.entry_date DESC, h.created_at DESC`,
      [projectId],
    ),
    tx.query<{
      cost_header_id: string;
      entry_date: string;
      cost_category: CostCategory;
      slip_title: string;
      line_no: number;
      item_code: string | null;
      item_name: string;
      unit_name: string | null;
      quantity: string;
      tax_code: TaxCode;
      applied_unit_price: string;
      line_amount: string;
      line_tax: string;
      line_total: string;
      remarks: string | null;
    }>(
      `SELECT h.id AS cost_header_id, h.entry_date::text AS entry_date,
              h.cost_category::text AS cost_category, h.slip_title,
              l.line_no, l.item_code, l.item_name, l.unit_name,
              l.quantity::text AS quantity, l.tax_code,
              l.applied_unit_price::text AS applied_unit_price,
              l.line_amount::text AS line_amount,
              l.line_tax::text AS line_tax,
              l.line_total::text AS line_total,
              l.remarks
         FROM project_cost_lines l
         JOIN project_cost_headers h ON h.tenant_id = l.tenant_id AND h.id = l.cost_header_id
        WHERE h.project_id = $1::uuid
        ORDER BY h.entry_date DESC, h.cost_category ASC, l.line_no ASC`,
      [projectId],
    ),
    tx.query<{
      id: string;
      quotation_no: string;
      quotation_name: string;
      quotation_date: string;
      status: string;
      is_selected: boolean;
      subtotal_amount: string;
      total_amount: string;
      cost_subtotal: string;
      cost_total: string;
    }>(
      `SELECT q.id, q.quotation_no::text AS quotation_no, q.quotation_name,
              q.quotation_date::text AS quotation_date, q.status::text AS status,
              q.is_selected,
              q.subtotal_amount::text AS subtotal_amount,
              q.total_amount::text AS total_amount,
              COALESCE((
                SELECT SUM(ql.cost_amount - CASE WHEN ql.tax_code IN ('D','E') THEN ql.cost_tax ELSE 0 END)
                  FROM quotation_lines ql WHERE ql.quotation_id = q.id
              ), 0)::text AS cost_subtotal,
              COALESCE((
                SELECT SUM(ql.cost_total) FROM quotation_lines ql WHERE ql.quotation_id = q.id
              ), 0)::text AS cost_total
         FROM quotations q
        WHERE q.project_id = $1::uuid
        ORDER BY q.quotation_date DESC, q.quotation_no DESC`,
      [projectId],
    ),
    tx.query<{
      id: string;
      entry_type: 'SALE' | 'ADVANCE';
      slip_no: string;
      slip_name: string;
      slip_date: string;
      status: string;
      subtotal_amount: string;
      total_amount: string;
    }>(
      `SELECT id, entry_type::text AS entry_type, slip_no::text AS slip_no,
              slip_name, slip_date::text AS slip_date, status::text AS status,
              subtotal_amount::text AS subtotal_amount, total_amount::text AS total_amount
         FROM sales_headers
        WHERE project_id = $1::uuid
        ORDER BY slip_date DESC, slip_no DESC`,
      [projectId],
    ),
    tx.query<{
      id: string;
      order_no: string;
      order_name: string;
      order_date: string;
      supplier_name: string;
      status: string;
      total_amount: string;
    }>(
      `SELECT po.id, po.order_no::text AS order_no, po.order_name,
              po.order_date::text AS order_date, bp.partner_name AS supplier_name,
              po.status::text AS status, po.total_amount::text AS total_amount
         FROM purchase_orders po
         JOIN business_partners bp ON bp.tenant_id = po.tenant_id AND bp.id = po.supplier_id
        WHERE po.project_id = $1::uuid
        ORDER BY po.order_date DESC, po.order_no DESC`,
      [projectId],
    ),
    tx.query<{
      id: string;
      purchase_no: string;
      purchase_name: string;
      purchase_date: string;
      supplier_name: string;
      status: string;
      line_sub: string;
      line_tot: string;
    }>(
      `SELECT pur.id, pur.purchase_no::text AS purchase_no, pur.purchase_name,
              pur.purchase_date::text AS purchase_date, bp.partner_name AS supplier_name,
              pur.status::text AS status,
              SUM(pl.line_amount - CASE WHEN pl.tax_code IN ('D','E') THEN pl.line_tax ELSE 0 END)::text AS line_sub,
              SUM(pl.line_total)::text AS line_tot
         FROM purchases pur
         JOIN purchase_lines pl ON pl.tenant_id = pur.tenant_id AND pl.purchase_id = pur.id
         JOIN business_partners bp ON bp.tenant_id = pur.tenant_id AND bp.id = pur.supplier_id
        WHERE pl.project_id = $1::uuid
        GROUP BY pur.id, pur.purchase_no, pur.purchase_name, pur.purchase_date, bp.partner_name, pur.status
        ORDER BY pur.purchase_date DESC, pur.purchase_no DESC`,
      [projectId],
    ),
  ]);

  let attachments: AttachmentDto[] = [];
  if (constructionImageEnabled) {
    attachments = await listAttachments(tx, tenantId, 'PROJECT', projectId);
  }

  const budgetsBig: Record<CostCategory, bigint> = {
    EXPENSE: BigInt(p.budget_expense),
    LABOR: BigInt(p.budget_labor),
    MATERIAL: BigInt(p.budget_material),
    OUTSOURCING: BigInt(p.budget_outsourcing),
    TEMPORARY: BigInt(p.budget_temporary),
    INDIRECT: BigInt(p.budget_indirect),
  };

  const actualExclBig: Record<CostCategory, bigint> = {
    EXPENSE: 0n,
    LABOR: 0n,
    MATERIAL: 0n,
    OUTSOURCING: 0n,
    TEMPORARY: 0n,
    INDIRECT: 0n,
  };
  const actualInclBig: Record<CostCategory, bigint> = {
    EXPENSE: 0n,
    LABOR: 0n,
    MATERIAL: 0n,
    OUTSOURCING: 0n,
    TEMPORARY: 0n,
    INDIRECT: 0n,
  };

  for (const ch of costHeaderRows) {
    actualExclBig[ch.cost_category] += BigInt(ch.subtotal_amount);
    actualInclBig[ch.cost_category] += BigInt(ch.total_amount);
  }

  const profit = calculateProjectProfit({
    costTaxMode,
    contractSubtotal: BigInt(p.contract_subtotal),
    contractTotal: BigInt(p.contract_total),
    budgets: budgetsBig,
    actualCostsExcl: actualExclBig,
    actualCostsIncl: actualInclBig,
  });

  let salesRecordedExcl = 0n;
  let salesRecordedIncl = 0n;
  let advanceRecordedIncl = 0n;
  for (const sh of sRows) {
    if (sh.entry_type === 'SALE') {
      salesRecordedExcl += BigInt(sh.subtotal_amount);
      salesRecordedIncl += BigInt(sh.total_amount);
    } else {
      advanceRecordedIncl += BigInt(sh.total_amount);
    }
  }

  let actualCostExclTotal = 0n;
  let actualCostInclTotal = 0n;
  for (const cat of COST_CATEGORY_LIST) {
    actualCostExclTotal += actualExclBig[cat];
    actualCostInclTotal += actualInclBig[cat];
  }

  const salesEval = costTaxMode === 'TAX_EXCLUDED' ? salesRecordedExcl : salesRecordedIncl;
  const salesBasedGrossProfit = salesEval - profit.actualCostTotal;
  const salesBasedGrossMarginPercent = computeMarginPercent(salesBasedGrossProfit, salesEval);

  const categoryComparisons: ProjectCategoryComparisonItemDto[] = COST_CATEGORY_LIST.map((cat) => {
    const budgetAmt = budgetsBig[cat];
    const exclAmt = actualExclBig[cat];
    const inclAmt = actualInclBig[cat];
    const evalAmt = costTaxMode === 'TAX_EXCLUDED' ? exclAmt : inclAmt;
    const variance = budgetAmt - evalAmt;
    return {
      category: cat,
      categoryLabel: COST_CATEGORY_LABELS[cat],
      budgetAmount: Number(budgetAmt),
      actualExclAmount: Number(exclAmt),
      actualInclAmount: Number(inclAmt),
      actualEvalAmount: Number(evalAmt),
      varianceAmount: Number(variance),
      consumptionRatePercent: computeConsumptionPercent(evalAmt, budgetAmt),
      isOverBudget: variance < 0n,
    };
  });

  const costHeaders: ProjectCostHeaderRefDto[] = costHeaderRows.map((ch) => ({
    id: ch.id,
    costCategory: ch.cost_category,
    categoryLabel: COST_CATEGORY_LABELS[ch.cost_category],
    slipTitle: ch.slip_title,
    entryDate: ch.entry_date.slice(0, 10),
    status: ch.status,
    subtotalAmount: Number(ch.subtotal_amount),
    taxTotal: Number(ch.tax_total),
    totalAmount: Number(ch.total_amount),
    lineCount: Number(ch.line_count),
  }));

  const costLines: ProjectCostDetailLineDto[] = costLineRows.map((ln) => ({
    costHeaderId: ln.cost_header_id,
    entryDate: ln.entry_date.slice(0, 10),
    costCategory: ln.cost_category,
    categoryLabel: COST_CATEGORY_LABELS[ln.cost_category],
    slipTitle: ln.slip_title,
    lineNo: Number(ln.line_no),
    itemCode: ln.item_code,
    itemName: ln.item_name,
    unitName: ln.unit_name,
    quantity: Number(ln.quantity),
    taxCode: ln.tax_code,
    appliedUnitPrice: Number(ln.applied_unit_price),
    lineAmount: Number(ln.line_amount),
    lineTax: Number(ln.line_tax),
    lineTotal: Number(ln.line_total),
    remarks: ln.remarks,
  }));

  const relatedQuotations: ProjectRelatedQuotationDto[] = qRows.map((q) => ({
    id: q.id,
    quotationNo: Number(q.quotation_no),
    quotationName: q.quotation_name,
    quotationDate: q.quotation_date.slice(0, 10),
    status: q.status,
    isSelected: q.is_selected,
    subtotalAmount: Number(q.subtotal_amount),
    totalAmount: Number(q.total_amount),
    costSubtotal: Number(q.cost_subtotal),
    costTotal: Number(q.cost_total),
  }));

  const relatedSales: ProjectRelatedSaleDto[] = sRows.map((s) => ({
    id: s.id,
    entryType: s.entry_type,
    slipNo: Number(s.slip_no),
    slipName: s.slip_name,
    slipDate: s.slip_date.slice(0, 10),
    status: s.status,
    subtotalAmount: Number(s.subtotal_amount),
    totalAmount: Number(s.total_amount),
  }));

  const relatedOrders: ProjectRelatedOrderDto[] = poRows.map((o) => ({
    id: o.id,
    orderNo: Number(o.order_no),
    orderName: o.order_name,
    orderDate: o.order_date.slice(0, 10),
    supplierName: o.supplier_name,
    status: o.status,
    totalAmount: Number(o.total_amount),
  }));

  const relatedPurchases: ProjectRelatedPurchaseDto[] = purRows.map((pur) => ({
    id: pur.id,
    purchaseNo: Number(pur.purchase_no),
    purchaseName: pur.purchase_name,
    purchaseDate: pur.purchase_date.slice(0, 10),
    supplierName: pur.supplier_name,
    status: pur.status,
    projectLineSubtotal: Number(pur.line_sub),
    projectLineTotal: Number(pur.line_tot),
  }));

  return {
    id: p.id,
    projectNo: Number(p.project_no),
    projectName: p.project_name,
    projectDate: p.project_date.slice(0, 10),
    sitePlace: p.site_place,
    partnerId: p.partner_id,
    partnerCode: p.partner_code,
    partnerName: p.partner_name,
    partnerNameSnap: p.partner_name_snap,
    orderKindCode: p.order_kind_code,
    orderKindName: p.order_kind_name,
    subStatusCode: p.sub_status_code,
    subStatusName: p.sub_status_name,
    status: p.status,
    periodStartDate: p.period_start_date !== null ? p.period_start_date.slice(0, 10) : null,
    periodEndDate: p.period_end_date !== null ? p.period_end_date.slice(0, 10) : null,
    actualStartDate: p.actual_start_date !== null ? p.actual_start_date.slice(0, 10) : null,
    tempFinishDate: p.temp_finish_date !== null ? p.temp_finish_date.slice(0, 10) : null,
    finishDate: p.finish_date !== null ? p.finish_date.slice(0, 10) : null,
    salesEmployeeId: p.sales_employee_id,
    salesEmployeeName: p.sales_employee_name,
    siteEmployeeId: p.site_employee_id,
    siteEmployeeName: p.site_employee_name,
    unitName: p.unit_name,
    contractUnitPrice: Number(p.contract_unit_price),
    contractQuantity: Number(p.contract_quantity),
    contractSubtotal: Number(p.contract_subtotal),
    contractTax: Number(p.contract_tax),
    contractTotal: Number(p.contract_total),
    taxCode: p.tax_code,
    roundingMode: p.rounding_mode,
    costTaxMode,
    budgets: {
      EXPENSE: Number(budgetsBig.EXPENSE),
      LABOR: Number(budgetsBig.LABOR),
      MATERIAL: Number(budgetsBig.MATERIAL),
      OUTSOURCING: Number(budgetsBig.OUTSOURCING),
      TEMPORARY: Number(budgetsBig.TEMPORARY),
      INDIRECT: Number(budgetsBig.INDIRECT),
    },
    budgetTotal: Number(profit.budgetTotal),
    actualCostExclTotal: Number(actualCostExclTotal),
    actualCostInclTotal: Number(actualCostInclTotal),
    actualCostEvalTotal: Number(profit.actualCostTotal),
    salesRecordedExcl: Number(salesRecordedExcl),
    salesRecordedIncl: Number(salesRecordedIncl),
    advanceRecordedIncl: Number(advanceRecordedIncl),
    budgetVarianceTotal: Number(profit.budgetVarianceTotal),
    budgetConsumptionRatePercent: computeConsumptionPercent(profit.actualCostTotal, profit.budgetTotal),
    isOverBudget: profit.budgetVarianceTotal < 0n,
    budgetGrossProfit: Number(profit.budgetGrossProfit),
    actualGrossProfit: Number(profit.actualGrossProfit),
    actualGrossMarginPercent: profit.actualGrossMarginPercent,
    salesBasedGrossProfit: Number(salesBasedGrossProfit),
    salesBasedGrossMarginPercent,
    sourceQuotationNo: p.source_quotation_no !== null ? Number(p.source_quotation_no) : null,
    billNo: p.bill_no !== null ? Number(p.bill_no) : null,
    billDate: p.bill_date !== null ? p.bill_date.slice(0, 10) : null,
    remarks: p.remarks,
    createdAt: p.created_at,
    updatedAt: p.updated_at,
    categoryComparisons,
    costHeaders,
    costLines,
    relatedQuotations,
    relatedSales,
    relatedOrders,
    relatedPurchases,
    attachments,
  };
}

async function validateProjectRefsAndGetPartnerSnap(
  tx: DbExecutor,
  payload: CleanProjectPayload,
): Promise<string> {
  const bpRows = await tx.query<{ partner_name: string }>(
    'SELECT partner_name FROM business_partners WHERE id = $1::uuid AND is_deleted = false LIMIT 1',
    [payload.partnerId],
  );
  const bp = bpRows[0];
  if (bp === undefined) {
    throw new MasterDataError(400, 'PARTNER_NOT_FOUND', '指定された取引先が見つかりません。');
  }

  for (const [label, empId] of [
    ['営業担当者', payload.salesEmployeeId],
    ['現場担当者', payload.siteEmployeeId],
  ] as const) {
    if (empId !== null) {
      const empRows = await tx.query<{ id: string }>(
        'SELECT id FROM employees WHERE id = $1::uuid LIMIT 1',
        [empId],
      );
      if (empRows.length === 0) {
        throw new MasterDataError(400, 'EMPLOYEE_NOT_FOUND', `指定された${label}が見つかりません。`);
      }
    }
  }

  if (payload.orderKindCode !== null) {
    const okRows = await tx.query<{ code: string }>(
      "SELECT code FROM code_masters WHERE domain_key = 'ORDER_KIND' AND code = $1 LIMIT 1",
      [payload.orderKindCode],
    );
    if (okRows.length === 0) {
      throw new MasterDataError(400, 'INVALID_ORDER_KIND', '指定された工事種別区分がマスタに存在しません。');
    }
  }
  if (payload.subStatusCode !== null) {
    const ssRows = await tx.query<{ code: string }>(
      "SELECT code FROM code_masters WHERE domain_key = 'PROJECT_SUB_STATUS' AND code = $1 LIMIT 1",
      [payload.subStatusCode],
    );
    if (ssRows.length === 0) {
      throw new MasterDataError(400, 'INVALID_SUB_STATUS', '指定されたサブ状態区分がマスタに存在しません。');
    }
  }

  return bp.partner_name;
}

export async function createProject(
  tx: DbExecutor,
  tenantId: string,
  employeeId: string,
  input: ProjectInput,
): Promise<ProjectDetailDto> {
  await requireFeature(tx, tenantId, 'construction');
  const clean = validateProjectInput(input);
  const partnerNameSnap = await validateProjectRefsAndGetPartnerSnap(tx, clean);

  // テナント排他ロック下で案件番号を安全採番
  await tx.query('SELECT id FROM tenant_settings WHERE tenant_id = $1::uuid FOR UPDATE', [tenantId]);
  let projectNoStr: string;
  if (clean.projectNo !== null) {
    projectNoStr = String(clean.projectNo);
  } else {
    const datePrefix = clean.projectDate.replace(/-/g, '');
    const minRange = `${datePrefix}00000`;
    const maxRange = `${datePrefix}99999`;
    const maxRows = await tx.query<{ max_no: string | null }>(
      `SELECT MAX(project_no)::text AS max_no
         FROM projects
        WHERE project_no > $1::bigint
          AND project_no <= $2::bigint`,
      [minRange, maxRange],
    );
    const existingMax = maxRows[0]?.max_no;
    projectNoStr =
      existingMax !== null && existingMax !== undefined
        ? (BigInt(existingMax) + 1n).toString()
        : `${datePrefix}00001`;
  }

  const contractCalc = calculateLineAmounts({
    lineNo: 1,
    quantity: clean.contractQuantityStr,
    unitPrice: BigInt(clean.contractUnitPrice),
    taxCode: clean.taxCode,
    roundingMode: clean.roundingMode,
  });

  let insertedId: string | undefined;
  try {
    const rows = await tx.query<{ id: string }>(
      `INSERT INTO projects (
         tenant_id, project_no, project_name, project_date, site_place,
         partner_id, partner_name_snap, order_kind_code, sub_status_code, status,
         period_start_date, period_end_date, actual_start_date, temp_finish_date, finish_date,
         sales_employee_id, site_employee_id,
         unit_name, contract_unit_price, contract_quantity, contract_subtotal, contract_tax, contract_total,
         tax_code, rounding_mode,
         budget_expense, budget_labor, budget_material, budget_outsourcing, budget_temporary, budget_indirect,
         remarks, created_by, updated_by
       ) VALUES (
         $1::uuid, $2::bigint, $3, $4::date, $5,
         $6::uuid, $7, $8, $9, $10::project_status,
         $11::date, $12::date, $13::date, $14::date, $15::date,
         $16::uuid, $17::uuid,
         $18, $19::numeric, $20::numeric, $21::numeric, $22::numeric, $23::numeric,
         $24, $25::rounding_mode,
         $26::numeric, $27::numeric, $28::numeric, $29::numeric, $30::numeric, $31::numeric,
         $32, $33::uuid, $33::uuid
       ) RETURNING id`,
      [
        tenantId,
        projectNoStr,
        clean.projectName,
        clean.projectDate,
        clean.sitePlace,
        clean.partnerId,
        partnerNameSnap,
        clean.orderKindCode,
        clean.subStatusCode,
        clean.status,
        clean.periodStartDate,
        clean.periodEndDate,
        clean.actualStartDate,
        clean.tempFinishDate,
        clean.finishDate,
        clean.salesEmployeeId,
        clean.siteEmployeeId,
        clean.unitName,
        clean.contractUnitPrice,
        clean.contractQuantityStr,
        contractCalc.exclAmount.toString(),
        contractCalc.lineTax.toString(),
        contractCalc.rowTotal.toString(),
        clean.taxCode,
        clean.roundingMode,
        clean.budgets.EXPENSE,
        clean.budgets.LABOR,
        clean.budgets.MATERIAL,
        clean.budgets.OUTSOURCING,
        clean.budgets.TEMPORARY,
        clean.budgets.INDIRECT,
        clean.remarks,
        employeeId,
      ],
    );
    insertedId = rows[0]?.id;
  } catch (err) {
    throw mapPgConstraintError(err, { entityLabel: '案件データ' });
  }

  if (insertedId === undefined) {
    throw new MasterDataError(500, 'PROJECT_INSERT_FAILED', '案件データの登録結果を取得できませんでした。');
  }

  return getProjectDetail(tx, tenantId, insertedId);
}

export async function updateProject(
  tx: DbExecutor,
  tenantId: string,
  employeeId: string,
  projectId: string,
  input: ProjectInput,
): Promise<ProjectDetailDto> {
  validateUuid(projectId, '案件');
  await requireFeature(tx, tenantId, 'construction');

  const existingRows = await tx.query<{ id: string }>(
    'SELECT id FROM projects WHERE id = $1::uuid FOR UPDATE',
    [projectId],
  );
  if (existingRows.length === 0) {
    throw new MasterDataError(404, 'PROJECT_NOT_FOUND', '対象の案件データが見つかりません。');
  }

  const clean = validateProjectInput(input);
  const partnerNameSnap = await validateProjectRefsAndGetPartnerSnap(tx, clean);

  const contractCalc = calculateLineAmounts({
    lineNo: 1,
    quantity: clean.contractQuantityStr,
    unitPrice: BigInt(clean.contractUnitPrice),
    taxCode: clean.taxCode,
    roundingMode: clean.roundingMode,
  });

  try {
    await tx.query(
      `UPDATE projects
          SET project_no = COALESCE($2::bigint, project_no),
              project_name = $3,
              project_date = $4::date,
              site_place = $5,
              partner_id = $6::uuid,
              partner_name_snap = $7,
              order_kind_code = $8,
              sub_status_code = $9,
              status = $10::project_status,
              period_start_date = $11::date,
              period_end_date = $12::date,
              actual_start_date = $13::date,
              temp_finish_date = $14::date,
              finish_date = $15::date,
              sales_employee_id = $16::uuid,
              site_employee_id = $17::uuid,
              unit_name = $18,
              contract_unit_price = $19::numeric,
              contract_quantity = $20::numeric,
              contract_subtotal = $21::numeric,
              contract_tax = $22::numeric,
              contract_total = $23::numeric,
              tax_code = $24,
              rounding_mode = $25::rounding_mode,
              budget_expense = $26::numeric,
              budget_labor = $27::numeric,
              budget_material = $28::numeric,
              budget_outsourcing = $29::numeric,
              budget_temporary = $30::numeric,
              budget_indirect = $31::numeric,
              remarks = $32,
              updated_by = $33::uuid
        WHERE id = $1::uuid`,
      [
        projectId,
        clean.projectNo,
        clean.projectName,
        clean.projectDate,
        clean.sitePlace,
        clean.partnerId,
        partnerNameSnap,
        clean.orderKindCode,
        clean.subStatusCode,
        clean.status,
        clean.periodStartDate,
        clean.periodEndDate,
        clean.actualStartDate,
        clean.tempFinishDate,
        clean.finishDate,
        clean.salesEmployeeId,
        clean.siteEmployeeId,
        clean.unitName,
        clean.contractUnitPrice,
        clean.contractQuantityStr,
        contractCalc.exclAmount.toString(),
        contractCalc.lineTax.toString(),
        contractCalc.rowTotal.toString(),
        clean.taxCode,
        clean.roundingMode,
        clean.budgets.EXPENSE,
        clean.budgets.LABOR,
        clean.budgets.MATERIAL,
        clean.budgets.OUTSOURCING,
        clean.budgets.TEMPORARY,
        clean.budgets.INDIRECT,
        clean.remarks,
        employeeId,
      ],
    );
  } catch (err) {
    throw mapPgConstraintError(err, { entityLabel: '案件データ' });
  }

  return getProjectDetail(tx, tenantId, projectId);
}

export async function deleteProject(
  tx: DbExecutor,
  tenantId: string,
  projectId: string,
): Promise<{ id: string }> {
  validateUuid(projectId, '案件');
  await requireFeature(tx, tenantId, 'construction');

  const existing = await tx.query<{ id: string }>(
    'SELECT id FROM projects WHERE id = $1::uuid FOR UPDATE',
    [projectId],
  );
  if (existing.length === 0) {
    throw new MasterDataError(404, 'PROJECT_NOT_FOUND', '対象の案件データが見つかりません。');
  }

  const refRows = await tx.query<{
    q_cnt: number;
    s_cnt: number;
    po_cnt: number;
    pl_cnt: number;
    cr_cnt: number;
    ch_cnt: number;
    att_cnt: number;
  }>(
    `SELECT (SELECT COUNT(*)::int FROM quotations WHERE project_id = $1::uuid) AS q_cnt,
            (SELECT COUNT(*)::int FROM sales_headers WHERE project_id = $1::uuid) AS s_cnt,
            (SELECT COUNT(*)::int FROM purchase_orders WHERE project_id = $1::uuid) AS po_cnt,
            (SELECT COUNT(*)::int FROM purchase_lines WHERE project_id = $1::uuid) AS pl_cnt,
            (SELECT COUNT(*)::int FROM cash_receipts WHERE project_id = $1::uuid) AS cr_cnt,
            (SELECT COUNT(*)::int FROM project_cost_headers WHERE project_id = $1::uuid) AS ch_cnt,
            (SELECT COUNT(*)::int FROM attachments WHERE entity_type = 'PROJECT' AND entity_id = $1::uuid) AS att_cnt`,
    [projectId],
  );
  const ref = refRows[0];
  if (ref !== undefined) {
    const reasons: string[] = [];
    if (ref.q_cnt > 0) reasons.push(`見積(${ref.q_cnt}件)`);
    if (ref.s_cnt > 0) reasons.push(`売上・立替(${ref.s_cnt}件)`);
    if (ref.po_cnt > 0) reasons.push(`発注(${ref.po_cnt}件)`);
    if (ref.pl_cnt > 0) reasons.push(`仕入明細(${ref.pl_cnt}行)`);
    if (ref.cr_cnt > 0) reasons.push(`入金(${ref.cr_cnt}件)`);
    if (ref.ch_cnt > 0) reasons.push(`原価伝票(${ref.ch_cnt}件)`);
    if (ref.att_cnt > 0) reasons.push(`現場画像(${ref.att_cnt}枚)`);
    if (reasons.length > 0) {
      throw new MasterDataError(
        409,
        'PROJECT_IN_USE',
        `次の関連データが存在するため案件を削除できません: ${reasons.join('、')}`,
      );
    }
  }

  await tx.query('DELETE FROM projects WHERE id = $1::uuid', [projectId]);
  return { id: projectId };
}

/**
 * 紐づく見積（または指定見積）から6費目実行予算および契約金額を案件へ取り込む
 */
export async function importProjectBudgetFromQuotation(
  tx: DbExecutor,
  tenantId: string,
  employeeId: string,
  projectId: string,
  params: { quotationId?: string | null; updateContractAmount?: boolean } = {},
): Promise<ProjectDetailDto> {
  validateUuid(projectId, '案件');
  await requireFeature(tx, tenantId, 'construction');

  const pjRows = await tx.query<{ id: string }>(
    'SELECT id FROM projects WHERE id = $1::uuid FOR UPDATE',
    [projectId],
  );
  if (pjRows.length === 0) {
    throw new MasterDataError(404, 'PROJECT_NOT_FOUND', '対象の案件データが見つかりません。');
  }

  const tsRows = await tx.query<{ cost_tax_mode: CostTaxMode }>(
    'SELECT cost_tax_mode::text AS cost_tax_mode FROM tenant_settings WHERE tenant_id = $1::uuid LIMIT 1',
    [tenantId],
  );
  const costTaxMode: CostTaxMode =
    tsRows[0] !== undefined ? tsRows[0].cost_tax_mode : 'TAX_EXCLUDED';

  let quotationRow:
    | {
        id: string;
        quotation_no: string;
        rounding_mode: RoundingMode;
        tax_calc_policy: TaxCalcPolicy;
      }
    | undefined;

  if (params.quotationId !== undefined && params.quotationId !== null && params.quotationId !== '') {
    validateUuid(params.quotationId, '見積');
    const qRows = await tx.query<{
      id: string;
      quotation_no: string;
      rounding_mode: RoundingMode;
      tax_calc_policy: TaxCalcPolicy;
    }>(
      `SELECT id, quotation_no::text AS quotation_no,
              rounding_mode::text AS rounding_mode,
              tax_calc_policy::text AS tax_calc_policy
         FROM quotations
        WHERE id = $1::uuid
        LIMIT 1`,
      [params.quotationId],
    );
    quotationRow = qRows[0];
  } else {
    const qRows = await tx.query<{
      id: string;
      quotation_no: string;
      rounding_mode: RoundingMode;
      tax_calc_policy: TaxCalcPolicy;
    }>(
      `SELECT id, quotation_no::text AS quotation_no,
              rounding_mode::text AS rounding_mode,
              tax_calc_policy::text AS tax_calc_policy
         FROM quotations
        WHERE project_id = $1::uuid
        ORDER BY is_selected DESC, quotation_date DESC, quotation_no DESC
        LIMIT 1`,
      [projectId],
    );
    quotationRow = qRows[0];
  }

  if (quotationRow === undefined) {
    throw new MasterDataError(
      404,
      'QUOTATION_NOT_FOUND',
      '実行予算取込対象の見積が見つかりません。先に見積を作成・案件紐付けしてください。',
    );
  }

  const qLineRows = await tx.query<{
    line_no: number;
    is_heading: boolean;
    quantity: string;
    tax_code: TaxCode;
    cost_category: CostCategory | null;
    applied_unit_price: string;
    applied_cost_price: string;
  }>(
    `SELECT line_no, is_heading, quantity::text AS quantity,
            tax_code, cost_category::text AS cost_category,
            applied_unit_price::text AS applied_unit_price,
            applied_cost_price::text AS applied_cost_price
       FROM quotation_lines
      WHERE quotation_id = $1::uuid
      ORDER BY line_no ASC`,
    [quotationRow.id],
  );

  const calc = calculateQuotationSlip(
    qLineRows.map((l) => ({
      lineNo: Number(l.line_no),
      isHeading: l.is_heading,
      quantity: l.quantity,
      appliedUnitPrice: BigInt(l.applied_unit_price),
      appliedCostPrice: BigInt(l.applied_cost_price),
      taxCode: l.tax_code,
    })),
    quotationRow.rounding_mode,
    quotationRow.tax_calc_policy,
  );

  const budgetsByCat: Record<CostCategory, bigint> = {
    EXPENSE: 0n,
    LABOR: 0n,
    MATERIAL: 0n,
    OUTSOURCING: 0n,
    TEMPORARY: 0n,
    INDIRECT: 0n,
  };

  for (let i = 0; i < qLineRows.length; i += 1) {
    const rawLine = qLineRows[i];
    const calcLine = calc.lineResults[i];
    if (rawLine === undefined || calcLine === undefined || rawLine.is_heading) {
      continue;
    }
    const costVal =
      costTaxMode === 'TAX_EXCLUDED' ? calcLine.costExclAmount : calcLine.costTotal;
    const cat: CostCategory =
      rawLine.cost_category !== null ? rawLine.cost_category : 'EXPENSE';
    budgetsByCat[cat] += costVal;
  }

  const updateContract = params.updateContractAmount !== false;

  await tx.query(
    `UPDATE projects
        SET budget_expense = $2::numeric,
            budget_labor = $3::numeric,
            budget_material = $4::numeric,
            budget_outsourcing = $5::numeric,
            budget_temporary = $6::numeric,
            budget_indirect = $7::numeric,
            source_quotation_no = $8::bigint,
            contract_unit_price = CASE WHEN $9::boolean THEN $10::numeric ELSE contract_unit_price END,
            contract_quantity = CASE WHEN $9::boolean THEN 1 ELSE contract_quantity END,
            contract_subtotal = CASE WHEN $9::boolean THEN $10::numeric ELSE contract_subtotal END,
            contract_tax = CASE WHEN $9::boolean THEN $11::numeric ELSE contract_tax END,
            contract_total = CASE WHEN $9::boolean THEN $12::numeric ELSE contract_total END,
            updated_by = $13::uuid
      WHERE id = $1::uuid`,
    [
      projectId,
      budgetsByCat.EXPENSE.toString(),
      budgetsByCat.LABOR.toString(),
      budgetsByCat.MATERIAL.toString(),
      budgetsByCat.OUTSOURCING.toString(),
      budgetsByCat.TEMPORARY.toString(),
      budgetsByCat.INDIRECT.toString(),
      quotationRow.quotation_no,
      updateContract,
      calc.subtotalAmount.toString(),
      calc.taxTotal.toString(),
      calc.totalAmount.toString(),
      employeeId,
    ],
  );

  return getProjectDetail(tx, tenantId, projectId);
}

export async function exportProjectsCsv(
  tx: DbExecutor,
  tenantId: string,
  filter: ProjectListFilter,
): Promise<string> {
  const result = await listProjects(tx, tenantId, { ...filter, page: 1, pageSize: 5000 });
  const header = [
    '案件番号',
    '受注日',
    '状態',
    '取引先コード',
    '取引先名',
    '案件名',
    '現場場所',
    '請負契約(税抜)',
    '請負契約(税込)',
    '実行予算計',
    '実績原価(税抜)',
    '実績原価(税込)',
    '実績粗利額',
    '実績粗利率(%)',
    '予算超過',
  ].map(escapeCsvCell);

  const lines = [header.join(',')];
  for (const item of result.items) {
    lines.push(
      [
        String(item.projectNo),
        item.projectDate,
        PROJECT_STATUS_LABELS[item.status],
        item.partnerCode,
        item.partnerName,
        item.projectName,
        item.sitePlace !== null ? item.sitePlace : '',
        String(item.contractSubtotal),
        String(item.contractTotal),
        String(item.budgetTotal),
        String(item.actualCostExclTotal),
        String(item.actualCostInclTotal),
        String(item.actualGrossProfit),
        item.actualGrossMarginPercent,
        item.isOverBudget ? '超過' : '',
      ]
        .map(escapeCsvCell)
        .join(','),
    );
  }
  return `\uFEFF${lines.join('\r\n')}`;
}

export async function exportProjectsPdf(
  tx: DbExecutor,
  tenantId: string,
  filter: ProjectListFilter,
): Promise<Uint8Array> {
  const result = await listProjects(tx, tenantId, { ...filter, page: 1, pageSize: 5000 });
  const settingsRows = await tx.query<{ company_name: string }>(
    'SELECT company_name FROM tenant_settings WHERE tenant_id = $1::uuid LIMIT 1',
    [tenantId],
  );
  const companyName = settingsRows[0] !== undefined ? settingsRows[0].company_name : '自社';
  const costBasisLabel = result.costTaxMode === 'TAX_EXCLUDED' ? '税抜' : '税込';
  const summaryContract =
    result.costTaxMode === 'TAX_EXCLUDED'
      ? result.summary.contractSubtotal
      : result.summary.contractTotal;

  return renderProjectListPdf({
    companyName,
    generatedDate: new Date().toISOString().slice(0, 10),
    filterSummary: `状態:${filter.status !== null && filter.status !== undefined ? PROJECT_STATUS_LABELS[filter.status] : 'すべて'}${filter.overBudgetOnly ? ' / 予算超過のみ' : ''}`,
    costBasisLabel,
    items: result.items.map((item) => ({
      projectNo: item.projectNo,
      projectDate: item.projectDate,
      statusLabel: PROJECT_STATUS_LABELS[item.status],
      partnerName: item.partnerName,
      projectName: item.projectName,
      sitePlace: item.sitePlace,
      contractAmount:
        result.costTaxMode === 'TAX_EXCLUDED' ? item.contractSubtotal : item.contractTotal,
      budgetTotal: item.budgetTotal,
      actualCostTotal: item.actualCostEvalTotal,
      actualGrossProfit: item.actualGrossProfit,
      actualGrossMarginPercent: item.actualGrossMarginPercent,
      isOverBudget: item.isOverBudget,
    })),
    totals: {
      count: result.summary.totalCount,
      contractAmount: summaryContract,
      budgetTotal: result.summary.budgetTotal,
      actualCostTotal: result.summary.actualCostEvalTotal,
      budgetGrossProfit: result.summary.budgetGrossProfit,
      actualGrossProfit: result.summary.actualGrossProfit,
    },
  });
}

export async function exportProjectLedgerCsv(
  tx: DbExecutor,
  tenantId: string,
  projectId: string,
): Promise<string> {
  const detail = await getProjectDetail(tx, tenantId, projectId);
  const lines: string[] = [];

  lines.push(
    ['工事台帳', `案件番号:${detail.projectNo}`, detail.projectName, `発注元:${detail.partnerName}`]
      .map(escapeCsvCell)
      .join(','),
  );
  lines.push(
    [
      '費目区分',
      '実行予算',
      '実績原価(税抜)',
      '実績原価(税込)',
      '予算残額',
      '消化率(%)',
    ]
      .map(escapeCsvCell)
      .join(','),
  );
  for (const cat of detail.categoryComparisons) {
    lines.push(
      [
        cat.categoryLabel,
        String(cat.budgetAmount),
        String(cat.actualExclAmount),
        String(cat.actualInclAmount),
        String(cat.varianceAmount),
        cat.consumptionRatePercent,
      ]
        .map(escapeCsvCell)
        .join(','),
    );
  }

  lines.push('');
  lines.push(
    ['計上日', '費目区分', '伝票件名', '品名・作業内容', '数量', '単位', '単価', '金額', '消費税', '行税込計', '備考']
      .map(escapeCsvCell)
      .join(','),
  );
  for (const ln of detail.costLines) {
    lines.push(
      [
        ln.entryDate,
        ln.categoryLabel,
        ln.slipTitle,
        ln.itemName,
        String(ln.quantity),
        ln.unitName !== null ? ln.unitName : '',
        String(ln.appliedUnitPrice),
        String(ln.lineAmount),
        String(ln.lineTax),
        String(ln.lineTotal),
        ln.remarks !== null ? ln.remarks : '',
      ]
        .map(escapeCsvCell)
        .join(','),
    );
  }

  return `\uFEFF${lines.join('\r\n')}`;
}

export async function exportProjectLedgerPdf(
  tx: DbExecutor,
  tenantId: string,
  projectId: string,
): Promise<{ pdfBytes: Uint8Array; projectNo: number }> {
  const detail = await getProjectDetail(tx, tenantId, projectId);
  const settingsRows = await tx.query<{ company_name: string }>(
    'SELECT company_name FROM tenant_settings WHERE tenant_id = $1::uuid LIMIT 1',
    [tenantId],
  );
  const companyName = settingsRows[0] !== undefined ? settingsRows[0].company_name : '自社';
  const costBasisLabel = detail.costTaxMode === 'TAX_EXCLUDED' ? '税抜' : '税込';

  const pdfBytes = await renderProjectLedgerPdf({
    companyName,
    generatedDate: new Date().toISOString().slice(0, 10),
    projectNo: detail.projectNo,
    projectName: detail.projectName,
    projectDate: detail.projectDate,
    statusLabel: PROJECT_STATUS_LABELS[detail.status],
    subStatusName: detail.subStatusName,
    orderKindName: detail.orderKindName,
    partnerCode: detail.partnerCode,
    partnerName: detail.partnerName,
    sitePlace: detail.sitePlace,
    periodStartDate: detail.periodStartDate,
    periodEndDate: detail.periodEndDate,
    salesEmployeeName: detail.salesEmployeeName,
    siteEmployeeName: detail.siteEmployeeName,
    costBasisLabel,
    contractSubtotal: detail.contractSubtotal,
    contractTax: detail.contractTax,
    contractTotal: detail.contractTotal,
    salesRecordedExcl: detail.salesRecordedExcl,
    salesRecordedIncl: detail.salesRecordedIncl,
    budgetTotal: detail.budgetTotal,
    actualCostExclTotal: detail.actualCostExclTotal,
    actualCostInclTotal: detail.actualCostInclTotal,
    actualCostEvalTotal: detail.actualCostEvalTotal,
    budgetVarianceTotal: detail.budgetVarianceTotal,
    budgetGrossProfit: detail.budgetGrossProfit,
    actualGrossProfit: detail.actualGrossProfit,
    actualGrossMarginPercent: detail.actualGrossMarginPercent,
    categories: detail.categoryComparisons.map((c) => ({
      categoryLabel: c.categoryLabel,
      budgetAmount: c.budgetAmount,
      actualExclAmount: c.actualExclAmount,
      actualInclAmount: c.actualInclAmount,
      actualEvalAmount: c.actualEvalAmount,
      varianceAmount: c.varianceAmount,
      consumptionRatePercent: c.consumptionRatePercent,
      isOverBudget: c.isOverBudget,
    })),
    costLines: detail.costLines.map((ln) => ({
      entryDate: ln.entryDate,
      categoryLabel: ln.categoryLabel,
      slipTitle: ln.slipTitle,
      itemName: ln.itemName,
      quantity: ln.quantity,
      unitName: ln.unitName,
      appliedUnitPrice: ln.appliedUnitPrice,
      lineAmount: ln.lineAmount,
      lineTax: ln.lineTax,
      lineTotal: ln.lineTotal,
      remarks: ln.remarks,
    })),
  });

  return { pdfBytes, projectNo: detail.projectNo };
}
