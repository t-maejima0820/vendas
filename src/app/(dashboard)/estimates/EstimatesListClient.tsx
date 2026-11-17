'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import {
  computePageCount,
  QUOTATION_STATUS_LABELS,
  type QuotationListItemDto,
  type QuotationPageDto,
  type QuotationStatus,
} from '@/lib/estimates/types';
import { requestMasterApi } from '@/lib/masters/client-api';

interface EstimatesListClientProps {
  initialPage: QuotationPageDto;
}

function formatYen(amount: number): string {
  return `¥${amount.toLocaleString('ja-JP')}`;
}

export default function EstimatesListClient({ initialPage }: EstimatesListClientProps) {
  const router = useRouter();
  const [pageData, setPageData] = useState<QuotationPageDto>(initialPage);

  const [keyword, setKeyword] = useState('');
  const [status, setStatus] = useState<'' | QuotationStatus>('');
  const [dateFrom, setDateFrom] = useState('');
  const [dateTo, setDateTo] = useState('');
  const [projectLink, setProjectLink] = useState<'ALL' | 'LINKED' | 'UNLINKED'>('ALL');
  const [selectedFilter, setSelectedFilter] = useState<'ALL' | 'SELECTED' | 'UNSELECTED'>('ALL');

  const [loading, setLoading] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [bannerError, setBannerError] = useState<string | null>(null);
  const [bannerSuccess, setBannerSuccess] = useState<string | null>(null);

  const totalPages = computePageCount(pageData.summary.totalCount, pageData.pageSize);

  function buildFilterQuery(overrides?: {
    q?: string;
    st?: '' | QuotationStatus;
    from?: string;
    to?: string;
    pj?: 'ALL' | 'LINKED' | 'UNLINKED';
    sel?: 'ALL' | 'SELECTED' | 'UNSELECTED';
    page?: number;
  }): URLSearchParams {
    const q = overrides?.q !== undefined ? overrides.q : keyword;
    const st = overrides?.st !== undefined ? overrides.st : status;
    const from = overrides?.from !== undefined ? overrides.from : dateFrom;
    const to = overrides?.to !== undefined ? overrides.to : dateTo;
    const pj = overrides?.pj !== undefined ? overrides.pj : projectLink;
    const sel = overrides?.sel !== undefined ? overrides.sel : selectedFilter;
    const p = overrides?.page !== undefined ? overrides.page : pageData.page;

    const params = new URLSearchParams();
    if (q.trim() !== '') params.set('q', q.trim());
    if (st !== '') params.set('status', st);
    if (from.trim() !== '') params.set('dateFrom', from.trim());
    if (to.trim() !== '') params.set('dateTo', to.trim());
    if (pj !== 'ALL') params.set('projectLink', pj);
    if (sel !== 'ALL') params.set('selected', sel);
    params.set('page', String(p));
    params.set('pageSize', String(pageData.pageSize));
    return params;
  }

  async function loadPage(overrides?: Parameters<typeof buildFilterQuery>[0]) {
    setLoading(true);
    setBannerError(null);
    const params = buildFilterQuery(overrides);
    const res = await requestMasterApi<QuotationPageDto>(`/api/v1/estimates?${params.toString()}`);
    setLoading(false);
    if (!res.ok) {
      setBannerError(res.error);
      return;
    }
    setPageData({
      items: res.data.items,
      summary: res.data.summary,
      page: res.data.page,
      pageSize: res.data.pageSize,
    });
  }

  function handleSearchSubmit(e: React.FormEvent) {
    e.preventDefault();
    void loadPage({ page: 1 });
  }

  function handleResetFilters() {
    setKeyword('');
    setStatus('');
    setDateFrom('');
    setDateTo('');
    setProjectLink('ALL');
    setSelectedFilter('ALL');
    void loadPage({
      q: '',
      st: '',
      from: '',
      to: '',
      pj: 'ALL',
      sel: 'ALL',
      page: 1,
    });
  }

  function getExportUrl(format: 'csv' | 'pdf'): string {
    const params = buildFilterQuery({ page: 1 });
    params.delete('page');
    params.delete('pageSize');
    params.set('format', format);
    return `/api/v1/estimates/export?${params.toString()}`;
  }

  async function handleDuplicate(item: QuotationListItemDto) {
    setBannerError(null);
    setBannerSuccess(null);
    setBusyId(item.id);
    const res = await requestMasterApi<{ item: { id: string; quotationNo: number } }>(
      `/api/v1/estimates/${encodeURIComponent(item.id)}/duplicate`,
      { method: 'POST' },
    );
    setBusyId(null);
    if (!res.ok) {
      setBannerError(res.error);
      return;
    }
    setBannerSuccess(`見積 #${item.quotationNo} を複写し、新規見積 #${res.data.item.quotationNo} を作成しました。`);
    router.push(`/estimates/${res.data.item.id}`);
  }

  async function handleDelete(item: QuotationListItemDto) {
    if (!window.confirm(`見積 #${item.quotationNo}「${item.quotationName}」を削除しますか？`)) {
      return;
    }
    setBannerError(null);
    setBannerSuccess(null);
    setBusyId(item.id);
    const res = await requestMasterApi<{ ok: true }>(
      `/api/v1/estimates/${encodeURIComponent(item.id)}`,
      { method: 'DELETE' },
    );
    setBusyId(null);
    if (!res.ok) {
      setBannerError(res.error);
      return;
    }
    setBannerSuccess(`見積 #${item.quotationNo} を削除しました。`);
    await loadPage();
  }

  return (
    <div className="max-w-7xl space-y-5">
      {/* ヘッダ */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold text-slate-900">見積管理</h1>
          <p className="text-sm text-slate-600 mt-1">
            案件別・顧客別の見積作成、売価/原価同時積算、イミュータブル見積書の発行・版管理を行います。
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <a
            href={getExportUrl('csv')}
            className="rounded-lg border border-slate-300 bg-white hover:bg-slate-50 px-3 py-2 text-xs font-medium text-slate-700 transition-colors"
          >
            CSVエクスポート
          </a>
          <a
            href={getExportUrl('pdf')}
            target="_blank"
            rel="noopener noreferrer"
            className="rounded-lg border border-slate-300 bg-white hover:bg-slate-50 px-3 py-2 text-xs font-medium text-slate-700 transition-colors"
          >
            見積一覧PDF出力
          </a>
          <Link
            href="/estimates/new"
            className="rounded-lg bg-blue-600 hover:bg-blue-700 px-4 py-2 text-xs font-semibold text-white transition-colors"
          >
            ＋ 新規見積作成
          </Link>
        </div>
      </div>

      {bannerError !== null && (
        <div className="rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-800">
          {bannerError}
        </div>
      )}
      {bannerSuccess !== null && (
        <div className="rounded-lg border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm text-emerald-800">
          {bannerSuccess}
        </div>
      )}

      {/* 集計サマリカード */}
      <div className="grid grid-cols-2 lg:grid-cols-5 gap-3">
        <div className="rounded-xl bg-white border border-slate-200 p-4 shadow-xs">
          <div className="text-xs font-medium text-slate-500">対象見積件数</div>
          <div className="text-xl font-bold text-slate-900 mt-1 font-mono">
            {pageData.summary.totalCount} 件
          </div>
        </div>
        <div className="rounded-xl bg-white border border-slate-200 p-4 shadow-xs">
          <div className="text-xs font-medium text-slate-500">税抜金額合計</div>
          <div className="text-xl font-bold text-slate-900 mt-1 font-mono">
            {formatYen(pageData.summary.subtotalAmount)}
          </div>
        </div>
        <div className="rounded-xl bg-white border border-slate-200 p-4 shadow-xs">
          <div className="text-xs font-medium text-slate-500">消費税合計</div>
          <div className="text-xl font-bold text-slate-900 mt-1 font-mono">
            {formatYen(pageData.summary.taxTotal)}
          </div>
        </div>
        <div className="rounded-xl bg-blue-50 border border-blue-200 p-4 shadow-xs">
          <div className="text-xs font-semibold text-blue-700">税込合計金額</div>
          <div className="text-xl font-bold text-blue-900 mt-1 font-mono">
            {formatYen(pageData.summary.totalAmount)}
          </div>
        </div>
        <div className="rounded-xl bg-white border border-slate-200 p-4 shadow-xs">
          <div className="text-xs font-medium text-slate-500">予定粗利（税抜）</div>
          <div className="text-xl font-bold text-emerald-700 mt-1 font-mono">
            {formatYen(pageData.summary.grossProfitExcl)}
          </div>
          <div className="text-[11px] text-slate-500 mt-0.5 font-mono">
            予定原価: {formatYen(pageData.summary.costSubtotal)}
          </div>
        </div>
      </div>

      {/* 検索フィルタ */}
      <form
        onSubmit={handleSearchSubmit}
        className="rounded-xl bg-white border border-slate-200 p-4 shadow-xs space-y-3"
      >
        <div className="grid grid-cols-1 md:grid-cols-6 gap-3">
          <div className="md:col-span-2">
            <label className="block text-xs font-medium text-slate-600 mb-1">
              キーワード（見積No・件名・取引先・案件）
            </label>
            <input
              type="text"
              value={keyword}
              onChange={(e) => setKeyword(e.target.value)}
              placeholder="例: 外構工事 / 00007 / 7"
              className="w-full rounded-lg border border-slate-300 px-3 py-1.5 text-sm text-slate-900 focus:border-blue-500 focus:outline-none"
            />
          </div>

          <div>
            <label className="block text-xs font-medium text-slate-600 mb-1">ステータス</label>
            <select
              value={status}
              onChange={(e) => setStatus(e.target.value as '' | QuotationStatus)}
              className="w-full rounded-lg border border-slate-300 px-2.5 py-1.5 text-sm text-slate-900 bg-white focus:border-blue-500 focus:outline-none"
            >
              <option value="">すべて</option>
              <option value="Q1">Q1: 見積済</option>
              <option value="Q2">Q2: 注文確定</option>
              <option value="Q3">Q3: －</option>
            </select>
          </div>

          <div>
            <label className="block text-xs font-medium text-slate-600 mb-1">見積日（From）</label>
            <input
              type="date"
              value={dateFrom}
              onChange={(e) => setDateFrom(e.target.value)}
              className="w-full rounded-lg border border-slate-300 px-2.5 py-1.5 text-sm text-slate-900 focus:border-blue-500 focus:outline-none"
            />
          </div>

          <div>
            <label className="block text-xs font-medium text-slate-600 mb-1">見積日（To）</label>
            <input
              type="date"
              value={dateTo}
              onChange={(e) => setDateTo(e.target.value)}
              className="w-full rounded-lg border border-slate-300 px-2.5 py-1.5 text-sm text-slate-900 focus:border-blue-500 focus:outline-none"
            />
          </div>

          <div className="grid grid-cols-2 gap-2">
            <div>
              <label className="block text-xs font-medium text-slate-600 mb-1">案件紐付</label>
              <select
                value={projectLink}
                onChange={(e) => setProjectLink(e.target.value as 'ALL' | 'LINKED' | 'UNLINKED')}
                className="w-full rounded-lg border border-slate-300 px-2 py-1.5 text-xs text-slate-900 bg-white focus:border-blue-500 focus:outline-none"
              >
                <option value="ALL">すべて</option>
                <option value="LINKED">あり</option>
                <option value="UNLINKED">なし</option>
              </select>
            </div>
            <div>
              <label className="block text-xs font-medium text-slate-600 mb-1">案採用</label>
              <select
                value={selectedFilter}
                onChange={(e) =>
                  setSelectedFilter(e.target.value as 'ALL' | 'SELECTED' | 'UNSELECTED')
                }
                className="w-full rounded-lg border border-slate-300 px-2 py-1.5 text-xs text-slate-900 bg-white focus:border-blue-500 focus:outline-none"
              >
                <option value="ALL">すべて</option>
                <option value="SELECTED">採用</option>
                <option value="UNSELECTED">未採用</option>
              </select>
            </div>
          </div>
        </div>

        <div className="flex items-center justify-end gap-2">
          <button
            type="button"
            onClick={handleResetFilters}
            className="rounded-lg border border-slate-300 bg-white hover:bg-slate-50 px-3 py-1.5 text-xs font-medium text-slate-700 cursor-pointer"
          >
            条件リセット
          </button>
          <button
            type="submit"
            disabled={loading}
            className="rounded-lg bg-slate-800 hover:bg-slate-700 px-4 py-1.5 text-xs font-semibold text-white cursor-pointer"
          >
            {loading ? '検索中...' : '検索する'}
          </button>
        </div>
      </form>

      {/* 一覧テーブル */}
      <div className="rounded-xl bg-white border border-slate-200 shadow-xs overflow-hidden">
        <div className="overflow-x-auto">
          <table className="min-w-full divide-y divide-slate-200 text-sm">
            <thead className="bg-slate-50 text-xs font-semibold text-slate-600">
              <tr>
                <th className="px-3 py-2.5 text-right whitespace-nowrap">見積No</th>
                <th className="px-3 py-2.5 text-center whitespace-nowrap">見積日</th>
                <th className="px-3 py-2.5 text-center whitespace-nowrap">状態</th>
                <th className="px-3 py-2.5 text-center whitespace-nowrap">採用/立替</th>
                <th className="px-3 py-2.5 text-left">取引先</th>
                <th className="px-3 py-2.5 text-left">件名 / 紐付案件</th>
                <th className="px-3 py-2.5 text-right whitespace-nowrap">税抜金額</th>
                <th className="px-3 py-2.5 text-right whitespace-nowrap">消費税</th>
                <th className="px-3 py-2.5 text-right whitespace-nowrap">税込合計</th>
                <th className="px-3 py-2.5 text-right whitespace-nowrap">予定粗利</th>
                <th className="px-3 py-2.5 text-center whitespace-nowrap">見積書版</th>
                <th className="px-3 py-2.5 text-right whitespace-nowrap">操作</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {pageData.items.length === 0 ? (
                <tr>
                  <td colSpan={12} className="px-4 py-8 text-center text-sm text-slate-500">
                    条件に一致する見積データがありません。
                  </td>
                </tr>
              ) : (
                pageData.items.map((item) => (
                  <tr key={item.id} className="hover:bg-slate-50/80">
                    <td className="px-3 py-2.5 text-right font-mono font-semibold text-blue-700 whitespace-nowrap">
                      <Link href={`/estimates/${item.id}`} className="hover:underline">
                        #{item.quotationNo}
                      </Link>
                    </td>
                    <td className="px-3 py-2.5 text-center font-mono text-xs text-slate-700 whitespace-nowrap">
                      {item.quotationDate}
                    </td>
                    <td className="px-3 py-2.5 text-center whitespace-nowrap">
                      <span
                        className={`inline-flex px-2 py-0.5 rounded-full text-[11px] font-semibold ${
                          item.status === 'Q2'
                            ? 'bg-emerald-100 text-emerald-800'
                            : item.status === 'Q1'
                              ? 'bg-blue-100 text-blue-800'
                              : 'bg-slate-100 text-slate-700'
                        }`}
                      >
                        {item.status}: {QUOTATION_STATUS_LABELS[item.status]}
                      </span>
                    </td>
                    <td className="px-3 py-2.5 text-center whitespace-nowrap">
                      <div className="flex items-center justify-center gap-1">
                        {item.isSelected && (
                          <span className="px-1.5 py-0.5 rounded bg-amber-100 text-amber-800 text-[10px] font-semibold">
                            採用
                          </span>
                        )}
                        {item.isAdvanceType && (
                          <span className="px-1.5 py-0.5 rounded bg-purple-100 text-purple-800 text-[10px] font-semibold">
                            立替
                          </span>
                        )}
                        {!item.isSelected && !item.isAdvanceType && (
                          <span className="text-xs text-slate-400">-</span>
                        )}
                      </div>
                    </td>
                    <td className="px-3 py-2.5 text-slate-800">
                      <div className="font-medium text-xs">{item.partnerName}</div>
                      <div className="text-[11px] font-mono text-slate-400">{item.partnerCode}</div>
                    </td>
                    <td className="px-3 py-2.5 text-slate-900">
                      <Link
                        href={`/estimates/${item.id}`}
                        className="font-medium hover:text-blue-700 hover:underline block"
                      >
                        {item.quotationName}
                      </Link>
                      {item.projectName !== null && (
                        <div className="text-[11px] text-slate-500 mt-0.5">
                          案件 #{item.projectNo}: {item.projectName}
                        </div>
                      )}
                      <div className="text-[11px] text-slate-400 mt-0.5">
                        明細 {item.lineCount}行
                        {item.attachmentCount > 0 ? ` / 添付画像 ${item.attachmentCount}枚` : ''}
                      </div>
                    </td>
                    <td className="px-3 py-2.5 text-right font-mono text-xs text-slate-800 whitespace-nowrap">
                      {formatYen(item.subtotalAmount)}
                    </td>
                    <td className="px-3 py-2.5 text-right font-mono text-xs text-slate-600 whitespace-nowrap">
                      {formatYen(item.taxTotal)}
                    </td>
                    <td className="px-3 py-2.5 text-right font-mono text-xs font-bold text-slate-900 whitespace-nowrap">
                      {formatYen(item.totalAmount)}
                    </td>
                    <td className="px-3 py-2.5 text-right font-mono text-xs text-emerald-700 whitespace-nowrap">
                      {formatYen(item.grossProfitExcl)}
                    </td>
                    <td className="px-3 py-2.5 text-center whitespace-nowrap">
                      {item.latestSnapshotVersion !== null ? (
                        <span className="inline-flex px-2 py-0.5 rounded bg-indigo-50 text-indigo-700 border border-indigo-200 text-[11px] font-mono font-semibold">
                          v{item.latestSnapshotVersion} ({item.snapshotCount}版)
                        </span>
                      ) : (
                        <span className="text-[11px] text-slate-400">未発行</span>
                      )}
                    </td>
                    <td className="px-3 py-2.5 text-right whitespace-nowrap">
                      <div className="inline-flex items-center gap-1.5">
                        <Link
                          href={`/estimates/${item.id}`}
                          className="rounded border border-slate-300 bg-white hover:bg-slate-50 px-2 py-1 text-xs font-medium text-slate-700"
                        >
                          開く
                        </Link>
                        <button
                          type="button"
                          disabled={busyId === item.id}
                          onClick={() => void handleDuplicate(item)}
                          className="rounded border border-slate-300 bg-white hover:bg-slate-50 px-2 py-1 text-xs font-medium text-slate-700 cursor-pointer"
                        >
                          複写
                        </button>
                        {item.snapshotCount === 0 && (
                          <button
                            type="button"
                            disabled={busyId === item.id}
                            onClick={() => void handleDelete(item)}
                            className="rounded border border-red-200 bg-white hover:bg-red-50 px-2 py-1 text-xs font-medium text-red-700 cursor-pointer"
                          >
                            削除
                          </button>
                        )}
                      </div>
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>

        {/* ページネーション */}
        <div className="flex items-center justify-between px-4 py-3 border-t border-slate-200 bg-slate-50 text-xs text-slate-600">
          <div>
            全 {pageData.summary.totalCount} 件（ページ {pageData.page} / {totalPages}）
          </div>
          <div className="flex items-center gap-2">
            <button
              type="button"
              disabled={pageData.page <= 1 || loading}
              onClick={() => void loadPage({ page: pageData.page - 1 })}
              className="rounded border border-slate-300 bg-white px-2.5 py-1 disabled:opacity-40 cursor-pointer"
            >
              前へ
            </button>
            <button
              type="button"
              disabled={pageData.page >= totalPages || loading}
              onClick={() => void loadPage({ page: pageData.page + 1 })}
              className="rounded border border-slate-300 bg-white px-2.5 py-1 disabled:opacity-40 cursor-pointer"
            >
              次へ
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
