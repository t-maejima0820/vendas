import Decimal from 'decimal.js';
import type { DbExecutor } from '@/lib/db/tenant-client';
import {
  calculateQuotationSlip,
  type CostCategory,
  type CostTaxMode,
  type RoundingMode,
  type TaxCalcPolicy,
  type TaxCode,
} from '@/lib/domain/calculations';
import { renderProjectCostListPdf } from '@/lib/domain/pdf-renderer';
import { COST_CATEGORY_LABELS } from '@/lib/estimates/types';
import { requireFeature } from '@/lib/feature-flags/gate';
import { mapPgConstraintError, MasterDataError } from '@/lib/masters/error-mapper';
import type {
  CandidatePurchaseForCostDto,
  ImportCostFromPurchaseInput,
  ProjectCostCategorySummaryDto,
  ProjectCostDetailDto,
  ProjectCostInput,
  ProjectCostLineDto,
  ProjectCostLineInput,
  ProjectCostListItemDto,
  ProjectCostPageDto,
} from '@/lib/project-costs/types';
import {
  COST_CATEGORY_LIST,
  PROJECT_STATUS_LABELS,
  type ProjectStatus,
} from '@/lib/projects/types';

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DATE_REGEX = /^\d{4}-\d{2}-\d{2}$/;
const VALID_STATUSES = new Set<ProjectStatus>(['C1', 'C2', 'C3']);
const VALID_ROUNDING_MODES = new Set<RoundingMode>(['FLOOR', 'ROUND', 'CEIL']);
const VALID_TAX_CODES = new Set<TaxCode>(['A', 'B', 'C', 'D', 'E']);
const VALID_COST_CATEGORIES = new Set<CostCategory>(COST_CATEGORY_LIST);

export interface ProjectCostListFilter {
  projectId?: string | null;
  costCategory?: CostCategory | null;
  status?: ProjectStatus | null;
  dateFrom?: string | null;
  dateTo?: string | null;
  keyword?: string | null;
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

function escapeCsvCell(value: string): string {
  const escaped = value.replace(/"/g, '""');
  return `"${escaped}"`;
}

interface CleanCostLine {
  productId: string | null;
  itemCode: string | null;
  itemName: string;
  unitName: string | null;
  isHeading: boolean;
  quantityStr: string;
  taxCode: TaxCode;
  masterUnitPrice: number | null;
  appliedUnitPrice: number;
  appliedCostPrice: number;
  sourcePurchaseLineId: string | null;
  remarks: string | null;
}

interface CleanCostPayload {
  projectId: string;
  costCategory: CostCategory;
  slipTitle: string;
  entryDate: string;
  status: ProjectStatus;
  roundingMode: RoundingMode;
  lines: CleanCostLine[];
}

function validateCostInput(input: ProjectCostInput): CleanCostPayload {
  validateUuid(input.projectId, '案件');
  if (!VALID_COST_CATEGORIES.has(input.costCategory)) {
    throw new MasterDataError(400, 'INVALID_COST_CATEGORY', '原価費目区分が不正です。');
  }
  const slipTitle = input.slipTitle.trim();
  if (slipTitle.length === 0 || slipTitle.length > 200) {
    throw new MasterDataError(400, 'INVALID_SLIP_TITLE', '原価伝票件名は1〜200文字で入力してください。');
  }
  const entryDate = validateDateOnly(input.entryDate, '計上日');
  if (!VALID_STATUSES.has(input.status)) {
    throw new MasterDataError(400, 'INVALID_STATUS', 'ステータスは C1〜C3 を指定してください。');
  }
  if (!VALID_ROUNDING_MODES.has(input.roundingMode)) {
    throw new MasterDataError(400, 'INVALID_ROUNDING_MODE', '端数処理が不正です。');
  }
  if (!Array.isArray(input.lines) || input.lines.length === 0) {
    throw new MasterDataError(400, 'LINES_REQUIRED', '原価明細は最低1行以上入力してください。');
  }

  const lines: CleanCostLine[] = input.lines.map((line: ProjectCostLineInput, idx: number) => {
    const lineNo = idx + 1;
    const isHeading = Boolean(line.isHeading);
    const itemName = line.itemName.trim();
    if (itemName.length === 0 || itemName.length > 300) {
      throw new MasterDataError(
        400,
        'INVALID_ITEM_NAME',
        `${lineNo}行目の品名・作業内容は1〜300文字で入力してください。`,
      );
    }

    let productId: string | null = null;
    if (line.productId !== null && line.productId.trim() !== '') {
      validateUuid(line.productId.trim(), `${lineNo}行目の商品`);
      productId = line.productId.trim();
    }

    let sourcePurchaseLineId: string | null = null;
    if (
      line.sourcePurchaseLineId !== undefined &&
      line.sourcePurchaseLineId !== null &&
      line.sourcePurchaseLineId.trim() !== ''
    ) {
      validateUuid(line.sourcePurchaseLineId.trim(), `${lineNo}行目の元仕入明細`);
      sourcePurchaseLineId = line.sourcePurchaseLineId.trim();
    }

    const taxCode: TaxCode = isHeading ? 'C' : line.taxCode;
    if (!VALID_TAX_CODES.has(taxCode)) {
      throw new MasterDataError(400, 'INVALID_TAX_CODE', `${lineNo}行目の税区分が不正です。`);
    }

    const quantityStr = isHeading ? '0' : validateQuantity(line.quantity, lineNo);
    const masterUnitPrice = validateOptionalIntegerYen(line.masterUnitPrice, `${lineNo}行目の基準単価`);
    const appliedUnitPrice = isHeading
      ? 0
      : validateIntegerYen(line.appliedUnitPrice, `${lineNo}行目の単価`);
    const appliedCostPrice = isHeading
      ? 0
      : line.appliedCostPrice !== undefined && line.appliedCostPrice !== null
        ? validateIntegerYen(line.appliedCostPrice, `${lineNo}行目の原価単価`)
        : appliedUnitPrice;

    return {
      productId,
      itemCode: optTrimmed(line.itemCode),
      itemName,
      unitName: isHeading ? null : optTrimmed(line.unitName),
      isHeading,
      quantityStr,
      taxCode,
      masterUnitPrice,
      appliedUnitPrice,
      appliedCostPrice,
      sourcePurchaseLineId,
      remarks: optTrimmed(line.remarks),
    };
  });

  return {
    projectId: input.projectId.trim(),
    costCategory: input.costCategory,
    slipTitle,
    entryDate,
    status: input.status,
    roundingMode: input.roundingMode,
    lines,
  };
}

async function validateCostReferences(
  tx: DbExecutor,
  tenantId: string,
  payload: CleanCostPayload,
): Promise<{ openingBalanceDate: string; policy: TaxCalcPolicy }> {
  const tsRows = await tx.query<{
    opening_balance_date: string;
    tax_calc_policy: TaxCalcPolicy;
  }>(
    `SELECT opening_balance_date::text AS opening_balance_date,
            tax_calc_policy::text AS tax_calc_policy
       FROM tenant_settings
      WHERE tenant_id = $1::uuid
      LIMIT 1`,
    [tenantId],
  );
  const ts = tsRows[0];
  if (ts === undefined) {
    throw new MasterDataError(404, 'TENANT_SETTINGS_NOT_FOUND', '自社設定が見つかりません。');
  }

  const pjRows = await tx.query<{ id: string }>(
    'SELECT id FROM projects WHERE id = $1::uuid LIMIT 1',
    [payload.projectId],
  );
  if (pjRows.length === 0) {
    throw new MasterDataError(400, 'PROJECT_NOT_FOUND', '指定された案件が見つかりません。');
  }

  const prodIds = payload.lines
    .map((l) => l.productId)
    .filter((id): id is string => id !== null);
  if (prodIds.length > 0) {
    const prodRows = await tx.query<{ id: string }>(
      'SELECT id FROM products WHERE id = ANY($1::uuid[]) AND is_deleted = false',
      [prodIds],
    );
    const prodSet = new Set(prodRows.map((r) => r.id));
    for (const id of prodIds) {
      if (!prodSet.has(id)) {
        throw new MasterDataError(400, 'PRODUCT_NOT_FOUND', '明細で指定された商品が見つかりません。');
      }
    }
  }

  return {
    openingBalanceDate: ts.opening_balance_date.slice(0, 10),
    policy: ts.tax_calc_policy,
  };
}

export async function listProjectCosts(
  tx: DbExecutor,
  tenantId: string,
  filter: ProjectCostListFilter = {},
): Promise<ProjectCostPageDto> {
  await requireFeature(tx, tenantId, 'cost');

  const tsRows = await tx.query<{ cost_tax_mode: CostTaxMode }>(
    'SELECT cost_tax_mode::text AS cost_tax_mode FROM tenant_settings WHERE tenant_id = $1::uuid LIMIT 1',
    [tenantId],
  );
  const costTaxMode: CostTaxMode =
    tsRows[0] !== undefined ? tsRows[0].cost_tax_mode : 'TAX_EXCLUDED';

  const rawProject = optTrimmed(filter.projectId);
  if (rawProject !== null) {
    validateUuid(rawProject, '案件');
  }
  const costCategory =
    filter.costCategory !== undefined &&
    filter.costCategory !== null &&
    VALID_COST_CATEGORIES.has(filter.costCategory)
      ? filter.costCategory
      : null;
  const status =
    filter.status !== undefined && filter.status !== null && VALID_STATUSES.has(filter.status)
      ? filter.status
      : null;
  const rawFrom = optTrimmed(filter.dateFrom);
  const dateFrom = rawFrom !== null && DATE_REGEX.test(rawFrom) ? rawFrom : null;
  const rawTo = optTrimmed(filter.dateTo);
  const dateTo = rawTo !== null && DATE_REGEX.test(rawTo) ? rawTo : null;
  const kw = optTrimmed(filter.keyword);

  const rawPage = filter.page === undefined ? 1 : filter.page;
  const rawSize = filter.pageSize === undefined ? 25 : filter.pageSize;
  const page = Number.isInteger(rawPage) && rawPage >= 1 ? rawPage : 1;
  const pageSize = Number.isInteger(rawSize) && rawSize >= 1 && rawSize <= 5000 ? rawSize : 25;
  const offset = (page - 1) * pageSize;

  const [sumRows, byCatRows, rows] = await Promise.all([
    tx.query<{
      total_count: number;
      subtotal_amount: string;
      tax_total: string;
      total_amount: string;
    }>(
      `SELECT COUNT(*)::int AS total_count,
              COALESCE(SUM(h.subtotal_amount), 0)::text AS subtotal_amount,
              COALESCE(SUM(h.tax_total), 0)::text AS tax_total,
              COALESCE(SUM(h.total_amount), 0)::text AS total_amount
         FROM project_cost_headers h
         JOIN projects pj ON pj.tenant_id = h.tenant_id AND pj.id = h.project_id
         JOIN business_partners bp ON bp.tenant_id = pj.tenant_id AND bp.id = pj.partner_id
        WHERE ($1::uuid IS NULL OR h.project_id = $1::uuid)
          AND ($2::text IS NULL OR h.cost_category::text = $2)
          AND ($3::text IS NULL OR h.status::text = $3)
          AND ($4::date IS NULL OR h.entry_date >= $4::date)
          AND ($5::date IS NULL OR h.entry_date <= $5::date)
          AND ($6::text IS NULL OR h.slip_title ILIKE '%' || $6 || '%'
               OR pj.project_no::text = $6
               OR pj.project_name ILIKE '%' || $6 || '%'
               OR bp.partner_name ILIKE '%' || $6 || '%'
               OR EXISTS (
                 SELECT 1 FROM project_cost_lines l
                  WHERE l.cost_header_id = h.id
                    AND l.item_name ILIKE '%' || $6 || '%'
               ))`,
      [rawProject, costCategory, status, dateFrom, dateTo, kw],
    ),
    tx.query<{
      cost_category: CostCategory;
      header_count: number;
      subtotal_amount: string;
      total_amount: string;
    }>(
      `SELECT h.cost_category::text AS cost_category,
              COUNT(*)::int AS header_count,
              COALESCE(SUM(h.subtotal_amount), 0)::text AS subtotal_amount,
              COALESCE(SUM(h.total_amount), 0)::text AS total_amount
         FROM project_cost_headers h
         JOIN projects pj ON pj.tenant_id = h.tenant_id AND pj.id = h.project_id
         JOIN business_partners bp ON bp.tenant_id = pj.tenant_id AND bp.id = pj.partner_id
        WHERE ($1::uuid IS NULL OR h.project_id = $1::uuid)
          AND ($2::text IS NULL OR h.cost_category::text = $2)
          AND ($3::text IS NULL OR h.status::text = $3)
          AND ($4::date IS NULL OR h.entry_date >= $4::date)
          AND ($5::date IS NULL OR h.entry_date <= $5::date)
          AND ($6::text IS NULL OR h.slip_title ILIKE '%' || $6 || '%'
               OR pj.project_no::text = $6
               OR pj.project_name ILIKE '%' || $6 || '%'
               OR bp.partner_name ILIKE '%' || $6 || '%'
               OR EXISTS (
                 SELECT 1 FROM project_cost_lines l
                  WHERE l.cost_header_id = h.id
                    AND l.item_name ILIKE '%' || $6 || '%'
               ))
        GROUP BY h.cost_category`,
      [rawProject, costCategory, status, dateFrom, dateTo, kw],
    ),
    tx.query<{
      id: string;
      project_id: string;
      project_no: string;
      project_name: string;
      partner_name: string;
      cost_category: CostCategory;
      slip_title: string;
      entry_date: string;
      status: ProjectStatus;
      rounding_mode: RoundingMode;
      subtotal_amount: string;
      tax_total: string;
      total_amount: string;
      cost_subtotal: string;
      cost_total: string;
      line_count: number;
      has_purchase_link: boolean;
      updated_at: string;
    }>(
      `SELECT h.id, h.project_id, pj.project_no::text AS project_no, pj.project_name,
              bp.partner_name,
              h.cost_category::text AS cost_category,
              h.slip_title, h.entry_date::text AS entry_date,
              h.status::text AS status, h.rounding_mode::text AS rounding_mode,
              h.subtotal_amount::text AS subtotal_amount,
              h.tax_total::text AS tax_total,
              h.total_amount::text AS total_amount,
              h.cost_subtotal::text AS cost_subtotal,
              h.cost_total::text AS cost_total,
              (SELECT COUNT(*)::int FROM project_cost_lines l WHERE l.cost_header_id = h.id) AS line_count,
              EXISTS (
                SELECT 1 FROM project_cost_lines l
                 WHERE l.cost_header_id = h.id AND l.source_purchase_line_id IS NOT NULL
              ) AS has_purchase_link,
              h.updated_at::text AS updated_at
         FROM project_cost_headers h
         JOIN projects pj ON pj.tenant_id = h.tenant_id AND pj.id = h.project_id
         JOIN business_partners bp ON bp.tenant_id = pj.tenant_id AND bp.id = pj.partner_id
        WHERE ($1::uuid IS NULL OR h.project_id = $1::uuid)
          AND ($2::text IS NULL OR h.cost_category::text = $2)
          AND ($3::text IS NULL OR h.status::text = $3)
          AND ($4::date IS NULL OR h.entry_date >= $4::date)
          AND ($5::date IS NULL OR h.entry_date <= $5::date)
          AND ($6::text IS NULL OR h.slip_title ILIKE '%' || $6 || '%'
               OR pj.project_no::text = $6
               OR pj.project_name ILIKE '%' || $6 || '%'
               OR bp.partner_name ILIKE '%' || $6 || '%'
               OR EXISTS (
                 SELECT 1 FROM project_cost_lines l
                  WHERE l.cost_header_id = h.id
                    AND l.item_name ILIKE '%' || $6 || '%'
               ))
        ORDER BY h.entry_date DESC, h.created_at DESC
        LIMIT $7 OFFSET $8`,
      [rawProject, costCategory, status, dateFrom, dateTo, kw, pageSize, offset],
    ),
  ]);

  const catMap = new Map(byCatRows.map((c) => [c.cost_category, c]));
  const byCategory: ProjectCostCategorySummaryDto[] = COST_CATEGORY_LIST.map((cat) => {
    const found = catMap.get(cat);
    return {
      category: cat,
      categoryLabel: COST_CATEGORY_LABELS[cat],
      headerCount: found !== undefined ? Number(found.header_count) : 0,
      subtotalAmount: found !== undefined ? Number(found.subtotal_amount) : 0,
      totalAmount: found !== undefined ? Number(found.total_amount) : 0,
    };
  });

  const sum = sumRows[0];
  const items: ProjectCostListItemDto[] = rows.map((r) => ({
    id: r.id,
    projectId: r.project_id,
    projectNo: Number(r.project_no),
    projectName: r.project_name,
    partnerName: r.partner_name,
    costCategory: r.cost_category,
    categoryLabel: COST_CATEGORY_LABELS[r.cost_category],
    slipTitle: r.slip_title,
    entryDate: r.entry_date.slice(0, 10),
    status: r.status,
    roundingMode: r.rounding_mode,
    subtotalAmount: Number(r.subtotal_amount),
    taxTotal: Number(r.tax_total),
    totalAmount: Number(r.total_amount),
    costSubtotal: Number(r.cost_subtotal),
    costTotal: Number(r.cost_total),
    lineCount: Number(r.line_count),
    hasPurchaseLink: r.has_purchase_link,
    updatedAt: r.updated_at,
  }));

  return {
    items,
    summary: {
      totalCount: sum !== undefined ? Number(sum.total_count) : 0,
      subtotalAmount: sum !== undefined ? Number(sum.subtotal_amount) : 0,
      taxTotal: sum !== undefined ? Number(sum.tax_total) : 0,
      totalAmount: sum !== undefined ? Number(sum.total_amount) : 0,
      byCategory,
    },
    costTaxMode,
    page,
    pageSize,
  };
}

export async function getProjectCostDetail(
  tx: DbExecutor,
  tenantId: string,
  costHeaderId: string,
): Promise<ProjectCostDetailDto> {
  validateUuid(costHeaderId, '原価伝票');
  await requireFeature(tx, tenantId, 'cost');

  const tsRows = await tx.query<{ tax_calc_policy: TaxCalcPolicy }>(
    'SELECT tax_calc_policy::text AS tax_calc_policy FROM tenant_settings WHERE tenant_id = $1::uuid LIMIT 1',
    [tenantId],
  );
  const policy: TaxCalcPolicy =
    tsRows[0] !== undefined ? tsRows[0].tax_calc_policy : 'SLIP_BY_RATE';

  const rows = await tx.query<{
    id: string;
    project_id: string;
    project_no: string;
    project_name: string;
    partner_name: string;
    cost_category: CostCategory;
    slip_title: string;
    entry_date: string;
    status: ProjectStatus;
    rounding_mode: RoundingMode;
    subtotal_amount: string;
    tax_total: string;
    total_amount: string;
    cost_subtotal: string;
    cost_tax_total: string;
    cost_total: string;
    created_at: string;
    updated_at: string;
  }>(
    `SELECT h.id, h.project_id, pj.project_no::text AS project_no, pj.project_name,
            bp.partner_name, h.cost_category::text AS cost_category, h.slip_title,
            h.entry_date::text AS entry_date, h.status::text AS status,
            h.rounding_mode::text AS rounding_mode,
            h.subtotal_amount::text AS subtotal_amount,
            h.tax_total::text AS tax_total,
            h.total_amount::text AS total_amount,
            h.cost_subtotal::text AS cost_subtotal,
            h.cost_tax_total::text AS cost_tax_total,
            h.cost_total::text AS cost_total,
            h.created_at::text AS created_at,
            h.updated_at::text AS updated_at
       FROM project_cost_headers h
       JOIN projects pj ON pj.tenant_id = h.tenant_id AND pj.id = h.project_id
       JOIN business_partners bp ON bp.tenant_id = pj.tenant_id AND bp.id = pj.partner_id
      WHERE h.id = $1::uuid
      LIMIT 1`,
    [costHeaderId],
  );
  const row = rows[0];
  if (row === undefined) {
    throw new MasterDataError(404, 'COST_HEADER_NOT_FOUND', '対象の原価伝票が見つかりません。');
  }

  const lineRows = await tx.query<{
    id: string;
    line_no: number;
    product_id: string | null;
    item_code: string | null;
    item_name: string;
    unit_name: string | null;
    quantity: string;
    tax_code: TaxCode;
    master_unit_price: string | null;
    applied_unit_price: string;
    line_amount: string;
    line_tax: string;
    line_total: string;
    applied_cost_price: string;
    cost_amount: string;
    cost_tax: string;
    cost_total: string;
    source_purchase_line_id: string | null;
    remarks: string | null;
  }>(
    `SELECT id, line_no, product_id, item_code, item_name, unit_name,
            quantity::text AS quantity, tax_code,
            master_unit_price::text AS master_unit_price,
            applied_unit_price::text AS applied_unit_price,
            line_amount::text AS line_amount,
            line_tax::text AS line_tax,
            line_total::text AS line_total,
            applied_cost_price::text AS applied_cost_price,
            cost_amount::text AS cost_amount,
            cost_tax::text AS cost_tax,
            cost_total::text AS cost_total,
            source_purchase_line_id,
            remarks
       FROM project_cost_lines
      WHERE cost_header_id = $1::uuid
      ORDER BY line_no ASC`,
    [costHeaderId],
  );

  const lines: ProjectCostLineDto[] = lineRows.map((l) => ({
    id: l.id,
    lineNo: Number(l.line_no),
    productId: l.product_id,
    itemCode: l.item_code,
    itemName: l.item_name,
    unitName: l.unit_name,
    quantity: Number(l.quantity),
    taxCode: l.tax_code,
    masterUnitPrice: l.master_unit_price !== null ? Number(l.master_unit_price) : null,
    appliedUnitPrice: Number(l.applied_unit_price),
    lineAmount: Number(l.line_amount),
    lineTax: Number(l.line_tax),
    lineTotal: Number(l.line_total),
    appliedCostPrice: Number(l.applied_cost_price),
    costAmount: Number(l.cost_amount),
    costTax: Number(l.cost_tax),
    costTotal: Number(l.cost_total),
    sourcePurchaseLineId: l.source_purchase_line_id,
    remarks: l.remarks,
  }));

  return {
    id: row.id,
    projectId: row.project_id,
    projectNo: Number(row.project_no),
    projectName: row.project_name,
    partnerName: row.partner_name,
    costCategory: row.cost_category,
    categoryLabel: COST_CATEGORY_LABELS[row.cost_category],
    slipTitle: row.slip_title,
    entryDate: row.entry_date.slice(0, 10),
    status: row.status,
    roundingMode: row.rounding_mode,
    taxCalcPolicy: policy,
    subtotalAmount: Number(row.subtotal_amount),
    taxTotal: Number(row.tax_total),
    totalAmount: Number(row.total_amount),
    costSubtotal: Number(row.cost_subtotal),
    costTaxTotal: Number(row.cost_tax_total),
    costTotal: Number(row.cost_total),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    lines,
  };
}

async function replaceCostLinesAndCalc(
  tx: DbExecutor,
  params: {
    tenantId: string;
    costHeaderId: string;
    lines: readonly CleanCostLine[];
    roundingMode: RoundingMode;
    policy: TaxCalcPolicy;
  },
) {
  const calc = calculateQuotationSlip(
    params.lines.map((l, idx) => ({
      lineNo: idx + 1,
      isHeading: l.isHeading,
      quantity: l.quantityStr,
      appliedUnitPrice: BigInt(l.appliedUnitPrice),
      appliedCostPrice: BigInt(l.appliedCostPrice),
      taxCode: l.taxCode,
    })),
    params.roundingMode,
    params.policy,
  );

  await tx.query('DELETE FROM project_cost_lines WHERE cost_header_id = $1::uuid', [
    params.costHeaderId,
  ]);

  for (let idx = 0; idx < params.lines.length; idx += 1) {
    const line = params.lines[idx];
    const calcRow = calc.lineResults[idx];
    if (line === undefined || calcRow === undefined) {
      throw new MasterDataError(500, 'CALC_MISMATCH', '原価明細の計算結果が不整合です。');
    }
    await tx.query(
      `INSERT INTO project_cost_lines (
         tenant_id, cost_header_id, line_no, product_id, item_code, item_name, unit_name,
         quantity, tax_code, master_unit_price, applied_unit_price,
         line_amount, line_tax, line_total,
         applied_cost_price, cost_amount, cost_tax, cost_total,
         source_purchase_line_id, remarks
       ) VALUES (
         $1::uuid, $2::uuid, $3::int, $4::uuid, $5, $6, $7,
         $8::numeric, $9, $10::numeric, $11::numeric,
         $12::numeric, $13::numeric, $14::numeric,
         $15::numeric, $16::numeric, $17::numeric, $18::numeric,
         $19::uuid, $20
       )`,
      [
        params.tenantId,
        params.costHeaderId,
        idx + 1,
        line.productId,
        line.itemCode,
        line.itemName,
        line.unitName,
        line.quantityStr,
        line.taxCode,
        line.masterUnitPrice,
        line.isHeading ? 0 : line.appliedUnitPrice,
        calcRow.lineAmount.toString(),
        calcRow.lineTax.toString(),
        calcRow.lineTotal.toString(),
        line.isHeading ? 0 : line.appliedCostPrice,
        calcRow.costAmount.toString(),
        calcRow.costTax.toString(),
        calcRow.costTotal.toString(),
        line.sourcePurchaseLineId,
        line.remarks,
      ],
    );
  }

  return calc;
}

export async function createProjectCost(
  tx: DbExecutor,
  tenantId: string,
  employeeId: string,
  input: ProjectCostInput,
): Promise<ProjectCostDetailDto> {
  await requireFeature(tx, tenantId, 'cost');
  const clean = validateCostInput(input);
  const refs = await validateCostReferences(tx, tenantId, clean);

  if (clean.status === 'C3' && clean.entryDate <= refs.openingBalanceDate) {
    throw new MasterDataError(
      400,
      'COST_DATE_BEFORE_CUTOFF',
      `期首残高基準日(${refs.openingBalanceDate})以前の日付(${clean.entryDate})では完了済(C3)として計上できません。`,
    );
  }

  await tx.query('SELECT id FROM tenant_settings WHERE tenant_id = $1::uuid FOR UPDATE', [tenantId]);

  let headerId: string | undefined;
  try {
    const inserted = await tx.query<{ id: string }>(
      `INSERT INTO project_cost_headers (
         tenant_id, project_id, cost_category, slip_title, entry_date,
         status, rounding_mode,
         subtotal_amount, tax_total, total_amount,
         cost_subtotal, cost_tax_total, cost_total,
         created_by, updated_by
       ) VALUES (
         $1::uuid, $2::uuid, $3::cost_category, $4, $5::date,
         $6::project_status, $7::rounding_mode,
         0, 0, 0,
         0, 0, 0,
         $8::uuid, $8::uuid
       ) RETURNING id`,
      [
        tenantId,
        clean.projectId,
        clean.costCategory,
        clean.slipTitle,
        clean.entryDate,
        clean.status,
        clean.roundingMode,
        employeeId,
      ],
    );
    headerId = inserted[0]?.id;
  } catch (err) {
    throw mapPgConstraintError(err, { entityLabel: '原価伝票' });
  }

  if (headerId === undefined) {
    throw new MasterDataError(500, 'COST_INSERT_FAILED', '原価伝票の登録結果を取得できませんでした。');
  }

  const calc = await replaceCostLinesAndCalc(tx, {
    tenantId,
    costHeaderId: headerId,
    lines: clean.lines,
    roundingMode: clean.roundingMode,
    policy: refs.policy,
  });

  await tx.query(
    `UPDATE project_cost_headers
        SET subtotal_amount = $2::numeric,
            tax_total = $3::numeric,
            total_amount = $4::numeric,
            cost_subtotal = $5::numeric,
            cost_tax_total = $6::numeric,
            cost_total = $7::numeric,
            updated_by = $8::uuid
      WHERE id = $1::uuid`,
    [
      headerId,
      calc.subtotalAmount.toString(),
      calc.taxTotal.toString(),
      calc.totalAmount.toString(),
      calc.costSubtotal.toString(),
      calc.costTaxTotal.toString(),
      calc.costTotal.toString(),
      employeeId,
    ],
  );

  return getProjectCostDetail(tx, tenantId, headerId);
}

export async function updateProjectCost(
  tx: DbExecutor,
  tenantId: string,
  employeeId: string,
  costHeaderId: string,
  input: ProjectCostInput,
): Promise<ProjectCostDetailDto> {
  validateUuid(costHeaderId, '原価伝票');
  await requireFeature(tx, tenantId, 'cost');

  const existingRows = await tx.query<{
    id: string;
    status: ProjectStatus;
    entry_date: string;
  }>(
    `SELECT id, status::text AS status, entry_date::text AS entry_date
       FROM project_cost_headers
      WHERE id = $1::uuid
      FOR UPDATE`,
    [costHeaderId],
  );
  const existing = existingRows[0];
  if (existing === undefined) {
    throw new MasterDataError(404, 'COST_HEADER_NOT_FOUND', '対象の原価伝票が見つかりません。');
  }

  const clean = validateCostInput(input);
  const refs = await validateCostReferences(tx, tenantId, clean);

  if (existing.status === 'C3' && existing.entry_date.slice(0, 10) <= refs.openingBalanceDate) {
    throw new MasterDataError(
      400,
      'COST_DATE_BEFORE_CUTOFF',
      `期首残高基準日(${refs.openingBalanceDate})以前の完了済原価伝票は変更できません。`,
    );
  }
  if (clean.status === 'C3' && clean.entryDate <= refs.openingBalanceDate) {
    throw new MasterDataError(
      400,
      'COST_DATE_BEFORE_CUTOFF',
      `期首残高基準日(${refs.openingBalanceDate})以前の日付(${clean.entryDate})では完了済(C3)へ変更できません。`,
    );
  }

  const calc = await replaceCostLinesAndCalc(tx, {
    tenantId,
    costHeaderId,
    lines: clean.lines,
    roundingMode: clean.roundingMode,
    policy: refs.policy,
  });

  try {
    await tx.query(
      `UPDATE project_cost_headers
          SET project_id = $2::uuid,
              cost_category = $3::cost_category,
              slip_title = $4,
              entry_date = $5::date,
              status = $6::project_status,
              rounding_mode = $7::rounding_mode,
              subtotal_amount = $8::numeric,
              tax_total = $9::numeric,
              total_amount = $10::numeric,
              cost_subtotal = $11::numeric,
              cost_tax_total = $12::numeric,
              cost_total = $13::numeric,
              updated_by = $14::uuid
        WHERE id = $1::uuid`,
      [
        costHeaderId,
        clean.projectId,
        clean.costCategory,
        clean.slipTitle,
        clean.entryDate,
        clean.status,
        clean.roundingMode,
        calc.subtotalAmount.toString(),
        calc.taxTotal.toString(),
        calc.totalAmount.toString(),
        calc.costSubtotal.toString(),
        calc.costTaxTotal.toString(),
        calc.costTotal.toString(),
        employeeId,
      ],
    );
  } catch (err) {
    throw mapPgConstraintError(err, { entityLabel: '原価伝票' });
  }

  return getProjectCostDetail(tx, tenantId, costHeaderId);
}

export async function deleteProjectCost(
  tx: DbExecutor,
  tenantId: string,
  costHeaderId: string,
): Promise<{ id: string }> {
  validateUuid(costHeaderId, '原価伝票');
  await requireFeature(tx, tenantId, 'cost');

  const tsRows = await tx.query<{ opening_balance_date: string }>(
    'SELECT opening_balance_date::text AS opening_balance_date FROM tenant_settings WHERE tenant_id = $1::uuid LIMIT 1',
    [tenantId],
  );
  const openingBalanceDate =
    tsRows[0] !== undefined ? tsRows[0].opening_balance_date.slice(0, 10) : null;

  const existingRows = await tx.query<{
    id: string;
    status: ProjectStatus;
    entry_date: string;
  }>(
    `SELECT id, status::text AS status, entry_date::text AS entry_date
       FROM project_cost_headers
      WHERE id = $1::uuid
      FOR UPDATE`,
    [costHeaderId],
  );
  const existing = existingRows[0];
  if (existing === undefined) {
    throw new MasterDataError(404, 'COST_HEADER_NOT_FOUND', '対象の原価伝票が見つかりません。');
  }
  if (
    existing.status === 'C3' &&
    openingBalanceDate !== null &&
    existing.entry_date.slice(0, 10) <= openingBalanceDate
  ) {
    throw new MasterDataError(
      400,
      'COST_DATE_BEFORE_CUTOFF',
      `期首残高基準日(${openingBalanceDate})以前の完了済原価伝票は削除できません。`,
    );
  }

  await tx.query('DELETE FROM project_cost_headers WHERE id = $1::uuid', [costHeaderId]);
  return { id: costHeaderId };
}

export async function listCandidatePurchasesForProjectCost(
  tx: DbExecutor,
  tenantId: string,
  projectId: string,
): Promise<CandidatePurchaseForCostDto[]> {
  validateUuid(projectId, '案件');
  await requireFeature(tx, tenantId, 'cost');

  const rows = await tx.query<{
    purchase_id: string;
    purchase_no: string;
    purchase_name: string;
    purchase_date: string;
    supplier_name: string;
    status: string;
    total_amount: string;
    matching_line_count: number;
    imported_line_count: number;
    is_project_linked: boolean;
  }>(
    `SELECT p.id AS purchase_id,
            p.purchase_no::text AS purchase_no,
            p.purchase_name,
            p.purchase_date::text AS purchase_date,
            bp.partner_name AS supplier_name,
            p.status::text AS status,
            p.total_amount::text AS total_amount,
            COALESCE((
              SELECT COUNT(*)::int FROM purchase_lines l
               WHERE l.purchase_id = p.id
                 AND (l.project_id = $1::uuid OR NOT EXISTS (
                   SELECT 1 FROM purchase_lines l2 WHERE l2.purchase_id = p.id AND l2.project_id = $1::uuid
                 ))
            ), 0) AS matching_line_count,
            COALESCE((
              SELECT COUNT(*)::int
                FROM purchase_lines l
                JOIN project_cost_lines cl
                  ON cl.tenant_id = l.tenant_id AND cl.source_purchase_line_id = l.id
               WHERE l.purchase_id = p.id
            ), 0) AS imported_line_count,
            EXISTS (
              SELECT 1 FROM purchase_lines l
               WHERE l.purchase_id = p.id AND l.project_id = $1::uuid
            ) AS is_project_linked
       FROM purchases p
       JOIN business_partners bp ON bp.tenant_id = p.tenant_id AND bp.id = p.supplier_id
      ORDER BY is_project_linked DESC, p.purchase_date DESC, p.purchase_no DESC
      LIMIT 100`,
    [projectId],
  );

  return rows.map((r) => {
    const totalLines = Number(r.matching_line_count);
    const importedLines = Number(r.imported_line_count);
    return {
      purchaseId: r.purchase_id,
      purchaseNo: Number(r.purchase_no),
      purchaseName: r.purchase_name,
      purchaseDate: r.purchase_date.slice(0, 10),
      supplierName: r.supplier_name,
      status: r.status,
      totalAmount: Number(r.total_amount),
      matchingLineCount: totalLines,
      alreadyImportedLineCount: importedLines,
      isFullyImported: totalLines > 0 && importedLines >= totalLines,
      isProjectLinked: r.is_project_linked,
    };
  });
}

/**
 * 仕入伝票（purchases）から原価伝票を生成する（同一仕入明細からの重複取込を 409 で防止）
 */
export async function createProjectCostFromPurchase(
  tx: DbExecutor,
  tenantId: string,
  employeeId: string,
  input: ImportCostFromPurchaseInput,
): Promise<ProjectCostDetailDto> {
  validateUuid(input.projectId, '案件');
  validateUuid(input.purchaseId, '仕入');
  await requireFeature(tx, tenantId, 'cost');

  const pRows = await tx.query<{
    id: string;
    purchase_no: string;
    purchase_name: string;
    purchase_date: string;
    rounding_mode: RoundingMode;
    supplier_name: string;
  }>(
    `SELECT p.id, p.purchase_no::text AS purchase_no, p.purchase_name,
            p.purchase_date::text AS purchase_date,
            p.rounding_mode::text AS rounding_mode,
            bp.partner_name AS supplier_name
       FROM purchases p
       JOIN business_partners bp ON bp.tenant_id = p.tenant_id AND bp.id = p.supplier_id
      WHERE p.id = $1::uuid
      FOR UPDATE OF p`,
    [input.purchaseId],
  );
  const purchase = pRows[0];
  if (purchase === undefined) {
    throw new MasterDataError(404, 'PURCHASE_NOT_FOUND', '取込元の仕入伝票が見つかりません。');
  }

  const lineRows = await tx.query<{
    id: string;
    project_id: string | null;
    product_id: string | null;
    item_code: string | null;
    item_name: string;
    unit_name: string | null;
    quantity: string;
    tax_code: TaxCode;
    master_unit_price: string | null;
    applied_unit_price: string;
    remarks: string | null;
  }>(
    `SELECT id, project_id, product_id, item_code, item_name, unit_name,
            quantity::text AS quantity, tax_code,
            master_unit_price::text AS master_unit_price,
            applied_unit_price::text AS applied_unit_price,
            remarks
       FROM purchase_lines
      WHERE purchase_id = $1::uuid
      ORDER BY line_no ASC`,
    [input.purchaseId],
  );

  const projectMatching = lineRows.filter((l) => l.project_id === input.projectId);
  const targetLines = projectMatching.length > 0 ? projectMatching : lineRows;
  if (targetLines.length === 0) {
    throw new MasterDataError(400, 'PURCHASE_HAS_NO_LINES', '取込元の仕入明細が0件です。');
  }

  const targetIds = targetLines.map((l) => l.id);
  const dupRows = await tx.query<{ cnt: number }>(
    `SELECT COUNT(*)::int AS cnt
       FROM project_cost_lines
      WHERE source_purchase_line_id = ANY($1::uuid[])`,
    [targetIds],
  );
  if (dupRows[0] !== undefined && Number(dupRows[0].cnt) > 0) {
    throw new MasterDataError(
      409,
      'PURCHASE_ALREADY_IMPORTED_TO_COST',
      `仕入No.${purchase.purchase_no} の明細は既に原価伝票へ取込済みです（重複取込不可）。`,
    );
  }

  const catLabel = COST_CATEGORY_LABELS[input.costCategory];
  const slipTitle =
    input.slipTitle !== undefined && input.slipTitle !== null && input.slipTitle.trim() !== ''
      ? input.slipTitle.trim()
      : `【${catLabel}】${purchase.purchase_name} (仕入No.${purchase.purchase_no} / ${purchase.supplier_name})`;
  const entryDate =
    input.entryDate !== undefined && input.entryDate !== null && input.entryDate.trim() !== ''
      ? input.entryDate.trim()
      : purchase.purchase_date.slice(0, 10);
  const status: ProjectStatus = input.status !== undefined ? input.status : 'C2';

  return createProjectCost(tx, tenantId, employeeId, {
    projectId: input.projectId,
    costCategory: input.costCategory,
    slipTitle,
    entryDate,
    status,
    roundingMode: purchase.rounding_mode,
    lines: targetLines.map((l) => ({
      productId: l.product_id,
      itemCode: l.item_code,
      itemName: l.item_name,
      unitName: l.unit_name,
      isHeading: false,
      quantity: Number(l.quantity),
      taxCode: l.tax_code,
      masterUnitPrice: l.master_unit_price !== null ? Number(l.master_unit_price) : null,
      appliedUnitPrice: Number(l.applied_unit_price),
      appliedCostPrice: Number(l.applied_unit_price),
      sourcePurchaseLineId: l.id,
      remarks: l.remarks,
    })),
  });
}

export async function exportProjectCostsCsv(
  tx: DbExecutor,
  tenantId: string,
  filter: ProjectCostListFilter,
): Promise<string> {
  const result = await listProjectCosts(tx, tenantId, { ...filter, page: 1, pageSize: 5000 });
  const header = [
    '計上日',
    '案件番号',
    '案件名',
    '発注元取引先',
    '費目区分',
    '原価伝票件名',
    '状態',
    '明細行数',
    '税抜原価',
    '消費税',
    '税込原価',
  ].map(escapeCsvCell);

  const lines = [header.join(',')];
  for (const item of result.items) {
    lines.push(
      [
        item.entryDate,
        String(item.projectNo),
        item.projectName,
        item.partnerName,
        item.categoryLabel,
        item.slipTitle,
        PROJECT_STATUS_LABELS[item.status],
        String(item.lineCount),
        String(item.subtotalAmount),
        String(item.taxTotal),
        String(item.totalAmount),
      ]
        .map(escapeCsvCell)
        .join(','),
    );
  }
  return `\uFEFF${lines.join('\r\n')}`;
}

export async function exportProjectCostsPdf(
  tx: DbExecutor,
  tenantId: string,
  filter: ProjectCostListFilter,
): Promise<Uint8Array> {
  const result = await listProjectCosts(tx, tenantId, { ...filter, page: 1, pageSize: 5000 });
  const settingsRows = await tx.query<{ company_name: string }>(
    'SELECT company_name FROM tenant_settings WHERE tenant_id = $1::uuid LIMIT 1',
    [tenantId],
  );
  const companyName = settingsRows[0] !== undefined ? settingsRows[0].company_name : '自社';
  const catLabel =
    filter.costCategory !== undefined && filter.costCategory !== null
      ? COST_CATEGORY_LABELS[filter.costCategory]
      : '全6費目';

  return renderProjectCostListPdf({
    companyName,
    generatedDate: new Date().toISOString().slice(0, 10),
    filterSummary: `費目:${catLabel}`,
    items: result.items.map((item) => ({
      entryDate: item.entryDate,
      projectNo: item.projectNo,
      projectName: item.projectName,
      categoryLabel: item.categoryLabel,
      slipTitle: item.slipTitle,
      statusLabel: PROJECT_STATUS_LABELS[item.status],
      lineCount: item.lineCount,
      subtotalAmount: item.subtotalAmount,
      taxTotal: item.taxTotal,
      totalAmount: item.totalAmount,
    })),
    totals: {
      count: result.summary.totalCount,
      subtotalAmount: result.summary.subtotalAmount,
      taxTotal: result.summary.taxTotal,
      totalAmount: result.summary.totalAmount,
    },
  });
}
