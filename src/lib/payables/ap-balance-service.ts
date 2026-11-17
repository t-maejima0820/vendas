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

/**
 * 買掛繰越・残高計算共通サービス（旧Accessバグ②是正：opening_ap_balance 基準＆複数支払全額控除）
 * - tenant_settings.opening_balance_date (D0) を起点に [D1, D2] の買掛残高推移を1円単位で算出する
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

  const tsRows = await tx.query<{ opening_balance_date: string }>(
    `SELECT opening_balance_date::text AS opening_balance_date
       FROM tenant_settings
      WHERE tenant_id = $1::uuid
      LIMIT 1`,
    [params.tenantId],
  );
  const tsRow = tsRows[0];
  if (tsRow === undefined) {
    throw new MasterDataError(404, 'TENANT_SETTINGS_NOT_FOUND', '自社設定が見つかりません。');
  }
  const openingBalanceDate = tsRow.opening_balance_date.slice(0, 10);

  const partnerRows = await tx.query<{ id: string; opening_ap_balance: string }>(
    `SELECT id, opening_ap_balance::text AS opening_ap_balance
       FROM business_partners
      WHERE id = ANY($1::uuid[])`,
    [uniqueIds],
  );
  const openingMap = new Map(partnerRows.map((p) => [p.id, BigInt(p.opening_ap_balance)]));

  const payableAggRows = await tx.query<{
    supplier_id: string;
    before_payables: string;
    in_period_payables_incl: string;
    in_period_payables_tax: string;
  }>(
    `SELECT supplier_id,
            COALESCE(SUM(payable_amount) FILTER (
              WHERE purchase_date > $2::date AND purchase_date < $3::date
            ), 0)::text AS before_payables,
            COALESCE(SUM(payable_amount) FILTER (
              WHERE purchase_date > $2::date AND purchase_date >= $3::date AND purchase_date <= $4::date
            ), 0)::text AS in_period_payables_incl,
            COALESCE(SUM(tax_total) FILTER (
              WHERE purchase_date > $2::date AND purchase_date >= $3::date AND purchase_date <= $4::date
            ), 0)::text AS in_period_payables_tax
       FROM payable_ledgers
      WHERE supplier_id = ANY($1::uuid[])
      GROUP BY supplier_id`,
    [uniqueIds, openingBalanceDate, periodStart, periodEnd],
  );
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

  const paymentAggRows = await tx.query<{
    supplier_id: string;
    before_payments: string;
    in_period_payments: string;
  }>(
    `SELECT supplier_id,
            COALESCE(SUM(
              amount_1 + amount_2 + amount_3 +
              deduction_amt_1 + deduction_amt_2 + deduction_amt_3
            ) FILTER (
              WHERE payment_date > $2::date AND payment_date < $3::date
            ), 0)::text AS before_payments,
            COALESCE(SUM(
              amount_1 + amount_2 + amount_3 +
              deduction_amt_1 + deduction_amt_2 + deduction_amt_3
            ) FILTER (
              WHERE payment_date > $2::date AND payment_date >= $3::date AND payment_date <= $4::date
            ), 0)::text AS in_period_payments
       FROM supplier_payments
      WHERE supplier_id = ANY($1::uuid[])
      GROUP BY supplier_id`,
    [uniqueIds, openingBalanceDate, periodStart, periodEnd],
  );
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
