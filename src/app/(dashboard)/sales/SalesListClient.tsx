'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect, useMemo, useRef, useState } from 'react';
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
  currentJstYear: number;
}

interface MonthBucketSummary {
  month: number;
  label: string;
  count: number;
  approvedCount: number;
  pendingCount: number;
  totalAmount: number;
}

const STATUS_FILTER_ORDER: readonly SalesStatus[] = ['K1', 'K2', 'K3', 'K4', 'K5', 'K6'];

const APPROVAL_FILTER_OPTIONS: ReadonlyArray<{ value: '' | '0' | '1' | '2'; label: string }> = [
  { value: '', label: 'すべて' },
  { value: '0', label: '未承認' },
  { value: '1', label: '承認済' },
  { value: '2', label: '差戻し' },
];

const PROJECT_LINK_OPTIONS: ReadonlyArray<{
  value: 'ALL' | 'LINKED' | 'UNLINKED';
  label: string;
}> = [
  { value: 'ALL', label: 'すべて' },
  { value: 'LINKED', label: 'あり' },
  { value: 'UNLINKED', label: 'なし' },
];

function formatYen(amount: number): string {
  return amount.toLocaleString('ja-JP');
}

function formatQty(qty: number): string {
  if (Number.isInteger(qty)) return qty.toLocaleString('ja-JP');
  return qty.toFixed(4).replace(/0+$/, '').replace(/\.$/, '');
}

function extractYearFromItems(items: SalesListItemDto[], fallbackYear: number): number {
  let maxYear = 0;
  for (const item of items) {
    const y = Number(item.slipDate.slice(0, 4));
    if (Number.isInteger(y) && y > maxYear) {
      maxYear = y;
    }
  }
  return maxYear > 0 ? maxYear : fallbackYear;
}

function filterItemsByYear(items: SalesListItemDto[], year: number): SalesListItemDto[] {
  const prefix = `${year}-`;
  return items.filter((item) => item.slipDate.startsWith(prefix));
}

function buildYearRange(year: number, month: number | null): { from: string; to: string } {
  if (month === null) {
    return { from: `${year}-01-01`, to: `${year}-12-31` };
  }
  const lastDay = new Date(year, month, 0).getDate();
  const ym = `${year}-${String(month).padStart(2, '0')}`;
  return {
    from: `${ym}-01`,
    to: `${ym}-${String(lastDay).padStart(2, '0')}`,
  };
}

export default function SalesListClient({
  initialTab,
  lookups,
  initialSalesPage,
  initialAdvancePage,
  initialProductSummary,
  currentJstYear,
}: SalesListClientProps) {
  const router = useRouter();
  const [activeTab, setActiveTab] = useState<'SALE' | 'ADVANCE' | 'SUMMARY'>(initialTab);

  // 年別キャッシュ（${entryType}_${year} -> items）および全件メモリキャッシュ判定
  const yearCacheRef = useRef<Map<string, { items: SalesListItemDto[]; totalCount: number }>>(
    new Map(),
  );
  const fullDatasetRef = useRef<Partial<Record<SalesEntryType, SalesListItemDto[]>>>({});

  const initialEntry: SalesEntryType = initialTab === 'ADVANCE' ? 'ADVANCE' : 'SALE';
  const initialPageObj =
    initialEntry === 'ADVANCE'
      ? initialAdvancePage !== null
        ? initialAdvancePage
        : initialSalesPage
      : initialSalesPage !== null
        ? initialSalesPage
        : initialAdvancePage;

  const [selectedYear, setSelectedYear] = useState<number>(() =>
    initialPageObj !== null
      ? extractYearFromItems(initialPageObj.items, currentJstYear)
      : currentJstYear,
  );
  const [selectedMonth, setSelectedMonth] = useState<number | null>(null);

  const [yearItems, setYearItems] = useState<SalesListItemDto[]>(() => {
    if (initialPageObj === null) return [];
    const targetY = extractYearFromItems(initialPageObj.items, currentJstYear);
    if (initialPageObj.summary.totalCount <= initialPageObj.items.length) {
      fullDatasetRef.current[initialEntry] = initialPageObj.items;
    }
    const filtered = filterItemsByYear(initialPageObj.items, targetY);
    yearCacheRef.current.set(`${initialEntry}_${targetY}`, {
      items: filtered,
      totalCount: filtered.length,
    });
    return filtered;
  });

  const [yearTotalCount, setYearTotalCount] = useState<number>(() => yearItems.length);

  // 中間バー：リアルタイム検索＆1クリックセグメントフィルタ
  const [keyword, setKeyword] = useState('');
  const [statusFilter, setStatusFilter] = useState<'' | SalesStatus>('');
  const [approvalFilter, setApprovalFilter] = useState<'' | '0' | '1' | '2'>('');
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

  async function fetchYearSlips(
    entryType: SalesEntryType,
    year: number,
    forceRefresh: boolean = false,
  ) {
    const cacheKey = `${entryType}_${year}`;
    if (!forceRefresh) {
      const fullList = fullDatasetRef.current[entryType];
      if (fullList !== undefined) {
        const sliced = filterItemsByYear(fullList, year);
        yearCacheRef.current.set(cacheKey, { items: sliced, totalCount: sliced.length });
        setSelectedIds([]);
        setYearItems(sliced);
        setYearTotalCount(sliced.length);
        return;
      }

      const cached = yearCacheRef.current.get(cacheKey);
      if (cached !== undefined) {
        setSelectedIds([]);
        setYearItems(cached.items);
        setYearTotalCount(cached.totalCount);
        return;
      }
    }

    setLoading(true);
    setBannerError(null);
    const params = new URLSearchParams();
    params.set('entryType', entryType);
    params.set('dateFrom', `${year}-01-01`);
    params.set('dateTo', `${year}-12-31`);
    params.set('page', '1');
    params.set('pageSize', '2000');

    const res = await requestMasterApi<SalesPageDto>(`/api/v1/sales?${params.toString()}`);
    setLoading(false);
    if (!res.ok) {
      setBannerError(res.error);
      return;
    }

    if (forceRefresh) {
      delete fullDatasetRef.current[entryType];
    }

    yearCacheRef.current.set(cacheKey, {
      items: res.data.items,
      totalCount: res.data.summary.totalCount,
    });
    setSelectedIds([]);
    setYearItems(res.data.items);
    setYearTotalCount(res.data.summary.totalCount);
  }

  function buildSummaryQuery(overrides?: {
    entryTypeFilter?: 'ALL' | SalesEntryType;
    partnerId?: string;
    dateFrom?: string;
    dateTo?: string;
  }): URLSearchParams {
    const ef = overrides?.entryTypeFilter !== undefined ? overrides.entryTypeFilter : sumEntryFilter;
    const pid = overrides?.partnerId !== undefined ? overrides.partnerId : sumPartnerId;
    const from = overrides?.dateFrom !== undefined ? overrides.dateFrom : sumDateFrom;
    const to = overrides?.dateTo !== undefined ? overrides.dateTo : sumDateTo;

    const params = new URLSearchParams();
    if (ef !== 'ALL') params.set('entryTypeFilter', ef);
    if (pid !== '') params.set('partnerId', pid);
    if (from.trim() !== '') params.set('dateFrom', from.trim());
    if (to.trim() !== '') params.set('dateTo', to.trim());
    return params;
  }

  async function loadProductSummary(overrides?: Parameters<typeof buildSummaryQuery>[0]) {
    setLoading(true);
    setBannerError(null);
    const params = buildSummaryQuery(overrides);
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
    setSelectedIds([]);
    if (nextTab === 'SUMMARY') {
      void loadProductSummary();
    } else {
      setSelectedMonth(null);
      void fetchYearSlips(nextTab, selectedYear);
    }
  }

  async function handleChangeYear(nextYear: number) {
    setSelectedYear(nextYear);
    setSelectedMonth(null);
    await fetchYearSlips(currentEntryType, nextYear);
  }

  function handleResetFilters() {
    setKeyword('');
    setStatusFilter('');
    setApprovalFilter('');
    setProjectLink('ALL');
    setSelectedIds([]);
  }

  function handleResetSummaryFilters() {
    setSumEntryFilter('ALL');
    setSumPartnerId('');
    setSumDateFrom('');
    setSumDateTo('');
    setSumKeyword('');
    void loadProductSummary({
      entryTypeFilter: 'ALL',
      partnerId: '',
      dateFrom: '',
      dateTo: '',
    });
  }

  // 左ペイン：1月〜12月および年間合計の集計
  const monthlyBuckets = useMemo<MonthBucketSummary[]>(() => {
    const buckets: MonthBucketSummary[] = Array.from({ length: 12 }, (_, idx) => {
      const month = idx + 1;
      return {
        month,
        label: `${String(month).padStart(2, '0')}月`,
        count: 0,
        approvedCount: 0,
        pendingCount: 0,
        totalAmount: 0,
      };
    });

    for (const item of yearItems) {
      const mNum = Number(item.slipDate.slice(5, 7));
      if (mNum >= 1 && mNum <= 12) {
        const bucket = buckets[mNum - 1];
        if (bucket !== undefined) {
          bucket.count += 1;
          if (item.approvalStatus === 1) bucket.approvedCount += 1;
          if (item.approvalStatus === 0) bucket.pendingCount += 1;
          bucket.totalAmount += item.totalAmount;
        }
      }
    }

    return buckets;
  }, [yearItems]);

  const annualSummary = useMemo(() => {
    let totalAmount = 0;
    let pendingCount = 0;
    let approvedCount = 0;
    for (const item of yearItems) {
      totalAmount += item.totalAmount;
      if (item.approvalStatus === 0) pendingCount += 1;
      if (item.approvalStatus === 1) approvedCount += 1;
    }
    return {
      count: yearItems.length,
      totalAmount,
      pendingCount,
      approvedCount,
    };
  }, [yearItems]);

  // 右ペイン：選択月＋リアルタイム検索＋1クリックセグメントフィルタ適用後の伝票一覧
  const displayedItems = useMemo(() => {
    const kw = keyword.trim().toLowerCase();
    return yearItems.filter((item) => {
      if (selectedMonth !== null) {
        const mNum = Number(item.slipDate.slice(5, 7));
        if (mNum !== selectedMonth) return false;
      }
      if (statusFilter !== '' && item.status !== statusFilter) return false;
      if (approvalFilter !== '' && String(item.approvalStatus) !== approvalFilter) return false;
      if (projectLink === 'LINKED' && item.projectId === null) return false;
      if (projectLink === 'UNLINKED' && item.projectId !== null) return false;

      if (kw !== '') {
        const slipNoStr = String(item.slipNo);
        const formattedNo = item.entryType === 'ADVANCE' ? `t-${slipNoStr}` : `#${slipNoStr}`;
        const slipName = item.slipName.toLowerCase();
        const partnerName = item.partnerName.toLowerCase();
        const partnerCode = item.partnerCode.toLowerCase();
        const projectName = item.projectName !== null ? item.projectName.toLowerCase() : '';
        const projectNoStr = item.projectNo !== null ? String(item.projectNo) : '';
        if (
          !slipNoStr.includes(kw) &&
          !formattedNo.includes(kw) &&
          !slipName.includes(kw) &&
          !partnerName.includes(kw) &&
          !partnerCode.includes(kw) &&
          !projectName.includes(kw) &&
          !projectNoStr.includes(kw)
        ) {
          return false;
        }
      }
      return true;
    });
  }, [yearItems, selectedMonth, keyword, statusFilter, approvalFilter, projectLink]);

  // 上部5連KPI ＆ tfoot 集計（表示中の期間・絞込条件に即時連動）
  const displayedTotals = useMemo(() => {
    let subtotal = 0;
    let tax = 0;
    let total = 0;
    let approvedCount = 0;
    let pendingCount = 0;
    for (const item of displayedItems) {
      subtotal += item.subtotalAmount;
      tax += item.taxTotal;
      total += item.totalAmount;
      if (item.approvalStatus === 1) approvedCount += 1;
      if (item.approvalStatus === 0) pendingCount += 1;
    }
    return { subtotal, tax, total, approvedCount, pendingCount };
  }, [displayedItems]);

  const approvalRateText =
    displayedItems.length > 0
      ? `${((displayedTotals.approvedCount / displayedItems.length) * 100).toFixed(1)}%`
      : '0.0%';

  // SUMMARY タブ：リアルタイムキーワード絞込
  const displayedSummaryItems = useMemo(() => {
    const kw = sumKeyword.trim().toLowerCase();
    if (kw === '') return summaryData.items;
    return summaryData.items.filter((row) => {
      const codeMatch = row.itemCode !== null && row.itemCode.toLowerCase().includes(kw);
      const nameMatch = row.itemName.toLowerCase().includes(kw);
      return codeMatch || nameMatch;
    });
  }, [summaryData.items, sumKeyword]);

  const displayedSummaryTotals = useMemo(() => {
    let exclAmount = 0;
    let taxAmount = 0;
    let inclAmount = 0;
    for (const row of displayedSummaryItems) {
      exclAmount += row.exclAmount;
      taxAmount += row.taxAmount;
      inclAmount += row.inclAmount;
    }
    return {
      rowCount: displayedSummaryItems.length,
      exclAmount,
      taxAmount,
      inclAmount,
    };
  }, [displayedSummaryItems]);

  const hasActiveFilters =
    keyword !== '' || statusFilter !== '' || approvalFilter !== '' || projectLink !== 'ALL';

  const hasActiveSummaryFilters =
    sumEntryFilter !== 'ALL' ||
    sumPartnerId !== '' ||
    sumDateFrom !== '' ||
    sumDateTo !== '' ||
    sumKeyword !== '';

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
    await fetchYearSlips(currentEntryType, selectedYear, true);
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
    await fetchYearSlips(currentEntryType, selectedYear, true);
  }

  function getSalesExportUrl(format: 'csv' | 'pdf'): string {
    const params = new URLSearchParams();
    const range = buildYearRange(selectedYear, selectedMonth);
    params.set('dateFrom', range.from);
    params.set('dateTo', range.to);
    if (keyword.trim() !== '') params.set('q', keyword.trim());
    if (statusFilter !== '') params.set('status', statusFilter);
    if (approvalFilter !== '') params.set('approvalStatus', approvalFilter);
    if (projectLink !== 'ALL') params.set('projectLink', projectLink);
    params.set('kind', currentEntryType);
    params.set('format', format);
    return `/api/v1/sales/export?${params.toString()}`;
  }

  function getSummaryExportUrl(format: 'csv' | 'pdf'): string {
    const params = buildSummaryQuery();
    if (sumKeyword.trim() !== '') params.set('q', sumKeyword.trim());
    params.set('kind', 'PRODUCT_SUMMARY');
    params.set('format', format);
    return `/api/v1/sales/export?${params.toString()}`;
  }

  const periodScopeLabel =
    selectedMonth !== null
      ? `${selectedYear}年${String(selectedMonth).padStart(2, '0')}月`
      : `${selectedYear}年 通年`;

  const selectableCount = displayedItems.filter(
    (i) => i.status !== 'K4' && i.status !== 'K5',
  ).length;

  return (
    <div className="-m-6 min-h-[calc(100vh-3.5rem)] lg:h-[calc(100vh-3.5rem)] flex flex-col bg-[#F0F0FF] text-[#1F1F5C] antialiased lg:overflow-hidden select-none">
      {/* ========================================================= */}
      {/* 画面トップバー */}
      {/* ========================================================= */}
      <header className="h-14 bg-white border-b-2 border-[#9999FF] px-4 sm:px-6 flex items-center justify-between gap-3 shrink-0 shadow-2xs z-20">
        <div className="flex items-center gap-3 min-w-0">
          <div className="flex items-center gap-2 min-w-0">
            <span className="inline-flex h-8 w-8 items-center justify-center rounded-lg bg-gradient-to-b from-[#9999FF] via-[#7878FF] to-[#333399] text-white text-sm shadow-2xs shrink-0">
              🧾
            </span>
            <h1 className="text-base sm:text-lg font-black text-[#1F1F5C] tracking-tight truncate">
              {activeTab === 'ADVANCE'
                ? '立替金伝票一覧'
                : activeTab === 'SUMMARY'
                  ? '商品別売上・立替集計'
                  : '売上伝票一覧'}
            </h1>
            <span className="hidden xl:inline-flex items-center px-2.5 py-0.5 rounded-full text-[11px] font-bold bg-[#CCCCFF] text-[#1F1F5C] border border-[#9999FF] shrink-0">
              {activeTab === 'ADVANCE'
                ? 'TATEKAE'
                : activeTab === 'SUMMARY'
                  ? 'PRODUCT SUMMARY'
                  : 'SALES SLIPS'}
            </span>
          </div>

          {/* 業務タブ切替バー */}
          <nav
            aria-label="売上機能タブ"
            className="hidden md:flex items-center gap-1 rounded-lg bg-[#F0F0FF] p-1 border border-[#B3B3FF] ml-2"
          >
            {lookups.salesEnabled && (
              <button
                type="button"
                onClick={() => handleTabSwitch('SALE')}
                className={`px-3.5 py-1 rounded-md text-xs font-bold transition cursor-pointer ${
                  activeTab === 'SALE'
                    ? 'bg-gradient-to-b from-[#7878FF] to-[#5252CC] text-white shadow-xs'
                    : 'text-[#333399] hover:bg-[#D6D6FF]'
                }`}
              >
                売上伝票
              </button>
            )}
            {lookups.tatekaeEnabled && (
              <button
                type="button"
                onClick={() => handleTabSwitch('ADVANCE')}
                className={`px-3.5 py-1 rounded-md text-xs font-bold transition cursor-pointer ${
                  activeTab === 'ADVANCE'
                    ? 'bg-gradient-to-b from-[#7878FF] to-[#5252CC] text-white shadow-xs'
                    : 'text-[#333399] hover:bg-[#D6D6FF]'
                }`}
              >
                立替金伝票
              </button>
            )}
            {(lookups.salesEnabled || lookups.tatekaeEnabled) && (
              <button
                type="button"
                onClick={() => handleTabSwitch('SUMMARY')}
                className={`px-3.5 py-1 rounded-md text-xs font-bold transition cursor-pointer ${
                  activeTab === 'SUMMARY'
                    ? 'bg-gradient-to-b from-[#7878FF] to-[#5252CC] text-white shadow-xs'
                    : 'text-[#333399] hover:bg-[#D6D6FF]'
                }`}
              >
                商品別売上・立替集計
              </button>
            )}
          </nav>
        </div>

        {/* 右側アクションボタン群（角丸ボタン） */}
        <div className="flex items-center gap-2 shrink-0">
          {activeTab === 'SUMMARY' ? (
            <>
              <a
                href={getSummaryExportUrl('csv')}
                className="h-8 px-3.5 rounded-lg bg-gradient-to-b from-white via-[#F0F0FF] to-[#CCCCFF] hover:to-[#B3B3FF] text-[#333399] border border-[#9999FF] shadow-2xs text-xs font-bold inline-flex items-center gap-1 transition"
              >
                <span>集計CSV出力</span>
              </a>
              <a
                href={getSummaryExportUrl('pdf')}
                target="_blank"
                rel="noopener noreferrer"
                className="h-8 px-3.5 rounded-lg bg-gradient-to-b from-white via-[#F0F0FF] to-[#CCCCFF] hover:to-[#B3B3FF] text-[#333399] border border-[#9999FF] shadow-2xs text-xs font-bold inline-flex items-center gap-1 transition"
              >
                <span>商品別集計PDF</span>
              </a>
            </>
          ) : (
            <>
              <a
                href={getSalesExportUrl('csv')}
                className="hidden sm:inline-flex h-8 px-3.5 rounded-lg bg-gradient-to-b from-white via-[#F0F0FF] to-[#CCCCFF] hover:to-[#B3B3FF] text-[#333399] border border-[#9999FF] shadow-2xs text-xs font-bold items-center gap-1 transition"
              >
                <span>CSV出力</span>
              </a>
              <a
                href={getSalesExportUrl('pdf')}
                target="_blank"
                rel="noopener noreferrer"
                className="hidden sm:inline-flex h-8 px-3.5 rounded-lg bg-gradient-to-b from-white via-[#F0F0FF] to-[#CCCCFF] hover:to-[#B3B3FF] text-[#333399] border border-[#9999FF] shadow-2xs text-xs font-bold items-center gap-1 transition"
              >
                <span>{activeTab === 'ADVANCE' ? '立替金一覧PDF' : '売上一覧PDF'}</span>
              </a>
              <Link
                href={`/sales/new?entryType=${currentEntryType}`}
                className="h-8 px-4 rounded-lg bg-gradient-to-b from-[#7878FF] to-[#5252CC] hover:from-[#8C8CFF] hover:to-[#4747B3] text-white border border-[#333399]/60 shadow-xs text-xs font-bold inline-flex items-center gap-1.5 transition transform hover:-translate-y-0.5 active:translate-y-px"
              >
                <span>＋ 新規{currentEntryType === 'ADVANCE' ? '立替金' : '売上'}発行</span>
                <kbd className="hidden sm:inline-block px-1.5 py-0.5 text-[10px] bg-black/25 text-[#E6E6FF] rounded font-mono font-bold">
                  F2
                </kbd>
              </Link>
            </>
          )}
        </div>
      </header>

      {/* モバイル用タブ切替バー */}
      <div className="md:hidden flex items-center gap-1.5 px-4 py-2 bg-white border-b border-[#B3B3FF] overflow-x-auto shrink-0">
        {lookups.salesEnabled && (
          <button
            type="button"
            onClick={() => handleTabSwitch('SALE')}
            className={`px-3 py-1 rounded-md text-xs font-bold shrink-0 cursor-pointer ${
              activeTab === 'SALE'
                ? 'bg-[#7878FF] text-white'
                : 'bg-[#F0F0FF] text-[#333399]'
            }`}
          >
            売上伝票
          </button>
        )}
        {lookups.tatekaeEnabled && (
          <button
            type="button"
            onClick={() => handleTabSwitch('ADVANCE')}
            className={`px-3 py-1 rounded-md text-xs font-bold shrink-0 cursor-pointer ${
              activeTab === 'ADVANCE'
                ? 'bg-[#7878FF] text-white'
                : 'bg-[#F0F0FF] text-[#333399]'
            }`}
          >
            立替金伝票
          </button>
        )}
        {(lookups.salesEnabled || lookups.tatekaeEnabled) && (
          <button
            type="button"
            onClick={() => handleTabSwitch('SUMMARY')}
            className={`px-3 py-1 rounded-md text-xs font-bold shrink-0 cursor-pointer ${
              activeTab === 'SUMMARY'
                ? 'bg-[#7878FF] text-white'
                : 'bg-[#F0F0FF] text-[#333399]'
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
            {/* KPI サマリカード行（期間・リアルタイム絞込に連動） */}
            {/* ------------------------------------------------------- */}
            <div className="grid grid-cols-2 lg:grid-cols-5 gap-3 shrink-0">
              {/* 1. ダークヒーローカード: 税込合計金額 */}
              <div className="bg-gradient-to-br from-[#19194D] via-[#2B2B80] to-[#4747B3] rounded-xl px-4 py-3 text-white border-2 border-[#9999FF] shadow-sm flex flex-col justify-between col-span-2 lg:col-span-1">
                <div className="flex items-center justify-between text-xs font-bold text-[#CCCCFF]">
                  <span>💰 税込合計金額</span>
                  <span className="px-2 py-0.5 rounded-full bg-[#7878FF]/45 text-[10px] font-mono text-white">
                    {selectedMonth !== null ? `${selectedMonth}月` : '通年'}
                  </span>
                </div>
                <div className="mt-1.5 text-2xl font-black font-mono tabular-nums tracking-tight text-white">
                  {formatYen(displayedTotals.total)}
                </div>
                <div className="mt-1 text-[11px] text-[#B3B3FF] font-mono flex items-center justify-between">
                  <span>対象: {displayedItems.length}件</span>
                  <span className="text-[#E6E6FF]">{periodScopeLabel}</span>
                </div>
              </div>

              {/* 2. 税抜金額合計 */}
              <div className="bg-white rounded-xl px-4 py-3 border-2 border-[#B3B3FF] text-[#1F1F5C] shadow-2xs flex flex-col justify-between">
                <div className="flex items-center justify-between text-xs font-bold text-[#4D4DB3]">
                  <span>💴 税抜金額合計</span>
                  <span className="px-2 py-0.5 rounded-full bg-[#F0F0FF] text-[10px] font-mono text-[#4D4DB3] border border-[#CCCCFF]">
                    EXCL
                  </span>
                </div>
                <div className="mt-1.5 text-xl xl:text-2xl font-black font-mono tabular-nums tracking-tight text-[#1F1F5C]">
                  {formatYen(displayedTotals.subtotal)}
                </div>
                <div className="mt-1 text-[11px] text-[#666699] font-mono flex items-center justify-between">
                  <span>年間税抜</span>
                  <span>
                    {formatYen(
                      yearItems.reduce((acc, item) => acc + item.subtotalAmount, 0),
                    )}
                  </span>
                </div>
              </div>

              {/* 3. 消費税合計 */}
              <div className="bg-white rounded-xl px-4 py-3 border-2 border-[#B3B3FF] text-[#1F1F5C] shadow-2xs flex flex-col justify-between">
                <div className="flex items-center justify-between text-xs font-bold text-[#4D4DB3]">
                  <span>🧮 消費税合計</span>
                  <span className="px-2 py-0.5 rounded-full bg-[#F0F0FF] text-[10px] font-mono text-[#4D4DB3] border border-[#CCCCFF]">
                    TAX
                  </span>
                </div>
                <div className="mt-1.5 text-xl xl:text-2xl font-black font-mono tabular-nums tracking-tight text-[#1F1F5C]">
                  {formatYen(displayedTotals.tax)}
                </div>
                <div className="mt-1 text-[11px] text-[#666699] font-mono flex items-center justify-between">
                  <span>年間税額</span>
                  <span>
                    {formatYen(yearItems.reduce((acc, item) => acc + item.taxTotal, 0))}
                  </span>
                </div>
              </div>

              {/* 4. 承認済件数（クリックで承認済フィルタ切替） */}
              <button
                type="button"
                onClick={() =>
                  setApprovalFilter((prev) => (prev === '1' ? '' : '1'))
                }
                title="クリックで承認済伝票のみ表示 / 解除"
                className={`text-left rounded-xl px-4 py-3 transition flex flex-col justify-between cursor-pointer ${
                  approvalFilter === '1'
                    ? 'bg-emerald-50/70 border-2 border-emerald-500 ring-2 ring-emerald-200 shadow-xs'
                    : 'bg-white border-2 border-[#B3B3FF] hover:border-[#7878FF] shadow-2xs'
                }`}
              >
                <div className="flex items-center justify-between text-xs font-bold text-[#4D4DB3] w-full">
                  <span>✅ 承認済伝票</span>
                  <span className="px-2 py-0.5 rounded-full bg-emerald-100 text-[10px] font-mono text-emerald-800 border border-emerald-300">
                    APPROVED
                  </span>
                </div>
                <div className="mt-1.5 text-xl xl:text-2xl font-black font-mono tabular-nums tracking-tight text-emerald-700">
                  {displayedTotals.approvedCount}{' '}
                  <span className="text-xs font-sans font-bold text-[#666699]">件</span>
                </div>
                <div className="mt-1 text-[11px] text-[#666699] font-mono flex items-center justify-between w-full">
                  <span>承認率 {approvalRateText}</span>
                  <span className="text-[10px] font-sans text-[#4D4DB3]">
                    {approvalFilter === '1' ? '絞込中' : 'クリックで絞込'}
                  </span>
                </div>
              </button>

              {/* 5. 未承認・確認待件数（クリックで未承認フィルタ切替） */}
              <button
                type="button"
                onClick={() =>
                  setApprovalFilter((prev) => (prev === '0' ? '' : '0'))
                }
                title="クリックで未承認伝票のみ表示 / 解除"
                className={`text-left rounded-xl px-4 py-3 transition flex flex-col justify-between cursor-pointer ${
                  approvalFilter === '0'
                    ? 'bg-[#FEE2E2]/45 border-2 border-[#C00000] ring-2 ring-[#FCA5A5] shadow-xs'
                    : 'bg-white border-2 border-[#B3B3FF] hover:border-[#7878FF] shadow-2xs'
                }`}
              >
                <div className="flex items-center justify-between text-xs font-bold text-[#4D4DB3] w-full">
                  <span>⏳ 未承認・確認待</span>
                  <span className="px-2 py-0.5 rounded-full bg-[#F0F0FF] text-[10px] font-mono text-[#4D4DB3] border border-[#CCCCFF]">
                    PENDING
                  </span>
                </div>
                <div
                  className={`mt-1.5 text-xl xl:text-2xl font-black font-mono tabular-nums tracking-tight ${
                    displayedTotals.pendingCount > 0 ? 'text-[#C00000]' : 'text-[#1F1F5C]'
                  }`}
                >
                  {displayedTotals.pendingCount}{' '}
                  <span className="text-xs font-sans font-bold text-[#666699]">件</span>
                </div>
                <div className="mt-1 text-[11px] text-[#666699] font-mono flex items-center justify-between w-full">
                  <span>選択中 {selectedIds.length}件</span>
                  <span className="text-[10px] font-sans text-[#4D4DB3]">
                    {approvalFilter === '0' ? '絞込中' : 'クリックで絞込'}
                  </span>
                </div>
              </button>
            </div>

            {/* ------------------------------------------------------- */}
            {/* 中間コントロールバー（1行完結：リアルタイム検索＋1クリックセグメントボタン） */}
            {/* ------------------------------------------------------- */}
            <div className="relative bg-white pl-4 pr-3 py-2 rounded-xl border-2 border-[#9999FF] shadow-2xs flex flex-wrap xl:flex-nowrap items-center justify-between gap-2 shrink-0 min-h-[50px]">
              <div className="absolute left-0 top-0 bottom-0 w-1.5 bg-[#7878FF] rounded-l-xl" />

              <div className="flex flex-wrap items-center gap-2 min-w-0 flex-1">
                {/* 1. リアルタイム検索入力 */}
                <div className="relative w-48 xl:w-52 shrink-0">
                  <span className="absolute left-2.5 top-1/2 -translate-y-1/2 text-xs text-[#5252CC]">
                    🔍
                  </span>
                  <input
                    type="text"
                    value={keyword}
                    onChange={(e) => setKeyword(e.target.value)}
                    placeholder="伝票No・件名・取引先..."
                    aria-label="リアルタイム検索"
                    className="w-full h-8 pl-7 pr-7 text-xs bg-white border border-[#9999FF] hover:border-[#7878FF] rounded-lg focus:border-[#5252CC] focus:ring-2 focus:ring-[#9999FF]/35 focus:outline-hidden font-semibold text-[#1F1F5C] placeholder:text-[#666699] placeholder:font-normal"
                  />
                  {keyword !== '' && (
                    <button
                      type="button"
                      onClick={() => setKeyword('')}
                      title="入力をクリア"
                      className="absolute right-1.5 top-1/2 -translate-y-1/2 h-5 w-5 rounded flex items-center justify-center text-[11px] text-[#666699] hover:text-[#1F1F5C] hover:bg-[#E6E6FF] cursor-pointer"
                    >
                      ✕
                    </button>
                  )}
                </div>

                {/* 2. ステータス セグメントボタン（K1〜K6コード表記なし） */}
                <div className="flex items-center gap-1 shrink-0">
                  <span className="text-[11px] font-bold text-[#4D4DB3]">状態:</span>
                  <div className="inline-flex items-center rounded-lg bg-[#F0F0FF] p-0.5 border border-[#B3B3FF]">
                    <button
                      type="button"
                      onClick={() => setStatusFilter('')}
                      className={`px-2 py-1 rounded-md text-[11px] font-bold transition whitespace-nowrap cursor-pointer ${
                        statusFilter === ''
                          ? 'bg-gradient-to-b from-[#7878FF] to-[#5252CC] text-white shadow-2xs'
                          : 'text-[#333399] hover:bg-[#D6D6FF]/70'
                      }`}
                    >
                      すべて
                    </button>
                    {STATUS_FILTER_ORDER.map((st) => (
                      <button
                        key={st}
                        type="button"
                        onClick={() =>
                          setStatusFilter((prev) => (prev === st ? '' : st))
                        }
                        className={`px-2 py-1 rounded-md text-[11px] font-bold transition whitespace-nowrap cursor-pointer ${
                          statusFilter === st
                            ? 'bg-gradient-to-b from-[#7878FF] to-[#5252CC] text-white shadow-2xs'
                            : 'text-[#333399] hover:bg-[#D6D6FF]/70'
                        }`}
                      >
                        {SALES_STATUS_LABELS[st]}
                      </button>
                    ))}
                  </div>
                </div>

                {/* 3. 承認状態 セグメントボタン */}
                <div className="flex items-center gap-1 shrink-0">
                  <span className="text-[11px] font-bold text-[#4D4DB3]">承認:</span>
                  <div className="inline-flex items-center rounded-lg bg-[#F0F0FF] p-0.5 border border-[#B3B3FF]">
                    {APPROVAL_FILTER_OPTIONS.map((opt) => (
                      <button
                        key={opt.label}
                        type="button"
                        onClick={() =>
                          setApprovalFilter((prev) =>
                            opt.value !== '' && prev === opt.value ? '' : opt.value,
                          )
                        }
                        className={`px-2 py-1 rounded-md text-[11px] font-bold transition whitespace-nowrap cursor-pointer ${
                          approvalFilter === opt.value
                            ? 'bg-gradient-to-b from-[#7878FF] to-[#5252CC] text-white shadow-2xs'
                            : 'text-[#333399] hover:bg-[#D6D6FF]/70'
                        }`}
                      >
                        {opt.label}
                      </button>
                    ))}
                  </div>
                </div>

                {/* 4. 案件紐付 セグメントボタン */}
                <div className="flex items-center gap-1 shrink-0">
                  <span className="text-[11px] font-bold text-[#4D4DB3]">案件:</span>
                  <div className="inline-flex items-center rounded-lg bg-[#F0F0FF] p-0.5 border border-[#B3B3FF]">
                    {PROJECT_LINK_OPTIONS.map((opt) => (
                      <button
                        key={opt.value}
                        type="button"
                        onClick={() => setProjectLink(opt.value)}
                        className={`px-2 py-1 rounded-md text-[11px] font-bold transition whitespace-nowrap cursor-pointer ${
                          projectLink === opt.value
                            ? 'bg-gradient-to-b from-[#7878FF] to-[#5252CC] text-white shadow-2xs'
                            : 'text-[#333399] hover:bg-[#D6D6FF]/70'
                        }`}
                      >
                        {opt.label}
                      </button>
                    ))}
                  </div>
                </div>
              </div>

              {/* 右端：条件解除（絞込中のみ表示）または読込中バッジ */}
              <div className="flex items-center gap-2 shrink-0">
                {loading && (
                  <span className="inline-flex items-center gap-1 text-[11px] font-bold bg-[#CCCCFF] text-[#1F1F5C] border border-[#7878FF] px-2.5 py-0.5 rounded-full animate-pulse">
                    読込中...
                  </span>
                )}
                {hasActiveFilters && (
                  <button
                    type="button"
                    onClick={handleResetFilters}
                    className="h-7 px-2.5 rounded-md border border-[#9999FF] bg-white hover:bg-[#E6E6FF] text-[11px] font-bold text-[#333399] cursor-pointer transition whitespace-nowrap"
                  >
                    条件解除
                  </button>
                )}
              </div>
            </div>

            {/* 一括承認操作バー */}
            {selectedIds.length > 0 && (
              <div className="rounded-xl border-2 border-[#7878FF] bg-[#CCCCFF] px-4 py-2 flex flex-wrap items-center justify-between gap-2 shrink-0 shadow-2xs">
                <span className="text-xs font-black text-[#1F1F5C]">
                  ☑ {selectedIds.length} 件の伝票を選択中
                </span>
                <div className="flex flex-wrap items-center gap-2">
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() => void handleBatchApproval(1)}
                    className="h-7 rounded-md bg-emerald-600 hover:bg-emerald-700 px-3.5 text-xs font-bold text-white cursor-pointer shadow-2xs"
                  >
                    一括承認
                  </button>
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() => void handleBatchApproval(2)}
                    className="h-7 rounded-md bg-amber-600 hover:bg-amber-700 px-3.5 text-xs font-bold text-white cursor-pointer shadow-2xs"
                  >
                    一括差戻し
                  </button>
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() => void handleBatchApproval(0)}
                    className="h-7 rounded-md border border-[#7878FF] bg-white hover:bg-[#F0F0FF] px-3.5 text-xs font-bold text-[#333399] cursor-pointer"
                  >
                    未承認に戻す
                  </button>
                  <button
                    type="button"
                    onClick={() => setSelectedIds([])}
                    className="h-7 rounded-md border border-[#9999FF] bg-[#F0F0FF] hover:bg-white px-3 text-xs font-medium text-[#4D4DB3] cursor-pointer"
                  >
                    選択解除
                  </button>
                </div>
              </div>
            )}

            {/* ========================================================= */}
            {/* 2ペイン領域（左: 売上月別一覧[年移動+年間計+1〜12月] / 右: 伝票一覧テーブル） */}
            {/* ========================================================= */}
            <div className="flex-1 min-h-[440px] flex flex-col lg:flex-row gap-3.5 lg:overflow-hidden">
              {/* 1. 左サイドバー: 売上月別一覧 */}
              <aside className="w-full lg:w-64 xl:w-72 bg-white rounded-xl border-2 border-[#9999FF] shadow-2xs flex flex-col shrink-0 overflow-hidden max-h-72 lg:max-h-none lg:h-full">
                {/* 年移動統合ヘッダ（背景と同化しない高コントラスト立体ボタン） */}
                <div className="h-10 bg-gradient-to-r from-[#2B2B80] via-[#333399] to-[#2B2B80] border-b border-[#19194D] px-2.5 flex items-center justify-between shrink-0 gap-1.5">
                  <button
                    type="button"
                    onClick={() => void handleChangeYear(selectedYear - 1)}
                    disabled={loading}
                    title="前年へ"
                    className="h-7 px-2.5 rounded-md bg-gradient-to-b from-white via-[#F0F0FF] to-[#CCCCFF] hover:from-white hover:to-[#B3B3FF] text-[#1F1F5C] font-black text-[11px] border border-white/90 shadow-[inset_0_1px_0_rgba(255,255,255,0.9),0_1px_3px_rgba(0,0,0,0.25)] cursor-pointer transition active:translate-y-px disabled:opacity-50 shrink-0"
                  >
                    ◀ 前年
                  </button>
                  <div className="flex items-center gap-1 text-white font-mono font-black text-sm tracking-tight">
                    <span>📅</span>
                    <span>{selectedYear}年</span>
                  </div>
                  <button
                    type="button"
                    onClick={() => void handleChangeYear(selectedYear + 1)}
                    disabled={loading}
                    title="翌年へ"
                    className="h-7 px-2.5 rounded-md bg-gradient-to-b from-white via-[#F0F0FF] to-[#CCCCFF] hover:from-white hover:to-[#B3B3FF] text-[#1F1F5C] font-black text-[11px] border border-white/90 shadow-[inset_0_1px_0_rgba(255,255,255,0.9),0_1px_3px_rgba(0,0,0,0.25)] cursor-pointer transition active:translate-y-px disabled:opacity-50 shrink-0"
                  >
                    翌年 ▶
                  </button>
                </div>

                {/* 先頭行：通年合計 ＋ 1月〜12月カードリスト */}
                <div className="flex-1 min-h-0 overflow-y-auto p-1.5 space-y-1">
                  {/* 先頭固定: 選択年の通年合計行 */}
                  <button
                    type="button"
                    onClick={() => setSelectedMonth(null)}
                    className={`w-full text-left p-2.5 rounded-lg transition border-2 flex flex-col justify-between cursor-pointer ${
                      selectedMonth === null
                        ? 'bg-[#CCCCFF]/85 border-[#7878FF] shadow-xs'
                        : 'bg-[#F5F5FF] border-[#CCCCFF] hover:bg-[#E6E6FF] hover:border-[#9999FF]'
                    }`}
                  >
                    <div className="flex items-center justify-between gap-1">
                      <span className="font-black text-xs text-[#1F1F5C]">
                        📊 {selectedYear}年 通年合計
                      </span>
                      <span className="px-2 py-0.5 rounded-full font-mono text-[10px] font-black bg-[#333399] text-white shrink-0">
                        全 {annualSummary.count}件
                      </span>
                    </div>
                    <div className="mt-1 flex items-center justify-between text-[11px] font-mono">
                      <span className="text-[10px] font-sans font-bold text-[#4D4DB3]">
                        {annualSummary.pendingCount > 0
                          ? `未承認 ${annualSummary.pendingCount}件`
                          : `承認済 ${annualSummary.approvedCount}件`}
                      </span>
                      <span className="font-black text-sm text-[#19194D] tabular-nums">
                        {formatYen(annualSummary.totalAmount)}
                      </span>
                    </div>
                  </button>

                  <div className="border-t border-[#D6D6FF] pt-1 space-y-1">
                    {monthlyBuckets.map((bucket) => {
                      const isSelected = selectedMonth === bucket.month;
                      const isEmpty = bucket.count === 0;
                      return (
                        <button
                          key={bucket.month}
                          type="button"
                          onClick={() =>
                            setSelectedMonth((prev) =>
                              prev === bucket.month ? null : bucket.month,
                            )
                          }
                          title={`${selectedYear}年${bucket.label} の伝票を表示`}
                          className={`w-full text-left px-2.5 py-2 rounded-lg transition border flex items-center justify-between gap-2 cursor-pointer ${
                            isSelected
                              ? 'bg-[#CCCCFF]/80 border-[#7878FF] shadow-2xs ring-1 ring-[#7878FF]/40'
                              : isEmpty
                                ? 'bg-white border-transparent opacity-60 hover:opacity-100 hover:bg-[#F5F5FF] hover:border-[#D6D6FF]'
                                : 'bg-white border-transparent hover:bg-[#F0F0FF] hover:border-[#CCCCFF]'
                          }`}
                        >
                          <div className="flex items-center gap-2 min-w-0">
                            <span
                              className={`w-2 h-2 rounded-full shrink-0 ${
                                isSelected
                                  ? 'bg-[#333399]'
                                  : bucket.pendingCount > 0
                                    ? 'bg-[#C00000]'
                                    : bucket.count > 0
                                      ? 'bg-[#7878FF]'
                                      : 'bg-[#D6D6FF]'
                              }`}
                            />
                            <div className="min-w-0">
                              <div className="flex items-center gap-1.5">
                                <span className="font-mono font-black text-xs text-[#1F1F5C]">
                                  {bucket.label}
                                </span>
                                {bucket.pendingCount > 0 && (
                                  <span className="text-[10px] font-sans font-bold text-[#C00000]">
                                    未承認{bucket.pendingCount}
                                  </span>
                                )}
                              </div>
                            </div>
                          </div>

                          <div className="flex items-center gap-2 shrink-0">
                            <span
                              className={`px-2 py-0.5 rounded-full font-mono text-[10px] font-bold border ${
                                bucket.count > 0
                                  ? 'bg-[#E6E6FF] text-[#1F1F5C] border-[#9999FF]'
                                  : 'bg-[#F5F5FF] text-[#666699] border-[#D6D6FF]'
                              }`}
                            >
                              {bucket.count}件
                            </span>
                            <span
                              className={`font-mono font-black text-xs tabular-nums min-w-[82px] text-right ${
                                bucket.totalAmount > 0 ? 'text-[#19194D]' : 'text-[#666699]'
                              }`}
                            >
                              {formatYen(bucket.totalAmount)}
                            </span>
                          </div>
                        </button>
                      );
                    })}
                  </div>
                </div>

                {/* サイドバーフッタ */}
                <div className="p-2.5 border-t-2 border-[#7878FF] bg-gradient-to-r from-[#C2C2FF] via-[#D6D6FF] to-[#C2C2FF] text-xs font-mono flex items-center justify-between shrink-0 text-[#1F1F5C]">
                  <span className="text-[10px] font-sans font-bold">
                    {periodScopeLabel}（{displayedItems.length}件）
                  </span>
                  <div className="text-right">
                    <span className="text-[10px] font-sans font-bold mr-1">年間計:</span>
                    <span className="font-black text-xs tabular-nums">
                      {formatYen(annualSummary.totalAmount)}
                    </span>
                  </div>
                </div>
              </aside>

              {/* 2. 右メインパネル: 伝票一覧テーブル */}
              <div className="flex-1 min-w-0 min-h-0 bg-white rounded-xl border-2 border-[#9999FF] shadow-2xs overflow-hidden flex flex-col">
                <div className="flex-1 min-h-0 overflow-auto">
                  <table className="w-full h-full min-w-[960px] text-left border-collapse text-xs">
                    <thead className="sticky top-0 z-20 shadow-[0_1px_0_0_rgba(120,120,255,0.4)]">
                      <tr className="h-9 bg-gradient-to-r from-[#CCCCFF] via-[#DDDDFF] to-[#CCCCFF] border-b-2 border-[#7878FF] text-[#1F1F5C] font-black text-xs select-none">
                        <th className="h-9 px-2.5 w-9 text-center">
                          <input
                            type="checkbox"
                            aria-label="未請求伝票を全選択"
                            onChange={toggleSelectAllUnbilled}
                            checked={
                              selectableCount > 0 && selectedIds.length === selectableCount
                            }
                            title="未請求伝票を全選択"
                            className="cursor-pointer accent-[#5252CC]"
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
                        <th className="h-9 py-1 px-2.5 w-12 text-center whitespace-nowrap">🗑️</th>
                      </tr>
                    </thead>

                    <tbody className="divide-y divide-[#D6D6FF] font-sans">
                      {displayedItems.length === 0 ? (
                        <tr>
                          <td colSpan={11} className="px-6 py-16 text-center bg-white">
                            <div className="flex flex-col items-center justify-center gap-2.5">
                              <span className="text-3xl">🧾</span>
                              <p className="text-sm font-black text-[#1F1F5C]">
                                {periodScopeLabel} に一致する伝票データがありません
                              </p>
                              <p className="text-xs text-[#666699]">
                                左の月別一覧・年切替または上のリアルタイム検索条件を変更してください。
                              </p>
                              <Link
                                href={`/sales/new?entryType=${currentEntryType}`}
                                className="mt-1 h-8 px-4 rounded-lg bg-gradient-to-b from-[#7878FF] to-[#5252CC] text-white text-xs font-bold inline-flex items-center gap-1 shadow-xs"
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
                            const zebraClass = idx % 2 === 0 ? 'bg-white' : 'bg-[#F5F5FF]';
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
                                className={`h-9 ${zebraClass} hover:bg-[#D6D6FF]/65 transition-colors cursor-pointer group`}
                              >
                                <td className="h-9 px-2.5 text-center">
                                  <input
                                    type="checkbox"
                                    disabled={isBilled}
                                    checked={selectedIds.includes(item.id)}
                                    onChange={() => toggleRowSelect(item.id)}
                                    className="cursor-pointer disabled:cursor-not-allowed accent-[#5252CC]"
                                  />
                                </td>
                                <td className="h-9 py-1 px-2.5 text-center font-mono font-black text-[#333399] whitespace-nowrap">
                                  <Link
                                    href={`/sales/${item.id}`}
                                    className="hover:text-[#5252CC] hover:underline"
                                  >
                                    {item.entryType === 'ADVANCE'
                                      ? `T-${item.slipNo}`
                                      : `#${item.slipNo}`}
                                  </Link>
                                </td>
                                <td className="h-9 py-1 px-2.5 text-center font-mono text-xs text-[#1F1F5C] whitespace-nowrap">
                                  {item.slipDate.replace(/-/g, '/')}
                                </td>
                                <td className="h-9 py-1 px-2.5 text-center whitespace-nowrap">
                                  <span
                                    className={`inline-flex px-2 py-0.5 rounded-full text-[11px] font-bold border ${
                                      isBilled
                                        ? 'bg-[#C2C2FF] text-[#19194D] border-[#7878FF]'
                                        : item.status === 'K3'
                                          ? 'bg-[#D6D6FF] text-[#1F1F5C] border-[#7878FF]/70'
                                          : item.status === 'K2'
                                            ? 'bg-[#E6E6FF] text-[#333399] border-[#9999FF]'
                                            : 'bg-[#F5F5FF] text-[#4D4DB3] border-[#B3B3FF]'
                                    }`}
                                  >
                                    {SALES_STATUS_LABELS[item.status]}
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
                                <td className="h-9 py-1 px-3 text-[#1F1F5C]">
                                  <div className="font-bold text-xs truncate max-w-[200px]">
                                    {item.partnerName}
                                  </div>
                                  <div className="text-[10px] font-mono text-[#666699]">
                                    {item.partnerCode}
                                  </div>
                                </td>
                                <td className="h-9 py-1 px-3 text-[#1F1F5C]">
                                  <Link
                                    href={`/sales/${item.id}`}
                                    className="font-bold text-xs text-[#1F1F5C] group-hover:text-[#5252CC] hover:underline block truncate max-w-[280px]"
                                  >
                                    {item.slipName !== '' ? item.slipName : '（件名なし）'}
                                  </Link>
                                  {item.projectName !== null && (
                                    <div className="mt-0.5">
                                      <span className="inline-flex items-center px-2 py-0.5 rounded-full text-[10px] font-bold bg-[#E6E6FF] text-[#333399] border border-[#9999FF]">
                                        工事 #{item.projectNo}: {item.projectName}
                                      </span>
                                    </div>
                                  )}
                                </td>
                                <td className="h-9 py-1 px-3 text-right font-mono tabular-nums text-xs text-[#333366] whitespace-nowrap">
                                  {formatYen(item.subtotalAmount)}
                                </td>
                                <td className="h-9 py-1 px-3 text-right font-mono tabular-nums text-xs text-[#4D4DB3] whitespace-nowrap">
                                  {formatYen(item.taxTotal)}
                                </td>
                                <td className="h-9 py-1 px-3 text-right font-mono tabular-nums text-xs font-black text-[#19194D] whitespace-nowrap">
                                  {formatYen(item.totalAmount)}
                                </td>
                                <td className="h-9 py-1 px-2.5 text-center whitespace-nowrap">
                                  {(() => {
                                    const canDelete =
                                      !isBilled &&
                                      item.deliveryNoteCount === 0 &&
                                      item.deliveryReceiptCount === 0;
                                    return (
                                      <button
                                        type="button"
                                        disabled={!canDelete || busy}
                                        onClick={() => void handleDelete(item)}
                                        title={
                                          canDelete
                                            ? '伝票を削除'
                                            : '請求済みまたは納品書・受領書発行済みのため削除できません'
                                        }
                                        aria-label="伝票を削除"
                                        className={`h-7 w-7 rounded-md flex items-center justify-center transition mx-auto ${
                                          canDelete
                                            ? 'text-[#666699] hover:text-[#C00000] hover:bg-[#FEE2E2] border border-transparent hover:border-[#FCA5A5] cursor-pointer'
                                            : 'text-[#CCCCFF] cursor-not-allowed opacity-50'
                                        }`}
                                      >
                                        <svg
                                          viewBox="0 0 24 24"
                                          fill="none"
                                          stroke="currentColor"
                                          strokeWidth="2"
                                          strokeLinecap="round"
                                          strokeLinejoin="round"
                                          className="w-3.5 h-3.5"
                                          aria-hidden="true"
                                        >
                                          <path d="M3 6h18" />
                                          <path d="M19 6v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6" />
                                          <path d="M8 6V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2" />
                                          <line x1="10" x2="10" y1="11" y2="17" />
                                          <line x1="14" x2="14" y1="11" y2="17" />
                                        </svg>
                                      </button>
                                    );
                                  })()}
                                </td>
                              </tr>
                            );
                          })}
                          <tr aria-hidden="true" className="h-full">
                            <td colSpan={11} className="p-0 border-0" />
                          </tr>
                        </>
                      )}
                    </tbody>

                    {/* 下部固定 合計フッタ行 */}
                    <tfoot className="sticky bottom-0 z-20 shadow-[0_-1px_0_0_rgba(120,120,255,0.45)]">
                      <tr className="h-9 bg-gradient-to-r from-[#C2C2FF] via-[#D6D6FF] to-[#C2C2FF] font-black text-[#1F1F5C] border-t-2 border-[#7878FF] text-xs">
                        <td colSpan={2} className="h-9 py-1 px-3 text-center whitespace-nowrap font-mono">
                          表示 {displayedItems.length} 伝票
                        </td>
                        <td colSpan={5} className="h-9 py-1 px-3 text-left text-[11px] font-bold text-[#1F1F5C]">
                          {periodScopeLabel} 合計
                          {hasActiveFilters ? '（条件絞込適用中）' : ''}
                        </td>
                        <td className="h-9 py-1 px-3 text-right font-mono tabular-nums whitespace-nowrap">
                          {formatYen(displayedTotals.subtotal)}
                        </td>
                        <td className="h-9 py-1 px-3 text-right font-mono tabular-nums whitespace-nowrap text-[#333399]">
                          {formatYen(displayedTotals.tax)}
                        </td>
                        <td className="h-9 py-1 px-3 text-right font-mono tabular-nums font-black whitespace-nowrap text-[#19194D]">
                          {formatYen(displayedTotals.total)}
                        </td>
                        <td className="h-9 py-1 px-2.5 text-center font-mono text-[10px] text-[#333399]">
                          Total
                        </td>
                      </tr>
                    </tfoot>
                  </table>
                </div>

                {/* 下部フッタバー */}
                <div className="min-h-9 px-4 py-1.5 bg-gradient-to-r from-[#2B2B80] via-[#333399] to-[#2B2B80] border-t-2 border-[#7878FF] flex flex-wrap items-center justify-between gap-2 text-xs text-white shrink-0">
                  <span className="text-[11px] text-[#E6E6FF] truncate">
                    ※ 左の売上月別一覧（通年 / 1〜12月）で表示期間を即時切替、上のバーでリアルタイム絞り込みができます。
                  </span>
                  <div className="flex items-center gap-2 font-mono shrink-0">
                    <span className="px-2.5 py-0.5 rounded-full bg-[#7878FF]/45 border border-[#CCCCFF]/40 text-[11px] text-[#E6E6FF]">
                      表示: {displayedItems.length} 件 / {selectedYear}年 全 {yearTotalCount} 件
                    </span>
                  </div>
                </div>
              </div>
            </div>
          </>
        ) : (
          /* ========================================================= */
          /* 商品別売上・立替集計タブ（区分セグメントボタン＋リアルタイム検索） */
          /* ========================================================= */
          <div className="flex-1 min-h-[440px] flex flex-col space-y-3 lg:overflow-hidden">
            <div className="grid grid-cols-2 md:grid-cols-4 gap-3 shrink-0">
              <div className="bg-gradient-to-br from-[#19194D] via-[#2B2B80] to-[#4747B3] rounded-xl px-4 py-3 text-white border-2 border-[#9999FF] shadow-sm flex flex-col justify-between">
                <div className="flex items-center justify-between text-xs font-bold text-[#CCCCFF]">
                  <span>💰 税込金額合計</span>
                  <span className="px-2 py-0.5 rounded-full bg-[#7878FF]/45 text-[10px] font-mono">
                    SUMMARY
                  </span>
                </div>
                <div className="mt-1.5 text-2xl font-black font-mono tabular-nums text-white">
                  {formatYen(displayedSummaryTotals.inclAmount)}
                </div>
                <div className="mt-1 text-[11px] text-[#B3B3FF] font-mono">
                  集計品目: {displayedSummaryTotals.rowCount} 件
                </div>
              </div>

              <div className="bg-white rounded-xl px-4 py-3 border-2 border-[#B3B3FF] text-[#1F1F5C] shadow-2xs flex flex-col justify-between">
                <div className="text-xs font-bold text-[#4D4DB3]">📦 集計品目数</div>
                <div className="mt-1.5 text-2xl font-black font-mono tabular-nums text-[#1F1F5C]">
                  {displayedSummaryTotals.rowCount}{' '}
                  <span className="text-xs font-sans font-bold text-[#666699]">品目</span>
                </div>
                <div className="mt-1 text-[11px] text-[#666699] font-mono">商品別グルーピング</div>
              </div>

              <div className="bg-white rounded-xl px-4 py-3 border-2 border-[#B3B3FF] text-[#1F1F5C] shadow-2xs flex flex-col justify-between">
                <div className="text-xs font-bold text-[#4D4DB3]">💴 税抜金額合計</div>
                <div className="mt-1.5 text-2xl font-black font-mono tabular-nums text-[#1F1F5C]">
                  {formatYen(displayedSummaryTotals.exclAmount)}
                </div>
                <div className="mt-1 text-[11px] text-[#666699] font-mono">純売上合計</div>
              </div>

              <div className="bg-white rounded-xl px-4 py-3 border-2 border-[#B3B3FF] text-[#1F1F5C] shadow-2xs flex flex-col justify-between">
                <div className="text-xs font-bold text-[#4D4DB3]">🧾 消費税額合計</div>
                <div className="mt-1.5 text-2xl font-black font-mono tabular-nums text-[#1F1F5C]">
                  {formatYen(displayedSummaryTotals.taxAmount)}
                </div>
                <div className="mt-1 text-[11px] text-[#666699] font-mono">内訳税額合算</div>
              </div>
            </div>

            <div className="relative bg-white pl-4 pr-3.5 py-2 rounded-xl border-2 border-[#9999FF] shadow-2xs flex flex-wrap items-center justify-between gap-2.5 shrink-0 min-h-[50px]">
              <div className="absolute left-0 top-0 bottom-0 w-1.5 bg-[#7878FF] rounded-l-xl" />
              <div className="flex flex-wrap items-center gap-2.5">
                {/* リアルタイム品名・コード検索 */}
                <div className="relative w-52">
                  <span className="absolute left-2.5 top-1/2 -translate-y-1/2 text-xs text-[#5252CC]">
                    🔍
                  </span>
                  <input
                    type="text"
                    value={sumKeyword}
                    onChange={(e) => setSumKeyword(e.target.value)}
                    placeholder="品名・商品コードで即時検索..."
                    className="w-full h-8 pl-7 pr-7 rounded-lg border border-[#9999FF] focus:border-[#5252CC] focus:ring-2 focus:ring-[#9999FF]/35 focus:outline-hidden text-xs font-semibold text-[#1F1F5C] placeholder:text-[#666699] placeholder:font-normal"
                  />
                  {sumKeyword !== '' && (
                    <button
                      type="button"
                      onClick={() => setSumKeyword('')}
                      title="入力をクリア"
                      className="absolute right-1.5 top-1/2 -translate-y-1/2 h-5 w-5 rounded flex items-center justify-center text-[11px] text-[#666699] hover:text-[#1F1F5C] hover:bg-[#E6E6FF] cursor-pointer"
                    >
                      ✕
                    </button>
                  )}
                </div>

                {/* 区分セグメントボタン */}
                <div className="flex items-center gap-1">
                  <span className="text-[11px] font-bold text-[#4D4DB3]">区分:</span>
                  <div className="inline-flex items-center rounded-lg bg-[#F0F0FF] p-0.5 border border-[#B3B3FF]">
                    {lookups.salesEnabled && lookups.tatekaeEnabled && (
                      <button
                        type="button"
                        onClick={() => {
                          setSumEntryFilter('ALL');
                          void loadProductSummary({ entryTypeFilter: 'ALL' });
                        }}
                        className={`px-2.5 py-1 rounded-md text-[11px] font-bold transition cursor-pointer ${
                          sumEntryFilter === 'ALL'
                            ? 'bg-gradient-to-b from-[#7878FF] to-[#5252CC] text-white shadow-2xs'
                            : 'text-[#333399] hover:bg-[#D6D6FF]/70'
                        }`}
                      >
                        すべて
                      </button>
                    )}
                    {lookups.salesEnabled && (
                      <button
                        type="button"
                        onClick={() => {
                          setSumEntryFilter('SALE');
                          void loadProductSummary({ entryTypeFilter: 'SALE' });
                        }}
                        className={`px-2.5 py-1 rounded-md text-[11px] font-bold transition cursor-pointer ${
                          sumEntryFilter === 'SALE'
                            ? 'bg-gradient-to-b from-[#7878FF] to-[#5252CC] text-white shadow-2xs'
                            : 'text-[#333399] hover:bg-[#D6D6FF]/70'
                        }`}
                      >
                        売上のみ
                      </button>
                    )}
                    {lookups.tatekaeEnabled && (
                      <button
                        type="button"
                        onClick={() => {
                          setSumEntryFilter('ADVANCE');
                          void loadProductSummary({ entryTypeFilter: 'ADVANCE' });
                        }}
                        className={`px-2.5 py-1 rounded-md text-[11px] font-bold transition cursor-pointer ${
                          sumEntryFilter === 'ADVANCE'
                            ? 'bg-gradient-to-b from-[#7878FF] to-[#5252CC] text-white shadow-2xs'
                            : 'text-[#333399] hover:bg-[#D6D6FF]/70'
                        }`}
                      >
                        立替のみ
                      </button>
                    )}
                  </div>
                </div>

                {/* 取引先・期間 */}
                <select
                  aria-label="取引先"
                  value={sumPartnerId}
                  onChange={(e) => {
                    const nextPartner = e.target.value;
                    setSumPartnerId(nextPartner);
                    void loadProductSummary({ partnerId: nextPartner });
                  }}
                  className="h-8 rounded-lg border border-[#9999FF] bg-white px-2.5 text-xs font-semibold text-[#1F1F5C] max-w-[200px]"
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
                    onChange={(e) => {
                      const nextFrom = e.target.value;
                      setSumDateFrom(nextFrom);
                      void loadProductSummary({ dateFrom: nextFrom });
                    }}
                    className="h-8 rounded-lg border border-[#9999FF] px-2 text-xs font-mono text-[#1F1F5C] bg-white"
                  />
                  <span className="text-xs text-[#666699]">〜</span>
                  <input
                    aria-label="集計期間To"
                    type="date"
                    value={sumDateTo}
                    onChange={(e) => {
                      const nextTo = e.target.value;
                      setSumDateTo(nextTo);
                      void loadProductSummary({ dateTo: nextTo });
                    }}
                    className="h-8 rounded-lg border border-[#9999FF] px-2 text-xs font-mono text-[#1F1F5C] bg-white"
                  />
                </div>
              </div>

              <div className="flex items-center gap-2">
                {loading && (
                  <span className="inline-flex items-center gap-1 text-[11px] font-bold bg-[#CCCCFF] text-[#1F1F5C] border border-[#7878FF] px-2.5 py-0.5 rounded-full animate-pulse">
                    集計中...
                  </span>
                )}
                {hasActiveSummaryFilters && (
                  <button
                    type="button"
                    onClick={handleResetSummaryFilters}
                    disabled={loading}
                    className="h-7 px-2.5 rounded-md border border-[#9999FF] bg-white hover:bg-[#E6E6FF] text-[11px] font-bold text-[#333399] cursor-pointer"
                  >
                    条件解除
                  </button>
                )}
                <span className="px-2.5 py-1 rounded-full text-[11px] font-mono font-black bg-[#CCCCFF] text-[#1F1F5C] border border-[#7878FF]">
                  計 {displayedSummaryTotals.rowCount} 品目
                </span>
              </div>
            </div>

            <div className="flex-1 min-h-0 bg-white rounded-xl border-2 border-[#9999FF] shadow-2xs overflow-hidden flex flex-col">
              <div className="flex-1 min-h-0 overflow-auto">
                <table className="w-full h-full min-w-[920px] text-left border-collapse text-xs">
                  <thead className="sticky top-0 z-20">
                    <tr className="h-9 bg-gradient-to-r from-[#CCCCFF] via-[#DDDDFF] to-[#CCCCFF] border-b-2 border-[#7878FF] text-[#1F1F5C] font-black text-xs select-none">
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
                  <tbody className="divide-y divide-[#D6D6FF]">
                    {displayedSummaryItems.length === 0 ? (
                      <tr>
                        <td colSpan={10} className="px-4 py-14 text-center text-sm text-[#666699] bg-white">
                          該当する集計データがありません。
                        </td>
                      </tr>
                    ) : (
                      <>
                        {displayedSummaryItems.map((row, idx) => (
                          <tr
                            key={`${row.entryType}-${row.itemName}-${row.taxCode}-${idx}`}
                            className={`h-9 ${idx % 2 === 0 ? 'bg-white' : 'bg-[#F5F5FF]'} hover:bg-[#D6D6FF]/65 transition-colors`}
                          >
                            <td className="h-9 px-3 text-center whitespace-nowrap">
                              <span
                                className={`inline-flex px-2 py-0.5 rounded-full text-[11px] font-bold border ${
                                  row.entryType === 'ADVANCE'
                                    ? 'bg-[#C2C2FF] text-[#19194D] border-[#7878FF]'
                                    : 'bg-[#E6E6FF] text-[#333399] border-[#9999FF]'
                                }`}
                              >
                                {ENTRY_TYPE_LABELS[row.entryType]}
                              </span>
                            </td>
                            <td className="h-9 px-3 font-mono text-xs text-[#4D4DB3] whitespace-nowrap">
                              {row.itemCode !== null ? row.itemCode : '-'}
                            </td>
                            <td className="h-9 px-3 text-[#1F1F5C] font-bold whitespace-pre-line">
                              {row.itemName}
                            </td>
                            <td className="h-9 px-3 text-center text-xs text-[#333366] whitespace-nowrap">
                              {row.unitName !== null ? row.unitName : '-'}
                            </td>
                            <td className="h-9 px-3 text-center font-mono text-xs text-[#1F1F5C]">
                              {row.taxCode}
                            </td>
                            <td className="h-9 px-3 text-right font-mono tabular-nums text-xs text-[#1F1F5C]">
                              {row.slipCount}
                            </td>
                            <td className="h-9 px-3 text-right font-mono tabular-nums text-xs text-[#1F1F5C]">
                              {formatQty(row.totalQuantity)}
                            </td>
                            <td className="h-9 px-3 text-right font-mono tabular-nums text-xs text-[#333366]">
                              {formatYen(row.exclAmount)}
                            </td>
                            <td className="h-9 px-3 text-right font-mono tabular-nums text-xs text-[#4D4DB3]">
                              {formatYen(row.taxAmount)}
                            </td>
                            <td className="h-9 px-3 text-right font-mono tabular-nums text-xs font-black text-[#19194D]">
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
                    <tr className="h-9 bg-gradient-to-r from-[#C2C2FF] via-[#D6D6FF] to-[#C2C2FF] font-black text-[#1F1F5C] border-t-2 border-[#7878FF] text-xs">
                      <td colSpan={7} className="h-9 px-3 text-left font-bold">
                        商品別集計合計（全 {displayedSummaryTotals.rowCount} 品目）
                      </td>
                      <td className="h-9 px-3 text-right font-mono tabular-nums">
                        {formatYen(displayedSummaryTotals.exclAmount)}
                      </td>
                      <td className="h-9 px-3 text-right font-mono tabular-nums text-[#333399]">
                        {formatYen(displayedSummaryTotals.taxAmount)}
                      </td>
                      <td className="h-9 px-3 text-right font-mono tabular-nums font-black text-[#19194D]">
                        {formatYen(displayedSummaryTotals.inclAmount)}
                      </td>
                    </tr>
                  </tfoot>
                </table>
              </div>
              <div className="h-9 px-4 bg-gradient-to-r from-[#2B2B80] via-[#333399] to-[#2B2B80] border-t-2 border-[#7878FF] flex items-center justify-between text-xs text-white shrink-0">
                <span className="text-[11px] text-[#E6E6FF]">
                  ※ 区分ボタン・取引先・期間で自動集計し、品名・商品コードで即時絞り込みができます。
                </span>
                <span className="font-mono text-[11px] text-[#E6E6FF]">
                  表示中: {displayedSummaryTotals.rowCount} 品目
                </span>
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
