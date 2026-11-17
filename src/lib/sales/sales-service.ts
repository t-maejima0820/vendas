import Decimal from 'decimal.js';
import type { DbExecutor } from '@/lib/db/tenant-client';
import {
  calculateSalesSlip,
  type RoundingMode,
  type TaxCalcPolicy,
  type TaxCode,
} from '@/lib/domain/calculations';
import type {
  SalesListPdfInput,
  SalesProductSummaryPdfInput,
} from '@/lib/domain/pdf-renderer';
import { getConsolidatedBaseLookups } from '@/lib/estimates/estimates-service';
import { FeatureDisabledError, isFeatureEnabled, requireFeature } from '@/lib/feature-flags/gate';
import { mapPgConstraintError, MasterDataError } from '@/lib/masters/error-mapper';
import {
  APPROVAL_STATUS_LABELS,
  ENTRY_TYPE_LABELS,
  SALES_STATUS_LABELS,
  type ApprovalStatus,
  type SalesDetailDto,
  type SalesEditorLookupsDto,
  type SalesEntryType,
  type SalesInput,
  type SalesLineDto,
  type SalesListItemDto,
  type SalesListSummaryDto,
  type SalesPageDto,
  type SalesProductSummaryItemDto,
  type SalesProductSummaryResultDto,
  type SalesStatus,
} from '@/lib/sales/types';
import { listEntitySnapshots } from '@/lib/snapshots/snapshot-service';

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DATE_REGEX = /^\d{4}-\d{2}-\d{2}$/;
const VALID_ENTRY_TYPES = new Set<SalesEntryType>(['SALE', 'ADVANCE']);
const VALID_STATUSES = new Set<SalesStatus>(['K1', 'K2', 'K3', 'K4', 'K5', 'K6']);
const EDITABLE_STATUSES = new Set<SalesStatus>(['K1', 'K2', 'K3', 'K6']);
const VALID_ROUNDING_MODES = new Set<RoundingMode>(['FLOOR', 'ROUND', 'CEIL']);
const VALID_TAX_CODES = new Set<TaxCode>(['A', 'B', 'C', 'D', 'E']);

export interface SalesListFilter {
  entryType: SalesEntryType;
  keyword?: string | null;
  status?: SalesStatus | null;
  approvalStatus?: ApprovalStatus | null;
  dateFrom?: string | null;
  dateTo?: string | null;
  projectLink?: 'ALL' | 'LINKED' | 'UNLINKED';
  page?: number;
  pageSize?: number;
}

export interface SalesProductSummaryFilter {
  entryTypeFilter?: 'ALL' | SalesEntryType;
  partnerId?: string | null;
  dateFrom?: string | null;
  dateTo?: string | null;
  keyword?: string | null;
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

export async function assertSalesFeature(
  tx: DbExecutor,
  tenantId: string,
  entryType: SalesEntryType,
): Promise<void> {
  if (!VALID_ENTRY_TYPES.has(entryType)) {
    throw new MasterDataError(400, 'INVALID_ENTRY_TYPE', '区分は SALE または ADVANCE を指定してください。');
  }
  await requireFeature(tx, tenantId, entryType === 'ADVANCE' ? 'tatekae' : 'sales');
}

interface CleanSalesLine {
  productId: string | null;
  itemCode: string | null;
  itemName: string;
  unitName: string | null;
  targetMonthLabel: string | null;
  isHeading: boolean;
  quantityStr: string;
  masterUnitPrice: number | null;
  appliedUnitPrice: number;
  taxCode: TaxCode;
  remarks: string | null;
}

interface CleanSalesPayload {
  entryType: SalesEntryType;
  slipName: string;
  slipDate: string;
  partnerId: string;
  projectId: string | null;
  honorific: string;
  status: SalesStatus;
  salesKubun: string | null;
  roundingMode: RoundingMode;
  approvalRemarks: string | null;
  lines: CleanSalesLine[];
}

function validateSalesInput(input: SalesInput): CleanSalesPayload {
  if (!VALID_ENTRY_TYPES.has(input.entryType)) {
    throw new MasterDataError(400, 'INVALID_ENTRY_TYPE', '伝票区分は SALE または ADVANCE を指定してください。');
  }
  const slipName = input.slipName.trim();
  if (slipName.length === 0 || slipName.length > 200) {
    throw new MasterDataError(400, 'INVALID_SLIP_NAME', '件名は1〜200文字で入力してください。');
  }
  const slipDate = validateDateOnly(input.slipDate, '売上日');
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
    throw new MasterDataError(400, 'INVALID_STATUS', '売上ステータスが不正です。');
  }
  if (!EDITABLE_STATUSES.has(input.status)) {
    throw new MasterDataError(
      400,
      'INVALID_STATUS_TRANSITION',
      '請求済み(K4/K5)ステータスへの直接登録・変更は請求書確定処理からのみ実行できます。',
    );
  }
  if (!VALID_ROUNDING_MODES.has(input.roundingMode)) {
    throw new MasterDataError(400, 'INVALID_ROUNDING_MODE', '端数処理が不正です。');
  }

  if (!Array.isArray(input.lines) || input.lines.length === 0) {
    throw new MasterDataError(400, 'LINES_REQUIRED', '明細行は最低1行以上入力してください。');
  }

  const cleanLines: CleanSalesLine[] = input.lines.map((line, idx) => {
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

    const quantityStr = isHeading ? '0' : validateQuantity(line.quantity, lineNo);
    const masterUnitPrice = validateOptionalIntegerYen(line.masterUnitPrice, `${lineNo}行目の基準単価`);
    const appliedUnitPrice = isHeading
      ? 0
      : validateIntegerYen(line.appliedUnitPrice, `${lineNo}行目の適用単価`);

    return {
      productId,
      itemCode: optTrimmed(line.itemCode),
      itemName,
      unitName: isHeading ? null : optTrimmed(line.unitName),
      targetMonthLabel: isHeading ? null : optTrimmed(line.targetMonthLabel),
      isHeading,
      quantityStr,
      masterUnitPrice,
      appliedUnitPrice,
      taxCode: line.taxCode,
      remarks: optTrimmed(line.remarks),
    };
  });

  return {
    entryType: input.entryType,
    slipName,
    slipDate,
    partnerId: input.partnerId.trim(),
    projectId,
    honorific,
    status: input.status,
    salesKubun: optTrimmed(input.salesKubun),
    roundingMode: input.roundingMode,
    approvalRemarks: optTrimmed(input.approvalRemarks),
    lines: cleanLines,
  };
}

async function assertReferencesExist(
  tx: DbExecutor,
  clean: CleanSalesPayload,
): Promise<void> {
  const partnerRows = await tx.query<{ id: string }>(
    'SELECT id FROM business_partners WHERE id = $1::uuid LIMIT 1',
    [clean.partnerId],
  );
  if (partnerRows.length === 0) {
    throw new MasterDataError(400, 'PARTNER_NOT_FOUND', '指定された取引先が見つかりません。');
  }

  if (clean.projectId !== null) {
    const pjRows = await tx.query<{ id: string }>(
      'SELECT id FROM projects WHERE id = $1::uuid LIMIT 1',
      [clean.projectId],
    );
    if (pjRows.length === 0) {
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

export async function getSalesEditorLookups(
  tx: DbExecutor,
  tenantId: string,
): Promise<SalesEditorLookupsDto> {
  const baseLookups = await getConsolidatedBaseLookups(tx, tenantId, {
    includeCatalog: true,
    includeClosingDays: false,
    includePaymentMethods: false,
  });
  const [salesEnabled, tatekaeEnabled, customSumItemEnabled, estimateEnabled] = await Promise.all([
    isFeatureEnabled(tx, tenantId, 'sales'),
    isFeatureEnabled(tx, tenantId, 'tatekae'),
    isFeatureEnabled(tx, tenantId, 'custom-sum-item'),
    isFeatureEnabled(tx, tenantId, 'estimate'),
  ]);

  return {
    approvalFlowEnabled: baseLookups.approvalFlowEnabled,
    taxCalcPolicy: baseLookups.taxCalcPolicy,
    defaultRoundingMode: baseLookups.defaultRoundingMode,
    quotationTemplateRows: baseLookups.quotationTemplateRows,
    salesEnabled,
    tatekaeEnabled,
    customSumItemEnabled,
    estimateEnabled,
    partners: baseLookups.partners,
    projects: baseLookups.projects,
    products: baseLookups.products,
    intelligences: baseLookups.intelligences,
    units: baseLookups.units,
    taxCodes: baseLookups.taxCodes,
  };
}

function normalizeSalesListFilter(filter: SalesListFilter): {
  entryType: SalesEntryType;
  kw: string | null;
  status: SalesStatus | null;
  approvalStatus: ApprovalStatus | null;
  dateFrom: string | null;
  dateTo: string | null;
  projectLink: 'ALL' | 'LINKED' | 'UNLINKED';
  page: number;
  pageSize: number;
  offset: number;
} {
  const entryType: SalesEntryType = filter.entryType === 'ADVANCE' ? 'ADVANCE' : 'SALE';
  const kw = optTrimmed(filter.keyword);
  const status =
    filter.status !== undefined && filter.status !== null && VALID_STATUSES.has(filter.status)
      ? filter.status
      : null;
  const approvalStatus =
    filter.approvalStatus === 0 || filter.approvalStatus === 1 || filter.approvalStatus === 2
      ? filter.approvalStatus
      : null;
  const rawFrom = optTrimmed(filter.dateFrom);
  const dateFrom = rawFrom !== null && DATE_REGEX.test(rawFrom) ? rawFrom : null;
  const rawTo = optTrimmed(filter.dateTo);
  const dateTo = rawTo !== null && DATE_REGEX.test(rawTo) ? rawTo : null;
  const projectLink =
    filter.projectLink === 'LINKED' || filter.projectLink === 'UNLINKED' ? filter.projectLink : 'ALL';

  const rawPage = filter.page === undefined ? 1 : filter.page;
  const rawSize = filter.pageSize === undefined ? 25 : filter.pageSize;
  const page = Number.isInteger(rawPage) && rawPage >= 1 ? rawPage : 1;
  const pageSize = Number.isInteger(rawSize) && rawSize >= 1 && rawSize <= 5000 ? rawSize : 25;
  const offset = (page - 1) * pageSize;

  return {
    entryType,
    kw,
    status,
    approvalStatus,
    dateFrom,
    dateTo,
    projectLink,
    page,
    pageSize,
    offset,
  };
}

interface SalesListRow extends Record<string, unknown> {
  id: string;
  entry_type: SalesEntryType;
  slip_no: string;
  slip_name: string;
  slip_date: string;
  partner_id: string;
  partner_code: string;
  partner_name: string;
  project_id: string | null;
  project_no: string | null;
  project_name: string | null;
  honorific: string;
  status: SalesStatus;
  approval_status: number;
  approval_remarks: string | null;
  sales_kubun: string | null;
  rounding_mode: RoundingMode;
  subtotal_amount: string;
  tax_total: string;
  total_amount: string;
  line_count: number;
  dn_count: number;
  dn_max_ver: number | null;
  dr_count: number;
  dr_max_ver: number | null;
  updated_at: string;
}

export async function listSalesSlips(
  tx: DbExecutor,
  tenantId: string,
  filter: SalesListFilter,
): Promise<SalesPageDto> {
  const f = normalizeSalesListFilter(filter);
  await assertSalesFeature(tx, tenantId, f.entryType);

  const summaryRows = await tx.query<{
    total_count: number;
    sum_subtotal: string;
    sum_tax: string;
    sum_total: string;
    approved_count: number;
    pending_count: number;
  }>(
    `SELECT COUNT(*)::int AS total_count,
            COALESCE(SUM(sh.subtotal_amount), 0)::text AS sum_subtotal,
            COALESCE(SUM(sh.tax_total), 0)::text AS sum_tax,
            COALESCE(SUM(sh.total_amount), 0)::text AS sum_total,
            COUNT(*) FILTER (WHERE sh.approval_status = 1)::int AS approved_count,
            COUNT(*) FILTER (WHERE sh.approval_status = 0)::int AS pending_count
       FROM sales_headers sh
       JOIN business_partners bp ON bp.tenant_id = sh.tenant_id AND bp.id = sh.partner_id
       LEFT JOIN projects pj ON pj.tenant_id = sh.tenant_id AND pj.id = sh.project_id
      WHERE sh.entry_type = $1::sales_entry_type
        AND (
          $2::text IS NULL
          OR CAST(sh.slip_no AS text) ILIKE '%' || $2 || '%'
          OR sh.slip_name ILIKE '%' || $2 || '%'
          OR bp.partner_name ILIKE '%' || $2 || '%'
          OR bp.partner_code ILIKE '%' || $2 || '%'
          OR COALESCE(pj.project_name, '') ILIKE '%' || $2 || '%'
        )
        AND ($3::text IS NULL OR sh.status::text = $3)
        AND ($4::smallint IS NULL OR sh.approval_status = $4::smallint)
        AND ($5::date IS NULL OR sh.slip_date >= $5::date)
        AND ($6::date IS NULL OR sh.slip_date <= $6::date)
        AND (
          $7::text = 'ALL'
          OR ($7::text = 'LINKED' AND sh.project_id IS NOT NULL)
          OR ($7::text = 'UNLINKED' AND sh.project_id IS NULL)
        )`,
    [f.entryType, f.kw, f.status, f.approvalStatus, f.dateFrom, f.dateTo, f.projectLink],
  );

  const sumRow = summaryRows[0];
  const summary: SalesListSummaryDto = {
    totalCount: sumRow !== undefined ? Number(sumRow.total_count) : 0,
    subtotalAmount: sumRow !== undefined ? Number(sumRow.sum_subtotal) : 0,
    taxTotal: sumRow !== undefined ? Number(sumRow.sum_tax) : 0,
    totalAmount: sumRow !== undefined ? Number(sumRow.sum_total) : 0,
    approvedCount: sumRow !== undefined ? Number(sumRow.approved_count) : 0,
    pendingCount: sumRow !== undefined ? Number(sumRow.pending_count) : 0,
  };

  const rows = await tx.query<SalesListRow>(
    `SELECT sh.id,
            sh.entry_type::text AS entry_type,
            sh.slip_no::text AS slip_no,
            sh.slip_name,
            sh.slip_date::text AS slip_date,
            sh.partner_id,
            bp.partner_code,
            bp.partner_name,
            sh.project_id,
            pj.project_no::text AS project_no,
            pj.project_name,
            sh.honorific,
            sh.status::text AS status,
            sh.approval_status,
            sh.approval_remarks,
            sh.sales_kubun,
            sh.rounding_mode::text AS rounding_mode,
            sh.subtotal_amount::text AS subtotal_amount,
            sh.tax_total::text AS tax_total,
            sh.total_amount::text AS total_amount,
            COALESCE(sl_agg.line_count, 0)::int AS line_count,
            COALESCE(dn_agg.snap_count, 0)::int AS dn_count,
            dn_agg.max_ver AS dn_max_ver,
            COALESCE(dr_agg.snap_count, 0)::int AS dr_count,
            dr_agg.max_ver AS dr_max_ver,
            sh.updated_at::text AS updated_at
       FROM sales_headers sh
       JOIN business_partners bp ON bp.tenant_id = sh.tenant_id AND bp.id = sh.partner_id
       LEFT JOIN projects pj ON pj.tenant_id = sh.tenant_id AND pj.id = sh.project_id
       LEFT JOIN (
         SELECT sales_header_id, COUNT(*)::int AS line_count
           FROM sales_lines
          GROUP BY sales_header_id
       ) sl_agg ON sl_agg.sales_header_id = sh.id
       LEFT JOIN (
         SELECT source_entity_id, COUNT(*)::int AS snap_count, MAX(version_no)::int AS max_ver
           FROM document_snapshots
          WHERE document_type = 'DELIVERY_NOTE'
          GROUP BY source_entity_id
       ) dn_agg ON dn_agg.source_entity_id = sh.id
       LEFT JOIN (
         SELECT source_entity_id, COUNT(*)::int AS snap_count, MAX(version_no)::int AS max_ver
           FROM document_snapshots
          WHERE document_type = 'DELIVERY_RECEIPT'
          GROUP BY source_entity_id
       ) dr_agg ON dr_agg.source_entity_id = sh.id
      WHERE sh.entry_type = $1::sales_entry_type
        AND (
          $2::text IS NULL
          OR CAST(sh.slip_no AS text) ILIKE '%' || $2 || '%'
          OR sh.slip_name ILIKE '%' || $2 || '%'
          OR bp.partner_name ILIKE '%' || $2 || '%'
          OR bp.partner_code ILIKE '%' || $2 || '%'
          OR COALESCE(pj.project_name, '') ILIKE '%' || $2 || '%'
        )
        AND ($3::text IS NULL OR sh.status::text = $3)
        AND ($4::smallint IS NULL OR sh.approval_status = $4::smallint)
        AND ($5::date IS NULL OR sh.slip_date >= $5::date)
        AND ($6::date IS NULL OR sh.slip_date <= $6::date)
        AND (
          $7::text = 'ALL'
          OR ($7::text = 'LINKED' AND sh.project_id IS NOT NULL)
          OR ($7::text = 'UNLINKED' AND sh.project_id IS NULL)
        )
      ORDER BY sh.slip_date DESC, sh.slip_no DESC
      LIMIT $8 OFFSET $9`,
    [
      f.entryType,
      f.kw,
      f.status,
      f.approvalStatus,
      f.dateFrom,
      f.dateTo,
      f.projectLink,
      f.pageSize,
      f.offset,
    ],
  );

  const items: SalesListItemDto[] = rows.map((r) => ({
    id: r.id,
    entryType: r.entry_type,
    slipNo: Number(r.slip_no),
    slipName: r.slip_name,
    slipDate: r.slip_date.slice(0, 10),
    partnerId: r.partner_id,
    partnerCode: r.partner_code,
    partnerName: r.partner_name,
    projectId: r.project_id,
    projectNo: r.project_no !== null ? Number(r.project_no) : null,
    projectName: r.project_name,
    honorific: r.honorific,
    status: r.status,
    approvalStatus: (r.approval_status === 1 || r.approval_status === 2 ? r.approval_status : 0) as ApprovalStatus,
    approvalRemarks: r.approval_remarks,
    salesKubun: r.sales_kubun,
    roundingMode: r.rounding_mode,
    subtotalAmount: Number(r.subtotal_amount),
    taxTotal: Number(r.tax_total),
    totalAmount: Number(r.total_amount),
    lineCount: Number(r.line_count),
    deliveryNoteCount: Number(r.dn_count),
    latestDeliveryNoteVersion: r.dn_max_ver !== null ? Number(r.dn_max_ver) : null,
    deliveryReceiptCount: Number(r.dr_count),
    latestDeliveryReceiptVersion: r.dr_max_ver !== null ? Number(r.dr_max_ver) : null,
    updatedAt: r.updated_at,
  }));

  return {
    items,
    summary,
    page: f.page,
    pageSize: f.pageSize,
  };
}

export async function getSalesDetail(
  tx: DbExecutor,
  tenantId: string,
  id: string,
): Promise<SalesDetailDto> {
  validateUuid(id, '売上・立替伝票');

  const headerRows = await tx.query<{
    id: string;
    entry_type: SalesEntryType;
    slip_no: string;
    slip_name: string;
    slip_date: string;
    partner_id: string;
    partner_code: string;
    partner_name: string;
    project_id: string | null;
    project_no: string | null;
    project_name: string | null;
    honorific: string;
    status: SalesStatus;
    approval_status: number;
    approval_remarks: string | null;
    sales_kubun: string | null;
    billing_id: string | null;
    billing_date: string | null;
    rounding_mode: RoundingMode;
    subtotal_amount: string;
    tax_total: string;
    total_amount: string;
    created_at: string;
    updated_at: string;
  }>(
    `SELECT sh.id, sh.entry_type::text AS entry_type, sh.slip_no::text AS slip_no,
            sh.slip_name, sh.slip_date::text AS slip_date,
            sh.partner_id, bp.partner_code, bp.partner_name,
            sh.project_id, pj.project_no::text AS project_no, pj.project_name,
            sh.honorific, sh.status::text AS status, sh.approval_status,
            sh.approval_remarks, sh.sales_kubun, sh.billing_id,
            sh.billing_date::text AS billing_date,
            sh.rounding_mode::text AS rounding_mode,
            sh.subtotal_amount::text AS subtotal_amount,
            sh.tax_total::text AS tax_total,
            sh.total_amount::text AS total_amount,
            sh.created_at::text AS created_at, sh.updated_at::text AS updated_at
       FROM sales_headers sh
       JOIN business_partners bp ON bp.tenant_id = sh.tenant_id AND bp.id = sh.partner_id
       LEFT JOIN projects pj ON pj.tenant_id = sh.tenant_id AND pj.id = sh.project_id
      WHERE sh.id = $1::uuid
      LIMIT 1`,
    [id],
  );
  const hdr = headerRows[0];
  if (hdr === undefined) {
    throw new MasterDataError(404, 'SALES_NOT_FOUND', '指定された売上・立替伝票が見つかりません。');
  }

  await assertSalesFeature(tx, tenantId, hdr.entry_type);

  const settingsRows = await tx.query<{ tax_calc_policy: TaxCalcPolicy }>(
    'SELECT tax_calc_policy::text AS tax_calc_policy FROM tenant_settings WHERE tenant_id = $1::uuid LIMIT 1',
    [tenantId],
  );
  const taxCalcPolicy: TaxCalcPolicy =
    settingsRows[0] !== undefined ? settingsRows[0].tax_calc_policy : 'SLIP_BY_RATE';

  const lineRows = await tx.query<{
    id: string;
    line_no: number;
    product_id: string | null;
    item_code: string | null;
    item_name: string;
    unit_name: string | null;
    target_month_label: string | null;
    is_heading: boolean;
    quantity: string;
    master_unit_price: string | null;
    applied_unit_price: string;
    tax_code: TaxCode;
    line_amount: string;
    line_tax: string;
    row_total: string;
    remarks: string | null;
  }>(
    `SELECT id, line_no, product_id, item_code, item_name, unit_name,
            target_month_label, is_heading, quantity::text AS quantity,
            master_unit_price::text AS master_unit_price,
            applied_unit_price::text AS applied_unit_price,
            tax_code, line_amount::text AS line_amount,
            line_tax::text AS line_tax, row_total::text AS row_total, remarks
       FROM sales_lines
      WHERE sales_header_id = $1::uuid
      ORDER BY line_no ASC`,
    [id],
  );

  const lines: SalesLineDto[] = lineRows.map((l) => ({
    id: l.id,
    lineNo: Number(l.line_no),
    productId: l.product_id,
    itemCode: l.item_code,
    itemName: l.item_name,
    unitName: l.unit_name,
    targetMonthLabel: l.target_month_label,
    isHeading: l.is_heading,
    quantity: Number(l.quantity),
    masterUnitPrice: l.master_unit_price !== null ? Number(l.master_unit_price) : null,
    appliedUnitPrice: Number(l.applied_unit_price),
    taxCode: l.tax_code,
    lineAmount: Number(l.line_amount),
    lineTax: Number(l.line_tax),
    rowTotal: Number(l.row_total),
    remarks: l.remarks,
  }));

  const [deliveryNotes, deliveryReceipts] = await Promise.all([
    listEntitySnapshots(tx, { documentType: 'DELIVERY_NOTE', sourceEntityId: id }),
    listEntitySnapshots(tx, { documentType: 'DELIVERY_RECEIPT', sourceEntityId: id }),
  ]);

  return {
    id: hdr.id,
    entryType: hdr.entry_type,
    slipNo: Number(hdr.slip_no),
    slipName: hdr.slip_name,
    slipDate: hdr.slip_date.slice(0, 10),
    partnerId: hdr.partner_id,
    partnerCode: hdr.partner_code,
    partnerName: hdr.partner_name,
    projectId: hdr.project_id,
    projectNo: hdr.project_no !== null ? Number(hdr.project_no) : null,
    projectName: hdr.project_name,
    honorific: hdr.honorific,
    status: hdr.status,
    approvalStatus: (hdr.approval_status === 1 || hdr.approval_status === 2 ? hdr.approval_status : 0) as ApprovalStatus,
    approvalRemarks: hdr.approval_remarks,
    salesKubun: hdr.sales_kubun,
    billingId: hdr.billing_id,
    billingDate: hdr.billing_date !== null ? hdr.billing_date.slice(0, 10) : null,
    roundingMode: hdr.rounding_mode,
    taxCalcPolicy,
    subtotalAmount: Number(hdr.subtotal_amount),
    taxTotal: Number(hdr.tax_total),
    totalAmount: Number(hdr.total_amount),
    createdAt: hdr.created_at,
    updatedAt: hdr.updated_at,
    lines,
    deliveryNotes,
    deliveryReceipts,
  };
}

async function insertSalesLines(
  tx: DbExecutor,
  tenantId: string,
  salesHeaderId: string,
  cleanLines: readonly CleanSalesLine[],
  roundingMode: RoundingMode,
  policy: TaxCalcPolicy,
): Promise<void> {
  const calc = calculateSalesSlip(
    cleanLines.map((l, idx) => ({
      lineNo: idx + 1,
      isHeading: l.isHeading,
      quantity: l.quantityStr,
      appliedUnitPrice: BigInt(l.appliedUnitPrice),
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
      `INSERT INTO sales_lines (
         tenant_id, sales_header_id, line_no, product_id, item_code, item_name, unit_name,
         target_month_label, is_heading, quantity, master_unit_price, applied_unit_price,
         tax_code, line_amount, line_tax, row_total, remarks
       ) VALUES (
         $1::uuid, $2::uuid, $3, $4::uuid, $5, $6, $7,
         $8, $9, $10::numeric, $11::numeric, $12::numeric,
         $13, $14::numeric, $15::numeric, $16::numeric, $17
       )`,
      [
        tenantId,
        salesHeaderId,
        i + 1,
        line.productId,
        line.itemCode,
        line.itemName,
        line.unitName,
        line.targetMonthLabel,
        line.isHeading,
        line.quantityStr,
        line.masterUnitPrice !== null ? String(line.masterUnitPrice) : null,
        String(line.appliedUnitPrice),
        line.taxCode,
        lr.lineAmount.toString(),
        lr.lineTax.toString(),
        lr.rowTotal.toString(),
        line.remarks,
      ],
    );
  }
}

export async function createSalesSlip(
  tx: DbExecutor,
  tenantId: string,
  employeeId: string,
  input: SalesInput,
): Promise<SalesDetailDto> {
  await assertSalesFeature(tx, tenantId, input.entryType);
  const clean = validateSalesInput(input);
  await assertReferencesExist(tx, clean);

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

  const calc = calculateSalesSlip(
    clean.lines.map((l, idx) => ({
      lineNo: idx + 1,
      isHeading: l.isHeading,
      quantity: l.quantityStr,
      appliedUnitPrice: BigInt(l.appliedUnitPrice),
      taxCode: l.taxCode,
    })),
    clean.roundingMode,
    settings.tax_calc_policy,
  );

  try {
    const noRows = await tx.query<{ next_no: string }>(
      `SELECT (COALESCE(MAX(slip_no), 0) + 1)::text AS next_no
         FROM sales_headers
        WHERE entry_type = $1::sales_entry_type`,
      [clean.entryType],
    );
    const nextNo = noRows[0] !== undefined ? noRows[0].next_no : '1';

    const inserted = await tx.query<{ id: string }>(
      `INSERT INTO sales_headers (
         tenant_id, entry_type, slip_no, slip_name, slip_date, partner_id, project_id,
         honorific, status, approval_status, approval_remarks, sales_kubun,
         rounding_mode, subtotal_amount, tax_total, total_amount, created_by, updated_by
       ) VALUES (
         $1::uuid, $2::sales_entry_type, $3::bigint, $4, $5::date, $6::uuid, $7::uuid,
         $8, $9::sales_status, 0, $10, $11,
         $12::rounding_mode, $13::numeric, $14::numeric, $15::numeric, $16::uuid, $16::uuid
       ) RETURNING id`,
      [
        tenantId,
        clean.entryType,
        nextNo,
        clean.slipName,
        clean.slipDate,
        clean.partnerId,
        clean.projectId,
        clean.honorific,
        clean.status,
        clean.approvalRemarks,
        clean.salesKubun,
        clean.roundingMode,
        calc.subtotalAmount.toString(),
        calc.taxTotal.toString(),
        calc.totalAmount.toString(),
        employeeId,
      ],
    );

    const salesId = inserted[0]?.id;
    if (salesId === undefined) {
      throw new MasterDataError(500, 'INSERT_FAILED', '売上・立替ヘッダの登録結果を取得できませんでした。');
    }

    await insertSalesLines(tx, tenantId, salesId, clean.lines, clean.roundingMode, settings.tax_calc_policy);
    return getSalesDetail(tx, tenantId, salesId);
  } catch (err) {
    throw mapPgConstraintError(err, { entityLabel: '売上・立替伝票' });
  }
}

export async function updateSalesSlip(
  tx: DbExecutor,
  tenantId: string,
  employeeId: string,
  id: string,
  input: SalesInput,
): Promise<SalesDetailDto> {
  validateUuid(id, '売上・立替伝票');
  const clean = validateSalesInput(input);
  await assertSalesFeature(tx, tenantId, clean.entryType);
  await assertReferencesExist(tx, clean);

  const lockRows = await tx.query<{
    id: string;
    entry_type: SalesEntryType;
    status: SalesStatus;
  }>(
    `SELECT id, entry_type::text AS entry_type, status::text AS status
       FROM sales_headers
      WHERE id = $1::uuid
      FOR UPDATE`,
    [id],
  );
  const existing = lockRows[0];
  if (existing === undefined) {
    throw new MasterDataError(404, 'SALES_NOT_FOUND', '指定された売上・立替伝票が見つかりません。');
  }
  if (existing.entry_type !== clean.entryType) {
    throw new MasterDataError(
      400,
      'ENTRY_TYPE_IMMUTABLE',
      '登録済みの伝票区分（売上 / 立替）は変更できません。',
    );
  }
  if (existing.status === 'K4' || existing.status === 'K5') {
    throw new MasterDataError(
      409,
      'BILLED_SALES_LOCKED',
      '請求済み(K4/K5)の売上・立替伝票は修正できません。',
    );
  }

  const settingsRows = await tx.query<{ tax_calc_policy: TaxCalcPolicy }>(
    'SELECT tax_calc_policy::text AS tax_calc_policy FROM tenant_settings WHERE tenant_id = $1::uuid LIMIT 1',
    [tenantId],
  );
  const taxCalcPolicy: TaxCalcPolicy =
    settingsRows[0] !== undefined ? settingsRows[0].tax_calc_policy : 'SLIP_BY_RATE';

  const calc = calculateSalesSlip(
    clean.lines.map((l, idx) => ({
      lineNo: idx + 1,
      isHeading: l.isHeading,
      quantity: l.quantityStr,
      appliedUnitPrice: BigInt(l.appliedUnitPrice),
      taxCode: l.taxCode,
    })),
    clean.roundingMode,
    taxCalcPolicy,
  );

  try {
    await tx.query(
      `UPDATE sales_headers
          SET slip_name = $2,
              slip_date = $3::date,
              partner_id = $4::uuid,
              project_id = $5::uuid,
              honorific = $6,
              status = $7::sales_status,
              approval_remarks = $8,
              sales_kubun = $9,
              rounding_mode = $10::rounding_mode,
              subtotal_amount = $11::numeric,
              tax_total = $12::numeric,
              total_amount = $13::numeric,
              updated_by = $14::uuid
        WHERE id = $1::uuid`,
      [
        id,
        clean.slipName,
        clean.slipDate,
        clean.partnerId,
        clean.projectId,
        clean.honorific,
        clean.status,
        clean.approvalRemarks,
        clean.salesKubun,
        clean.roundingMode,
        calc.subtotalAmount.toString(),
        calc.taxTotal.toString(),
        calc.totalAmount.toString(),
        employeeId,
      ],
    );

    await tx.query('DELETE FROM sales_lines WHERE sales_header_id = $1::uuid', [id]);
    await insertSalesLines(tx, tenantId, id, clean.lines, clean.roundingMode, taxCalcPolicy);

    return getSalesDetail(tx, tenantId, id);
  } catch (err) {
    throw mapPgConstraintError(err, { entityLabel: '売上・立替伝票' });
  }
}

export async function deleteSalesSlip(
  tx: DbExecutor,
  tenantId: string,
  id: string,
): Promise<void> {
  validateUuid(id, '売上・立替伝票');

  const lockRows = await tx.query<{
    id: string;
    entry_type: SalesEntryType;
    status: SalesStatus;
  }>(
    `SELECT id, entry_type::text AS entry_type, status::text AS status
       FROM sales_headers
      WHERE id = $1::uuid
      FOR UPDATE`,
    [id],
  );
  const existing = lockRows[0];
  if (existing === undefined) {
    throw new MasterDataError(404, 'SALES_NOT_FOUND', '指定された売上・立替伝票が見つかりません。');
  }

  await assertSalesFeature(tx, tenantId, existing.entry_type);

  if (existing.status === 'K4' || existing.status === 'K5') {
    throw new MasterDataError(
      409,
      'BILLED_SALES_LOCKED',
      '請求済み(K4/K5)の売上・立替伝票は削除できません。',
    );
  }

  const snapRows = await tx.query<{ cnt: number }>(
    `SELECT COUNT(*)::int AS cnt
       FROM document_snapshots
      WHERE source_entity_type = 'SALES_HEADER'
        AND source_entity_id = $1::uuid`,
    [id],
  );
  const snapCount = snapRows[0] !== undefined ? Number(snapRows[0].cnt) : 0;
  if (snapCount > 0) {
    throw new MasterDataError(
      409,
      'SALES_HAS_SNAPSHOTS',
      '納品書または受領書が発行済みの伝票は削除できません。',
    );
  }

  await tx.query('DELETE FROM sales_headers WHERE id = $1::uuid', [id]);
}

export async function createSalesFromQuotation(
  tx: DbExecutor,
  tenantId: string,
  employeeId: string,
  params: {
    quotationId: string;
    entryType?: SalesEntryType;
    slipDate?: string;
    updateQuotationStatusToQ2?: boolean;
  },
): Promise<SalesDetailDto> {
  validateUuid(params.quotationId, '転記元見積');
  await requireFeature(tx, tenantId, 'estimate');

  const qRows = await tx.query<{
    id: string;
    quotation_name: string;
    partner_id: string;
    project_id: string | null;
    honorific: string;
    is_advance_type: boolean;
    rounding_mode: RoundingMode;
  }>(
    `SELECT id, quotation_name, partner_id, project_id, honorific,
            is_advance_type, rounding_mode::text AS rounding_mode
       FROM quotations
      WHERE id = $1::uuid
      FOR UPDATE`,
    [params.quotationId],
  );
  const quotation = qRows[0];
  if (quotation === undefined) {
    throw new MasterDataError(404, 'QUOTATION_NOT_FOUND', '転記元の見積が見つかりません。');
  }

  const lineRows = await tx.query<{
    product_id: string | null;
    item_code: string | null;
    item_name: string;
    unit_name: string | null;
    is_heading: boolean;
    quantity: string;
    tax_code: TaxCode;
    master_unit_price: string | null;
    applied_unit_price: string;
    remarks: string | null;
  }>(
    `SELECT product_id, item_code, item_name, unit_name, is_heading,
            quantity::text AS quantity, tax_code,
            master_unit_price::text AS master_unit_price,
            applied_unit_price::text AS applied_unit_price, remarks
       FROM quotation_lines
      WHERE quotation_id = $1::uuid
      ORDER BY line_no ASC`,
    [params.quotationId],
  );
  if (lineRows.length === 0) {
    throw new MasterDataError(400, 'EMPTY_QUOTATION_LINES', '明細行がない見積からは転記できません。');
  }

  const entryType: SalesEntryType =
    params.entryType !== undefined
      ? params.entryType
      : quotation.is_advance_type
        ? 'ADVANCE'
        : 'SALE';

  const slipDate =
    params.slipDate !== undefined && params.slipDate.trim() !== ''
      ? validateDateOnly(params.slipDate, '売上日')
      : new Date().toISOString().slice(0, 10);

  const created = await createSalesSlip(tx, tenantId, employeeId, {
    entryType,
    slipName: quotation.quotation_name,
    slipDate,
    partnerId: quotation.partner_id,
    projectId: quotation.project_id,
    honorific: quotation.honorific,
    status: 'K1',
    salesKubun: null,
    roundingMode: quotation.rounding_mode,
    approvalRemarks: null,
    lines: lineRows.map((l) => ({
      productId: l.product_id,
      itemCode: l.item_code,
      itemName: l.item_name,
      unitName: l.unit_name,
      targetMonthLabel: null,
      isHeading: l.is_heading,
      quantity: l.is_heading ? 0 : Number(l.quantity),
      masterUnitPrice: l.master_unit_price !== null ? Number(l.master_unit_price) : null,
      appliedUnitPrice: l.is_heading ? 0 : Number(l.applied_unit_price),
      taxCode: l.tax_code,
      remarks: l.remarks,
    })),
  });

  if (params.updateQuotationStatusToQ2 !== false) {
    await tx.query(
      `UPDATE quotations
          SET status = 'Q2'::quotation_status,
              updated_by = $2::uuid
        WHERE id = $1::uuid`,
      [params.quotationId, employeeId],
    );
  }

  return created;
}

export async function updateSalesApproval(
  tx: DbExecutor,
  tenantId: string,
  employeeId: string,
  params: {
    ids: readonly string[];
    approvalStatus: ApprovalStatus;
    approvalRemarks?: string | null;
    nextStatus?: 'K1' | 'K2' | 'K3' | 'K6';
  },
): Promise<{ updatedCount: number }> {
  if (!Array.isArray(params.ids) || params.ids.length === 0) {
    throw new MasterDataError(400, 'IDS_REQUIRED', '承認更新対象の伝票IDを1件以上指定してください。');
  }
  const uniqueIds = Array.from(new Set(params.ids));
  for (const id of uniqueIds) {
    validateUuid(id, '売上・立替伝票');
  }
  if (params.approvalStatus !== 0 && params.approvalStatus !== 1 && params.approvalStatus !== 2) {
    throw new MasterDataError(400, 'INVALID_APPROVAL_STATUS', '承認ステータスは 0 / 1 / 2 を指定してください。');
  }
  if (params.nextStatus !== undefined && !EDITABLE_STATUSES.has(params.nextStatus)) {
    throw new MasterDataError(
      400,
      'INVALID_STATUS_TRANSITION',
      '承認操作で更新できるステータスは K1 / K2 / K3 / K6 のみです。',
    );
  }

  const rows = await tx.query<{
    id: string;
    entry_type: SalesEntryType;
    status: SalesStatus;
  }>(
    `SELECT id, entry_type::text AS entry_type, status::text AS status
       FROM sales_headers
      WHERE id = ANY($1::uuid[])
      FOR UPDATE`,
    [uniqueIds],
  );
  if (rows.length !== uniqueIds.length) {
    throw new MasterDataError(404, 'SALES_NOT_FOUND', '指定された伝票の一部が見つかりません。');
  }

  const entryTypesPresent = new Set<SalesEntryType>();
  for (const r of rows) {
    entryTypesPresent.add(r.entry_type);
    if (r.status === 'K4' || r.status === 'K5') {
      throw new MasterDataError(
        409,
        'BILLED_SALES_LOCKED',
        '請求済み(K4/K5)の売上・立替伝票は承認状態やステータスを変更できません。',
      );
    }
  }
  for (const et of entryTypesPresent) {
    await assertSalesFeature(tx, tenantId, et);
  }

  const cleanRemarks =
    params.approvalRemarks !== undefined ? optTrimmed(params.approvalRemarks) : undefined;
  const remarksUpdateProvided = cleanRemarks !== undefined;
  const remarksVal = cleanRemarks !== undefined ? cleanRemarks : null;
  const nextStatusVal = params.nextStatus !== undefined ? params.nextStatus : null;

  await tx.query(
    `UPDATE sales_headers
        SET approval_status = $2::smallint,
            approval_remarks = CASE WHEN $3::boolean THEN $4 ELSE approval_remarks END,
            status = COALESCE($5::sales_status, status),
            updated_by = $6::uuid
      WHERE id = ANY($1::uuid[])`,
    [
      uniqueIds,
      params.approvalStatus,
      remarksUpdateProvided,
      remarksVal,
      nextStatusVal,
      employeeId,
    ],
  );

  return { updatedCount: rows.length };
}

export async function getSalesProductSummary(
  tx: DbExecutor,
  tenantId: string,
  filter: SalesProductSummaryFilter = {},
): Promise<SalesProductSummaryResultDto> {
  const entryTypeFilter = filter.entryTypeFilter ?? 'ALL';
  const enabledTypes: SalesEntryType[] = [];

  if (entryTypeFilter === 'SALE') {
    await requireFeature(tx, tenantId, 'sales');
    enabledTypes.push('SALE');
  } else if (entryTypeFilter === 'ADVANCE') {
    await requireFeature(tx, tenantId, 'tatekae');
    enabledTypes.push('ADVANCE');
  } else {
    const [salesOk, advanceOk] = await Promise.all([
      isFeatureEnabled(tx, tenantId, 'sales'),
      isFeatureEnabled(tx, tenantId, 'tatekae'),
    ]);
    if (salesOk) enabledTypes.push('SALE');
    if (advanceOk) enabledTypes.push('ADVANCE');
    if (enabledTypes.length === 0) {
      throw new FeatureDisabledError('sales');
    }
  }

  let partnerId: string | null = null;
  if (filter.partnerId !== undefined && filter.partnerId !== null && filter.partnerId.trim() !== '') {
    validateUuid(filter.partnerId.trim(), '取引先');
    partnerId = filter.partnerId.trim();
  }
  const rawFrom = optTrimmed(filter.dateFrom);
  const dateFrom = rawFrom !== null && DATE_REGEX.test(rawFrom) ? rawFrom : null;
  const rawTo = optTrimmed(filter.dateTo);
  const dateTo = rawTo !== null && DATE_REGEX.test(rawTo) ? rawTo : null;
  const kw = optTrimmed(filter.keyword);

  const rows = await tx.query<{
    entry_type: SalesEntryType;
    item_code: string | null;
    item_name: string;
    unit_name: string | null;
    tax_code: TaxCode;
    slip_count: number;
    total_qty: string;
    excl_amount: string;
    tax_amount: string;
    incl_amount: string;
  }>(
    `SELECT sh.entry_type::text AS entry_type,
            sl.item_code,
            sl.item_name,
            sl.unit_name,
            sl.tax_code,
            COUNT(DISTINCT sh.id)::int AS slip_count,
            COALESCE(SUM(sl.quantity), 0)::text AS total_qty,
            COALESCE(SUM(
              CASE
                WHEN sl.tax_code IN ('D', 'E') THEN sl.line_amount - sl.line_tax
                ELSE sl.line_amount
              END
            ), 0)::text AS excl_amount,
            COALESCE(SUM(sl.line_tax), 0)::text AS tax_amount,
            COALESCE(SUM(sl.row_total), 0)::text AS incl_amount
       FROM sales_lines sl
       JOIN sales_headers sh ON sh.tenant_id = sl.tenant_id AND sh.id = sl.sales_header_id
      WHERE sl.is_heading = false
        AND sh.entry_type::text = ANY($1::text[])
        AND ($2::uuid IS NULL OR sh.partner_id = $2::uuid)
        AND ($3::date IS NULL OR sh.slip_date >= $3::date)
        AND ($4::date IS NULL OR sh.slip_date <= $4::date)
        AND (
          $5::text IS NULL
          OR COALESCE(sl.item_code, '') ILIKE '%' || $5 || '%'
          OR sl.item_name ILIKE '%' || $5 || '%'
        )
      GROUP BY sh.entry_type, sl.item_code, sl.item_name, sl.unit_name, sl.tax_code
      ORDER BY sh.entry_type ASC, incl_amount DESC, sl.item_name ASC`,
    [enabledTypes, partnerId, dateFrom, dateTo, kw],
  );

  let exclSum = 0;
  let taxSum = 0;
  let inclSum = 0;

  const items: SalesProductSummaryItemDto[] = rows.map((r) => {
    const excl = Number(r.excl_amount);
    const tax = Number(r.tax_amount);
    const incl = Number(r.incl_amount);
    exclSum += excl;
    taxSum += tax;
    inclSum += incl;
    return {
      entryType: r.entry_type,
      itemCode: r.item_code,
      itemName: r.item_name,
      unitName: r.unit_name,
      taxCode: r.tax_code,
      slipCount: Number(r.slip_count),
      totalQuantity: Number(r.total_qty),
      exclAmount: excl,
      taxAmount: tax,
      inclAmount: incl,
    };
  });

  return {
    items,
    totals: {
      rowCount: items.length,
      exclAmount: exclSum,
      taxAmount: taxSum,
      inclAmount: inclSum,
    },
  };
}

function escapeCsvCell(value: string): string {
  const escaped = value.replace(/"/g, '""');
  return `"${escaped}"`;
}

export async function exportSalesCsv(
  tx: DbExecutor,
  tenantId: string,
  filter: SalesListFilter,
): Promise<string> {
  const page = await listSalesSlips(tx, tenantId, { ...filter, page: 1, pageSize: 5000 });
  const header = [
    '区分',
    '伝票番号',
    '売上日',
    'ステータス',
    '承認状態',
    '取引先コード',
    '取引先名',
    '案件番号',
    '案件名',
    '件名',
    '税抜合計',
    '消費税合計',
    '税込合計',
  ]
    .map(escapeCsvCell)
    .join(',');

  const lines = page.items.map((item) =>
    [
      ENTRY_TYPE_LABELS[item.entryType],
      String(item.slipNo),
      item.slipDate,
      `${item.status}:${SALES_STATUS_LABELS[item.status]}`,
      APPROVAL_STATUS_LABELS[item.approvalStatus],
      item.partnerCode,
      item.partnerName,
      item.projectNo !== null ? String(item.projectNo) : '',
      item.projectName !== null ? item.projectName : '',
      item.slipName,
      String(item.subtotalAmount),
      String(item.taxTotal),
      String(item.totalAmount),
    ]
      .map(escapeCsvCell)
      .join(','),
  );

  return `\uFEFF${[header, ...lines].join('\r\n')}`;
}

export async function buildSalesListPdfInput(
  tx: DbExecutor,
  tenantId: string,
  filter: SalesListFilter,
): Promise<SalesListPdfInput> {
  const settingsRows = await tx.query<{ company_name: string }>(
    'SELECT company_name FROM tenant_settings WHERE tenant_id = $1::uuid LIMIT 1',
    [tenantId],
  );
  const companyName = settingsRows[0] !== undefined ? settingsRows[0].company_name : '自社';

  const page = await listSalesSlips(tx, tenantId, { ...filter, page: 1, pageSize: 5000 });
  const parts: string[] = [];
  if (optTrimmed(filter.keyword) !== null) parts.push(`検索:${optTrimmed(filter.keyword)}`);
  if (filter.status !== undefined && filter.status !== null) {
    parts.push(`状態:${SALES_STATUS_LABELS[filter.status]}`);
  }
  if (filter.approvalStatus !== undefined && filter.approvalStatus !== null) {
    parts.push(`承認:${APPROVAL_STATUS_LABELS[filter.approvalStatus]}`);
  }
  if (optTrimmed(filter.dateFrom) !== null || optTrimmed(filter.dateTo) !== null) {
    parts.push(`期間:${optTrimmed(filter.dateFrom) ?? ''}〜${optTrimmed(filter.dateTo) ?? ''}`);
  }

  const reportTitle =
    filter.entryType === 'ADVANCE' ? '立替金一覧表（立替伝票管理）' : '売上一覧表（売上伝票管理）';

  return {
    reportTitle,
    companyName,
    generatedDate: new Date().toISOString().slice(0, 10),
    filterSummary: parts.length > 0 ? parts.join(' / ') : '全件',
    items: page.items.map((item) => ({
      slipNo: item.slipNo,
      slipDate: item.slipDate,
      entryTypeLabel: ENTRY_TYPE_LABELS[item.entryType],
      statusLabel: `${item.status}:${SALES_STATUS_LABELS[item.status]}`,
      approvalLabel: APPROVAL_STATUS_LABELS[item.approvalStatus],
      partnerName: item.partnerName,
      slipName: item.slipName,
      projectName: item.projectName,
      subtotalAmount: item.subtotalAmount,
      taxTotal: item.taxTotal,
      totalAmount: item.totalAmount,
    })),
    totals: {
      count: page.summary.totalCount,
      subtotalAmount: page.summary.subtotalAmount,
      taxTotal: page.summary.taxTotal,
      totalAmount: page.summary.totalAmount,
    },
  };
}

export async function exportSalesProductSummaryCsv(
  tx: DbExecutor,
  tenantId: string,
  filter: SalesProductSummaryFilter = {},
): Promise<string> {
  const result = await getSalesProductSummary(tx, tenantId, filter);
  const header = [
    '区分',
    '商品コード',
    '品名・仕様',
    '単位',
    '税区分',
    '伝票数',
    '合計数量',
    '税抜金額',
    '消費税額',
    '税込金額',
  ]
    .map(escapeCsvCell)
    .join(',');

  const lines = result.items.map((item) =>
    [
      ENTRY_TYPE_LABELS[item.entryType],
      item.itemCode !== null ? item.itemCode : '',
      item.itemName,
      item.unitName !== null ? item.unitName : '',
      item.taxCode,
      String(item.slipCount),
      String(item.totalQuantity),
      String(item.exclAmount),
      String(item.taxAmount),
      String(item.inclAmount),
    ]
      .map(escapeCsvCell)
      .join(','),
  );

  return `\uFEFF${[header, ...lines].join('\r\n')}`;
}

export async function buildSalesProductSummaryPdfInput(
  tx: DbExecutor,
  tenantId: string,
  filter: SalesProductSummaryFilter = {},
): Promise<SalesProductSummaryPdfInput> {
  const settingsRows = await tx.query<{ company_name: string }>(
    'SELECT company_name FROM tenant_settings WHERE tenant_id = $1::uuid LIMIT 1',
    [tenantId],
  );
  const companyName = settingsRows[0] !== undefined ? settingsRows[0].company_name : '自社';

  const result = await getSalesProductSummary(tx, tenantId, filter);
  const parts: string[] = [];
  if (filter.entryTypeFilter === 'SALE') parts.push('区分:売上のみ');
  else if (filter.entryTypeFilter === 'ADVANCE') parts.push('区分:立替のみ');
  if (optTrimmed(filter.dateFrom) !== null || optTrimmed(filter.dateTo) !== null) {
    parts.push(`期間:${optTrimmed(filter.dateFrom) ?? ''}〜${optTrimmed(filter.dateTo) ?? ''}`);
  }
  if (optTrimmed(filter.keyword) !== null) parts.push(`品名:${optTrimmed(filter.keyword)}`);

  return {
    companyName,
    generatedDate: new Date().toISOString().slice(0, 10),
    filterSummary: parts.length > 0 ? parts.join(' / ') : '全件',
    items: result.items.map((item) => ({
      entryTypeLabel: ENTRY_TYPE_LABELS[item.entryType],
      itemCode: item.itemCode,
      itemName: item.itemName,
      unitName: item.unitName,
      taxCode: item.taxCode,
      slipCount: item.slipCount,
      totalQuantity: item.totalQuantity,
      exclAmount: item.exclAmount,
      taxAmount: item.taxAmount,
      inclAmount: item.inclAmount,
    })),
    totals: result.totals,
  };
}
