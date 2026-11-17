'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect, useMemo, useRef, useState } from 'react';
import { requestMasterApi } from '@/lib/masters/client-api';
import {
  APPROVAL_STATUS_LABELS,
  SALES_STATUS_LABELS,
  type ApprovalStatus,
  type SalesEditorLookupsDto,
  type SalesListItemDto,
  type SalesPageDto,
  type SalesStatus,
} from '@/lib/sales/types';

interface SalesListClientProps {
  lookups: SalesEditorLookupsDto;
  initialSalesPage: SalesPageDto;
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

function formatAmount(amount: number): string {
  return amount.toLocaleString('ja-JP');
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
  lookups: _lookups,
  initialSalesPage,
  currentJstYear,
}: SalesListClientProps) {
  const router = useRouter();

  const yearCacheRef = useRef<Map<number, { items: SalesListItemDto[]; totalCount: number }>>(
    new Map(),
  );
  const fullDatasetRef = useRef<SalesListItemDto[] | null>(
    initialSalesPage.summary.totalCount <= initialSalesPage.items.length
      ? initialSalesPage.items
      : null,
  );

  const [selectedYear, setSelectedYear] = useState<number>(() =>
    extractYearFromItems(initialSalesPage.items, currentJstYear),
  );
  const [selectedMonth, setSelectedMonth] = useState<number | null>(null);

  const [yearItems, setYearItems] = useState<SalesListItemDto[]>(() => {
    const targetY = extractYearFromItems(initialSalesPage.items, currentJstYear);
    const filtered = filterItemsByYear(initialSalesPage.items, targetY);
    yearCacheRef.current.set(targetY, { items: filtered, totalCount: filtered.length });
    return filtered;
  });

  const [yearTotalCount, setYearTotalCount] = useState<number>(() => yearItems.length);

  // 中間バー：リアルタイム検索＆1クリックセグメントフィルタ
  const [keyword, setKeyword] = useState('');
  const [statusFilter, setStatusFilter] = useState<'' | SalesStatus>('');
  const [approvalFilter, setApprovalFilter] = useState<'' | '0' | '1' | '2'>('');
  const [projectLink, setProjectLink] = useState<'ALL' | 'LINKED' | 'UNLINKED'>('ALL');
  const [selectedIds, setSelectedIds] = useState<string[]>([]);

  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [bannerError, setBannerError] = useState<string | null>(null);
  const [bannerSuccess, setBannerSuccess] = useState<string | null>(null);

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'F2') {
        e.preventDefault();
        router.push('/sales/new?entryType=SALE');
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [router]);

  async function fetchYearSlips(year: number, forceRefresh: boolean = false) {
    if (!forceRefresh) {
      if (fullDatasetRef.current !== null) {
        const sliced = filterItemsByYear(fullDatasetRef.current, year);
        yearCacheRef.current.set(year, { items: sliced, totalCount: sliced.length });
        setSelectedIds([]);
        setYearItems(sliced);
        setYearTotalCount(sliced.length);
        return;
      }

      const cached = yearCacheRef.current.get(year);
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
    params.set('entryType', 'SALE');
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
      fullDatasetRef.current = null;
    }

    yearCacheRef.current.set(year, {
      items: res.data.items,
      totalCount: res.data.summary.totalCount,
    });
    setSelectedIds([]);
    setYearItems(res.data.items);
    setYearTotalCount(res.data.summary.totalCount);
  }

  async function handleChangeYear(nextYear: number) {
    setSelectedYear(nextYear);
    setSelectedMonth(null);
    await fetchYearSlips(nextYear);
  }

  function handleResetFilters() {
    setKeyword('');
    setStatusFilter('');
    setApprovalFilter('');
    setProjectLink('ALL');
    setSelectedIds([]);
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

  // 右ペイン：選択月＋リアルタイム検索＋1クリックセグメントフィルタ適用後の売上伝票
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
        const formattedNo = `#${slipNoStr}`;
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

  const hasActiveFilters =
    keyword !== '' || statusFilter !== '' || approvalFilter !== '' || projectLink !== 'ALL';

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
      `${res.data.updatedCount}件の売上伝票を「${APPROVAL_STATUS_LABELS[approvalStatus]}」に更新しました。`,
    );
    await fetchYearSlips(selectedYear, true);
  }

  async function handleDelete(item: SalesListItemDto) {
    if (!window.confirm(`売上 #${item.slipNo}「${item.slipName}」を削除しますか？`)) {
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
    setBannerSuccess(`売上 #${item.slipNo} を削除しました。`);
    await fetchYearSlips(selectedYear, true);
  }

  function getExportUrl(format: 'csv' | 'pdf'): string {
    const params = new URLSearchParams();
    const range = buildYearRange(selectedYear, selectedMonth);
    params.set('dateFrom', range.from);
    params.set('dateTo', range.to);
    if (keyword.trim() !== '') params.set('q', keyword.trim());
    if (statusFilter !== '') params.set('status', statusFilter);
    if (approvalFilter !== '') params.set('approvalStatus', approvalFilter);
    if (projectLink !== 'ALL') params.set('projectLink', projectLink);
    params.set('kind', 'SALE');
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
      {/* 画面トップバー（売上伝票専用・タブなし） */}
      {/* ========================================================= */}
      <header className="h-14 bg-white border-b-2 border-[#9999FF] px-4 sm:px-6 flex items-center justify-between gap-3 shrink-0 shadow-2xs z-20">
        <div className="flex items-center gap-2.5 min-w-0">
          <span className="inline-flex h-8 w-8 items-center justify-center rounded-lg bg-gradient-to-b from-[#9999FF] via-[#7878FF] to-[#333399] text-white text-sm shadow-2xs shrink-0">
            🧾
          </span>
          <h1 className="text-base sm:text-lg font-black text-[#1F1F5C] tracking-tight truncate">
            売上伝票一覧
          </h1>
          <span className="hidden sm:inline-flex items-center px-2.5 py-0.5 rounded-full text-[11px] font-bold bg-[#CCCCFF] text-[#1F1F5C] border border-[#9999FF] shrink-0">
            SALES SLIPS
          </span>
        </div>

        {/* 右側アクションボタン群（角丸ボタン） */}
        <div className="flex items-center gap-2 shrink-0">
          <a
            href={getExportUrl('csv')}
            className="hidden sm:inline-flex h-8 px-3.5 rounded-lg bg-gradient-to-b from-white via-[#F0F0FF] to-[#CCCCFF] hover:to-[#B3B3FF] text-[#333399] border border-[#9999FF] shadow-2xs text-xs font-bold items-center gap-1 transition"
          >
            <span>CSV出力</span>
          </a>
          <a
            href={getExportUrl('pdf')}
            target="_blank"
            rel="noopener noreferrer"
            className="hidden sm:inline-flex h-8 px-3.5 rounded-lg bg-gradient-to-b from-white via-[#F0F0FF] to-[#CCCCFF] hover:to-[#B3B3FF] text-[#333399] border border-[#9999FF] shadow-2xs text-xs font-bold items-center gap-1 transition"
          >
            <span>売上一覧PDF</span>
          </a>
          <Link
            href="/sales/new?entryType=SALE"
            className="h-8 px-4 rounded-lg bg-gradient-to-b from-[#7878FF] to-[#5252CC] hover:from-[#8C8CFF] hover:to-[#4747B3] text-white border border-[#333399]/60 shadow-xs text-xs font-bold inline-flex items-center gap-1.5 transition transform hover:-translate-y-0.5 active:translate-y-px"
          >
            <span>＋ 新規売上発行</span>
            <kbd className="hidden sm:inline-block px-1.5 py-0.5 text-[10px] bg-black/25 text-[#E6E6FF] rounded font-mono font-bold">
              F2
            </kbd>
          </Link>
        </div>
      </header>

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

        {/* ------------------------------------------------------- */}
        {/* KPI サマリカード行（期間・リアルタイム絞込に連動） */}
        {/* ------------------------------------------------------- */}
        <div className="grid grid-cols-2 lg:grid-cols-5 gap-3 shrink-0">
          <div className="bg-gradient-to-br from-[#19194D] via-[#2B2B80] to-[#4747B3] rounded-xl px-4 py-3 text-white border-2 border-[#9999FF] shadow-sm flex flex-col justify-between col-span-2 lg:col-span-1">
            <div className="flex items-center justify-between text-xs font-bold text-[#CCCCFF]">
              <span>💰 税込合計金額</span>
              <span className="px-2 py-0.5 rounded-full bg-[#7878FF]/45 text-[10px] font-mono text-white">
                {selectedMonth !== null ? `${selectedMonth}月` : '通年'}
              </span>
            </div>
            <div className="mt-1.5 text-2xl font-black font-mono tabular-nums tracking-tight text-white">
              {formatAmount(displayedTotals.total)}
            </div>
            <div className="mt-1 text-[11px] text-[#B3B3FF] font-mono flex items-center justify-between">
              <span>対象: {displayedItems.length}件</span>
              <span className="text-[#E6E6FF]">{periodScopeLabel}</span>
            </div>
          </div>

          <div className="bg-white rounded-xl px-4 py-3 border-2 border-[#B3B3FF] text-[#1F1F5C] shadow-2xs flex flex-col justify-between">
            <div className="flex items-center justify-between text-xs font-bold text-[#4D4DB3]">
              <span>💴 税抜金額合計</span>
              <span className="px-2 py-0.5 rounded-full bg-[#F0F0FF] text-[10px] font-mono text-[#4D4DB3] border border-[#CCCCFF]">
                EXCL
              </span>
            </div>
            <div className="mt-1.5 text-xl xl:text-2xl font-black font-mono tabular-nums tracking-tight text-[#1F1F5C]">
              {formatAmount(displayedTotals.subtotal)}
            </div>
            <div className="mt-1 text-[11px] text-[#666699] font-mono flex items-center justify-between">
              <span>年間税抜</span>
              <span>
                {formatAmount(yearItems.reduce((acc, item) => acc + item.subtotalAmount, 0))}
              </span>
            </div>
          </div>

          <div className="bg-white rounded-xl px-4 py-3 border-2 border-[#B3B3FF] text-[#1F1F5C] shadow-2xs flex flex-col justify-between">
            <div className="flex items-center justify-between text-xs font-bold text-[#4D4DB3]">
              <span>🧮 消費税合計</span>
              <span className="px-2 py-0.5 rounded-full bg-[#F0F0FF] text-[10px] font-mono text-[#4D4DB3] border border-[#CCCCFF]">
                TAX
              </span>
            </div>
            <div className="mt-1.5 text-xl xl:text-2xl font-black font-mono tabular-nums tracking-tight text-[#1F1F5C]">
              {formatAmount(displayedTotals.tax)}
            </div>
            <div className="mt-1 text-[11px] text-[#666699] font-mono flex items-center justify-between">
              <span>年間税額</span>
              <span>{formatAmount(yearItems.reduce((acc, item) => acc + item.taxTotal, 0))}</span>
            </div>
          </div>

          <button
            type="button"
            onClick={() => setApprovalFilter((prev) => (prev === '1' ? '' : '1'))}
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

          <button
            type="button"
            onClick={() => setApprovalFilter((prev) => (prev === '0' ? '' : '0'))}
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
                    onClick={() => setStatusFilter((prev) => (prev === st ? '' : st))}
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
        {/* 2ペイン領域（左: 売上月別一覧 / 右: 固定列幅テーブル） */}
        {/* ========================================================= */}
        <div className="flex-1 min-h-[440px] flex flex-col lg:flex-row gap-3 lg:overflow-hidden">
          {/* 1. 左サイドバー: 売上月別一覧 */}
          <aside className="w-full lg:w-[300px] bg-white rounded-xl border-2 border-[#9999FF] shadow-2xs flex flex-col shrink-0 overflow-hidden max-h-72 lg:max-h-none lg:h-full">
            <div className="h-10 bg-gradient-to-r from-[#2B2B80] via-[#333399] to-[#2B2B80] border-b border-[#19194D] px-2 flex items-center justify-between shrink-0 gap-1">
              <button
                type="button"
                onClick={() => void handleChangeYear(selectedYear - 1)}
                disabled={loading}
                title="前年へ"
                className="h-7 px-2 rounded-md bg-gradient-to-b from-white via-[#F0F0FF] to-[#CCCCFF] hover:from-white hover:to-[#B3B3FF] text-[#1F1F5C] font-black text-[11px] border border-white/90 shadow-[inset_0_1px_0_rgba(255,255,255,0.9),0_1px_3px_rgba(0,0,0,0.25)] cursor-pointer transition active:translate-y-px disabled:opacity-50 shrink-0"
              >
                ◀ 前年
              </button>
              <div className="flex items-center gap-1 text-white font-mono font-black text-xs xl:text-sm tracking-tight">
                <span>📅</span>
                <span>{selectedYear}年</span>
              </div>
              <button
                type="button"
                onClick={() => void handleChangeYear(selectedYear + 1)}
                disabled={loading}
                title="翌年へ"
                className="h-7 px-2 rounded-md bg-gradient-to-b from-white via-[#F0F0FF] to-[#CCCCFF] hover:from-white hover:to-[#B3B3FF] text-[#1F1F5C] font-black text-[11px] border border-white/90 shadow-[inset_0_1px_0_rgba(255,255,255,0.9),0_1px_3px_rgba(0,0,0,0.25)] cursor-pointer transition active:translate-y-px disabled:opacity-50 shrink-0"
              >
                翌年 ▶
              </button>
            </div>

            <div className="flex-1 min-h-0 overflow-y-auto p-1.5 space-y-1">
              <button
                type="button"
                onClick={() => setSelectedMonth(null)}
                className={`w-full text-left p-2 rounded-lg transition border-2 flex flex-col justify-between cursor-pointer ${
                  selectedMonth === null
                    ? 'bg-[#CCCCFF]/85 border-[#7878FF] shadow-xs'
                    : 'bg-[#F5F5FF] border-[#CCCCFF] hover:bg-[#E6E6FF] hover:border-[#9999FF]'
                }`}
              >
                <div className="flex items-center justify-between gap-1">
                  <span className="font-black text-xs text-[#1F1F5C] whitespace-nowrap">
                    📊 {selectedYear}年 通年合計
                  </span>
                  <span className="px-2 py-0.5 rounded-full font-mono text-[10px] font-black bg-[#333399] text-white shrink-0 whitespace-nowrap">
                    全 {annualSummary.count}件
                  </span>
                </div>
                <div className="mt-1 flex items-center justify-between text-[11px] font-mono">
                  <span className="text-[10px] font-sans font-bold text-[#4D4DB3] whitespace-nowrap">
                    {annualSummary.pendingCount > 0
                      ? `未承認 ${annualSummary.pendingCount}件`
                      : `承認済 ${annualSummary.approvedCount}件`}
                  </span>
                  <span className="font-black text-xs text-[#19194D] tabular-nums whitespace-nowrap">
                    {formatAmount(annualSummary.totalAmount)}
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
                      className={`w-full text-left px-2 py-1.5 rounded-lg transition border flex items-center justify-between gap-1.5 cursor-pointer ${
                        isSelected
                          ? 'bg-[#CCCCFF]/80 border-[#7878FF] shadow-2xs ring-1 ring-[#7878FF]/40'
                          : isEmpty
                            ? 'bg-white border-transparent opacity-60 hover:opacity-100 hover:bg-[#F5F5FF] hover:border-[#D6D6FF]'
                            : 'bg-white border-transparent hover:bg-[#F0F0FF] hover:border-[#CCCCFF]'
                      }`}
                    >
                      <div className="flex items-center gap-1.5 min-w-0 shrink-0">
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
                        <span className="font-mono font-black text-xs text-[#1F1F5C] whitespace-nowrap shrink-0">
                          {bucket.label}
                        </span>
                        {bucket.pendingCount > 0 && (
                          <span className="text-[10px] font-sans font-bold text-[#C00000] whitespace-nowrap shrink-0">
                            未{bucket.pendingCount}
                          </span>
                        )}
                      </div>

                      <div className="flex items-center gap-1.5 shrink-0">
                        <span
                          className={`px-2 py-0.5 rounded-full font-mono text-[10px] font-bold border whitespace-nowrap shrink-0 ${
                            bucket.count > 0
                              ? 'bg-[#E6E6FF] text-[#1F1F5C] border-[#9999FF]'
                              : 'bg-[#F5F5FF] text-[#666699] border-[#D6D6FF]'
                          }`}
                        >
                          {bucket.count}件
                        </span>
                        <span
                          className={`font-mono font-black text-xs tabular-nums min-w-[96px] text-right whitespace-nowrap shrink-0 ${
                            bucket.totalAmount > 0 ? 'text-[#19194D]' : 'text-[#666699]'
                          }`}
                        >
                          {formatAmount(bucket.totalAmount)}
                        </span>
                      </div>
                    </button>
                  );
                })}
              </div>
            </div>

            <div className="p-2 border-t-2 border-[#7878FF] bg-gradient-to-r from-[#C2C2FF] via-[#D6D6FF] to-[#C2C2FF] text-xs font-mono flex items-center justify-between shrink-0 text-[#1F1F5C]">
              <span className="text-[10px] font-sans font-bold truncate">
                {periodScopeLabel}（{displayedItems.length}件）
              </span>
              <span className="font-black text-xs tabular-nums shrink-0 whitespace-nowrap">
                {formatAmount(annualSummary.totalAmount)}
              </span>
            </div>
          </aside>

          {/* 2. 右メインパネル: 固定列幅＋件名列可変伸縮テーブル */}
          <div className="flex-1 min-w-0 min-h-0 bg-white rounded-xl border-2 border-[#9999FF] shadow-2xs overflow-hidden flex flex-col">
            <div className="flex-1 min-h-0 overflow-auto">
              <table className="w-full h-full table-fixed min-w-[984px] text-left border-collapse text-xs">
                <colgroup>
                  <col className="w-[32px]" />
                  <col className="w-[72px]" />
                  <col className="w-[98px]" />
                  <col className="w-[84px]" />
                  <col className="w-[64px]" />
                  <col className="w-[126px]" />
                  <col />
                  <col className="w-[110px]" />
                  <col className="w-[106px]" />
                  <col className="w-[112px]" />
                  <col className="w-[38px]" />
                </colgroup>
                <thead className="sticky top-0 z-20 shadow-[0_1px_0_0_rgba(120,120,255,0.4)]">
                  <tr className="h-9 bg-gradient-to-r from-[#CCCCFF] via-[#DDDDFF] to-[#CCCCFF] border-b-2 border-[#7878FF] text-[#1F1F5C] font-black text-xs select-none">
                    <th className="h-9 px-1 text-center">
                      <input
                        type="checkbox"
                        aria-label="未請求伝票を全選択"
                        onChange={toggleSelectAllUnbilled}
                        checked={selectableCount > 0 && selectedIds.length === selectableCount}
                        title="未請求伝票を全選択"
                        className="cursor-pointer accent-[#5252CC]"
                      />
                    </th>
                    <th className="h-9 py-1 px-1 text-center whitespace-nowrap overflow-hidden">
                      🔢 伝票No
                    </th>
                    <th className="h-9 py-1 px-1 text-center whitespace-nowrap overflow-hidden">
                      📅 売上日
                    </th>
                    <th className="h-9 py-1 px-1 text-center whitespace-nowrap overflow-hidden">
                      🏷️ ステータス
                    </th>
                    <th className="h-9 py-1 px-1 text-center whitespace-nowrap overflow-hidden">
                      ✅ 承認
                    </th>
                    <th className="h-9 py-1 px-2 text-left whitespace-nowrap overflow-hidden">
                      🏢 取引先
                    </th>
                    <th className="h-9 py-1 px-2.5 text-left whitespace-nowrap overflow-hidden">
                      📝 件名 / 案件
                    </th>
                    <th className="h-9 py-1 px-1.5 text-right whitespace-nowrap overflow-hidden">
                      💴 税抜金額
                    </th>
                    <th className="h-9 py-1 px-1.5 text-right whitespace-nowrap overflow-hidden">
                      🧾 消費税
                    </th>
                    <th className="h-9 py-1 px-1.5 text-right whitespace-nowrap overflow-hidden">
                      💰 税込合計
                    </th>
                    <th className="h-9 py-1 px-1 text-center whitespace-nowrap overflow-hidden">
                      🗑️
                    </th>
                  </tr>
                </thead>

                <tbody className="divide-y divide-[#D6D6FF] font-sans">
                  {displayedItems.length === 0 ? (
                    <tr>
                      <td colSpan={11} className="px-6 py-16 text-center bg-white">
                        <div className="flex flex-col items-center justify-center gap-2.5">
                          <span className="text-3xl">🧾</span>
                          <p className="text-sm font-black text-[#1F1F5C]">
                            {periodScopeLabel} に一致する売上伝票がありません
                          </p>
                          <p className="text-xs text-[#666699]">
                            左の月別一覧・年切替または上のリアルタイム検索条件を変更してください。
                          </p>
                          <Link
                            href="/sales/new?entryType=SALE"
                            className="mt-1 h-8 px-4 rounded-lg bg-gradient-to-b from-[#7878FF] to-[#5252CC] text-white text-xs font-bold inline-flex items-center gap-1 shadow-xs"
                          >
                            ＋ 新規売上発行
                          </Link>
                        </div>
                      </td>
                    </tr>
                  ) : (
                    <>
                      {displayedItems.map((item, idx) => {
                        const isBilled = item.status === 'K4' || item.status === 'K5';
                        const zebraClass = idx % 2 === 0 ? 'bg-white' : 'bg-[#F5F5FF]';
                        const canDelete =
                          !isBilled &&
                          item.deliveryNoteCount === 0 &&
                          item.deliveryReceiptCount === 0;
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
                            className={`h-10 ${zebraClass} hover:bg-[#D6D6FF]/65 transition-colors cursor-pointer group`}
                          >
                            <td className="h-10 px-1 text-center">
                              <input
                                type="checkbox"
                                disabled={isBilled}
                                checked={selectedIds.includes(item.id)}
                                onChange={() => toggleRowSelect(item.id)}
                                className="cursor-pointer disabled:cursor-not-allowed accent-[#5252CC]"
                              />
                            </td>
                            <td className="h-10 py-1 px-1 text-center font-mono font-black text-[#333399] whitespace-nowrap overflow-hidden">
                              <Link
                                href={`/sales/${item.id}`}
                                className="hover:text-[#5252CC] hover:underline"
                              >
                                #{item.slipNo}
                              </Link>
                            </td>
                            <td className="h-10 py-1 px-1 text-center font-mono text-xs text-[#1F1F5C] whitespace-nowrap overflow-hidden">
                              {item.slipDate.replace(/-/g, '/')}
                            </td>
                            <td className="h-10 py-1 px-1 text-center whitespace-nowrap overflow-hidden">
                              <span
                                className={`inline-flex px-1.5 py-0.5 rounded-full text-[11px] font-bold border ${
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
                            <td className="h-10 py-1 px-1 text-center whitespace-nowrap overflow-hidden">
                              <span
                                className={`inline-flex px-1.5 py-0.5 rounded-full text-[11px] font-bold ${
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
                            <td className="h-10 py-1 px-2 text-[#1F1F5C] overflow-hidden">
                              <div className="flex flex-col justify-center h-8 overflow-hidden">
                                <div
                                  title={item.partnerName}
                                  className="font-bold text-xs leading-4 h-4 truncate w-full shrink-0"
                                >
                                  {item.partnerName}
                                </div>
                                <div className="mt-0.5 text-[10px] leading-3.5 h-3.5 font-mono text-[#7575A3] truncate shrink-0">
                                  {item.partnerCode}
                                </div>
                              </div>
                            </td>
                            <td className="h-10 py-1 px-2.5 text-[#1F1F5C] overflow-hidden">
                              <div className="flex flex-col justify-center h-8 overflow-hidden">
                                <Link
                                  href={`/sales/${item.id}`}
                                  title={item.slipName !== '' ? item.slipName : '（件名なし）'}
                                  className="font-bold text-xs leading-4 h-4 text-[#1F1F5C] group-hover:text-[#5252CC] hover:underline block truncate w-full shrink-0"
                                >
                                  {item.slipName !== '' ? item.slipName : '（件名なし）'}
                                </Link>
                                {item.projectName !== null && (
                                  <div
                                    title={`工事 #${item.projectNo}: ${item.projectName}`}
                                    className="mt-0.5 text-[10px] leading-3.5 h-3.5 font-normal text-[#7575A3] truncate w-full shrink-0"
                                  >
                                    工事 #{item.projectNo}: {item.projectName}
                                  </div>
                                )}
                              </div>
                            </td>
                            <td className="h-10 py-1 px-1.5 text-right font-mono tabular-nums text-xs text-[#333366] whitespace-nowrap overflow-hidden">
                              {formatAmount(item.subtotalAmount)}
                            </td>
                            <td className="h-10 py-1 px-1.5 text-right font-mono tabular-nums text-xs text-[#4D4DB3] whitespace-nowrap overflow-hidden">
                              {formatAmount(item.taxTotal)}
                            </td>
                            <td className="h-10 py-1 px-1.5 text-right font-mono tabular-nums text-xs font-black text-[#19194D] whitespace-nowrap overflow-hidden">
                              {formatAmount(item.totalAmount)}
                            </td>
                            <td className="h-10 py-1 px-1 text-center whitespace-nowrap">
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

                <tfoot className="sticky bottom-0 z-20 shadow-[0_-1px_0_0_rgba(120,120,255,0.45)]">
                  <tr className="h-9 bg-gradient-to-r from-[#C2C2FF] via-[#D6D6FF] to-[#C2C2FF] font-black text-[#1F1F5C] border-t-2 border-[#7878FF] text-xs">
                    <td
                      colSpan={2}
                      className="h-9 py-1 px-2 text-center whitespace-nowrap overflow-hidden font-mono"
                    >
                      表示 {displayedItems.length} 件
                    </td>
                    <td
                      colSpan={5}
                      className="h-9 py-1 px-3 text-left text-[11px] font-bold text-[#1F1F5C] truncate"
                    >
                      {periodScopeLabel} 合計{hasActiveFilters ? '（条件絞込適用中）' : ''}
                    </td>
                    <td className="h-9 py-1 px-1.5 text-right font-mono tabular-nums whitespace-nowrap overflow-hidden">
                      {formatAmount(displayedTotals.subtotal)}
                    </td>
                    <td className="h-9 py-1 px-1.5 text-right font-mono tabular-nums whitespace-nowrap overflow-hidden text-[#333399]">
                      {formatAmount(displayedTotals.tax)}
                    </td>
                    <td className="h-9 py-1 px-1.5 text-right font-mono tabular-nums font-black whitespace-nowrap overflow-hidden text-[#19194D]">
                      {formatAmount(displayedTotals.total)}
                    </td>
                    <td className="h-9 py-1 px-1 text-center font-mono text-[10px] text-[#333399]">
                      Total
                    </td>
                  </tr>
                </tfoot>
              </table>
            </div>

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
      </div>
    </div>
  );
}
