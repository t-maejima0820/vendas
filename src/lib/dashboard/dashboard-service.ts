import {
  calculatePartnersArBalances,
  getMonthStartAndEndDates,
} from '@/lib/billing/ar-balance-service';
import { listChatThreads } from '@/lib/chat/chat-service';
import type { ChatThreadDto } from '@/lib/chat/types';
import type { DbExecutor } from '@/lib/db/tenant-client';
import {
  calculateProjectProfit,
  type CostCategory,
  type CostTaxMode,
  type RoundingMode,
  type TaxCalcPolicy,
} from '@/lib/domain/calculations';
import { COST_CATEGORY_LABELS } from '@/lib/estimates/types';
import { primeFeatureCacheForTx } from '@/lib/feature-flags/gate';
import { MasterDataError } from '@/lib/masters/error-mapper';
import { calculatePartnersApBalances } from '@/lib/payables/ap-balance-service';
import { COST_CATEGORY_LIST } from '@/lib/projects/types';

export interface DashboardOverBudgetProjectItem {
  id: string;
  projectNo: number;
  projectName: string;
  partnerName: string;
  budgetTotal: number;
  actualCostEvalTotal: number;
  budgetVarianceTotal: number;
  isTotalOverBudget: boolean;
  overCategories: string[];
}

export interface DashboardActivityItem {
  kind: 'ESTIMATE' | 'SALE' | 'BILLING' | 'PURCHASE' | 'PROJECT';
  kindLabel: string;
  docNo: string;
  title: string;
  date: string;
  amount: number;
  status: string;
  href: string;
}

export interface DashboardOverviewDto {
  companyName: string;
  openingBalanceDate: string;
  costTaxMode: CostTaxMode;
  taxCalcPolicy: TaxCalcPolicy;
  defaultRoundingMode: RoundingMode;
  approvalFlowEnabled: boolean;
  targetMonth: string;
  periodStart: string;
  periodEnd: string;
  enabledFeaturesCount: number;
  totalFeaturesCount: number;
  enabledFeatureCodes: string[];
  salesKpi: {
    saleCount: number;
    salesExclTotal: number;
    salesTaxTotal: number;
    salesInclTotal: number;
    advanceCount: number;
    advanceInclTotal: number;
  } | null;
  billingKpi: {
    billingCount: number;
    billingAmountTotal: number;
    fixedBillingCount: number;
    fixedBillingAmountTotal: number;
  } | null;
  arKpi: {
    partnerCount: number;
    prevCarriedBalanceTotal: number;
    periodBillingsTotal: number;
    periodReceiptTotal: number;
    currentArBalanceTotal: number;
  } | null;
  apKpi: {
    supplierCount: number;
    prevCarriedBalanceTotal: number;
    periodPayablesTotal: number;
    periodPaymentTotal: number;
    currentApBalanceTotal: number;
  } | null;
  projectsKpi: {
    totalCount: number;
    activeCount: number;
    contractSubtotalTotal: number;
    contractTotal: number;
    budgetTotal: number;
    actualCostExclTotal: number;
    actualCostInclTotal: number;
    actualCostEvalTotal: number;
    budgetGrossProfitTotal: number;
    actualGrossProfitTotal: number;
    overBudgetCount: number;
  } | null;
  alerts: {
    unapprovedAlert: {
      salesPendingCount: number;
      salesRejectedCount: number;
      subscriptionPendingCount: number;
      subscriptionRejectedCount: number;
      totalCount: number;
    } | null;
    unbilledSalesAlert: {
      count: number;
      totalAmount: number;
    } | null;
    unpaidBillingAlert: {
      count: number;
      billingAmountTotal: number;
      overdueCount: number;
    } | null;
    aplusFailureAlert: {
      count: number;
      unpaidAmountTotal: number;
    } | null;
    purchasingPayableAlert: {
      unconfirmedPurchaseCount: number;
      unconfirmedPurchaseAmount: number;
      unpaidPayableCount: number;
      unpaidPayableAmount: number;
    } | null;
    overBudgetProjects: DashboardOverBudgetProjectItem[] | null;
  };
  chatSummary: {
    unresolvedCount: number;
    totalCount: number;
    latestThreads: ChatThreadDto[];
  } | null;
  recentActivities: DashboardActivityItem[];
}

function normalizeTargetMonth(raw: string | null | undefined): string {
  const trimmed = raw !== undefined && raw !== null ? raw.trim() : '';
  if (trimmed === '') {
    return new Date().toISOString().slice(0, 7);
  }
  if (/^\d{4}-\d{2}$/.test(trimmed)) {
    const m = Number(trimmed.slice(5, 7));
    if (m >= 1 && m <= 12) {
      return trimmed;
    }
  }
  throw new MasterDataError(
    400,
    'INVALID_TARGET_MONTH',
    '対象月は YYYY-MM 形式で指定してください。',
  );
}

function parseJsonValue<T>(raw: T | string): T {
  if (typeof raw === 'string') {
    return JSON.parse(raw) as T;
  }
  return raw;
}

interface DashboardFeatureRow {
  feature_code: string;
  is_enabled: boolean;
}

interface DashboardSalesKpiRaw {
  sale_count: string;
  sales_excl: string;
  sales_tax: string;
  sales_incl: string;
  advance_count: string;
  advance_incl: string;
}

interface DashboardBillingKpiRaw {
  billing_count: string;
  billing_amount_total: string;
  fixed_count: string;
  fixed_amount_total: string;
}

interface DashboardProjectRaw {
  id: string;
  project_no: string;
  project_name: string;
  partner_name: string;
  status: string;
  contract_subtotal: string;
  contract_total: string;
  budget_expense: string;
  budget_labor: string;
  budget_material: string;
  budget_outsourcing: string;
  budget_temporary: string;
  budget_indirect: string;
}

interface DashboardProjectCostRaw {
  project_id: string;
  cost_category: CostCategory;
  excl_sum: string;
  incl_sum: string;
}

interface DashboardConsolidatedDbRow extends Record<string, unknown> {
  company_name: string | null;
  opening_balance_date: string | null;
  cost_tax_mode: CostTaxMode | null;
  tax_calc_policy: TaxCalcPolicy | null;
  default_rounding_mode: RoundingMode | null;
  approval_flow_enabled: boolean | null;
  features_json: DashboardFeatureRow[] | string;
  sales_kpi_json: DashboardSalesKpiRaw | string | null;
  billing_kpi_json: DashboardBillingKpiRaw | string | null;
  ar_partner_ids_json: string[] | string;
  ap_supplier_ids_json: string[] | string;
  projects_json: DashboardProjectRaw[] | string;
  project_costs_json: DashboardProjectCostRaw[] | string;
  sales_appr_json: { pending_cnt: string; rejected_cnt: string } | string | null;
  sub_appr_json: { pending_cnt: string; rejected_cnt: string } | string | null;
  unbilled_sales_json: { cnt: string; amt: string } | string | null;
  unpaid_billings_json: { cnt: string; amt: string; overdue_cnt: string } | string | null;
  aplus_fail_json: { cnt: string; unpaid: string } | string | null;
  unconfirmed_purchases_json: { cnt: string; amt: string } | string | null;
  unpaid_payables_json: { cnt: string; amt: string } | string | null;
  recent_estimates_json:
    | Array<{ id: string; no: string; title: string; dt: string; amt: string; st: string }>
    | string;
  recent_sales_json:
    | Array<{
        id: string;
        entry_type: 'SALE' | 'ADVANCE';
        no: string;
        title: string;
        dt: string;
        amt: string;
        st: string;
      }>
    | string;
  recent_billings_json:
    | Array<{
        id: string;
        no: string;
        partner_name: string;
        dt: string;
        amt: string;
        st: string;
      }>
    | string;
  recent_projects_json:
    | Array<{ id: string; no: string; title: string; dt: string; amt: string; st: string }>
    | string;
  recent_purchases_json:
    | Array<{ id: string; no: string; title: string; dt: string; amt: string; st: string }>
    | string;
}

export async function getDashboardOverview(
  tx: DbExecutor,
  tenantId: string,
  targetMonthRaw?: string | null,
): Promise<DashboardOverviewDto> {
  const targetMonth = normalizeTargetMonth(targetMonthRaw);
  const { periodStart, periodEnd } = getMonthStartAndEndDates(targetMonth.replace('-', ''));

  const consolidatedRows = await tx.query<DashboardConsolidatedDbRow>(
    `WITH ts AS (
       SELECT company_name,
              opening_balance_date::text AS opening_balance_date,
              cost_tax_mode::text AS cost_tax_mode,
              tax_calc_policy::text AS tax_calc_policy,
              default_rounding_mode::text AS default_rounding_mode,
              approval_flow_enabled
         FROM tenant_settings
        WHERE tenant_id = $1::uuid
        LIMIT 1
     ),
     feat AS (
       SELECT feature_code, is_enabled
         FROM tenant_feature_authorities
        WHERE tenant_id = $1::uuid
     ),
     flags AS (
       SELECT
         COALESCE(BOOL_OR(is_enabled AND feature_code IN ('sales', 'tatekae')), false) AS sales_ok,
         COALESCE(BOOL_OR(is_enabled AND feature_code IN ('billsummary', 'billissue', 'fixedbill')), false) AS billing_ok,
         COALESCE(BOOL_OR(is_enabled AND feature_code IN ('receivable', 'deposit')), false) AS ar_ok,
         COALESCE(BOOL_OR(is_enabled AND feature_code IN ('payable', 'payment', 'purchase')), false) AS ap_ok,
         COALESCE(BOOL_OR(is_enabled AND feature_code IN ('construction', 'budget', 'cost')), false) AS project_ok,
         COALESCE(BOOL_OR(is_enabled AND feature_code = 'aplus'), false) AS aplus_ok,
         COALESCE(BOOL_OR(is_enabled AND feature_code = 'fixedbill'), false) AS fixedbill_ok,
         COALESCE(BOOL_OR(is_enabled AND feature_code = 'estimate'), false) AS estimate_ok,
         COALESCE(BOOL_OR(is_enabled AND feature_code = 'purchase'), false) AS purchase_ok,
         COALESCE(BOOL_OR(is_enabled AND feature_code IN ('sales', 'tatekae', 'billsummary')), false) AS unbilled_ok,
         COALESCE(BOOL_OR(is_enabled AND feature_code IN ('receivable', 'deposit', 'billissue')), false) AS unpaid_bill_ok
       FROM feat
     )
     SELECT
       (SELECT company_name FROM ts) AS company_name,
       (SELECT opening_balance_date FROM ts) AS opening_balance_date,
       (SELECT cost_tax_mode FROM ts) AS cost_tax_mode,
       (SELECT tax_calc_policy FROM ts) AS tax_calc_policy,
       (SELECT default_rounding_mode FROM ts) AS default_rounding_mode,
       (SELECT approval_flow_enabled FROM ts) AS approval_flow_enabled,
       COALESCE((SELECT json_agg(row_to_json(feat)) FROM feat), '[]'::json) AS features_json,
       CASE
         WHEN (SELECT sales_ok FROM flags) THEN (
           SELECT json_build_object(
             'sale_count', COUNT(*) FILTER (WHERE entry_type = 'SALE')::text,
             'sales_excl', COALESCE(SUM(subtotal_amount) FILTER (WHERE entry_type = 'SALE'), 0)::text,
             'sales_tax', COALESCE(SUM(tax_total) FILTER (WHERE entry_type = 'SALE'), 0)::text,
             'sales_incl', COALESCE(SUM(total_amount) FILTER (WHERE entry_type = 'SALE'), 0)::text,
             'advance_count', COUNT(*) FILTER (WHERE entry_type = 'ADVANCE')::text,
             'advance_incl', COALESCE(SUM(total_amount) FILTER (WHERE entry_type = 'ADVANCE'), 0)::text
           )
             FROM sales_headers
            WHERE tenant_id = $1::uuid
              AND slip_date >= $2::date
              AND slip_date <= $3::date
         )
         ELSE NULL
       END AS sales_kpi_json,
       CASE
         WHEN (SELECT billing_ok FROM flags) THEN (
           SELECT json_build_object(
             'billing_count', COUNT(*)::text,
             'billing_amount_total', COALESCE(SUM(billing_amount), 0)::text,
             'fixed_count', COUNT(*) FILTER (WHERE is_subscription_bill = true)::text,
             'fixed_amount_total', COALESCE(SUM(billing_amount) FILTER (WHERE is_subscription_bill = true), 0)::text
           )
             FROM billing_headers
            WHERE tenant_id = $1::uuid
              AND billing_date >= $2::date
              AND billing_date <= $3::date
         )
         ELSE NULL
       END AS billing_kpi_json,
       CASE
         WHEN (SELECT ar_ok FROM flags) THEN COALESCE((
           SELECT json_agg(id)
             FROM business_partners
            WHERE tenant_id = $1::uuid
              AND is_deleted = false
              AND (is_client = true OR opening_ar_balance <> 0)
         ), '[]'::json)
         ELSE '[]'::json
       END AS ar_partner_ids_json,
       CASE
         WHEN (SELECT ap_ok FROM flags) THEN COALESCE((
           SELECT json_agg(id)
             FROM business_partners
            WHERE tenant_id = $1::uuid
              AND is_deleted = false
              AND (is_supplier = true OR opening_ap_balance <> 0)
         ), '[]'::json)
         ELSE '[]'::json
       END AS ap_supplier_ids_json,
       CASE
         WHEN (SELECT project_ok FROM flags) THEN COALESCE((
           SELECT json_agg(
             json_build_object(
               'id', pj.id,
               'project_no', pj.project_no,
               'project_name', pj.project_name,
               'partner_name', pj.partner_name,
               'status', pj.status,
               'contract_subtotal', pj.contract_subtotal,
               'contract_total', pj.contract_total,
               'budget_expense', pj.budget_expense,
               'budget_labor', pj.budget_labor,
               'budget_material', pj.budget_material,
               'budget_outsourcing', pj.budget_outsourcing,
               'budget_temporary', pj.budget_temporary,
               'budget_indirect', pj.budget_indirect
             )
             ORDER BY pj.project_date DESC, pj.project_no_num DESC
           )
             FROM (
               SELECT p.id, p.project_no::text AS project_no, p.project_no AS project_no_num,
                      p.project_date, p.project_name,
                      COALESCE(bp.partner_name, '') AS partner_name,
                      p.status::text AS status,
                      p.contract_subtotal::text AS contract_subtotal,
                      p.contract_total::text AS contract_total,
                      p.budget_expense::text AS budget_expense,
                      p.budget_labor::text AS budget_labor,
                      p.budget_material::text AS budget_material,
                      p.budget_outsourcing::text AS budget_outsourcing,
                      p.budget_temporary::text AS budget_temporary,
                      p.budget_indirect::text AS budget_indirect
                 FROM projects p
                 LEFT JOIN business_partners bp
                   ON bp.tenant_id = p.tenant_id AND bp.id = p.partner_id
                WHERE p.tenant_id = $1::uuid
             ) pj
         ), '[]'::json)
         ELSE '[]'::json
       END AS projects_json,
       CASE
         WHEN (SELECT project_ok FROM flags) THEN COALESCE((
           SELECT json_agg(row_to_json(c))
             FROM (
               SELECT project_id,
                      cost_category::text AS cost_category,
                      COALESCE(SUM(subtotal_amount), 0)::text AS excl_sum,
                      COALESCE(SUM(total_amount), 0)::text AS incl_sum
                 FROM project_cost_headers
                WHERE tenant_id = $1::uuid
                GROUP BY project_id, cost_category
             ) c
         ), '[]'::json)
         ELSE '[]'::json
       END AS project_costs_json,
       CASE
         WHEN COALESCE((SELECT approval_flow_enabled FROM ts), false)
          AND ((SELECT sales_ok FROM flags) OR (SELECT fixedbill_ok FROM flags)) THEN (
           SELECT json_build_object(
             'pending_cnt', COUNT(*) FILTER (WHERE approval_status = 0 AND status IN ('K1','K2','K3'))::text,
             'rejected_cnt', COUNT(*) FILTER (WHERE approval_status = 2 AND status IN ('K1','K2','K3'))::text
           )
             FROM sales_headers
            WHERE tenant_id = $1::uuid
         )
         ELSE NULL
       END AS sales_appr_json,
       CASE
         WHEN COALESCE((SELECT approval_flow_enabled FROM ts), false)
          AND (SELECT fixedbill_ok FROM flags) THEN (
           SELECT json_build_object(
             'pending_cnt', COUNT(*) FILTER (WHERE flow_status = 0)::text,
             'rejected_cnt', COUNT(*) FILTER (WHERE flow_status = 2)::text
           )
             FROM subscription_approval_flows
            WHERE tenant_id = $1::uuid
         )
         ELSE NULL
       END AS sub_appr_json,
       CASE
         WHEN (SELECT unbilled_ok FROM flags) THEN (
           SELECT json_build_object(
             'cnt', COUNT(*)::text,
             'amt', COALESCE(SUM(total_amount), 0)::text
           )
             FROM sales_headers
            WHERE tenant_id = $1::uuid
              AND status IN ('K1', 'K2', 'K3')
         )
         ELSE NULL
       END AS unbilled_sales_json,
       CASE
         WHEN (SELECT unpaid_bill_ok FROM flags) THEN (
           SELECT json_build_object(
             'cnt', COUNT(*)::text,
             'amt', COALESCE(SUM(billing_amount), 0)::text,
             'overdue_cnt', COUNT(*) FILTER (WHERE payment_due_date IS NOT NULL AND payment_due_date < CURRENT_DATE)::text
           )
             FROM billing_headers
            WHERE tenant_id = $1::uuid
              AND status IN ('N1', 'N2')
         )
         ELSE NULL
       END AS unpaid_billings_json,
       CASE
         WHEN (SELECT aplus_ok FROM flags) THEN (
           SELECT json_build_object(
             'cnt', COUNT(*)::text,
             'unpaid', COALESCE(SUM(unpaid_amount), 0)::text
           )
             FROM aplus_imports
            WHERE tenant_id = $1::uuid
              AND (result_code <> '0' OR unpaid_amount > 0)
         )
         ELSE NULL
       END AS aplus_fail_json,
       CASE
         WHEN (SELECT ap_ok FROM flags) THEN (
           SELECT json_build_object(
             'cnt', COUNT(*)::text,
             'amt', COALESCE(SUM(total_amount), 0)::text
           )
             FROM purchases
            WHERE tenant_id = $1::uuid
              AND status IN ('P1', 'P2')
         )
         ELSE NULL
       END AS unconfirmed_purchases_json,
       CASE
         WHEN (SELECT ap_ok FROM flags) THEN (
           SELECT json_build_object(
             'cnt', COUNT(*)::text,
             'amt', COALESCE(SUM(payable_amount), 0)::text
           )
             FROM payable_ledgers
            WHERE tenant_id = $1::uuid
              AND status = 'A1'
         )
         ELSE NULL
       END AS unpaid_payables_json,
       CASE
         WHEN (SELECT estimate_ok FROM flags) THEN COALESCE((
           SELECT json_agg(
             json_build_object('id', q.id, 'no', q.no, 'title', q.title, 'dt', q.dt, 'amt', q.amt, 'st', q.st)
             ORDER BY q.updated_at DESC
           )
             FROM (
               SELECT id, quotation_no::text AS no, quotation_name AS title,
                      quotation_date::text AS dt, total_amount::text AS amt,
                      status::text AS st, updated_at
                 FROM quotations
                WHERE tenant_id = $1::uuid
                ORDER BY updated_at DESC
                LIMIT 4
             ) q
         ), '[]'::json)
         ELSE '[]'::json
       END AS recent_estimates_json,
       CASE
         WHEN (SELECT sales_ok FROM flags) THEN COALESCE((
           SELECT json_agg(
             json_build_object('id', s.id, 'entry_type', s.entry_type, 'no', s.no, 'title', s.title, 'dt', s.dt, 'amt', s.amt, 'st', s.st)
             ORDER BY s.updated_at DESC
           )
             FROM (
               SELECT id, entry_type::text AS entry_type, slip_no::text AS no, slip_name AS title,
                      slip_date::text AS dt, total_amount::text AS amt,
                      status::text AS st, updated_at
                 FROM sales_headers
                WHERE tenant_id = $1::uuid
                ORDER BY updated_at DESC
                LIMIT 4
             ) s
         ), '[]'::json)
         ELSE '[]'::json
       END AS recent_sales_json,
       CASE
         WHEN (SELECT billing_ok FROM flags) THEN COALESCE((
           SELECT json_agg(
             json_build_object('id', b.id, 'no', b.no, 'partner_name', b.partner_name, 'dt', b.dt, 'amt', b.amt, 'st', b.st)
             ORDER BY b.updated_at DESC
           )
             FROM (
               SELECT bh.id, bh.billing_no::text AS no, COALESCE(bp.partner_name, '') AS partner_name,
                      bh.billing_date::text AS dt, bh.billing_amount::text AS amt,
                      bh.status::text AS st, bh.updated_at
                 FROM billing_headers bh
                 LEFT JOIN business_partners bp
                   ON bp.tenant_id = bh.tenant_id AND bp.id = bh.partner_id
                WHERE bh.tenant_id = $1::uuid
                ORDER BY bh.updated_at DESC
                LIMIT 4
             ) b
         ), '[]'::json)
         ELSE '[]'::json
       END AS recent_billings_json,
       CASE
         WHEN (SELECT project_ok FROM flags) THEN COALESCE((
           SELECT json_agg(
             json_build_object('id', pj.id, 'no', pj.no, 'title', pj.title, 'dt', pj.dt, 'amt', pj.amt, 'st', pj.st)
             ORDER BY pj.updated_at DESC
           )
             FROM (
               SELECT id, project_no::text AS no, project_name AS title,
                      project_date::text AS dt, contract_total::text AS amt,
                      status::text AS st, updated_at
                 FROM projects
                WHERE tenant_id = $1::uuid
                ORDER BY updated_at DESC
                LIMIT 4
             ) pj
         ), '[]'::json)
         ELSE '[]'::json
       END AS recent_projects_json,
       CASE
         WHEN (SELECT purchase_ok FROM flags) THEN COALESCE((
           SELECT json_agg(
             json_build_object('id', pu.id, 'no', pu.no, 'title', pu.title, 'dt', pu.dt, 'amt', pu.amt, 'st', pu.st)
             ORDER BY pu.updated_at DESC
           )
             FROM (
               SELECT id, purchase_no::text AS no, purchase_name AS title,
                      purchase_date::text AS dt, total_amount::text AS amt,
                      status::text AS st, updated_at
                 FROM purchases
                WHERE tenant_id = $1::uuid
                ORDER BY updated_at DESC
                LIMIT 4
             ) pu
         ), '[]'::json)
         ELSE '[]'::json
       END AS recent_purchases_json`,
    [tenantId, periodStart, periodEnd],
  );

  const dbRow = consolidatedRows[0];
  if (
    dbRow === undefined ||
    dbRow.company_name === null ||
    dbRow.opening_balance_date === null ||
    dbRow.cost_tax_mode === null ||
    dbRow.tax_calc_policy === null ||
    dbRow.default_rounding_mode === null ||
    dbRow.approval_flow_enabled === null
  ) {
    throw new MasterDataError(404, 'TENANT_SETTINGS_NOT_FOUND', '自社設定が見つかりません。');
  }

  const featRows = parseJsonValue<DashboardFeatureRow[]>(dbRow.features_json);
  const featCacheMap = new Map<string, boolean>();
  for (const f of featRows) {
    featCacheMap.set(f.feature_code, f.is_enabled === true);
  }
  primeFeatureCacheForTx(tx, tenantId, featCacheMap);

  const enabledCodes = featRows.filter((f) => f.is_enabled).map((f) => f.feature_code);
  const enabledSet = new Set(enabledCodes);
  const hasAny = (...codes: string[]) => codes.some((c) => enabledSet.has(c));

  const salesEnabled = hasAny('sales', 'tatekae');
  const billingEnabled = hasAny('billsummary', 'billissue', 'fixedbill');
  const arEnabled = hasAny('receivable', 'deposit');
  const apEnabled = hasAny('payable', 'payment', 'purchase');
  const projectEnabled = hasAny('construction', 'budget', 'cost');
  const aplusEnabled = enabledSet.has('aplus');
  const teamsEnabled = enabledSet.has('teams');

  let salesKpi: DashboardOverviewDto['salesKpi'] = null;
  if (salesEnabled && dbRow.sales_kpi_json !== null) {
    const sr = parseJsonValue<DashboardSalesKpiRaw>(dbRow.sales_kpi_json);
    salesKpi = {
      saleCount: Number(sr.sale_count),
      salesExclTotal: Number(sr.sales_excl),
      salesTaxTotal: Number(sr.sales_tax),
      salesInclTotal: Number(sr.sales_incl),
      advanceCount: Number(sr.advance_count),
      advanceInclTotal: Number(sr.advance_incl),
    };
  }

  let billingKpi: DashboardOverviewDto['billingKpi'] = null;
  if (billingEnabled && dbRow.billing_kpi_json !== null) {
    const br = parseJsonValue<DashboardBillingKpiRaw>(dbRow.billing_kpi_json);
    billingKpi = {
      billingCount: Number(br.billing_count),
      billingAmountTotal: Number(br.billing_amount_total),
      fixedBillingCount: Number(br.fixed_count),
      fixedBillingAmountTotal: Number(br.fixed_amount_total),
    };
  }

  let arKpi: DashboardOverviewDto['arKpi'] = null;
  if (arEnabled) {
    const partnerIds = parseJsonValue<string[]>(dbRow.ar_partner_ids_json);
    const arMap = await calculatePartnersArBalances(tx, {
      tenantId,
      partnerIds,
      periodStart,
      periodEnd,
    });
    let prevSum = 0n;
    let billSum = 0n;
    let recSum = 0n;
    let closeSum = 0n;
    for (const summary of arMap.values()) {
      prevSum += summary.prevCarriedBalance;
      billSum += summary.inPeriodBillings;
      recSum += summary.periodReceiptAmount;
      closeSum += summary.closingBalanceExisting;
    }
    arKpi = {
      partnerCount: arMap.size,
      prevCarriedBalanceTotal: Number(prevSum),
      periodBillingsTotal: Number(billSum),
      periodReceiptTotal: Number(recSum),
      currentArBalanceTotal: Number(closeSum),
    };
  }

  let apKpi: DashboardOverviewDto['apKpi'] = null;
  if (apEnabled) {
    const supplierIds = parseJsonValue<string[]>(dbRow.ap_supplier_ids_json);
    const apMap = await calculatePartnersApBalances(tx, {
      tenantId,
      supplierIds,
      periodStart,
      periodEnd,
    });
    let prevSum = 0n;
    let purSum = 0n;
    let paySum = 0n;
    let closeSum = 0n;
    for (const summary of apMap.values()) {
      prevSum += summary.prevCarriedBalance;
      purSum += summary.inPeriodPayablesIncl;
      paySum += summary.periodPaymentAmount;
      closeSum += summary.closingApBalance;
    }
    apKpi = {
      supplierCount: apMap.size,
      prevCarriedBalanceTotal: Number(prevSum),
      periodPayablesTotal: Number(purSum),
      periodPaymentTotal: Number(paySum),
      currentApBalanceTotal: Number(closeSum),
    };
  }

  let projectsKpi: DashboardOverviewDto['projectsKpi'] = null;
  let overBudgetProjects: DashboardOverBudgetProjectItem[] | null = null;
  if (projectEnabled) {
    const pjRows = parseJsonValue<DashboardProjectRaw[]>(dbRow.projects_json);
    const costRows = parseJsonValue<DashboardProjectCostRaw[]>(dbRow.project_costs_json);
    const costTaxMode = dbRow.cost_tax_mode;

    const costByProject = new Map<
      string,
      { excl: Record<CostCategory, bigint>; incl: Record<CostCategory, bigint> }
    >();
    for (const cr of costRows) {
      let bucket = costByProject.get(cr.project_id);
      if (bucket === undefined) {
        bucket = {
          excl: {
            EXPENSE: 0n,
            LABOR: 0n,
            MATERIAL: 0n,
            OUTSOURCING: 0n,
            TEMPORARY: 0n,
            INDIRECT: 0n,
          },
          incl: {
            EXPENSE: 0n,
            LABOR: 0n,
            MATERIAL: 0n,
            OUTSOURCING: 0n,
            TEMPORARY: 0n,
            INDIRECT: 0n,
          },
        };
        costByProject.set(cr.project_id, bucket);
      }
      bucket.excl[cr.cost_category] += BigInt(cr.excl_sum);
      bucket.incl[cr.cost_category] += BigInt(cr.incl_sum);
    }

    let activeCount = 0;
    let contractSubtotalSum = 0n;
    let contractTotalSum = 0n;
    let budgetSum = 0n;
    let actualExclSum = 0n;
    let actualInclSum = 0n;
    let actualEvalSum = 0n;
    let budgetGpSum = 0n;
    let actualGpSum = 0n;
    let overBudgetTotalCount = 0;
    const overList: DashboardOverBudgetProjectItem[] = [];

    for (const pj of pjRows) {
      if (pj.status === 'C1' || pj.status === 'C2') {
        activeCount += 1;
      }
      const budgets: Record<CostCategory, bigint> = {
        EXPENSE: BigInt(pj.budget_expense),
        LABOR: BigInt(pj.budget_labor),
        MATERIAL: BigInt(pj.budget_material),
        OUTSOURCING: BigInt(pj.budget_outsourcing),
        TEMPORARY: BigInt(pj.budget_temporary),
        INDIRECT: BigInt(pj.budget_indirect),
      };
      const costs = costByProject.get(pj.id) ?? {
        excl: {
          EXPENSE: 0n,
          LABOR: 0n,
          MATERIAL: 0n,
          OUTSOURCING: 0n,
          TEMPORARY: 0n,
          INDIRECT: 0n,
        },
        incl: {
          EXPENSE: 0n,
          LABOR: 0n,
          MATERIAL: 0n,
          OUTSOURCING: 0n,
          TEMPORARY: 0n,
          INDIRECT: 0n,
        },
      };

      const profit = calculateProjectProfit({
        costTaxMode,
        contractSubtotal: BigInt(pj.contract_subtotal),
        contractTotal: BigInt(pj.contract_total),
        budgets,
        actualCostsExcl: costs.excl,
        actualCostsIncl: costs.incl,
      });

      contractSubtotalSum += BigInt(pj.contract_subtotal);
      contractTotalSum += BigInt(pj.contract_total);
      budgetSum += profit.budgetTotal;
      actualEvalSum += profit.actualCostTotal;
      budgetGpSum += profit.budgetGrossProfit;
      actualGpSum += profit.actualGrossProfit;

      const overCats: string[] = [];
      for (const cat of COST_CATEGORY_LIST) {
        actualExclSum += costs.excl[cat];
        actualInclSum += costs.incl[cat];
        const evalCat = costTaxMode === 'TAX_EXCLUDED' ? costs.excl[cat] : costs.incl[cat];
        if (evalCat > budgets[cat]) {
          overCats.push(COST_CATEGORY_LABELS[cat]);
        }
      }

      const isTotalOverBudget = profit.budgetVarianceTotal < 0n;
      if (isTotalOverBudget) {
        overBudgetTotalCount += 1;
      }
      if (isTotalOverBudget || overCats.length > 0) {
        overList.push({
          id: pj.id,
          projectNo: Number(pj.project_no),
          projectName: pj.project_name,
          partnerName: pj.partner_name,
          budgetTotal: Number(profit.budgetTotal),
          actualCostEvalTotal: Number(profit.actualCostTotal),
          budgetVarianceTotal: Number(profit.budgetVarianceTotal),
          isTotalOverBudget,
          overCategories: overCats,
        });
      }
    }

    projectsKpi = {
      totalCount: pjRows.length,
      activeCount,
      contractSubtotalTotal: Number(contractSubtotalSum),
      contractTotal: Number(contractTotalSum),
      budgetTotal: Number(budgetSum),
      actualCostExclTotal: Number(actualExclSum),
      actualCostInclTotal: Number(actualInclSum),
      actualCostEvalTotal: Number(actualEvalSum),
      budgetGrossProfitTotal: Number(budgetGpSum),
      actualGrossProfitTotal: Number(actualGpSum),
      overBudgetCount: overBudgetTotalCount,
    };
    overBudgetProjects = overList.slice(0, 10);
  }

  let unapprovedAlert: DashboardOverviewDto['alerts']['unapprovedAlert'] = null;
  if (dbRow.approval_flow_enabled && (salesEnabled || enabledSet.has('fixedbill'))) {
    const sh =
      dbRow.sales_appr_json !== null
        ? parseJsonValue<{ pending_cnt: string; rejected_cnt: string }>(dbRow.sales_appr_json)
        : null;
    const sub =
      dbRow.sub_appr_json !== null
        ? parseJsonValue<{ pending_cnt: string; rejected_cnt: string }>(dbRow.sub_appr_json)
        : null;
    const sPending = Number(sh !== null ? sh.pending_cnt : '0');
    const sRej = Number(sh !== null ? sh.rejected_cnt : '0');
    const fPending = Number(sub !== null ? sub.pending_cnt : '0');
    const fRej = Number(sub !== null ? sub.rejected_cnt : '0');
    unapprovedAlert = {
      salesPendingCount: sPending,
      salesRejectedCount: sRej,
      subscriptionPendingCount: fPending,
      subscriptionRejectedCount: fRej,
      totalCount: sPending + sRej + fPending + fRej,
    };
  }

  let unbilledSalesAlert: DashboardOverviewDto['alerts']['unbilledSalesAlert'] = null;
  if (hasAny('sales', 'tatekae', 'billsummary') && dbRow.unbilled_sales_json !== null) {
    const ur = parseJsonValue<{ cnt: string; amt: string }>(dbRow.unbilled_sales_json);
    unbilledSalesAlert = {
      count: Number(ur.cnt),
      totalAmount: Number(ur.amt),
    };
  }

  let unpaidBillingAlert: DashboardOverviewDto['alerts']['unpaidBillingAlert'] = null;
  if (hasAny('receivable', 'deposit', 'billissue') && dbRow.unpaid_billings_json !== null) {
    const ubr = parseJsonValue<{ cnt: string; amt: string; overdue_cnt: string }>(
      dbRow.unpaid_billings_json,
    );
    unpaidBillingAlert = {
      count: Number(ubr.cnt),
      billingAmountTotal: Number(ubr.amt),
      overdueCount: Number(ubr.overdue_cnt),
    };
  }

  let aplusFailureAlert: DashboardOverviewDto['alerts']['aplusFailureAlert'] = null;
  if (aplusEnabled && dbRow.aplus_fail_json !== null) {
    const afr = parseJsonValue<{ cnt: string; unpaid: string }>(dbRow.aplus_fail_json);
    aplusFailureAlert = {
      count: Number(afr.cnt),
      unpaidAmountTotal: Number(afr.unpaid),
    };
  }

  let purchasingPayableAlert: DashboardOverviewDto['alerts']['purchasingPayableAlert'] = null;
  if (apEnabled) {
    const pur =
      dbRow.unconfirmed_purchases_json !== null
        ? parseJsonValue<{ cnt: string; amt: string }>(dbRow.unconfirmed_purchases_json)
        : null;
    const pay =
      dbRow.unpaid_payables_json !== null
        ? parseJsonValue<{ cnt: string; amt: string }>(dbRow.unpaid_payables_json)
        : null;
    purchasingPayableAlert = {
      unconfirmedPurchaseCount: Number(pur !== null ? pur.cnt : '0'),
      unconfirmedPurchaseAmount: Number(pur !== null ? pur.amt : '0'),
      unpaidPayableCount: Number(pay !== null ? pay.cnt : '0'),
      unpaidPayableAmount: Number(pay !== null ? pay.amt : '0'),
    };
  }

  let chatSummary: DashboardOverviewDto['chatSummary'] = null;
  if (teamsEnabled) {
    const chatPage = await listChatThreads(tx, tenantId, {});
    chatSummary = {
      unresolvedCount: chatPage.unresolvedCount,
      totalCount: chatPage.totalCount,
      latestThreads: chatPage.items.slice(0, 5),
    };
  }

  const allActivities: DashboardActivityItem[] = [];
  if (enabledSet.has('estimate')) {
    const rows = parseJsonValue<
      Array<{ id: string; no: string; title: string; dt: string; amt: string; st: string }>
    >(dbRow.recent_estimates_json);
    for (const r of rows) {
      allActivities.push({
        kind: 'ESTIMATE',
        kindLabel: '見積',
        docNo: r.no,
        title: r.title,
        date: r.dt.slice(0, 10),
        amount: Number(r.amt),
        status: r.st,
        href: `/estimates/${r.id}`,
      });
    }
  }
  if (salesEnabled) {
    const rows = parseJsonValue<
      Array<{
        id: string;
        entry_type: 'SALE' | 'ADVANCE';
        no: string;
        title: string;
        dt: string;
        amt: string;
        st: string;
      }>
    >(dbRow.recent_sales_json);
    for (const r of rows) {
      allActivities.push({
        kind: 'SALE',
        kindLabel: r.entry_type === 'ADVANCE' ? '立替金' : '売上',
        docNo: r.no,
        title: r.title,
        date: r.dt.slice(0, 10),
        amount: Number(r.amt),
        status: r.st,
        href: `/sales/${r.id}`,
      });
    }
  }
  if (billingEnabled) {
    const rows = parseJsonValue<
      Array<{ id: string; no: string; partner_name: string; dt: string; amt: string; st: string }>
    >(dbRow.recent_billings_json);
    for (const r of rows) {
      allActivities.push({
        kind: 'BILLING',
        kindLabel: '請求確定',
        docNo: r.no,
        title: `${r.partner_name} 請求書`,
        date: r.dt.slice(0, 10),
        amount: Number(r.amt),
        status: r.st,
        href: `/billing/${r.id}`,
      });
    }
  }
  if (projectEnabled) {
    const rows = parseJsonValue<
      Array<{ id: string; no: string; title: string; dt: string; amt: string; st: string }>
    >(dbRow.recent_projects_json);
    for (const r of rows) {
      allActivities.push({
        kind: 'PROJECT',
        kindLabel: '案件',
        docNo: r.no,
        title: r.title,
        date: r.dt.slice(0, 10),
        amount: Number(r.amt),
        status: r.st,
        href: `/projects/${r.id}`,
      });
    }
  }
  if (enabledSet.has('purchase')) {
    const rows = parseJsonValue<
      Array<{ id: string; no: string; title: string; dt: string; amt: string; st: string }>
    >(dbRow.recent_purchases_json);
    for (const r of rows) {
      allActivities.push({
        kind: 'PURCHASE',
        kindLabel: '仕入',
        docNo: r.no,
        title: r.title,
        date: r.dt.slice(0, 10),
        amount: Number(r.amt),
        status: r.st,
        href: '/purchasing?tab=PURCHASES',
      });
    }
  }

  const recentActivities = allActivities
    .sort((a, b) => b.date.localeCompare(a.date))
    .slice(0, 8);

  return {
    companyName: dbRow.company_name,
    openingBalanceDate: dbRow.opening_balance_date.slice(0, 10),
    costTaxMode: dbRow.cost_tax_mode,
    taxCalcPolicy: dbRow.tax_calc_policy,
    defaultRoundingMode: dbRow.default_rounding_mode,
    approvalFlowEnabled: dbRow.approval_flow_enabled,
    targetMonth,
    periodStart,
    periodEnd,
    enabledFeaturesCount: enabledCodes.length,
    totalFeaturesCount: featRows.length,
    enabledFeatureCodes: enabledCodes,
    salesKpi,
    billingKpi,
    arKpi,
    apKpi,
    projectsKpi,
    alerts: {
      unapprovedAlert,
      unbilledSalesAlert,
      unpaidBillingAlert,
      aplusFailureAlert,
      purchasingPayableAlert,
      overBudgetProjects,
    },
    chatSummary,
    recentActivities,
  };
}
