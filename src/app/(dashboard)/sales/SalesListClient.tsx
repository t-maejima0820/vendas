'use client';

import Link from 'next/link';
import { useState } from 'react';
import { computePageCount } from '@/lib/estimates/types';
import { requestMasterApi } from '@/lib/masters/client-api';
import {
  APPROVAL_STATUS_LABELS,
  ENTRY_TYPE_LABELS,
  SALES_STATUS_LABELS,
  type ApprovalStatus,
  type SalesEditorLookupsDto,
  type SalesEntryType,
  type SalesListItemDto,
  type SalesPageDto,
  type SalesProductSummaryResultDto,
  type SalesStatus,
} from '@/lib/sales/types';

interface SalesListClientProps {
  initialTab: 'SALE' | 'ADVANCE' | 'SUMMARY';
  lookups: SalesEditorLookupsDto;
  initialSalesPage: SalesPageDto | null;
  initialAdvancePage: SalesPageDto | null;
  initialProductSummary: SalesProductSummaryResultDto | null;
}

function formatYen(amount: number): string {
  return `¥${amount.toLocaleString('ja-JP')}`;
}

function formatQty(qty: number): string {
  if (Number.isInteger(qty)) return qty.toLocaleString('ja-JP');
  return qty.toFixed(4).replace(/0+$/, '').replace(/\.$/, '');
}

export default function SalesListClient({
  initialTab,
  lookups,
  initialSalesPage,
  initialAdvancePage,
  initialProductSummary,
}: SalesListClientProps) {
  const [activeTab, setActiveTab] = useState<'SALE' | 'ADVANCE' | 'SUMMARY'>(initialTab);

  // 伝票一覧状態（売上/立替タブ共用、タブ切替で再ロードまたは初期値保持）
  const [pageData, setPageData] = useState<SalesPageDto>(() => {
    if (initialTab === 'ADVANCE' && initialAdvancePage !== null) return initialAdvancePage;
    if (initialSalesPage !== null) return initialSalesPage;
    if (initialAdvancePage !== null) return initialAdvancePage;
    return {
      items: [],
      summary: {
        totalCount: 0,
        subtotalAmount: 0,
        taxTotal: 0,
        totalAmount: 0,
        approvedCount: 0,
        pendingCount: 0,
      },
      page: 1,
      pageSize: 25,
    };
  });

  const [keyword, setKeyword] = useState('');
  const [status, setStatus] = useState<'' | SalesStatus>('');
  const [approvalFilter, setApprovalFilter] = useState<'' | '0' | '1' | '2'>('');
  const [dateFrom, setDateFrom] = useState('');
  const [dateTo, setDateTo] = useState('');
  const [projectLink, setProjectLink] = useState<'ALL' | 'LINKED' | 'UNLINKED'>('ALL');
  const [selectedIds, setSelectedIds] = useState<string[]>([]);

  // 商品別集計状態
  const [summaryData, setSummaryData] = useState<SalesProductSummaryResultDto>(
    initialProductSummary !== null
      ? initialProductSummary
      : { items: [], totals: { rowCount: 0, exclAmount: 0, taxAmount: 0, inclAmount: 0 } },
  );
  const [sumEntryFilter, setSumEntryFilter] = useState<'ALL' | SalesEntryType>('ALL');
  const [sumPartnerId, setSumPartnerId] = useState('');
  const [sumDateFrom, setSumDateFrom] = useState('');
  const [sumDateTo, setSumDateTo] = useState('');
  const [sumKeyword, setSumKeyword] = useState('');

  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [bannerError, setBannerError] = useState<string | null>(null);
  const [bannerSuccess, setBannerSuccess] = useState<string | null>(null);

  const currentEntryType: SalesEntryType = activeTab === 'ADVANCE' ? 'ADVANCE' : 'SALE';
  const totalPages = computePageCount(pageData.summary.totalCount, pageData.pageSize);

  function buildSalesQuery(
    entryType: SalesEntryType,
    overrides?: {
      q?: string;
      st?: '' | SalesStatus;
      ap?: '' | '0' | '1' | '2';
      from?: string;
      to?: string;
      pj?: 'ALL' | 'LINKED' | 'UNLINKED';
      page?: number;
    },
  ): URLSearchParams {
    const q = overrides?.q !== undefined ? overrides.q : keyword;
    const st = overrides?.st !== undefined ? overrides.st : status;
    const ap = overrides?.ap !== undefined ? overrides.ap : approvalFilter;
    const from = overrides?.from !== undefined ? overrides.from : dateFrom;
    const to = overrides?.to !== undefined ? overrides.to : dateTo;
    const pj = overrides?.pj !== undefined ? overrides.pj : projectLink;
    const p = overrides?.page !== undefined ? overrides.page : pageData.page;

    const params = new URLSearchParams();
    params.set('entryType', entryType);
    if (q.trim() !== '') params.set('q', q.trim());
    if (st !== '') params.set('status', st);
    if (ap !== '') params.set('approvalStatus', ap);
    if (from.trim() !== '') params.set('dateFrom', from.trim());
    if (to.trim() !== '') params.set('dateTo', to.trim());
    if (pj !== 'ALL') params.set('projectLink', pj);
    params.set('page', String(p));
    params.set('pageSize', String(pageData.pageSize));
    return params;
  }

  async function loadSalesPage(
    entryType: SalesEntryType,
    overrides?: Parameters<typeof buildSalesQuery>[1],
  ) {
    setLoading(true);
    setBannerError(null);
    const params = buildSalesQuery(entryType, overrides);
    const res = await requestMasterApi<SalesPageDto>(`/api/v1/sales?${params.toString()}`);
    setLoading(false);
    if (!res.ok) {
      setBannerError(res.error);
      return;
    }
    setSelectedIds([]);
    setPageData({
      items: res.data.items,
      summary: res.data.summary,
      page: res.data.page,
      pageSize: res.data.pageSize,
    });
  }

  function buildSummaryQuery(): URLSearchParams {
    const params = new URLSearchParams();
    if (sumEntryFilter !== 'ALL') params.set('entryTypeFilter', sumEntryFilter);
    if (sumPartnerId !== '') params.set('partnerId', sumPartnerId);
    if (sumDateFrom.trim() !== '') params.set('dateFrom', sumDateFrom.trim());
    if (sumDateTo.trim() !== '') params.set('dateTo', sumDateTo.trim());
    if (sumKeyword.trim() !== '') params.set('q', sumKeyword.trim());
    return params;
  }

  async function loadProductSummary() {
    setLoading(true);
    setBannerError(null);
    const params = buildSummaryQuery();
    const res = await requestMasterApi<SalesProductSummaryResultDto>(
      `/api/v1/sales/product-summary?${params.toString()}`,
    );
    setLoading(false);
    if (!res.ok) {
      setBannerError(res.error);
      return;
    }
    setSummaryData({
      items: res.data.items,
      totals: res.data.totals,
    });
  }

  function handleTabSwitch(nextTab: 'SALE' | 'ADVANCE' | 'SUMMARY') {
    setActiveTab(nextTab);
    setBannerError(null);
    setBannerSuccess(null);
    if (nextTab === 'SUMMARY') {
      void loadProductSummary();
    } else {
      void loadSalesPage(nextTab, { page: 1 });
    }
  }

  function handleSearchSubmit(e: React.FormEvent) {
    e.preventDefault();
    void loadSalesPage(currentEntryType, { page: 1 });
  }

  function handleResetFilters() {
    setKeyword('');
    setStatus('');
    setApprovalFilter('');
    setDateFrom('');
    setDateTo('');
    setProjectLink('ALL');
    void loadSalesPage(currentEntryType, {
      q: '',
      st: '',
      ap: '',
      from: '',
      to: '',
      pj: 'ALL',
      page: 1,
    });
  }

  function toggleRowSelect(id: string) {
    setSelectedIds((prev) =>
      prev.includes(id) ? prev.filter((item) => item !== id) : [...prev, id],
    );
  }

  function toggleSelectAllUnbilled() {
    const selectable = pageData.items
      .filter((i) => i.status !== 'K4' && i.status !== 'K5')
      .map((i) => i.id);
    if (selectable.length === 0) return;
    if (selectedIds.length === selectable.length) {
      setSelectedIds([]);
    } else {
      setSelectedIds(selectable);
    }
  }

  async function handleBatchApproval(approvalStatus: ApprovalStatus) {
    if (selectedIds.length === 0) return;
    setBannerError(null);
    setBannerSuccess(null);
    setBusy(true);
    const res = await requestMasterApi<{ updatedCount: number }>('/api/v1/sales/approval', {
      method: 'PATCH',
      body: JSON.stringify({
        ids: selectedIds,
        approvalStatus,
      }),
    });
    setBusy(false);
    if (!res.ok) {
      setBannerError(res.error);
      return;
    }
    setBannerSuccess(
      `${res.data.updatedCount}件の伝票を「${APPROVAL_STATUS_LABELS[approvalStatus]}」に更新しました。`,
    );
    await loadSalesPage(currentEntryType);
  }

  async function handleDelete(item: SalesListItemDto) {
    if (!window.confirm(`${ENTRY_TYPE_LABELS[item.entryType]} #${item.slipNo}「${item.slipName}」を削除しますか？`)) {
      return;
    }
    setBannerError(null);
    setBannerSuccess(null);
    setBusy(true);
    const res = await requestMasterApi<{ ok: true }>(
      `/api/v1/sales/${encodeURIComponent(item.id)}`,
      { method: 'DELETE' },
    );
    setBusy(false);
    if (!res.ok) {
      setBannerError(res.error);
      return;
    }
    setBannerSuccess(`${ENTRY_TYPE_LABELS[item.entryType]} #${item.slipNo} を削除しました。`);
    await loadSalesPage(currentEntryType);
  }

  function getSalesExportUrl(format: 'csv' | 'pdf'): string {
    const params = buildSalesQuery(currentEntryType, { page: 1 });
    params.delete('entryType');
    params.delete('page');
    params.delete('pageSize');
    params.set('kind', currentEntryType);
    params.set('format', format);
    return `/api/v1/sales/export?${params.toString()}`;
  }

  function getSummaryExportUrl(format: 'csv' | 'pdf'): string {
    const params = buildSummaryQuery();
    params.set('kind', 'PRODUCT_SUMMARY');
    params.set('format', format);
    return `/api/v1/sales/export?${params.toString()}`;
  }

  return (
    <div className="max-w-7xl space-y-5">
      {/* ヘッダ */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold text-slate-900">売上・立替金管理</h1>
          <p className="text-sm text-slate-600 mt-1">
            売上・立替伝票の登録、承認フロー管理、納品書／受領書スナップショット発行、商品別売上・立替集計を行います。
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          {activeTab === 'SUMMARY' ? (
            <>
              <a
                href={getSummaryExportUrl('csv')}
                className="rounded-lg border border-slate-300 bg-white hover:bg-slate-50 px-3 py-2 text-xs font-medium text-slate-700"
              >
                集計CSV出力
              </a>
              <a
                href={getSummaryExportUrl('pdf')}
                target="_blank"
                rel="noopener noreferrer"
                className="rounded-lg border border-slate-300 bg-white hover:bg-slate-50 px-3 py-2 text-xs font-medium text-slate-700"
              >
                商品別集計PDF出力
              </a>
            </>
          ) : (
            <>
              <a
                href={getSalesExportUrl('csv')}
                className="rounded-lg border border-slate-300 bg-white hover:bg-slate-50 px-3 py-2 text-xs font-medium text-slate-700"
              >
                CSVエクスポート
              </a>
              <a
                href={getSalesExportUrl('pdf')}
                target="_blank"
                rel="noopener noreferrer"
                className="rounded-lg border border-slate-300 bg-white hover:bg-slate-50 px-3 py-2 text-xs font-medium text-slate-700"
              >
                {activeTab === 'ADVANCE' ? '立替金一覧PDF' : '売上一覧PDF'}
              </a>
              <Link
                href={`/sales/new?entryType=${currentEntryType}`}
                className="rounded-lg bg-blue-600 hover:bg-blue-700 px-4 py-2 text-xs font-semibold text-white"
              >
                ＋ 新規{currentEntryType === 'ADVANCE' ? '立替金' : '売上'}作成
              </Link>
            </>
          )}
        </div>
      </div>

      {/* タブ切替（無効機能フラグのタブは非表示） */}
      <div className="flex items-center gap-2 border-b border-slate-200">
        {lookups.salesEnabled && (
          <button
            type="button"
            onClick={() => handleTabSwitch('SALE')}
            className={`px-4 py-2.5 text-sm font-medium border-b-2 transition-colors cursor-pointer ${
              activeTab === 'SALE'
                ? 'border-blue-600 text-blue-700'
                : 'border-transparent text-slate-600 hover:text-slate-900'
            }`}
          >
            売上伝票
          </button>
        )}
        {lookups.tatekaeEnabled && (
          <button
            type="button"
            onClick={() => handleTabSwitch('ADVANCE')}
            className={`px-4 py-2.5 text-sm font-medium border-b-2 transition-colors cursor-pointer ${
              activeTab === 'ADVANCE'
                ? 'border-blue-600 text-blue-700'
                : 'border-transparent text-slate-600 hover:text-slate-900'
            }`}
          >
            立替金伝票
          </button>
        )}
        {(lookups.salesEnabled || lookups.tatekaeEnabled) && (
          <button
            type="button"
            onClick={() => handleTabSwitch('SUMMARY')}
            className={`px-4 py-2.5 text-sm font-medium border-b-2 transition-colors cursor-pointer ${
              activeTab === 'SUMMARY'
                ? 'border-blue-600 text-blue-700'
                : 'border-transparent text-slate-600 hover:text-slate-900'
            }`}
          >
            商品別売上・立替集計
          </button>
        )}
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

      {activeTab !== 'SUMMARY' ? (
        <>
          {/* サマリカード */}
          <div className="grid grid-cols-2 lg:grid-cols-5 gap-3">
            <div className="rounded-xl bg-white border border-slate-200 p-4 shadow-xs">
              <div className="text-xs font-medium text-slate-500">対象伝票件数</div>
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
              <div className="text-xs font-medium text-slate-500">承認状況</div>
              <div className="text-sm font-bold text-slate-900 mt-1.5 font-mono">
                承認済: {pageData.summary.approvedCount} / 未承認: {pageData.summary.pendingCount}
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
                  キーワード（伝票No・件名・取引先・案件）
                </label>
                <input
                  type="text"
                  value={keyword}
                  onChange={(e) => setKeyword(e.target.value)}
                  placeholder="例: 改修工事 / 00007 / 5"
                  className="w-full rounded-lg border border-slate-300 px-3 py-1.5 text-sm text-slate-900"
                />
              </div>

              <div>
                <label className="block text-xs font-medium text-slate-600 mb-1">ステータス</label>
                <select
                  value={status}
                  onChange={(e) => setStatus(e.target.value as '' | SalesStatus)}
                  className="w-full rounded-lg border border-slate-300 px-2.5 py-1.5 text-sm bg-white"
                >
                  <option value="">すべて</option>
                  {(Object.keys(SALES_STATUS_LABELS) as SalesStatus[]).map((st) => (
                    <option key={st} value={st}>
                      {st}: {SALES_STATUS_LABELS[st]}
                    </option>
                  ))}
                </select>
              </div>

              <div>
                <label className="block text-xs font-medium text-slate-600 mb-1">承認状態</label>
                <select
                  value={approvalFilter}
                  onChange={(e) => setApprovalFilter(e.target.value as '' | '0' | '1' | '2')}
                  className="w-full rounded-lg border border-slate-300 px-2.5 py-1.5 text-sm bg-white"
                >
                  <option value="">すべて</option>
                  <option value="0">未承認</option>
                  <option value="1">承認済</option>
                  <option value="2">差戻し</option>
                </select>
              </div>

              <div>
                <label className="block text-xs font-medium text-slate-600 mb-1">売上日（From）</label>
                <input
                  type="date"
                  value={dateFrom}
                  onChange={(e) => setDateFrom(e.target.value)}
                  className="w-full rounded-lg border border-slate-300 px-2.5 py-1.5 text-sm"
                />
              </div>

              <div>
                <label className="block text-xs font-medium text-slate-600 mb-1">売上日（To）</label>
                <input
                  type="date"
                  value={dateTo}
                  onChange={(e) => setDateTo(e.target.value)}
                  className="w-full rounded-lg border border-slate-300 px-2.5 py-1.5 text-sm"
                />
              </div>
            </div>

            <div className="flex flex-wrap items-center justify-between gap-2">
              <div className="flex items-center gap-2">
                <span className="text-xs text-slate-500">案件紐付:</span>
                <select
                  value={projectLink}
                  onChange={(e) => setProjectLink(e.target.value as 'ALL' | 'LINKED' | 'UNLINKED')}
                  className="rounded-lg border border-slate-300 px-2.5 py-1 text-xs bg-white"
                >
                  <option value="ALL">すべて</option>
                  <option value="LINKED">案件あり</option>
                  <option value="UNLINKED">案件なし</option>
                </select>
              </div>

              <div className="flex items-center gap-2">
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
            </div>
          </form>

          {/* 一括承認操作バー */}
          {selectedIds.length > 0 && (
            <div className="rounded-xl border border-blue-200 bg-blue-50 px-4 py-2.5 flex flex-wrap items-center justify-between gap-2">
              <span className="text-xs font-semibold text-blue-900">
                {selectedIds.length} 件の伝票を選択中
              </span>
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => void handleBatchApproval(1)}
                  className="rounded bg-emerald-600 hover:bg-emerald-700 px-3 py-1 text-xs font-semibold text-white cursor-pointer"
                >
                  一括承認
                </button>
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => void handleBatchApproval(2)}
                  className="rounded bg-amber-600 hover:bg-amber-700 px-3 py-1 text-xs font-semibold text-white cursor-pointer"
                >
                  一括差戻し
                </button>
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => void handleBatchApproval(0)}
                  className="rounded border border-slate-300 bg-white hover:bg-slate-50 px-3 py-1 text-xs font-medium text-slate-700 cursor-pointer"
                >
                  未承認に戻す
                </button>
              </div>
            </div>
          )}

          {/* 伝票一覧テーブル */}
          <div className="rounded-xl bg-white border border-slate-200 shadow-xs overflow-hidden">
            <div className="overflow-x-auto">
              <table className="min-w-full divide-y divide-slate-200 text-sm">
                <thead className="bg-slate-50 text-xs font-semibold text-slate-600">
                  <tr>
                    <th className="px-3 py-2.5 text-center w-9">
                      <input
                        type="checkbox"
                        onChange={toggleSelectAllUnbilled}
                        checked={
                          selectedIds.length > 0 &&
                          selectedIds.length ===
                            pageData.items.filter((i) => i.status !== 'K4' && i.status !== 'K5').length
                        }
                        title="未請求伝票を全選択"
                      />
                    </th>
                    <th className="px-3 py-2.5 text-right whitespace-nowrap">伝票No</th>
                    <th className="px-3 py-2.5 text-center whitespace-nowrap">売上日</th>
                    <th className="px-3 py-2.5 text-center whitespace-nowrap">ステータス</th>
                    <th className="px-3 py-2.5 text-center whitespace-nowrap">承認</th>
                    <th className="px-3 py-2.5 text-left">取引先</th>
                    <th className="px-3 py-2.5 text-left">件名 / 案件</th>
                    <th className="px-3 py-2.5 text-right whitespace-nowrap">税抜金額</th>
                    <th className="px-3 py-2.5 text-right whitespace-nowrap">消費税</th>
                    <th className="px-3 py-2.5 text-right whitespace-nowrap">税込合計</th>
                    <th className="px-3 py-2.5 text-center whitespace-nowrap">納品/受領書</th>
                    <th className="px-3 py-2.5 text-right whitespace-nowrap">操作</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {pageData.items.length === 0 ? (
                    <tr>
                      <td colSpan={12} className="px-4 py-8 text-center text-sm text-slate-500">
                        条件に一致する伝票データがありません。
                      </td>
                    </tr>
                  ) : (
                    pageData.items.map((item) => {
                      const isBilled = item.status === 'K4' || item.status === 'K5';
                      return (
                        <tr key={item.id} className="hover:bg-slate-50/80">
                          <td className="px-3 py-2.5 text-center">
                            <input
                              type="checkbox"
                              disabled={isBilled}
                              checked={selectedIds.includes(item.id)}
                              onChange={() => toggleRowSelect(item.id)}
                            />
                          </td>
                          <td className="px-3 py-2.5 text-right font-mono font-semibold text-blue-700 whitespace-nowrap">
                            <Link href={`/sales/${item.id}`} className="hover:underline">
                              {item.entryType === 'ADVANCE' ? `T-${item.slipNo}` : `#${item.slipNo}`}
                            </Link>
                          </td>
                          <td className="px-3 py-2.5 text-center font-mono text-xs text-slate-700 whitespace-nowrap">
                            {item.slipDate}
                          </td>
                          <td className="px-3 py-2.5 text-center whitespace-nowrap">
                            <span
                              className={`inline-flex px-2 py-0.5 rounded-full text-[11px] font-semibold ${
                                isBilled
                                  ? 'bg-purple-100 text-purple-800'
                                  : item.status === 'K3'
                                    ? 'bg-emerald-100 text-emerald-800'
                                    : item.status === 'K2'
                                      ? 'bg-blue-100 text-blue-800'
                                      : 'bg-slate-100 text-slate-700'
                              }`}
                            >
                              {item.status}: {SALES_STATUS_LABELS[item.status]}
                            </span>
                          </td>
                          <td className="px-3 py-2.5 text-center whitespace-nowrap">
                            <span
                              className={`inline-flex px-2 py-0.5 rounded-full text-[11px] font-semibold ${
                                item.approvalStatus === 1
                                  ? 'bg-emerald-100 text-emerald-800'
                                  : item.approvalStatus === 2
                                    ? 'bg-red-100 text-red-700'
                                    : 'bg-amber-100 text-amber-800'
                              }`}
                            >
                              {APPROVAL_STATUS_LABELS[item.approvalStatus]}
                            </span>
                          </td>
                          <td className="px-3 py-2.5 text-slate-800">
                            <div className="font-medium text-xs">{item.partnerName}</div>
                            <div className="text-[11px] font-mono text-slate-400">
                              {item.partnerCode}
                            </div>
                          </td>
                          <td className="px-3 py-2.5 text-slate-900">
                            <Link
                              href={`/sales/${item.id}`}
                              className="font-medium hover:text-blue-700 hover:underline block"
                            >
                              {item.slipName !== '' ? item.slipName : '（件名なし）'}
                            </Link>
                            {item.projectName !== null && (
                              <div className="text-[11px] text-slate-500 mt-0.5">
                                案件 #{item.projectNo}: {item.projectName}
                              </div>
                            )}
                            <div className="text-[11px] text-slate-400 mt-0.5">
                              明細 {item.lineCount}行
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
                          <td className="px-3 py-2.5 text-center whitespace-nowrap text-[11px] font-mono">
                            <span className="text-slate-600">
                              納:{item.latestDeliveryNoteVersion !== null ? `v${item.latestDeliveryNoteVersion}` : '-'}
                            </span>
                            <span className="mx-1 text-slate-300">/</span>
                            <span className="text-slate-600">
                              受:{item.latestDeliveryReceiptVersion !== null ? `v${item.latestDeliveryReceiptVersion}` : '-'}
                            </span>
                          </td>
                          <td className="px-3 py-2.5 text-right whitespace-nowrap">
                            <div className="inline-flex items-center gap-1.5">
                              <Link
                                href={`/sales/${item.id}`}
                                className="rounded border border-slate-300 bg-white hover:bg-slate-50 px-2 py-1 text-xs font-medium text-slate-700"
                              >
                                {isBilled ? '閲覧' : '開く'}
                              </Link>
                              {!isBilled &&
                                item.deliveryNoteCount === 0 &&
                                item.deliveryReceiptCount === 0 && (
                                  <button
                                    type="button"
                                    disabled={busy}
                                    onClick={() => void handleDelete(item)}
                                    className="rounded border border-red-200 bg-white hover:bg-red-50 px-2 py-1 text-xs font-medium text-red-700 cursor-pointer"
                                  >
                                    削除
                                  </button>
                                )}
                            </div>
                          </td>
                        </tr>
                      );
                    })
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
                  onClick={() => void loadSalesPage(currentEntryType, { page: pageData.page - 1 })}
                  className="rounded border border-slate-300 bg-white px-2.5 py-1 disabled:opacity-40 cursor-pointer"
                >
                  前へ
                </button>
                <button
                  type="button"
                  disabled={pageData.page >= totalPages || loading}
                  onClick={() => void loadSalesPage(currentEntryType, { page: pageData.page + 1 })}
                  className="rounded border border-slate-300 bg-white px-2.5 py-1 disabled:opacity-40 cursor-pointer"
                >
                  次へ
                </button>
              </div>
            </div>
          </div>
        </>
      ) : (
        /* 商品別売上・立替集計タブ */
        <div className="space-y-4">
          <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
            <div className="rounded-xl bg-white border border-slate-200 p-4 shadow-xs">
              <div className="text-xs font-medium text-slate-500">集計品目数</div>
              <div className="text-xl font-bold text-slate-900 mt-1 font-mono">
                {summaryData.totals.rowCount} 件
              </div>
            </div>
            <div className="rounded-xl bg-white border border-slate-200 p-4 shadow-xs">
              <div className="text-xs font-medium text-slate-500">税抜金額合計</div>
              <div className="text-xl font-bold text-slate-900 mt-1 font-mono">
                {formatYen(summaryData.totals.exclAmount)}
              </div>
            </div>
            <div className="rounded-xl bg-white border border-slate-200 p-4 shadow-xs">
              <div className="text-xs font-medium text-slate-500">消費税額合計</div>
              <div className="text-xl font-bold text-slate-900 mt-1 font-mono">
                {formatYen(summaryData.totals.taxAmount)}
              </div>
            </div>
            <div className="rounded-xl bg-blue-50 border border-blue-200 p-4 shadow-xs">
              <div className="text-xs font-semibold text-blue-700">税込金額合計</div>
              <div className="text-xl font-bold text-blue-900 mt-1 font-mono">
                {formatYen(summaryData.totals.inclAmount)}
              </div>
            </div>
          </div>

          <form
            onSubmit={(e) => {
              e.preventDefault();
              void loadProductSummary();
            }}
            className="rounded-xl bg-white border border-slate-200 p-4 shadow-xs"
          >
            <div className="grid grid-cols-1 md:grid-cols-5 gap-3">
              <div>
                <label className="block text-xs font-medium text-slate-600 mb-1">区分</label>
                <select
                  value={sumEntryFilter}
                  onChange={(e) => setSumEntryFilter(e.target.value as 'ALL' | SalesEntryType)}
                  className="w-full rounded-lg border border-slate-300 px-2.5 py-1.5 text-sm bg-white"
                >
                  {lookups.salesEnabled && lookups.tatekaeEnabled && (
                    <option value="ALL">すべて（売上＋立替）</option>
                  )}
                  {lookups.salesEnabled && <option value="SALE">売上のみ</option>}
                  {lookups.tatekaeEnabled && <option value="ADVANCE">立替のみ</option>}
                </select>
              </div>
              <div>
                <label className="block text-xs font-medium text-slate-600 mb-1">取引先</label>
                <select
                  value={sumPartnerId}
                  onChange={(e) => setSumPartnerId(e.target.value)}
                  className="w-full rounded-lg border border-slate-300 px-2.5 py-1.5 text-sm bg-white"
                >
                  <option value="">すべての取引先</option>
                  {lookups.partners.map((p) => (
                    <option key={p.id} value={p.id}>
                      [{p.partnerCode}] {p.partnerName}
                    </option>
                  ))}
                </select>
              </div>
              <div>
                <label className="block text-xs font-medium text-slate-600 mb-1">期間（From）</label>
                <input
                  type="date"
                  value={sumDateFrom}
                  onChange={(e) => setSumDateFrom(e.target.value)}
                  className="w-full rounded-lg border border-slate-300 px-2.5 py-1.5 text-sm"
                />
              </div>
              <div>
                <label className="block text-xs font-medium text-slate-600 mb-1">期間（To）</label>
                <input
                  type="date"
                  value={sumDateTo}
                  onChange={(e) => setSumDateTo(e.target.value)}
                  className="w-full rounded-lg border border-slate-300 px-2.5 py-1.5 text-sm"
                />
              </div>
              <div>
                <label className="block text-xs font-medium text-slate-600 mb-1">品名・コード</label>
                <div className="flex gap-1.5">
                  <input
                    type="text"
                    value={sumKeyword}
                    onChange={(e) => setSumKeyword(e.target.value)}
                    placeholder="品名検索..."
                    className="w-full rounded-lg border border-slate-300 px-2.5 py-1.5 text-sm"
                  />
                  <button
                    type="submit"
                    disabled={loading}
                    className="rounded-lg bg-slate-800 hover:bg-slate-700 px-3 py-1.5 text-xs font-semibold text-white shrink-0 cursor-pointer"
                  >
                    集計
                  </button>
                </div>
              </div>
            </div>
          </form>

          <div className="rounded-xl bg-white border border-slate-200 shadow-xs overflow-hidden">
            <div className="overflow-x-auto">
              <table className="min-w-full divide-y divide-slate-200 text-sm">
                <thead className="bg-slate-50 text-xs font-semibold text-slate-600">
                  <tr>
                    <th className="px-3 py-2.5 text-center">区分</th>
                    <th className="px-3 py-2.5 text-left">商品コード</th>
                    <th className="px-3 py-2.5 text-left">品名・仕様</th>
                    <th className="px-3 py-2.5 text-center">単位</th>
                    <th className="px-3 py-2.5 text-center">税区分</th>
                    <th className="px-3 py-2.5 text-right">伝票数</th>
                    <th className="px-3 py-2.5 text-right">合計数量</th>
                    <th className="px-3 py-2.5 text-right">税抜金額</th>
                    <th className="px-3 py-2.5 text-right">消費税額</th>
                    <th className="px-3 py-2.5 text-right">税込金額</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {summaryData.items.length === 0 ? (
                    <tr>
                      <td colSpan={10} className="px-4 py-8 text-center text-sm text-slate-500">
                        該当する集計データがありません。
                      </td>
                    </tr>
                  ) : (
                    summaryData.items.map((row, idx) => (
                      <tr key={`${row.entryType}-${row.itemName}-${row.taxCode}-${idx}`} className="hover:bg-slate-50">
                        <td className="px-3 py-2 text-center">
                          <span
                            className={`inline-flex px-2 py-0.5 rounded text-[11px] font-semibold ${
                              row.entryType === 'ADVANCE'
                                ? 'bg-purple-100 text-purple-800'
                                : 'bg-blue-100 text-blue-800'
                            }`}
                          >
                            {ENTRY_TYPE_LABELS[row.entryType]}
                          </span>
                        </td>
                        <td className="px-3 py-2 font-mono text-xs text-slate-500">
                          {row.itemCode !== null ? row.itemCode : '-'}
                        </td>
                        <td className="px-3 py-2 text-slate-900 font-medium whitespace-pre-line">
                          {row.itemName}
                        </td>
                        <td className="px-3 py-2 text-center text-xs text-slate-600">
                          {row.unitName !== null ? row.unitName : '-'}
                        </td>
                        <td className="px-3 py-2 text-center font-mono text-xs">{row.taxCode}</td>
                        <td className="px-3 py-2 text-right font-mono text-xs">{row.slipCount}</td>
                        <td className="px-3 py-2 text-right font-mono text-xs">
                          {formatQty(row.totalQuantity)}
                        </td>
                        <td className="px-3 py-2 text-right font-mono text-xs">
                          {formatYen(row.exclAmount)}
                        </td>
                        <td className="px-3 py-2 text-right font-mono text-xs text-slate-600">
                          {formatYen(row.taxAmount)}
                        </td>
                        <td className="px-3 py-2 text-right font-mono text-xs font-bold text-slate-900">
                          {formatYen(row.inclAmount)}
                        </td>
                      </tr>
                    ))
                  )}
                </tbody>
              </table>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
