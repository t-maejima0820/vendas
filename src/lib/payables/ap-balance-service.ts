import type { DbExecutor } from '@/lib/db/tenant-client';
import { calculateApBalance } from '@/lib/domain/calculations';
import { MasterDataError } from '@/lib/masters/error-mapper';

const DATE_REGEX = /^\d{4}-\d{2}-\d{2}$/;
const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface PartnerApBalanceSummary {
  supplierId: string;
  openingBalanceDate: string;
  periodStart: string;
  periodEnd: string;
  openingApBalance: bigint;
  beforePeriodPayables: bigint;
  beforePeriodPayments: bigint;
  prevCarriedBalance: bigint;
  inPeriodPayablesExcl: bigint;
  inPeriodPayablesTax: bigint;
  inPeriodPayablesIncl: bigint;
  periodPaymentAmount: bigint;
  periodNetDelta: bigint;
  closingApBalance: bigint;
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

function parseJsonRows<T>(raw: T[] | string): T[] {
  if (Array.isArray(raw)) {
    return raw;
  }
  const parsed = JSON.parse(raw) as unknown;
  if (!Array.isArray(parsed)) {
    throw new Error('買掛残高JSONデータの形式が不正です。');
  }
  return parsed as T[];
}

/**
 * 買掛繰越・残高計算共通サービス（旧Accessバグ②是正：opening_ap_balance 基準＆複数支払全額控除）
 * - tenant_settings.opening_balance_date (D0) を起点に [D1, D2] の買掛残高推移を1円単位で算出する（単一CTEクエリ）
 */
export async function calculatePartnersApBalances(
  tx: DbExecutor,
  params: {
    tenantId: string;
    supplierIds: readonly string[];
    periodStart: string;
    periodEnd: string;
  },
): Promise<Map<string, PartnerApBalanceSummary>> {
  const result = new Map<string, PartnerApBalanceSummary>();
  const uniqueIds = Array.from(new Set(params.supplierIds));
  if (uniqueIds.length === 0) {
    return result;
  }

  for (const id of uniqueIds) {
    if (!UUID_REGEX.test(id)) {
      throw new MasterDataError(400, 'INVALID_ID', '仕入先IDの形式が不正です。');
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

  type PartnerOpeningRow = { id: string; opening_ap_balance: string };
  type PayableAggRow = {
    supplier_id: string;
    before_payables: string;
    in_period_payables_incl: string;
    in_period_payables_tax: string;
  };
  type PaymentAggRow = {
    supplier_id: string;
    before_payments: string;
    in_period_payments: string;
  };

  const aggRows = await tx.query<{
    opening_balance_date: string | null;
    partners_json: PartnerOpeningRow[] | string;
    payables_json: PayableAggRow[] | string;
    payments_json: PaymentAggRow[] | string;
  }>(
    `WITH ts AS (
       SELECT opening_balance_date::text AS opening_balance_date
         FROM tenant_settings
        WHERE tenant_id = $1::uuid
        LIMIT 1
     ),
     bp AS (
       SELECT id, opening_ap_balance::text AS opening_ap_balance
         FROM business_partners
        WHERE id = ANY($2::uuid[])
     ),
     payables AS (
       SELECT pl.supplier_id,
              COALESCE(SUM(pl.payable_amount) FILTER (
                WHERE pl.purchase_date > ts.opening_balance_date::date AND pl.purchase_date < $3::date
              ), 0)::text AS before_payables,
              COALESCE(SUM(pl.payable_amount) FILTER (
                WHERE pl.purchase_date > ts.opening_balance_date::date AND pl.purchase_date >= $3::date AND pl.purchase_date <= $4::date
              ), 0)::text AS in_period_payables_incl,
              COALESCE(SUM(pl.tax_total) FILTER (
                WHERE pl.purchase_date > ts.opening_balance_date::date AND pl.purchase_date >= $3::date AND pl.purchase_date <= $4::date
              ), 0)::text AS in_period_payables_tax
         FROM payable_ledgers pl
        CROSS JOIN ts
        WHERE pl.supplier_id = ANY($2::uuid[])
        GROUP BY pl.supplier_id
     ),
     payments AS (
       SELECT sp.supplier_id,
              COALESCE(SUM(
                sp.amount_1 + sp.amount_2 + sp.amount_3 +
                sp.deduction_amt_1 + sp.deduction_amt_2 + sp.deduction_amt_3
              ) FILTER (
                WHERE sp.payment_date > ts.opening_balance_date::date AND sp.payment_date < $3::date
              ), 0)::text AS before_payments,
              COALESCE(SUM(
                sp.amount_1 + sp.amount_2 + sp.amount_3 +
                sp.deduction_amt_1 + sp.deduction_amt_2 + sp.deduction_amt_3
              ) FILTER (
                WHERE sp.payment_date > ts.opening_balance_date::date AND sp.payment_date >= $3::date AND sp.payment_date <= $4::date
              ), 0)::text AS in_period_payments
         FROM supplier_payments sp
        CROSS JOIN ts
        WHERE sp.supplier_id = ANY($2::uuid[])
        GROUP BY sp.supplier_id
     )
     SELECT
       (SELECT opening_balance_date FROM ts) AS opening_balance_date,
       COALESCE((SELECT json_agg(row_to_json(bp)) FROM bp), '[]'::json) AS partners_json,
       COALESCE((SELECT json_agg(row_to_json(payables)) FROM payables), '[]'::json) AS payables_json,
       COALESCE((SELECT json_agg(row_to_json(payments)) FROM payments), '[]'::json) AS payments_json`,
    [params.tenantId, uniqueIds, periodStart, periodEnd],
  );

  const aggRow = aggRows[0];
  if (aggRow === undefined || aggRow.opening_balance_date === null) {
    throw new MasterDataError(404, 'TENANT_SETTINGS_NOT_FOUND', '自社設定が見つかりません。');
  }
  const openingBalanceDate = aggRow.opening_balance_date.slice(0, 10);

  const partnerRows = parseJsonRows<PartnerOpeningRow>(aggRow.partners_json);
  const openingMap = new Map(partnerRows.map((p) => [p.id, BigInt(p.opening_ap_balance)]));

  const payableAggRows = parseJsonRows<PayableAggRow>(aggRow.payables_json);
  const payableAggMap = new Map(
    payableAggRows.map((r) => [
      r.supplier_id,
      {
        before: BigInt(r.before_payables),
        inPeriodIncl: BigInt(r.in_period_payables_incl),
        inPeriodTax: BigInt(r.in_period_payables_tax),
      },
    ]),
  );

  const paymentAggRows = parseJsonRows<PaymentAggRow>(aggRow.payments_json);
  const paymentAggMap = new Map(
    paymentAggRows.map((r) => [
      r.supplier_id,
      {
        before: BigInt(r.before_payments),
        inPeriod: BigInt(r.in_period_payments),
      },
    ]),
  );

  for (const supplierId of uniqueIds) {
    const openingApBalance = openingMap.get(supplierId);
    if (openingApBalance === undefined) {
      throw new MasterDataError(404, 'SUPPLIER_NOT_FOUND', '対象の仕入先が見つかりません。');
    }

    const pAgg = payableAggMap.get(supplierId);
    const payAgg = paymentAggMap.get(supplierId);

    const beforePeriodPayables = pAgg !== undefined ? pAgg.before : 0n;
    const inPeriodPayablesIncl = pAgg !== undefined ? pAgg.inPeriodIncl : 0n;
    const inPeriodPayablesTax = pAgg !== undefined ? pAgg.inPeriodTax : 0n;
    const inPeriodPayablesExcl = inPeriodPayablesIncl - inPeriodPayablesTax;

    const beforePeriodPayments = payAgg !== undefined ? payAgg.before : 0n;
    const periodPaymentAmount = payAgg !== undefined ? payAgg.inPeriod : 0n;

    const ap = calculateApBalance({
      openingBalanceAtCutoff: openingApBalance,
      beforePeriodIncreases: beforePeriodPayables,
      beforePeriodDecreases: beforePeriodPayments,
      inPeriodIncreases: inPeriodPayablesIncl,
      inPeriodDecreases: periodPaymentAmount,
    });

    result.set(supplierId, {
      supplierId,
      openingBalanceDate,
      periodStart,
      periodEnd,
      openingApBalance,
      beforePeriodPayables,
      beforePeriodPayments,
      prevCarriedBalance: ap.carriedBalance,
      inPeriodPayablesExcl,
      inPeriodPayablesTax,
      inPeriodPayablesIncl,
      periodPaymentAmount,
      periodNetDelta: ap.periodNetDelta,
      closingApBalance: ap.closingBalance,
    });
  }

  return result;
}
