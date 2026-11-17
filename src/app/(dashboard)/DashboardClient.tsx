'use client';

import Link from 'next/link';
import { useState } from 'react';
import type { DashboardOverviewDto } from '@/lib/dashboard/dashboard-service';
import { requestMasterApi } from '@/lib/masters/client-api';

interface DashboardClientProps {
  initialOverview: DashboardOverviewDto;
  isAdmin: boolean;
}

function formatYen(amount: number): string {
  return `¥${amount.toLocaleString('ja-JP')}`;
}

export default function DashboardClient({ initialOverview, isAdmin }: DashboardClientProps) {
  const [overview, setOverview] = useState<DashboardOverviewDto>(initialOverview);
  const [targetMonth, setTargetMonth] = useState(initialOverview.targetMonth);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleMonthChange(nextMonth: string) {
    setTargetMonth(nextMonth);
    if (!/^\d{4}-\d{2}$/.test(nextMonth)) return;
    setLoading(true);
    setError(null);
    const res = await requestMasterApi<{ ok: true; overview: DashboardOverviewDto }>(
      `/api/v1/dashboard?targetMonth=${encodeURIComponent(nextMonth)}`,
    );
    setLoading(false);
    if (!res.ok) {
      setError(res.error);
      return;
    }
    setOverview(res.data.overview);
  }

  return (
    <div className="space-y-6">
      {/* Header + Target Month Selector */}
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold text-slate-900">経営・業務ダッシュボード</h1>
          <p className="text-sm text-slate-600 mt-0.5">
            {overview.companyName} / 計算方式:{' '}
            <span className="font-mono">{overview.taxCalcPolicy}</span> / 原価基準:{' '}
            <span className="font-mono">
              {overview.costTaxMode === 'TAX_EXCLUDED' ? '税抜' : '税込'}
            </span>{' '}
            / 期首基準日: <span className="font-mono">{overview.openingBalanceDate}</span>
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-3">
          <div className="flex items-center gap-2 rounded-lg border border-slate-300 bg-white px-3 py-1.5 text-sm">
            <label htmlFor="dashboard-target-month" className="text-xs font-medium text-slate-600">
              集計対象月:
            </label>
            <input
              id="dashboard-target-month"
              type="month"
              value={targetMonth}
              onChange={(e) => void handleMonthChange(e.target.value)}
              className="font-mono text-sm text-slate-900 focus:outline-none"
            />
            {loading && <span className="text-xs text-blue-600">読込中...</span>}
          </div>

          <div className="rounded-lg border border-slate-200 bg-white px-3 py-1.5 text-xs text-slate-600">
            契約機能: <strong>{overview.enabledFeaturesCount}</strong> / {overview.totalFeaturesCount}
            {isAdmin && (
              <Link href="/settings" className="ml-2 text-blue-600 hover:underline">
                設定変更 →
              </Link>
            )}
          </div>
        </div>
      </div>

      {error !== null && (
        <div className="rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-800">
          {error}
        </div>
      )}

      {/* Main KPI Summary Cards (Rendered dynamically per enabled feature authority) */}
      <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-5 gap-4">
        {overview.salesKpi !== null && (
          <Link
            href="/sales"
            className="rounded-xl border border-slate-200 bg-white p-4 shadow-2xs hover:border-blue-300 transition-colors"
          >
            <div className="text-xs font-medium text-slate-500">
              当月売上高 ({overview.targetMonth})
            </div>
            <div className="mt-1 text-xl font-bold font-mono text-slate-900">
              {formatYen(overview.salesKpi.salesInclTotal)}
            </div>
            <div className="mt-1 text-xs font-mono text-slate-500">
              税抜 {formatYen(overview.salesKpi.salesExclTotal)} ({overview.salesKpi.saleCount}件)
            </div>
            {overview.salesKpi.advanceCount > 0 && (
              <div className="mt-0.5 text-xs font-mono text-slate-500">
                立替 {formatYen(overview.salesKpi.advanceInclTotal)} (
                {overview.salesKpi.advanceCount}件)
              </div>
            )}
          </Link>
        )}

        {overview.billingKpi !== null && (
          <Link
            href="/billing?tab=ISSUED"
            className="rounded-xl border border-slate-200 bg-white p-4 shadow-2xs hover:border-blue-300 transition-colors"
          >
            <div className="text-xs font-medium text-slate-500">
              当月請求確定額 ({overview.targetMonth})
            </div>
            <div className="mt-1 text-xl font-bold font-mono text-blue-700">
              {formatYen(overview.billingKpi.billingAmountTotal)}
            </div>
            <div className="mt-1 text-xs text-slate-500">
              確定請求 {overview.billingKpi.billingCount}件（定額{' '}
              {overview.billingKpi.fixedBillingCount}件）
            </div>
          </Link>
        )}

        {overview.arKpi !== null && (
          <Link
            href="/receivables?tab=BALANCES"
            className="rounded-xl border border-slate-200 bg-white p-4 shadow-2xs hover:border-blue-300 transition-colors"
          >
            <div className="text-xs font-medium text-slate-500">売掛残高（{overview.periodEnd}時点）</div>
            <div className="mt-1 text-xl font-bold font-mono text-emerald-700">
              {formatYen(overview.arKpi.currentArBalanceTotal)}
            </div>
            <div className="mt-1 text-xs font-mono text-slate-500">
              当月入金 {formatYen(overview.arKpi.periodReceiptTotal)}
            </div>
          </Link>
        )}

        {overview.apKpi !== null && (
          <Link
            href="/payables?tab=BALANCES"
            className="rounded-xl border border-slate-200 bg-white p-4 shadow-2xs hover:border-blue-300 transition-colors"
          >
            <div className="text-xs font-medium text-slate-500">買掛残高（{overview.periodEnd}時点）</div>
            <div className="mt-1 text-xl font-bold font-mono text-amber-700">
              {formatYen(overview.apKpi.currentApBalanceTotal)}
            </div>
            <div className="mt-1 text-xs font-mono text-slate-500">
              当月支払 {formatYen(overview.apKpi.periodPaymentTotal)}
            </div>
          </Link>
        )}

        {overview.projectsKpi !== null && (
          <Link
            href="/projects"
            className="rounded-xl border border-slate-200 bg-white p-4 shadow-2xs hover:border-blue-300 transition-colors"
          >
            <div className="text-xs font-medium text-slate-500">
              案件契約・粗利（稼働 {overview.projectsKpi.activeCount} / 全{' '}
              {overview.projectsKpi.totalCount}件）
            </div>
            <div className="mt-1 text-xl font-bold font-mono text-slate-900">
              {formatYen(overview.projectsKpi.contractTotal)}
            </div>
            <div className="mt-1 text-xs font-mono text-emerald-700">
              実績粗利 {formatYen(overview.projectsKpi.actualGrossProfitTotal)}
              {overview.projectsKpi.overBudgetCount > 0 && (
                <span className="ml-1.5 rounded bg-red-100 px-1.5 py-0.5 text-[10px] text-red-700">
                  超過 {overview.projectsKpi.overBudgetCount}
                </span>
              )}
            </div>
          </Link>
        )}
      </div>

      {/* Actionable Alerts Panel */}
      <div className="rounded-xl border border-slate-200 bg-white p-5 space-y-4">
        <div className="flex items-center justify-between">
          <h2 className="text-base font-bold text-slate-900">要対応アクション・アラート</h2>
          <span className="text-xs text-slate-500">カードをクリックして該当画面へ移動</span>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-3">
          {overview.alerts.unapprovedAlert !== null && (
            <Link
              href="/sales"
              className={`rounded-xl border p-4 transition-colors ${
                overview.alerts.unapprovedAlert.totalCount > 0
                  ? 'border-amber-300 bg-amber-50/70 hover:bg-amber-50'
                  : 'border-slate-200 bg-slate-50/50 hover:bg-slate-50'
              }`}
            >
              <div className="text-xs font-semibold text-slate-600">未承認・差戻し伝票</div>
              <div className="mt-1 text-lg font-bold text-slate-900">
                {overview.alerts.unapprovedAlert.totalCount}件
              </div>
              <div className="text-xs text-slate-600 mt-1">
                売上/立替: 未承認 {overview.alerts.unapprovedAlert.salesPendingCount} / 差戻{' '}
                {overview.alerts.unapprovedAlert.salesRejectedCount} ・ 定額:{' '}
                {overview.alerts.unapprovedAlert.subscriptionPendingCount +
                  overview.alerts.unapprovedAlert.subscriptionRejectedCount}
              </div>
            </Link>
          )}

          {overview.alerts.unbilledSalesAlert !== null && (
            <Link
              href="/billing?tab=CANDIDATES"
              className={`rounded-xl border p-4 transition-colors ${
                overview.alerts.unbilledSalesAlert.count > 0
                  ? 'border-blue-200 bg-blue-50/60 hover:bg-blue-50'
                  : 'border-slate-200 bg-slate-50/50 hover:bg-slate-50'
              }`}
            >
              <div className="text-xs font-semibold text-slate-600">
                未請求の売上・立替（K1〜K3）
              </div>
              <div className="mt-1 text-lg font-bold text-blue-800">
                {overview.alerts.unbilledSalesAlert.count}件{' '}
                <span className="text-sm font-mono">
                  ({formatYen(overview.alerts.unbilledSalesAlert.totalAmount)})
                </span>
              </div>
              <div className="text-xs text-slate-600 mt-1">請求確定対象へ遷移 →</div>
            </Link>
          )}

          {overview.alerts.unpaidBillingAlert !== null && (
            <Link
              href="/receivables?tab=BALANCES"
              className={`rounded-xl border p-4 transition-colors ${
                overview.alerts.unpaidBillingAlert.overdueCount > 0
                  ? 'border-red-300 bg-red-50/70 hover:bg-red-50'
                  : 'border-slate-200 bg-slate-50/50 hover:bg-slate-50'
              }`}
            >
              <div className="text-xs font-semibold text-slate-600">
                未入金・一部入金請求書（N1/N2）
              </div>
              <div className="mt-1 text-lg font-bold text-slate-900">
                {overview.alerts.unpaidBillingAlert.count}件{' '}
                <span className="text-sm font-mono">
                  ({formatYen(overview.alerts.unpaidBillingAlert.billingAmountTotal)})
                </span>
              </div>
              <div className="text-xs text-red-700 mt-1">
                支払期限超過: {overview.alerts.unpaidBillingAlert.overdueCount}件
              </div>
            </Link>
          )}

          {overview.alerts.aplusFailureAlert !== null && (
            <Link
              href="/aplus"
              className={`rounded-xl border p-4 transition-colors ${
                overview.alerts.aplusFailureAlert.count > 0
                  ? 'border-red-300 bg-red-50/70 hover:bg-red-50'
                  : 'border-slate-200 bg-slate-50/50 hover:bg-slate-50'
              }`}
            >
              <div className="text-xs font-semibold text-slate-600">アプラス振替不能アラート</div>
              <div className="mt-1 text-lg font-bold text-red-700">
                {overview.alerts.aplusFailureAlert.count}件
              </div>
              <div className="text-xs font-mono text-slate-600 mt-1">
                未収金額 {formatYen(overview.alerts.aplusFailureAlert.unpaidAmountTotal)}
              </div>
            </Link>
          )}

          {overview.alerts.purchasingPayableAlert !== null && (
            <Link
              href="/purchasing?tab=PURCHASES"
              className="rounded-xl border border-slate-200 bg-slate-50/50 p-4 hover:bg-slate-50 transition-colors"
            >
              <div className="text-xs font-semibold text-slate-600">未確定仕入(P1/P2) ＆ 未払買掛(A1)</div>
              <div className="mt-1 text-sm font-bold text-slate-900">
                未確定仕入 {overview.alerts.purchasingPayableAlert.unconfirmedPurchaseCount}件 (
                {formatYen(overview.alerts.purchasingPayableAlert.unconfirmedPurchaseAmount)})
              </div>
              <div className="text-xs text-amber-800 mt-1 font-mono">
                未払買掛 {overview.alerts.purchasingPayableAlert.unpaidPayableCount}件 (
                {formatYen(overview.alerts.purchasingPayableAlert.unpaidPayableAmount)})
              </div>
            </Link>
          )}
        </div>

        {/* Over-budget Projects List */}
        {overview.alerts.overBudgetProjects !== null &&
          overview.alerts.overBudgetProjects.length > 0 && (
            <div className="pt-2">
              <div className="text-xs font-bold text-red-700 mb-2">
                実行予算超過アラート案件（全体または費目別超過）
              </div>
              <div className="grid grid-cols-1 md:grid-cols-2 gap-2.5">
                {overview.alerts.overBudgetProjects.map((pj) => (
                  <Link
                    key={pj.id}
                    href={`/projects/${pj.id}`}
                    className="flex items-center justify-between rounded-lg border border-red-200 bg-red-50/50 px-3.5 py-2.5 text-xs hover:bg-red-50"
                  >
                    <div>
                      <div className="font-semibold text-slate-900">
                        <span className="font-mono mr-1">#{pj.projectNo}</span>
                        {pj.projectName}
                      </div>
                      <div className="text-red-700 mt-0.5">
                        超過費目: {pj.overCategories.join('・')}
                      </div>
                    </div>
                    <div className="text-right font-mono">
                      <div>実績 {formatYen(pj.actualCostEvalTotal)}</div>
                      <div className="text-slate-500">予算 {formatYen(pj.budgetTotal)}</div>
                    </div>
                  </Link>
                ))}
              </div>
            </div>
          )}
      </div>

      {/* Bottom Split: Recent Activities + Internal Chat (if teams enabled) */}
      <div className="grid grid-cols-1 lg:grid-cols-12 gap-6">
        <div
          className={`${
            overview.chatSummary !== null ? 'lg:col-span-7' : 'lg:col-span-12'
          } rounded-xl border border-slate-200 bg-white overflow-hidden`}
        >
          <div className="border-b border-slate-200 px-4 py-3 text-sm font-bold text-slate-900">
            最近の業務アクティビティ
          </div>
          <div className="divide-y divide-slate-100 text-sm">
            {overview.recentActivities.length === 0 ? (
              <div className="p-6 text-center text-slate-500">最近の登録伝票はありません。</div>
            ) : (
              overview.recentActivities.map((act, idx) => (
                <Link
                  key={`${act.kind}-${act.docNo}-${idx}`}
                  href={act.href}
                  className="flex items-center justify-between px-4 py-2.5 hover:bg-slate-50"
                >
                  <div className="flex items-center gap-3 min-w-0">
                    <span className="rounded bg-slate-100 px-2 py-0.5 text-xs font-medium text-slate-700 shrink-0">
                      {act.kindLabel}
                    </span>
                    <span className="font-mono text-xs text-slate-500 shrink-0">#{act.docNo}</span>
                    <span className="truncate font-medium text-slate-900">{act.title}</span>
                  </div>
                  <div className="flex items-center gap-3 shrink-0 font-mono text-xs">
                    <span className="text-slate-500">{act.date}</span>
                    <span className="font-semibold text-slate-900">{formatYen(act.amount)}</span>
                    <span className="rounded bg-slate-100 px-1.5 py-0.5 text-[10px]">
                      {act.status}
                    </span>
                  </div>
                </Link>
              ))
            )}
          </div>
        </div>

        {overview.chatSummary !== null && (
          <div className="lg:col-span-5 rounded-xl border border-slate-200 bg-white overflow-hidden">
            <div className="border-b border-slate-200 px-4 py-3 flex items-center justify-between">
              <div className="text-sm font-bold text-slate-900">
                社内チャット新着（未解決 {overview.chatSummary.unresolvedCount}件）
              </div>
              <Link href="/chat" className="text-xs font-medium text-blue-600 hover:underline">
                チャットを開く →
              </Link>
            </div>
            <div className="divide-y divide-slate-100 text-xs">
              {overview.chatSummary.latestThreads.length === 0 ? (
                <div className="p-6 text-center text-slate-500">
                  まだチャット投稿はありません。
                </div>
              ) : (
                overview.chatSummary.latestThreads.map((th) => (
                  <Link
                    key={th.id}
                    href="/chat"
                    className="block px-4 py-3 hover:bg-slate-50 space-y-1"
                  >
                    <div className="flex items-center justify-between">
                      <span className="font-semibold text-slate-800">
                        [{th.roomName}] {th.staffName}
                      </span>
                      <span
                        className={`rounded-full px-2 py-0.5 text-[10px] font-semibold ${
                          th.isResolved
                            ? 'bg-emerald-100 text-emerald-800'
                            : 'bg-amber-100 text-amber-800'
                        }`}
                      >
                        {th.isResolved ? '解決済' : '対応中'}
                      </span>
                    </div>
                    <div className="text-slate-700 line-clamp-2">{th.question}</div>
                  </Link>
                ))
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
