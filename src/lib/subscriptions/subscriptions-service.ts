import Decimal from 'decimal.js';
import {
  calculateSinglePartnerArBalance,
  getMonthStartAndEndDates,
  proposePaymentDueDate,
} from '@/lib/billing/ar-balance-service';
import { withBillingTransition, type DbExecutor } from '@/lib/db/tenant-client';
import {
  calculateInvoiceSummary,
  calculateSalesSlip,
  calculateSlipTotals,
  calculateSubscriptionContractLine,
  type LineCalcInput,
  type RoundingMode,
  type TaxCalcPolicy,
  type TaxCode,
} from '@/lib/domain/calculations';
import { getConsolidatedBaseLookups } from '@/lib/estimates/estimates-service';
import type { QuotationTemplateVariant } from '@/lib/estimates/types';
import { requireFeature } from '@/lib/feature-flags/gate';
import { mapPgConstraintError, MasterDataError } from '@/lib/masters/error-mapper';
import type { ApprovalStatus, SalesEntryType } from '@/lib/sales/types';
import { issueBillingSnapshot } from '@/lib/snapshots/snapshot-service';
import {
  SUBSCRIPTION_OUTPUT_TYPES,
  type ExecuteSubscriptionBillingInput,
  type ExecuteSubscriptionBillingResultDto,
  type SubscriptionBillingHistoryItemDto,
  type SubscriptionContractDto,
  type SubscriptionContractInput,
  type SubscriptionListResultDto,
  type SubscriptionLookupsDto,
  type SubscriptionMonthlyApprovalItemDto,
  type SubscriptionMonthlyApprovalResultDto,
  type SubscriptionOutputType,
  type SubscriptionPartnerMonthlySummary,
} from '@/lib/subscriptions/types';

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const TARGET_MONTH_REGEX = /^[0-9]{6}$/;
const VALID_ENTRY_TYPES = new Set<SalesEntryType>(['SALE', 'ADVANCE']);
const VALID_ROUNDING_MODES = new Set<RoundingMode>(['FLOOR', 'ROUND', 'CEIL']);
const VALID_TAX_CODES = new Set<TaxCode>(['A', 'B', 'C', 'D', 'E']);
const VALID_OUTPUT_TYPES = new Set<SubscriptionOutputType>(SUBSCRIPTION_OUTPUT_TYPES);

export interface SubscriptionListFilter {
  keyword?: string | null;
  partnerId?: string | null;
  entryType?: 'ALL' | SalesEntryType;
  activeFilter?: 'ALL' | 'ACTIVE' | 'INACTIVE';
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

export function validateTargetMonth(raw: string): string {
  const trimmed = raw.trim().replace(/-/g, '');
  if (!TARGET_MONTH_REGEX.test(trimmed)) {
    throw new MasterDataError(400, 'INVALID_TARGET_MONTH', '対象年月は YYYYMM 形式（例: 202606）で指定してください。');
  }
  const mm = Number(trimmed.slice(4, 6));
  if (mm < 1 || mm > 12) {
    throw new MasterDataError(400, 'INVALID_TARGET_MONTH', '対象年月の月は 01〜12 で指定してください。');
  }
  return trimmed;
}

interface CleanContractPayload {
  partnerId: string;
  entryType: SalesEntryType;
  subscSeqNo: number | null;
  productId: string | null;
  itemName: string;
  monthLabel: string | null;
  unitName: string | null;
  quantityStr: string;
  masterUnitPrice: number | null;
  appliedUnitPrice: number;
  taxCode: TaxCode;
  roundingMode: RoundingMode;
  outputType: SubscriptionOutputType;
  isActive: boolean;
}

function validateContractInput(input: SubscriptionContractInput): CleanContractPayload {
  validateUuid(input.partnerId, '取引先');
  if (!VALID_ENTRY_TYPES.has(input.entryType)) {
    throw new MasterDataError(400, 'INVALID_ENTRY_TYPE', '区分は SALE または ADVANCE を指定してください。');
  }

  let subscSeqNo: number | null = null;
  if (input.subscSeqNo !== undefined && input.subscSeqNo !== null) {
    if (!Number.isInteger(input.subscSeqNo) || input.subscSeqNo < 1 || input.subscSeqNo > 999999) {
      throw new MasterDataError(400, 'INVALID_SEQ_NO', '契約連番は1以上の整数で指定してください。');
    }
    subscSeqNo = input.subscSeqNo;
  }

  let productId: string | null = null;
  if (input.productId !== null && input.productId.trim() !== '') {
    validateUuid(input.productId.trim(), '商品');
    productId = input.productId.trim();
  }

  const itemName = input.itemName.trim();
  if (itemName.length === 0 || itemName.length > 300) {
    throw new MasterDataError(400, 'INVALID_ITEM_NAME', '品名は1〜300文字で入力してください。');
  }
  if (!Number.isFinite(input.quantity) || Math.abs(input.quantity) > 99_999_999) {
    throw new MasterDataError(400, 'INVALID_QUANTITY', '数量が不正です。');
  }
  const quantityStr = new Decimal(input.quantity).toDecimalPlaces(4, Decimal.ROUND_HALF_UP).toString();

  if (
    input.masterUnitPrice !== null &&
    (!Number.isInteger(input.masterUnitPrice) || Math.abs(input.masterUnitPrice) > 999_999_999_999)
  ) {
    throw new MasterDataError(400, 'INVALID_PRICE', '基準単価は整数円で入力してください。');
  }
  if (!Number.isInteger(input.appliedUnitPrice) || Math.abs(input.appliedUnitPrice) > 999_999_999_999) {
    throw new MasterDataError(400, 'INVALID_PRICE', '適用単価は整数円で入力してください。');
  }
  if (!VALID_TAX_CODES.has(input.taxCode)) {
    throw new MasterDataError(400, 'INVALID_TAX_CODE', '税区分は A〜E のいずれかを指定してください。');
  }
  if (!VALID_ROUNDING_MODES.has(input.roundingMode)) {
    throw new MasterDataError(400, 'INVALID_ROUNDING_MODE', '端数処理は FLOOR / ROUND / CEIL を指定してください。');
  }
  if (!VALID_OUTPUT_TYPES.has(input.outputType)) {
    throw new MasterDataError(400, 'INVALID_OUTPUT_TYPE', '出力方法は 印刷 / メール / PDF のいずれかを指定してください。');
  }

  return {
    partnerId: input.partnerId.trim(),
    entryType: input.entryType,
    subscSeqNo,
    productId,
    itemName,
    monthLabel: optTrimmed(input.monthLabel),
    unitName: optTrimmed(input.unitName),
    quantityStr,
    masterUnitPrice: input.masterUnitPrice,
    appliedUnitPrice: input.appliedUnitPrice,
    taxCode: input.taxCode,
    roundingMode: input.roundingMode,
    outputType: input.outputType,
    isActive: Boolean(input.isActive),
  };
}

interface ContractRow extends Record<string, unknown> {
  id: string;
  partner_id: string;
  partner_code: string;
  partner_name: string;
  entry_type: SalesEntryType;
  subsc_seq_no: number;
  product_id: string | null;
  product_code: string | null;
  item_name: string;
  month_label: string | null;
  unit_name: string | null;
  quantity: string;
  master_unit_price: string | null;
  applied_unit_price: string;
  tax_code: TaxCode;
  rounding_mode: RoundingMode;
  line_amount: string;
  line_tax: string;
  output_type: SubscriptionOutputType;
  is_active: boolean;
  created_at: string;
  updated_at: string;
}

function mapContractRow(row: ContractRow): SubscriptionContractDto {
  const calc = calculateSubscriptionContractLine({
    quantity: row.quantity,
    appliedUnitPrice: BigInt(row.applied_unit_price),
    taxCode: row.tax_code,
    roundingMode: row.rounding_mode,
  });

  return {
    id: row.id,
    partnerId: row.partner_id,
    partnerCode: row.partner_code,
    partnerName: row.partner_name,
    entryType: row.entry_type,
    subscSeqNo: Number(row.subsc_seq_no),
    productId: row.product_id,
    productCode: row.product_code,
    itemName: row.item_name,
    monthLabel: row.month_label,
    unitName: row.unit_name,
    quantity: Number(row.quantity),
    masterUnitPrice: row.master_unit_price !== null ? Number(row.master_unit_price) : null,
    appliedUnitPrice: Number(row.applied_unit_price),
    taxCode: row.tax_code,
    roundingMode: row.rounding_mode,
    lineAmount: Number(row.line_amount),
    lineTax: Number(row.line_tax),
    exclAmount: Number(calc.exclAmount),
    rowTotal: Number(calc.rowTotal),
    outputType: row.output_type,
    isActive: row.is_active,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export async function getSubscriptionLookups(
  tx: DbExecutor,
  tenantId: string,
): Promise<SubscriptionLookupsDto> {
  await requireFeature(tx, tenantId, 'fixedbill');
  const base = await getConsolidatedBaseLookups(tx, tenantId, {
    includeCatalog: true,
    includeClosingDays: false,
    includePaymentMethods: false,
  });
  return {
    approvalFlowEnabled: base.approvalFlowEnabled,
    openingBalanceDate: base.openingBalanceDate,
    defaultRoundingMode: base.defaultRoundingMode,
    taxCalcPolicy: base.taxCalcPolicy,
    quotationTemplateRows: base.quotationTemplateRows === 20 ? '20_ROWS' : '10_ROWS',
    partners: base.partners,
    products: base.products,
    units: base.units,
    taxCodes: base.taxCodes,
  };
}

export async function listSubscriptionContracts(
  tx: DbExecutor,
  tenantId: string,
  filter: SubscriptionListFilter = {},
): Promise<SubscriptionListResultDto> {
  await requireFeature(tx, tenantId, 'fixedbill');

  const kw = optTrimmed(filter.keyword);
  let partnerId: string | null = null;
  if (filter.partnerId !== undefined && filter.partnerId !== null && filter.partnerId.trim() !== '') {
    validateUuid(filter.partnerId.trim(), '取引先');
    partnerId = filter.partnerId.trim();
  }
  const entryType =
    filter.entryType === 'SALE' || filter.entryType === 'ADVANCE' ? filter.entryType : 'ALL';
  const activeFilter =
    filter.activeFilter === 'ACTIVE' || filter.activeFilter === 'INACTIVE'
      ? filter.activeFilter
      : 'ALL';

  const rows = await tx.query<ContractRow>(
    `SELECT sc.id, sc.partner_id, bp.partner_code, bp.partner_name,
            sc.entry_type::text AS entry_type, sc.subsc_seq_no,
            sc.product_id, pr.product_code, sc.item_name, sc.month_label,
            sc.unit_name, sc.quantity::text AS quantity,
            sc.master_unit_price::text AS master_unit_price,
            sc.applied_unit_price::text AS applied_unit_price,
            sc.tax_code, sc.rounding_mode::text AS rounding_mode,
            sc.line_amount::text AS line_amount, sc.line_tax::text AS line_tax,
            sc.output_type, sc.is_active,
            sc.created_at::text AS created_at, sc.updated_at::text AS updated_at
       FROM subscription_contracts sc
       JOIN business_partners bp ON bp.tenant_id = sc.tenant_id AND bp.id = sc.partner_id
       LEFT JOIN products pr ON pr.tenant_id = sc.tenant_id AND pr.id = sc.product_id
      WHERE (
        $1::text IS NULL
        OR bp.partner_name ILIKE '%' || $1 || '%'
        OR bp.partner_code ILIKE '%' || $1 || '%'
        OR sc.item_name ILIKE '%' || $1 || '%'
      )
      AND ($2::uuid IS NULL OR sc.partner_id = $2::uuid)
      AND ($3::text = 'ALL' OR sc.entry_type::text = $3)
      AND (
        $4::text = 'ALL'
        OR ($4::text = 'ACTIVE' AND sc.is_active = true)
        OR ($4::text = 'INACTIVE' AND sc.is_active = false)
      )
      ORDER BY bp.partner_code ASC, sc.entry_type ASC, sc.subsc_seq_no ASC`,
    [kw, partnerId, entryType, activeFilter],
  );

  const items = rows.map(mapContractRow);
  const summaryMap = new Map<string, SubscriptionPartnerMonthlySummary>();

  let activeContracts = 0;
  let activeSalesInclTotal = 0;
  let activeAdvanceInclTotal = 0;

  for (const item of items) {
    if (!item.isActive) continue;
    activeContracts += 1;

    let entry = summaryMap.get(item.partnerId);
    if (entry === undefined) {
      entry = {
        partnerId: item.partnerId,
        partnerCode: item.partnerCode,
        partnerName: item.partnerName,
        activeCount: 0,
        salesInclTotal: 0,
        advanceInclTotal: 0,
        combinedInclTotal: 0,
      };
      summaryMap.set(item.partnerId, entry);
    }
    entry.activeCount += 1;
    if (item.entryType === 'SALE') {
      entry.salesInclTotal += item.rowTotal;
      activeSalesInclTotal += item.rowTotal;
    } else {
      entry.advanceInclTotal += item.rowTotal;
      activeAdvanceInclTotal += item.rowTotal;
    }
    entry.combinedInclTotal = entry.salesInclTotal + entry.advanceInclTotal;
  }

  return {
    items,
    partnerSummaries: Array.from(summaryMap.values()),
    totals: {
      totalContracts: items.length,
      activeContracts,
      activeSalesInclTotal,
      activeAdvanceInclTotal,
      activeCombinedInclTotal: activeSalesInclTotal + activeAdvanceInclTotal,
    },
  };
}

async function assertContractReferences(
  tx: DbExecutor,
  clean: CleanContractPayload,
): Promise<void> {
  const pRows = await tx.query<{ id: string }>(
    'SELECT id FROM business_partners WHERE id = $1::uuid LIMIT 1',
    [clean.partnerId],
  );
  if (pRows.length === 0) {
    throw new MasterDataError(400, 'PARTNER_NOT_FOUND', '指定された取引先が見つかりません。');
  }
  if (clean.productId !== null) {
    const prodRows = await tx.query<{ id: string }>(
      'SELECT id FROM products WHERE id = $1::uuid LIMIT 1',
      [clean.productId],
    );
    if (prodRows.length === 0) {
      throw new MasterDataError(400, 'PRODUCT_NOT_FOUND', '指定された商品が見つかりません。');
    }
  }
}

async function getSubscriptionContractById(
  tx: DbExecutor,
  id: string,
): Promise<SubscriptionContractDto> {
  const rows = await tx.query<ContractRow>(
    `SELECT sc.id, sc.partner_id, bp.partner_code, bp.partner_name,
            sc.entry_type::text AS entry_type, sc.subsc_seq_no,
            sc.product_id, pr.product_code, sc.item_name, sc.month_label,
            sc.unit_name, sc.quantity::text AS quantity,
            sc.master_unit_price::text AS master_unit_price,
            sc.applied_unit_price::text AS applied_unit_price,
            sc.tax_code, sc.rounding_mode::text AS rounding_mode,
            sc.line_amount::text AS line_amount, sc.line_tax::text AS line_tax,
            sc.output_type, sc.is_active,
            sc.created_at::text AS created_at, sc.updated_at::text AS updated_at
       FROM subscription_contracts sc
       JOIN business_partners bp ON bp.tenant_id = sc.tenant_id AND bp.id = sc.partner_id
       LEFT JOIN products pr ON pr.tenant_id = sc.tenant_id AND pr.id = sc.product_id
      WHERE sc.id = $1::uuid
      LIMIT 1`,
    [id],
  );
  const row = rows[0];
  if (row === undefined) {
    throw new MasterDataError(404, 'CONTRACT_NOT_FOUND', '指定された定額契約が見つかりません。');
  }
  return mapContractRow(row);
}

export async function createSubscriptionContract(
  tx: DbExecutor,
  tenantId: string,
  input: SubscriptionContractInput,
): Promise<SubscriptionContractDto> {
  await requireFeature(tx, tenantId, 'fixedbill');
  const clean = validateContractInput(input);
  await assertContractReferences(tx, clean);

  // テナント排他ロック取得（連番自動採番競合防止）
  await tx.query('SELECT id FROM tenant_settings WHERE tenant_id = $1::uuid FOR UPDATE', [tenantId]);

  const calc = calculateSubscriptionContractLine({
    quantity: clean.quantityStr,
    appliedUnitPrice: BigInt(clean.appliedUnitPrice),
    taxCode: clean.taxCode,
    roundingMode: clean.roundingMode,
  });

  try {
    let seqNo = clean.subscSeqNo;
    if (seqNo === null) {
      const seqRows = await tx.query<{ next_seq: number }>(
        `SELECT COALESCE(MAX(subsc_seq_no), 0)::int + 1 AS next_seq
           FROM subscription_contracts
          WHERE partner_id = $1::uuid
            AND entry_type = $2::sales_entry_type`,
        [clean.partnerId, clean.entryType],
      );
      seqNo = seqRows[0] !== undefined ? Number(seqRows[0].next_seq) : 1;
    }

    const inserted = await tx.query<{ id: string }>(
      `INSERT INTO subscription_contracts (
         tenant_id, partner_id, entry_type, subsc_seq_no, product_id, item_name,
         month_label, unit_name, quantity, master_unit_price, applied_unit_price,
         tax_code, rounding_mode, line_amount, line_tax, output_type, is_active
       ) VALUES (
         $1::uuid, $2::uuid, $3::sales_entry_type, $4, $5::uuid, $6,
         $7, $8, $9::numeric, $10::numeric, $11::numeric,
         $12, $13::rounding_mode, $14::numeric, $15::numeric, $16, $17
       ) RETURNING id`,
      [
        tenantId,
        clean.partnerId,
        clean.entryType,
        seqNo,
        clean.productId,
        clean.itemName,
        clean.monthLabel,
        clean.unitName,
        clean.quantityStr,
        clean.masterUnitPrice !== null ? String(clean.masterUnitPrice) : null,
        String(clean.appliedUnitPrice),
        clean.taxCode,
        clean.roundingMode,
        calc.lineAmount.toString(),
        calc.lineTax.toString(),
        clean.outputType,
        clean.isActive,
      ],
    );

    const newId = inserted[0]?.id;
    if (newId === undefined) {
      throw new MasterDataError(500, 'INSERT_FAILED', '定額契約の登録結果を取得できませんでした。');
    }
    return getSubscriptionContractById(tx, newId);
  } catch (err) {
    throw mapPgConstraintError(err, {
      entityLabel: '定額契約',
      defaultUniqueMessage: '同一取引先・区分に同じ契約連番が既に登録されています。別の連番を指定してください。',
    });
  }
}

export async function updateSubscriptionContract(
  tx: DbExecutor,
  tenantId: string,
  id: string,
  input: SubscriptionContractInput,
): Promise<SubscriptionContractDto> {
  validateUuid(id, '定額契約');
  await requireFeature(tx, tenantId, 'fixedbill');
  const clean = validateContractInput(input);
  await assertContractReferences(tx, clean);

  const lockRows = await tx.query<{ id: string; subsc_seq_no: number }>(
    'SELECT id, subsc_seq_no FROM subscription_contracts WHERE id = $1::uuid FOR UPDATE',
    [id],
  );
  const existing = lockRows[0];
  if (existing === undefined) {
    throw new MasterDataError(404, 'CONTRACT_NOT_FOUND', '指定された定額契約が見つかりません。');
  }

  const seqNo = clean.subscSeqNo !== null ? clean.subscSeqNo : Number(existing.subsc_seq_no);
  const calc = calculateSubscriptionContractLine({
    quantity: clean.quantityStr,
    appliedUnitPrice: BigInt(clean.appliedUnitPrice),
    taxCode: clean.taxCode,
    roundingMode: clean.roundingMode,
  });

  try {
    await tx.query(
      `UPDATE subscription_contracts
          SET partner_id = $2::uuid,
              entry_type = $3::sales_entry_type,
              subsc_seq_no = $4,
              product_id = $5::uuid,
              item_name = $6,
              month_label = $7,
              unit_name = $8,
              quantity = $9::numeric,
              master_unit_price = $10::numeric,
              applied_unit_price = $11::numeric,
              tax_code = $12,
              rounding_mode = $13::rounding_mode,
              line_amount = $14::numeric,
              line_tax = $15::numeric,
              output_type = $16,
              is_active = $17
        WHERE id = $1::uuid`,
      [
        id,
        clean.partnerId,
        clean.entryType,
        seqNo,
        clean.productId,
        clean.itemName,
        clean.monthLabel,
        clean.unitName,
        clean.quantityStr,
        clean.masterUnitPrice !== null ? String(clean.masterUnitPrice) : null,
        String(clean.appliedUnitPrice),
        clean.taxCode,
        clean.roundingMode,
        calc.lineAmount.toString(),
        calc.lineTax.toString(),
        clean.outputType,
        clean.isActive,
      ],
    );
    return getSubscriptionContractById(tx, id);
  } catch (err) {
    throw mapPgConstraintError(err, {
      entityLabel: '定額契約',
      defaultUniqueMessage: '同一取引先・区分に同じ契約連番が既に登録されています。',
    });
  }
}

export async function deleteSubscriptionContract(
  tx: DbExecutor,
  tenantId: string,
  id: string,
): Promise<void> {
  validateUuid(id, '定額契約');
  await requireFeature(tx, tenantId, 'fixedbill');

  const delRows = await tx.query<{ id: string }>(
    'DELETE FROM subscription_contracts WHERE id = $1::uuid RETURNING id',
    [id],
  );
  if (delRows.length === 0) {
    throw new MasterDataError(404, 'CONTRACT_NOT_FOUND', '指定された定額契約が見つかりません。');
  }
}

export async function listMonthlyApprovalFlows(
  tx: DbExecutor,
  tenantId: string,
  rawTargetMonth: string,
  filter: { keyword?: string | null; entryType?: 'ALL' | SalesEntryType } = {},
): Promise<SubscriptionMonthlyApprovalResultDto> {
  await requireFeature(tx, tenantId, 'fixedbill');
  const targetMonth = validateTargetMonth(rawTargetMonth);
  const kw = optTrimmed(filter.keyword);
  const entryTypeFilter =
    filter.entryType === 'SALE' || filter.entryType === 'ADVANCE' ? filter.entryType : 'ALL';

  const settingsRows = await tx.query<{
    tax_calc_policy: TaxCalcPolicy;
    default_rounding_mode: RoundingMode;
  }>(
    `SELECT tax_calc_policy::text AS tax_calc_policy,
            default_rounding_mode::text AS default_rounding_mode
       FROM tenant_settings
      WHERE tenant_id = $1::uuid
      LIMIT 1`,
    [tenantId],
  );
  const taxCalcPolicy: TaxCalcPolicy =
    settingsRows[0] !== undefined ? settingsRows[0].tax_calc_policy : 'SLIP_BY_RATE';
  const defaultRoundingMode: RoundingMode =
    settingsRows[0] !== undefined ? settingsRows[0].default_rounding_mode : 'FLOOR';

  const contractRows = await tx.query<{
    partner_id: string;
    partner_code: string;
    partner_name: string;
    entry_type: SalesEntryType;
    subsc_seq_no: number;
    quantity: string;
    applied_unit_price: string;
    tax_code: TaxCode;
    rounding_mode: RoundingMode;
  }>(
    `SELECT sc.partner_id, bp.partner_code, bp.partner_name,
            sc.entry_type::text AS entry_type, sc.subsc_seq_no,
            sc.quantity::text AS quantity, sc.applied_unit_price::text AS applied_unit_price,
            sc.tax_code, sc.rounding_mode::text AS rounding_mode
       FROM subscription_contracts sc
       JOIN business_partners bp ON bp.tenant_id = sc.tenant_id AND bp.id = sc.partner_id
      WHERE sc.is_active = true
        AND (
          $1::text IS NULL
          OR bp.partner_name ILIKE '%' || $1 || '%'
          OR bp.partner_code ILIKE '%' || $1 || '%'
        )
        AND ($2::text = 'ALL' OR sc.entry_type::text = $2)
      ORDER BY bp.partner_code ASC, sc.entry_type ASC, sc.subsc_seq_no ASC`,
    [kw, entryTypeFilter],
  );

  const flowRows = await tx.query<{
    partner_id: string;
    entry_type: SalesEntryType;
    flow_status: number;
    remarks: string | null;
    updated_by_name: string | null;
    updated_at: string;
  }>(
    `SELECT saf.partner_id, saf.entry_type::text AS entry_type, saf.flow_status,
            saf.remarks, e.syain_name AS updated_by_name, saf.updated_at::text AS updated_at
       FROM subscription_approval_flows saf
       LEFT JOIN employees e ON e.tenant_id = saf.tenant_id AND e.id = saf.updated_by
      WHERE saf.target_month = $1`,
    [targetMonth],
  );
  const flowMap = new Map(flowRows.map((f) => [`${f.partner_id}:${f.entry_type}`, f]));

  const billedRows = await tx.query<{ partner_id: string; entry_type: SalesEntryType }>(
    `SELECT partner_id, entry_type::text AS entry_type
       FROM subscription_billings
      WHERE target_month = $1`,
    [targetMonth],
  );
  const billedSet = new Set(billedRows.map((b) => `${b.partner_id}:${b.entry_type}`));

  interface GroupBucket {
    partnerId: string;
    partnerCode: string;
    partnerName: string;
    entryType: SalesEntryType;
    roundingMode: RoundingMode;
    lines: LineCalcInput[];
  }
  const grouped = new Map<string, GroupBucket>();

  for (const r of contractRows) {
    const key = `${r.partner_id}:${r.entry_type}`;
    let bucket = grouped.get(key);
    if (bucket === undefined) {
      bucket = {
        partnerId: r.partner_id,
        partnerCode: r.partner_code,
        partnerName: r.partner_name,
        entryType: r.entry_type,
        roundingMode: r.rounding_mode !== undefined ? r.rounding_mode : defaultRoundingMode,
        lines: [],
      };
      grouped.set(key, bucket);
    }
    bucket.lines.push({
      lineNo: bucket.lines.length + 1,
      quantity: r.quantity,
      unitPrice: BigInt(r.applied_unit_price),
      taxCode: r.tax_code,
      roundingMode: bucket.roundingMode,
    });
  }

  const items: SubscriptionMonthlyApprovalItemDto[] = [];
  let approvedCount = 0;
  let pendingCount = 0;
  let rejectedCount = 0;
  let totalInclAmount = 0;

  for (const [key, bucket] of grouped.entries()) {
    const totals = calculateSlipTotals(bucket.lines, bucket.roundingMode, taxCalcPolicy);
    const flow = flowMap.get(key);
    const flowStatus: ApprovalStatus =
      flow !== undefined && (flow.flow_status === 1 || flow.flow_status === 2)
        ? flow.flow_status
        : 0;

    if (flowStatus === 1) approvedCount += 1;
    else if (flowStatus === 2) rejectedCount += 1;
    else pendingCount += 1;

    const totalIncl = Number(totals.totalIncl);
    totalInclAmount += totalIncl;

    items.push({
      partnerId: bucket.partnerId,
      partnerCode: bucket.partnerCode,
      partnerName: bucket.partnerName,
      entryType: bucket.entryType,
      targetMonth,
      activeContractCount: bucket.lines.length,
      subtotalExcl: Number(totals.subtotalExcl),
      taxTotal: Number(totals.taxTotal),
      totalIncl,
      flowStatus,
      remarks: flow !== undefined ? flow.remarks : null,
      updatedByName: flow !== undefined ? flow.updated_by_name : null,
      updatedAt: flow !== undefined ? flow.updated_at : null,
      isAlreadyBilled: billedSet.has(key),
    });
  }

  return {
    targetMonth,
    items,
    totals: {
      targetCount: items.length,
      approvedCount,
      pendingCount,
      rejectedCount,
      totalInclAmount,
    },
  };
}

export async function updateMonthlyApprovalFlows(
  tx: DbExecutor,
  tenantId: string,
  employeeId: string,
  input: {
    targetMonth: string;
    items: Array<{
      partnerId: string;
      entryType: SalesEntryType;
      flowStatus: ApprovalStatus;
      remarks?: string | null;
    }>;
  },
): Promise<{ updatedCount: number }> {
  await requireFeature(tx, tenantId, 'fixedbill');
  const targetMonth = validateTargetMonth(input.targetMonth);

  if (!Array.isArray(input.items) || input.items.length === 0) {
    throw new MasterDataError(400, 'ITEMS_REQUIRED', '更新対象の取引先明細を1件以上指定してください。');
  }

  for (const item of input.items) {
    validateUuid(item.partnerId, '取引先');
    if (!VALID_ENTRY_TYPES.has(item.entryType)) {
      throw new MasterDataError(400, 'INVALID_ENTRY_TYPE', '区分は SALE または ADVANCE を指定してください。');
    }
    if (item.flowStatus !== 0 && item.flowStatus !== 1 && item.flowStatus !== 2) {
      throw new MasterDataError(400, 'INVALID_FLOW_STATUS', '承認ステータスは 0 / 1 / 2 を指定してください。');
    }
  }

  try {
    for (const item of input.items) {
      const cleanRemarks = optTrimmed(item.remarks);
      await tx.query(
        `INSERT INTO subscription_approval_flows (
           tenant_id, partner_id, entry_type, target_month, flow_status, remarks, updated_by
         ) VALUES (
           $1::uuid, $2::uuid, $3::sales_entry_type, $4, $5::smallint, $6, $7::uuid
         )
         ON CONFLICT (tenant_id, partner_id, entry_type, target_month)
         DO UPDATE SET
           flow_status = EXCLUDED.flow_status,
           remarks = EXCLUDED.remarks,
           updated_by = EXCLUDED.updated_by`,
        [
          tenantId,
          item.partnerId,
          item.entryType,
          targetMonth,
          item.flowStatus,
          cleanRemarks,
          employeeId,
        ],
      );
    }
  } catch (err) {
    throw mapPgConstraintError(err, { entityLabel: '定額月次承認フロー' });
  }

  return { updatedCount: input.items.length };
}

const DATE_ONLY_REGEX = /^\d{4}-\d{2}-\d{2}$/;

function validateBillingDateStr(raw: string, label: string): string {
  const trimmed = raw.trim().slice(0, 10);
  if (!DATE_ONLY_REGEX.test(trimmed)) {
    throw new MasterDataError(400, 'INVALID_DATE', `${label}は YYYY-MM-DD 形式で指定してください。`);
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
    throw new MasterDataError(400, 'INVALID_DATE', `${label}の日付が不正です。`);
  }
  return trimmed;
}

export async function listSubscriptionBillings(
  tx: DbExecutor,
  tenantId: string,
  rawTargetMonth?: string | null,
): Promise<SubscriptionBillingHistoryItemDto[]> {
  await requireFeature(tx, tenantId, 'fixedbill');
  const targetMonth =
    rawTargetMonth !== undefined && rawTargetMonth !== null && rawTargetMonth.trim() !== ''
      ? validateTargetMonth(rawTargetMonth)
      : null;

  const rows = await tx.query<{
    id: string;
    partner_id: string;
    partner_code: string;
    partner_name: string;
    entry_type: SalesEntryType;
    target_month: string;
    billing_id: string | null;
    billing_no: string | null;
    billing_date: string;
    billed_amount: string;
    output_type: string;
    result_message: string;
    latest_snapshot_id: string | null;
    created_at: string;
  }>(
    `SELECT sb.id, sb.partner_id, bp.partner_code, bp.partner_name,
            sb.entry_type::text AS entry_type, sb.target_month,
            sb.billing_id, bh.billing_no::text AS billing_no,
            sb.billing_date::text AS billing_date,
            sb.billed_amount::text AS billed_amount,
            sb.output_type, sb.result_message,
            (SELECT ds.id FROM document_snapshots ds
              WHERE ds.source_entity_type = 'BILLING_HEADER'
                AND ds.source_entity_id = sb.billing_id
                AND ds.document_type = 'FIXED_INVOICE'
              ORDER BY ds.version_no DESC
              LIMIT 1) AS latest_snapshot_id,
            sb.created_at::text AS created_at
       FROM subscription_billings sb
       JOIN business_partners bp ON bp.tenant_id = sb.tenant_id AND bp.id = sb.partner_id
       LEFT JOIN billing_headers bh ON bh.tenant_id = sb.tenant_id AND bh.id = sb.billing_id
      WHERE ($1::text IS NULL OR sb.target_month = $1)
      ORDER BY sb.target_month DESC, bp.partner_code ASC, sb.entry_type ASC, sb.created_at DESC`,
    [targetMonth],
  );

  return rows.map((r) => ({
    id: r.id,
    partnerId: r.partner_id,
    partnerCode: r.partner_code,
    partnerName: r.partner_name,
    entryType: r.entry_type,
    targetMonth: r.target_month,
    billingId: r.billing_id,
    billingNo: r.billing_no !== null ? Number(r.billing_no) : null,
    billingDate: r.billing_date.slice(0, 10),
    billedAmount: Number(r.billed_amount),
    outputType: r.output_type,
    resultMessage: r.result_message,
    latestSnapshotId: r.latest_snapshot_id,
    createdAt: r.created_at,
  }));
}

/**
 * 定額サブスク一括請求確定（old Access バグ④是正：内税割り戻し・税抜内訳正確計算 + FIXED_INVOICE自動発行）
 */
export async function executeSubscriptionBilling(
  tx: DbExecutor,
  tenantId: string,
  employeeId: string,
  input: ExecuteSubscriptionBillingInput,
): Promise<ExecuteSubscriptionBillingResultDto> {
  await requireFeature(tx, tenantId, 'fixedbill');
  const targetMonth = validateTargetMonth(input.targetMonth);
  const billingDate = validateBillingDateStr(input.billingDate, '請求日');
  const explicitDueDate =
    input.paymentDueDate !== undefined &&
    input.paymentDueDate !== null &&
    input.paymentDueDate.trim() !== ''
      ? validateBillingDateStr(input.paymentDueDate, '支払期限')
      : null;

  const tsRows = await tx.query<{
    opening_balance_date: string;
    approval_flow_enabled: boolean;
    tax_calc_policy: TaxCalcPolicy;
    default_rounding_mode: RoundingMode;
    quotation_template_rows: number;
  }>(
    `SELECT opening_balance_date::text AS opening_balance_date,
            approval_flow_enabled,
            tax_calc_policy::text AS tax_calc_policy,
            default_rounding_mode::text AS default_rounding_mode,
            quotation_template_rows
       FROM tenant_settings
      WHERE tenant_id = $1::uuid
      FOR UPDATE`,
    [tenantId],
  );
  const settings = tsRows[0];
  if (settings === undefined) {
    throw new MasterDataError(404, 'TENANT_SETTINGS_NOT_FOUND', '自社設定が見つかりません。');
  }

  const openingBalanceDate = settings.opening_balance_date.slice(0, 10);
  if (billingDate <= openingBalanceDate) {
    throw new MasterDataError(
      400,
      'BILLING_DATE_BEFORE_CUTOFF',
      `請求日は期首残高基準日 (${openingBalanceDate}) より後の日付を指定してください。`,
    );
  }

  const { periodStart, periodEnd } = getMonthStartAndEndDates(targetMonth);

  const contractRows = await tx.query<{
    partner_id: string;
    partner_code: string;
    partner_name: string;
    is_individual_honorific: boolean;
    closing_day_code: string | null;
    collection_day_code: string | null;
    entry_type: SalesEntryType;
    subsc_seq_no: number;
    product_id: string | null;
    product_code: string | null;
    item_name: string;
    month_label: string | null;
    unit_name: string | null;
    quantity: string;
    master_unit_price: string | null;
    applied_unit_price: string;
    tax_code: TaxCode;
    rounding_mode: RoundingMode;
    output_type: SubscriptionOutputType;
  }>(
    `SELECT sc.partner_id, bp.partner_code, bp.partner_name,
            bp.is_individual_honorific, bp.closing_day_code, bp.collection_day_code,
            sc.entry_type::text AS entry_type, sc.subsc_seq_no,
            sc.product_id, pr.product_code, sc.item_name, sc.month_label,
            sc.unit_name, sc.quantity::text AS quantity,
            sc.master_unit_price::text AS master_unit_price,
            sc.applied_unit_price::text AS applied_unit_price,
            sc.tax_code, sc.rounding_mode::text AS rounding_mode, sc.output_type
       FROM subscription_contracts sc
       JOIN business_partners bp ON bp.tenant_id = sc.tenant_id AND bp.id = sc.partner_id
       LEFT JOIN products pr ON pr.tenant_id = sc.tenant_id AND pr.id = sc.product_id
      WHERE sc.is_active = true
      ORDER BY bp.partner_code ASC, sc.entry_type ASC, sc.subsc_seq_no ASC`,
    [],
  );

  interface ContractBucket {
    key: string;
    partnerId: string;
    partnerCode: string;
    partnerName: string;
    isIndividualHonorific: boolean;
    closingDayCode: string | null;
    collectionDayCode: string | null;
    entryType: SalesEntryType;
    roundingMode: RoundingMode;
    outputTypes: Set<SubscriptionOutputType>;
    contracts: typeof contractRows;
  }

  const bucketMap = new Map<string, ContractBucket>();
  for (const r of contractRows) {
    const key = `${r.partner_id}:${r.entry_type}`;
    const existing = bucketMap.get(key);
    if (existing !== undefined) {
      existing.contracts.push(r);
      existing.outputTypes.add(r.output_type);
    } else {
      bucketMap.set(key, {
        key,
        partnerId: r.partner_id,
        partnerCode: r.partner_code,
        partnerName: r.partner_name,
        isIndividualHonorific: r.is_individual_honorific,
        closingDayCode: r.closing_day_code,
        collectionDayCode: r.collection_day_code,
        entryType: r.entry_type,
        roundingMode: r.rounding_mode,
        outputTypes: new Set([r.output_type]),
        contracts: [r],
      });
    }
  }

  if (bucketMap.size === 0) {
    throw new MasterDataError(400, 'NO_ACTIVE_CONTRACTS', '稼働中の定額サブスク契約がありません。');
  }

  let requestedKeys: string[] | null = null;
  if (input.targets !== undefined) {
    if (!Array.isArray(input.targets) || input.targets.length === 0) {
      throw new MasterDataError(400, 'TARGETS_REQUIRED', '請求確定対象の取引先を指定してください。');
    }
    const keys: string[] = [];
    for (const t of input.targets) {
      validateUuid(t.partnerId, '取引先');
      if (!VALID_ENTRY_TYPES.has(t.entryType)) {
        throw new MasterDataError(400, 'INVALID_ENTRY_TYPE', '区分は SALE または ADVANCE を指定してください。');
      }
      const key = `${t.partnerId}:${t.entryType}`;
      if (!bucketMap.has(key)) {
        throw new MasterDataError(
          404,
          'CONTRACT_NOT_FOUND',
          '指定された取引先・区分の稼働中定額契約が見つかりません。',
        );
      }
      if (!keys.includes(key)) {
        keys.push(key);
      }
    }
    requestedKeys = keys;
  }

  const existingBilledRows = await tx.query<{ partner_id: string; entry_type: SalesEntryType }>(
    `SELECT partner_id, entry_type::text AS entry_type
       FROM subscription_billings
      WHERE target_month = $1`,
    [targetMonth],
  );
  const alreadyBilledSet = new Set(existingBilledRows.map((b) => `${b.partner_id}:${b.entry_type}`));

  const flowRows = await tx.query<{
    partner_id: string;
    entry_type: SalesEntryType;
    flow_status: number;
  }>(
    `SELECT partner_id, entry_type::text AS entry_type, flow_status
       FROM subscription_approval_flows
      WHERE target_month = $1`,
    [targetMonth],
  );
  const flowStatusMap = new Map(flowRows.map((f) => [`${f.partner_id}:${f.entry_type}`, f.flow_status]));

  const candidateBuckets: ContractBucket[] = [];
  if (requestedKeys !== null) {
    for (const key of requestedKeys) {
      if (alreadyBilledSet.has(key)) {
        throw new MasterDataError(
          409,
          'SUBSCRIPTION_ALREADY_BILLED',
          `対象年月 ${targetMonth} には既に定額請求確定済みの取引先が含まれています（二重請求禁止）。`,
        );
      }
      if (settings.approval_flow_enabled && flowStatusMap.get(key) !== 1) {
        throw new MasterDataError(
          409,
          'SUBSCRIPTION_NOT_APPROVED',
          '月次承認フローが有効なため、未承認・差戻しの対象は定額請求確定できません。',
        );
      }
      const bucket = bucketMap.get(key);
      if (bucket !== undefined) {
        candidateBuckets.push(bucket);
      }
    }
  } else {
    let anyUnbilledExists = false;
    for (const bucket of bucketMap.values()) {
      if (alreadyBilledSet.has(bucket.key)) {
        continue;
      }
      anyUnbilledExists = true;
      if (settings.approval_flow_enabled && flowStatusMap.get(bucket.key) !== 1) {
        continue;
      }
      candidateBuckets.push(bucket);
    }
    if (candidateBuckets.length === 0) {
      if (!anyUnbilledExists) {
        throw new MasterDataError(
          409,
          'SUBSCRIPTION_ALREADY_BILLED',
          `対象年月 ${targetMonth} の稼働中定額契約はすべて請求確定済みです（二重請求禁止）。`,
        );
      }
      throw new MasterDataError(
        409,
        'SUBSCRIPTION_NO_APPROVED_TARGETS',
        `対象年月 ${targetMonth} の承認済み定額対象がありません（月次承認フローで承認してください）。`,
      );
    }
  }

  const maxBillRows = await tx.query<{ max_no: string }>(
    'SELECT COALESCE(MAX(billing_no), 0)::text AS max_no FROM billing_headers',
    [],
  );
  let nextBillingNo = BigInt(maxBillRows[0] !== undefined ? maxBillRows[0].max_no : '0');

  const maxSlipRows = await tx.query<{ entry_type: SalesEntryType; max_no: string }>(
    `SELECT entry_type::text AS entry_type, COALESCE(MAX(slip_no), 0)::text AS max_no
       FROM sales_headers
      GROUP BY entry_type`,
    [],
  );
  const nextSlipByType = new Map<SalesEntryType, bigint>([
    ['SALE', 0n],
    ['ADVANCE', 0n],
  ]);
  for (const row of maxSlipRows) {
    nextSlipByType.set(row.entry_type, BigInt(row.max_no));
  }

  const templateVariant: QuotationTemplateVariant =
    input.templateVariant !== undefined
      ? input.templateVariant
      : settings.quotation_template_rows === 20
        ? '20_ROWS'
        : '10_ROWS';

  const yearDisplay = targetMonth.slice(0, 4);
  const monthDisplay = targetMonth.slice(4, 6);
  const createdIds: string[] = [];

  for (const bucket of candidateBuckets) {
    const slipInputs: LineCalcInput[] = bucket.contracts.map((c, idx) => ({
      lineNo: idx + 1,
      quantity: c.quantity,
      unitPrice: BigInt(c.applied_unit_price),
      taxCode: c.tax_code,
      roundingMode: bucket.roundingMode,
    }));

    const slipTotals = calculateSlipTotals(slipInputs, bucket.roundingMode, settings.tax_calc_policy);
    const salesCalc = calculateSalesSlip(
      bucket.contracts.map((c, idx) => ({
        lineNo: idx + 1,
        isHeading: false,
        quantity: c.quantity,
        appliedUnitPrice: BigInt(c.applied_unit_price),
        taxCode: c.tax_code,
      })),
      bucket.roundingMode,
      settings.tax_calc_policy,
    );

    const ar = await calculateSinglePartnerArBalance(tx, {
      tenantId,
      partnerId: bucket.partnerId,
      periodStart,
      periodEnd,
    });

    const inv = calculateInvoiceSummary({
      slips: [slipTotals],
      prevCarriedBalance: ar.prevCarriedBalance,
      periodReceiptAmount: ar.periodReceiptAmount,
      roundingMode: bucket.roundingMode,
      policy: settings.tax_calc_policy,
    });

    const paymentDueDate =
      explicitDueDate !== null
        ? explicitDueDate
        : proposePaymentDueDate(billingDate, bucket.closingDayCode, bucket.collectionDayCode);

    nextBillingNo += 1n;
    const prevSlipNo = nextSlipByType.get(bucket.entryType);
    const nextSlipNo = (prevSlipNo !== undefined ? prevSlipNo : 0n) + 1n;
    nextSlipByType.set(bucket.entryType, nextSlipNo);

    const honorific = bucket.isIndividualHonorific ? '様' : '御中';
    const salesKubun = bucket.entryType === 'ADVANCE' ? '立替金' : '定額';
    const slipName = `${yearDisplay}年${monthDisplay}月 定額請求（${
      bucket.entryType === 'ADVANCE' ? '立替金' : '通常売上'
    }）`;

    let billingId: string;
    try {
      const bInsRows = await tx.query<{ id: string }>(
        `INSERT INTO billing_headers (
           tenant_id, billing_no, partner_id, billing_date,
           target_period_start, target_period_end, payment_due_date,
           is_subscription_bill, tax_calc_policy, rounding_mode,
           amount_10_excl, amount_8_excl, amount_0_non_tax,
           tax_10_amount, tax_8_amount, tax_adjustment_amount,
           tax_total, billing_amount,
           prev_carried_balance, period_receipt_amount, net_carried_balance, closing_ar_balance,
           status, created_by, updated_by
         ) VALUES (
           $1::uuid, $2::bigint, $3::uuid, $4::date,
           $5::date, $6::date, $7::date,
           true, $8::tax_calc_policy, $9::rounding_mode,
           $10::numeric, $11::numeric, $12::numeric,
           $13::numeric, $14::numeric, $15::numeric,
           $16::numeric, $17::numeric,
           $18::numeric, $19::numeric, $20::numeric, $21::numeric,
           'N1'::receivable_status, $22::uuid, $22::uuid
         )
         RETURNING id`,
        [
          tenantId,
          nextBillingNo.toString(),
          bucket.partnerId,
          billingDate,
          periodStart,
          periodEnd,
          paymentDueDate,
          settings.tax_calc_policy,
          bucket.roundingMode,
          inv.amount10Excl.toString(),
          inv.amount8Excl.toString(),
          inv.amount0NonTax.toString(),
          inv.tax10Amount.toString(),
          inv.tax8Amount.toString(),
          inv.taxAdjustmentAmount.toString(),
          inv.taxTotal.toString(),
          inv.billingAmount.toString(),
          inv.prevCarriedBalance.toString(),
          inv.periodReceiptAmount.toString(),
          inv.netCarriedBalance.toString(),
          inv.closingArBalance.toString(),
          employeeId,
        ],
      );
      const insertedB = bInsRows[0];
      if (insertedB === undefined) {
        throw new MasterDataError(500, 'BILLING_INSERT_FAILED', '定額請求ヘッダの登録に失敗しました。');
      }
      billingId = insertedB.id;

      // trg_lock_billed_sales_lines は親が K4/K5 時の INSERT を検査するため withBillingTransition 内で実行
      await withBillingTransition(tx, async () => {
        const sInsRows = await tx.query<{ id: string }>(
          `INSERT INTO sales_headers (
             tenant_id, entry_type, slip_no, slip_name, slip_date,
             partner_id, project_id, honorific, status,
             approval_status, approval_remarks, sales_kubun,
             billing_id, billing_date, rounding_mode,
             subtotal_amount, tax_total, total_amount,
             created_by, updated_by
           ) VALUES (
             $1::uuid, $2::sales_entry_type, $3::bigint, $4, $5::date,
             $6::uuid, NULL, $7, 'K4'::sales_status,
             1, $8, $9,
             $10::uuid, $5::date, $11::rounding_mode,
             $12::numeric, $13::numeric, $14::numeric,
             $15::uuid, $15::uuid
           )
           RETURNING id`,
          [
            tenantId,
            bucket.entryType,
            nextSlipNo.toString(),
            slipName,
            billingDate,
            bucket.partnerId,
            honorific,
            `${targetMonth} 定額一括請求確定による自動作成`,
            salesKubun,
            billingId,
            bucket.roundingMode,
            salesCalc.subtotalAmount.toString(),
            salesCalc.taxTotal.toString(),
            salesCalc.totalAmount.toString(),
            employeeId,
          ],
        );
        const insertedS = sInsRows[0];
        if (insertedS === undefined) {
          throw new MasterDataError(500, 'SALES_INSERT_FAILED', '定額売上伝票の自動作成に失敗しました。');
        }

        for (let i = 0; i < bucket.contracts.length; i += 1) {
          const c = bucket.contracts[i];
          const lr = salesCalc.lineResults[i];
          if (c === undefined || lr === undefined) continue;
          await tx.query(
            `INSERT INTO sales_lines (
               tenant_id, sales_header_id, line_no,
               product_id, item_code, item_name, unit_name, target_month_label,
               is_heading, quantity, master_unit_price, applied_unit_price,
               tax_code, line_amount, line_tax, row_total, remarks
             ) VALUES (
               $1::uuid, $2::uuid, $3,
               $4::uuid, $5, $6, $7, $8,
               false, $9::numeric, $10::numeric, $11::numeric,
               $12, $13::numeric, $14::numeric, $15::numeric, NULL
             )`,
            [
              tenantId,
              insertedS.id,
              i + 1,
              c.product_id,
              c.product_code,
              c.item_name,
              c.unit_name,
              c.month_label,
              c.quantity,
              c.master_unit_price,
              c.applied_unit_price,
              c.tax_code,
              lr.lineAmount.toString(),
              lr.lineTax.toString(),
              lr.rowTotal.toString(),
            ],
          );
        }
      });

      const outputTypeLabel = Array.from(bucket.outputTypes).join('/');
      const resultMessage = `定額請求確定完了（請求No.${nextBillingNo.toString()} / 売上No.${nextSlipNo.toString()}）`;
      const sbIns = await tx.query<{ id: string }>(
        `INSERT INTO subscription_billings (
           tenant_id, partner_id, entry_type, target_month,
           billing_id, billing_date, billed_amount, output_type, result_message
         ) VALUES (
           $1::uuid, $2::uuid, $3::sales_entry_type, $4,
           $5::uuid, $6::date, $7::numeric, $8, $9
         )
         RETURNING id`,
        [
          tenantId,
          bucket.partnerId,
          bucket.entryType,
          targetMonth,
          billingId,
          billingDate,
          inv.billingAmount.toString(),
          outputTypeLabel,
          resultMessage,
        ],
      );
      if (sbIns[0] !== undefined) {
        createdIds.push(sbIns[0].id);
      }

      await issueBillingSnapshot(tx, {
        tenantId,
        employeeId,
        billingId,
        documentType: 'FIXED_INVOICE',
        templateVariant,
        issueDate: billingDate,
        forceReissue: false,
      });
    } catch (err) {
      if (err instanceof MasterDataError) {
        throw err;
      }
      throw mapPgConstraintError(err, { entityLabel: '定額一括請求' });
    }
  }

  const allForMonth = await listSubscriptionBillings(tx, tenantId, targetMonth);
  const items = allForMonth.filter((item) => createdIds.includes(item.id));
  return {
    targetMonth,
    executedCount: items.length,
    items,
  };
}
