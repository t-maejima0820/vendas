'use client';

import Link from 'next/link';
import { useState } from 'react';
import {
  BILLING_DOCUMENT_TYPE_LABELS,
  RECEIVABLE_STATUS_LABELS,
  STANDARD_BILLING_DOCUMENT_TYPES,
  type BillingCandidateListResultDto,
  type BillingCandidatePartnerGroupDto,
  type BillingDocumentType,
  type BillingExportTarget,
  type BillingListItemDto,
  type BillingLookupsDto,
  type BillingPageDto,
  type ConfirmBillingItemInput,
  type ReceivableStatus,
} from '@/lib/billing/types';
import { computePageCount, type QuotationTemplateVariant } from '@/lib/estimates/types';
import { requestMasterApi } from '@/lib/masters/client-api';
import {
  APPROVAL_STATUS_LABELS,
  ENTRY_TYPE_LABELS,
  SALES_STATUS_LABELS,
} from '@/lib/sales/types';

interface BillingListClientProps {
  initialTab: 'CANDIDATES' | 'ISSUED';
  defaultBillingDate: string;
  lookups: BillingLookupsDto;
  initialCandidates: BillingCandidateListResultDto | null;
  initialBillings: BillingPageDto;
}

function formatYen(amount: number): string {
  return `¥${amount.toLocaleString('ja-JP')}`;
}

export default function BillingListClient({
  initialTab,
  defaultBillingDate,
  lookups,
  initialCandidates,
  initialBillings,
}: BillingListClientProps) {
  const canCandidates = lookups.billsummaryEnabled || lookups.billissueEnabled;
  const [activeTab, setActiveTab] = useState<'CANDIDATES' | 'ISSUED'>(
    initialTab === 'CANDIDATES' && !canCandidates ? 'ISSUED' : initialTab,
  );

  // 候補集計タブ状態
  const [candidatesData, setCandidatesData] = useState<BillingCandidateListResultDto | null>(
    initialCandidates,
  );
  const [candDateFrom, setCandDateFrom] = useState('');
  const [candDateTo, setCandDateTo] = useState('');
  const [candClosingDay, setCandClosingDay] = useState('');
  const [candPartnerId, setCandPartnerId] = useState('');
  const [candKeyword, setCandKeyword] = useState('');

  // 請求確定パラメータ
  const [billingDate, setBillingDate] = useState(defaultBillingDate);
  const [docType, setDocType] = useState<BillingDocumentType>('INVOICE');
  const [templateVariant, setTemplateVariant] = useState<QuotationTemplateVariant>(
    lookups.quotationTemplateRows,
  );
  const [issueCoverDetail, setIssueCoverDetail] = useState(true);
  const [allowUnapproved, setAllowUnapproved] = useState(false);

  // 取引先グループ別選択伝票・個別支払期限マップ
  const [selectedSlipIdsByPartner, setSelectedSlipIdsByPartner] = useState<
    Record<string, string[]>
  >(() => {
    const map: Record<string, string[]> = {};
    if (initialCandidates !== null) {
      for (const g of initialCandidates.groups) {
        map[g.partnerId] = g.slips.map((s) => s.id);
      }
    }
    return map;
  });
  const [dueDateByPartner, setDueDateByPartner] = useState<Record<string, string>>(() => {
    const map: Record<string, string> = {};
    if (initialCandidates !== null) {
      for (const g of initialCandidates.groups) {
        map[g.partnerId] = g.proposedPaymentDueDate;
      }
    }
    return map;
  });
  const [selectedPartnerIds, setSelectedPartnerIds] = useState<string[]>([]);

  // 発行済請求一覧タブ状態
  const [issuedData, setIssuedData] = useState<BillingPageDto>(initialBillings);
  const [issKw, setIssKw] = useState('');
  const [issPartnerId, setIssPartnerId] = useState('');
  const [issStatus, setIssStatus] = useState<'' | ReceivableStatus>('');
  const [issSubKind, setIssSubKind] = useState<'ALL' | 'STANDARD' | 'SUBSCRIPTION'>('ALL');
  const [issDateFrom, setIssDateFrom] = useState('');
  const [issDateTo, setIssDateTo] = useState('');
  const [exportTarget, setExportTarget] = useState<BillingExportTarget>('standard');

  const [previewSnapshotId, setPreviewSnapshotId] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [bannerError, setBannerError] = useState<string | null>(null);
  const [bannerSuccess, setBannerSuccess] = useState<string | null>(null);

  async function reloadCandidates() {
    if (!canCandidates) return;
    setLoading(true);
    setBannerError(null);
    const params = new URLSearchParams();
    if (candDateFrom !== '') params.set('dateFrom', candDateFrom);
    if (candDateTo !== '') params.set('dateTo', candDateTo);
    if (candClosingDay !== '') params.set('closingDayCode', candClosingDay);
    if (candPartnerId !== '') params.set('partnerId', candPartnerId);
    if (candKeyword.trim() !== '') params.set('q', candKeyword.trim());

    const res = await requestMasterApi<BillingCandidateListResultDto>(
      `/api/v1/billing/candidates?${params.toString()}`,
    );
    setLoading(false);
    if (!res.ok) {
      setBannerError(res.error);
      return;
    }

    const nextSlipMap: Record<string, string[]> = {};
    const nextDueMap: Record<string, string> = {};
    for (const g of res.data.groups) {
      nextSlipMap[g.partnerId] = g.slips.map((s) => s.id);
      nextDueMap[g.partnerId] = g.proposedPaymentDueDate;
    }
    setSelectedSlipIdsByPartner(nextSlipMap);
    setDueDateByPartner(nextDueMap);
    setSelectedPartnerIds([]);
    setCandidatesData(res.data);
  }

  function buildIssuedFilterParams(page: number): URLSearchParams {
    const params = new URLSearchParams();
    params.set('page', String(page));
    params.set('pageSize', String(issuedData.pageSize));
    if (issKw.trim() !== '') params.set('q', issKw.trim());
    if (issPartnerId !== '') params.set('partnerId', issPartnerId);
    if (issStatus !== '') params.set('status', issStatus);
    if (issSubKind !== 'ALL') params.set('isSubscription', issSubKind);
    if (issDateFrom !== '') params.set('dateFrom', issDateFrom);
    if (issDateTo !== '') params.set('dateTo', issDateTo);
    return params;
  }

  async function reloadIssuedBillings(page: number = 1) {
    setLoading(true);
    setBannerError(null);
    const params = buildIssuedFilterParams(page);
    const res = await requestMasterApi<BillingPageDto>(`/api/v1/billing?${params.toString()}`);
    setLoading(false);
    if (!res.ok) {
      setBannerError(res.error);
      return;
    }
    setIssuedData({
      items: res.data.items,
      summary: res.data.summary,
      page: res.data.page,
      pageSize: res.data.pageSize,
    });
  }

  async function handleToggleSlipStatus(slipIds: string[], targetStatus: 'K2' | 'K3') {
    setBannerError(null);
    setBannerSuccess(null);
    setSaving(true);
    const res = await requestMasterApi<{ updatedCount: number }>('/api/v1/billing/candidates', {
      method: 'PATCH',
      body: JSON.stringify({ slipIds, targetStatus }),
    });
    setSaving(false);
    if (!res.ok) {
      setBannerError(res.error);
      return;
    }
    setBannerSuccess(
      `${res.data.updatedCount}件の伝票ステータスを「${SALES_STATUS_LABELS[targetStatus]}」へ更新しました。`,
    );
    await reloadCandidates();
  }

  async function handleConfirmGroups(groups: BillingCandidatePartnerGroupDto[]) {
    setBannerError(null);
    setBannerSuccess(null);

    const items: ConfirmBillingItemInput[] = [];
    for (const g of groups) {
      const selected = selectedSlipIdsByPartner[g.partnerId];
      const slipIds = selected !== undefined ? selected : [];
      if (slipIds.length === 0) {
        setBannerError(`${g.partnerName} の対象伝票を1件以上選択してください。`);
        return;
      }
      const dueRaw = dueDateByPartner[g.partnerId];
      items.push({
        partnerId: g.partnerId,
        slipIds,
        paymentDueDate: dueRaw !== undefined && dueRaw !== '' ? dueRaw : g.proposedPaymentDueDate,
        documentType: docType,
        templateVariant,
        issueCoverDetail,
      });
    }

    if (items.length === 0) {
      setBannerError('請求確定対象の取引先を選択してください。');
      return;
    }

    setSaving(true);
    const res = await requestMasterApi<{ billings: BillingListItemDto[] }>('/api/v1/billing', {
      method: 'POST',
      body: JSON.stringify({
        billingDate,
        targetPeriodStart: candDateFrom !== '' ? candDateFrom : null,
        targetPeriodEnd: candDateTo !== '' ? candDateTo : null,
        allowUnapproved,
        items,
      }),
    });
    setSaving(false);
    if (!res.ok) {
      setBannerError(res.error);
      return;
    }
    setBannerSuccess(
      `請求書 ${res.data.billings.length}件 を確定し、初回スナップショット（v1）を発行しました。`,
    );
    await Promise.all([reloadCandidates(), reloadIssuedBillings(1)]);
  }

  function togglePartnerSelection(partnerId: string) {
    setSelectedPartnerIds((prev) =>
      prev.includes(partnerId) ? prev.filter((id) => id !== partnerId) : [...prev, partnerId],
    );
  }

  function toggleSlipSelection(partnerId: string, slipId: string) {
    setSelectedSlipIdsByPartner((prev) => {
      const cur = prev[partnerId] !== undefined ? prev[partnerId] : [];
      const next = cur.includes(slipId) ? cur.filter((id) => id !== slipId) : [...cur, slipId];
      return { ...prev, [partnerId]: next };
    });
  }

  function buildExportUrl(format: 'csv' | 'pdf'): string {
    const params = buildIssuedFilterParams(1);
    params.set('target', exportTarget);
    params.set('format', format);
    return `/api/v1/billing/export?${params.toString()}`;
  }

  const totalIssuedPages = computePageCount(issuedData.summary.totalCount, issuedData.pageSize);

  return (
    <div className="max-w-7xl space-y-5">
      {/* ヘッダ */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold text-slate-900">請求集計 ＆ 請求書発行管理</h1>
          <p className="text-sm text-slate-600 mt-1">
            未請求伝票の取引先別集計・繰越残高計算・請求書確定（全6種）と、発行済み請求書の再発行・一覧出力を行います。
          </p>
        </div>

        <div className="flex items-center gap-2 text-xs text-slate-600">
          <span className="px-2.5 py-1 rounded bg-white border border-slate-200 font-mono">
            税方式: {lookups.taxCalcPolicy}
          </span>
          <span className="px-2.5 py-1 rounded bg-white border border-slate-200 font-mono">
            基準日: {lookups.openingBalanceDate}
          </span>
        </div>
      </div>

      {/* タブ */}
      <div className="flex items-center gap-2 border-b border-slate-200">
        {canCandidates && (
          <button
            type="button"
            onClick={() => setActiveTab('CANDIDATES')}
            className={`px-4 py-2.5 text-sm font-medium border-b-2 transition-colors cursor-pointer ${
              activeTab === 'CANDIDATES'
                ? 'border-blue-600 text-blue-700'
                : 'border-transparent text-slate-600 hover:text-slate-900'
            }`}
          >
            請求集計・新規発行（未請求候補）
          </button>
        )}
        <button
          type="button"
          onClick={() => {
            setActiveTab('ISSUED');
            void reloadIssuedBillings(1);
          }}
          className={`px-4 py-2.5 text-sm font-medium border-b-2 transition-colors cursor-pointer ${
            activeTab === 'ISSUED'
              ? 'border-blue-600 text-blue-700'
              : 'border-transparent text-slate-600 hover:text-slate-900'
          }`}
        >
          発行済請求一覧（{issuedData.summary.totalCount}件）
        </button>
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

      {activeTab === 'CANDIDATES' && candidatesData !== null ? (
        <div className="space-y-4">
          {/* 候補抽出サマリ */}
          <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
            <div className="rounded-xl bg-white border border-slate-200 p-4 shadow-xs">
              <div className="text-xs text-slate-500">未請求 取引先数</div>
              <div className="text-xl font-bold text-slate-900 mt-1 font-mono">
                {candidatesData.totals.partnerCount} 社
              </div>
            </div>
            <div className="rounded-xl bg-white border border-slate-200 p-4 shadow-xs">
              <div className="text-xs text-slate-500">未請求 伝票数</div>
              <div className="text-xl font-bold text-slate-900 mt-1 font-mono">
                {candidatesData.totals.slipCount} 件
              </div>
            </div>
            <div className="rounded-xl bg-white border border-slate-200 p-4 shadow-xs">
              <div className="text-xs text-slate-500">未承認 伝票数</div>
              <div className="text-xl font-bold text-amber-700 mt-1 font-mono">
                {candidatesData.totals.unapprovedSlipCount} 件
              </div>
            </div>
            <div className="rounded-xl bg-blue-50 border border-blue-200 p-4 shadow-xs">
              <div className="text-xs font-semibold text-blue-700">今回請求候補合計(税込)</div>
              <div className="text-xl font-bold text-blue-900 mt-1 font-mono">
                {formatYen(candidatesData.totals.currentBillingAmount)}
              </div>
            </div>
          </div>

          {/* 抽出フィルタ */}
          <form
            onSubmit={(e) => {
              e.preventDefault();
              void reloadCandidates();
            }}
            className="rounded-xl bg-white border border-slate-200 p-4 shadow-xs grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-6 gap-3"
          >
            <div>
              <label className="block text-xs font-medium text-slate-600 mb-1">売上日(From)</label>
              <input
                type="date"
                value={candDateFrom}
                onChange={(e) => setCandDateFrom(e.target.value)}
                className="w-full rounded-lg border border-slate-300 px-2.5 py-1.5 text-sm"
              />
            </div>
            <div>
              <label className="block text-xs font-medium text-slate-600 mb-1">売上日(To)</label>
              <input
                type="date"
                value={candDateTo}
                onChange={(e) => setCandDateTo(e.target.value)}
                className="w-full rounded-lg border border-slate-300 px-2.5 py-1.5 text-sm"
              />
            </div>
            <div>
              <label className="block text-xs font-medium text-slate-600 mb-1">締日区分</label>
              <select
                value={candClosingDay}
                onChange={(e) => setCandClosingDay(e.target.value)}
                className="w-full rounded-lg border border-slate-300 px-2.5 py-1.5 text-sm bg-white"
              >
                <option value="">すべて</option>
                {lookups.closingDays.map((cd) => (
                  <option key={cd.code} value={cd.code}>
                    {cd.code}: {cd.name}
                  </option>
                ))}
              </select>
            </div>
            <div>
              <label className="block text-xs font-medium text-slate-600 mb-1">取引先</label>
              <select
                value={candPartnerId}
                onChange={(e) => setCandPartnerId(e.target.value)}
                className="w-full rounded-lg border border-slate-300 px-2.5 py-1.5 text-sm bg-white"
              >
                <option value="">すべて</option>
                {lookups.partners.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.partnerCode} {p.partnerName}
                  </option>
                ))}
              </select>
            </div>
            <div>
              <label className="block text-xs font-medium text-slate-600 mb-1">キーワード</label>
              <input
                type="text"
                value={candKeyword}
                onChange={(e) => setCandKeyword(e.target.value)}
                placeholder="件名・伝票No・取引先"
                className="w-full rounded-lg border border-slate-300 px-2.5 py-1.5 text-sm"
              />
            </div>
            <div className="flex items-end">
              <button
                type="submit"
                disabled={loading}
                className="w-full rounded-lg bg-slate-800 hover:bg-slate-700 px-4 py-1.5 text-xs font-semibold text-white cursor-pointer"
              >
                {loading ? '検索中...' : '候補を再集計'}
              </button>
            </div>
          </form>

          {/* 請求確定オプションパネル */}
          {lookups.billissueEnabled && (
            <div className="rounded-xl border border-blue-200 bg-blue-50/70 p-4 shadow-xs space-y-3">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div className="text-sm font-bold text-blue-950">
                  請求書確定・発行設定（鏡集計・K4ロック・初回v1発行）
                </div>
                <span className="text-xs text-blue-800 font-mono">
                  繰越参照期間: {candidatesData.balancePeriodStart} 〜 {candidatesData.balancePeriodEnd}
                </span>
              </div>
              <div className="flex flex-wrap items-end gap-3">
                <div>
                  <label className="block text-xs font-medium text-blue-950 mb-1">請求日 *</label>
                  <input
                    type="date"
                    value={billingDate}
                    onChange={(e) => setBillingDate(e.target.value)}
                    className="rounded-lg border border-blue-300 bg-white px-2.5 py-1.5 text-sm"
                  />
                </div>
                <div>
                  <label className="block text-xs font-medium text-blue-950 mb-1">帳票種別</label>
                  <select
                    value={docType}
                    onChange={(e) => setDocType(e.target.value as BillingDocumentType)}
                    className="rounded-lg border border-blue-300 bg-white px-2.5 py-1.5 text-sm"
                  >
                    {STANDARD_BILLING_DOCUMENT_TYPES.map((dt) => (
                      <option key={dt} value={dt}>
                        {BILLING_DOCUMENT_TYPE_LABELS[dt]}
                      </option>
                    ))}
                  </select>
                </div>
                <div>
                  <label className="block text-xs font-medium text-blue-950 mb-1">明細枠</label>
                  <select
                    value={templateVariant}
                    onChange={(e) =>
                      setTemplateVariant(e.target.value as QuotationTemplateVariant)
                    }
                    className="rounded-lg border border-blue-300 bg-white px-2.5 py-1.5 text-sm"
                  >
                    <option value="10_ROWS">10行枠</option>
                    <option value="20_ROWS">20行枠</option>
                  </select>
                </div>
                {(docType === 'INVOICE_COVER' || docType === 'INVOICE_COVER_MEMO_SUM') && (
                  <label className="inline-flex items-center gap-1.5 text-xs text-blue-950 pb-2 cursor-pointer">
                    <input
                      type="checkbox"
                      checked={issueCoverDetail}
                      onChange={(e) => setIssueCoverDetail(e.target.checked)}
                    />
                    鏡明細（INVOICE_COVER_DETAIL）も同時発行
                  </label>
                )}
                {lookups.approvalFlowEnabled && lookups.allowBillingDateWarningSkip && (
                  <label className="inline-flex items-center gap-1.5 text-xs text-amber-900 pb-2 cursor-pointer">
                    <input
                      type="checkbox"
                      checked={allowUnapproved}
                      onChange={(e) => setAllowUnapproved(e.target.checked)}
                    />
                    未承認伝票を含めて確定を許可
                  </label>
                )}

                {selectedPartnerIds.length > 0 && (
                  <button
                    type="button"
                    disabled={saving}
                    onClick={() => {
                      const targets = candidatesData.groups.filter((g) =>
                        selectedPartnerIds.includes(g.partnerId),
                      );
                      void handleConfirmGroups(targets);
                    }}
                    className="ml-auto rounded-lg bg-blue-700 hover:bg-blue-800 disabled:opacity-60 px-4 py-2 text-xs font-semibold text-white cursor-pointer"
                  >
                    {saving
                      ? '請求確定中...'
                      : `選択した ${selectedPartnerIds.length} 社を一括請求確定`}
                  </button>
                )}
              </div>
            </div>
          )}

          {/* 取引先別 候補グループ一覧 */}
          {candidatesData.groups.length === 0 ? (
            <div className="rounded-xl bg-white border border-slate-200 p-8 text-center text-sm text-slate-500">
              条件に一致する未請求の売上・立替伝票はありません。
            </div>
          ) : (
            <div className="space-y-4">
              {candidatesData.groups.map((group) => {
                const rawSelectedSlips = selectedSlipIdsByPartner[group.partnerId];
                const selectedSlips: string[] =
                  rawSelectedSlips !== undefined ? rawSelectedSlips : [];
                const rawDueValue = dueDateByPartner[group.partnerId];
                const dueValue: string =
                  rawDueValue !== undefined ? rawDueValue : group.proposedPaymentDueDate;

                return (
                  <div
                    key={group.partnerId}
                    className="rounded-xl bg-white border border-slate-200 shadow-xs overflow-hidden"
                  >
                    <div className="px-4 py-3 bg-slate-50 border-b border-slate-200 flex flex-wrap items-center justify-between gap-3">
                      <div className="flex items-center gap-3">
                        <input
                          type="checkbox"
                          checked={selectedPartnerIds.includes(group.partnerId)}
                          onChange={() => togglePartnerSelection(group.partnerId)}
                        />
                        <div>
                          <div className="text-sm font-bold text-slate-900">
                            <span className="font-mono text-slate-400 mr-1.5">
                              {group.partnerCode}
                            </span>
                            {group.partnerName}
                          </div>
                          <div className="text-xs text-slate-500 flex flex-wrap gap-3 mt-0.5">
                            <span>
                              締日: {group.closingDayName !== null ? group.closingDayName : '-'}
                            </span>
                            <span>
                              対象: {group.slipCount}伝票（K3集計済: {group.aggregatedCount}件）
                            </span>
                            {group.unapprovedCount > 0 && (
                              <span className="text-amber-700 font-semibold">
                                未承認: {group.unapprovedCount}件
                              </span>
                            )}
                          </div>
                        </div>
                      </div>

                      <div className="flex flex-wrap items-center gap-2">
                        <div className="text-xs">
                          <span className="text-slate-500 mr-1">支払期限:</span>
                          <input
                            type="date"
                            value={dueValue}
                            onChange={(e) =>
                              setDueDateByPartner((prev) => ({
                                ...prev,
                                [group.partnerId]: e.target.value,
                              }))
                            }
                            className="rounded border border-slate-300 bg-white px-2 py-1 text-xs"
                          />
                        </div>
                        {lookups.billsummaryEnabled && (
                          <>
                            <button
                              type="button"
                              disabled={saving || selectedSlips.length === 0}
                              onClick={() => void handleToggleSlipStatus(selectedSlips, 'K3')}
                              className="rounded border border-slate-300 bg-white hover:bg-slate-100 px-2.5 py-1 text-xs font-medium text-slate-700 cursor-pointer"
                            >
                              K3(集計済)へ
                            </button>
                            <button
                              type="button"
                              disabled={saving || selectedSlips.length === 0}
                              onClick={() => void handleToggleSlipStatus(selectedSlips, 'K2')}
                              className="rounded border border-slate-300 bg-white hover:bg-slate-100 px-2.5 py-1 text-xs font-medium text-slate-700 cursor-pointer"
                            >
                              K2(請求待ち)へ
                            </button>
                          </>
                        )}
                        {lookups.billissueEnabled && (
                          <button
                            type="button"
                            disabled={saving || selectedSlips.length === 0}
                            onClick={() => void handleConfirmGroups([group])}
                            className="rounded-lg bg-blue-600 hover:bg-blue-700 disabled:opacity-60 px-3 py-1.5 text-xs font-semibold text-white cursor-pointer"
                          >
                            この取引先を請求確定
                          </button>
                        )}
                      </div>
                    </div>

                    {/* 繰越鏡プレビュー */}
                    <div className="grid grid-cols-2 sm:grid-cols-6 gap-2 px-4 py-2.5 bg-slate-50/50 border-b border-slate-200 text-xs">
                      <div>
                        <span className="text-slate-500 block">前回繰越</span>
                        <span className="font-mono font-semibold text-slate-800">
                          {formatYen(group.prevCarriedBalance)}
                        </span>
                      </div>
                      <div>
                        <span className="text-slate-500 block">当期入金額</span>
                        <span className="font-mono font-semibold text-emerald-700">
                          {formatYen(group.periodReceiptAmount)}
                        </span>
                      </div>
                      <div>
                        <span className="text-slate-500 block">差引繰越額</span>
                        <span className="font-mono font-semibold text-slate-800">
                          {formatYen(group.netCarriedBalance)}
                        </span>
                      </div>
                      <div>
                        <span className="text-slate-500 block">税端数調整額</span>
                        <span className="font-mono font-semibold text-slate-800">
                          {formatYen(group.taxAdjustmentAmount)}
                        </span>
                      </div>
                      <div>
                        <span className="text-slate-500 block">今回請求(税込)</span>
                        <span className="font-mono font-bold text-blue-800">
                          {formatYen(group.currentBillingAmount)}
                        </span>
                      </div>
                      <div>
                        <span className="text-slate-500 block">今回売掛残高</span>
                        <span className="font-mono font-bold text-slate-900">
                          {formatYen(group.closingArBalance)}
                        </span>
                      </div>
                    </div>

                    {/* 伝票明細テーブル */}
                    <div className="overflow-x-auto">
                      <table className="min-w-full divide-y divide-slate-200 text-xs">
                        <thead className="bg-slate-50 text-slate-600">
                          <tr>
                            <th className="px-3 py-2 text-center w-9">選択</th>
                            <th className="px-3 py-2 text-center">区分</th>
                            <th className="px-3 py-2 text-right">伝票No</th>
                            <th className="px-3 py-2 text-center">売上日</th>
                            <th className="px-3 py-2 text-left">件名</th>
                            <th className="px-3 py-2 text-center">状態</th>
                            <th className="px-3 py-2 text-center">承認</th>
                            <th className="px-3 py-2 text-right">税抜額</th>
                            <th className="px-3 py-2 text-right">消費税</th>
                            <th className="px-3 py-2 text-right">税込額</th>
                          </tr>
                        </thead>
                        <tbody className="divide-y divide-slate-100">
                          {group.slips.map((slip) => (
                            <tr key={slip.id} className="hover:bg-slate-50">
                              <td className="px-3 py-2 text-center">
                                <input
                                  type="checkbox"
                                  checked={selectedSlips.includes(slip.id)}
                                  onChange={() => toggleSlipSelection(group.partnerId, slip.id)}
                                />
                              </td>
                              <td className="px-3 py-2 text-center">
                                <span
                                  className={`px-1.5 py-0.5 rounded font-semibold ${
                                    slip.entryType === 'ADVANCE'
                                      ? 'bg-purple-100 text-purple-800'
                                      : 'bg-blue-100 text-blue-800'
                                  }`}
                                >
                                  {ENTRY_TYPE_LABELS[slip.entryType]}
                                </span>
                              </td>
                              <td className="px-3 py-2 text-right font-mono">
                                <Link
                                  href={`/sales/${slip.id}`}
                                  className="text-blue-600 hover:underline font-semibold"
                                >
                                  #{slip.slipNo}
                                </Link>
                              </td>
                              <td className="px-3 py-2 text-center font-mono">{slip.slipDate}</td>
                              <td className="px-3 py-2 font-medium text-slate-900">
                                {slip.slipName !== '' ? slip.slipName : '（件名なし）'}
                              </td>
                              <td className="px-3 py-2 text-center">
                                <span className="px-1.5 py-0.5 rounded bg-slate-100 text-slate-700 font-mono">
                                  {slip.status}:{SALES_STATUS_LABELS[slip.status]}
                                </span>
                              </td>
                              <td className="px-3 py-2 text-center">
                                <span
                                  className={`px-1.5 py-0.5 rounded font-semibold ${
                                    slip.approvalStatus === 1
                                      ? 'bg-emerald-100 text-emerald-800'
                                      : slip.approvalStatus === 2
                                        ? 'bg-red-100 text-red-700'
                                        : 'bg-amber-100 text-amber-800'
                                  }`}
                                >
                                  {APPROVAL_STATUS_LABELS[slip.approvalStatus]}
                                </span>
                              </td>
                              <td className="px-3 py-2 text-right font-mono">
                                {formatYen(slip.subtotalAmount)}
                              </td>
                              <td className="px-3 py-2 text-right font-mono text-slate-600">
                                {formatYen(slip.taxTotal)}
                              </td>
                              <td className="px-3 py-2 text-right font-mono font-bold text-slate-900">
                                {formatYen(slip.totalAmount)}
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      ) : (
        /* 発行済請求一覧タブ */
        <div className="space-y-4">
          <div className="grid grid-cols-2 lg:grid-cols-5 gap-3">
            <div className="rounded-xl bg-white border border-slate-200 p-4 shadow-xs">
              <div className="text-xs text-slate-500">請求件数</div>
              <div className="text-xl font-bold text-slate-900 mt-1 font-mono">
                {issuedData.summary.totalCount} 件
              </div>
            </div>
            <div className="rounded-xl bg-white border border-slate-200 p-4 shadow-xs">
              <div className="text-xs text-slate-500">前回繰越計</div>
              <div className="text-xl font-bold text-slate-900 mt-1 font-mono">
                {formatYen(issuedData.summary.sumPrevCarried)}
              </div>
            </div>
            <div className="rounded-xl bg-white border border-slate-200 p-4 shadow-xs">
              <div className="text-xs text-slate-500">当月入金計</div>
              <div className="text-xl font-bold text-emerald-700 mt-1 font-mono">
                {formatYen(issuedData.summary.sumPeriodReceipt)}
              </div>
            </div>
            <div className="rounded-xl bg-blue-50 border border-blue-200 p-4 shadow-xs">
              <div className="text-xs font-semibold text-blue-700">今回請求税込計</div>
              <div className="text-xl font-bold text-blue-900 mt-1 font-mono">
                {formatYen(issuedData.summary.sumBillingAmount)}
              </div>
            </div>
            <div className="rounded-xl bg-white border border-slate-200 p-4 shadow-xs">
              <div className="text-xs text-slate-500">今回売掛残高計</div>
              <div className="text-xl font-bold text-slate-900 mt-1 font-mono">
                {formatYen(issuedData.summary.sumClosingAr)}
              </div>
            </div>
          </div>

          {/* 検索・一覧出力バー */}
          <form
            onSubmit={(e) => {
              e.preventDefault();
              void reloadIssuedBillings(1);
            }}
            className="rounded-xl bg-white border border-slate-200 p-4 shadow-xs space-y-3"
          >
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-6 gap-3">
              <div>
                <label className="block text-xs font-medium text-slate-600 mb-1">検索</label>
                <input
                  type="text"
                  value={issKw}
                  onChange={(e) => setIssKw(e.target.value)}
                  placeholder="請求No・取引先"
                  className="w-full rounded-lg border border-slate-300 px-2.5 py-1.5 text-sm"
                />
              </div>
              <div>
                <label className="block text-xs font-medium text-slate-600 mb-1">取引先</label>
                <select
                  value={issPartnerId}
                  onChange={(e) => setIssPartnerId(e.target.value)}
                  className="w-full rounded-lg border border-slate-300 px-2.5 py-1.5 text-sm bg-white"
                >
                  <option value="">すべて</option>
                  {lookups.partners.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.partnerCode} {p.partnerName}
                    </option>
                  ))}
                </select>
              </div>
              <div>
                <label className="block text-xs font-medium text-slate-600 mb-1">状態</label>
                <select
                  value={issStatus}
                  onChange={(e) => setIssStatus(e.target.value as '' | ReceivableStatus)}
                  className="w-full rounded-lg border border-slate-300 px-2.5 py-1.5 text-sm bg-white"
                >
                  <option value="">すべて</option>
                  <option value="N1">N1: 未入金</option>
                  <option value="N2">N2: 一部入金</option>
                  <option value="N3">N3: 入金済</option>
                  <option value="N4">N4: 過入金</option>
                </select>
              </div>
              <div>
                <label className="block text-xs font-medium text-slate-600 mb-1">種別</label>
                <select
                  value={issSubKind}
                  onChange={(e) =>
                    setIssSubKind(e.target.value as 'ALL' | 'STANDARD' | 'SUBSCRIPTION')
                  }
                  className="w-full rounded-lg border border-slate-300 px-2.5 py-1.5 text-sm bg-white"
                >
                  <option value="ALL">すべて</option>
                  <option value="STANDARD">通常請求のみ</option>
                  <option value="SUBSCRIPTION">定額請求のみ</option>
                </select>
              </div>
              <div>
                <label className="block text-xs font-medium text-slate-600 mb-1">請求日(From)</label>
                <input
                  type="date"
                  value={issDateFrom}
                  onChange={(e) => setIssDateFrom(e.target.value)}
                  className="w-full rounded-lg border border-slate-300 px-2.5 py-1.5 text-sm"
                />
              </div>
              <div>
                <label className="block text-xs font-medium text-slate-600 mb-1">請求日(To)</label>
                <input
                  type="date"
                  value={issDateTo}
                  onChange={(e) => setIssDateTo(e.target.value)}
                  className="w-full rounded-lg border border-slate-300 px-2.5 py-1.5 text-sm"
                />
              </div>
            </div>

            <div className="flex flex-wrap items-center justify-between gap-2 pt-1 border-t border-slate-100">
              <div className="flex flex-wrap items-center gap-2">
                <span className="text-xs font-medium text-slate-600">一覧帳票種別:</span>
                <select
                  value={exportTarget}
                  onChange={(e) => setExportTarget(e.target.value as BillingExportTarget)}
                  className="rounded border border-slate-300 bg-white px-2 py-1 text-xs"
                >
                  <option value="standard">請求一覧（rp_請求一覧）</option>
                  <option value="simple">請求一覧（簡易）</option>
                  <option value="detail">請求一覧（詳細）</option>
                </select>
                <a
                  href={buildExportUrl('csv')}
                  className="rounded border border-slate-300 bg-white hover:bg-slate-50 px-3 py-1 text-xs font-medium text-slate-700"
                >
                  CSV出力
                </a>
                <a
                  href={buildExportUrl('pdf')}
                  className="rounded border border-slate-300 bg-white hover:bg-slate-50 px-3 py-1 text-xs font-medium text-slate-700"
                >
                  A4横PDF出力
                </a>
              </div>

              <button
                type="submit"
                disabled={loading}
                className="rounded-lg bg-slate-800 hover:bg-slate-700 px-4 py-1.5 text-xs font-semibold text-white cursor-pointer"
              >
                {loading ? '検索中...' : '絞り込む'}
              </button>
            </div>
          </form>

          {/* 請求書一覧テーブル */}
          <div className="rounded-xl bg-white border border-slate-200 shadow-xs overflow-hidden">
            <div className="overflow-x-auto">
              <table className="min-w-full divide-y divide-slate-200 text-xs">
                <thead className="bg-slate-50 text-slate-600">
                  <tr>
                    <th className="px-3 py-2.5 text-right">請求No</th>
                    <th className="px-3 py-2.5 text-center">請求日 / 期限</th>
                    <th className="px-3 py-2.5 text-left">取引先</th>
                    <th className="px-3 py-2.5 text-center">種別 / 状態</th>
                    <th className="px-3 py-2.5 text-right">前回繰越</th>
                    <th className="px-3 py-2.5 text-right">当月入金</th>
                    <th className="px-3 py-2.5 text-right">今回税込</th>
                    <th className="px-3 py-2.5 text-right">今回売掛残高</th>
                    <th className="px-3 py-2.5 text-right">操作 / 帳票</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {issuedData.items.length === 0 ? (
                    <tr>
                      <td colSpan={9} className="px-4 py-8 text-center text-sm text-slate-500">
                        発行済みの請求書はありません。
                      </td>
                    </tr>
                  ) : (
                    issuedData.items.map((item) => (
                      <tr key={item.id} className="hover:bg-slate-50">
                        <td className="px-3 py-2.5 text-right font-mono font-bold">
                          <Link
                            href={`/billing/${item.id}`}
                            className="text-blue-600 hover:underline"
                          >
                            #{item.billingNo}
                          </Link>
                        </td>
                        <td className="px-3 py-2.5 text-center font-mono">
                          <div>{item.billingDate}</div>
                          <div className="text-[10px] text-slate-400">
                            期: {item.paymentDueDate !== null ? item.paymentDueDate : '-'}
                          </div>
                        </td>
                        <td className="px-3 py-2.5">
                          <div className="font-medium text-slate-900">{item.partnerName}</div>
                          <div className="font-mono text-slate-400">
                            {item.partnerCode} ({item.slipCount}伝票)
                          </div>
                        </td>
                        <td className="px-3 py-2.5 text-center whitespace-nowrap">
                          <span
                            className={`px-1.5 py-0.5 rounded font-semibold mr-1 ${
                              item.isSubscriptionBill
                                ? 'bg-indigo-100 text-indigo-800'
                                : 'bg-slate-100 text-slate-700'
                            }`}
                          >
                            {item.isSubscriptionBill ? '定額' : '通常'}
                          </span>
                          <span className="px-1.5 py-0.5 rounded bg-amber-50 text-amber-800 font-semibold">
                            {item.status}:{RECEIVABLE_STATUS_LABELS[item.status]}
                          </span>
                        </td>
                        <td className="px-3 py-2.5 text-right font-mono">
                          {formatYen(item.prevCarriedBalance)}
                        </td>
                        <td className="px-3 py-2.5 text-right font-mono text-emerald-700">
                          {formatYen(item.periodReceiptAmount)}
                        </td>
                        <td className="px-3 py-2.5 text-right font-mono font-bold text-slate-900">
                          {formatYen(item.billingAmount)}
                        </td>
                        <td className="px-3 py-2.5 text-right font-mono font-bold text-blue-900">
                          {formatYen(item.closingArBalance)}
                        </td>
                        <td className="px-3 py-2.5 text-right whitespace-nowrap space-x-1">
                          {item.latestSnapshotId !== null && (
                            <button
                              type="button"
                              onClick={() => setPreviewSnapshotId(item.latestSnapshotId)}
                              className="rounded border border-slate-300 bg-white hover:bg-slate-50 px-2 py-1 font-medium text-slate-700 cursor-pointer"
                            >
                              PDF
                            </button>
                          )}
                          <Link
                            href={`/billing/${item.id}`}
                            className="rounded bg-slate-800 hover:bg-slate-700 px-2.5 py-1 font-medium text-white"
                          >
                            詳細 / 再発行
                          </Link>
                        </td>
                      </tr>
                    ))
                  )}
                </tbody>
              </table>
            </div>

            {totalIssuedPages > 1 && (
              <div className="px-4 py-2.5 bg-slate-50 border-t border-slate-200 flex items-center justify-between text-xs text-slate-600">
                <span>
                  Page {issuedData.page} / {totalIssuedPages}
                </span>
                <div className="flex gap-1.5">
                  <button
                    type="button"
                    disabled={issuedData.page <= 1}
                    onClick={() => void reloadIssuedBillings(issuedData.page - 1)}
                    className="rounded border border-slate-300 bg-white px-2.5 py-1 disabled:opacity-40 cursor-pointer"
                  >
                    前へ
                  </button>
                  <button
                    type="button"
                    disabled={issuedData.page >= totalIssuedPages}
                    onClick={() => void reloadIssuedBillings(issuedData.page + 1)}
                    className="rounded border border-slate-300 bg-white px-2.5 py-1 disabled:opacity-40 cursor-pointer"
                  >
                    次へ
                  </button>
                </div>
              </div>
            )}
          </div>
        </div>
      )}

      {/* PDF プレビューモーダル */}
      {previewSnapshotId !== null && (
        <div className="fixed inset-0 z-50 bg-slate-900/60 flex items-center justify-center p-4">
          <div className="bg-white rounded-xl w-full max-w-4xl h-[85vh] flex flex-col shadow-2xl overflow-hidden">
            <div className="px-4 py-3 border-b border-slate-200 flex items-center justify-between">
              <span className="text-sm font-bold text-slate-900">請求書スナップショット PDF プレビュー</span>
              <div className="flex items-center gap-2">
                <a
                  href={`/api/v1/snapshots/${encodeURIComponent(previewSnapshotId)}/pdf?download=1`}
                  className="rounded bg-blue-600 hover:bg-blue-700 px-3 py-1 text-xs font-semibold text-white"
                >
                  ダウンロード
                </a>
                <button
                  type="button"
                  onClick={() => setPreviewSnapshotId(null)}
                  className="rounded border border-slate-300 px-3 py-1 text-xs font-medium text-slate-700 cursor-pointer"
                >
                  閉じる
                </button>
              </div>
            </div>
            <iframe
              title="請求書PDFプレビュー"
              src={`/api/v1/snapshots/${encodeURIComponent(previewSnapshotId)}/pdf`}
              className="flex-1 w-full border-0"
            />
          </div>
        </div>
      )}
    </div>
  );
}
