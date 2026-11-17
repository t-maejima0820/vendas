'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect, useMemo, useState } from 'react';
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

interface DateGroupSummary {
  date: string;
  displayDate: string;
  dayOfWeek: string;
  isSunday: boolean;
  isSaturday: boolean;
  count: number;
  approvedCount: number;
  pendingCount: number;
  billedCount: number;
  projectLinkedCount: number;
  subtotalAmount: number;
  taxTotal: number;
  totalAmount: number;
}

const DOW_NAMES = ['日', '月', '火', '水', '木', '金', '土'] as const;

function formatYen(amount: number): string {
  return `¥${amount.toLocaleString('ja-JP')}`;
}

function formatQty(qty: number): string {
  if (Number.isInteger(qty)) return qty.toLocaleString('ja-JP');
  return qty.toFixed(4).replace(/0+$/, '').replace(/\.$/, '');
}

function getDateMeta(isoDate: string): {
  displayDate: string;
  dayOfWeek: string;
  isSunday: boolean;
  isSaturday: boolean;
} {
  const parts = isoDate.split('-').map(Number);
  const y = parts[0];
  const m = parts[1];
  const d = parts[2];
  if (
    parts.length !== 3 ||
    y === undefined ||
    m === undefined ||
    d === undefined ||
    Number.isNaN(y) ||
    Number.isNaN(m) ||
    Number.isNaN(d)
  ) {
    return {
      displayDate: isoDate.replace(/-/g, '/'),
      dayOfWeek: '-',
      isSunday: false,
      isSaturday: false,
    };
  }
  const dt = new Date(y, m - 1, d);
  const dowRaw = DOW_NAMES[dt.getDay()];
  const dow = dowRaw !== undefined ? dowRaw : '-';
  return {
    displayDate: isoDate.replace(/-/g, '/'),
    dayOfWeek: dow,
    isSunday: dow === '日',
    isSaturday: dow === '土',
  };
}

function parseYearMonth(yearMonth: string): { y: number; m: number } {
  const parts = yearMonth.split('-').map(Number);
  const y = parts[0];
  const m = parts[1];
  if (
    y !== undefined &&
    m !== undefined &&
    !Number.isNaN(y) &&
    !Number.isNaN(m) &&
    m >= 1 &&
    m <= 12
  ) {
    return { y, m };
  }
  const now = new Date();
  return { y: now.getFullYear(), m: now.getMonth() + 1 };
}

function buildMonthRange(yearMonth: string): { from: string; to: string } {
  const { y, m } = parseYearMonth(yearMonth);
  const lastDay = new Date(y, m, 0).getDate();
  const ym = `${String(y).padStart(4, '0')}-${String(m).padStart(2, '0')}`;
  return {
    from: `${ym}-01`,
    to: `${ym}-${String(lastDay).padStart(2, '0')}`,
  };
}

function shiftYearMonth(yearMonth: string, delta: number): string {
  const { y, m } = parseYearMonth(yearMonth);
  const dt = new Date(y, m - 1 + delta, 1);
  return `${dt.getFullYear()}-${String(dt.getMonth() + 1).padStart(2, '0')}`;
}

export default function SalesListClient({
  initialTab,
  lookups,
  initialSalesPage,
  initialAdvancePage,
  initialProductSummary,
}: SalesListClientProps) {
  const router = useRouter();
  const [activeTab, setActiveTab] = useState<'SALE' | 'ADVANCE' | 'SUMMARY'>(initialTab);

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
  const [selectedDateFilter, setSelectedDateFilter] = useState<string | null>(null);
  const [monthCursor, setMonthCursor] = useState<string>(() => {
    const firstItem =
      initialTab === 'ADVANCE' && initialAdvancePage !== null
        ? initialAdvancePage.items[0]
        : initialSalesPage !== null
          ? initialSalesPage.items[0]
          : undefined;
    return firstItem !== undefined ? firstItem.slipDate.slice(0, 7) : '';
  });

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

  useEffect(() => {
    if (monthCursor === '') {
      setMonthCursor(new Date().toISOString().slice(0, 7));
    }
  }, [monthCursor]);

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'F2' && activeTab !== 'SUMMARY') {
        e.preventDefault();
        router.push(`/sales/new?entryType=${currentEntryType}`);
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [activeTab, currentEntryType, router]);

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
    setSelectedDateFilter(null);
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
    setSelectedDateFilter(null);
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
    setSelectedDateFilter(null);
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

  function handleResetSummaryFilters() {
    setSumEntryFilter('ALL');
    setSumPartnerId('');
    setSumDateFrom('');
    setSumDateTo('');
    setSumKeyword('');
    setLoading(true);
    setBannerError(null);
    void requestMasterApi<SalesProductSummaryResultDto>('/api/v1/sales/product-summary').then((res) => {
      setLoading(false);
      if (!res.ok) {
        setBannerError(res.error);
        return;
      }
      setSummaryData({
        items: res.data.items,
        totals: res.data.totals,
      });
    });
  }

  function handleShiftMonth(delta: number) {
    const activeBase =
      dateFrom.length >= 7
        ? dateFrom.slice(0, 7)
        : monthCursor !== ''
          ? monthCursor
          : new Date().toISOString().slice(0, 7);
    const targetMonth = dateFrom === '' && delta === 0 ? activeBase : shiftYearMonth(activeBase, delta);
    const range = buildMonthRange(targetMonth);
    setMonthCursor(targetMonth);
    setDateFrom(range.from);
    setDateTo(range.to);
    void loadSalesPage(currentEntryType, {
      from: range.from,
      to: range.to,
      page: 1,
    });
  }

  function handleToggleMonthScope() {
    if (dateFrom !== '' || dateTo !== '') {
      setDateFrom('');
      setDateTo('');
      void loadSalesPage(currentEntryType, { from: '', to: '', page: 1 });
      return;
    }
    const targetMonth = monthCursor !== '' ? monthCursor : new Date().toISOString().slice(0, 7);
    const range = buildMonthRange(targetMonth);
    setMonthCursor(targetMonth);
    setDateFrom(range.from);
    setDateTo(range.to);
    void loadSalesPage(currentEntryType, {
      from: range.from,
      to: range.to,
      page: 1,
    });
  }

  const dateGroups = useMemo<DateGroupSummary[]>(() => {
    const map = new Map<string, DateGroupSummary>();
    for (const item of pageData.items) {
      const existing = map.get(item.slipDate);
      const isBilled = item.status === 'K4' || item.status === 'K5';
      const isApproved = item.approvalStatus === 1;
      const isPending = item.approvalStatus === 0;
      const isLinked = item.projectId !== null;

      if (existing === undefined) {
        const meta = getDateMeta(item.slipDate);
        map.set(item.slipDate, {
          date: item.slipDate,
          displayDate: meta.displayDate,
          dayOfWeek: meta.dayOfWeek,
          isSunday: meta.isSunday,
          isSaturday: meta.isSaturday,
          count: 1,
          approvedCount: isApproved ? 1 : 0,
          pendingCount: isPending ? 1 : 0,
          billedCount: isBilled ? 1 : 0,
          projectLinkedCount: isLinked ? 1 : 0,
          subtotalAmount: item.subtotalAmount,
          taxTotal: item.taxTotal,
          totalAmount: item.totalAmount,
        });
      } else {
        existing.count += 1;
        if (isApproved) existing.approvedCount += 1;
        if (isPending) existing.pendingCount += 1;
        if (isBilled) existing.billedCount += 1;
        if (isLinked) existing.projectLinkedCount += 1;
        existing.subtotalAmount += item.subtotalAmount;
        existing.taxTotal += item.taxTotal;
        existing.totalAmount += item.totalAmount;
      }
    }
    return Array.from(map.values()).sort((a, b) => b.date.localeCompare(a.date));
  }, [pageData.items]);

  const displayedItems = useMemo(() => {
    if (selectedDateFilter === null) return pageData.items;
    return pageData.items.filter((item) => item.slipDate === selectedDateFilter);
  }, [pageData.items, selectedDateFilter]);

  const pageItemsTotals = useMemo(() => {
    let subtotal = 0;
    let tax = 0;
    let total = 0;
    for (const item of pageData.items) {
      subtotal += item.subtotalAmount;
      tax += item.taxTotal;
      total += item.totalAmount;
    }
    return { subtotal, tax, total };
  }, [pageData.items]);

  const displayedTotals = useMemo(() => {
    let subtotal = 0;
    let tax = 0;
    let total = 0;
    for (const item of displayedItems) {
      subtotal += item.subtotalAmount;
      tax += item.taxTotal;
      total += item.totalAmount;
    }
    return { subtotal, tax, total };
  }, [displayedItems]);

  const approvalRateText =
    pageData.summary.totalCount > 0
      ? `${((pageData.summary.approvedCount / pageData.summary.totalCount) * 100).toFixed(1)}%`
      : '0.0%';

  function toggleRowSelect(id: string) {
    setSelectedIds((prev) =>
      prev.includes(id) ? prev.filter((item) => item !== id) : [...prev, id],
    );
  }

  function toggleSelectAllUnbilled() {
    const selectable = displayedItems
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
    if (
      !window.confirm(
        `${ENTRY_TYPE_LABELS[item.entryType]} #${item.slipNo}「${item.slipName}」を削除しますか？`,
      )
    ) {
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

  const activeMonthLabel =
    dateFrom !== '' && dateTo !== ''
      ? dateFrom.slice(0, 7).replace('-', '/')
      : dateFrom !== ''
        ? `${dateFrom.replace(/-/g, '/')}〜`
        : dateTo !== ''
          ? `〜${dateTo.replace(/-/g, '/')}`
          : '全期間';

  const selectedDateDisplay =
    selectedDateFilter !== null
      ? `${selectedDateFilter.replace(/-/g, '/')} (${getDateMeta(selectedDateFilter).dayOfWeek})`
      : '全表示（選択頁）';

  const selectableCount = displayedItems.filter(
    (i) => i.status !== 'K4' && i.status !== 'K5',
  ).length;

  return (
    <div className="-m-6 min-h-[calc(100vh-3.5rem)] lg:h-[calc(100vh-3.5rem)] flex flex-col bg-[#F0F3F9] text-[#242852] antialiased lg:overflow-hidden select-none">
      {/* ========================================================= */}
      {/* 画面トップバー（cabacc PageHeader スタイル × Access Vendas 色） */}
      {/* ========================================================= */}
      <header className="h-14 bg-white border-b-2 border-[#4A66AC] px-4 sm:px-6 flex items-center justify-between gap-3 shrink-0 shadow-2xs z-20">
        <div className="flex items-center gap-3 min-w-0">
          <div className="flex items-center gap-2 min-w-0">
            <span className="inline-flex h-8 w-8 items-center justify-center rounded-lg bg-gradient-to-b from-[#4A66AC] to-[#242852] text-white text-sm shadow-2xs shrink-0">
              🧾
            </span>
            <h1 className="text-base sm:text-lg font-black text-[#242852] tracking-tight truncate">
              {activeTab === 'ADVANCE'
                ? '立替金伝票一覧'
                : activeTab === 'SUMMARY'
                  ? '商品別売上・立替集計'
                  : '売上伝票一覧'}
            </h1>
            <span className="hidden xl:inline-flex items-center px-2.5 py-0.5 rounded-md text-[11px] font-bold bg-[#D4E5F6] text-[#242852] border border-[#90A2CF] shrink-0">
              {activeTab === 'ADVANCE'
                ? 'TATEKAE'
                : activeTab === 'SUMMARY'
                  ? 'PRODUCT SUMMARY'
                  : 'SALES SLIPS'}
            </span>
          </div>

          {/* 業務タブ切替ピル */}
          <nav
            aria-label="売上機能タブ"
            className="hidden md:flex items-center gap-1 rounded-full bg-[#F0F3F9] p-1 border border-[#B5C1DF] ml-2"
          >
            {lookups.salesEnabled && (
              <button
                type="button"
                onClick={() => handleTabSwitch('SALE')}
                className={`px-3.5 py-1 rounded-full text-xs font-bold transition cursor-pointer ${
                  activeTab === 'SALE'
                    ? 'bg-gradient-to-b from-[#4A66AC] to-[#3B528A] text-white shadow-xs'
                    : 'text-[#242852] hover:bg-[#D4E5F6]'
                }`}
              >
                売上伝票
              </button>
            )}
            {lookups.tatekaeEnabled && (
              <button
                type="button"
                onClick={() => handleTabSwitch('ADVANCE')}
                className={`px-3.5 py-1 rounded-full text-xs font-bold transition cursor-pointer ${
                  activeTab === 'ADVANCE'
                    ? 'bg-gradient-to-b from-[#4A66AC] to-[#3B528A] text-white shadow-xs'
                    : 'text-[#242852] hover:bg-[#D4E5F6]'
                }`}
              >
                立替金伝票
              </button>
            )}
            {(lookups.salesEnabled || lookups.tatekaeEnabled) && (
              <button
                type="button"
                onClick={() => handleTabSwitch('SUMMARY')}
                className={`px-3.5 py-1 rounded-full text-xs font-bold transition cursor-pointer ${
                  activeTab === 'SUMMARY'
                    ? 'bg-gradient-to-b from-[#4A66AC] to-[#3B528A] text-white shadow-xs'
                    : 'text-[#242852] hover:bg-[#D4E5F6]'
                }`}
              >
                商品別売上・立替集計
              </button>
            )}
          </nav>
        </div>

        {/* 右側アクションボタン群（カプセル型） */}
        <div className="flex items-center gap-2 shrink-0">
          {activeTab === 'SUMMARY' ? (
            <>
              <a
                href={getSummaryExportUrl('csv')}
                className="h-8 px-3.5 rounded-full bg-gradient-to-b from-white via-[#F0F3F9] to-[#D4E5F6] hover:to-[#B5C1DF] text-[#242852] border border-[#90A2CF] shadow-2xs text-xs font-bold inline-flex items-center gap-1 transition"
              >
                <span>集計CSV出力</span>
              </a>
              <a
                href={getSummaryExportUrl('pdf')}
                target="_blank"
                rel="noopener noreferrer"
                className="h-8 px-3.5 rounded-full bg-gradient-to-b from-white via-[#F0F3F9] to-[#D4E5F6] hover:to-[#B5C1DF] text-[#242852] border border-[#90A2CF] shadow-2xs text-xs font-bold inline-flex items-center gap-1 transition"
              >
                <span>商品別集計PDF</span>
              </a>
            </>
          ) : (
            <>
              <a
                href={getSalesExportUrl('csv')}
                className="hidden sm:inline-flex h-8 px-3.5 rounded-full bg-gradient-to-b from-white via-[#F0F3F9] to-[#D4E5F6] hover:to-[#B5C1DF] text-[#242852] border border-[#90A2CF] shadow-2xs text-xs font-bold items-center gap-1 transition"
              >
                <span>CSV出力</span>
              </a>
              <a
                href={getSalesExportUrl('pdf')}
                target="_blank"
                rel="noopener noreferrer"
                className="hidden sm:inline-flex h-8 px-3.5 rounded-full bg-gradient-to-b from-white via-[#F0F3F9] to-[#D4E5F6] hover:to-[#B5C1DF] text-[#242852] border border-[#90A2CF] shadow-2xs text-xs font-bold items-center gap-1 transition"
              >
                <span>{activeTab === 'ADVANCE' ? '立替金一覧PDF' : '売上一覧PDF'}</span>
              </a>
              <Link
                href={`/sales/new?entryType=${currentEntryType}`}
                className="h-8 px-4 rounded-full bg-gradient-to-b from-[#4A66AC] to-[#3B528A] hover:from-[#5974B8] hover:to-[#3B528A] text-white border border-[#242852]/50 shadow-xs text-xs font-bold inline-flex items-center gap-1.5 transition transform hover:-translate-y-0.5 active:translate-y-px"
              >
                <span>＋ 新規{currentEntryType === 'ADVANCE' ? '立替金' : '売上'}発行</span>
                <kbd className="hidden sm:inline-block px-1.5 py-0.5 text-[10px] bg-black/25 text-[#D4E5F6] rounded font-mono font-bold">
                  F2
                </kbd>
              </Link>
            </>
          )}
        </div>
      </header>

      {/* モバイル用タブ切替バー */}
      <div className="md:hidden flex items-center gap-1.5 px-4 py-2 bg-white border-b border-[#B5C1DF] overflow-x-auto shrink-0">
        {lookups.salesEnabled && (
          <button
            type="button"
            onClick={() => handleTabSwitch('SALE')}
            className={`px-3 py-1 rounded-full text-xs font-bold shrink-0 cursor-pointer ${
              activeTab === 'SALE'
                ? 'bg-[#4A66AC] text-white'
                : 'bg-[#F0F3F9] text-[#242852]'
            }`}
          >
            売上伝票
          </button>
        )}
        {lookups.tatekaeEnabled && (
          <button
            type="button"
            onClick={() => handleTabSwitch('ADVANCE')}
            className={`px-3 py-1 rounded-full text-xs font-bold shrink-0 cursor-pointer ${
              activeTab === 'ADVANCE'
                ? 'bg-[#4A66AC] text-white'
                : 'bg-[#F0F3F9] text-[#242852]'
            }`}
          >
            立替金伝票
          </button>
        )}
        {(lookups.salesEnabled || lookups.tatekaeEnabled) && (
          <button
            type="button"
            onClick={() => handleTabSwitch('SUMMARY')}
            className={`px-3 py-1 rounded-full text-xs font-bold shrink-0 cursor-pointer ${
              activeTab === 'SUMMARY'
                ? 'bg-[#4A66AC] text-white'
                : 'bg-[#F0F3F9] text-[#242852]'
            }`}
          >
            商品別集計
          </button>
        )}
      </div>

      {/* ========================================================= */}
      {/* メインエリア */}
      {/* ========================================================= */}
      <div className="flex-1 min-h-0 flex flex-col p-3.5 sm:px-5 sm:py-4 space-y-3 lg:overflow-hidden">
        {bannerError !== null && (
          <div className="rounded-xl border-2 border-[#C00000]/50 bg-[#FEE2E2] px-4 py-2.5 text-xs font-bold text-[#9A0000] flex items-center justify-between shrink-0 shadow-2xs">
            <span>⚠️ {bannerError}</span>
            <button
              type="button"
              onClick={() => setBannerError(null)}
              className="px-2 py-0.5 rounded hover:bg-black/5 text-xs cursor-pointer"
            >
              ✕
            </button>
          </div>
        )}
        {bannerSuccess !== null && (
          <div className="rounded-xl border border-emerald-400 bg-emerald-50 px-4 py-2.5 text-xs font-bold text-emerald-900 flex items-center justify-between shrink-0 shadow-2xs">
            <span>✅ {bannerSuccess}</span>
            <button
              type="button"
              onClick={() => setBannerSuccess(null)}
              className="px-2 py-0.5 rounded hover:bg-black/5 text-xs cursor-pointer"
            >
              ✕
            </button>
          </div>
        )}

        {activeTab !== 'SUMMARY' ? (
          <>
            {/* ------------------------------------------------------- */}
            {/* KPI サマリカード行（cabacc 5カード構成 × Vendas配色） */}
            {/* ------------------------------------------------------- */}
            <div className="grid grid-cols-2 lg:grid-cols-5 gap-3 shrink-0">
              {/* 1. ダークヒーローカード: 税込合計金額 */}
              <div className="bg-gradient-to-br from-[#121429] via-[#242852] to-[#374D81] rounded-xl px-4 py-3 text-white border-2 border-[#4A66AC] shadow-sm flex flex-col justify-between col-span-2 lg:col-span-1">
                <div className="flex items-center justify-between text-xs font-bold text-[#D4E5F6]">
                  <span>💰 税込合計金額</span>
                  <span className="px-1.5 py-0.5 rounded bg-[#4A66AC]/40 text-[10px] font-mono text-white">
                    {currentEntryType === 'ADVANCE' ? '立替' : '売上'}
                  </span>
                </div>
                <div className="mt-1.5 text-2xl font-black font-mono tabular-nums tracking-tight text-white">
                  {formatYen(pageData.summary.totalAmount)}
                </div>
                <div className="mt-1 text-[11px] text-[#B5C1DF] font-mono flex items-center justify-between">
                  <span>対象: {pageData.summary.totalCount}件</span>
                  <span className="text-[#D4E5F6]">表示: {displayedItems.length}件</span>
                </div>
              </div>

              {/* 2. 税抜金額合計 */}
              <div className="bg-white rounded-xl px-4 py-3 border-2 border-[#B5C1DF] text-[#242852] shadow-2xs flex flex-col justify-between">
                <div className="flex items-center justify-between text-xs font-bold text-[#3B528A]">
                  <span>💴 税抜金額合計</span>
                  <span className="text-[10px] font-mono text-[#7F8FA9]">EXCL</span>
                </div>
                <div className="mt-1.5 text-xl xl:text-2xl font-black font-mono tabular-nums tracking-tight text-[#242852]">
                  {formatYen(pageData.summary.subtotalAmount)}
                </div>
                <div className="mt-1 text-[11px] text-[#7F8FA9] font-mono flex items-center justify-between">
                  <span>表示分税抜</span>
                  <span>{formatYen(displayedTotals.subtotal)}</span>
                </div>
              </div>

              {/* 3. 消費税合計 */}
              <div className="bg-white rounded-xl px-4 py-3 border-2 border-[#B5C1DF] text-[#242852] shadow-2xs flex flex-col justify-between">
                <div className="flex items-center justify-between text-xs font-bold text-[#3B528A]">
                  <span>🧮 消費税合計</span>
                  <span className="text-[10px] font-mono text-[#7F8FA9]">TAX</span>
                </div>
                <div className="mt-1.5 text-xl xl:text-2xl font-black font-mono tabular-nums tracking-tight text-[#242852]">
                  {formatYen(pageData.summary.taxTotal)}
                </div>
                <div className="mt-1 text-[11px] text-[#7F8FA9] font-mono flex items-center justify-between">
                  <span>表示分税額</span>
                  <span>{formatYen(displayedTotals.tax)}</span>
                </div>
              </div>

              {/* 4. 承認済件数 */}
              <div className="bg-white rounded-xl px-4 py-3 border-2 border-[#B5C1DF] text-[#242852] shadow-2xs flex flex-col justify-between">
                <div className="flex items-center justify-between text-xs font-bold text-[#3B528A]">
                  <span>✅ 承認済伝票</span>
                  <span className="text-[10px] font-mono text-emerald-700">APPROVED</span>
                </div>
                <div className="mt-1.5 text-xl xl:text-2xl font-black font-mono tabular-nums tracking-tight text-emerald-700">
                  {pageData.summary.approvedCount}{' '}
                  <span className="text-xs font-sans font-bold text-[#7F8FA9]">件</span>
                </div>
                <div className="mt-1 text-[11px] text-[#7F8FA9] font-mono flex items-center justify-between">
                  <span>承認率</span>
                  <span className="font-bold text-[#242852]">{approvalRateText}</span>
                </div>
              </div>

              {/* 5. 未承認・確認待件数 */}
              <div className="bg-white rounded-xl px-4 py-3 border-2 border-[#B5C1DF] text-[#242852] shadow-2xs flex flex-col justify-between">
                <div className="flex items-center justify-between text-xs font-bold text-[#3B528A]">
                  <span>⏳ 未承認・確認待</span>
                  <span className="text-[10px] font-mono text-[#7F8FA9]">PENDING</span>
                </div>
                <div
                  className={`mt-1.5 text-xl xl:text-2xl font-black font-mono tabular-nums tracking-tight ${
                    pageData.summary.pendingCount > 0 ? 'text-[#C00000]' : 'text-[#242852]'
                  }`}
                >
                  {pageData.summary.pendingCount}{' '}
                  <span className="text-xs font-sans font-bold text-[#7F8FA9]">件</span>
                </div>
                <div className="mt-1 text-[11px] text-[#7F8FA9] font-mono flex items-center justify-between">
                  <span>選択中</span>
                  <span className="font-bold text-[#4A66AC]">{selectedIds.length} 件</span>
                </div>
              </div>
            </div>

            {/* ------------------------------------------------------- */}
            {/* 常設コントロール ＆ 検索バー（cabacc スタイル × Access 配色） */}
            {/* ------------------------------------------------------- */}
            <form
              onSubmit={handleSearchSubmit}
              className="relative bg-white pl-4 pr-3.5 py-2.5 rounded-xl border-2 border-[#90A2CF] shadow-2xs flex flex-wrap items-center justify-between gap-2.5 shrink-0"
            >
              <div className="absolute left-0 top-0 bottom-0 w-1.5 bg-[#4A66AC] rounded-l-xl" />

              <div className="flex flex-wrap items-center gap-2 min-w-0">
                {/* 月送りナビゲーション（cabacc 踏襲） */}
                <div className="flex items-center gap-1.5 shrink-0">
                  <button
                    type="button"
                    onClick={() => handleShiftMonth(-1)}
                    disabled={loading}
                    className="h-8 px-3 rounded-full bg-gradient-to-b from-white via-[#F0F3F9] to-[#D4E5F6] hover:to-[#B5C1DF] text-[#242852] border border-[#90A2CF] font-bold text-xs transition transform hover:-translate-y-0.5 active:translate-y-px flex items-center gap-1 cursor-pointer disabled:opacity-50"
                    title="前月へ"
                  >
                    <span>◀ 前月</span>
                  </button>
                  <button
                    type="button"
                    onClick={handleToggleMonthScope}
                    disabled={loading}
                    title={
                      dateFrom !== '' || dateTo !== ''
                        ? 'クリックで全期間表示に戻す'
                        : 'クリックで当月で絞り込む'
                    }
                    className="h-8 px-3 rounded-lg border border-[#4A66AC] bg-[#F0F3F9] hover:bg-[#D4E5F6] text-xs font-mono font-black text-[#242852] inline-flex items-center gap-1.5 cursor-pointer transition shadow-2xs"
                  >
                    <span>📅</span>
                    <span>{activeMonthLabel}</span>
                  </button>
                  <button
                    type="button"
                    onClick={() => handleShiftMonth(1)}
                    disabled={loading}
                    className="h-8 px-3 rounded-full bg-gradient-to-b from-white via-[#F0F3F9] to-[#D4E5F6] hover:to-[#B5C1DF] text-[#242852] border border-[#90A2CF] font-bold text-xs transition transform hover:-translate-y-0.5 active:translate-y-px flex items-center gap-1 cursor-pointer disabled:opacity-50"
                    title="翌月へ"
                  >
                    <span>翌月 ▶</span>
                  </button>
                </div>

                {loading && (
                  <span className="inline-flex items-center gap-1 text-xs font-bold bg-[#D4E5F6] text-[#242852] border border-[#4A66AC] px-2.5 py-1 rounded-md animate-pulse">
                    読込中...
                  </span>
                )}

                <span className="text-[#B5C1DF] hidden xl:inline">|</span>

                {/* キーワード検索 */}
                <div className="relative w-52 sm:w-60">
                  <span className="absolute left-2.5 top-1/2 -translate-y-1/2 text-xs text-[#4A66AC]">
                    🔍
                  </span>
                  <input
                    type="text"
                    value={keyword}
                    onChange={(e) => setKeyword(e.target.value)}
                    placeholder="伝票No・件名・取引先・案件..."
                    className="w-full h-8 pl-7 pr-2.5 text-xs bg-white border border-[#90A2CF] hover:border-[#4A66AC] rounded-lg focus:border-[#4A66AC] focus:ring-2 focus:ring-[#4A66AC]/25 focus:outline-hidden font-semibold text-[#242852] placeholder:text-[#7F8FA9] placeholder:font-normal"
                  />
                </div>

                {/* ステータス・承認・日付・案件紐付 */}
                <select
                  aria-label="ステータス"
                  value={status}
                  onChange={(e) => setStatus(e.target.value as '' | SalesStatus)}
                  className="h-8 rounded-lg border border-[#90A2CF] hover:border-[#4A66AC] focus:border-[#4A66AC] bg-white px-2 text-xs font-semibold text-[#242852]"
                >
                  <option value="">状態: すべて</option>
                  {(Object.keys(SALES_STATUS_LABELS) as SalesStatus[]).map((st) => (
                    <option key={st} value={st}>
                      {st}: {SALES_STATUS_LABELS[st]}
                    </option>
                  ))}
                </select>

                <select
                  aria-label="承認状態"
                  value={approvalFilter}
                  onChange={(e) => setApprovalFilter(e.target.value as '' | '0' | '1' | '2')}
                  className="h-8 rounded-lg border border-[#90A2CF] hover:border-[#4A66AC] focus:border-[#4A66AC] bg-white px-2 text-xs font-semibold text-[#242852]"
                >
                  <option value="">承認: すべて</option>
                  <option value="0">未承認</option>
                  <option value="1">承認済</option>
                  <option value="2">差戻し</option>
                </select>

                <select
                  aria-label="案件紐付"
                  value={projectLink}
                  onChange={(e) => setProjectLink(e.target.value as 'ALL' | 'LINKED' | 'UNLINKED')}
                  className="h-8 rounded-lg border border-[#90A2CF] hover:border-[#4A66AC] focus:border-[#4A66AC] bg-white px-2 text-xs font-semibold text-[#242852]"
                >
                  <option value="ALL">案件: すべて</option>
                  <option value="LINKED">案件あり</option>
                  <option value="UNLINKED">案件なし</option>
                </select>

                <div className="flex items-center gap-1">
                  <input
                    aria-label="売上日From"
                    type="date"
                    value={dateFrom}
                    onChange={(e) => setDateFrom(e.target.value)}
                    className="h-8 rounded-lg border border-[#90A2CF] focus:border-[#4A66AC] px-2 text-xs font-mono text-[#242852] bg-white"
                  />
                  <span className="text-xs text-[#7F8FA9]">〜</span>
                  <input
                    aria-label="売上日To"
                    type="date"
                    value={dateTo}
                    onChange={(e) => setDateTo(e.target.value)}
                    className="h-8 rounded-lg border border-[#90A2CF] focus:border-[#4A66AC] px-2 text-xs font-mono text-[#242852] bg-white"
                  />
                </div>

                {/* Access版 fm_売上一覧 の cmdsearch (#C00000) & cmdClear (#4A66AC) */}
                <button
                  type="submit"
                  disabled={loading}
                  className="h-8 px-4 rounded-full bg-gradient-to-b from-[#C00000] to-[#9A0000] hover:from-[#d90000] hover:to-[#C00000] text-white border border-[#9A0000] text-xs font-bold shadow-xs cursor-pointer transition disabled:opacity-50"
                >
                  {loading ? '検索中...' : '検索'}
                </button>
                <button
                  type="button"
                  onClick={handleResetFilters}
                  disabled={loading}
                  className="h-8 px-3.5 rounded-full bg-gradient-to-b from-[#4A66AC] to-[#3B528A] hover:from-[#5974B8] hover:to-[#4A66AC] text-white border border-[#3B528A] text-xs font-bold shadow-2xs cursor-pointer transition disabled:opacity-50"
                >
                  クリア
                </button>
              </div>

              {/* 右側: 表示日・件数バッジ */}
              <div className="hidden xl:flex items-center gap-2 px-3 h-8 rounded-lg bg-[#F0F3F9] border border-[#B5C1DF] text-xs shrink-0">
                <span className="text-[11px] text-[#5F718E] font-medium">表示日:</span>
                <span className="font-mono font-bold text-[#242852]">{selectedDateDisplay}</span>
                <span className="px-2 py-0.5 rounded-md text-[10px] font-mono font-black bg-[#D4E5F6] text-[#242852] border border-[#4A66AC]">
                  全 {pageData.summary.totalCount} 伝票
                </span>
              </div>
            </form>

            {/* 一括承認操作バー */}
            {selectedIds.length > 0 && (
              <div className="rounded-xl border-2 border-[#4A66AC] bg-[#D4E5F6] px-4 py-2 flex flex-wrap items-center justify-between gap-2 shrink-0 shadow-2xs">
                <span className="text-xs font-black text-[#242852]">
                  ☑ {selectedIds.length} 件の伝票を選択中
                </span>
                <div className="flex flex-wrap items-center gap-2">
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() => void handleBatchApproval(1)}
                    className="h-7 rounded-full bg-emerald-600 hover:bg-emerald-700 px-3.5 text-xs font-bold text-white cursor-pointer shadow-2xs"
                  >
                    一括承認
                  </button>
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() => void handleBatchApproval(2)}
                    className="h-7 rounded-full bg-amber-600 hover:bg-amber-700 px-3.5 text-xs font-bold text-white cursor-pointer shadow-2xs"
                  >
                    一括差戻し
                  </button>
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() => void handleBatchApproval(0)}
                    className="h-7 rounded-full border border-[#4A66AC] bg-white hover:bg-[#F0F3F9] px-3.5 text-xs font-bold text-[#242852] cursor-pointer"
                  >
                    未承認に戻す
                  </button>
                  <button
                    type="button"
                    onClick={() => setSelectedIds([])}
                    className="h-7 rounded-full border border-[#90A2CF] bg-[#F0F3F9] hover:bg-white px-3 text-xs font-medium text-[#40485C] cursor-pointer"
                  >
                    選択解除
                  </button>
                </div>
              </div>
            )}

            {/* ========================================================= */}
            {/* 2ペイン領域（左: 日別サマリカードリスト / 右: 伝票一覧テーブル） */}
            {/* ========================================================= */}
            <div className="flex-1 min-h-[440px] flex flex-col lg:flex-row gap-3.5 lg:overflow-hidden">
              {/* 1. 左サイドバー: 売上日別一覧カード */}
              <aside className="w-full lg:w-64 xl:w-72 bg-white rounded-xl border-2 border-[#4A66AC]/80 shadow-2xs flex flex-col shrink-0 overflow-hidden max-h-64 lg:max-h-none lg:h-full">
                {/* サイドバーヘッダ */}
                <div className="h-9 bg-gradient-to-r from-[#4A66AC] via-[#3B528A] to-[#4A66AC] text-white border-b border-[#242852] px-3 flex items-center justify-between font-bold text-xs shrink-0">
                  <span className="flex items-center gap-1.5">
                    <span>📅</span>
                    <span>売上日別一覧</span>
                  </span>
                  <span className="px-2 py-0.5 rounded bg-[#D4E5F6] text-[#242852] font-mono font-black text-[10px] border border-[#242852]/20">
                    {pageData.items.length}件
                  </span>
                </div>

                {/* 日付カードリスト */}
                <div className="flex-1 min-h-0 overflow-y-auto p-1.5 space-y-1 divide-y divide-[#F0F3F9]">
                  {/* 先頭: 全表示カード */}
                  <button
                    type="button"
                    onClick={() => setSelectedDateFilter(null)}
                    className={`w-full text-left p-2 rounded-lg transition border flex flex-col justify-between cursor-pointer ${
                      selectedDateFilter === null
                        ? 'bg-[#D4E5F6]/90 border-[#4A66AC] shadow-2xs'
                        : 'bg-white border-transparent hover:bg-[#F0F3F9] hover:border-[#B5C1DF]'
                    }`}
                  >
                    <div className="flex items-center justify-between gap-1">
                      <div className="flex items-center gap-1.5">
                        <span
                          className={`w-2 h-2 rounded-full shrink-0 ${
                            selectedDateFilter === null ? 'bg-[#4A66AC]' : 'bg-[#B5C1DF]'
                          }`}
                        />
                        <span className="font-bold text-xs text-[#242852]">
                          📋 すべて表示（頁内全件）
                        </span>
                      </div>
                      <span className="px-1.5 py-0.5 rounded font-mono text-[10px] font-bold bg-[#4A66AC] text-white">
                        {pageData.items.length}件
                      </span>
                    </div>
                    <div className="mt-1 flex items-center justify-between text-[11px] font-mono">
                      <span className="text-[10px] text-[#5F718E] font-sans">
                        ページ {pageData.page} / {totalPages}
                      </span>
                      <span className="font-black text-xs text-[#242852] tabular-nums">
                        {formatYen(pageItemsTotals.total)}
                      </span>
                    </div>
                  </button>

                  {dateGroups.map((group) => {
                    const isSelected = selectedDateFilter === group.date;
                    return (
                      <button
                        key={group.date}
                        type="button"
                        onClick={() =>
                          setSelectedDateFilter((prev) =>
                            prev === group.date ? null : group.date,
                          )
                        }
                        title={`${group.displayDate} (${group.dayOfWeek}) の伝票を表示`}
                        className={`w-full text-left p-2 rounded-lg transition border flex flex-col justify-between cursor-pointer ${
                          isSelected
                            ? 'bg-[#D4E5F6]/90 border-[#4A66AC] shadow-2xs'
                            : 'bg-white border-transparent hover:bg-[#F0F3F9] hover:border-[#B5C1DF]'
                        }`}
                      >
                        <div className="flex items-center justify-between gap-1">
                          <div className="flex items-center gap-1.5 truncate">
                            <span
                              className={`w-2 h-2 rounded-full shrink-0 ${
                                isSelected
                                  ? 'bg-[#C00000]'
                                  : group.pendingCount > 0
                                    ? 'bg-[#4A66AC]'
                                    : 'bg-[#5AA2AE]'
                              }`}
                            />
                            <span className="font-mono font-black text-xs text-[#242852]">
                              {group.displayDate}
                            </span>
                            <span
                              className={`text-[10px] font-sans font-bold ${
                                group.isSunday
                                  ? 'text-[#C00000]'
                                  : group.isSaturday
                                    ? 'text-[#4A66AC]'
                                    : 'text-[#7F8FA9]'
                              }`}
                            >
                              ({group.dayOfWeek})
                            </span>
                          </div>

                          <span className="px-1.5 py-0.5 rounded font-mono text-[10px] font-bold bg-[#D4E5F6] text-[#242852] border border-[#90A2CF] shrink-0">
                            {group.count}件
                          </span>
                        </div>

                        <div className="mt-1 flex items-center justify-between text-[11px] font-mono">
                          <span className="text-[10px] font-sans text-[#7F8FA9]">
                            {group.pendingCount > 0
                              ? `未承認 ${group.pendingCount}`
                              : `承認済 ${group.approvedCount}`}
                          </span>
                          <span className="font-black text-xs text-[#242852] tabular-nums">
                            {formatYen(group.totalAmount)}
                          </span>
                        </div>
                      </button>
                    );
                  })}
                </div>

                {/* サイドバーフッタ */}
                <div className="p-2.5 border-t-2 border-[#4A66AC] bg-gradient-to-r from-[#B5C1DF] via-[#CBD4E9] to-[#B5C1DF] text-xs font-mono flex items-center justify-between shrink-0 text-[#242852]">
                  <span className="text-[10px] font-sans font-bold">
                    表示中 {displayedItems.length} 伝票
                  </span>
                  <div className="text-right">
                    <span className="text-[10px] font-sans font-bold mr-1">頁計:</span>
                    <span className="font-black text-xs tabular-nums">
                      {formatYen(pageItemsTotals.total)}
                    </span>
                  </div>
                </div>
              </aside>

              {/* 2. 右メインパネル: 伝票一覧テーブル */}
              <div className="flex-1 min-w-0 min-h-0 bg-white rounded-xl border-2 border-[#4A66AC]/80 shadow-2xs overflow-hidden flex flex-col">
                <div className="flex-1 min-h-0 overflow-auto">
                  <table className="w-full h-full min-w-[980px] text-left border-collapse text-xs">
                    <thead className="sticky top-0 z-20 shadow-[0_1px_0_0_rgba(74,102,172,0.35)]">
                      <tr className="h-9 bg-gradient-to-r from-[#D4E5F6] via-[#E4EFFA] to-[#D4E5F6] border-b-2 border-[#4A66AC] text-[#242852] font-black text-xs select-none">
                        <th className="h-9 px-2.5 w-9 text-center">
                          <input
                            type="checkbox"
                            aria-label="未請求伝票を全選択"
                            onChange={toggleSelectAllUnbilled}
                            checked={
                              selectableCount > 0 && selectedIds.length === selectableCount
                            }
                            title="未請求伝票を全選択"
                            className="cursor-pointer accent-[#4A66AC]"
                          />
                        </th>
                        <th className="h-9 py-1 px-2.5 text-center whitespace-nowrap">
                          🔢 伝票No
                        </th>
                        <th className="h-9 py-1 px-2.5 text-center whitespace-nowrap">
                          📅 売上日
                        </th>
                        <th className="h-9 py-1 px-2.5 text-center whitespace-nowrap">
                          🏷️ ステータス
                        </th>
                        <th className="h-9 py-1 px-2.5 text-center whitespace-nowrap">
                          ✅ 承認
                        </th>
                        <th className="h-9 py-1 px-3 text-left whitespace-nowrap">🏢 取引先</th>
                        <th className="h-9 py-1 px-3 text-left whitespace-nowrap">
                          📝 件名 / 案件
                        </th>
                        <th className="h-9 py-1 px-3 text-right whitespace-nowrap">
                          💴 税抜金額
                        </th>
                        <th className="h-9 py-1 px-3 text-right whitespace-nowrap">
                          🧾 消費税
                        </th>
                        <th className="h-9 py-1 px-3 text-right whitespace-nowrap">
                          💰 税込合計
                        </th>
                        <th className="h-9 py-1 px-2.5 text-center whitespace-nowrap">
                          📄 納/受
                        </th>
                        <th className="h-9 py-1 px-3 text-right whitespace-nowrap">⚙️ 操作</th>
                      </tr>
                    </thead>

                    <tbody className="divide-y divide-[#D0D7D9] font-sans">
                      {displayedItems.length === 0 ? (
                        <tr>
                          <td colSpan={12} className="px-6 py-16 text-center bg-white">
                            <div className="flex flex-col items-center justify-center gap-2.5">
                              <span className="text-3xl">🧾</span>
                              <p className="text-sm font-black text-[#242852]">
                                条件に一致する伝票データがありません
                              </p>
                              <p className="text-xs text-[#7F8FA9]">
                                検索条件または左の売上日別フィルタを変更するか、新規伝票を発行してください。
                              </p>
                              <Link
                                href={`/sales/new?entryType=${currentEntryType}`}
                                className="mt-1 h-8 px-4 rounded-full bg-gradient-to-b from-[#4A66AC] to-[#3B528A] text-white text-xs font-bold inline-flex items-center gap-1 shadow-xs"
                              >
                                ＋ 新規{currentEntryType === 'ADVANCE' ? '立替金' : '売上'}発行
                              </Link>
                            </div>
                          </td>
                        </tr>
                      ) : (
                        <>
                          {displayedItems.map((item, idx) => {
                            const isBilled = item.status === 'K4' || item.status === 'K5';
                            const zebraClass = idx % 2 === 0 ? 'bg-white' : 'bg-[#F0F3F9]/75';
                            return (
                              <tr
                                key={item.id}
                                onClick={(e) => {
                                  if (
                                    e.target instanceof HTMLElement &&
                                    e.target.closest('a, button, input, label')
                                  ) {
                                    return;
                                  }
                                  router.push(`/sales/${item.id}`);
                                }}
                                className={`h-9 ${zebraClass} hover:bg-[#DDEAF8]/90 transition-colors cursor-pointer group`}
                              >
                                <td className="h-9 px-2.5 text-center">
                                  <input
                                    type="checkbox"
                                    disabled={isBilled}
                                    checked={selectedIds.includes(item.id)}
                                    onChange={() => toggleRowSelect(item.id)}
                                    className="cursor-pointer disabled:cursor-not-allowed accent-[#4A66AC]"
                                  />
                                </td>
                                <td className="h-9 py-1 px-2.5 text-center font-mono font-black text-[#4A66AC] whitespace-nowrap">
                                  <Link
                                    href={`/sales/${item.id}`}
                                    className="hover:text-[#9454C3] hover:underline"
                                  >
                                    {item.entryType === 'ADVANCE'
                                      ? `T-${item.slipNo}`
                                      : `#${item.slipNo}`}
                                  </Link>
                                </td>
                                <td className="h-9 py-1 px-2.5 text-center font-mono text-xs text-[#242852] whitespace-nowrap">
                                  {item.slipDate.replace(/-/g, '/')}
                                </td>
                                <td className="h-9 py-1 px-2.5 text-center whitespace-nowrap">
                                  <span
                                    className={`inline-flex px-2 py-0.5 rounded-full text-[11px] font-bold border ${
                                      isBilled
                                        ? 'bg-[#F3E8FF] text-[#6B21A8] border-[#9454C3]/40'
                                        : item.status === 'K3'
                                          ? 'bg-[#ADD0D7]/45 text-[#242852] border-[#5AA2AE]'
                                          : item.status === 'K2'
                                            ? 'bg-[#D4E5F6] text-[#242852] border-[#4A66AC]/50'
                                            : 'bg-[#F0F3F9] text-[#40485C] border-[#B5C1DF]'
                                    }`}
                                  >
                                    {item.status}: {SALES_STATUS_LABELS[item.status]}
                                  </span>
                                </td>
                                <td className="h-9 py-1 px-2.5 text-center whitespace-nowrap">
                                  <span
                                    className={`inline-flex px-2 py-0.5 rounded-full text-[11px] font-bold ${
                                      item.approvalStatus === 1
                                        ? 'bg-emerald-100 text-emerald-800 border border-emerald-300'
                                        : item.approvalStatus === 2
                                          ? 'bg-[#FEE2E2] text-[#C00000] border border-[#FCA5A5]'
                                          : 'bg-amber-100 text-amber-900 border border-amber-300'
                                    }`}
                                  >
                                    {APPROVAL_STATUS_LABELS[item.approvalStatus]}
                                  </span>
                                </td>
                                <td className="h-9 py-1 px-3 text-[#242852]">
                                  <div className="font-bold text-xs truncate max-w-[200px]">
                                    {item.partnerName}
                                  </div>
                                  <div className="text-[10px] font-mono text-[#7F8FA9]">
                                    {item.partnerCode}
                                  </div>
                                </td>
                                <td className="h-9 py-1 px-3 text-[#242852]">
                                  <Link
                                    href={`/sales/${item.id}`}
                                    className="font-bold text-xs text-[#242852] group-hover:text-[#9454C3] hover:underline block truncate max-w-[260px]"
                                  >
                                    {item.slipName !== '' ? item.slipName : '（件名なし）'}
                                  </Link>
                                  <div className="flex flex-wrap items-center gap-1.5 mt-0.5">
                                    {item.projectName !== null && (
                                      <span className="inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-bold bg-[#ADD0D7]/55 text-[#242852] border border-[#5AA2AE]">
                                        工事 #{item.projectNo}: {item.projectName}
                                      </span>
                                    )}
                                    <span className="text-[10px] font-mono text-[#7F8FA9]">
                                      明細 {item.lineCount}行
                                    </span>
                                  </div>
                                </td>
                                <td className="h-9 py-1 px-3 text-right font-mono tabular-nums text-xs text-[#40485C] whitespace-nowrap">
                                  {formatYen(item.subtotalAmount)}
                                </td>
                                <td className="h-9 py-1 px-3 text-right font-mono tabular-nums text-xs text-[#5F718E] whitespace-nowrap">
                                  {formatYen(item.taxTotal)}
                                </td>
                                <td className="h-9 py-1 px-3 text-right font-mono tabular-nums text-xs font-black text-[#242852] whitespace-nowrap">
                                  {formatYen(item.totalAmount)}
                                </td>
                                <td className="h-9 py-1 px-2.5 text-center whitespace-nowrap text-[11px] font-mono">
                                  <span className="text-[#40485C]">
                                    納:
                                    {item.latestDeliveryNoteVersion !== null
                                      ? `v${item.latestDeliveryNoteVersion}`
                                      : '-'}
                                  </span>
                                  <span className="mx-1 text-[#B5C1DF]">/</span>
                                  <span className="text-[#40485C]">
                                    受:
                                    {item.latestDeliveryReceiptVersion !== null
                                      ? `v${item.latestDeliveryReceiptVersion}`
                                      : '-'}
                                  </span>
                                </td>
                                <td className="h-9 py-1 px-3 text-right whitespace-nowrap">
                                  <div className="inline-flex items-center gap-1">
                                    <Link
                                      href={`/sales/${item.id}`}
                                      className="h-6 px-2.5 rounded-full border border-[#90A2CF] bg-white hover:bg-[#D4E5F6] text-[11px] font-bold text-[#242852] inline-flex items-center transition"
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
                                          title="伝票を削除"
                                          className="h-6 px-2 rounded-full border border-[#FCA5A5] bg-white hover:bg-[#FEE2E2] text-[11px] font-bold text-[#C00000] cursor-pointer transition"
                                        >
                                          削除
                                        </button>
                                      )}
                                  </div>
                                </td>
                              </tr>
                            );
                          })}
                          <tr aria-hidden="true" className="h-full">
                            <td colSpan={12} className="p-0 border-0" />
                          </tr>
                        </>
                      )}
                    </tbody>

                    {/* 下部固定 合計フッタ行（tfoot: Access Periwinkle #B5C1DF） */}
                    <tfoot className="sticky bottom-0 z-20 shadow-[0_-1px_0_0_rgba(74,102,172,0.4)]">
                      <tr className="h-9 bg-gradient-to-r from-[#B5C1DF] via-[#CBD4E9] to-[#B5C1DF] font-black text-[#242852] border-t-2 border-[#4A66AC] text-xs">
                        <td colSpan={2} className="h-9 py-1 px-3 text-center whitespace-nowrap font-mono">
                          表示 {displayedItems.length} 伝票
                        </td>
                        <td colSpan={5} className="h-9 py-1 px-3 text-left text-[11px] font-bold text-[#242852]">
                          {selectedDateFilter !== null
                            ? `選択日合計（${selectedDateDisplay}）`
                            : '表示一覧合計（当頁）'}
                        </td>
                        <td className="h-9 py-1 px-3 text-right font-mono tabular-nums whitespace-nowrap">
                          {formatYen(displayedTotals.subtotal)}
                        </td>
                        <td className="h-9 py-1 px-3 text-right font-mono tabular-nums whitespace-nowrap text-[#3B528A]">
                          {formatYen(displayedTotals.tax)}
                        </td>
                        <td className="h-9 py-1 px-3 text-right font-mono tabular-nums font-black whitespace-nowrap text-[#121429]">
                          {formatYen(displayedTotals.total)}
                        </td>
                        <td colSpan={2} className="h-9 py-1 px-3 text-right font-mono text-[10px] text-[#3B528A]">
                          VENDAS LEDGER
                        </td>
                      </tr>
                    </tfoot>
                  </table>
                </div>

                {/* 下部フッタバー（深紺 #242852 + ページネーション） */}
                <div className="min-h-10 px-4 py-1.5 bg-gradient-to-r from-[#242852] via-[#374D81] to-[#242852] border-t-2 border-[#4A66AC] flex flex-wrap items-center justify-between gap-2 text-xs text-white shrink-0">
                  <span className="text-[11px] text-[#D4E5F6] truncate">
                    ※ 左の売上日別一覧で日付を選択すると表示伝票を絞り込めます。行または伝票Noクリックで編集画面を開きます。
                  </span>
                  <div className="flex items-center gap-2 font-mono shrink-0">
                    <span className="text-[11px] text-[#D4E5F6]">
                      全 {pageData.summary.totalCount} 件（ページ {pageData.page} / {totalPages}）
                    </span>
                    <button
                      type="button"
                      disabled={pageData.page <= 1 || loading}
                      onClick={() => void loadSalesPage(currentEntryType, { page: pageData.page - 1 })}
                      className="h-7 rounded-full border border-[#90A2CF] bg-[#4A66AC] hover:bg-[#5974B8] px-3 text-xs font-bold text-white disabled:opacity-40 cursor-pointer transition"
                    >
                      ◀ 前へ
                    </button>
                    <button
                      type="button"
                      disabled={pageData.page >= totalPages || loading}
                      onClick={() => void loadSalesPage(currentEntryType, { page: pageData.page + 1 })}
                      className="h-7 rounded-full border border-[#90A2CF] bg-[#4A66AC] hover:bg-[#5974B8] px-3 text-xs font-bold text-white disabled:opacity-40 cursor-pointer transition"
                    >
                      次へ ▶
                    </button>
                  </div>
                </div>
              </div>
            </div>
          </>
        ) : (
          /* ========================================================= */
          /* 商品別売上・立替集計タブ（同じ Vendas × cabacc スタイル） */
          /* ========================================================= */
          <div className="flex-1 min-h-[440px] flex flex-col space-y-3 lg:overflow-hidden">
            <div className="grid grid-cols-2 md:grid-cols-4 gap-3 shrink-0">
              <div className="bg-gradient-to-br from-[#121429] via-[#242852] to-[#374D81] rounded-xl px-4 py-3 text-white border-2 border-[#4A66AC] shadow-sm flex flex-col justify-between">
                <div className="flex items-center justify-between text-xs font-bold text-[#D4E5F6]">
                  <span>💰 税込金額合計</span>
                  <span className="px-1.5 py-0.5 rounded bg-[#4A66AC]/40 text-[10px] font-mono">
                    SUMMARY
                  </span>
                </div>
                <div className="mt-1.5 text-2xl font-black font-mono tabular-nums text-white">
                  {formatYen(summaryData.totals.inclAmount)}
                </div>
                <div className="mt-1 text-[11px] text-[#B5C1DF] font-mono">
                  集計品目: {summaryData.totals.rowCount} 件
                </div>
              </div>

              <div className="bg-white rounded-xl px-4 py-3 border-2 border-[#B5C1DF] text-[#242852] shadow-2xs flex flex-col justify-between">
                <div className="text-xs font-bold text-[#3B528A]">📦 集計品目数</div>
                <div className="mt-1.5 text-2xl font-black font-mono tabular-nums text-[#242852]">
                  {summaryData.totals.rowCount}{' '}
                  <span className="text-xs font-sans font-bold text-[#7F8FA9]">品目</span>
                </div>
                <div className="mt-1 text-[11px] text-[#7F8FA9] font-mono">商品別グルーピング</div>
              </div>

              <div className="bg-white rounded-xl px-4 py-3 border-2 border-[#B5C1DF] text-[#242852] shadow-2xs flex flex-col justify-between">
                <div className="text-xs font-bold text-[#3B528A]">💴 税抜金額合計</div>
                <div className="mt-1.5 text-2xl font-black font-mono tabular-nums text-[#242852]">
                  {formatYen(summaryData.totals.exclAmount)}
                </div>
                <div className="mt-1 text-[11px] text-[#7F8FA9] font-mono">純売上合計</div>
              </div>

              <div className="bg-white rounded-xl px-4 py-3 border-2 border-[#B5C1DF] text-[#242852] shadow-2xs flex flex-col justify-between">
                <div className="text-xs font-bold text-[#3B528A]">🧾 消費税額合計</div>
                <div className="mt-1.5 text-2xl font-black font-mono tabular-nums text-[#242852]">
                  {formatYen(summaryData.totals.taxAmount)}
                </div>
                <div className="mt-1 text-[11px] text-[#7F8FA9] font-mono">内訳税額合算</div>
              </div>
            </div>

            <form
              onSubmit={(e) => {
                e.preventDefault();
                void loadProductSummary();
              }}
              className="relative bg-white pl-4 pr-3.5 py-2.5 rounded-xl border-2 border-[#90A2CF] shadow-2xs flex flex-wrap items-center justify-between gap-2.5 shrink-0"
            >
              <div className="absolute left-0 top-0 bottom-0 w-1.5 bg-[#4A66AC] rounded-l-xl" />
              <div className="flex flex-wrap items-center gap-2">
                <select
                  aria-label="区分"
                  value={sumEntryFilter}
                  onChange={(e) => setSumEntryFilter(e.target.value as 'ALL' | SalesEntryType)}
                  className="h-8 rounded-lg border border-[#90A2CF] bg-white px-2.5 text-xs font-semibold text-[#242852]"
                >
                  {lookups.salesEnabled && lookups.tatekaeEnabled && (
                    <option value="ALL">区分: すべて（売上＋立替）</option>
                  )}
                  {lookups.salesEnabled && <option value="SALE">区分: 売上のみ</option>}
                  {lookups.tatekaeEnabled && <option value="ADVANCE">区分: 立替のみ</option>}
                </select>

                <select
                  aria-label="取引先"
                  value={sumPartnerId}
                  onChange={(e) => setSumPartnerId(e.target.value)}
                  className="h-8 rounded-lg border border-[#90A2CF] bg-white px-2.5 text-xs font-semibold text-[#242852] max-w-[220px]"
                >
                  <option value="">すべての取引先</option>
                  {lookups.partners.map((p) => (
                    <option key={p.id} value={p.id}>
                      [{p.partnerCode}] {p.partnerName}
                    </option>
                  ))}
                </select>

                <div className="flex items-center gap-1">
                  <input
                    aria-label="集計期間From"
                    type="date"
                    value={sumDateFrom}
                    onChange={(e) => setSumDateFrom(e.target.value)}
                    className="h-8 rounded-lg border border-[#90A2CF] px-2 text-xs font-mono text-[#242852] bg-white"
                  />
                  <span className="text-xs text-[#7F8FA9]">〜</span>
                  <input
                    aria-label="集計期間To"
                    type="date"
                    value={sumDateTo}
                    onChange={(e) => setSumDateTo(e.target.value)}
                    className="h-8 rounded-lg border border-[#90A2CF] px-2 text-xs font-mono text-[#242852] bg-white"
                  />
                </div>

                <input
                  type="text"
                  value={sumKeyword}
                  onChange={(e) => setSumKeyword(e.target.value)}
                  placeholder="品名・商品コード検索..."
                  className="h-8 w-52 rounded-lg border border-[#90A2CF] px-3 text-xs font-semibold text-[#242852] placeholder:text-[#7F8FA9]"
                />

                <button
                  type="submit"
                  disabled={loading}
                  className="h-8 px-4 rounded-full bg-gradient-to-b from-[#C00000] to-[#9A0000] hover:from-[#d90000] hover:to-[#C00000] text-white border border-[#9A0000] text-xs font-bold shadow-xs cursor-pointer"
                >
                  {loading ? '集計中...' : '集計実行'}
                </button>
                <button
                  type="button"
                  onClick={handleResetSummaryFilters}
                  disabled={loading}
                  className="h-8 px-3.5 rounded-full bg-gradient-to-b from-[#4A66AC] to-[#3B528A] text-white border border-[#3B528A] text-xs font-bold shadow-2xs cursor-pointer"
                >
                  クリア
                </button>
              </div>
              <span className="px-2.5 py-1 rounded-md text-[11px] font-mono font-black bg-[#D4E5F6] text-[#242852] border border-[#4A66AC]">
                計 {summaryData.totals.rowCount} 品目
              </span>
            </form>

            <div className="flex-1 min-h-0 bg-white rounded-xl border-2 border-[#4A66AC]/80 shadow-2xs overflow-hidden flex flex-col">
              <div className="flex-1 min-h-0 overflow-auto">
                <table className="w-full h-full min-w-[920px] text-left border-collapse text-xs">
                  <thead className="sticky top-0 z-20">
                    <tr className="h-9 bg-gradient-to-r from-[#D4E5F6] via-[#E4EFFA] to-[#D4E5F6] border-b-2 border-[#4A66AC] text-[#242852] font-black text-xs select-none">
                      <th className="h-9 px-3 text-center whitespace-nowrap">区分</th>
                      <th className="h-9 px-3 text-left whitespace-nowrap">商品コード</th>
                      <th className="h-9 px-3 text-left whitespace-nowrap">品名・仕様</th>
                      <th className="h-9 px-3 text-center whitespace-nowrap">単位</th>
                      <th className="h-9 px-3 text-center whitespace-nowrap">税区分</th>
                      <th className="h-9 px-3 text-right whitespace-nowrap">伝票数</th>
                      <th className="h-9 px-3 text-right whitespace-nowrap">合計数量</th>
                      <th className="h-9 px-3 text-right whitespace-nowrap">税抜金額</th>
                      <th className="h-9 px-3 text-right whitespace-nowrap">消費税額</th>
                      <th className="h-9 px-3 text-right whitespace-nowrap">税込金額</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-[#D0D7D9]">
                    {summaryData.items.length === 0 ? (
                      <tr>
                        <td colSpan={10} className="px-4 py-14 text-center text-sm text-[#7F8FA9] bg-white">
                          該当する集計データがありません。条件を指定して「集計実行」を押してください。
                        </td>
                      </tr>
                    ) : (
                      <>
                        {summaryData.items.map((row, idx) => (
                          <tr
                            key={`${row.entryType}-${row.itemName}-${row.taxCode}-${idx}`}
                            className={`h-9 ${idx % 2 === 0 ? 'bg-white' : 'bg-[#F0F3F9]/75'} hover:bg-[#DDEAF8]/90 transition-colors`}
                          >
                            <td className="h-9 px-3 text-center whitespace-nowrap">
                              <span
                                className={`inline-flex px-2 py-0.5 rounded-full text-[11px] font-bold border ${
                                  row.entryType === 'ADVANCE'
                                    ? 'bg-[#F3E8FF] text-[#6B21A8] border-[#9454C3]/40'
                                    : 'bg-[#D4E5F6] text-[#242852] border-[#4A66AC]/50'
                                }`}
                              >
                                {ENTRY_TYPE_LABELS[row.entryType]}
                              </span>
                            </td>
                            <td className="h-9 px-3 font-mono text-xs text-[#5F718E] whitespace-nowrap">
                              {row.itemCode !== null ? row.itemCode : '-'}
                            </td>
                            <td className="h-9 px-3 text-[#242852] font-bold whitespace-pre-line">
                              {row.itemName}
                            </td>
                            <td className="h-9 px-3 text-center text-xs text-[#40485C] whitespace-nowrap">
                              {row.unitName !== null ? row.unitName : '-'}
                            </td>
                            <td className="h-9 px-3 text-center font-mono text-xs text-[#242852]">
                              {row.taxCode}
                            </td>
                            <td className="h-9 px-3 text-right font-mono tabular-nums text-xs text-[#242852]">
                              {row.slipCount}
                            </td>
                            <td className="h-9 px-3 text-right font-mono tabular-nums text-xs text-[#242852]">
                              {formatQty(row.totalQuantity)}
                            </td>
                            <td className="h-9 px-3 text-right font-mono tabular-nums text-xs text-[#40485C]">
                              {formatYen(row.exclAmount)}
                            </td>
                            <td className="h-9 px-3 text-right font-mono tabular-nums text-xs text-[#5F718E]">
                              {formatYen(row.taxAmount)}
                            </td>
                            <td className="h-9 px-3 text-right font-mono tabular-nums text-xs font-black text-[#242852]">
                              {formatYen(row.inclAmount)}
                            </td>
                          </tr>
                        ))}
                        <tr aria-hidden="true" className="h-full">
                          <td colSpan={10} className="p-0 border-0" />
                        </tr>
                      </>
                    )}
                  </tbody>
                  <tfoot className="sticky bottom-0 z-20">
                    <tr className="h-9 bg-gradient-to-r from-[#B5C1DF] via-[#CBD4E9] to-[#B5C1DF] font-black text-[#242852] border-t-2 border-[#4A66AC] text-xs">
                      <td colSpan={7} className="h-9 px-3 text-left font-bold">
                        商品別集計合計（全 {summaryData.totals.rowCount} 品目）
                      </td>
                      <td className="h-9 px-3 text-right font-mono tabular-nums">
                        {formatYen(summaryData.totals.exclAmount)}
                      </td>
                      <td className="h-9 px-3 text-right font-mono tabular-nums text-[#3B528A]">
                        {formatYen(summaryData.totals.taxAmount)}
                      </td>
                      <td className="h-9 px-3 text-right font-mono tabular-nums font-black text-[#121429]">
                        {formatYen(summaryData.totals.inclAmount)}
                      </td>
                    </tr>
                  </tfoot>
                </table>
              </div>
              <div className="h-9 px-4 bg-gradient-to-r from-[#242852] via-[#374D81] to-[#242852] border-t-2 border-[#4A66AC] flex items-center justify-between text-xs text-white shrink-0">
                <span className="text-[11px] text-[#D4E5F6]">
                  ※ 条件を指定して「集計実行」を押すと、売上・立替伝票の商品別集計が表示されます。
                </span>
                <span className="font-mono text-[11px] text-[#D4E5F6]">
                  表示中: {summaryData.totals.rowCount} 品目
                </span>
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
