import { calculatePartnersArBalances } from '@/lib/billing/ar-balance-service';
import { RECEIVABLE_STATUS_LABELS, type ReceivableStatus } from '@/lib/billing/types';
import type { DbExecutor } from '@/lib/db/tenant-client';
import type { ReceivableListPdfInput } from '@/lib/domain/pdf-renderer';
import { getConsolidatedBaseLookups } from '@/lib/estimates/estimates-service';
import type { SnapshotHistoryItemDto } from '@/lib/estimates/types';
import { isFeatureEnabled, requireFeature } from '@/lib/feature-flags/gate';
import { mapPgConstraintError, MasterDataError } from '@/lib/masters/error-mapper';
import type {
  CashReceiptDetailDto,
  CashReceiptDto,
  CashReceiptInput,
  CashReceiptListFilter,
  CashReceiptPageDto,
  ReceivableBalanceFilter,
  ReceivableBalanceItemDto,
  ReceivableBalanceListResultDto,
  ReceivablesLookupsDto,
  UnpaidBillingItemDto,
} from '@/lib/receivables/types';

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DATE_REGEX = /^\d{4}-\d{2}-\d{2}$/;
const DIGITS_ONLY_REGEX = /^\d+$/;
const VALID_RECEIVABLE_STATUSES = new Set<ReceivableStatus>(['N1', 'N2', 'N3', 'N4']);

function validateUuid(id: string, label: string): void {
  if (!UUID_REGEX.test(id)) {
    throw new MasterDataError(400, 'INVALID_ID', `${label}IDの形式が不正です。`);
  }
}

function validateDateOnly(raw: string, label: string): string {
  const trimmed = raw.trim().slice(0, 10);
  if (!DATE_REGEX.test(trimmed)) {
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
    throw new MasterDataError(400, 'INVALID_DATE', `${label}の日付が存在しません。`);
  }
  return trimmed;
}

function addOneDayIso(dateStr: string): string {
  const parts = dateStr.split('-');
  const y = Number(parts[0]);
  const m = Number(parts[1]);
  const d = Number(parts[2]);
  const next = new Date(Date.UTC(y, m - 1, d + 1));
  return next.toISOString().slice(0, 10);
}

function defaultPeriodAfterCutoff(openingBalanceDate: string): {
  periodStart: string;
  periodEnd: string;
} {
  const now = new Date();
  const y = now.getUTCFullYear();
  const m = now.getUTCMonth() + 1;
  const lastDay = new Date(Date.UTC(y, m, 0)).getUTCDate();
  const yStr = String(y).padStart(4, '0');
  const mStr = String(m).padStart(2, '0');
  const monthStart = `${yStr}-${mStr}-01`;
  const monthEnd = `${yStr}-${mStr}-${String(lastDay).padStart(2, '0')}`;

  if (monthStart > openingBalanceDate) {
    return { periodStart: monthStart, periodEnd: monthEnd };
  }
  const nextDay = addOneDayIso(openingBalanceDate);
  const nextParts = nextDay.split('-');
  const ny = Number(nextParts[0]);
  const nm = Number(nextParts[1]);
  const nLastDay = new Date(Date.UTC(ny, nm, 0)).getUTCDate();
  return {
    periodStart: nextDay,
    periodEnd: `${String(ny).padStart(4, '0')}-${String(nm).padStart(2, '0')}-${String(nLastDay).padStart(2, '0')}`,
  };
}

function optTrimmed(raw: string | null | undefined): string | null {
  if (raw === undefined || raw === null) {
    return null;
  }
  const t = raw.trim();
  return t === '' ? null : t;
}

function escapeCsvCell(value: string): string {
  const escaped = value.replace(/"/g, '""');
  return `"${escaped}"`;
}

async function requireAnyReceivablesReadFeature(tx: DbExecutor, tenantId: string): Promise<void> {
  const [recOk, depOk] = await Promise.all([
    isFeatureEnabled(tx, tenantId, 'receivable'),
    isFeatureEnabled(tx, tenantId, 'deposit'),
  ]);
  if (!recOk && !depOk) {
    await requireFeature(tx, tenantId, 'receivable');
  }
}

export async function getReceivablesLookups(
  tx: DbExecutor,
  tenantId: string,
): Promise<ReceivablesLookupsDto> {
  const base = await getConsolidatedBaseLookups(tx, tenantId, {
    includeCatalog: false,
    includeClosingDays: true,
    includePaymentMethods: true,
  });
  const [receivableEnabled, depositEnabled, aplusEnabled] = await Promise.all([
    isFeatureEnabled(tx, tenantId, 'receivable'),
    isFeatureEnabled(tx, tenantId, 'deposit'),
    isFeatureEnabled(tx, tenantId, 'aplus'),
  ]);

  return {
    openingBalanceDate: base.openingBalanceDate,
    defaultArListDateMode: base.defaultArListDateMode,
    receivableEnabled,
    depositEnabled,
    aplusEnabled,
    partners: base.partners,
    projects: base.projects,
    paymentMethods: base.paymentMethods,
    closingDays: base.closingDays,
  };
}

/**
 * 売掛残高一覧集計（旧 rp_売掛一覧：ar-balance-service.ts 共用）
 * - periodStart > opening_balance_date を検証
 */
export async function listReceivableBalances(
  tx: DbExecutor,
  tenantId: string,
  filter: ReceivableBalanceFilter = {},
): Promise<ReceivableBalanceListResultDto> {
  await requireFeature(tx, tenantId, 'receivable');

  const tsRows = await tx.query<{ opening_balance_date: string }>(
    `SELECT opening_balance_date::text AS opening_balance_date
       FROM tenant_settings
      WHERE tenant_id = $1::uuid
      LIMIT 1`,
    [tenantId],
  );
  const ts = tsRows[0];
  if (ts === undefined) {
    throw new MasterDataError(404, 'TENANT_SETTINGS_NOT_FOUND', '自社設定が見つかりません。');
  }
  const openingBalanceDate = ts.opening_balance_date.slice(0, 10);
  const def = defaultPeriodAfterCutoff(openingBalanceDate);

  const rawStart = optTrimmed(filter.periodStart);
  const rawEnd = optTrimmed(filter.periodEnd);
  const periodStart = rawStart !== null ? validateDateOnly(rawStart, '集計期間開始日') : def.periodStart;
  const periodEnd = rawEnd !== null ? validateDateOnly(rawEnd, '集計期間終了日') : def.periodEnd;

  if (periodStart <= openingBalanceDate) {
    throw new MasterDataError(
      400,
      'PERIOD_START_BEFORE_CUTOFF',
      `売掛集計の開始日は期首残高基準日 (${openingBalanceDate}) より後の日付を指定してください。`,
    );
  }
  if (periodStart > periodEnd) {
    throw new MasterDataError(
      400,
      'INVALID_PERIOD_RANGE',
      '集計期間開始日は終了日以前を指定してください。',
    );
  }

  const closingDayCode = optTrimmed(filter.closingDayCode);
  const rawPartnerId = optTrimmed(filter.partnerId);
  if (rawPartnerId !== null) {
    validateUuid(rawPartnerId, '取引先');
  }
  const kw = optTrimmed(filter.keyword);

  const partnerRows = await tx.query<{
    id: string;
    partner_code: string;
    partner_name: string;
    closing_day_code: string | null;
    closing_day_name: string | null;
  }>(
    `SELECT bp.id, bp.partner_code, bp.partner_name, bp.closing_day_code,
            cm.name AS closing_day_name
       FROM business_partners bp
       LEFT JOIN code_masters cm
         ON cm.tenant_id = bp.tenant_id
        AND cm.domain_key = 'BILL_CLOSE'
        AND cm.code = bp.closing_day_code
      WHERE bp.is_deleted = false
        AND (bp.is_client = true OR bp.opening_ar_balance <> 0)
        AND ($1::text IS NULL OR bp.closing_day_code = $1)
        AND ($2::uuid IS NULL OR bp.id = $2::uuid)
        AND (
          $3::text IS NULL
          OR bp.partner_code ILIKE '%' || $3 || '%'
          OR bp.partner_name ILIKE '%' || $3 || '%'
        )
      ORDER BY bp.partner_code ASC`,
    [closingDayCode, rawPartnerId, kw],
  );

  if (partnerRows.length === 0) {
    return {
      openingBalanceDate,
      periodStart,
      periodEnd,
      items: [],
      totals: {
        partnerCount: 0,
        prevCarriedBalance: 0,
        periodBillingExcl: 0,
        periodBillingTax: 0,
        periodBillingIncl: 0,
        periodReceiptAmount: 0,
        periodNetDelta: 0,
        closingArBalance: 0,
      },
    };
  }

  const partnerIds = partnerRows.map((p) => p.id);
  const arMap = await calculatePartnersArBalances(tx, {
    tenantId,
    partnerIds,
    periodStart,
    periodEnd,
  });

  const periodBillRows = await tx.query<{
    partner_id: string;
    sum_excl: string;
    sum_tax: string;
    sum_incl: string;
  }>(
    `SELECT partner_id,
            COALESCE(SUM(billing_amount - tax_total), 0)::text AS sum_excl,
            COALESCE(SUM(tax_total), 0)::text AS sum_tax,
            COALESCE(SUM(billing_amount), 0)::text AS sum_incl
       FROM billing_headers
      WHERE partner_id = ANY($1::uuid[])
        AND billing_date >= $2::date
        AND billing_date <= $3::date
      GROUP BY partner_id`,
    [partnerIds, periodStart, periodEnd],
  );
  const billBreakMap = new Map(
    periodBillRows.map((b) => [
      b.partner_id,
      {
        excl: Number(b.sum_excl),
        tax: Number(b.sum_tax),
        incl: Number(b.sum_incl),
      },
    ]),
  );

  const items: ReceivableBalanceItemDto[] = [];
  let sumPrevCarried = 0;
  let sumBillExcl = 0;
  let sumBillTax = 0;
  let sumBillIncl = 0;
  let sumReceipt = 0;
  let sumDelta = 0;
  let sumClosing = 0;

  for (const p of partnerRows) {
    const ar = arMap.get(p.id);
    if (ar === undefined) continue;
    const brk = billBreakMap.get(p.id);

    const prevCarriedBalance = Number(ar.prevCarriedBalance);
    const periodBillingExcl = brk !== undefined ? brk.excl : 0;
    const periodBillingTax = brk !== undefined ? brk.tax : 0;
    const periodBillingIncl = Number(ar.inPeriodBillings);
    const periodReceiptAmount = Number(ar.periodReceiptAmount);
    const periodNetDelta = periodBillingIncl - periodReceiptAmount;
    const closingArBalance = Number(ar.closingBalanceExisting);

    if (
      filter.onlyWithBalance === true &&
      prevCarriedBalance === 0 &&
      periodBillingIncl === 0 &&
      periodReceiptAmount === 0 &&
      closingArBalance === 0
    ) {
      continue;
    }

    sumPrevCarried += prevCarriedBalance;
    sumBillExcl += periodBillingExcl;
    sumBillTax += periodBillingTax;
    sumBillIncl += periodBillingIncl;
    sumReceipt += periodReceiptAmount;
    sumDelta += periodNetDelta;
    sumClosing += closingArBalance;

    items.push({
      partnerId: p.id,
      partnerCode: p.partner_code,
      partnerName: p.partner_name,
      closingDayCode: p.closing_day_code,
      closingDayName: p.closing_day_name,
      openingArBalance: Number(ar.openingArBalance),
      prevCarriedBalance,
      periodBillingExcl,
      periodBillingTax,
      periodBillingIncl,
      periodReceiptAmount,
      periodNetDelta,
      closingArBalance,
    });
  }

  return {
    openingBalanceDate,
    periodStart,
    periodEnd,
    items,
    totals: {
      partnerCount: items.length,
      prevCarriedBalance: sumPrevCarried,
      periodBillingExcl: sumBillExcl,
      periodBillingTax: sumBillTax,
      periodBillingIncl: sumBillIncl,
      periodReceiptAmount: sumReceipt,
      periodNetDelta: sumDelta,
      closingArBalance: sumClosing,
    },
  };
}

export async function exportReceivableBalancesCsv(
  tx: DbExecutor,
  tenantId: string,
  filter: ReceivableBalanceFilter,
): Promise<string> {
  const result = await listReceivableBalances(tx, tenantId, filter);
  const header = [
    '取引先コード',
    '取引先名',
    '締日',
    '期首売掛基準残高',
    '前回繰越残高',
    '当期請求(税抜)',
    '当期消費税',
    '当期請求(税込)',
    '当期入金額',
    '当期増減',
    '当期末売掛残高',
  ]
    .map(escapeCsvCell)
    .join(',');

  const lines = result.items.map((item) =>
    [
      item.partnerCode,
      item.partnerName,
      item.closingDayName !== null ? item.closingDayName : '',
      String(item.openingArBalance),
      String(item.prevCarriedBalance),
      String(item.periodBillingExcl),
      String(item.periodBillingTax),
      String(item.periodBillingIncl),
      String(item.periodReceiptAmount),
      String(item.periodNetDelta),
      String(item.closingArBalance),
    ]
      .map(escapeCsvCell)
      .join(','),
  );

  return `\uFEFF${[header, ...lines].join('\r\n')}`;
}

export async function buildReceivableBalancesPdfInput(
  tx: DbExecutor,
  tenantId: string,
  filter: ReceivableBalanceFilter,
): Promise<ReceivableListPdfInput> {
  const result = await listReceivableBalances(tx, tenantId, filter);
  const settingsRows = await tx.query<{ company_name: string }>(
    'SELECT company_name FROM tenant_settings WHERE tenant_id = $1::uuid LIMIT 1',
    [tenantId],
  );
  const companyName = settingsRows[0] !== undefined ? settingsRows[0].company_name : '自社';

  return {
    companyName,
    generatedDate: new Date().toISOString().slice(0, 10),
    filterSummary: `期間:${result.periodStart}〜${result.periodEnd}`,
    items: result.items.map((i) => ({
      partnerCode: i.partnerCode,
      partnerName: i.partnerName,
      closingDayName: i.closingDayName,
      prevCarriedBalance: i.prevCarriedBalance,
      periodBillingExcl: i.periodBillingExcl,
      periodBillingTax: i.periodBillingTax,
      periodBillingIncl: i.periodBillingIncl,
      periodReceiptAmount: i.periodReceiptAmount,
      periodNetDelta: i.periodNetDelta,
      closingArBalance: i.closingArBalance,
    })),
    totals: {
      count: result.totals.partnerCount,
      prevCarriedBalance: result.totals.prevCarriedBalance,
      periodBillingExcl: result.totals.periodBillingExcl,
      periodBillingTax: result.totals.periodBillingTax,
      periodBillingIncl: result.totals.periodBillingIncl,
      periodReceiptAmount: result.totals.periodReceiptAmount,
      periodNetDelta: result.totals.periodNetDelta,
      closingArBalance: result.totals.closingArBalance,
    },
  };
}

/**
 * 請求書番号指定に基づく請求消込ステータス自動連動（cash_receipts -> billing_headers）
 * - P <= 0 => N1 (未入金), received_at = NULL
 * - 0 < P < B => N2 (一部入金), received_at = 最新入金日
 * - P = B => N3 (入金済), received_at = 最新入金日
 * - P > B => N4 (過入金), received_at = 最新入金日
 */
export async function syncBillingSettlementByBillNo(
  tx: DbExecutor,
  employeeId: string,
  partnerId: string,
  billNo: string | null,
): Promise<ReceivableStatus | null> {
  if (billNo === null) {
    return null;
  }
  const trimmed = billNo.trim();
  if (!DIGITS_ONLY_REGEX.test(trimmed)) {
    return null;
  }

  const bRows = await tx.query<{
    id: string;
    billing_amount: string;
  }>(
    `SELECT id, billing_amount::text AS billing_amount
       FROM billing_headers
      WHERE partner_id = $1::uuid
        AND billing_no = $2::bigint
      FOR UPDATE`,
    [partnerId, trimmed],
  );
  const billing = bRows[0];
  if (billing === undefined) {
    return null;
  }

  const aggRows = await tx.query<{
    sum_deposit: string;
    latest_date: string | null;
  }>(
    `SELECT COALESCE(SUM(total_deposit), 0)::text AS sum_deposit,
            MAX(receipt_date)::text AS latest_date
       FROM cash_receipts
      WHERE partner_id = $1::uuid
        AND bill_no = $2`,
    [partnerId, trimmed],
  );
  const agg = aggRows[0];
  const paid = BigInt(agg !== undefined ? agg.sum_deposit : '0');
  const billed = BigInt(billing.billing_amount);
  const latestDate = agg !== undefined && agg.latest_date !== null ? agg.latest_date.slice(0, 10) : null;

  let nextStatus: ReceivableStatus = 'N1';
  let nextReceivedAt: string | null = null;
  if (paid <= 0n) {
    nextStatus = 'N1';
    nextReceivedAt = null;
  } else if (paid < billed) {
    nextStatus = 'N2';
    nextReceivedAt = latestDate;
  } else if (paid === billed) {
    nextStatus = 'N3';
    nextReceivedAt = latestDate;
  } else {
    nextStatus = 'N4';
    nextReceivedAt = latestDate;
  }

  await tx.query(
    `UPDATE billing_headers
        SET status = $2::receivable_status,
            received_at = $3::date,
            updated_by = $4::uuid
      WHERE id = $1::uuid`,
    [billing.id, nextStatus, nextReceivedAt, employeeId],
  );

  return nextStatus;
}

export async function listUnpaidBillings(
  tx: DbExecutor,
  tenantId: string,
  filter: {
    partnerId?: string | null;
    status?: ReceivableStatus | null;
    keyword?: string | null;
    unpaidOnly?: boolean;
  } = {},
): Promise<UnpaidBillingItemDto[]> {
  await requireAnyReceivablesReadFeature(tx, tenantId);
  const rawPartner = optTrimmed(filter.partnerId);
  if (rawPartner !== null) {
    validateUuid(rawPartner, '取引先');
  }
  const status =
    filter.status !== undefined && filter.status !== null && VALID_RECEIVABLE_STATUSES.has(filter.status)
      ? filter.status
      : null;
  const kw = optTrimmed(filter.keyword);
  const unpaidOnly = filter.unpaidOnly === true;

  const rows = await tx.query<{
    id: string;
    billing_no: string;
    partner_id: string;
    partner_code: string;
    partner_name: string;
    billing_date: string;
    payment_due_date: string | null;
    is_subscription_bill: boolean;
    billing_amount: string;
    settled_amount: string;
    receipt_count: number;
    received_at: string | null;
    status: ReceivableStatus;
  }>(
    `SELECT bh.id, bh.billing_no::text AS billing_no, bh.partner_id,
            bp.partner_code, bp.partner_name,
            bh.billing_date::text AS billing_date,
            bh.payment_due_date::text AS payment_due_date,
            bh.is_subscription_bill,
            bh.billing_amount::text AS billing_amount,
            COALESCE((
              SELECT SUM(cr.total_deposit)
                FROM cash_receipts cr
               WHERE cr.tenant_id = bh.tenant_id
                 AND cr.partner_id = bh.partner_id
                 AND cr.bill_no = bh.billing_no::text
            ), 0)::text AS settled_amount,
            COALESCE((
              SELECT COUNT(*)::int
                FROM cash_receipts cr
               WHERE cr.tenant_id = bh.tenant_id
                 AND cr.partner_id = bh.partner_id
                 AND cr.bill_no = bh.billing_no::text
            ), 0) AS receipt_count,
            bh.received_at::text AS received_at,
            bh.status::text AS status
       FROM billing_headers bh
       JOIN business_partners bp ON bp.tenant_id = bh.tenant_id AND bp.id = bh.partner_id
      WHERE ($1::uuid IS NULL OR bh.partner_id = $1::uuid)
        AND ($2::text IS NULL OR bh.status::text = $2)
        AND (
          $3::text IS NULL
          OR CAST(bh.billing_no AS text) ILIKE '%' || $3 || '%'
          OR bp.partner_name ILIKE '%' || $3 || '%'
          OR bp.partner_code ILIKE '%' || $3 || '%'
        )
        AND ($4::boolean = false OR bh.status IN ('N1', 'N2'))
      ORDER BY bh.billing_date DESC, bh.billing_no DESC
      LIMIT 500`,
    [rawPartner, status, kw, unpaidOnly],
  );

  return rows.map((r) => {
    const billingAmt = Number(r.billing_amount);
    const settledAmt = Number(r.settled_amount);
    return {
      id: r.id,
      billingNo: Number(r.billing_no),
      partnerId: r.partner_id,
      partnerCode: r.partner_code,
      partnerName: r.partner_name,
      billingDate: r.billing_date.slice(0, 10),
      paymentDueDate: r.payment_due_date !== null ? r.payment_due_date.slice(0, 10) : null,
      isSubscriptionBill: r.is_subscription_bill,
      billingAmount: billingAmt,
      settledAmount: settledAmt,
      unpaidBalance: billingAmt - settledAmt,
      receiptCount: Number(r.receipt_count),
      receivedAt: r.received_at !== null ? r.received_at.slice(0, 10) : null,
      status: r.status,
    };
  });
}

export async function updateBillingReceivableStatus(
  tx: DbExecutor,
  tenantId: string,
  employeeId: string,
  input: { billingId: string; status: ReceivableStatus; receivedAt?: string | null },
): Promise<{ billingId: string; status: ReceivableStatus }> {
  const depOk = await isFeatureEnabled(tx, tenantId, 'deposit');
  if (!depOk) {
    await requireFeature(tx, tenantId, 'receivable');
  }
  validateUuid(input.billingId, '請求ヘッダ');
  if (!VALID_RECEIVABLE_STATUSES.has(input.status)) {
    throw new MasterDataError(400, 'INVALID_STATUS', '入金ステータスは N1〜N4 を指定してください。');
  }

  let cleanReceivedAt: string | null = null;
  if (input.status !== 'N1') {
    const rawDate = optTrimmed(input.receivedAt);
    cleanReceivedAt =
      rawDate !== null ? validateDateOnly(rawDate, '入金消込日') : new Date().toISOString().slice(0, 10);
  }

  const rows = await tx.query<{ id: string }>(
    `UPDATE billing_headers
        SET status = $2::receivable_status,
            received_at = $3::date,
            updated_by = $4::uuid
      WHERE id = $1::uuid
      RETURNING id`,
    [input.billingId, input.status, cleanReceivedAt, employeeId],
  );
  if (rows.length === 0) {
    throw new MasterDataError(404, 'BILLING_NOT_FOUND', '対象の請求データが見つかりません。');
  }

  return { billingId: input.billingId, status: input.status };
}

interface CashReceiptRow extends Record<string, unknown> {
  id: string;
  receipt_no: string;
  receipt_date: string;
  partner_id: string;
  partner_code: string;
  partner_name: string;
  project_id: string | null;
  project_no: string | null;
  project_name: string | null;
  method_code_1: string | null;
  method_name_1: string | null;
  deposit_1: string;
  method_code_2: string | null;
  method_name_2: string | null;
  deposit_2: string;
  method_code_3: string | null;
  method_name_3: string | null;
  deposit_3: string;
  total_deposit: string;
  subtotal_10_excl: string;
  subtotal_8_excl: string;
  subtotal_0: string;
  tadashi: string | null;
  bill_no: string | null;
  bill_due_date: string | null;
  remarks: string | null;
  source_kind: 'MANUAL' | 'APLUS';
  snapshot_count: number;
  latest_snapshot_id: string | null;
  latest_snapshot_ver: number | null;
  created_at: string;
  updated_at: string;
}

function mapCashReceiptRow(r: CashReceiptRow): CashReceiptDto {
  return {
    id: r.id,
    receiptNo: Number(r.receipt_no),
    receiptDate: r.receipt_date.slice(0, 10),
    partnerId: r.partner_id,
    partnerCode: r.partner_code,
    partnerName: r.partner_name,
    projectId: r.project_id,
    projectNo: r.project_no !== null ? Number(r.project_no) : null,
    projectName: r.project_name,
    methodCode1: r.method_code_1,
    methodName1: r.method_name_1,
    deposit1: Number(r.deposit_1),
    methodCode2: r.method_code_2,
    methodName2: r.method_name_2,
    deposit2: Number(r.deposit_2),
    methodCode3: r.method_code_3,
    methodName3: r.method_name_3,
    deposit3: Number(r.deposit_3),
    totalDeposit: Number(r.total_deposit),
    subtotal10Excl: Number(r.subtotal_10_excl),
    subtotal8Excl: Number(r.subtotal_8_excl),
    subtotal0: Number(r.subtotal_0),
    tadashi: r.tadashi,
    billNo: r.bill_no,
    billDueDate: r.bill_due_date !== null ? r.bill_due_date.slice(0, 10) : null,
    remarks: r.remarks,
    sourceKind: r.source_kind,
    snapshotCount: Number(r.snapshot_count),
    latestSnapshotId: r.latest_snapshot_id,
    latestSnapshotVersion: r.latest_snapshot_ver !== null ? Number(r.latest_snapshot_ver) : null,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

export async function listCashReceipts(
  tx: DbExecutor,
  tenantId: string,
  filter: CashReceiptListFilter = {},
): Promise<CashReceiptPageDto> {
  await requireAnyReceivablesReadFeature(tx, tenantId);

  const kw = optTrimmed(filter.keyword);
  const rawPartner = optTrimmed(filter.partnerId);
  if (rawPartner !== null) {
    validateUuid(rawPartner, '取引先');
  }
  const sourceKind =
    filter.sourceKind === 'MANUAL' || filter.sourceKind === 'APLUS' ? filter.sourceKind : 'ALL';
  const rawFrom = optTrimmed(filter.dateFrom);
  const dateFrom = rawFrom !== null && DATE_REGEX.test(rawFrom) ? rawFrom : null;
  const rawTo = optTrimmed(filter.dateTo);
  const dateTo = rawTo !== null && DATE_REGEX.test(rawTo) ? rawTo : null;
  const billNo = optTrimmed(filter.billNo);

  const rawPage = filter.page === undefined ? 1 : filter.page;
  const rawSize = filter.pageSize === undefined ? 25 : filter.pageSize;
  const page = Number.isInteger(rawPage) && rawPage >= 1 ? rawPage : 1;
  const pageSize = Number.isInteger(rawSize) && rawSize >= 1 && rawSize <= 5000 ? rawSize : 25;
  const offset = (page - 1) * pageSize;

  const sumRows = await tx.query<{
    total_count: number;
    sum_deposit: string;
    manual_count: number;
    aplus_count: number;
  }>(
    `SELECT COUNT(*)::int AS total_count,
            COALESCE(SUM(cr.total_deposit), 0)::text AS sum_deposit,
            COUNT(*) FILTER (WHERE cr.source_kind = 'MANUAL')::int AS manual_count,
            COUNT(*) FILTER (WHERE cr.source_kind = 'APLUS')::int AS aplus_count
       FROM cash_receipts cr
       JOIN business_partners bp ON bp.tenant_id = cr.tenant_id AND bp.id = cr.partner_id
      WHERE (
          $1::text IS NULL
          OR CAST(cr.receipt_no AS text) ILIKE '%' || $1 || '%'
          OR COALESCE(cr.bill_no, '') ILIKE '%' || $1 || '%'
          OR COALESCE(cr.tadashi, '') ILIKE '%' || $1 || '%'
          OR bp.partner_name ILIKE '%' || $1 || '%'
          OR bp.partner_code ILIKE '%' || $1 || '%'
        )
        AND ($2::uuid IS NULL OR cr.partner_id = $2::uuid)
        AND ($3::text = 'ALL' OR cr.source_kind = $3)
        AND ($4::date IS NULL OR cr.receipt_date >= $4::date)
        AND ($5::date IS NULL OR cr.receipt_date <= $5::date)
        AND ($6::text IS NULL OR cr.bill_no = $6)`,
    [kw, rawPartner, sourceKind, dateFrom, dateTo, billNo],
  );
  const sum = sumRows[0];

  const rows = await tx.query<CashReceiptRow>(
    `SELECT cr.id, cr.receipt_no::text AS receipt_no, cr.receipt_date::text AS receipt_date,
            cr.partner_id, bp.partner_code, bp.partner_name,
            cr.project_id, pj.project_no::text AS project_no, pj.project_name,
            cr.method_code_1, pm1.method_name AS method_name_1, cr.deposit_1::text AS deposit_1,
            cr.method_code_2, pm2.method_name AS method_name_2, cr.deposit_2::text AS deposit_2,
            cr.method_code_3, pm3.method_name AS method_name_3, cr.deposit_3::text AS deposit_3,
            cr.total_deposit::text AS total_deposit,
            cr.subtotal_10_excl::text AS subtotal_10_excl,
            cr.subtotal_8_excl::text AS subtotal_8_excl,
            cr.subtotal_0::text AS subtotal_0,
            cr.tadashi, cr.bill_no, cr.bill_due_date::text AS bill_due_date, cr.remarks,
            cr.source_kind,
            (SELECT COUNT(*)::int FROM document_snapshots ds
              WHERE ds.document_type = 'RECEIPT'
                AND ds.source_entity_id = cr.id) AS snapshot_count,
            (SELECT ds.id FROM document_snapshots ds
              WHERE ds.document_type = 'RECEIPT'
                AND ds.source_entity_id = cr.id
              ORDER BY ds.version_no DESC
              LIMIT 1) AS latest_snapshot_id,
            (SELECT ds.version_no FROM document_snapshots ds
              WHERE ds.document_type = 'RECEIPT'
                AND ds.source_entity_id = cr.id
              ORDER BY ds.version_no DESC
              LIMIT 1) AS latest_snapshot_ver,
            cr.created_at::text AS created_at,
            cr.updated_at::text AS updated_at
       FROM cash_receipts cr
       JOIN business_partners bp ON bp.tenant_id = cr.tenant_id AND bp.id = cr.partner_id
       LEFT JOIN projects pj ON pj.tenant_id = cr.tenant_id AND pj.id = cr.project_id
       LEFT JOIN payment_methods pm1 ON pm1.tenant_id = cr.tenant_id AND pm1.method_code = cr.method_code_1
       LEFT JOIN payment_methods pm2 ON pm2.tenant_id = cr.tenant_id AND pm2.method_code = cr.method_code_2
       LEFT JOIN payment_methods pm3 ON pm3.tenant_id = cr.tenant_id AND pm3.method_code = cr.method_code_3
      WHERE (
          $1::text IS NULL
          OR CAST(cr.receipt_no AS text) ILIKE '%' || $1 || '%'
          OR COALESCE(cr.bill_no, '') ILIKE '%' || $1 || '%'
          OR COALESCE(cr.tadashi, '') ILIKE '%' || $1 || '%'
          OR bp.partner_name ILIKE '%' || $1 || '%'
          OR bp.partner_code ILIKE '%' || $1 || '%'
        )
        AND ($2::uuid IS NULL OR cr.partner_id = $2::uuid)
        AND ($3::text = 'ALL' OR cr.source_kind = $3)
        AND ($4::date IS NULL OR cr.receipt_date >= $4::date)
        AND ($5::date IS NULL OR cr.receipt_date <= $5::date)
        AND ($6::text IS NULL OR cr.bill_no = $6)
      ORDER BY cr.receipt_date DESC, cr.receipt_no DESC
      LIMIT $7 OFFSET $8`,
    [kw, rawPartner, sourceKind, dateFrom, dateTo, billNo, pageSize, offset],
  );

  return {
    items: rows.map(mapCashReceiptRow),
    summary: {
      totalCount: sum !== undefined ? Number(sum.total_count) : 0,
      sumDepositTotal: sum !== undefined ? Number(sum.sum_deposit) : 0,
      manualCount: sum !== undefined ? Number(sum.manual_count) : 0,
      aplusCount: sum !== undefined ? Number(sum.aplus_count) : 0,
    },
    page,
    pageSize,
  };
}

export async function getCashReceiptDetail(
  tx: DbExecutor,
  tenantId: string,
  receiptId: string,
): Promise<CashReceiptDetailDto> {
  await requireAnyReceivablesReadFeature(tx, tenantId);
  validateUuid(receiptId, '入金');

  const rows = await tx.query<CashReceiptRow>(
    `SELECT cr.id, cr.receipt_no::text AS receipt_no, cr.receipt_date::text AS receipt_date,
            cr.partner_id, bp.partner_code, bp.partner_name,
            cr.project_id, pj.project_no::text AS project_no, pj.project_name,
            cr.method_code_1, pm1.method_name AS method_name_1, cr.deposit_1::text AS deposit_1,
            cr.method_code_2, pm2.method_name AS method_name_2, cr.deposit_2::text AS deposit_2,
            cr.method_code_3, pm3.method_name AS method_name_3, cr.deposit_3::text AS deposit_3,
            cr.total_deposit::text AS total_deposit,
            cr.subtotal_10_excl::text AS subtotal_10_excl,
            cr.subtotal_8_excl::text AS subtotal_8_excl,
            cr.subtotal_0::text AS subtotal_0,
            cr.tadashi, cr.bill_no, cr.bill_due_date::text AS bill_due_date, cr.remarks,
            cr.source_kind,
            (SELECT COUNT(*)::int FROM document_snapshots ds
              WHERE ds.document_type = 'RECEIPT'
                AND ds.source_entity_id = cr.id) AS snapshot_count,
            (SELECT ds.id FROM document_snapshots ds
              WHERE ds.document_type = 'RECEIPT'
                AND ds.source_entity_id = cr.id
              ORDER BY ds.version_no DESC
              LIMIT 1) AS latest_snapshot_id,
            (SELECT ds.version_no FROM document_snapshots ds
              WHERE ds.document_type = 'RECEIPT'
                AND ds.source_entity_id = cr.id
              ORDER BY ds.version_no DESC
              LIMIT 1) AS latest_snapshot_ver,
            cr.created_at::text AS created_at,
            cr.updated_at::text AS updated_at
       FROM cash_receipts cr
       JOIN business_partners bp ON bp.tenant_id = cr.tenant_id AND bp.id = cr.partner_id
       LEFT JOIN projects pj ON pj.tenant_id = cr.tenant_id AND pj.id = cr.project_id
       LEFT JOIN payment_methods pm1 ON pm1.tenant_id = cr.tenant_id AND pm1.method_code = cr.method_code_1
       LEFT JOIN payment_methods pm2 ON pm2.tenant_id = cr.tenant_id AND pm2.method_code = cr.method_code_2
       LEFT JOIN payment_methods pm3 ON pm3.tenant_id = cr.tenant_id AND pm3.method_code = cr.method_code_3
      WHERE cr.id = $1::uuid
      LIMIT 1`,
    [receiptId],
  );
  const row = rows[0];
  if (row === undefined) {
    throw new MasterDataError(404, 'RECEIPT_NOT_FOUND', '対象の入金データが見つかりません。');
  }

  const snapRows = await tx.query<{
    id: string;
    document_type: SnapshotHistoryItemDto['documentType'];
    source_entity_type: SnapshotHistoryItemDto['sourceEntityType'];
    source_entity_id: string;
    document_no: string;
    version_no: number;
    is_reissue: boolean;
    reissue_label: string | null;
    template_variant: string;
    issued_at: string;
    issued_by: string | null;
    issued_by_name: string | null;
    payload_sha256: string;
  }>(
    `SELECT ds.id, ds.document_type::text AS document_type, ds.source_entity_type,
            ds.source_entity_id, ds.document_no, ds.version_no, ds.is_reissue,
            ds.reissue_label, ds.template_variant, ds.issued_at::text AS issued_at,
            ds.issued_by, e.syain_name AS issued_by_name, ds.payload_sha256
       FROM document_snapshots ds
       LEFT JOIN employees e ON e.tenant_id = ds.tenant_id AND e.id = ds.issued_by
      WHERE ds.document_type = 'RECEIPT'
        AND ds.source_entity_id = $1::uuid
      ORDER BY ds.version_no DESC`,
    [receiptId],
  );

  const snapshots: SnapshotHistoryItemDto[] = snapRows.map((s) => ({
    id: s.id,
    documentType: s.document_type,
    sourceEntityType: s.source_entity_type,
    sourceEntityId: s.source_entity_id,
    documentNo: s.document_no,
    versionNo: Number(s.version_no),
    isReissue: s.is_reissue,
    reissueLabel: s.reissue_label,
    templateVariant: s.template_variant,
    issuedAt: s.issued_at,
    issuedBy: s.issued_by,
    issuedByName: s.issued_by_name,
    payloadSha256: s.payload_sha256,
  }));

  return {
    ...mapCashReceiptRow(row),
    snapshots,
  };
}

async function validateCleanReceiptRefs(
  tx: DbExecutor,
  tenantId: string,
  input: CashReceiptInput,
  openingBalanceDate: string,
): Promise<{
  receiptDate: string;
  billDueDate: string | null;
  cleanMethod1: string | null;
  cleanMethod2: string | null;
  cleanMethod3: string | null;
}> {
  const receiptDate = validateDateOnly(input.receiptDate, '入金日');
  if (receiptDate <= openingBalanceDate) {
    throw new MasterDataError(
      400,
      'RECEIPT_DATE_BEFORE_CUTOFF',
      `入金日は期首残高基準日 (${openingBalanceDate}) より後の日付を指定してください。`,
    );
  }
  validateUuid(input.partnerId, '取引先');
  if (input.projectId !== null) {
    validateUuid(input.projectId, '案件');
  }

  const total = input.deposit1 + input.deposit2 + input.deposit3;
  if (total <= 0) {
    throw new MasterDataError(
      400,
      'INVALID_DEPOSIT_AMOUNT',
      '入金合計額は1円以上で入力してください。',
    );
  }

  const billDueDate =
    input.billDueDate !== null ? validateDateOnly(input.billDueDate, '手形期日') : null;

  const pRows = await tx.query<{ id: string }>(
    'SELECT id FROM business_partners WHERE id = $1::uuid LIMIT 1',
    [input.partnerId],
  );
  if (pRows.length === 0) {
    throw new MasterDataError(404, 'PARTNER_NOT_FOUND', '指定された取引先が見つかりません。');
  }

  if (input.projectId !== null) {
    const pjRows = await tx.query<{ id: string }>(
      'SELECT id FROM projects WHERE id = $1::uuid LIMIT 1',
      [input.projectId],
    );
    if (pjRows.length === 0) {
      throw new MasterDataError(404, 'PROJECT_NOT_FOUND', '指定された案件が見つかりません。');
    }
  }

  const cleanMethod1 = optTrimmed(input.methodCode1);
  const cleanMethod2 = optTrimmed(input.methodCode2);
  const cleanMethod3 = optTrimmed(input.methodCode3);

  const methodRows = await tx.query<{ method_code: string }>(
    'SELECT method_code FROM payment_methods',
    [],
  );
  const validCodes = new Set(methodRows.map((m) => m.method_code));
  for (const [idx, code] of [
    [1, cleanMethod1],
    [2, cleanMethod2],
    [3, cleanMethod3],
  ] as const) {
    if (code !== null && !validCodes.has(code)) {
      throw new MasterDataError(
        400,
        'INVALID_PAYMENT_METHOD',
        `入金方法${idx}の支払方法コード '${code}' がマスタに存在しません。`,
      );
    }
  }

  void tenantId;
  return {
    receiptDate,
    billDueDate,
    cleanMethod1,
    cleanMethod2,
    cleanMethod3,
  };
}

export async function insertCashReceiptInternal(
  tx: DbExecutor,
  params: {
    tenantId: string;
    employeeId: string;
    input: CashReceiptInput;
    sourceKind: 'MANUAL' | 'APLUS';
    openingBalanceDate: string;
  },
): Promise<{ id: string; receiptNo: number; totalDeposit: number }> {
  const refs = await validateCleanReceiptRefs(
    tx,
    params.tenantId,
    params.input,
    params.openingBalanceDate,
  );

  const maxRows = await tx.query<{ max_no: string }>(
    'SELECT COALESCE(MAX(receipt_no), 0)::text AS max_no FROM cash_receipts',
    [],
  );
  const nextReceiptNo = BigInt(maxRows[0] !== undefined ? maxRows[0].max_no : '0') + 1n;

  // total_deposit は GENERATED ALWAYS AS STORED 列のため INSERT に含めず RETURNING で取得する
  let inserted: { id: string; receipt_no: string; total_deposit: string } | undefined;
  try {
    const rows = await tx.query<{ id: string; receipt_no: string; total_deposit: string }>(
      `INSERT INTO cash_receipts (
         tenant_id, receipt_no, receipt_date, partner_id, project_id,
         method_code_1, deposit_1, method_code_2, deposit_2, method_code_3, deposit_3,
         subtotal_10_excl, subtotal_8_excl, subtotal_0,
         tadashi, bill_no, bill_due_date, remarks, source_kind,
         created_by, updated_by
       ) VALUES (
         $1::uuid, $2::bigint, $3::date, $4::uuid, $5::uuid,
         $6, $7::numeric, $8, $9::numeric, $10, $11::numeric,
         $12::numeric, $13::numeric, $14::numeric,
         $15, $16, $17::date, $18, $19,
         $20::uuid, $20::uuid
       )
       RETURNING id, receipt_no::text AS receipt_no, total_deposit::text AS total_deposit`,
      [
        params.tenantId,
        nextReceiptNo.toString(),
        refs.receiptDate,
        params.input.partnerId,
        params.input.projectId,
        refs.cleanMethod1,
        params.input.deposit1,
        refs.cleanMethod2,
        params.input.deposit2,
        refs.cleanMethod3,
        params.input.deposit3,
        params.input.subtotal10Excl,
        params.input.subtotal8Excl,
        params.input.subtotal0,
        params.input.tadashi,
        params.input.billNo,
        refs.billDueDate,
        params.input.remarks,
        params.sourceKind,
        params.employeeId,
      ],
    );
    inserted = rows[0];
  } catch (err) {
    throw mapPgConstraintError(err, { entityLabel: '入金データ' });
  }

  if (inserted === undefined) {
    throw new MasterDataError(500, 'RECEIPT_INSERT_FAILED', '入金データの登録に失敗しました。');
  }

  await syncBillingSettlementByBillNo(
    tx,
    params.employeeId,
    params.input.partnerId,
    params.input.billNo,
  );

  return {
    id: inserted.id,
    receiptNo: Number(inserted.receipt_no),
    totalDeposit: Number(inserted.total_deposit),
  };
}

export async function createCashReceipt(
  tx: DbExecutor,
  tenantId: string,
  employeeId: string,
  input: CashReceiptInput,
): Promise<CashReceiptDetailDto> {
  await requireFeature(tx, tenantId, 'deposit');

  const tsRows = await tx.query<{ opening_balance_date: string }>(
    `SELECT opening_balance_date::text AS opening_balance_date
       FROM tenant_settings
      WHERE tenant_id = $1::uuid
      FOR UPDATE`,
    [tenantId],
  );
  const ts = tsRows[0];
  if (ts === undefined) {
    throw new MasterDataError(404, 'TENANT_SETTINGS_NOT_FOUND', '自社設定が見つかりません。');
  }

  const inserted = await insertCashReceiptInternal(tx, {
    tenantId,
    employeeId,
    input,
    sourceKind: 'MANUAL',
    openingBalanceDate: ts.opening_balance_date.slice(0, 10),
  });

  return getCashReceiptDetail(tx, tenantId, inserted.id);
}

export async function updateCashReceipt(
  tx: DbExecutor,
  tenantId: string,
  employeeId: string,
  receiptId: string,
  input: CashReceiptInput,
): Promise<CashReceiptDetailDto> {
  await requireFeature(tx, tenantId, 'deposit');
  validateUuid(receiptId, '入金');

  const tsRows = await tx.query<{ opening_balance_date: string }>(
    `SELECT opening_balance_date::text AS opening_balance_date
       FROM tenant_settings
      WHERE tenant_id = $1::uuid
      LIMIT 1`,
    [tenantId],
  );
  const ts = tsRows[0];
  if (ts === undefined) {
    throw new MasterDataError(404, 'TENANT_SETTINGS_NOT_FOUND', '自社設定が見つかりません。');
  }
  const openingBalanceDate = ts.opening_balance_date.slice(0, 10);

  const curRows = await tx.query<{
    id: string;
    partner_id: string;
    receipt_date: string;
    bill_no: string | null;
  }>(
    `SELECT id, partner_id, receipt_date::text AS receipt_date, bill_no
       FROM cash_receipts
      WHERE id = $1::uuid
      FOR UPDATE`,
    [receiptId],
  );
  const current = curRows[0];
  if (current === undefined) {
    throw new MasterDataError(404, 'RECEIPT_NOT_FOUND', '対象の入金データが見つかりません。');
  }

  if (current.receipt_date.slice(0, 10) <= openingBalanceDate) {
    throw new MasterDataError(
      409,
      'CUTOFF_DATE_LOCKED',
      `期首残高基準日 (${openingBalanceDate}) 以前の入金データは変更できません。`,
    );
  }

  const refs = await validateCleanReceiptRefs(tx, tenantId, input, openingBalanceDate);

  // total_deposit は GENERATED ALWAYS AS STORED 列のため UPDATE 対象から除外
  try {
    await tx.query(
      `UPDATE cash_receipts
          SET receipt_date = $2::date,
              partner_id = $3::uuid,
              project_id = $4::uuid,
              method_code_1 = $5,
              deposit_1 = $6::numeric,
              method_code_2 = $7,
              deposit_2 = $8::numeric,
              method_code_3 = $9,
              deposit_3 = $10::numeric,
              subtotal_10_excl = $11::numeric,
              subtotal_8_excl = $12::numeric,
              subtotal_0 = $13::numeric,
              tadashi = $14,
              bill_no = $15,
              bill_due_date = $16::date,
              remarks = $17,
              updated_by = $18::uuid
        WHERE id = $1::uuid`,
      [
        receiptId,
        refs.receiptDate,
        input.partnerId,
        input.projectId,
        refs.cleanMethod1,
        input.deposit1,
        refs.cleanMethod2,
        input.deposit2,
        refs.cleanMethod3,
        input.deposit3,
        input.subtotal10Excl,
        input.subtotal8Excl,
        input.subtotal0,
        input.tadashi,
        input.billNo,
        refs.billDueDate,
        input.remarks,
        employeeId,
      ],
    );
  } catch (err) {
    throw mapPgConstraintError(err, { entityLabel: '入金データ' });
  }

  await syncBillingSettlementByBillNo(tx, employeeId, current.partner_id, current.bill_no);
  await syncBillingSettlementByBillNo(tx, employeeId, input.partnerId, input.billNo);

  return getCashReceiptDetail(tx, tenantId, receiptId);
}

export async function deleteCashReceipt(
  tx: DbExecutor,
  tenantId: string,
  employeeId: string,
  receiptId: string,
): Promise<void> {
  await requireFeature(tx, tenantId, 'deposit');
  validateUuid(receiptId, '入金');

  const tsRows = await tx.query<{ opening_balance_date: string }>(
    `SELECT opening_balance_date::text AS opening_balance_date
       FROM tenant_settings
      WHERE tenant_id = $1::uuid
      LIMIT 1`,
    [tenantId],
  );
  const openingBalanceDate =
    tsRows[0] !== undefined ? tsRows[0].opening_balance_date.slice(0, 10) : null;

  const curRows = await tx.query<{
    id: string;
    partner_id: string;
    receipt_date: string;
    bill_no: string | null;
  }>(
    `SELECT id, partner_id, receipt_date::text AS receipt_date, bill_no
       FROM cash_receipts
      WHERE id = $1::uuid
      FOR UPDATE`,
    [receiptId],
  );
  const current = curRows[0];
  if (current === undefined) {
    throw new MasterDataError(404, 'RECEIPT_NOT_FOUND', '対象の入金データが見つかりません。');
  }

  if (openingBalanceDate !== null && current.receipt_date.slice(0, 10) <= openingBalanceDate) {
    throw new MasterDataError(
      409,
      'CUTOFF_DATE_LOCKED',
      `期首残高基準日 (${openingBalanceDate}) 以前の入金データは削除できません。`,
    );
  }

  const snapRows = await tx.query<{ cnt: number }>(
    `SELECT COUNT(*)::int AS cnt
       FROM document_snapshots
      WHERE source_entity_type = 'CASH_RECEIPT'
        AND source_entity_id = $1::uuid`,
    [receiptId],
  );
  if (snapRows[0] !== undefined && Number(snapRows[0].cnt) > 0) {
    throw new MasterDataError(
      409,
      'RECEIPT_HAS_SNAPSHOTS',
      '領収書スナップショット発行済みの入金データは削除できません。',
    );
  }

  await tx.query('DELETE FROM cash_receipts WHERE id = $1::uuid', [receiptId]);
  await syncBillingSettlementByBillNo(tx, employeeId, current.partner_id, current.bill_no);
}

// 未使用警告防止のため明示型参照を維持
export { RECEIVABLE_STATUS_LABELS };
