import Decimal from 'decimal.js';
import { listAttachments } from '@/lib/attachments/attachment-service';
import type { DbExecutor } from '@/lib/db/tenant-client';
import {
  calculateQuotationSlip,
  computeMarginPercent,
  type CostCategory,
  type CostTaxMode,
  type RoundingMode,
  type TaxCalcPolicy,
  type TaxCode,
} from '@/lib/domain/calculations';
import { renderEstimateListPdf } from '@/lib/domain/pdf-renderer';
import {
  QUOTATION_STATUS_LABELS,
  type AttachmentDto,
  type EstimateEditorLookupsDto,
  type EstimateIntelligenceOption,
  type EstimatePartnerOption,
  type EstimateProductOption,
  type EstimateProjectOption,
  type QuotationDetailDto,
  type QuotationInput,
  type QuotationLineDto,
  type QuotationLineInput,
  type QuotationListItemDto,
  type QuotationListSummaryDto,
  type QuotationPageDto,
  type QuotationStatus,
} from '@/lib/estimates/types';
import { isFeatureEnabled } from '@/lib/feature-flags/gate';
import { mapPgConstraintError, MasterDataError } from '@/lib/masters/error-mapper';
import { listEntitySnapshots } from '@/lib/snapshots/snapshot-service';
import { removeAttachmentObject } from '@/lib/storage/storage-client';

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DATE_REGEX = /^\d{4}-\d{2}-\d{2}$/;
const VALID_STATUSES = new Set<QuotationStatus>(['Q1', 'Q2', 'Q3']);
const VALID_ROUNDING_MODES = new Set<RoundingMode>(['FLOOR', 'ROUND', 'CEIL']);
const VALID_TAX_CODES = new Set<TaxCode>(['A', 'B', 'C', 'D', 'E']);
const VALID_COST_CATEGORIES = new Set<CostCategory>([
  'EXPENSE',
  'LABOR',
  'MATERIAL',
  'OUTSOURCING',
  'TEMPORARY',
  'INDIRECT',
]);

export interface QuotationListFilter {
  keyword?: string | null;
  status?: QuotationStatus | null;
  dateFrom?: string | null;
  dateTo?: string | null;
  projectLink?: 'ALL' | 'LINKED' | 'UNLINKED';
  selectedFilter?: 'ALL' | 'SELECTED' | 'UNSELECTED';
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
  const trimmed = val.trim();
  if (!DATE_REGEX.test(trimmed)) {
    throw new MasterDataError(400, 'INVALID_DATE', `${label}は YYYY-MM-DD 形式で入力してください。`);
  }
  return trimmed;
}

function validateIntegerYen(val: number, label: string): number {
  if (!Number.isInteger(val) || Math.abs(val) > 999_999_999_999) {
    throw new MasterDataError(400, 'INVALID_AMOUNT', `${label}は整数円で入力してください。`);
  }
  return val;
}

function validateOptionalIntegerYen(val: number | null, label: string): number | null {
  if (val === null) {
    return null;
  }
  return validateIntegerYen(val, label);
}

function validateQuantity(val: number, lineNo: number): string {
  if (!Number.isFinite(val) || Math.abs(val) > 99_999_999) {
    throw new MasterDataError(400, 'INVALID_QUANTITY', `${lineNo}行目の数量が不正です。`);
  }
  return new Decimal(val).toDecimalPlaces(4, Decimal.ROUND_HALF_UP).toString();
}

interface CleanQuotationLine {
  productId: string | null;
  itemCode: string | null;
  itemName: string;
  unitName: string | null;
  isHeading: boolean;
  quantityStr: string;
  taxCode: TaxCode;
  costCategory: CostCategory | null;
  masterUnitPrice: number | null;
  appliedUnitPrice: number;
  masterCostPrice: number | null;
  appliedCostPrice: number;
  remarks: string | null;
}

interface CleanQuotationPayload {
  quotationName: string;
  quotationDate: string;
  partnerId: string;
  projectId: string | null;
  honorific: string;
  validityPeriod: string | null;
  deliveryDate: string | null;
  status: QuotationStatus;
  isAdvanceType: boolean;
  isSelected: boolean;
  roundingMode: RoundingMode;
  requestedPolicy: TaxCalcPolicy | null;
  remarks: string | null;
  lines: CleanQuotationLine[];
}

function validateQuotationInput(input: QuotationInput): CleanQuotationPayload {
  const quotationName = input.quotationName.trim();
  if (quotationName.length === 0 || quotationName.length > 200) {
    throw new MasterDataError(400, 'INVALID_QUOTATION_NAME', '件名は1〜200文字で入力してください。');
  }
  const quotationDate = validateDateOnly(input.quotationDate, '見積日');
  validateUuid(input.partnerId, '取引先');

  let projectId: string | null = null;
  if (input.projectId !== null && input.projectId.trim() !== '') {
    validateUuid(input.projectId.trim(), '案件');
    projectId = input.projectId.trim();
  }

  const honorific = input.honorific.trim();
  if (honorific.length === 0 || honorific.length > 20) {
    throw new MasterDataError(400, 'INVALID_HONORIFIC', '敬称は1〜20文字で入力してください。');
  }

  if (!VALID_STATUSES.has(input.status)) {
    throw new MasterDataError(400, 'INVALID_STATUS', '見積ステータスは Q1 / Q2 / Q3 のいずれかを指定してください。');
  }
  if (!VALID_ROUNDING_MODES.has(input.roundingMode)) {
    throw new MasterDataError(400, 'INVALID_ROUNDING_MODE', '端数処理は FLOOR / ROUND / CEIL を指定してください。');
  }

  let requestedPolicy: TaxCalcPolicy | null = null;
  if (input.taxCalcPolicy !== undefined) {
    if (input.taxCalcPolicy !== 'SLIP_BY_RATE' && input.taxCalcPolicy !== 'INVOICE_BY_RATE') {
      throw new MasterDataError(
        400,
        'INVALID_TAX_CALC_POLICY',
        '消費税計算方式は SLIP_BY_RATE または INVOICE_BY_RATE を指定してください。',
      );
    }
    requestedPolicy = input.taxCalcPolicy;
  }

  if (!Array.isArray(input.lines) || input.lines.length === 0) {
    throw new MasterDataError(400, 'LINES_REQUIRED', '見積明細は最低1行以上入力してください。');
  }

  const cleanLines: CleanQuotationLine[] = input.lines.map((line, idx) => {
    const lineNo = idx + 1;
    const isHeading = Boolean(line.isHeading);
    const itemName = line.itemName.trim();
    if (itemName.length === 0 || itemName.length > 300) {
      throw new MasterDataError(400, 'INVALID_ITEM_NAME', `${lineNo}行目の品名は1〜300文字で入力してください。`);
    }

    let productId: string | null = null;
    if (line.productId !== null && line.productId.trim() !== '') {
      validateUuid(line.productId.trim(), `${lineNo}行目の商品`);
      productId = line.productId.trim();
    }

    if (!VALID_TAX_CODES.has(line.taxCode)) {
      throw new MasterDataError(400, 'INVALID_TAX_CODE', `${lineNo}行目の税区分が不正です。`);
    }

    let costCategory: CostCategory | null = null;
    if (line.costCategory !== null) {
      if (!VALID_COST_CATEGORIES.has(line.costCategory)) {
        throw new MasterDataError(400, 'INVALID_COST_CATEGORY', `${lineNo}行目の原価費目区分が不正です。`);
      }
      costCategory = line.costCategory;
    }

    const quantityStr = isHeading ? '0' : validateQuantity(line.quantity, lineNo);
    const masterUnitPrice = validateOptionalIntegerYen(line.masterUnitPrice, `${lineNo}行目の基準売価単価`);
    const appliedUnitPrice = isHeading
      ? 0
      : validateIntegerYen(line.appliedUnitPrice, `${lineNo}行目の適用売価単価`);
    const masterCostPrice = validateOptionalIntegerYen(line.masterCostPrice, `${lineNo}行目の基準原価単価`);
    const appliedCostPrice = isHeading
      ? 0
      : validateIntegerYen(line.appliedCostPrice, `${lineNo}行目の適用原価単価`);

    return {
      productId,
      itemCode: optTrimmed(line.itemCode),
      itemName,
      unitName: isHeading ? null : optTrimmed(line.unitName),
      isHeading,
      quantityStr,
      taxCode: line.taxCode,
      costCategory: isHeading ? null : costCategory,
      masterUnitPrice,
      appliedUnitPrice,
      masterCostPrice,
      appliedCostPrice,
      remarks: optTrimmed(line.remarks),
    };
  });

  return {
    quotationName,
    quotationDate,
    partnerId: input.partnerId.trim(),
    projectId,
    honorific,
    validityPeriod: optTrimmed(input.validityPeriod),
    deliveryDate: optTrimmed(input.deliveryDate),
    status: input.status,
    isAdvanceType: Boolean(input.isAdvanceType),
    isSelected: Boolean(input.isSelected),
    roundingMode: input.roundingMode,
    requestedPolicy,
    remarks: optTrimmed(input.remarks),
    lines: cleanLines,
  };
}

export async function getEstimateEditorLookups(
  tx: DbExecutor,
  tenantId: string,
): Promise<EstimateEditorLookupsDto> {
  const settingsRows = await tx.query<{
    tax_calc_policy: TaxCalcPolicy;
    default_rounding_mode: RoundingMode;
    cost_tax_mode: CostTaxMode;
    quotation_template_rows: number;
  }>(
    `SELECT tax_calc_policy::text AS tax_calc_policy,
            default_rounding_mode::text AS default_rounding_mode,
            cost_tax_mode::text AS cost_tax_mode,
            quotation_template_rows
       FROM tenant_settings
      WHERE tenant_id = $1::uuid
      LIMIT 1`,
    [tenantId],
  );
  const settings = settingsRows[0];
  if (settings === undefined) {
    throw new MasterDataError(404, 'TENANT_SETTINGS_NOT_FOUND', '自社設定が見つかりません。');
  }

  const estimateImageEnabled = await isFeatureEnabled(tx, tenantId, 'estimateimage');

  const partnerRows = await tx.query<{
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
  );

  const projectRows = await tx.query<{
    id: string;
    project_no: string;
    project_name: string;
    partner_id: string;
    status: string;
  }>(
    `SELECT id, project_no::text AS project_no, project_name, partner_id, status::text AS status
       FROM projects
      ORDER BY project_no DESC`,
    [],
  );

  const productRows = await tx.query<{
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
  );

  const intelRows = await tx.query<{
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
  );

  const unitRows = await tx.query<{
    id: string;
    unit_code: string;
    unit_name: string;
  }>(
    `SELECT id, unit_code, unit_name
       FROM units
      WHERE is_deleted = false
      ORDER BY display_order ASC, unit_code ASC`,
    [],
  );

  const taxRows = await tx.query<{
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
  );

  const partners: EstimatePartnerOption[] = partnerRows.map((r) => ({
    id: r.id,
    partnerCode: r.partner_code,
    partnerName: r.partner_name,
    isIndividualHonorific: r.is_individual_honorific,
    representativeName: r.representative_name,
    isClient: r.is_client,
  }));

  const projects: EstimateProjectOption[] = projectRows.map((r) => ({
    id: r.id,
    projectNo: Number(r.project_no),
    projectName: r.project_name,
    partnerId: r.partner_id,
    status: r.status,
  }));

  const products: EstimateProductOption[] = productRows.map((r) => ({
    id: r.id,
    productCode: r.product_code,
    productName: r.product_name,
    productNameSub: r.product_name_sub,
    unitName: r.unit_name,
    standardUnitPrice: Number(r.standard_unit_price),
    standardCostPrice: Number(r.standard_cost_price),
    defaultTaxCode: r.default_tax_code,
    isHeading: r.is_heading,
  }));

  const intelligences: EstimateIntelligenceOption[] = intelRows.map((r) => ({
    id: r.id,
    itemName: r.item_name,
    unitName: r.unit_name,
    unitPrice: Number(r.unit_price),
    costPrice: Number(r.cost_price),
    taxCode: r.tax_code,
  }));

  return {
    taxCalcPolicy: settings.tax_calc_policy,
    defaultRoundingMode: settings.default_rounding_mode,
    costTaxMode: settings.cost_tax_mode,
    quotationTemplateRows: settings.quotation_template_rows === 20 ? 20 : 10,
    estimateImageEnabled,
    partners,
    projects,
    products,
    intelligences,
    units: unitRows.map((u) => ({
      id: u.id,
      unitCode: u.unit_code,
      unitName: u.unit_name,
    })),
    taxCodes: taxRows.map((r) => ({
      taxCode: r.tax_code,
      taxName: r.tax_name,
      taxRate: Number(r.tax_rate),
      markSymbol: r.mark_symbol,
      isInternal: r.is_internal,
    })),
  };
}

function normalizeListFilterParams(filter: QuotationListFilter): {
  kw: string | null;
  status: QuotationStatus | null;
  dateFrom: string | null;
  dateTo: string | null;
  projectLink: 'ALL' | 'LINKED' | 'UNLINKED';
  selectedFilter: 'ALL' | 'SELECTED' | 'UNSELECTED';
  page: number;
  pageSize: number;
  offset: number;
} {
  const kw = optTrimmed(filter.keyword);
  const status =
    filter.status !== undefined && filter.status !== null && VALID_STATUSES.has(filter.status)
      ? filter.status
      : null;
  const rawFrom = optTrimmed(filter.dateFrom);
  const dateFrom = rawFrom !== null && DATE_REGEX.test(rawFrom) ? rawFrom : null;
  const rawTo = optTrimmed(filter.dateTo);
  const dateTo = rawTo !== null && DATE_REGEX.test(rawTo) ? rawTo : null;

  const projectLink =
    filter.projectLink === 'LINKED' || filter.projectLink === 'UNLINKED' ? filter.projectLink : 'ALL';
  const selectedFilter =
    filter.selectedFilter === 'SELECTED' || filter.selectedFilter === 'UNSELECTED'
      ? filter.selectedFilter
      : 'ALL';

  const rawPage = filter.page === undefined ? 1 : filter.page;
  const rawSize = filter.pageSize === undefined ? 25 : filter.pageSize;
  const page = Number.isInteger(rawPage) && rawPage >= 1 ? rawPage : 1;
  const pageSize = Number.isInteger(rawSize) && rawSize >= 1 && rawSize <= 5000 ? rawSize : 25;
  const offset = (page - 1) * pageSize;

  return { kw, status, dateFrom, dateTo, projectLink, selectedFilter, page, pageSize, offset };
}

interface QuotationListRow extends Record<string, unknown> {
  id: string;
  quotation_no: string;
  quotation_name: string;
  quotation_date: string;
  partner_id: string;
  partner_code: string;
  partner_name: string;
  project_id: string | null;
  project_no: string | null;
  project_name: string | null;
  honorific: string;
  status: QuotationStatus;
  is_advance_type: boolean;
  is_selected: boolean;
  rounding_mode: RoundingMode;
  tax_calc_policy: TaxCalcPolicy;
  subtotal_amount: string;
  tax_total: string;
  total_amount: string;
  cost_subtotal: string;
  line_count: number;
  snapshot_count: number;
  latest_snapshot_version: number | null;
  attachment_count: number;
  updated_at: string;
}

export async function listQuotations(
  tx: DbExecutor,
  filter: QuotationListFilter = {},
): Promise<QuotationPageDto> {
  const f = normalizeListFilterParams(filter);

  const summaryRows = await tx.query<{
    total_count: number;
    sum_subtotal: string;
    sum_tax: string;
    sum_total: string;
    sum_cost_subtotal: string;
  }>(
    `SELECT COUNT(*)::int AS total_count,
            COALESCE(SUM(q.subtotal_amount), 0)::text AS sum_subtotal,
            COALESCE(SUM(q.tax_total), 0)::text AS sum_tax,
            COALESCE(SUM(q.total_amount), 0)::text AS sum_total,
            COALESCE(SUM(COALESCE(ql_agg.cost_subtotal, 0)), 0)::text AS sum_cost_subtotal
       FROM quotations q
       JOIN business_partners bp ON bp.tenant_id = q.tenant_id AND bp.id = q.partner_id
       LEFT JOIN projects pj ON pj.tenant_id = q.tenant_id AND pj.id = q.project_id
       LEFT JOIN (
         SELECT quotation_id,
                COALESCE(SUM(
                  CASE
                    WHEN is_heading THEN 0
                    WHEN tax_code IN ('D', 'E') THEN cost_amount - cost_tax
                    ELSE cost_amount
                  END
                ), 0) AS cost_subtotal
           FROM quotation_lines
          GROUP BY quotation_id
       ) ql_agg ON ql_agg.quotation_id = q.id
      WHERE (
        $1::text IS NULL
        OR CAST(q.quotation_no AS text) ILIKE '%' || $1 || '%'
        OR q.quotation_name ILIKE '%' || $1 || '%'
        OR bp.partner_name ILIKE '%' || $1 || '%'
        OR bp.partner_code ILIKE '%' || $1 || '%'
        OR COALESCE(pj.project_name, '') ILIKE '%' || $1 || '%'
      )
      AND ($2::text IS NULL OR q.status::text = $2)
      AND ($3::date IS NULL OR q.quotation_date >= $3::date)
      AND ($4::date IS NULL OR q.quotation_date <= $4::date)
      AND (
        $5::text = 'ALL'
        OR ($5::text = 'LINKED' AND q.project_id IS NOT NULL)
        OR ($5::text = 'UNLINKED' AND q.project_id IS NULL)
      )
      AND (
        $6::text = 'ALL'
        OR ($6::text = 'SELECTED' AND q.is_selected = true)
        OR ($6::text = 'UNSELECTED' AND q.is_selected = false)
      )`,
    [f.kw, f.status, f.dateFrom, f.dateTo, f.projectLink, f.selectedFilter],
  );

  const sumRow = summaryRows[0];
  const totalCount = sumRow !== undefined ? Number(sumRow.total_count) : 0;
  const sumSubtotal = sumRow !== undefined ? Number(sumRow.sum_subtotal) : 0;
  const sumTax = sumRow !== undefined ? Number(sumRow.sum_tax) : 0;
  const sumTotal = sumRow !== undefined ? Number(sumRow.sum_total) : 0;
  const sumCostSubtotal = sumRow !== undefined ? Number(sumRow.sum_cost_subtotal) : 0;

  const summary: QuotationListSummaryDto = {
    totalCount,
    subtotalAmount: sumSubtotal,
    taxTotal: sumTax,
    totalAmount: sumTotal,
    costSubtotal: sumCostSubtotal,
    grossProfitExcl: sumSubtotal - sumCostSubtotal,
  };

  const rows = await tx.query<QuotationListRow>(
    `SELECT q.id,
            q.quotation_no::text AS quotation_no,
            q.quotation_name,
            q.quotation_date::text AS quotation_date,
            q.partner_id,
            bp.partner_code,
            bp.partner_name,
            q.project_id,
            pj.project_no::text AS project_no,
            pj.project_name,
            q.honorific,
            q.status::text AS status,
            q.is_advance_type,
            q.is_selected,
            q.rounding_mode::text AS rounding_mode,
            q.tax_calc_policy::text AS tax_calc_policy,
            q.subtotal_amount::text AS subtotal_amount,
            q.tax_total::text AS tax_total,
            q.total_amount::text AS total_amount,
            COALESCE(ql_agg.cost_subtotal, 0)::text AS cost_subtotal,
            COALESCE(ql_agg.line_count, 0)::int AS line_count,
            COALESCE(ds_agg.snap_count, 0)::int AS snapshot_count,
            ds_agg.max_ver AS latest_snapshot_version,
            COALESCE(att_agg.att_count, 0)::int AS attachment_count,
            q.updated_at::text AS updated_at
       FROM quotations q
       JOIN business_partners bp ON bp.tenant_id = q.tenant_id AND bp.id = q.partner_id
       LEFT JOIN projects pj ON pj.tenant_id = q.tenant_id AND pj.id = q.project_id
       LEFT JOIN (
         SELECT quotation_id,
                COUNT(*)::int AS line_count,
                COALESCE(SUM(
                  CASE
                    WHEN is_heading THEN 0
                    WHEN tax_code IN ('D', 'E') THEN cost_amount - cost_tax
                    ELSE cost_amount
                  END
                ), 0) AS cost_subtotal
           FROM quotation_lines
          GROUP BY quotation_id
       ) ql_agg ON ql_agg.quotation_id = q.id
       LEFT JOIN (
         SELECT source_entity_id,
                COUNT(*)::int AS snap_count,
                MAX(version_no)::int AS max_ver
           FROM document_snapshots
          WHERE document_type IN ('ESTIMATE', 'ESTIMATE_SUMMARY_COVER', 'ESTIMATE_SUMMARY_DETAIL')
          GROUP BY source_entity_id
       ) ds_agg ON ds_agg.source_entity_id = q.id
       LEFT JOIN (
         SELECT entity_id, COUNT(*)::int AS att_count
           FROM attachments
          WHERE entity_type = 'QUOTATION'
          GROUP BY entity_id
       ) att_agg ON att_agg.entity_id = q.id
      WHERE (
        $1::text IS NULL
        OR CAST(q.quotation_no AS text) ILIKE '%' || $1 || '%'
        OR q.quotation_name ILIKE '%' || $1 || '%'
        OR bp.partner_name ILIKE '%' || $1 || '%'
        OR bp.partner_code ILIKE '%' || $1 || '%'
        OR COALESCE(pj.project_name, '') ILIKE '%' || $1 || '%'
      )
      AND ($2::text IS NULL OR q.status::text = $2)
      AND ($3::date IS NULL OR q.quotation_date >= $3::date)
      AND ($4::date IS NULL OR q.quotation_date <= $4::date)
      AND (
        $5::text = 'ALL'
        OR ($5::text = 'LINKED' AND q.project_id IS NOT NULL)
        OR ($5::text = 'UNLINKED' AND q.project_id IS NULL)
      )
      AND (
        $6::text = 'ALL'
        OR ($6::text = 'SELECTED' AND q.is_selected = true)
        OR ($6::text = 'UNSELECTED' AND q.is_selected = false)
      )
      ORDER BY q.quotation_date DESC, q.quotation_no DESC
      LIMIT $7 OFFSET $8`,
    [f.kw, f.status, f.dateFrom, f.dateTo, f.projectLink, f.selectedFilter, f.pageSize, f.offset],
  );

  const items: QuotationListItemDto[] = rows.map((r) => {
    const subtotalAmount = Number(r.subtotal_amount);
    const costSubtotal = Number(r.cost_subtotal);
    return {
      id: r.id,
      quotationNo: Number(r.quotation_no),
      quotationName: r.quotation_name,
      quotationDate: r.quotation_date.slice(0, 10),
      partnerId: r.partner_id,
      partnerCode: r.partner_code,
      partnerName: r.partner_name,
      projectId: r.project_id,
      projectNo: r.project_no !== null ? Number(r.project_no) : null,
      projectName: r.project_name,
      honorific: r.honorific,
      status: r.status,
      isAdvanceType: r.is_advance_type,
      isSelected: r.is_selected,
      roundingMode: r.rounding_mode,
      taxCalcPolicy: r.tax_calc_policy,
      subtotalAmount,
      taxTotal: Number(r.tax_total),
      totalAmount: Number(r.total_amount),
      costSubtotal,
      grossProfitExcl: subtotalAmount - costSubtotal,
      lineCount: Number(r.line_count),
      snapshotCount: Number(r.snapshot_count),
      latestSnapshotVersion: r.latest_snapshot_version !== null ? Number(r.latest_snapshot_version) : null,
      attachmentCount: Number(r.attachment_count),
      updatedAt: r.updated_at,
    };
  });

  return {
    items,
    summary,
    page: f.page,
    pageSize: f.pageSize,
  };
}

export async function getQuotationDetail(
  tx: DbExecutor,
  tenantId: string,
  id: string,
): Promise<QuotationDetailDto> {
  validateUuid(id, '見積');

  const headerRows = await tx.query<{
    id: string;
    quotation_no: string;
    quotation_name: string;
    quotation_date: string;
    partner_id: string;
    partner_code: string;
    partner_name: string;
    project_id: string | null;
    project_no: string | null;
    project_name: string | null;
    honorific: string;
    validity_period: string | null;
    delivery_date: string | null;
    status: QuotationStatus;
    is_advance_type: boolean;
    is_selected: boolean;
    rounding_mode: RoundingMode;
    tax_calc_policy: TaxCalcPolicy;
    subtotal_amount: string;
    tax_total: string;
    total_amount: string;
    remarks: string | null;
    created_at: string;
    updated_at: string;
  }>(
    `SELECT q.id, q.quotation_no::text AS quotation_no, q.quotation_name,
            q.quotation_date::text AS quotation_date,
            q.partner_id, bp.partner_code, bp.partner_name,
            q.project_id, pj.project_no::text AS project_no, pj.project_name,
            q.honorific, q.validity_period, q.delivery_date,
            q.status::text AS status, q.is_advance_type, q.is_selected,
            q.rounding_mode::text AS rounding_mode, q.tax_calc_policy::text AS tax_calc_policy,
            q.subtotal_amount::text AS subtotal_amount,
            q.tax_total::text AS tax_total,
            q.total_amount::text AS total_amount,
            q.remarks, q.created_at::text AS created_at, q.updated_at::text AS updated_at
       FROM quotations q
       JOIN business_partners bp ON bp.tenant_id = q.tenant_id AND bp.id = q.partner_id
       LEFT JOIN projects pj ON pj.tenant_id = q.tenant_id AND pj.id = q.project_id
      WHERE q.id = $1::uuid
      LIMIT 1`,
    [id],
  );
  const hdr = headerRows[0];
  if (hdr === undefined) {
    throw new MasterDataError(404, 'QUOTATION_NOT_FOUND', '指定された見積が見つかりません。');
  }

  const lineRows = await tx.query<{
    id: string;
    line_no: number;
    product_id: string | null;
    item_code: string | null;
    item_name: string;
    unit_name: string | null;
    is_heading: boolean;
    quantity: string;
    tax_code: TaxCode;
    cost_category: CostCategory | null;
    master_unit_price: string | null;
    applied_unit_price: string;
    line_amount: string;
    line_tax: string;
    line_total: string;
    master_cost_price: string | null;
    applied_cost_price: string;
    cost_amount: string;
    cost_tax: string;
    cost_total: string;
    remarks: string | null;
  }>(
    `SELECT id, line_no, product_id, item_code, item_name, unit_name, is_heading,
            quantity::text AS quantity, tax_code, cost_category::text AS cost_category,
            master_unit_price::text AS master_unit_price,
            applied_unit_price::text AS applied_unit_price,
            line_amount::text AS line_amount,
            line_tax::text AS line_tax,
            line_total::text AS line_total,
            master_cost_price::text AS master_cost_price,
            applied_cost_price::text AS applied_cost_price,
            cost_amount::text AS cost_amount,
            cost_tax::text AS cost_tax,
            cost_total::text AS cost_total,
            remarks
       FROM quotation_lines
      WHERE quotation_id = $1::uuid
      ORDER BY line_no ASC`,
    [id],
  );

  const lines: QuotationLineDto[] = lineRows.map((l) => ({
    id: l.id,
    lineNo: Number(l.line_no),
    productId: l.product_id,
    itemCode: l.item_code,
    itemName: l.item_name,
    unitName: l.unit_name,
    isHeading: l.is_heading,
    quantity: Number(l.quantity),
    taxCode: l.tax_code,
    costCategory: l.cost_category,
    masterUnitPrice: l.master_unit_price !== null ? Number(l.master_unit_price) : null,
    appliedUnitPrice: Number(l.applied_unit_price),
    lineAmount: Number(l.line_amount),
    lineTax: Number(l.line_tax),
    lineTotal: Number(l.line_total),
    masterCostPrice: l.master_cost_price !== null ? Number(l.master_cost_price) : null,
    appliedCostPrice: Number(l.applied_cost_price),
    costAmount: Number(l.cost_amount),
    costTax: Number(l.cost_tax),
    costTotal: Number(l.cost_total),
    remarks: l.remarks,
  }));

  const calc = calculateQuotationSlip(
    lines.map((l) => ({
      lineNo: l.lineNo,
      isHeading: l.isHeading,
      quantity: l.quantity,
      appliedUnitPrice: BigInt(l.appliedUnitPrice),
      appliedCostPrice: BigInt(l.appliedCostPrice),
      taxCode: l.taxCode,
    })),
    hdr.rounding_mode,
    hdr.tax_calc_policy,
  );

  const subtotalAmount = Number(hdr.subtotal_amount);
  const costSubtotal = Number(calc.costSubtotal);
  const grossProfitExcl = subtotalAmount - costSubtotal;
  const grossMarginExclPercent = computeMarginPercent(
    BigInt(hdr.subtotal_amount) - calc.costSubtotal,
    BigInt(hdr.subtotal_amount),
  );

  const [estSnaps, coverSnaps, detailSnaps] = await Promise.all([
    listEntitySnapshots(tx, { documentType: 'ESTIMATE', sourceEntityId: id }),
    listEntitySnapshots(tx, { documentType: 'ESTIMATE_SUMMARY_COVER', sourceEntityId: id }),
    listEntitySnapshots(tx, { documentType: 'ESTIMATE_SUMMARY_DETAIL', sourceEntityId: id }),
  ]);
  const snapshots = [...estSnaps, ...coverSnaps, ...detailSnaps].sort((a, b) =>
    b.issuedAt.localeCompare(a.issuedAt),
  );

  const estimateImageEnabled = await isFeatureEnabled(tx, tenantId, 'estimateimage');
  const attachments: AttachmentDto[] = estimateImageEnabled
    ? await listAttachments(tx, tenantId, 'QUOTATION', id)
    : [];

  return {
    id: hdr.id,
    quotationNo: Number(hdr.quotation_no),
    quotationName: hdr.quotation_name,
    quotationDate: hdr.quotation_date.slice(0, 10),
    partnerId: hdr.partner_id,
    partnerCode: hdr.partner_code,
    partnerName: hdr.partner_name,
    projectId: hdr.project_id,
    projectNo: hdr.project_no !== null ? Number(hdr.project_no) : null,
    projectName: hdr.project_name,
    honorific: hdr.honorific,
    validityPeriod: hdr.validity_period,
    deliveryDate: hdr.delivery_date,
    status: hdr.status,
    isAdvanceType: hdr.is_advance_type,
    isSelected: hdr.is_selected,
    roundingMode: hdr.rounding_mode,
    taxCalcPolicy: hdr.tax_calc_policy,
    subtotalAmount,
    taxTotal: Number(hdr.tax_total),
    totalAmount: Number(hdr.total_amount),
    costSubtotal,
    costTaxTotal: Number(calc.costTaxTotal),
    costTotal: Number(calc.costTotal),
    grossProfitExcl,
    grossMarginExclPercent,
    remarks: hdr.remarks,
    createdAt: hdr.created_at,
    updatedAt: hdr.updated_at,
    lines,
    snapshots,
    attachments,
  };
}

async function assertReferencesExist(
  tx: DbExecutor,
  clean: CleanQuotationPayload,
): Promise<void> {
  const partnerRows = await tx.query<{ id: string }>(
    'SELECT id FROM business_partners WHERE id = $1::uuid LIMIT 1',
    [clean.partnerId],
  );
  if (partnerRows.length === 0) {
    throw new MasterDataError(400, 'PARTNER_NOT_FOUND', '指定された取引先が見つかりません。');
  }

  if (clean.projectId !== null) {
    const projectRows = await tx.query<{ id: string }>(
      'SELECT id FROM projects WHERE id = $1::uuid LIMIT 1',
      [clean.projectId],
    );
    if (projectRows.length === 0) {
      throw new MasterDataError(400, 'PROJECT_NOT_FOUND', '指定された案件が見つかりません。');
    }
  }

  const productIds = Array.from(
    new Set(clean.lines.map((l) => l.productId).filter((pid): pid is string => pid !== null)),
  );
  if (productIds.length > 0) {
    const prodRows = await tx.query<{ id: string }>(
      'SELECT id FROM products WHERE id = ANY($1::uuid[])',
      [productIds],
    );
    if (prodRows.length !== productIds.length) {
      throw new MasterDataError(400, 'PRODUCT_NOT_FOUND', '明細に存在しない商品IDが含まれています。');
    }
  }
}

async function insertQuotationLines(
  tx: DbExecutor,
  tenantId: string,
  quotationId: string,
  cleanLines: readonly CleanQuotationLine[],
  roundingMode: RoundingMode,
  policy: TaxCalcPolicy,
): Promise<void> {
  const calc = calculateQuotationSlip(
    cleanLines.map((l, idx) => ({
      lineNo: idx + 1,
      isHeading: l.isHeading,
      quantity: l.quantityStr,
      appliedUnitPrice: BigInt(l.appliedUnitPrice),
      appliedCostPrice: BigInt(l.appliedCostPrice),
      taxCode: l.taxCode,
    })),
    roundingMode,
    policy,
  );

  for (let i = 0; i < cleanLines.length; i += 1) {
    const line = cleanLines[i];
    const lr = calc.lineResults[i];
    if (line === undefined || lr === undefined) continue;

    await tx.query(
      `INSERT INTO quotation_lines (
         tenant_id, quotation_id, line_no, product_id, item_code, item_name, unit_name,
         is_heading, quantity, tax_code, cost_category,
         master_unit_price, applied_unit_price, line_amount, line_tax, line_total,
         master_cost_price, applied_cost_price, cost_amount, cost_tax, cost_total, remarks
       ) VALUES (
         $1::uuid, $2::uuid, $3, $4::uuid, $5, $6, $7,
         $8, $9::numeric, $10, $11::cost_category,
         $12::numeric, $13::numeric, $14::numeric, $15::numeric, $16::numeric,
         $17::numeric, $18::numeric, $19::numeric, $20::numeric, $21::numeric, $22
       )`,
      [
        tenantId,
        quotationId,
        i + 1,
        line.productId,
        line.itemCode,
        line.itemName,
        line.unitName,
        line.isHeading,
        line.quantityStr,
        line.taxCode,
        line.costCategory,
        line.masterUnitPrice !== null ? String(line.masterUnitPrice) : null,
        String(line.appliedUnitPrice),
        lr.lineAmount.toString(),
        lr.lineTax.toString(),
        lr.lineTotal.toString(),
        line.masterCostPrice !== null ? String(line.masterCostPrice) : null,
        String(line.appliedCostPrice),
        lr.costAmount.toString(),
        lr.costTax.toString(),
        lr.costTotal.toString(),
        line.remarks,
      ],
    );
  }
}

export async function createQuotation(
  tx: DbExecutor,
  tenantId: string,
  employeeId: string,
  input: QuotationInput,
): Promise<QuotationDetailDto> {
  const clean = validateQuotationInput(input);
  await assertReferencesExist(tx, clean);

  // テナント単位の排他ロック取得（同時採番の競合防止）
  const settingsRows = await tx.query<{ tax_calc_policy: TaxCalcPolicy }>(
    `SELECT tax_calc_policy::text AS tax_calc_policy
       FROM tenant_settings
      WHERE tenant_id = $1::uuid
      FOR UPDATE`,
    [tenantId],
  );
  const settings = settingsRows[0];
  if (settings === undefined) {
    throw new MasterDataError(404, 'TENANT_SETTINGS_NOT_FOUND', '自社設定が見つかりません。');
  }

  const policy: TaxCalcPolicy =
    clean.requestedPolicy !== null ? clean.requestedPolicy : settings.tax_calc_policy;

  const calc = calculateQuotationSlip(
    clean.lines.map((l, idx) => ({
      lineNo: idx + 1,
      isHeading: l.isHeading,
      quantity: l.quantityStr,
      appliedUnitPrice: BigInt(l.appliedUnitPrice),
      appliedCostPrice: BigInt(l.appliedCostPrice),
      taxCode: l.taxCode,
    })),
    clean.roundingMode,
    policy,
  );

  try {
    const noRows = await tx.query<{ next_no: string }>(
      'SELECT (COALESCE(MAX(quotation_no), 0) + 1)::text AS next_no FROM quotations',
      [],
    );
    const nextNo = noRows[0] !== undefined ? noRows[0].next_no : '1';

    const inserted = await tx.query<{ id: string }>(
      `INSERT INTO quotations (
         tenant_id, quotation_no, quotation_name, quotation_date, partner_id, project_id,
         honorific, validity_period, delivery_date, status, is_advance_type, is_selected,
         rounding_mode, tax_calc_policy, subtotal_amount, tax_total, total_amount,
         remarks, created_by, updated_by
       ) VALUES (
         $1::uuid, $2::bigint, $3, $4::date, $5::uuid, $6::uuid,
         $7, $8, $9, $10::quotation_status, $11, $12,
         $13::rounding_mode, $14::tax_calc_policy, $15::numeric, $16::numeric, $17::numeric,
         $18, $19::uuid, $19::uuid
       ) RETURNING id`,
      [
        tenantId,
        nextNo,
        clean.quotationName,
        clean.quotationDate,
        clean.partnerId,
        clean.projectId,
        clean.honorific,
        clean.validityPeriod,
        clean.deliveryDate,
        clean.status,
        clean.isAdvanceType,
        clean.isSelected,
        clean.roundingMode,
        policy,
        calc.subtotalAmount.toString(),
        calc.taxTotal.toString(),
        calc.totalAmount.toString(),
        clean.remarks,
        employeeId,
      ],
    );

    const quotationId = inserted[0]?.id;
    if (quotationId === undefined) {
      throw new MasterDataError(500, 'INSERT_FAILED', '見積ヘッダの登録結果を取得できませんでした。');
    }

    await insertQuotationLines(tx, tenantId, quotationId, clean.lines, clean.roundingMode, policy);
    return getQuotationDetail(tx, tenantId, quotationId);
  } catch (err) {
    throw mapPgConstraintError(err, { entityLabel: '見積' });
  }
}

export async function updateQuotation(
  tx: DbExecutor,
  tenantId: string,
  employeeId: string,
  id: string,
  input: QuotationInput,
): Promise<QuotationDetailDto> {
  validateUuid(id, '見積');
  const clean = validateQuotationInput(input);
  await assertReferencesExist(tx, clean);

  const lockRows = await tx.query<{ id: string; tax_calc_policy: TaxCalcPolicy }>(
    `SELECT id, tax_calc_policy::text AS tax_calc_policy
       FROM quotations
      WHERE id = $1::uuid
      FOR UPDATE`,
    [id],
  );
  const existing = lockRows[0];
  if (existing === undefined) {
    throw new MasterDataError(404, 'QUOTATION_NOT_FOUND', '指定された見積が見つかりません。');
  }

  const policy: TaxCalcPolicy =
    clean.requestedPolicy !== null ? clean.requestedPolicy : existing.tax_calc_policy;

  const calc = calculateQuotationSlip(
    clean.lines.map((l, idx) => ({
      lineNo: idx + 1,
      isHeading: l.isHeading,
      quantity: l.quantityStr,
      appliedUnitPrice: BigInt(l.appliedUnitPrice),
      appliedCostPrice: BigInt(l.appliedCostPrice),
      taxCode: l.taxCode,
    })),
    clean.roundingMode,
    policy,
  );

  try {
    await tx.query(
      `UPDATE quotations
          SET quotation_name = $2,
              quotation_date = $3::date,
              partner_id = $4::uuid,
              project_id = $5::uuid,
              honorific = $6,
              validity_period = $7,
              delivery_date = $8,
              status = $9::quotation_status,
              is_advance_type = $10,
              is_selected = $11,
              rounding_mode = $12::rounding_mode,
              tax_calc_policy = $13::tax_calc_policy,
              subtotal_amount = $14::numeric,
              tax_total = $15::numeric,
              total_amount = $16::numeric,
              remarks = $17,
              updated_by = $18::uuid
        WHERE id = $1::uuid`,
      [
        id,
        clean.quotationName,
        clean.quotationDate,
        clean.partnerId,
        clean.projectId,
        clean.honorific,
        clean.validityPeriod,
        clean.deliveryDate,
        clean.status,
        clean.isAdvanceType,
        clean.isSelected,
        clean.roundingMode,
        policy,
        calc.subtotalAmount.toString(),
        calc.taxTotal.toString(),
        calc.totalAmount.toString(),
        clean.remarks,
        employeeId,
      ],
    );

    await tx.query('DELETE FROM quotation_lines WHERE quotation_id = $1::uuid', [id]);
    await insertQuotationLines(tx, tenantId, id, clean.lines, clean.roundingMode, policy);

    return getQuotationDetail(tx, tenantId, id);
  } catch (err) {
    throw mapPgConstraintError(err, { entityLabel: '見積' });
  }
}

export async function duplicateQuotation(
  tx: DbExecutor,
  tenantId: string,
  employeeId: string,
  sourceId: string,
): Promise<QuotationDetailDto> {
  validateUuid(sourceId, '複写元見積');

  const source = await getQuotationDetail(tx, tenantId, sourceId);
  if (source.lines.length === 0) {
    throw new MasterDataError(400, 'EMPTY_SOURCE_LINES', '明細が存在しない見積は複写できません。');
  }

  const copyName = `${source.quotationName}（コピー）`.slice(0, 200);
  const today = new Date().toISOString().slice(0, 10);

  const linesInput: QuotationLineInput[] = source.lines.map((l) => ({
    productId: l.productId,
    itemCode: l.itemCode,
    itemName: l.itemName,
    unitName: l.unitName,
    isHeading: l.isHeading,
    quantity: l.quantity,
    taxCode: l.taxCode,
    costCategory: l.costCategory,
    masterUnitPrice: l.masterUnitPrice,
    appliedUnitPrice: l.appliedUnitPrice,
    masterCostPrice: l.masterCostPrice,
    appliedCostPrice: l.appliedCostPrice,
    remarks: l.remarks,
  }));

  const copyInput: QuotationInput = {
    quotationName: copyName,
    quotationDate: today,
    partnerId: source.partnerId,
    projectId: source.projectId,
    honorific: source.honorific,
    validityPeriod: source.validityPeriod,
    deliveryDate: source.deliveryDate,
    status: 'Q1',
    isAdvanceType: source.isAdvanceType,
    isSelected: false,
    roundingMode: source.roundingMode,
    taxCalcPolicy:
      source.taxCalcPolicy === 'LEGACY_LINE_SUM' ? 'SLIP_BY_RATE' : source.taxCalcPolicy,
    remarks: source.remarks,
    lines: linesInput,
  };

  return createQuotation(tx, tenantId, employeeId, copyInput);
}

export async function deleteQuotation(tx: DbExecutor, id: string): Promise<void> {
  validateUuid(id, '見積');

  const lockRows = await tx.query<{ id: string }>(
    'SELECT id FROM quotations WHERE id = $1::uuid FOR UPDATE',
    [id],
  );
  if (lockRows.length === 0) {
    throw new MasterDataError(404, 'QUOTATION_NOT_FOUND', '指定された見積が見つかりません。');
  }

  const snapRows = await tx.query<{ cnt: number }>(
    `SELECT COUNT(*)::int AS cnt
       FROM document_snapshots
      WHERE document_type IN ('ESTIMATE', 'ESTIMATE_SUMMARY_COVER', 'ESTIMATE_SUMMARY_DETAIL')
        AND source_entity_id = $1::uuid`,
    [id],
  );
  const snapCount = snapRows[0] !== undefined ? Number(snapRows[0].cnt) : 0;
  if (snapCount > 0) {
    throw new MasterDataError(
      409,
      'QUOTATION_HAS_SNAPSHOTS',
      '見積書が発行済み（スナップショットが存在する）の見積データは削除できません。',
    );
  }

  const attRows = await tx.query<{ id: string; storage_key: string }>(
    `SELECT id, storage_key
       FROM attachments
      WHERE entity_type = 'QUOTATION'
        AND entity_id = $1::uuid`,
    [id],
  );

  if (attRows.length > 0) {
    await tx.query(
      `DELETE FROM attachments
        WHERE entity_type = 'QUOTATION'
          AND entity_id = $1::uuid`,
      [id],
    );
  }

  await tx.query('DELETE FROM quotations WHERE id = $1::uuid', [id]);

  for (const att of attRows) {
    await removeAttachmentObject({ storageKey: att.storage_key });
  }
}

function escapeCsvCell(value: string): string {
  const escaped = value.replace(/"/g, '""');
  return `"${escaped}"`;
}

export async function exportQuotationsCsv(
  tx: DbExecutor,
  filter: QuotationListFilter = {},
): Promise<string> {
  const page = await listQuotations(tx, { ...filter, page: 1, pageSize: 5000 });
  const header = [
    '見積番号',
    '見積日',
    'ステータス',
    '採用',
    '立替区分',
    '取引先コード',
    '取引先名',
    '案件番号',
    '案件名',
    '件名',
    '税抜合計',
    '消費税合計',
    '税込合計',
    '予定原価(税抜)',
    '予定粗利(税抜)',
  ].map(escapeCsvCell).join(',');

  const lines = page.items.map((item) =>
    [
      String(item.quotationNo),
      item.quotationDate,
      QUOTATION_STATUS_LABELS[item.status],
      item.isSelected ? '採用' : '',
      item.isAdvanceType ? '立替' : '',
      item.partnerCode,
      item.partnerName,
      item.projectNo !== null ? String(item.projectNo) : '',
      item.projectName !== null ? item.projectName : '',
      item.quotationName,
      String(item.subtotalAmount),
      String(item.taxTotal),
      String(item.totalAmount),
      String(item.costSubtotal),
      String(item.grossProfitExcl),
    ]
      .map(escapeCsvCell)
      .join(','),
  );

  return `\uFEFF${[header, ...lines].join('\r\n')}`;
}

export async function exportQuotationsListPdf(
  tx: DbExecutor,
  tenantId: string,
  filter: QuotationListFilter = {},
): Promise<Uint8Array> {
  const settingsRows = await tx.query<{ company_name: string }>(
    'SELECT company_name FROM tenant_settings WHERE tenant_id = $1::uuid LIMIT 1',
    [tenantId],
  );
  const companyName = settingsRows[0] !== undefined ? settingsRows[0].company_name : '自社';

  const page = await listQuotations(tx, { ...filter, page: 1, pageSize: 5000 });
  const parts: string[] = [];
  if (optTrimmed(filter.keyword) !== null) parts.push(`検索:${optTrimmed(filter.keyword)}`);
  if (filter.status !== undefined && filter.status !== null) parts.push(`状態:${QUOTATION_STATUS_LABELS[filter.status]}`);
  if (optTrimmed(filter.dateFrom) !== null || optTrimmed(filter.dateTo) !== null) {
    parts.push(`期間:${optTrimmed(filter.dateFrom) ?? ''}〜${optTrimmed(filter.dateTo) ?? ''}`);
  }
  if (filter.projectLink === 'LINKED') parts.push('案件紐付あり');
  if (filter.projectLink === 'UNLINKED') parts.push('案件未紐付');
  if (filter.selectedFilter === 'SELECTED') parts.push('採用のみ');
  if (filter.selectedFilter === 'UNSELECTED') parts.push('未採用のみ');

  return renderEstimateListPdf({
    companyName,
    generatedDate: new Date().toISOString().slice(0, 10),
    filterSummary: parts.length > 0 ? parts.join(' / ') : '全件',
    items: page.items.map((item) => ({
      quotationNo: item.quotationNo,
      quotationDate: item.quotationDate,
      status: item.status,
      isSelected: item.isSelected,
      isAdvanceType: item.isAdvanceType,
      partnerName: item.partnerName,
      quotationName: item.quotationName,
      projectName: item.projectName,
      subtotalAmount: item.subtotalAmount,
      taxTotal: item.taxTotal,
      totalAmount: item.totalAmount,
      costSubtotal: item.costSubtotal,
      grossProfitExcl: item.grossProfitExcl,
    })),
    totals: {
      count: page.summary.totalCount,
      subtotalAmount: page.summary.subtotalAmount,
      taxTotal: page.summary.taxTotal,
      totalAmount: page.summary.totalAmount,
      costSubtotal: page.summary.costSubtotal,
      grossProfitExcl: page.summary.grossProfitExcl,
    },
  });
}
