'use client';

import { useMemo, useState } from 'react';
import { requestMasterApi } from '@/lib/masters/client-api';
import {
  ENTRY_TYPE_LABELS,
  type SalesEditorLookupsDto,
  type SalesEntryType,
  type SalesProductSummaryResultDto,
} from '@/lib/sales/types';

interface SalesSummaryClientProps {
  lookups: SalesEditorLookupsDto;
  initialProductSummary: SalesProductSummaryResultDto;
}

function formatAmount(amount: number): string {
  return amount.toLocaleString('ja-JP');
}

function formatQty(qty: number): string {
  if (Number.isInteger(qty)) return qty.toLocaleString('ja-JP');
  return qty.toFixed(4).replace(/0+$/, '').replace(/\.$/, '');
}

export default function SalesSummaryClient({
  lookups,
  initialProductSummary,
}: SalesSummaryClientProps) {
  const [summaryData, setSummaryData] =
    useState<SalesProductSummaryResultDto>(initialProductSummary);
  const [sumEntryFilter, setSumEntryFilter] = useState<'ALL' | SalesEntryType>('ALL');
  const [sumPartnerId, setSumPartnerId] = useState('');
  const [sumDateFrom, setSumDateFrom] = useState('');
  const [sumDateTo, setSumDateTo] = useState('');
  const [sumKeyword, setSumKeyword] = useState('');

  const [loading, setLoading] = useState(false);
  const [bannerError, setBannerError] = useState<string | null>(null);

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

  function handleResetFilters() {
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

  const displayedItems = useMemo(() => {
    const kw = sumKeyword.trim().toLowerCase();
    if (kw === '') return summaryData.items;
    return summaryData.items.filter((row) => {
      const codeMatch = row.itemCode !== null && row.itemCode.toLowerCase().includes(kw);
      const nameMatch = row.itemName.toLowerCase().includes(kw);
      return codeMatch || nameMatch;
    });
  }, [summaryData.items, sumKeyword]);

  const displayedTotals = useMemo(() => {
    let exclAmount = 0;
    let taxAmount = 0;
    let inclAmount = 0;
    for (const row of displayedItems) {
      exclAmount += row.exclAmount;
      taxAmount += row.taxAmount;
      inclAmount += row.inclAmount;
    }
    return {
      rowCount: displayedItems.length,
      exclAmount,
      taxAmount,
      inclAmount,
    };
  }, [displayedItems]);

  const hasActiveFilters =
    sumEntryFilter !== 'ALL' ||
    sumPartnerId !== '' ||
    sumDateFrom !== '' ||
    sumDateTo !== '' ||
    sumKeyword !== '';

  function getExportUrl(format: 'csv' | 'pdf'): string {
    const params = buildSummaryQuery();
    if (sumKeyword.trim() !== '') params.set('q', sumKeyword.trim());
    params.set('kind', 'PRODUCT_SUMMARY');
    params.set('format', format);
    return `/api/v1/sales/export?${params.toString()}`;
  }

  return (
    <div className="-m-6 min-h-[calc(100vh-3.5rem)] lg:h-[calc(100vh-3.5rem)] flex flex-col bg-[#F0F0FF] text-[#1F1F5C] antialiased lg:overflow-hidden select-none">
      {/* 画面トップバー（商品別売上・立替集計専用・タブなし） */}
      <header className="h-14 bg-white border-b-2 border-[#9999FF] px-4 sm:px-6 flex items-center justify-between gap-3 shrink-0 shadow-2xs z-20">
        <div className="flex items-center gap-2.5 min-w-0">
          <span className="inline-flex h-8 w-8 items-center justify-center rounded-lg bg-gradient-to-b from-[#9999FF] via-[#7878FF] to-[#333399] text-white text-sm shadow-2xs shrink-0">
            📊
          </span>
          <h1 className="text-base sm:text-lg font-black text-[#1F1F5C] tracking-tight truncate">
            商品別売上・立替集計
          </h1>
          <span className="hidden sm:inline-flex items-center px-2.5 py-0.5 rounded-full text-[11px] font-bold bg-[#CCCCFF] text-[#1F1F5C] border border-[#9999FF] shrink-0">
            PRODUCT SUMMARY
          </span>
        </div>

        <div className="flex items-center gap-2 shrink-0">
          <a
            href={getExportUrl('csv')}
            className="h-8 px-3.5 rounded-lg bg-gradient-to-b from-white via-[#F0F0FF] to-[#CCCCFF] hover:to-[#B3B3FF] text-[#333399] border border-[#9999FF] shadow-2xs text-xs font-bold inline-flex items-center gap-1 transition"
          >
            <span>集計CSV出力</span>
          </a>
          <a
            href={getExportUrl('pdf')}
            target="_blank"
            rel="noopener noreferrer"
            className="h-8 px-3.5 rounded-lg bg-gradient-to-b from-white via-[#F0F0FF] to-[#CCCCFF] hover:to-[#B3B3FF] text-[#333399] border border-[#9999FF] shadow-2xs text-xs font-bold inline-flex items-center gap-1 transition"
          >
            <span>商品別集計PDF</span>
          </a>
        </div>
      </header>

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

        {/* KPI サマリカード */}
        <div className="grid grid-cols-2 md:grid-cols-4 gap-3 shrink-0">
          <div className="bg-gradient-to-br from-[#19194D] via-[#2B2B80] to-[#4747B3] rounded-xl px-4 py-3 text-white border-2 border-[#9999FF] shadow-sm flex flex-col justify-between">
            <div className="flex items-center justify-between text-xs font-bold text-[#CCCCFF]">
              <span>💰 税込金額合計</span>
              <span className="px-2 py-0.5 rounded-full bg-[#7878FF]/45 text-[10px] font-mono">
                SUMMARY
              </span>
            </div>
            <div className="mt-1.5 text-2xl font-black font-mono tabular-nums text-white">
              {formatAmount(displayedTotals.inclAmount)}
            </div>
            <div className="mt-1 text-[11px] text-[#B3B3FF] font-mono">
              集計品目: {displayedTotals.rowCount} 件
            </div>
          </div>

          <div className="bg-white rounded-xl px-4 py-3 border-2 border-[#B3B3FF] text-[#1F1F5C] shadow-2xs flex flex-col justify-between">
            <div className="text-xs font-bold text-[#4D4DB3]">📦 集計品目数</div>
            <div className="mt-1.5 text-2xl font-black font-mono tabular-nums text-[#1F1F5C]">
              {displayedTotals.rowCount}{' '}
              <span className="text-xs font-sans font-bold text-[#666699]">品目</span>
            </div>
            <div className="mt-1 text-[11px] text-[#666699] font-mono">商品別グルーピング</div>
          </div>

          <div className="bg-white rounded-xl px-4 py-3 border-2 border-[#B3B3FF] text-[#1F1F5C] shadow-2xs flex flex-col justify-between">
            <div className="text-xs font-bold text-[#4D4DB3]">💴 税抜金額合計</div>
            <div className="mt-1.5 text-2xl font-black font-mono tabular-nums text-[#1F1F5C]">
              {formatAmount(displayedTotals.exclAmount)}
            </div>
            <div className="mt-1 text-[11px] text-[#666699] font-mono">純売上合計</div>
          </div>

          <div className="bg-white rounded-xl px-4 py-3 border-2 border-[#B3B3FF] text-[#1F1F5C] shadow-2xs flex flex-col justify-between">
            <div className="text-xs font-bold text-[#4D4DB3]">🧾 消費税額合計</div>
            <div className="mt-1.5 text-2xl font-black font-mono tabular-nums text-[#1F1F5C]">
              {formatAmount(displayedTotals.taxAmount)}
            </div>
            <div className="mt-1 text-[11px] text-[#666699] font-mono">内訳税額合算</div>
          </div>
        </div>

        {/* コントロールバー */}
        <div className="relative bg-white pl-4 pr-3.5 py-2 rounded-xl border-2 border-[#9999FF] shadow-2xs flex flex-wrap items-center justify-between gap-2.5 shrink-0 min-h-[50px]">
          <div className="absolute left-0 top-0 bottom-0 w-1.5 bg-[#7878FF] rounded-l-xl" />
          <div className="flex flex-wrap items-center gap-2.5">
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
            {hasActiveFilters && (
              <button
                type="button"
                onClick={handleResetFilters}
                disabled={loading}
                className="h-7 px-2.5 rounded-md border border-[#9999FF] bg-white hover:bg-[#E6E6FF] text-[11px] font-bold text-[#333399] cursor-pointer"
              >
                条件解除
              </button>
            )}
            <span className="px-2.5 py-1 rounded-full text-[11px] font-mono font-black bg-[#CCCCFF] text-[#1F1F5C] border border-[#7878FF]">
              計 {displayedTotals.rowCount} 品目
            </span>
          </div>
        </div>

        {/* 集計テーブル */}
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
                {displayedItems.length === 0 ? (
                  <tr>
                    <td colSpan={10} className="px-4 py-14 text-center text-sm text-[#666699] bg-white">
                      該当する集計データがありません。
                    </td>
                  </tr>
                ) : (
                  <>
                    {displayedItems.map((row, idx) => (
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
                          {formatAmount(row.exclAmount)}
                        </td>
                        <td className="h-9 px-3 text-right font-mono tabular-nums text-xs text-[#4D4DB3]">
                          {formatAmount(row.taxAmount)}
                        </td>
                        <td className="h-9 px-3 text-right font-mono tabular-nums text-xs font-black text-[#19194D]">
                          {formatAmount(row.inclAmount)}
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
                    商品別集計合計（全 {displayedTotals.rowCount} 品目）
                  </td>
                  <td className="h-9 px-3 text-right font-mono tabular-nums">
                    {formatAmount(displayedTotals.exclAmount)}
                  </td>
                  <td className="h-9 px-3 text-right font-mono tabular-nums text-[#333399]">
                    {formatAmount(displayedTotals.taxAmount)}
                  </td>
                  <td className="h-9 px-3 text-right font-mono tabular-nums font-black text-[#19194D]">
                    {formatAmount(displayedTotals.inclAmount)}
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
              表示中: {displayedTotals.rowCount} 品目
            </span>
          </div>
        </div>
      </div>
    </div>
  );
}
