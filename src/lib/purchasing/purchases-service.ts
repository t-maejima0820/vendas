import Decimal from 'decimal.js';
import { proposePaymentDueDate } from '@/lib/billing/ar-balance-service';
import type { DbExecutor } from '@/lib/db/tenant-client';
import {
  calculateSalesSlip,
  type RoundingMode,
  type TaxCalcPolicy,
  type TaxCode,
} from '@/lib/domain/calculations';
import { renderPurchaseListPdf } from '@/lib/domain/pdf-renderer';
import { requireFeature } from '@/lib/feature-flags/gate';
import { mapPgConstraintError, MasterDataError } from '@/lib/masters/error-mapper';
import {
  PAYABLE_STATUS_LABELS,
  PURCHASE_STATUS_LABELS,
  type PayableStatus,
  type PurchaseDetailDto,
  type PurchaseInput,
  type PurchaseLineDto,
  type PurchaseListItemDto,
  type PurchaseListSummaryDto,
  type PurchasePageDto,
  type PurchaseStatus,
} from '@/lib/purchasing/types';

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DATE_REGEX = /^\d{4}-\d{2}-\d{2}$/;
const VALID_STATUSES = new Set<PurchaseStatus>(['P1', 'P2', 'P3']);
const VALID_ROUNDING_MODES = new Set<RoundingMode>(['FLOOR', 'ROUND', 'CEIL']);
const VALID_TAX_CODES = new Set<TaxCode>(['A', 'B', 'C', 'D', 'E']);

export interface PurchaseListFilter {
  keyword?: string | null;
  supplierId?: string | null;
  status?: PurchaseStatus | null;
  dateFrom?: string | null;
  dateTo?: string | null;
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

interface CleanPurchaseLine {
  projectId: string | null;
  productId: string | null;
  itemCode: string | null;
  itemName: string;
  unitName: string | null;
  isHeading: boolean;
  quantityStr: string;
  taxCode: TaxCode;
  masterUnitPrice: number | null;
  appliedUnitPrice: number;
  remarks: string | null;
}

interface CleanPurchasePayload {
  purchaseName: string;
  purchaseDate: string;
  supplierId: string;
  purchaseOrderId: string | null;
  honorific: string;
  status: PurchaseStatus;
  roundingMode: RoundingMode;
  remarks: string | null;
  lines: CleanPurchaseLine[];
}

function validatePurchaseInput(input: PurchaseInput): CleanPurchasePayload {
  const purchaseName = input.purchaseName.trim();
  if (purchaseName.length === 0 || purchaseName.length > 200) {
    throw new MasterDataError(400, 'INVALID_PURCHASE_NAME', '仕入件名は1〜200文字で入力してください。');
  }
  const purchaseDate = validateDateOnly(input.purchaseDate, '仕入日');
  validateUuid(input.supplierId, '仕入先');

  let purchaseOrderId: string | null = null;
  if (input.purchaseOrderId !== null && input.purchaseOrderId.trim() !== '') {
    validateUuid(input.purchaseOrderId.trim(), '発注');
    purchaseOrderId = input.purchaseOrderId.trim();
  }

  const honorific = input.honorific.trim();
  if (honorific.length === 0 || honorific.length > 20) {
    throw new MasterDataError(400, 'INVALID_HONORIFIC', '敬称は1〜20文字で入力してください。');
  }
  if (!VALID_STATUSES.has(input.status)) {
    throw new MasterDataError(400, 'INVALID_STATUS', '仕入ステータスは P1〜P3 を指定してください。');
  }
  if (!VALID_ROUNDING_MODES.has(input.roundingMode)) {
    throw new MasterDataError(400, 'INVALID_ROUNDING_MODE', '端数処理は FLOOR / ROUND / CEIL を指定してください。');
  }
  if (!Array.isArray(input.lines) || input.lines.length === 0) {
    throw new MasterDataError(400, 'LINES_REQUIRED', '仕入明細は最低1行以上入力してください。');
  }

  const lines: CleanPurchaseLine[] = input.lines.map((line, idx) => {
    const lineNo = idx + 1;
    const isHeading = Boolean(line.isHeading);
    const itemName = line.itemName.trim();
    if (itemName.length === 0 || itemName.length > 300) {
      throw new MasterDataError(400, 'INVALID_ITEM_NAME', `${lineNo}行目の品名は1〜300文字で入力してください。`);
    }
    let projectId: string | null = null;
    if (line.projectId !== null && line.projectId.trim() !== '') {
      validateUuid(line.projectId.trim(), `${lineNo}行目の案件`);
      projectId = line.projectId.trim();
    }
    let productId: string | null = null;
    if (line.productId !== null && line.productId.trim() !== '') {
      validateUuid(line.productId.trim(), `${lineNo}行目の商品`);
      productId = line.productId.trim();
    }
    const taxCode: TaxCode = isHeading ? 'C' : line.taxCode;
    if (!VALID_TAX_CODES.has(taxCode)) {
      throw new MasterDataError(400, 'INVALID_TAX_CODE', `${lineNo}行目の税区分が不正です。`);
    }
    const quantityStr = isHeading ? '0' : validateQuantity(line.quantity, lineNo);
    const masterUnitPrice = validateOptionalIntegerYen(line.masterUnitPrice, `${lineNo}行目の基準単価`);
    const appliedUnitPrice = isHeading
      ? 0
      : validateIntegerYen(line.appliedUnitPrice, `${lineNo}行目の仕入単価`);

    return {
      projectId,
      productId,
      itemCode: optTrimmed(line.itemCode),
      itemName,
      unitName: isHeading ? null : optTrimmed(line.unitName),
      isHeading,
      quantityStr,
      taxCode,
      masterUnitPrice,
      appliedUnitPrice,
      remarks: optTrimmed(line.remarks),
    };
  });

  return {
    purchaseName,
    purchaseDate,
    supplierId: input.supplierId.trim(),
    purchaseOrderId,
    honorific,
    status: input.status,
    roundingMode: input.roundingMode,
    remarks: optTrimmed(input.remarks),
    lines,
  };
}

interface PurchaseRefMeta {
  openingBalanceDate: string;
  policy: TaxCalcPolicy;
  closingDayCode: string | null;
  collectionDayCode: string | null;
  orderedAt: string | null;
}

async function validatePurchaseReferences(
  tx: DbExecutor,
  tenantId: string,
  payload: CleanPurchasePayload,
): Promise<PurchaseRefMeta> {
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

  const bpRows = await tx.query<{
    id: string;
    closing_day_code: string | null;
    collection_day_code: string | null;
  }>(
    `SELECT id, closing_day_code, collection_day_code
       FROM business_partners
      WHERE id = $1::uuid AND is_deleted = false
      LIMIT 1`,
    [payload.supplierId],
  );
  const supplier = bpRows[0];
  if (supplier === undefined) {
    throw new MasterDataError(400, 'SUPPLIER_NOT_FOUND', '指定された仕入先が見つかりません。');
  }

  let orderedAt: string | null = null;
  if (payload.purchaseOrderId !== null) {
    const poRows = await tx.query<{ order_date: string }>(
      'SELECT order_date::text AS order_date FROM purchase_orders WHERE id = $1::uuid LIMIT 1',
      [payload.purchaseOrderId],
    );
    if (poRows[0] === undefined) {
      throw new MasterDataError(400, 'PURCHASE_ORDER_NOT_FOUND', '紐付け指定された発注データが見つかりません。');
    }
    orderedAt = poRows[0].order_date.slice(0, 10);
  }

  const projIds = Array.from(
    new Set(payload.lines.map((l) => l.projectId).filter((id): id is string => id !== null)),
  );
  if (projIds.length > 0) {
    const pjRows = await tx.query<{ id: string }>(
      'SELECT id FROM projects WHERE id = ANY($1::uuid[])',
      [projIds],
    );
    const pjSet = new Set(pjRows.map((r) => r.id));
    for (const id of projIds) {
      if (!pjSet.has(id)) {
        throw new MasterDataError(400, 'PROJECT_NOT_FOUND', '明細で指定された案件が見つかりません。');
      }
    }
  }

  const prodIds = payload.lines
    .map((l) => l.productId)
    .filter((id): id is string => id !== null);
  if (prodIds.length > 0) {
    const prodRows = await tx.query<{ id: string; is_heading: boolean }>(
      'SELECT id, is_heading FROM products WHERE id = ANY($1::uuid[]) AND is_deleted = false',
      [prodIds],
    );
    const prodMap = new Map(prodRows.map((r) => [r.id, r.is_heading]));
    for (const ln of payload.lines) {
      if (ln.productId !== null && !prodMap.has(ln.productId)) {
        throw new MasterDataError(400, 'PRODUCT_NOT_FOUND', '明細で指定された商品が見つかりません。');
      }
      if (ln.productId !== null && prodMap.get(ln.productId) === true) {
        ln.isHeading = true;
        ln.quantityStr = '0';
        ln.appliedUnitPrice = 0;
        ln.unitName = null;
        ln.taxCode = 'C';
      }
    }
  }

  return {
    openingBalanceDate: ts.opening_balance_date.slice(0, 10),
    policy: ts.tax_calc_policy,
    closingDayCode: supplier.closing_day_code,
    collectionDayCode: supplier.collection_day_code,
    orderedAt,
  };
}

export async function listPurchases(
  tx: DbExecutor,
  tenantId: string,
  filter: PurchaseListFilter = {},
): Promise<PurchasePageDto> {
  await requireFeature(tx, tenantId, 'purchase');

  const kw = optTrimmed(filter.keyword);
  const rawSupplier = optTrimmed(filter.supplierId);
  if (rawSupplier !== null) {
    validateUuid(rawSupplier, '仕入先');
  }
  const status =
    filter.status !== undefined && filter.status !== null && VALID_STATUSES.has(filter.status)
      ? filter.status
      : null;
  const rawFrom = optTrimmed(filter.dateFrom);
  const dateFrom = rawFrom !== null && DATE_REGEX.test(rawFrom) ? rawFrom : null;
  const rawTo = optTrimmed(filter.dateTo);
  const dateTo = rawTo !== null && DATE_REGEX.test(rawTo) ? rawTo : null;

  const rawPage = filter.page === undefined ? 1 : filter.page;
  const rawSize = filter.pageSize === undefined ? 25 : filter.pageSize;
  const page = Number.isInteger(rawPage) && rawPage >= 1 ? rawPage : 1;
  const pageSize = Number.isInteger(rawSize) && rawSize >= 1 && rawSize <= 5000 ? rawSize : 25;
  const offset = (page - 1) * pageSize;

  const sumRows = await tx.query<{
    total_count: number;
    subtotal_amount: string;
    tax_total: string;
    total_amount: string;
  }>(
    `SELECT COUNT(*)::int AS total_count,
            COALESCE(SUM(p.subtotal_amount), 0)::text AS subtotal_amount,
            COALESCE(SUM(p.tax_total), 0)::text AS tax_total,
            COALESCE(SUM(p.total_amount), 0)::text AS total_amount
       FROM purchases p
       JOIN business_partners bp ON bp.tenant_id = p.tenant_id AND bp.id = p.supplier_id
      WHERE ($1::text IS NULL OR p.purchase_no::text = $1
             OR p.purchase_name ILIKE '%' || $1 || '%'
             OR bp.partner_name ILIKE '%' || $1 || '%'
             OR bp.partner_code ILIKE '%' || $1 || '%')
        AND ($2::uuid IS NULL OR p.supplier_id = $2::uuid)
        AND ($3::text IS NULL OR p.status::text = $3)
        AND ($4::date IS NULL OR p.purchase_date >= $4::date)
        AND ($5::date IS NULL OR p.purchase_date <= $5::date)`,
    [kw, rawSupplier, status, dateFrom, dateTo],
  );
  const sum = sumRows[0];
  const summary: PurchaseListSummaryDto = {
    totalCount: sum !== undefined ? Number(sum.total_count) : 0,
    subtotalAmount: sum !== undefined ? Number(sum.subtotal_amount) : 0,
    taxTotal: sum !== undefined ? Number(sum.tax_total) : 0,
    totalAmount: sum !== undefined ? Number(sum.total_amount) : 0,
  };

  const rows = await tx.query<{
    id: string;
    purchase_no: string;
    purchase_name: string;
    purchase_date: string;
    supplier_id: string;
    supplier_code: string;
    supplier_name: string;
    purchase_order_id: string | null;
    order_no: string | null;
    honorific: string;
    status: PurchaseStatus;
    rounding_mode: RoundingMode;
    subtotal_amount: string;
    tax_total: string;
    total_amount: string;
    payable_ledger_id: string | null;
    payable_status: PayableStatus | null;
    scheduled_pay_at: string | null;
    line_count: number;
    updated_at: string;
  }>(
    `SELECT p.id, p.purchase_no::text AS purchase_no, p.purchase_name,
            p.purchase_date::text AS purchase_date,
            p.supplier_id, bp.partner_code AS supplier_code, bp.partner_name AS supplier_name,
            p.purchase_order_id, po.order_no::text AS order_no,
            p.honorific, p.status::text AS status,
            p.rounding_mode::text AS rounding_mode,
            p.subtotal_amount::text AS subtotal_amount,
            p.tax_total::text AS tax_total,
            p.total_amount::text AS total_amount,
            pl.id AS payable_ledger_id,
            pl.status::text AS payable_status,
            pl.scheduled_pay_at::text AS scheduled_pay_at,
            (SELECT COUNT(*)::int FROM purchase_lines l WHERE l.purchase_id = p.id) AS line_count,
            p.updated_at::text AS updated_at
       FROM purchases p
       JOIN business_partners bp ON bp.tenant_id = p.tenant_id AND bp.id = p.supplier_id
       LEFT JOIN purchase_orders po ON po.tenant_id = p.tenant_id AND po.id = p.purchase_order_id
       LEFT JOIN payable_ledgers pl ON pl.tenant_id = p.tenant_id AND pl.purchase_id = p.id
      WHERE ($1::text IS NULL OR p.purchase_no::text = $1
             OR p.purchase_name ILIKE '%' || $1 || '%'
             OR bp.partner_name ILIKE '%' || $1 || '%'
             OR bp.partner_code ILIKE '%' || $1 || '%')
        AND ($2::uuid IS NULL OR p.supplier_id = $2::uuid)
        AND ($3::text IS NULL OR p.status::text = $3)
        AND ($4::date IS NULL OR p.purchase_date >= $4::date)
        AND ($5::date IS NULL OR p.purchase_date <= $5::date)
      ORDER BY p.purchase_date DESC, p.purchase_no DESC
      LIMIT $6 OFFSET $7`,
    [kw, rawSupplier, status, dateFrom, dateTo, pageSize, offset],
  );

  const items: PurchaseListItemDto[] = rows.map((r) => ({
    id: r.id,
    purchaseNo: Number(r.purchase_no),
    purchaseName: r.purchase_name,
    purchaseDate: r.purchase_date.slice(0, 10),
    supplierId: r.supplier_id,
    supplierCode: r.supplier_code,
    supplierName: r.supplier_name,
    purchaseOrderId: r.purchase_order_id,
    orderNo: r.order_no !== null ? Number(r.order_no) : null,
    honorific: r.honorific,
    status: r.status,
    roundingMode: r.rounding_mode,
    subtotalAmount: Number(r.subtotal_amount),
    taxTotal: Number(r.tax_total),
    totalAmount: Number(r.total_amount),
    payableLedgerId: r.payable_ledger_id,
    payableStatus: r.payable_status,
    scheduledPayAt: r.scheduled_pay_at !== null ? r.scheduled_pay_at.slice(0, 10) : null,
    lineCount: Number(r.line_count),
    updatedAt: r.updated_at,
  }));

  return { items, summary, page, pageSize };
}

export async function getPurchaseDetail(
  tx: DbExecutor,
  tenantId: string,
  purchaseId: string,
): Promise<PurchaseDetailDto> {
  validateUuid(purchaseId, '仕入');
  await requireFeature(tx, tenantId, 'purchase');

  const tsRows = await tx.query<{ tax_calc_policy: TaxCalcPolicy }>(
    'SELECT tax_calc_policy::text AS tax_calc_policy FROM tenant_settings WHERE tenant_id = $1::uuid LIMIT 1',
    [tenantId],
  );
  const policy: TaxCalcPolicy =
    tsRows[0] !== undefined ? tsRows[0].tax_calc_policy : 'SLIP_BY_RATE';

  const rows = await tx.query<{
    id: string;
    purchase_no: string;
    purchase_name: string;
    purchase_date: string;
    supplier_id: string;
    supplier_code: string;
    supplier_name: string;
    purchase_order_id: string | null;
    order_no: string | null;
    honorific: string;
    status: PurchaseStatus;
    rounding_mode: RoundingMode;
    subtotal_amount: string;
    tax_total: string;
    total_amount: string;
    remarks: string | null;
    payable_ledger_id: string | null;
    payable_status: PayableStatus | null;
    scheduled_pay_at: string | null;
    created_at: string;
    updated_at: string;
  }>(
    `SELECT p.id, p.purchase_no::text AS purchase_no, p.purchase_name,
            p.purchase_date::text AS purchase_date,
            p.supplier_id, bp.partner_code AS supplier_code, bp.partner_name AS supplier_name,
            p.purchase_order_id, po.order_no::text AS order_no,
            p.honorific, p.status::text AS status,
            p.rounding_mode::text AS rounding_mode,
            p.subtotal_amount::text AS subtotal_amount,
            p.tax_total::text AS tax_total,
            p.total_amount::text AS total_amount,
            p.remarks,
            pl.id AS payable_ledger_id,
            pl.status::text AS payable_status,
            pl.scheduled_pay_at::text AS scheduled_pay_at,
            p.created_at::text AS created_at,
            p.updated_at::text AS updated_at
       FROM purchases p
       JOIN business_partners bp ON bp.tenant_id = p.tenant_id AND bp.id = p.supplier_id
       LEFT JOIN purchase_orders po ON po.tenant_id = p.tenant_id AND po.id = p.purchase_order_id
       LEFT JOIN payable_ledgers pl ON pl.tenant_id = p.tenant_id AND pl.purchase_id = p.id
      WHERE p.id = $1::uuid
      LIMIT 1`,
    [purchaseId],
  );
  const row = rows[0];
  if (row === undefined) {
    throw new MasterDataError(404, 'PURCHASE_NOT_FOUND', '対象の仕入データが見つかりません。');
  }

  const lineRows = await tx.query<{
    id: string;
    line_no: number;
    project_id: string | null;
    project_no: string | null;
    project_name: string | null;
    product_id: string | null;
    prod_is_heading: boolean | null;
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
    remarks: string | null;
  }>(
    `SELECT pl.id, pl.line_no, pl.project_id,
            pj.project_no::text AS project_no, pj.project_name,
            pl.product_id, pr.is_heading AS prod_is_heading,
            pl.item_code, pl.item_name, pl.unit_name,
            pl.quantity::text AS quantity, pl.tax_code,
            pl.master_unit_price::text AS master_unit_price,
            pl.applied_unit_price::text AS applied_unit_price,
            pl.line_amount::text AS line_amount,
            pl.line_tax::text AS line_tax,
            pl.line_total::text AS line_total,
            pl.remarks
       FROM purchase_lines pl
       LEFT JOIN projects pj ON pj.tenant_id = pl.tenant_id AND pj.id = pl.project_id
       LEFT JOIN products pr ON pr.tenant_id = pl.tenant_id AND pr.id = pl.product_id
      WHERE pl.purchase_id = $1::uuid
      ORDER BY pl.line_no ASC`,
    [purchaseId],
  );

  const lines: PurchaseLineDto[] = lineRows.map((l) => {
    const qtyNum = Number(l.quantity);
    const priceNum = Number(l.applied_unit_price);
    const isHeading =
      l.prod_is_heading === true ||
      (qtyNum === 0 && priceNum === 0 && l.unit_name === null && l.tax_code === 'C');
    return {
      id: l.id,
      lineNo: Number(l.line_no),
      projectId: l.project_id,
      projectNo: l.project_no !== null ? Number(l.project_no) : null,
      projectName: l.project_name,
      productId: l.product_id,
      itemCode: l.item_code,
      itemName: l.item_name,
      unitName: l.unit_name,
      isHeading,
      quantity: qtyNum,
      taxCode: l.tax_code,
      masterUnitPrice: l.master_unit_price !== null ? Number(l.master_unit_price) : null,
      appliedUnitPrice: priceNum,
      lineAmount: Number(l.line_amount),
      lineTax: Number(l.line_tax),
      lineTotal: Number(l.line_total),
      remarks: l.remarks,
    };
  });

  return {
    id: row.id,
    purchaseNo: Number(row.purchase_no),
    purchaseName: row.purchase_name,
    purchaseDate: row.purchase_date.slice(0, 10),
    supplierId: row.supplier_id,
    supplierCode: row.supplier_code,
    supplierName: row.supplier_name,
    purchaseOrderId: row.purchase_order_id,
    orderNo: row.order_no !== null ? Number(row.order_no) : null,
    honorific: row.honorific,
    status: row.status,
    roundingMode: row.rounding_mode,
    taxCalcPolicy: policy,
    subtotalAmount: Number(row.subtotal_amount),
    taxTotal: Number(row.tax_total),
    totalAmount: Number(row.total_amount),
    remarks: row.remarks,
    payableLedgerId: row.payable_ledger_id,
    payableStatus: row.payable_status,
    scheduledPayAt: row.scheduled_pay_at !== null ? row.scheduled_pay_at.slice(0, 10) : null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    lines,
  };
}

async function replacePurchaseLinesAndCalc(
  tx: DbExecutor,
  params: {
    tenantId: string;
    purchaseId: string;
    lines: readonly CleanPurchaseLine[];
    roundingMode: RoundingMode;
    policy: TaxCalcPolicy;
  },
) {
  const calc = calculateSalesSlip(
    params.lines.map((l, idx) => ({
      lineNo: idx + 1,
      isHeading: l.isHeading,
      quantity: l.quantityStr,
      appliedUnitPrice: BigInt(l.appliedUnitPrice),
      taxCode: l.taxCode,
    })),
    params.roundingMode,
    params.policy,
  );

  await tx.query('DELETE FROM purchase_lines WHERE purchase_id = $1::uuid', [params.purchaseId]);

  for (let idx = 0; idx < params.lines.length; idx += 1) {
    const line = params.lines[idx];
    const calcRow = calc.lineResults[idx];
    if (line === undefined || calcRow === undefined) {
      throw new MasterDataError(500, 'CALC_MISMATCH', '仕入明細の計算結果が不整合です。');
    }
    await tx.query(
      `INSERT INTO purchase_lines (
         tenant_id, purchase_id, line_no, project_id, product_id, item_code, item_name, unit_name,
         quantity, tax_code, master_unit_price, applied_unit_price,
         line_amount, line_tax, line_total, remarks
       ) VALUES (
         $1::uuid, $2::uuid, $3::int, $4::uuid, $5::uuid, $6, $7, $8,
         $9::numeric, $10, $11::numeric, $12::numeric,
         $13::numeric, $14::numeric, $15::numeric, $16
       )`,
      [
        params.tenantId,
        params.purchaseId,
        idx + 1,
        line.projectId,
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
        calcRow.rowTotal.toString(),
        line.remarks,
      ],
    );
  }

  return calc;
}

/**
 * P3（仕入確定）時の買掛台帳（payable_ledgers）自動同期生成（旧 Access D3 欠陥の根絶）
 */
async function syncPayableLedgerForConfirmedPurchase(
  tx: DbExecutor,
  params: {
    tenantId: string;
    employeeId: string;
    supplierId: string;
    purchaseId: string;
    purchaseDate: string;
    totalAmount: bigint;
    rate10Excl: bigint;
    rate8Excl: bigint;
    nonTax0: bigint;
    taxTotal: bigint;
    scheduledPayAt: string | null;
    orderedAt: string | null;
  },
): Promise<void> {
  await tx.query(
    `INSERT INTO payable_ledgers (
       tenant_id, supplier_id, purchase_id, purchase_date,
       payable_amount, amount_10_excl, amount_8_excl, amount_0_non_tax, tax_total,
       status, scheduled_pay_at, ordered_at, created_by, updated_by
     ) VALUES (
       $1::uuid, $2::uuid, $3::uuid, $4::date,
       $5::numeric, $6::numeric, $7::numeric, $8::numeric, $9::numeric,
       'A1'::payable_status, $10::date, $11::date, $12::uuid, $12::uuid
     )
     ON CONFLICT (tenant_id, purchase_id) DO UPDATE SET
       supplier_id = EXCLUDED.supplier_id,
       purchase_date = EXCLUDED.purchase_date,
       payable_amount = EXCLUDED.payable_amount,
       amount_10_excl = EXCLUDED.amount_10_excl,
       amount_8_excl = EXCLUDED.amount_8_excl,
       amount_0_non_tax = EXCLUDED.amount_0_non_tax,
       tax_total = EXCLUDED.tax_total,
       scheduled_pay_at = EXCLUDED.scheduled_pay_at,
       ordered_at = EXCLUDED.ordered_at,
       updated_by = EXCLUDED.updated_by`,
    [
      params.tenantId,
      params.supplierId,
      params.purchaseId,
      params.purchaseDate,
      params.totalAmount.toString(),
      params.rate10Excl.toString(),
      params.rate8Excl.toString(),
      params.nonTax0.toString(),
      params.taxTotal.toString(),
      params.scheduledPayAt,
      params.orderedAt,
      params.employeeId,
    ],
  );
}

export async function createPurchase(
  tx: DbExecutor,
  tenantId: string,
  employeeId: string,
  input: PurchaseInput,
): Promise<PurchaseDetailDto> {
  await requireFeature(tx, tenantId, 'purchase');
  const clean = validatePurchaseInput(input);
  const refs = await validatePurchaseReferences(tx, tenantId, clean);

  if (clean.status === 'P3' && clean.purchaseDate <= refs.openingBalanceDate) {
    throw new MasterDataError(
      400,
      'PURCHASE_DATE_BEFORE_CUTOFF',
      `期首残高基準日(${refs.openingBalanceDate})以前の日付(${clean.purchaseDate})では仕入確定（P3）できません。基準日より後の日付を指定してください。`,
    );
  }

  // 仕入番号採番のため tenant_settings を排他ロック
  await tx.query('SELECT id FROM tenant_settings WHERE tenant_id = $1::uuid FOR UPDATE', [tenantId]);
  const maxRows = await tx.query<{ max_no: string }>(
    'SELECT COALESCE(MAX(purchase_no), 0)::text AS max_no FROM purchases',
    [],
  );
  const nextNo = BigInt(maxRows[0] !== undefined ? maxRows[0].max_no : '0') + 1n;

  let purchaseId: string | undefined;
  try {
    const inserted = await tx.query<{ id: string }>(
      `INSERT INTO purchases (
         tenant_id, purchase_no, purchase_name, purchase_date, supplier_id,
         purchase_order_id, honorific, status, rounding_mode,
         subtotal_amount, tax_total, total_amount, remarks,
         created_by, updated_by
       ) VALUES (
         $1::uuid, $2::bigint, $3, $4::date, $5::uuid,
         $6::uuid, $7, $8::purchase_status, $9::rounding_mode,
         0, 0, 0, $10,
         $11::uuid, $11::uuid
       ) RETURNING id`,
      [
        tenantId,
        nextNo.toString(),
        clean.purchaseName,
        clean.purchaseDate,
        clean.supplierId,
        clean.purchaseOrderId,
        clean.honorific,
        clean.status,
        clean.roundingMode,
        clean.remarks,
        employeeId,
      ],
    );
    purchaseId = inserted[0]?.id;
  } catch (err) {
    throw mapPgConstraintError(err, { entityLabel: '仕入データ' });
  }

  if (purchaseId === undefined) {
    throw new MasterDataError(500, 'PURCHASE_INSERT_FAILED', '仕入データの登録結果を取得できませんでした。');
  }

  const calc = await replacePurchaseLinesAndCalc(tx, {
    tenantId,
    purchaseId,
    lines: clean.lines,
    roundingMode: clean.roundingMode,
    policy: refs.policy,
  });

  await tx.query(
    `UPDATE purchases
        SET subtotal_amount = $2::numeric,
            tax_total = $3::numeric,
            total_amount = $4::numeric,
            updated_by = $5::uuid
      WHERE id = $1::uuid`,
    [
      purchaseId,
      calc.subtotalAmount.toString(),
      calc.taxTotal.toString(),
      calc.totalAmount.toString(),
      employeeId,
    ],
  );

  if (clean.status === 'P3') {
    const scheduledPayAt = proposePaymentDueDate(
      clean.purchaseDate,
      refs.closingDayCode,
      refs.collectionDayCode,
    );
    await syncPayableLedgerForConfirmedPurchase(tx, {
      tenantId,
      employeeId,
      supplierId: clean.supplierId,
      purchaseId,
      purchaseDate: clean.purchaseDate,
      totalAmount: calc.totalAmount,
      rate10Excl: calc.rate10Excl,
      rate8Excl: calc.rate8Excl,
      nonTax0: calc.nonTax0,
      taxTotal: calc.taxTotal,
      scheduledPayAt,
      orderedAt: refs.orderedAt,
    });
  }

  return getPurchaseDetail(tx, tenantId, purchaseId);
}

export async function updatePurchase(
  tx: DbExecutor,
  tenantId: string,
  employeeId: string,
  purchaseId: string,
  input: PurchaseInput,
): Promise<PurchaseDetailDto> {
  validateUuid(purchaseId, '仕入');
  await requireFeature(tx, tenantId, 'purchase');

  const existingRows = await tx.query<{ id: string; status: PurchaseStatus }>(
    'SELECT id, status::text AS status FROM purchases WHERE id = $1::uuid FOR UPDATE',
    [purchaseId],
  );
  const existing = existingRows[0];
  if (existing === undefined) {
    throw new MasterDataError(404, 'PURCHASE_NOT_FOUND', '対象の仕入データが見つかりません。');
  }
  if (existing.status === 'P3') {
    throw new MasterDataError(
      409,
      'PURCHASE_ALREADY_CONFIRMED',
      '仕入確定済（P3）のデータは直接編集できません。未払の場合は先に確定取消を行ってください。',
    );
  }

  const clean = validatePurchaseInput(input);
  const refs = await validatePurchaseReferences(tx, tenantId, clean);

  if (clean.status === 'P3' && clean.purchaseDate <= refs.openingBalanceDate) {
    throw new MasterDataError(
      400,
      'PURCHASE_DATE_BEFORE_CUTOFF',
      `期首残高基準日(${refs.openingBalanceDate})以前の日付(${clean.purchaseDate})では仕入確定（P3）できません。基準日より後の日付を指定してください。`,
    );
  }

  const calc = await replacePurchaseLinesAndCalc(tx, {
    tenantId,
    purchaseId,
    lines: clean.lines,
    roundingMode: clean.roundingMode,
    policy: refs.policy,
  });

  try {
    await tx.query(
      `UPDATE purchases
          SET purchase_name = $2,
              purchase_date = $3::date,
              supplier_id = $4::uuid,
              purchase_order_id = $5::uuid,
              honorific = $6,
              status = $7::purchase_status,
              rounding_mode = $8::rounding_mode,
              subtotal_amount = $9::numeric,
              tax_total = $10::numeric,
              total_amount = $11::numeric,
              remarks = $12,
              updated_by = $13::uuid
        WHERE id = $1::uuid`,
      [
        purchaseId,
        clean.purchaseName,
        clean.purchaseDate,
        clean.supplierId,
        clean.purchaseOrderId,
        clean.honorific,
        clean.status,
        clean.roundingMode,
        calc.subtotalAmount.toString(),
        calc.taxTotal.toString(),
        calc.totalAmount.toString(),
        clean.remarks,
        employeeId,
      ],
    );
  } catch (err) {
    throw mapPgConstraintError(err, { entityLabel: '仕入データ' });
  }

  if (clean.status === 'P3') {
    const scheduledPayAt = proposePaymentDueDate(
      clean.purchaseDate,
      refs.closingDayCode,
      refs.collectionDayCode,
    );
    await syncPayableLedgerForConfirmedPurchase(tx, {
      tenantId,
      employeeId,
      supplierId: clean.supplierId,
      purchaseId,
      purchaseDate: clean.purchaseDate,
      totalAmount: calc.totalAmount,
      rate10Excl: calc.rate10Excl,
      rate8Excl: calc.rate8Excl,
      nonTax0: calc.nonTax0,
      taxTotal: calc.taxTotal,
      scheduledPayAt,
      orderedAt: refs.orderedAt,
    });
  }

  return getPurchaseDetail(tx, tenantId, purchaseId);
}

/**
 * 発注伝票から仕入伝票（初期ステータス P1 / P2）を転記作成する
 */
export async function createPurchaseFromOrder(
  tx: DbExecutor,
  tenantId: string,
  employeeId: string,
  params: {
    orderId: string;
    purchaseDate?: string;
    initialStatus?: 'P1' | 'P2';
  },
): Promise<PurchaseDetailDto> {
  validateUuid(params.orderId, '発注');
  await requireFeature(tx, tenantId, 'purchase');

  const poRows = await tx.query<{
    id: string;
    order_name: string;
    order_date: string;
    supplier_id: string;
    project_id: string | null;
    honorific: string;
    status: string;
    rounding_mode: RoundingMode;
    remarks: string | null;
  }>(
    `SELECT id, order_name, order_date::text AS order_date,
            supplier_id, project_id, honorific, status::text AS status,
            rounding_mode::text AS rounding_mode, remarks
       FROM purchase_orders
      WHERE id = $1::uuid
      FOR UPDATE`,
    [params.orderId],
  );
  const order = poRows[0];
  if (order === undefined) {
    throw new MasterDataError(404, 'PURCHASE_ORDER_NOT_FOUND', '転記元の発注データが見つかりません。');
  }

  const lineRows = await tx.query<{
    product_id: string | null;
    prod_is_heading: boolean | null;
    item_code: string | null;
    item_name: string;
    unit_name: string | null;
    quantity: string;
    tax_code: TaxCode;
    master_unit_price: string | null;
    applied_unit_price: string;
    remarks: string | null;
  }>(
    `SELECT pol.product_id, p.is_heading AS prod_is_heading,
            pol.item_code, pol.item_name, pol.unit_name,
            pol.quantity::text AS quantity, pol.tax_code,
            pol.master_unit_price::text AS master_unit_price,
            pol.applied_unit_price::text AS applied_unit_price,
            pol.remarks
       FROM purchase_order_lines pol
       LEFT JOIN products p ON p.tenant_id = pol.tenant_id AND p.id = pol.product_id
      WHERE pol.order_id = $1::uuid
      ORDER BY pol.line_no ASC`,
    [params.orderId],
  );
  if (lineRows.length === 0) {
    throw new MasterDataError(400, 'ORDER_HAS_NO_LINES', '転記元の発注明細が0件です。');
  }

  const purchaseDate =
    params.purchaseDate !== undefined && params.purchaseDate.trim() !== ''
      ? validateDateOnly(params.purchaseDate, '仕入日')
      : new Date().toISOString().slice(0, 10);
  const initialStatus: 'P1' | 'P2' = params.initialStatus === 'P1' ? 'P1' : 'P2';

  const created = await createPurchase(tx, tenantId, employeeId, {
    purchaseName: order.order_name,
    purchaseDate,
    supplierId: order.supplier_id,
    purchaseOrderId: order.id,
    honorific: order.honorific,
    status: initialStatus,
    roundingMode: order.rounding_mode,
    remarks: order.remarks,
    lines: lineRows.map((l) => {
      const qtyNum = Number(l.quantity);
      const priceNum = Number(l.applied_unit_price);
      const isHeading =
        l.prod_is_heading === true ||
        (qtyNum === 0 && priceNum === 0 && l.unit_name === null && l.tax_code === 'C');
      return {
        projectId: order.project_id,
        productId: l.product_id,
        itemCode: l.item_code,
        itemName: l.item_name,
        unitName: l.unit_name,
        isHeading,
        quantity: qtyNum,
        taxCode: l.tax_code,
        masterUnitPrice: l.master_unit_price !== null ? Number(l.master_unit_price) : null,
        appliedUnitPrice: priceNum,
        remarks: l.remarks,
      };
    }),
  });

  if (order.status === 'O1' || order.status === 'O2') {
    await tx.query(
      `UPDATE purchase_orders
          SET status = 'O3'::order_status,
              updated_by = $2::uuid
        WHERE id = $1::uuid`,
      [order.id, employeeId],
    );
  }

  return created;
}

/**
 * 仕入確定取消（P3 -> P2 ロールバック & 対応 payable_ledgers 削除）
 */
export async function cancelPurchaseConfirmation(
  tx: DbExecutor,
  tenantId: string,
  employeeId: string,
  purchaseId: string,
): Promise<PurchaseDetailDto> {
  validateUuid(purchaseId, '仕入');
  await requireFeature(tx, tenantId, 'purchase');

  const tsRows = await tx.query<{ opening_balance_date: string }>(
    'SELECT opening_balance_date::text AS opening_balance_date FROM tenant_settings WHERE tenant_id = $1::uuid LIMIT 1',
    [tenantId],
  );
  const ts = tsRows[0];
  if (ts === undefined) {
    throw new MasterDataError(404, 'TENANT_SETTINGS_NOT_FOUND', '自社設定が見つかりません。');
  }
  const openingBalanceDate = ts.opening_balance_date.slice(0, 10);

  const pRows = await tx.query<{
    id: string;
    purchase_no: string;
    purchase_date: string;
    supplier_id: string;
    status: PurchaseStatus;
  }>(
    `SELECT id, purchase_no::text AS purchase_no,
            purchase_date::text AS purchase_date,
            supplier_id, status::text AS status
       FROM purchases
      WHERE id = $1::uuid
      FOR UPDATE`,
    [purchaseId],
  );
  const purchase = pRows[0];
  if (purchase === undefined) {
    throw new MasterDataError(404, 'PURCHASE_NOT_FOUND', '対象の仕入データが見つかりません。');
  }
  if (purchase.status !== 'P3') {
    throw new MasterDataError(
      400,
      'PURCHASE_NOT_CONFIRMED',
      '仕入確定済（P3）の伝票のみ確定取消できます。',
    );
  }

  const pDate = purchase.purchase_date.slice(0, 10);
  if (pDate <= openingBalanceDate) {
    throw new MasterDataError(
      400,
      'PURCHASE_DATE_BEFORE_CUTOFF',
      `期首残高基準日(${openingBalanceDate})以前の確定済仕入(${pDate})は確定取消できません。`,
    );
  }

  const ledgerRows = await tx.query<{ id: string; status: PayableStatus }>(
    'SELECT id, status::text AS status FROM payable_ledgers WHERE purchase_id = $1::uuid FOR UPDATE',
    [purchaseId],
  );
  const ledger = ledgerRows[0];
  if (ledger !== undefined && ledger.status === 'A2') {
    throw new MasterDataError(
      409,
      'PAYABLE_ALREADY_SETTLED',
      '支払済（A2）の買掛台帳が存在するため仕入確定を取消できません。',
    );
  }

  const linkedPayments = await tx.query<{ cnt: number }>(
    `SELECT COUNT(*)::int AS cnt
       FROM supplier_payments
      WHERE supplier_id = $1::uuid
        AND bill_no = $2`,
    [purchase.supplier_id, purchase.purchase_no],
  );
  if (linkedPayments[0] !== undefined && Number(linkedPayments[0].cnt) > 0) {
    throw new MasterDataError(
      409,
      'PAYABLE_ALREADY_SETTLED',
      'この仕入伝票に対する支払履歴が存在するため確定取消できません。先に支払データを削除してください。',
    );
  }

  await tx.query('DELETE FROM payable_ledgers WHERE purchase_id = $1::uuid', [purchaseId]);
  await tx.query(
    `UPDATE purchases
        SET status = 'P2'::purchase_status,
            updated_by = $2::uuid
      WHERE id = $1::uuid`,
    [purchaseId, employeeId],
  );

  return getPurchaseDetail(tx, tenantId, purchaseId);
}

export async function deletePurchase(
  tx: DbExecutor,
  tenantId: string,
  purchaseId: string,
): Promise<{ id: string }> {
  validateUuid(purchaseId, '仕入');
  await requireFeature(tx, tenantId, 'purchase');

  const pRows = await tx.query<{ id: string; status: PurchaseStatus }>(
    'SELECT id, status::text AS status FROM purchases WHERE id = $1::uuid FOR UPDATE',
    [purchaseId],
  );
  const purchase = pRows[0];
  if (purchase === undefined) {
    throw new MasterDataError(404, 'PURCHASE_NOT_FOUND', '対象の仕入データが見つかりません。');
  }
  if (purchase.status === 'P3') {
    throw new MasterDataError(
      409,
      'PURCHASE_ALREADY_CONFIRMED',
      '仕入確定済（P3）の伝票は削除できません。未払の場合は先に確定取消を行ってください。',
    );
  }

  const ledgerRows = await tx.query<{ cnt: number }>(
    'SELECT COUNT(*)::int AS cnt FROM payable_ledgers WHERE purchase_id = $1::uuid',
    [purchaseId],
  );
  if (ledgerRows[0] !== undefined && Number(ledgerRows[0].cnt) > 0) {
    throw new MasterDataError(
      409,
      'PURCHASE_ALREADY_CONFIRMED',
      '買掛台帳が生成済みの仕入データは削除できません。',
    );
  }

  await tx.query('DELETE FROM purchases WHERE id = $1::uuid', [purchaseId]);
  return { id: purchaseId };
}

export async function exportPurchasesCsv(
  tx: DbExecutor,
  tenantId: string,
  filter: PurchaseListFilter,
): Promise<string> {
  const result = await listPurchases(tx, tenantId, { ...filter, page: 1, pageSize: 5000 });
  const header = [
    '仕入No',
    '仕入日',
    '状態',
    '元発注No',
    '仕入先コード',
    '仕入先名',
    '件名',
    '買掛状態',
    '支払予定日',
    '税抜金額',
    '消費税',
    '税込金額',
  ].map(escapeCsvCell);

  const lines = [header.join(',')];
  for (const item of result.items) {
    const payableLabel =
      item.payableStatus !== null ? PAYABLE_STATUS_LABELS[item.payableStatus] : '未計上';
    lines.push(
      [
        String(item.purchaseNo),
        item.purchaseDate,
        PURCHASE_STATUS_LABELS[item.status],
        item.orderNo !== null ? String(item.orderNo) : '',
        item.supplierCode,
        item.supplierName,
        item.purchaseName,
        payableLabel,
        item.scheduledPayAt !== null ? item.scheduledPayAt : '',
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

export async function exportPurchasesPdf(
  tx: DbExecutor,
  tenantId: string,
  filter: PurchaseListFilter,
): Promise<Uint8Array> {
  const result = await listPurchases(tx, tenantId, { ...filter, page: 1, pageSize: 5000 });
  const settingsRows = await tx.query<{ company_name: string }>(
    'SELECT company_name FROM tenant_settings WHERE tenant_id = $1::uuid LIMIT 1',
    [tenantId],
  );
  const companyName = settingsRows[0] !== undefined ? settingsRows[0].company_name : '自社';

  return renderPurchaseListPdf({
    companyName,
    generatedDate: new Date().toISOString().slice(0, 10),
    filterSummary: `状態:${filter.status !== null && filter.status !== undefined ? PURCHASE_STATUS_LABELS[filter.status] : 'すべて'}`,
    items: result.items.map((item) => ({
      purchaseNo: item.purchaseNo,
      purchaseDate: item.purchaseDate,
      statusLabel: PURCHASE_STATUS_LABELS[item.status],
      orderNo: item.orderNo,
      supplierName: item.supplierName,
      purchaseName: item.purchaseName,
      payableStatusLabel:
        item.payableStatus !== null ? PAYABLE_STATUS_LABELS[item.payableStatus] : '未計上',
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
