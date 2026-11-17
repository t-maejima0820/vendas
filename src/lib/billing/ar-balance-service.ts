import type { DbExecutor } from '@/lib/db/tenant-client';
import { calculateArBalance } from '@/lib/domain/calculations';
import { MasterDataError } from '@/lib/masters/error-mapper';

const DATE_REGEX = /^\d{4}-\d{2}-\d{2}$/;
const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface PartnerArBalanceSummary {
  partnerId: string;
  openingBalanceDate: string;
  periodStart: string;
  periodEnd: string;
  openingArBalance: bigint;
  beforePeriodBillings: bigint;
  beforePeriodReceipts: bigint;
  prevCarriedBalance: bigint;
  inPeriodBillings: bigint;
  periodReceiptAmount: bigint;
  netCarriedBalance: bigint;
  closingBalanceExisting: bigint;
}

function assertValidDate(raw: string, label: string): string {
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
    throw new MasterDataError(400, 'INVALID_DATE', `${label}の日付が不正です。`);
  }
  return trimmed;
}

function formatIsoUtcDate(year: number, month: number, day: number): string {
  const yStr = String(year).padStart(4, '0');
  const mStr = String(month).padStart(2, '0');
  const dStr = String(day).padStart(2, '0');
  return `${yStr}-${mStr}-${dStr}`;
}

export function getMonthStartAndEndDates(yyyymm: string): {
  periodStart: string;
  periodEnd: string;
} {
  if (!/^[0-9]{6}$/.test(yyyymm)) {
    throw new MasterDataError(400, 'INVALID_TARGET_MONTH', '対象年月は YYYYMM 形式で指定してください。');
  }
  const year = Number(yyyymm.slice(0, 4));
  const month = Number(yyyymm.slice(4, 6));
  if (month < 1 || month > 12) {
    throw new MasterDataError(400, 'INVALID_TARGET_MONTH', '対象年月の月指定が不正です。');
  }
  const lastDay = new Date(Date.UTC(year, month, 0)).getUTCDate();
  return {
    periodStart: formatIsoUtcDate(year, month, 1),
    periodEnd: formatIsoUtcDate(year, month, lastDay),
  };
}

export function getMonthStartForDate(dateStr: string): string {
  const valid = assertValidDate(dateStr, '日付');
  return `${valid.slice(0, 8)}01`;
}

/**
 * 取引先の締日区分（BILL_CLOSE）および回収サイト区分（COLLECT_DAY）に基づき支払期限の初期値を提案する
 */
export function proposePaymentDueDate(
  billingDate: string,
  closingDayCode: string | null,
  collectionDayCode: string | null,
): string {
  const valid = assertValidDate(billingDate, '請求日');
  const parts = valid.split('-');
  const year = Number(parts[0]);
  const month = Number(parts[1]);

  const monthOffset = collectionDayCode === '2' || collectionDayCode === 'C' ? 2 : 1;
  const zeroBasedMonth = month - 1 + monthOffset;
  const remMonth = zeroBasedMonth % 12;
  const yearDelta = (zeroBasedMonth - remMonth) / 12;
  const targetYear = year + yearDelta;
  const targetMonth = remMonth + 1;

  const lastDay = new Date(Date.UTC(targetYear, targetMonth, 0)).getUTCDate();
  let day = lastDay;
  if (closingDayCode === 'B' || closingDayCode === '10') {
    day = 10;
  } else if (closingDayCode === 'C' || closingDayCode === '20') {
    day = 20;
  }

  return formatIsoUtcDate(targetYear, targetMonth, day);
}

function parseJsonRows<T>(raw: T[] | string): T[] {
  if (Array.isArray(raw)) {
    return raw;
  }
  const parsed = JSON.parse(raw) as unknown;
  if (!Array.isArray(parsed)) {
    throw new Error('売掛残高JSONデータの形式が不正です。');
  }
  return parsed as T[];
}

/**
 * 売掛繰越・残高計算共通サービス（旧Access BillUpdateDetailPrice 単一行入金＆期首漏れバグを是正）
 * - opening_balance_date (D0) を起点に、対象期間 [D1, D2] の前期末繰越および期間内全入金合算を算出する
 * - Phase 3-A 請求確定および Phase 3-B 売掛残高一覧の双方で共用可能（単一CTEクエリで一括取得）
 */
export async function calculatePartnersArBalances(
  tx: DbExecutor,
  params: {
    tenantId: string;
    partnerIds: readonly string[];
    periodStart: string;
    periodEnd: string;
    excludeBillingId?: string | null;
  },
): Promise<Map<string, PartnerArBalanceSummary>> {
  const result = new Map<string, PartnerArBalanceSummary>();
  const uniqueIds = Array.from(new Set(params.partnerIds));
  if (uniqueIds.length === 0) {
    return result;
  }

  for (const id of uniqueIds) {
    if (!UUID_REGEX.test(id)) {
      throw new MasterDataError(400, 'INVALID_ID', '取引先IDの形式が不正です。');
    }
  }

  const periodStart = assertValidDate(params.periodStart, '集計期間開始日');
  const periodEnd = assertValidDate(params.periodEnd, '集計期間終了日');
  if (periodStart > periodEnd) {
    throw new MasterDataError(
      400,
      'INVALID_PERIOD_RANGE',
      '集計期間開始日は終了日以前を指定してください。',
    );
  }

  let excludeBillingId: string | null = null;
  if (
    params.excludeBillingId !== undefined &&
    params.excludeBillingId !== null &&
    params.excludeBillingId.trim() !== ''
  ) {
    if (!UUID_REGEX.test(params.excludeBillingId.trim())) {
      throw new MasterDataError(400, 'INVALID_ID', '除外請求IDの形式が不正です。');
    }
    excludeBillingId = params.excludeBillingId.trim();
  }

  type PartnerOpeningRow = { id: string; opening_ar_balance: string };
  type BillingAggRow = {
    partner_id: string;
    before_billings: string;
    in_period_billings: string;
  };
  type ReceiptAggRow = {
    partner_id: string;
    before_receipts: string;
    in_period_receipts: string;
  };

  const aggRows = await tx.query<{
    opening_balance_date: string | null;
    partners_json: PartnerOpeningRow[] | string;
    billings_json: BillingAggRow[] | string;
    receipts_json: ReceiptAggRow[] | string;
  }>(
    `WITH ts AS (
       SELECT opening_balance_date::text AS opening_balance_date
         FROM tenant_settings
        WHERE tenant_id = $1::uuid
        LIMIT 1
     ),
     bp AS (
       SELECT id, opening_ar_balance::text AS opening_ar_balance
         FROM business_partners
        WHERE id = ANY($2::uuid[])
     ),
     bill AS (
       SELECT bh.partner_id,
              COALESCE(SUM(bh.billing_amount) FILTER (
                WHERE bh.billing_date > ts.opening_balance_date::date AND bh.billing_date < $3::date
              ), 0)::text AS before_billings,
              COALESCE(SUM(bh.billing_amount) FILTER (
                WHERE bh.billing_date > ts.opening_balance_date::date AND bh.billing_date >= $3::date AND bh.billing_date <= $4::date
              ), 0)::text AS in_period_billings
         FROM billing_headers bh
        CROSS JOIN ts
        WHERE bh.partner_id = ANY($2::uuid[])
          AND ($5::uuid IS NULL OR bh.id <> $5::uuid)
        GROUP BY bh.partner_id
     ),
     rec AS (
       SELECT cr.partner_id,
              COALESCE(SUM(cr.total_deposit) FILTER (
                WHERE cr.receipt_date > ts.opening_balance_date::date AND cr.receipt_date < $3::date
              ), 0)::text AS before_receipts,
              COALESCE(SUM(cr.total_deposit) FILTER (
                WHERE cr.receipt_date > ts.opening_balance_date::date AND cr.receipt_date >= $3::date AND cr.receipt_date <= $4::date
              ), 0)::text AS in_period_receipts
         FROM cash_receipts cr
        CROSS JOIN ts
        WHERE cr.partner_id = ANY($2::uuid[])
        GROUP BY cr.partner_id
     )
     SELECT
       (SELECT opening_balance_date FROM ts) AS opening_balance_date,
       COALESCE((SELECT json_agg(row_to_json(bp)) FROM bp), '[]'::json) AS partners_json,
       COALESCE((SELECT json_agg(row_to_json(bill)) FROM bill), '[]'::json) AS billings_json,
       COALESCE((SELECT json_agg(row_to_json(rec)) FROM rec), '[]'::json) AS receipts_json`,
    [params.tenantId, uniqueIds, periodStart, periodEnd, excludeBillingId],
  );

  const aggRow = aggRows[0];
  if (aggRow === undefined || aggRow.opening_balance_date === null) {
    throw new MasterDataError(404, 'TENANT_SETTINGS_NOT_FOUND', '自社設定が見つかりません。');
  }
  const openingBalanceDate = aggRow.opening_balance_date.slice(0, 10);

  const partnerRows = parseJsonRows<PartnerOpeningRow>(aggRow.partners_json);
  const openingMap = new Map(partnerRows.map((p) => [p.id, BigInt(p.opening_ar_balance)]));

  const billingAggRows = parseJsonRows<BillingAggRow>(aggRow.billings_json);
  const billingAggMap = new Map(
    billingAggRows.map((r) => [
      r.partner_id,
      {
        before: BigInt(r.before_billings),
        inPeriod: BigInt(r.in_period_billings),
      },
    ]),
  );

  const receiptAggRows = parseJsonRows<ReceiptAggRow>(aggRow.receipts_json);
  const receiptAggMap = new Map(
    receiptAggRows.map((r) => [
      r.partner_id,
      {
        before: BigInt(r.before_receipts),
        inPeriod: BigInt(r.in_period_receipts),
      },
    ]),
  );

  for (const partnerId of uniqueIds) {
    const openingArBalance = openingMap.get(partnerId);
    if (openingArBalance === undefined) {
      throw new MasterDataError(404, 'PARTNER_NOT_FOUND', '対象の取引先が見つかりません。');
    }

    const billAgg = billingAggMap.get(partnerId);
    const recAgg = receiptAggMap.get(partnerId);

    const beforePeriodBillings = billAgg !== undefined ? billAgg.before : 0n;
    const inPeriodBillings = billAgg !== undefined ? billAgg.inPeriod : 0n;
    const beforePeriodReceipts = recAgg !== undefined ? recAgg.before : 0n;
    const periodReceiptAmount = recAgg !== undefined ? recAgg.inPeriod : 0n;

    const ar = calculateArBalance({
      openingBalanceAtCutoff: openingArBalance,
      beforePeriodIncreases: beforePeriodBillings,
      beforePeriodDecreases: beforePeriodReceipts,
      inPeriodIncreases: inPeriodBillings,
      inPeriodDecreases: periodReceiptAmount,
    });

    result.set(partnerId, {
      partnerId,
      openingBalanceDate,
      periodStart,
      periodEnd,
      openingArBalance,
      beforePeriodBillings,
      beforePeriodReceipts,
      prevCarriedBalance: ar.carriedBalance,
      inPeriodBillings,
      periodReceiptAmount,
      netCarriedBalance: ar.carriedBalance - periodReceiptAmount,
      closingBalanceExisting: ar.closingBalance,
    });
  }

  return result;
}

export async function calculateSinglePartnerArBalance(
  tx: DbExecutor,
  params: {
    tenantId: string;
    partnerId: string;
    periodStart: string;
    periodEnd: string;
    excludeBillingId?: string | null;
  },
): Promise<PartnerArBalanceSummary> {
  const map = await calculatePartnersArBalances(tx, {
    tenantId: params.tenantId,
    partnerIds: [params.partnerId],
    periodStart: params.periodStart,
    periodEnd: params.periodEnd,
    excludeBillingId: params.excludeBillingId,
  });
  const summary = map.get(params.partnerId);
  if (summary === undefined) {
    throw new MasterDataError(404, 'PARTNER_NOT_FOUND', '対象の取引先が見つかりません。');
  }
  return summary;
}
