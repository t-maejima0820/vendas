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

export async function getDashboardOverview(
  tx: DbExecutor,
  tenantId: string,
  targetMonthRaw?: string | null,
): Promise<DashboardOverviewDto> {
  const targetMonth = normalizeTargetMonth(targetMonthRaw);
  const { periodStart, periodEnd } = getMonthStartAndEndDates(targetMonth.replace('-', ''));

  const [tsRows, featRows] = await Promise.all([
    tx.query<{
      company_name: string;
      opening_balance_date: string;
      cost_tax_mode: CostTaxMode;
      tax_calc_policy: TaxCalcPolicy;
      default_rounding_mode: RoundingMode;
      approval_flow_enabled: boolean;
    }>(
      `SELECT company_name,
              opening_balance_date::text AS opening_balance_date,
              cost_tax_mode::text AS cost_tax_mode,
              tax_calc_policy::text AS tax_calc_policy,
              default_rounding_mode::text AS default_rounding_mode,
              approval_flow_enabled
         FROM tenant_settings
        WHERE tenant_id = $1::uuid
        LIMIT 1`,
      [tenantId],
    ),
    tx.query<{ feature_code: string; is_enabled: boolean }>(
      `SELECT feature_code, is_enabled
         FROM tenant_feature_authorities
        WHERE tenant_id = $1::uuid`,
      [tenantId],
    ),
  ]);

  const ts = tsRows[0];
  if (ts === undefined) {
    throw new MasterDataError(404, 'TENANT_SETTINGS_NOT_FOUND', '自社設定が見つかりません。');
  }

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

  // 1. 当月売上・立替KPI
  let salesKpi: DashboardOverviewDto['salesKpi'] = null;
  if (salesEnabled) {
    const sRows = await tx.query<{
      sale_count: string;
      sales_excl: string;
      sales_tax: string;
      sales_incl: string;
      advance_count: string;
      advance_incl: string;
    }>(
      `SELECT COUNT(*) FILTER (WHERE entry_type = 'SALE')::text AS sale_count,
              COALESCE(SUM(subtotal_amount) FILTER (WHERE entry_type = 'SALE'), 0)::text AS sales_excl,
              COALESCE(SUM(tax_total) FILTER (WHERE entry_type = 'SALE'), 0)::text AS sales_tax,
              COALESCE(SUM(total_amount) FILTER (WHERE entry_type = 'SALE'), 0)::text AS sales_incl,
              COUNT(*) FILTER (WHERE entry_type = 'ADVANCE')::text AS advance_count,
              COALESCE(SUM(total_amount) FILTER (WHERE entry_type = 'ADVANCE'), 0)::text AS advance_incl
         FROM sales_headers
        WHERE tenant_id = $1::uuid
          AND slip_date >= $2::date
          AND slip_date <= $3::date`,
      [tenantId, periodStart, periodEnd],
    );
    const sr = sRows[0];
    salesKpi = {
      saleCount: sr !== undefined ? Number(sr.sale_count) : 0,
      salesExclTotal: sr !== undefined ? Number(sr.sales_excl) : 0,
      salesTaxTotal: sr !== undefined ? Number(sr.sales_tax) : 0,
      salesInclTotal: sr !== undefined ? Number(sr.sales_incl) : 0,
      advanceCount: sr !== undefined ? Number(sr.advance_count) : 0,
      advanceInclTotal: sr !== undefined ? Number(sr.advance_incl) : 0,
    };
  }

  // 2. 当月請求確定KPI
  let billingKpi: DashboardOverviewDto['billingKpi'] = null;
  if (billingEnabled) {
    const bRows = await tx.query<{
      billing_count: string;
      billing_amount_total: string;
      fixed_count: string;
      fixed_amount_total: string;
    }>(
      `SELECT COUNT(*)::text AS billing_count,
              COALESCE(SUM(billing_amount), 0)::text AS billing_amount_total,
              COUNT(*) FILTER (WHERE is_subscription_bill = true)::text AS fixed_count,
              COALESCE(SUM(billing_amount) FILTER (WHERE is_subscription_bill = true), 0)::text AS fixed_amount_total
         FROM billing_headers
        WHERE tenant_id = $1::uuid
          AND billing_date >= $2::date
          AND billing_date <= $3::date`,
      [tenantId, periodStart, periodEnd],
    );
    const br = bRows[0];
    billingKpi = {
      billingCount: br !== undefined ? Number(br.billing_count) : 0,
      billingAmountTotal: br !== undefined ? Number(br.billing_amount_total) : 0,
      fixedBillingCount: br !== undefined ? Number(br.fixed_count) : 0,
      fixedBillingAmountTotal: br !== undefined ? Number(br.fixed_amount_total) : 0,
    };
  }

  // 3. 売掛残高KPI（ar-balance-service 共通ロジック使用）
  let arKpi: DashboardOverviewDto['arKpi'] = null;
  if (arEnabled) {
    const clientRows = await tx.query<{ id: string }>(
      `SELECT id
         FROM business_partners
        WHERE tenant_id = $1::uuid
          AND is_deleted = false
          AND (is_client = true OR opening_ar_balance <> 0)`,
      [tenantId],
    );
    const partnerIds = clientRows.map((c) => c.id);
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

  // 4. 買掛残高KPI（ap-balance-service 共通ロジック使用）
  let apKpi: DashboardOverviewDto['apKpi'] = null;
  if (apEnabled) {
    const supplierRows = await tx.query<{ id: string }>(
      `SELECT id
         FROM business_partners
        WHERE tenant_id = $1::uuid
          AND is_deleted = false
          AND (is_supplier = true OR opening_ap_balance <> 0)`,
      [tenantId],
    );
    const supplierIds = supplierRows.map((s) => s.id);
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

  // 5. 稼働中案件契約・原価・粗利サマリ ＆ 予算超過アラート（calculateProjectProfit 一貫使用）
  let projectsKpi: DashboardOverviewDto['projectsKpi'] = null;
  let overBudgetProjects: DashboardOverBudgetProjectItem[] | null = null;
  if (projectEnabled) {
    const pjRows = await tx.query<{
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
    }>(
      `SELECT p.id, p.project_no::text AS project_no, p.project_name,
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
        ORDER BY p.project_date DESC, p.project_no DESC`,
      [tenantId],
    );

    const costRows = await tx.query<{
      project_id: string;
      cost_category: CostCategory;
      excl_sum: string;
      incl_sum: string;
    }>(
      `SELECT project_id,
              cost_category::text AS cost_category,
              COALESCE(SUM(subtotal_amount), 0)::text AS excl_sum,
              COALESCE(SUM(total_amount), 0)::text AS incl_sum
         FROM project_cost_headers
        WHERE tenant_id = $1::uuid
        GROUP BY project_id, cost_category`,
      [tenantId],
    );

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
        costTaxMode: ts.cost_tax_mode,
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
        const evalCat = ts.cost_tax_mode === 'TAX_EXCLUDED' ? costs.excl[cat] : costs.incl[cat];
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

  // 6. 要対応アラート群
  let unapprovedAlert: DashboardOverviewDto['alerts']['unapprovedAlert'] = null;
  if (ts.approval_flow_enabled && (salesEnabled || enabledSet.has('fixedbill'))) {
    const [shAppr, subAppr] = await Promise.all([
      tx.query<{ pending_cnt: string; rejected_cnt: string }>(
        `SELECT COUNT(*) FILTER (WHERE approval_status = 0 AND status IN ('K1','K2','K3'))::text AS pending_cnt,
                COUNT(*) FILTER (WHERE approval_status = 2 AND status IN ('K1','K2','K3'))::text AS rejected_cnt
           FROM sales_headers
          WHERE tenant_id = $1::uuid`,
        [tenantId],
      ),
      enabledSet.has('fixedbill')
        ? tx.query<{ pending_cnt: string; rejected_cnt: string }>(
            `SELECT COUNT(*) FILTER (WHERE flow_status = 0)::text AS pending_cnt,
                    COUNT(*) FILTER (WHERE flow_status = 2)::text AS rejected_cnt
               FROM subscription_approval_flows
              WHERE tenant_id = $1::uuid`,
            [tenantId],
          )
        : Promise.resolve([{ pending_cnt: '0', rejected_cnt: '0' }]),
    ]);
    const sPending = Number(shAppr[0]?.pending_cnt ?? '0');
    const sRej = Number(shAppr[0]?.rejected_cnt ?? '0');
    const fPending = Number(subAppr[0]?.pending_cnt ?? '0');
    const fRej = Number(subAppr[0]?.rejected_cnt ?? '0');
    unapprovedAlert = {
      salesPendingCount: sPending,
      salesRejectedCount: sRej,
      subscriptionPendingCount: fPending,
      subscriptionRejectedCount: fRej,
      totalCount: sPending + sRej + fPending + fRej,
    };
  }

  let unbilledSalesAlert: DashboardOverviewDto['alerts']['unbilledSalesAlert'] = null;
  if (hasAny('sales', 'tatekae', 'billsummary')) {
    const rows = await tx.query<{ cnt: string; amt: string }>(
      `SELECT COUNT(*)::text AS cnt,
              COALESCE(SUM(total_amount), 0)::text AS amt
         FROM sales_headers
        WHERE tenant_id = $1::uuid
          AND status IN ('K1', 'K2', 'K3')`,
      [tenantId],
    );
    unbilledSalesAlert = {
      count: Number(rows[0]?.cnt ?? '0'),
      totalAmount: Number(rows[0]?.amt ?? '0'),
    };
  }

  let unpaidBillingAlert: DashboardOverviewDto['alerts']['unpaidBillingAlert'] = null;
  if (hasAny('receivable', 'deposit', 'billissue')) {
    const rows = await tx.query<{ cnt: string; amt: string; overdue_cnt: string }>(
      `SELECT COUNT(*)::text AS cnt,
              COALESCE(SUM(billing_amount), 0)::text AS amt,
              COUNT(*) FILTER (WHERE payment_due_date IS NOT NULL AND payment_due_date < CURRENT_DATE)::text AS overdue_cnt
         FROM billing_headers
        WHERE tenant_id = $1::uuid
          AND status IN ('N1', 'N2')`,
      [tenantId],
    );
    unpaidBillingAlert = {
      count: Number(rows[0]?.cnt ?? '0'),
      billingAmountTotal: Number(rows[0]?.amt ?? '0'),
      overdueCount: Number(rows[0]?.overdue_cnt ?? '0'),
    };
  }

  let aplusFailureAlert: DashboardOverviewDto['alerts']['aplusFailureAlert'] = null;
  if (aplusEnabled) {
    const rows = await tx.query<{ cnt: string; unpaid: string }>(
      `SELECT COUNT(*)::text AS cnt,
              COALESCE(SUM(unpaid_amount), 0)::text AS unpaid
         FROM aplus_imports
        WHERE tenant_id = $1::uuid
          AND (result_code <> '0' OR unpaid_amount > 0)`,
      [tenantId],
    );
    aplusFailureAlert = {
      count: Number(rows[0]?.cnt ?? '0'),
      unpaidAmountTotal: Number(rows[0]?.unpaid ?? '0'),
    };
  }

  let purchasingPayableAlert: DashboardOverviewDto['alerts']['purchasingPayableAlert'] = null;
  if (apEnabled) {
    const [purRows, payRows] = await Promise.all([
      tx.query<{ cnt: string; amt: string }>(
        `SELECT COUNT(*)::text AS cnt,
                COALESCE(SUM(total_amount), 0)::text AS amt
           FROM purchases
          WHERE tenant_id = $1::uuid
            AND status IN ('P1', 'P2')`,
        [tenantId],
      ),
      tx.query<{ cnt: string; amt: string }>(
        `SELECT COUNT(*)::text AS cnt,
                COALESCE(SUM(payable_amount), 0)::text AS amt
           FROM payable_ledgers
          WHERE tenant_id = $1::uuid
            AND status = 'A1'`,
        [tenantId],
      ),
    ]);
    purchasingPayableAlert = {
      unconfirmedPurchaseCount: Number(purRows[0]?.cnt ?? '0'),
      unconfirmedPurchaseAmount: Number(purRows[0]?.amt ?? '0'),
      unpaidPayableCount: Number(payRows[0]?.cnt ?? '0'),
      unpaidPayableAmount: Number(payRows[0]?.amt ?? '0'),
    };
  }

  // 7. 社内チャット新着サマリ（teams 有効時のみ）
  let chatSummary: DashboardOverviewDto['chatSummary'] = null;
  if (teamsEnabled) {
    const chatPage = await listChatThreads(tx, tenantId, {});
    chatSummary = {
      unresolvedCount: chatPage.unresolvedCount,
      totalCount: chatPage.totalCount,
      latestThreads: chatPage.items.slice(0, 5),
    };
  }

  // 8. 最近の業務アクティビティ（有効モジュールのみ）
  const activityQueries: Promise<DashboardActivityItem[]>[] = [];
  if (enabledSet.has('estimate')) {
    activityQueries.push(
      tx
        .query<{
          id: string;
          no: string;
          title: string;
          dt: string;
          amt: string;
          st: string;
        }>(
          `SELECT id, quotation_no::text AS no, quotation_name AS title,
                  quotation_date::text AS dt, total_amount::text AS amt, status::text AS st
             FROM quotations
            WHERE tenant_id = $1::uuid
            ORDER BY updated_at DESC
            LIMIT 4`,
          [tenantId],
        )
        .then((rows) =>
          rows.map((r) => ({
            kind: 'ESTIMATE' as const,
            kindLabel: '見積',
            docNo: r.no,
            title: r.title,
            date: r.dt.slice(0, 10),
            amount: Number(r.amt),
            status: r.st,
            href: `/estimates/${r.id}`,
          })),
        ),
    );
  }
  if (salesEnabled) {
    activityQueries.push(
      tx
        .query<{
          id: string;
          entry_type: 'SALE' | 'ADVANCE';
          no: string;
          title: string;
          dt: string;
          amt: string;
          st: string;
        }>(
          `SELECT id, entry_type::text AS entry_type, slip_no::text AS no, slip_name AS title,
                  slip_date::text AS dt, total_amount::text AS amt, status::text AS st
             FROM sales_headers
            WHERE tenant_id = $1::uuid
            ORDER BY updated_at DESC
            LIMIT 4`,
          [tenantId],
        )
        .then((rows) =>
          rows.map((r) => ({
            kind: 'SALE' as const,
            kindLabel: r.entry_type === 'ADVANCE' ? '立替金' : '売上',
            docNo: r.no,
            title: r.title,
            date: r.dt.slice(0, 10),
            amount: Number(r.amt),
            status: r.st,
            href: `/sales/${r.id}`,
          })),
        ),
    );
  }
  if (billingEnabled) {
    activityQueries.push(
      tx
        .query<{
          id: string;
          no: string;
          partner_name: string;
          dt: string;
          amt: string;
          st: string;
        }>(
          `SELECT bh.id, bh.billing_no::text AS no, COALESCE(bp.partner_name, '') AS partner_name,
                  bh.billing_date::text AS dt, bh.billing_amount::text AS amt, bh.status::text AS st
             FROM billing_headers bh
             LEFT JOIN business_partners bp
               ON bp.tenant_id = bh.tenant_id AND bp.id = bh.partner_id
            WHERE bh.tenant_id = $1::uuid
            ORDER BY bh.updated_at DESC
            LIMIT 4`,
          [tenantId],
        )
        .then((rows) =>
          rows.map((r) => ({
            kind: 'BILLING' as const,
            kindLabel: '請求確定',
            docNo: r.no,
            title: `${r.partner_name} 請求書`,
            date: r.dt.slice(0, 10),
            amount: Number(r.amt),
            status: r.st,
            href: `/billing/${r.id}`,
          })),
        ),
    );
  }
  if (projectEnabled) {
    activityQueries.push(
      tx
        .query<{
          id: string;
          no: string;
          title: string;
          dt: string;
          amt: string;
          st: string;
        }>(
          `SELECT id, project_no::text AS no, project_name AS title,
                  project_date::text AS dt, contract_total::text AS amt, status::text AS st
             FROM projects
            WHERE tenant_id = $1::uuid
            ORDER BY updated_at DESC
            LIMIT 4`,
          [tenantId],
        )
        .then((rows) =>
          rows.map((r) => ({
            kind: 'PROJECT' as const,
            kindLabel: '案件',
            docNo: r.no,
            title: r.title,
            date: r.dt.slice(0, 10),
            amount: Number(r.amt),
            status: r.st,
            href: `/projects/${r.id}`,
          })),
        ),
    );
  }
  if (enabledSet.has('purchase')) {
    activityQueries.push(
      tx
        .query<{
          id: string;
          no: string;
          title: string;
          dt: string;
          amt: string;
          st: string;
        }>(
          `SELECT id, purchase_no::text AS no, purchase_name AS title,
                  purchase_date::text AS dt, total_amount::text AS amt, status::text AS st
             FROM purchases
            WHERE tenant_id = $1::uuid
            ORDER BY updated_at DESC
            LIMIT 4`,
          [tenantId],
        )
        .then((rows) =>
          rows.map((r) => ({
            kind: 'PURCHASE' as const,
            kindLabel: '仕入',
            docNo: r.no,
            title: r.title,
            date: r.dt.slice(0, 10),
            amount: Number(r.amt),
            status: r.st,
            href: '/purchasing?tab=PURCHASES',
          })),
        ),
    );
  }

  const activityGroups = await Promise.all(activityQueries);
  const recentActivities = activityGroups
    .flat()
    .sort((a, b) => b.date.localeCompare(a.date))
    .slice(0, 8);

  return {
    companyName: ts.company_name,
    openingBalanceDate: ts.opening_balance_date.slice(0, 10),
    costTaxMode: ts.cost_tax_mode,
    taxCalcPolicy: ts.tax_calc_policy,
    defaultRoundingMode: ts.default_rounding_mode,
    approvalFlowEnabled: ts.approval_flow_enabled,
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
