'use client';

import Link from 'next/link';
import { useMemo, useState } from 'react';
import type {
  AnalyticsDimension,
  CustomAnalyticsPageDto,
} from '@/lib/analytics/analytics-service';
import { requestMasterApi } from '@/lib/masters/client-api';

interface AnalyticsClientProps {
  initialPage: CustomAnalyticsPageDto;
  sumEnabled: boolean;
}

const DIMENSIONS: ReadonlyArray<{ key: AnalyticsDimension; label: string }> = [
  { key: 'PARTNER', label: '取引先別集計' },
  { key: 'CATEGORY', label: '項目分類別集計' },
  { key: 'EMPLOYEE', label: '担当者別(案件)集計' },
  { key: 'PERIOD', label: '月別推移集計' },
];

function formatYen(amount: number): string {
  return `¥${amount.toLocaleString('ja-JP')}`;
}

export default function AnalyticsClient({ initialPage, sumEnabled }: AnalyticsClientProps) {
  const [pageData, setPageData] = useState<CustomAnalyticsPageDto>(initialPage);
  const [dimension, setDimension] = useState<AnalyticsDimension>(initialPage.dimension);
  const [dateFrom, setDateFrom] = useState('');
  const [dateTo, setDateTo] = useState('');
  const [keyword, setKeyword] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const exportCsvHref = useMemo(() => {
    const qs = new URLSearchParams({ dimension, format: 'csv' });
    if (dateFrom !== '') qs.set('dateFrom', dateFrom);
    if (dateTo !== '') qs.set('dateTo', dateTo);
    if (keyword.trim() !== '') qs.set('keyword', keyword.trim());
    return `/api/v1/analytics/export?${qs.toString()}`;
  }, [dimension, dateFrom, dateTo, keyword]);

  const exportPdfHref = useMemo(() => {
    const qs = new URLSearchParams({ dimension, format: 'pdf', inline: '1' });
    if (dateFrom !== '') qs.set('dateFrom', dateFrom);
    if (dateTo !== '') qs.set('dateTo', dateTo);
    if (keyword.trim() !== '') qs.set('keyword', keyword.trim());
    return `/api/v1/analytics/export?${qs.toString()}`;
  }, [dimension, dateFrom, dateTo, keyword]);

  async function fetchAnalytics(nextDim = dimension) {
    setLoading(true);
    setError(null);
    const qs = new URLSearchParams({ dimension: nextDim });
    if (dateFrom !== '') qs.set('dateFrom', dateFrom);
    if (dateTo !== '') qs.set('dateTo', dateTo);
    if (keyword.trim() !== '') qs.set('keyword', keyword.trim());

    const res = await requestMasterApi<CustomAnalyticsPageDto & { ok: true }>(
      `/api/v1/analytics?${qs.toString()}`,
    );
    setLoading(false);
    if (!res.ok) {
      setError(res.error);
      return;
    }
    setPageData(res.data);
  }

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold text-slate-900">カスタム経営・売上粗利集計</h1>
          <p className="text-sm text-slate-600 mt-0.5">
            取引先別・項目分類別（ITEM_CLASS）・担当者別・月別推移のリアルタイムクロス集計
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          {sumEnabled && (
            <Link
              href="/sales?tab=SUMMARY"
              className="rounded-lg border border-slate-300 bg-white px-3.5 py-2 text-sm font-medium text-slate-700 hover:bg-slate-50"
            >
              商品別売上立替集計へ
            </Link>
          )}
          <a
            href={exportCsvHref}
            className="rounded-lg border border-slate-300 bg-white px-3.5 py-2 text-sm font-medium text-slate-700 hover:bg-slate-50"
          >
            集計 CSV
          </a>
          <a
            href={exportPdfHref}
            target="_blank"
            rel="noopener noreferrer"
            className="rounded-lg bg-slate-900 px-4 py-2 text-sm font-semibold text-white hover:bg-slate-800"
          >
            集計 PDF
          </a>
        </div>
      </div>

      {error !== null && (
        <div className="rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-800">
          {error}
        </div>
      )}

      {/* Dimension Tabs */}
      <div className="flex flex-wrap gap-1.5 border-b border-slate-200 pb-2">
        {DIMENSIONS.map((d) => (
          <button
            key={d.key}
            type="button"
            onClick={() => {
              setDimension(d.key);
              void fetchAnalytics(d.key);
            }}
            className={`rounded-lg px-4 py-1.5 text-sm font-medium transition-colors ${
              dimension === d.key
                ? 'bg-blue-600 text-white'
                : 'bg-white border border-slate-300 text-slate-700 hover:bg-slate-50'
            }`}
          >
            {d.label}
          </button>
        ))}
      </div>

      {/* Filters */}
      <form
        onSubmit={(e) => {
          e.preventDefault();
          void fetchAnalytics();
        }}
        className="rounded-xl border border-slate-200 bg-white p-4 flex flex-wrap items-end gap-3"
      >
        <div>
          <label className="block text-xs font-medium text-slate-600 mb-1">期間 From</label>
          <input
            type="date"
            value={dateFrom}
            onChange={(e) => setDateFrom(e.target.value)}
            className="rounded-lg border border-slate-300 px-3 py-1.5 text-sm"
          />
        </div>
        <div>
          <label className="block text-xs font-medium text-slate-600 mb-1">期間 To</label>
          <input
            type="date"
            value={dateTo}
            onChange={(e) => setDateTo(e.target.value)}
            className="rounded-lg border border-slate-300 px-3 py-1.5 text-sm"
          />
        </div>
        <div className="flex-1 min-w-[200px]">
          <label className="block text-xs font-medium text-slate-600 mb-1">絞込キーワード</label>
          <input
            type="text"
            value={keyword}
            onChange={(e) => setKeyword(e.target.value)}
            placeholder="コード・名称"
            className="w-full rounded-lg border border-slate-300 px-3 py-1.5 text-sm"
          />
        </div>
        <button
          type="submit"
          disabled={loading}
          className="rounded-lg bg-slate-900 px-4 py-1.5 text-sm font-medium text-white hover:bg-slate-800"
        >
          {loading ? '集計中...' : '再集計'}
        </button>
      </form>

      {/* KPI Totals */}
      <div className="grid grid-cols-2 lg:grid-cols-5 gap-3">
        <div className="rounded-xl border border-slate-200 bg-white p-4">
          <div className="text-xs font-medium text-slate-500">売上合計（税抜）</div>
          <div className="mt-1 text-xl font-bold font-mono text-slate-900">
            {formatYen(pageData.totals.salesExcl)}
          </div>
          <div className="text-xs font-mono text-slate-500">
            税込 {formatYen(pageData.totals.salesIncl)}
          </div>
        </div>
        <div className="rounded-xl border border-slate-200 bg-white p-4">
          <div className="text-xs font-medium text-slate-500">立替金計（税込）</div>
          <div className="mt-1 text-xl font-bold font-mono text-slate-900">
            {formatYen(pageData.totals.advanceIncl)}
          </div>
        </div>
        <div className="rounded-xl border border-slate-200 bg-white p-4">
          <div className="text-xs font-medium text-slate-500">仕入・原価（税抜）</div>
          <div className="mt-1 text-xl font-bold font-mono text-amber-700">
            {formatYen(pageData.totals.costOrPurchaseExcl)}
          </div>
        </div>
        <div className="rounded-xl border border-slate-200 bg-white p-4">
          <div className="text-xs font-medium text-slate-500">粗利額（税抜基準）</div>
          <div
            className={`mt-1 text-xl font-bold font-mono ${
              pageData.totals.grossProfit < 0 ? 'text-red-700' : 'text-emerald-700'
            }`}
          >
            {formatYen(pageData.totals.grossProfit)}
          </div>
        </div>
        <div className="rounded-xl border border-slate-200 bg-white p-4">
          <div className="text-xs font-medium text-slate-500">粗利率 / 集計行数</div>
          <div className="mt-1 text-xl font-bold font-mono text-blue-700">
            {pageData.totals.grossMarginPercent}%
          </div>
          <div className="text-xs text-slate-500">{pageData.totals.count}区分</div>
        </div>
      </div>

      {/* Table */}
      <div className="rounded-xl border border-slate-200 bg-white overflow-hidden">
        <div className="overflow-x-auto">
          <table className="min-w-full divide-y divide-slate-200 text-sm">
            <thead className="bg-slate-50 text-xs font-semibold text-slate-600">
              <tr>
                <th className="px-3 py-2.5 text-left">コード / 区分</th>
                <th className="px-3 py-2.5 text-left">集計軸名称</th>
                <th className="px-3 py-2.5 text-right">伝票/案件数</th>
                <th className="px-3 py-2.5 text-right">売上(税抜)</th>
                <th className="px-3 py-2.5 text-right">売上(税込)</th>
                <th className="px-3 py-2.5 text-right">立替計(税込)</th>
                <th className="px-3 py-2.5 text-right">原価・仕入(税抜)</th>
                <th className="px-3 py-2.5 text-right">粗利額</th>
                <th className="px-3 py-2.5 text-right">粗利率</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {pageData.items.length === 0 ? (
                <tr>
                  <td colSpan={9} className="px-4 py-10 text-center text-slate-500">
                    集計対象データがありません。
                  </td>
                </tr>
              ) : (
                pageData.items.map((item) => (
                  <tr key={item.groupKey} className="hover:bg-slate-50/70">
                    <td className="px-3 py-2.5 font-mono text-xs text-slate-600">
                      {item.groupKey}
                    </td>
                    <td className="px-3 py-2.5">
                      <div className="font-medium text-slate-900">{item.groupLabel}</div>
                      <div className="text-xs text-slate-400">{item.subLabel}</div>
                    </td>
                    <td className="px-3 py-2.5 text-right font-mono">{item.recordCount}</td>
                    <td className="px-3 py-2.5 text-right font-mono">
                      {formatYen(item.salesExcl)}
                    </td>
                    <td className="px-3 py-2.5 text-right font-mono">
                      {formatYen(item.salesIncl)}
                    </td>
                    <td className="px-3 py-2.5 text-right font-mono">
                      {formatYen(item.advanceIncl)}
                    </td>
                    <td className="px-3 py-2.5 text-right font-mono text-amber-700">
                      {formatYen(item.costOrPurchaseExcl)}
                    </td>
                    <td
                      className={`px-3 py-2.5 text-right font-mono font-semibold ${
                        item.grossProfit < 0 ? 'text-red-700' : 'text-emerald-700'
                      }`}
                    >
                      {formatYen(item.grossProfit)}
                    </td>
                    <td className="px-3 py-2.5 text-right font-mono text-xs">
                      {item.grossMarginPercent}%
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
