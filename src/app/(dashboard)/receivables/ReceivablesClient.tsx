'use client';

import Link from 'next/link';
import { useState } from 'react';
import { RECEIVABLE_STATUS_LABELS, type ReceivableStatus } from '@/lib/billing/types';
import { computePageCount, type SnapshotHistoryItemDto } from '@/lib/estimates/types';
import { normalizeNullableText, requestMasterApi } from '@/lib/masters/client-api';
import type {
  CashReceiptDetailDto,
  CashReceiptDto,
  CashReceiptInput,
  CashReceiptPageDto,
  ReceivableBalanceListResultDto,
  ReceivablesLookupsDto,
  UnpaidBillingItemDto,
} from '@/lib/receivables/types';

interface ReceivablesClientProps {
  initialTab: 'BALANCES' | 'UNPAID' | 'RECEIPTS';
  defaultReceiptDate: string;
  lookups: ReceivablesLookupsDto;
  initialBalances: ReceivableBalanceListResultDto | null;
  initialUnpaid: UnpaidBillingItemDto[];
  initialReceipts: CashReceiptPageDto;
  prefillPartnerId: string | null;
  prefillBillNo: string | null;
  prefillAmount: number | null;
}

function formatYen(amount: number): string {
  return `¥${amount.toLocaleString('ja-JP')}`;
}

function parseIntInput(raw: string): number {
  const cleaned = raw.trim().replace(/,/g, '');
  if (cleaned === '') return 0;
  const num = Number(cleaned);
  return Number.isFinite(num) && Number.isInteger(num) && num >= 0 ? num : 0;
}

export default function ReceivablesClient({
  initialTab,
  defaultReceiptDate,
  lookups,
  initialBalances,
  initialUnpaid,
  initialReceipts,
  prefillPartnerId,
  prefillBillNo,
  prefillAmount,
}: ReceivablesClientProps) {
  const [activeTab, setActiveTab] = useState<'BALANCES' | 'UNPAID' | 'RECEIPTS'>(initialTab);

  // 売掛残高一覧タブ
  const [balancesData, setBalancesData] = useState<ReceivableBalanceListResultDto | null>(
    initialBalances,
  );
  const [balStart, setBalStart] = useState(
    initialBalances !== null ? initialBalances.periodStart : defaultReceiptDate,
  );
  const [balEnd, setBalEnd] = useState(
    initialBalances !== null ? initialBalances.periodEnd : defaultReceiptDate,
  );
  const [balClosingDay, setBalClosingDay] = useState('');
  const [balKw, setBalKw] = useState('');
  const [balOnlyWithBalance, setBalOnlyWithBalance] = useState(false);

  // 未収請求タブ
  const [unpaidItems, setUnpaidItems] = useState<UnpaidBillingItemDto[]>(initialUnpaid);
  const [unpaidStatus, setUnpaidStatus] = useState<'' | ReceivableStatus>('');
  const [unpaidKw, setUnpaidKw] = useState('');
  const [unpaidOnlyFlag, setUnpaidOnlyFlag] = useState(true);

  // 入金履歴タブ
  const [receiptsData, setReceiptsData] = useState<CashReceiptPageDto>(initialReceipts);
  const [recKw, setRecKw] = useState('');
  const [recPartnerId, setRecPartnerId] = useState('');
  const [recSourceKind, setRecSourceKind] = useState<'ALL' | 'MANUAL' | 'APLUS'>('ALL');
  const [recDateFrom, setRecDateFrom] = useState('');
  const [recDateTo, setRecDateTo] = useState('');

  // 入金登録/編集モーダル
  const hasPrefill =
    prefillPartnerId !== null && prefillPartnerId !== '' && lookups.depositEnabled;
  const [modalOpen, setModalOpen] = useState(hasPrefill);
  const [editingReceiptId, setEditingReceiptId] = useState<string | null>(null);
  const [formReceiptDate, setFormReceiptDate] = useState(
    defaultReceiptDate > lookups.openingBalanceDate ? defaultReceiptDate : '',
  );
  const [formPartnerId, setFormPartnerId] = useState(
    hasPrefill && prefillPartnerId !== null ? prefillPartnerId : '',
  );
  const [formProjectId, setFormProjectId] = useState('');
  const [formMethod1, setFormMethod1] = useState('D');
  const [formDeposit1, setFormDeposit1] = useState(
    hasPrefill && prefillAmount !== null && Number.isFinite(prefillAmount)
      ? String(prefillAmount)
      : '0',
  );
  const [formMethod2, setFormMethod2] = useState('');
  const [formDeposit2, setFormDeposit2] = useState('0');
  const [formMethod3, setFormMethod3] = useState('');
  const [formDeposit3, setFormDeposit3] = useState('0');
  const [formSub10Excl, setFormSub10Excl] = useState('0');
  const [formSub8Excl, setFormSub8Excl] = useState('0');
  const [formSub0, setFormSub0] = useState('0');
  const [formTadashi, setFormTadashi] = useState('お買上代金として');
  const [formBillNo, setFormBillNo] = useState(
    hasPrefill && prefillBillNo !== null ? prefillBillNo : '',
  );
  const [formBillDueDate, setFormBillDueDate] = useState('');
  const [formRemarks, setFormRemarks] = useState('');
  const [modalError, setModalError] = useState<string | null>(null);

  // 領収書スナップショットモーダル
  const [receiptDetailModal, setReceiptDetailModal] = useState<CashReceiptDetailDto | null>(null);
  const [previewSnapshotId, setPreviewSnapshotId] = useState<string | null>(null);

  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [bannerError, setBannerError] = useState<string | null>(null);
  const [bannerSuccess, setBannerSuccess] = useState<string | null>(null);

  function buildBalanceExportParams(format: 'csv' | 'pdf'): string {
    const params = new URLSearchParams();
    params.set('format', format);
    if (balStart !== '') params.set('periodStart', balStart);
    if (balEnd !== '') params.set('periodEnd', balEnd);
    if (balClosingDay !== '') params.set('closingDayCode', balClosingDay);
    if (balKw.trim() !== '') params.set('q', balKw.trim());
    if (balOnlyWithBalance) params.set('onlyWithBalance', '1');
    return `/api/v1/receivables/export?${params.toString()}`;
  }

  async function reloadBalances() {
    if (!lookups.receivableEnabled) return;
    setLoading(true);
    setBannerError(null);
    const params = new URLSearchParams();
    if (balStart !== '') params.set('periodStart', balStart);
    if (balEnd !== '') params.set('periodEnd', balEnd);
    if (balClosingDay !== '') params.set('closingDayCode', balClosingDay);
    if (balKw.trim() !== '') params.set('q', balKw.trim());
    if (balOnlyWithBalance) params.set('onlyWithBalance', '1');

    const res = await requestMasterApi<ReceivableBalanceListResultDto>(
      `/api/v1/receivables/balances?${params.toString()}`,
    );
    setLoading(false);
    if (!res.ok) {
      setBannerError(res.error);
      return;
    }
    setBalancesData(res.data);
  }

  async function reloadUnpaidBillings() {
    setLoading(true);
    setBannerError(null);
    const params = new URLSearchParams();
    params.set('mode', 'unpaid');
    if (unpaidStatus !== '') params.set('status', unpaidStatus);
    if (unpaidKw.trim() !== '') params.set('q', unpaidKw.trim());
    if (unpaidOnlyFlag) params.set('unpaidOnly', '1');

    const res = await requestMasterApi<{ items: UnpaidBillingItemDto[] }>(
      `/api/v1/receivables/balances?${params.toString()}`,
    );
    setLoading(false);
    if (!res.ok) {
      setBannerError(res.error);
      return;
    }
    setUnpaidItems(res.data.items);
  }

  async function reloadReceipts(page: number = 1) {
    setLoading(true);
    setBannerError(null);
    const params = new URLSearchParams();
    params.set('page', String(page));
    params.set('pageSize', String(receiptsData.pageSize));
    if (recKw.trim() !== '') params.set('q', recKw.trim());
    if (recPartnerId !== '') params.set('partnerId', recPartnerId);
    if (recSourceKind !== 'ALL') params.set('sourceKind', recSourceKind);
    if (recDateFrom !== '') params.set('dateFrom', recDateFrom);
    if (recDateTo !== '') params.set('dateTo', recDateTo);

    const res = await requestMasterApi<CashReceiptPageDto>(
      `/api/v1/receivables/receipts?${params.toString()}`,
    );
    setLoading(false);
    if (!res.ok) {
      setBannerError(res.error);
      return;
    }
    setReceiptsData({
      items: res.data.items,
      summary: res.data.summary,
      page: res.data.page,
      pageSize: res.data.pageSize,
    });
  }

  function openNewReceiptModal(prefill?: {
    partnerId?: string;
    billNo?: string;
    amount?: number;
  }) {
    setEditingReceiptId(null);
    setFormReceiptDate(defaultReceiptDate);
    setFormPartnerId(prefill?.partnerId !== undefined ? prefill.partnerId : '');
    setFormProjectId('');
    setFormMethod1('D');
    setFormDeposit1(
      prefill?.amount !== undefined && prefill.amount > 0 ? String(prefill.amount) : '0',
    );
    setFormMethod2('');
    setFormDeposit2('0');
    setFormMethod3('');
    setFormDeposit3('0');
    setFormSub10Excl('0');
    setFormSub8Excl('0');
    setFormSub0('0');
    setFormTadashi('お買上代金として');
    setFormBillNo(prefill?.billNo !== undefined ? prefill.billNo : '');
    setFormBillDueDate('');
    setFormRemarks('');
    setModalError(null);
    setModalOpen(true);
  }

  function openEditReceiptModal(item: CashReceiptDto) {
    setEditingReceiptId(item.id);
    setFormReceiptDate(item.receiptDate);
    setFormPartnerId(item.partnerId);
    setFormProjectId(item.projectId !== null ? item.projectId : '');
    setFormMethod1(item.methodCode1 !== null ? item.methodCode1 : 'D');
    setFormDeposit1(String(item.deposit1));
    setFormMethod2(item.methodCode2 !== null ? item.methodCode2 : '');
    setFormDeposit2(String(item.deposit2));
    setFormMethod3(item.methodCode3 !== null ? item.methodCode3 : '');
    setFormDeposit3(String(item.deposit3));
    setFormSub10Excl(String(item.subtotal10Excl));
    setFormSub8Excl(String(item.subtotal8Excl));
    setFormSub0(String(item.subtotal0));
    setFormTadashi(item.tadashi !== null ? item.tadashi : '');
    setFormBillNo(item.billNo !== null ? item.billNo : '');
    setFormBillDueDate(item.billDueDate !== null ? item.billDueDate : '');
    setFormRemarks(item.remarks !== null ? item.remarks : '');
    setModalError(null);
    setModalOpen(true);
  }

  async function handleSaveReceipt(e: React.FormEvent) {
    e.preventDefault();
    setModalError(null);
    setBannerError(null);
    setBannerSuccess(null);

    const payload: CashReceiptInput = {
      receiptDate: formReceiptDate,
      partnerId: formPartnerId,
      projectId: formProjectId !== '' ? formProjectId : null,
      methodCode1: normalizeNullableText(formMethod1),
      deposit1: parseIntInput(formDeposit1),
      methodCode2: normalizeNullableText(formMethod2),
      deposit2: parseIntInput(formDeposit2),
      methodCode3: normalizeNullableText(formMethod3),
      deposit3: parseIntInput(formDeposit3),
      subtotal10Excl: parseIntInput(formSub10Excl),
      subtotal8Excl: parseIntInput(formSub8Excl),
      subtotal0: parseIntInput(formSub0),
      tadashi: normalizeNullableText(formTadashi),
      billNo: normalizeNullableText(formBillNo),
      billDueDate: normalizeNullableText(formBillDueDate),
      remarks: normalizeNullableText(formRemarks),
    };

    setSaving(true);
    const res =
      editingReceiptId === null
        ? await requestMasterApi<{ item: CashReceiptDetailDto }>('/api/v1/receivables/receipts', {
            method: 'POST',
            body: JSON.stringify(payload),
          })
        : await requestMasterApi<{ item: CashReceiptDetailDto }>(
            `/api/v1/receivables/receipts/${encodeURIComponent(editingReceiptId)}`,
            {
              method: 'PUT',
              body: JSON.stringify(payload),
            },
          );
    setSaving(false);

    if (!res.ok) {
      setModalError(res.error);
      return;
    }

    setModalOpen(false);
    setBannerSuccess(
      editingReceiptId === null
        ? `入金No.${res.data.item.receiptNo}（¥${res.data.item.totalDeposit.toLocaleString('ja-JP')}）を登録しました。`
        : `入金No.${res.data.item.receiptNo} を更新しました。`,
    );
    await Promise.all([reloadReceipts(1), reloadUnpaidBillings(), reloadBalances()]);
  }

  async function handleDeleteReceipt(item: CashReceiptDto) {
    setBannerError(null);
    setBannerSuccess(null);
    setSaving(true);
    const res = await requestMasterApi<{ ok: boolean }>(
      `/api/v1/receivables/receipts/${encodeURIComponent(item.id)}`,
      { method: 'DELETE' },
    );
    setSaving(false);
    if (!res.ok) {
      setBannerError(res.error);
      return;
    }
    setBannerSuccess(`入金No.${item.receiptNo} を削除し、消込ステータスを再同期しました。`);
    await Promise.all([reloadReceipts(1), reloadUnpaidBillings(), reloadBalances()]);
  }

  async function openReceiptSnapshotPanel(receiptId: string) {
    setBannerError(null);
    const res = await requestMasterApi<{ item: CashReceiptDetailDto }>(
      `/api/v1/receivables/receipts/${encodeURIComponent(receiptId)}`,
    );
    if (!res.ok) {
      setBannerError(res.error);
      return;
    }
    setReceiptDetailModal(res.data.item);
  }

  async function handleIssueReceiptSnapshot(receiptId: string) {
    setBannerError(null);
    setBannerSuccess(null);
    setSaving(true);
    const res = await requestMasterApi<{ item: SnapshotHistoryItemDto }>('/api/v1/snapshots', {
      method: 'POST',
      body: JSON.stringify({
        documentType: 'RECEIPT',
        sourceEntityId: receiptId,
      }),
    });
    setSaving(false);
    if (!res.ok) {
      setBannerError(res.error);
      return;
    }
    setBannerSuccess(
      `領収書スナップショット v${res.data.item.versionNo}${
        res.data.item.reissueLabel !== null ? ` ${res.data.item.reissueLabel}` : ''
      } を発行しました。`,
    );
    await openReceiptSnapshotPanel(receiptId);
    await reloadReceipts(receiptsData.page);
  }

  async function handleManualStatusChange(billingId: string, status: ReceivableStatus) {
    setBannerError(null);
    setBannerSuccess(null);
    setSaving(true);
    const res = await requestMasterApi<{ billingId: string; status: ReceivableStatus }>(
      '/api/v1/receivables/billing-status',
      {
        method: 'PATCH',
        body: JSON.stringify({ billingId, status }),
      },
    );
    setSaving(false);
    if (!res.ok) {
      setBannerError(res.error);
      return;
    }
    setBannerSuccess(`請求消込ステータスを ${status}:${RECEIVABLE_STATUS_LABELS[status]} へ更新しました。`);
    await reloadUnpaidBillings();
  }

  const modalDepositTotal =
    parseIntInput(formDeposit1) + parseIntInput(formDeposit2) + parseIntInput(formDeposit3);
  const totalReceiptPages = computePageCount(
    receiptsData.summary.totalCount,
    receiptsData.pageSize,
  );

  return (
    <div className="max-w-7xl space-y-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold text-slate-900">売掛一覧 ＆ 入金消込・領収書管理</h1>
          <p className="text-sm text-slate-600 mt-1">
            取引先別売掛残高推移（rp_売掛一覧）、請求消込ステータス自動連動、領収書スナップショット発行を行います。
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          {lookups.aplusEnabled && (
            <Link
              href="/aplus"
              className="rounded-lg border border-slate-300 bg-white hover:bg-slate-50 px-3.5 py-2 text-xs font-semibold text-slate-700"
            >
              アプラス口座振替連携 →
            </Link>
          )}
          {lookups.depositEnabled && (
            <button
              type="button"
              onClick={() => openNewReceiptModal()}
              className="rounded-lg bg-blue-600 hover:bg-blue-700 px-4 py-2 text-xs font-semibold text-white cursor-pointer"
            >
              ＋ 新規入金登録
            </button>
          )}
        </div>
      </div>

      {/* タブ */}
      <div className="flex items-center gap-2 border-b border-slate-200">
        {lookups.receivableEnabled && (
          <button
            type="button"
            onClick={() => setActiveTab('BALANCES')}
            className={`px-4 py-2.5 text-sm font-medium border-b-2 transition-colors cursor-pointer ${
              activeTab === 'BALANCES'
                ? 'border-blue-600 text-blue-700'
                : 'border-transparent text-slate-600 hover:text-slate-900'
            }`}
          >
            売掛残高一覧（rp_売掛一覧）
          </button>
        )}
        <button
          type="button"
          onClick={() => {
            setActiveTab('UNPAID');
            void reloadUnpaidBillings();
          }}
          className={`px-4 py-2.5 text-sm font-medium border-b-2 transition-colors cursor-pointer ${
            activeTab === 'UNPAID'
              ? 'border-blue-600 text-blue-700'
              : 'border-transparent text-slate-600 hover:text-slate-900'
          }`}
        >
          未収請求・消込状況（{unpaidItems.length}件）
        </button>
        <button
          type="button"
          onClick={() => {
            setActiveTab('RECEIPTS');
            void reloadReceipts(1);
          }}
          className={`px-4 py-2.5 text-sm font-medium border-b-2 transition-colors cursor-pointer ${
            activeTab === 'RECEIPTS'
              ? 'border-blue-600 text-blue-700'
              : 'border-transparent text-slate-600 hover:text-slate-900'
          }`}
        >
          入金履歴・領収書発行（{receiptsData.summary.totalCount}件）
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

      {/* 1. 売掛残高一覧タブ */}
      {activeTab === 'BALANCES' && balancesData !== null && (
        <div className="space-y-4">
          <div className="grid grid-cols-2 lg:grid-cols-5 gap-3">
            <div className="rounded-xl bg-white border border-slate-200 p-4 shadow-xs">
              <div className="text-xs text-slate-500">前回繰越残高計</div>
              <div className="text-xl font-bold text-slate-900 mt-1 font-mono">
                {formatYen(balancesData.totals.prevCarriedBalance)}
              </div>
            </div>
            <div className="rounded-xl bg-white border border-slate-200 p-4 shadow-xs">
              <div className="text-xs text-slate-500">当期請求(税抜)</div>
              <div className="text-xl font-bold text-slate-900 mt-1 font-mono">
                {formatYen(balancesData.totals.periodBillingExcl)}
              </div>
            </div>
            <div className="rounded-xl bg-white border border-slate-200 p-4 shadow-xs">
              <div className="text-xs text-slate-500">当期請求(税込)</div>
              <div className="text-xl font-bold text-blue-800 mt-1 font-mono">
                {formatYen(balancesData.totals.periodBillingIncl)}
              </div>
            </div>
            <div className="rounded-xl bg-white border border-slate-200 p-4 shadow-xs">
              <div className="text-xs text-slate-500">当期入金額計</div>
              <div className="text-xl font-bold text-emerald-700 mt-1 font-mono">
                {formatYen(balancesData.totals.periodReceiptAmount)}
              </div>
            </div>
            <div className="rounded-xl bg-slate-900 text-white p-4 shadow-xs">
              <div className="text-xs text-slate-300">当期末売掛残高計</div>
              <div className="text-xl font-bold mt-1 font-mono">
                {formatYen(balancesData.totals.closingArBalance)}
              </div>
            </div>
          </div>

          <form
            onSubmit={(e) => {
              e.preventDefault();
              void reloadBalances();
            }}
            className="rounded-xl bg-white border border-slate-200 p-4 shadow-xs flex flex-wrap items-end gap-3"
          >
            <div>
              <label className="block text-xs font-medium text-slate-600 mb-1">
                期間開始 (基準日 {balancesData.openingBalanceDate} 以降)
              </label>
              <input
                type="date"
                value={balStart}
                onChange={(e) => setBalStart(e.target.value)}
                className="rounded-lg border border-slate-300 px-2.5 py-1.5 text-sm"
              />
            </div>
            <div>
              <label className="block text-xs font-medium text-slate-600 mb-1">期間終了</label>
              <input
                type="date"
                value={balEnd}
                onChange={(e) => setBalEnd(e.target.value)}
                className="rounded-lg border border-slate-300 px-2.5 py-1.5 text-sm"
              />
            </div>
            <div>
              <label className="block text-xs font-medium text-slate-600 mb-1">締日区分</label>
              <select
                value={balClosingDay}
                onChange={(e) => setBalClosingDay(e.target.value)}
                className="rounded-lg border border-slate-300 px-2.5 py-1.5 text-sm bg-white"
              >
                <option value="">すべて</option>
                {lookups.closingDays.map((cd) => (
                  <option key={cd.code} value={cd.code}>
                    {cd.code}: {cd.name}
                  </option>
                ))}
              </select>
            </div>
            <div className="flex-1 min-w-44">
              <label className="block text-xs font-medium text-slate-600 mb-1">取引先検索</label>
              <input
                type="text"
                value={balKw}
                onChange={(e) => setBalKw(e.target.value)}
                placeholder="コード・取引先名"
                className="w-full rounded-lg border border-slate-300 px-2.5 py-1.5 text-sm"
              />
            </div>
            <label className="inline-flex items-center gap-1.5 text-xs text-slate-700 pb-2 cursor-pointer">
              <input
                type="checkbox"
                checked={balOnlyWithBalance}
                onChange={(e) => setBalOnlyWithBalance(e.target.checked)}
              />
              残高・取引ありのみ
            </label>
            <button
              type="submit"
              disabled={loading}
              className="rounded-lg bg-slate-800 hover:bg-slate-700 px-4 py-1.5 text-xs font-semibold text-white cursor-pointer"
            >
              {loading ? '集計中...' : '集計実行'}
            </button>
            <a
              href={buildBalanceExportParams('csv')}
              className="rounded-lg border border-slate-300 bg-white hover:bg-slate-50 px-3 py-1.5 text-xs font-medium text-slate-700"
            >
              CSV出力
            </a>
            <a
              href={buildBalanceExportParams('pdf')}
              className="rounded-lg border border-slate-300 bg-white hover:bg-slate-50 px-3 py-1.5 text-xs font-medium text-slate-700"
            >
              A4横PDF出力
            </a>
          </form>

          <div className="rounded-xl bg-white border border-slate-200 shadow-xs overflow-hidden">
            <div className="overflow-x-auto">
              <table className="min-w-full divide-y divide-slate-200 text-xs">
                <thead className="bg-slate-50 text-slate-600">
                  <tr>
                    <th className="px-3 py-2.5 text-left">コード / 取引先名</th>
                    <th className="px-3 py-2.5 text-center">締日</th>
                    <th className="px-3 py-2.5 text-right">前回繰越</th>
                    <th className="px-3 py-2.5 text-right">当期請求(税抜)</th>
                    <th className="px-3 py-2.5 text-right">消費税</th>
                    <th className="px-3 py-2.5 text-right">当期請求(税込)</th>
                    <th className="px-3 py-2.5 text-right">当期入金額</th>
                    <th className="px-3 py-2.5 text-right">当期増減</th>
                    <th className="px-3 py-2.5 text-right">当期末残高</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {balancesData.items.map((item) => (
                    <tr key={item.partnerId} className="hover:bg-slate-50">
                      <td className="px-3 py-2">
                        <span className="font-mono text-slate-400 mr-1.5">{item.partnerCode}</span>
                        <span className="font-medium text-slate-900">{item.partnerName}</span>
                      </td>
                      <td className="px-3 py-2 text-center">
                        {item.closingDayName !== null ? item.closingDayName : '-'}
                      </td>
                      <td className="px-3 py-2 text-right font-mono">
                        {formatYen(item.prevCarriedBalance)}
                      </td>
                      <td className="px-3 py-2 text-right font-mono">
                        {formatYen(item.periodBillingExcl)}
                      </td>
                      <td className="px-3 py-2 text-right font-mono text-slate-500">
                        {formatYen(item.periodBillingTax)}
                      </td>
                      <td className="px-3 py-2 text-right font-mono font-semibold text-blue-800">
                        {formatYen(item.periodBillingIncl)}
                      </td>
                      <td className="px-3 py-2 text-right font-mono text-emerald-700">
                        {formatYen(item.periodReceiptAmount)}
                      </td>
                      <td className="px-3 py-2 text-right font-mono">
                        {formatYen(item.periodNetDelta)}
                      </td>
                      <td className="px-3 py-2 text-right font-mono font-bold text-slate-900">
                        {formatYen(item.closingArBalance)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        </div>
      )}

      {/* 2. 未収請求・消込状況タブ */}
      {activeTab === 'UNPAID' && (
        <div className="space-y-4">
          <form
            onSubmit={(e) => {
              e.preventDefault();
              void reloadUnpaidBillings();
            }}
            className="rounded-xl bg-white border border-slate-200 p-4 shadow-xs flex flex-wrap items-end gap-3"
          >
            <div>
              <label className="block text-xs font-medium text-slate-600 mb-1">消込状態</label>
              <select
                value={unpaidStatus}
                onChange={(e) => setUnpaidStatus(e.target.value as '' | ReceivableStatus)}
                className="rounded-lg border border-slate-300 px-2.5 py-1.5 text-sm bg-white"
              >
                <option value="">すべて</option>
                <option value="N1">N1: 未入金</option>
                <option value="N2">N2: 一部入金</option>
                <option value="N3">N3: 入金済</option>
                <option value="N4">N4: 過入金</option>
              </select>
            </div>
            <div className="flex-1 min-w-48">
              <label className="block text-xs font-medium text-slate-600 mb-1">検索</label>
              <input
                type="text"
                value={unpaidKw}
                onChange={(e) => setUnpaidKw(e.target.value)}
                placeholder="請求No・取引先"
                className="w-full rounded-lg border border-slate-300 px-2.5 py-1.5 text-sm"
              />
            </div>
            <label className="inline-flex items-center gap-1.5 text-xs text-slate-700 pb-2 cursor-pointer">
              <input
                type="checkbox"
                checked={unpaidOnlyFlag}
                onChange={(e) => setUnpaidOnlyFlag(e.target.checked)}
              />
              未収(N1/N2)のみ
            </label>
            <button
              type="submit"
              disabled={loading}
              className="rounded-lg bg-slate-800 hover:bg-slate-700 px-4 py-1.5 text-xs font-semibold text-white cursor-pointer"
            >
              検索
            </button>
          </form>

          <div className="rounded-xl bg-white border border-slate-200 shadow-xs overflow-hidden">
            <div className="overflow-x-auto">
              <table className="min-w-full divide-y divide-slate-200 text-xs">
                <thead className="bg-slate-50 text-slate-600">
                  <tr>
                    <th className="px-3 py-2.5 text-right">請求No</th>
                    <th className="px-3 py-2.5 text-center">請求日 / 期限</th>
                    <th className="px-3 py-2.5 text-left">取引先</th>
                    <th className="px-3 py-2.5 text-center">状態</th>
                    <th className="px-3 py-2.5 text-right">今回請求額</th>
                    <th className="px-3 py-2.5 text-right">消込済入金</th>
                    <th className="px-3 py-2.5 text-right">未収残額</th>
                    <th className="px-3 py-2.5 text-right">操作</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {unpaidItems.length === 0 ? (
                    <tr>
                      <td colSpan={8} className="px-4 py-8 text-center text-slate-500">
                        該当する請求書はありません。
                      </td>
                    </tr>
                  ) : (
                    unpaidItems.map((u) => (
                      <tr key={u.id} className="hover:bg-slate-50">
                        <td className="px-3 py-2 text-right font-mono font-bold">
                          <Link href={`/billing/${u.id}`} className="text-blue-600 hover:underline">
                            #{u.billingNo}
                          </Link>
                        </td>
                        <td className="px-3 py-2 text-center font-mono">
                          <div>{u.billingDate}</div>
                          <div className="text-[10px] text-slate-400">
                            期: {u.paymentDueDate !== null ? u.paymentDueDate : '-'}
                          </div>
                        </td>
                        <td className="px-3 py-2">
                          <div className="font-medium text-slate-900">{u.partnerName}</div>
                          <div className="font-mono text-slate-400">{u.partnerCode}</div>
                        </td>
                        <td className="px-3 py-2 text-center">
                          <select
                            value={u.status}
                            disabled={saving}
                            onChange={(e) =>
                              void handleManualStatusChange(u.id, e.target.value as ReceivableStatus)
                            }
                            className="rounded border border-slate-300 bg-white px-1.5 py-0.5 text-xs"
                          >
                            <option value="N1">N1: 未入金</option>
                            <option value="N2">N2: 一部入金</option>
                            <option value="N3">N3: 入金済</option>
                            <option value="N4">N4: 過入金</option>
                          </select>
                        </td>
                        <td className="px-3 py-2 text-right font-mono">
                          {formatYen(u.billingAmount)}
                        </td>
                        <td className="px-3 py-2 text-right font-mono text-emerald-700">
                          {formatYen(u.settledAmount)} ({u.receiptCount}件)
                        </td>
                        <td className="px-3 py-2 text-right font-mono font-bold text-slate-900">
                          {formatYen(u.unpaidBalance)}
                        </td>
                        <td className="px-3 py-2 text-right whitespace-nowrap">
                          {lookups.depositEnabled && (
                            <button
                              type="button"
                              onClick={() =>
                                openNewReceiptModal({
                                  partnerId: u.partnerId,
                                  billNo: String(u.billingNo),
                                  amount: u.unpaidBalance > 0 ? u.unpaidBalance : u.billingAmount,
                                })
                              }
                              className="rounded bg-blue-600 hover:bg-blue-700 px-2.5 py-1 text-xs font-semibold text-white cursor-pointer"
                            >
                              入金消込登録
                            </button>
                          )}
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

      {/* 3. 入金履歴・領収書発行タブ */}
      {activeTab === 'RECEIPTS' && (
        <div className="space-y-4">
          <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
            <div className="rounded-xl bg-white border border-slate-200 p-4 shadow-xs">
              <div className="text-xs text-slate-500">総入金件数</div>
              <div className="text-xl font-bold text-slate-900 mt-1 font-mono">
                {receiptsData.summary.totalCount} 件
              </div>
            </div>
            <div className="rounded-xl bg-emerald-50 border border-emerald-200 p-4 shadow-xs">
              <div className="text-xs font-semibold text-emerald-700">総入金額</div>
              <div className="text-xl font-bold text-emerald-900 mt-1 font-mono">
                {formatYen(receiptsData.summary.sumDepositTotal)}
              </div>
            </div>
            <div className="rounded-xl bg-white border border-slate-200 p-4 shadow-xs">
              <div className="text-xs text-slate-500">手入力 (MANUAL)</div>
              <div className="text-xl font-bold text-slate-900 mt-1 font-mono">
                {receiptsData.summary.manualCount} 件
              </div>
            </div>
            <div className="rounded-xl bg-white border border-slate-200 p-4 shadow-xs">
              <div className="text-xs text-slate-500">アプラス取込 (APLUS)</div>
              <div className="text-xl font-bold text-indigo-800 mt-1 font-mono">
                {receiptsData.summary.aplusCount} 件
              </div>
            </div>
          </div>

          <form
            onSubmit={(e) => {
              e.preventDefault();
              void reloadReceipts(1);
            }}
            className="rounded-xl bg-white border border-slate-200 p-4 shadow-xs grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-6 gap-3"
          >
            <div>
              <label className="block text-xs font-medium text-slate-600 mb-1">検索</label>
              <input
                type="text"
                value={recKw}
                onChange={(e) => setRecKw(e.target.value)}
                placeholder="入金No・請求No・但し書き"
                className="w-full rounded-lg border border-slate-300 px-2.5 py-1.5 text-sm"
              />
            </div>
            <div>
              <label className="block text-xs font-medium text-slate-600 mb-1">取引先</label>
              <select
                value={recPartnerId}
                onChange={(e) => setRecPartnerId(e.target.value)}
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
              <label className="block text-xs font-medium text-slate-600 mb-1">取込区分</label>
              <select
                value={recSourceKind}
                onChange={(e) => setRecSourceKind(e.target.value as 'ALL' | 'MANUAL' | 'APLUS')}
                className="w-full rounded-lg border border-slate-300 px-2.5 py-1.5 text-sm bg-white"
              >
                <option value="ALL">すべて</option>
                <option value="MANUAL">MANUAL (手入力)</option>
                <option value="APLUS">APLUS (口座振替)</option>
              </select>
            </div>
            <div>
              <label className="block text-xs font-medium text-slate-600 mb-1">入金日(From)</label>
              <input
                type="date"
                value={recDateFrom}
                onChange={(e) => setRecDateFrom(e.target.value)}
                className="w-full rounded-lg border border-slate-300 px-2.5 py-1.5 text-sm"
              />
            </div>
            <div>
              <label className="block text-xs font-medium text-slate-600 mb-1">入金日(To)</label>
              <input
                type="date"
                value={recDateTo}
                onChange={(e) => setRecDateTo(e.target.value)}
                className="w-full rounded-lg border border-slate-300 px-2.5 py-1.5 text-sm"
              />
            </div>
            <div className="flex items-end">
              <button
                type="submit"
                disabled={loading}
                className="w-full rounded-lg bg-slate-800 hover:bg-slate-700 px-4 py-1.5 text-xs font-semibold text-white cursor-pointer"
              >
                絞り込む
              </button>
            </div>
          </form>

          <div className="rounded-xl bg-white border border-slate-200 shadow-xs overflow-hidden">
            <div className="overflow-x-auto">
              <table className="min-w-full divide-y divide-slate-200 text-xs">
                <thead className="bg-slate-50 text-slate-600">
                  <tr>
                    <th className="px-3 py-2.5 text-right">入金No</th>
                    <th className="px-3 py-2.5 text-center">入金日</th>
                    <th className="px-3 py-2.5 text-left">取引先</th>
                    <th className="px-3 py-2.5 text-center">種別</th>
                    <th className="px-3 py-2.5 text-left">入金手段・内訳</th>
                    <th className="px-3 py-2.5 text-center">対象請求No</th>
                    <th className="px-3 py-2.5 text-right">入金合計</th>
                    <th className="px-3 py-2.5 text-center">領収書</th>
                    <th className="px-3 py-2.5 text-right">操作</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {receiptsData.items.length === 0 ? (
                    <tr>
                      <td colSpan={9} className="px-4 py-8 text-center text-slate-500">
                        入金履歴がありません。
                      </td>
                    </tr>
                  ) : (
                    receiptsData.items.map((r) => (
                      <tr key={r.id} className="hover:bg-slate-50">
                        <td className="px-3 py-2 text-right font-mono font-bold">#{r.receiptNo}</td>
                        <td className="px-3 py-2 text-center font-mono">{r.receiptDate}</td>
                        <td className="px-3 py-2">
                          <div className="font-medium text-slate-900">{r.partnerName}</div>
                          {r.tadashi !== null && (
                            <div className="text-[10px] text-slate-500">但し: {r.tadashi}</div>
                          )}
                        </td>
                        <td className="px-3 py-2 text-center">
                          <span
                            className={`px-1.5 py-0.5 rounded font-semibold ${
                              r.sourceKind === 'APLUS'
                                ? 'bg-indigo-100 text-indigo-800'
                                : 'bg-slate-100 text-slate-700'
                            }`}
                          >
                            {r.sourceKind}
                          </span>
                        </td>
                        <td className="px-3 py-2">
                          {r.deposit1 > 0 && (
                            <div>
                              {r.methodName1 !== null ? r.methodName1 : r.methodCode1}:{' '}
                              {formatYen(r.deposit1)}
                            </div>
                          )}
                          {r.deposit2 > 0 && (
                            <div>
                              {r.methodName2 !== null ? r.methodName2 : r.methodCode2}:{' '}
                              {formatYen(r.deposit2)}
                            </div>
                          )}
                          {r.deposit3 > 0 && (
                            <div>
                              {r.methodName3 !== null ? r.methodName3 : r.methodCode3}:{' '}
                              {formatYen(r.deposit3)}
                            </div>
                          )}
                        </td>
                        <td className="px-3 py-2 text-center font-mono">
                          {r.billNo !== null ? `#${r.billNo}` : '-'}
                        </td>
                        <td className="px-3 py-2 text-right font-mono font-bold text-slate-900">
                          {formatYen(r.totalDeposit)}
                        </td>
                        <td className="px-3 py-2 text-center whitespace-nowrap">
                          <button
                            type="button"
                            onClick={() => void openReceiptSnapshotPanel(r.id)}
                            className="rounded border border-emerald-300 bg-emerald-50 hover:bg-emerald-100 px-2 py-1 text-emerald-800 font-semibold cursor-pointer"
                          >
                            {r.latestSnapshotVersion !== null
                              ? `領収書 v${r.latestSnapshotVersion}`
                              : '領収書発行'}
                          </button>
                        </td>
                        <td className="px-3 py-2 text-right whitespace-nowrap space-x-1">
                          {lookups.depositEnabled && (
                            <>
                              <button
                                type="button"
                                onClick={() => openEditReceiptModal(r)}
                                className="rounded border border-slate-300 bg-white hover:bg-slate-50 px-2 py-1 font-medium text-slate-700 cursor-pointer"
                              >
                                編集
                              </button>
                              <button
                                type="button"
                                disabled={saving}
                                onClick={() => void handleDeleteReceipt(r)}
                                className="rounded border border-red-200 bg-white hover:bg-red-50 px-2 py-1 font-medium text-red-700 cursor-pointer"
                              >
                                削除
                              </button>
                            </>
                          )}
                        </td>
                      </tr>
                    ))
                  )}
                </tbody>
              </table>
            </div>

            {totalReceiptPages > 1 && (
              <div className="px-4 py-2.5 bg-slate-50 border-t border-slate-200 flex items-center justify-between text-xs text-slate-600">
                <span>
                  Page {receiptsData.page} / {totalReceiptPages}
                </span>
                <div className="flex gap-1.5">
                  <button
                    type="button"
                    disabled={receiptsData.page <= 1}
                    onClick={() => void reloadReceipts(receiptsData.page - 1)}
                    className="rounded border border-slate-300 bg-white px-2.5 py-1 disabled:opacity-40 cursor-pointer"
                  >
                    前へ
                  </button>
                  <button
                    type="button"
                    disabled={receiptsData.page >= totalReceiptPages}
                    onClick={() => void reloadReceipts(receiptsData.page + 1)}
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

      {/* 入金登録・編集モーダル */}
      {modalOpen && (
        <div className="fixed inset-0 z-50 bg-slate-900/50 flex items-center justify-center p-4">
          <form
            onSubmit={handleSaveReceipt}
            className="bg-white rounded-xl max-w-2xl w-full max-h-[90vh] overflow-y-auto shadow-xl p-6 space-y-4"
          >
            <div className="flex items-center justify-between border-b border-slate-200 pb-3">
              <h2 className="text-base font-bold text-slate-900">
                {editingReceiptId === null ? '新規入金登録' : '入金データの編集'}
              </h2>
              <button
                type="button"
                onClick={() => setModalOpen(false)}
                className="text-xs text-slate-500 hover:text-slate-800 cursor-pointer"
              >
                閉じる
              </button>
            </div>

            {modalError !== null && (
              <div className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-800">
                {modalError}
              </div>
            )}

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 text-sm">
              <div>
                <label className="block text-xs font-medium text-slate-700 mb-1">
                  入金日 * (基準日 {lookups.openingBalanceDate} 以降)
                </label>
                <input
                  type="date"
                  required
                  value={formReceiptDate}
                  onChange={(e) => setFormReceiptDate(e.target.value)}
                  className="w-full rounded-lg border border-slate-300 px-3 py-1.5"
                />
              </div>
              <div>
                <label className="block text-xs font-medium text-slate-700 mb-1">取引先 *</label>
                <select
                  required
                  value={formPartnerId}
                  onChange={(e) => setFormPartnerId(e.target.value)}
                  className="w-full rounded-lg border border-slate-300 px-3 py-1.5 bg-white"
                >
                  <option value="">取引先を選択...</option>
                  {lookups.partners.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.partnerCode} {p.partnerName}
                    </option>
                  ))}
                </select>
              </div>
              <div>
                <label className="block text-xs font-medium text-slate-700 mb-1">
                  対象請求番号（任意：消込連動）
                </label>
                <input
                  type="text"
                  value={formBillNo}
                  onChange={(e) => setFormBillNo(e.target.value)}
                  placeholder="例: 12（数値入力で請求書と消込連動）"
                  className="w-full rounded-lg border border-slate-300 px-3 py-1.5"
                />
              </div>
              <div>
                <label className="block text-xs font-medium text-slate-700 mb-1">案件参照（任意）</label>
                <select
                  value={formProjectId}
                  onChange={(e) => setFormProjectId(e.target.value)}
                  className="w-full rounded-lg border border-slate-300 px-3 py-1.5 bg-white"
                >
                  <option value="">紐付けなし</option>
                  {lookups.projects.map((pj) => (
                    <option key={pj.id} value={pj.id}>
                      {pj.projectNo} {pj.projectName}
                    </option>
                  ))}
                </select>
              </div>
            </div>

            <div className="rounded-lg border border-slate-200 bg-slate-50 p-3 space-y-2">
              <div className="flex items-center justify-between text-xs font-bold text-slate-700">
                <span>入金手段・金額（最大3枠）</span>
                <span className="font-mono text-blue-800">
                  合計: {formatYen(modalDepositTotal)}
                </span>
              </div>
              {[
                { m: formMethod1, setM: setFormMethod1, d: formDeposit1, setD: setFormDeposit1, label: '枠1' },
                { m: formMethod2, setM: setFormMethod2, d: formDeposit2, setD: setFormDeposit2, label: '枠2' },
                { m: formMethod3, setM: setFormMethod3, d: formDeposit3, setD: setFormDeposit3, label: '枠3' },
              ].map((slot) => (
                <div key={slot.label} className="grid grid-cols-12 gap-2 items-center">
                  <div className="col-span-2 text-xs text-slate-600">{slot.label}</div>
                  <div className="col-span-5">
                    <select
                      value={slot.m}
                      onChange={(e) => slot.setM(e.target.value)}
                      className="w-full rounded border border-slate-300 bg-white px-2 py-1 text-xs"
                    >
                      <option value="">未選択</option>
                      {lookups.paymentMethods.map((pm) => (
                        <option key={pm.methodCode} value={pm.methodCode}>
                          {pm.methodCode}: {pm.methodName}
                        </option>
                      ))}
                    </select>
                  </div>
                  <div className="col-span-5">
                    <input
                      type="number"
                      min={0}
                      value={slot.d}
                      onChange={(e) => slot.setD(e.target.value)}
                      className="w-full rounded border border-slate-300 bg-white px-2 py-1 text-xs text-right font-mono"
                    />
                  </div>
                </div>
              ))}
            </div>

            <div className="grid grid-cols-3 gap-3 text-xs">
              <div>
                <label className="block font-medium text-slate-700 mb-1">10%対象税抜(任意)</label>
                <input
                  type="number"
                  min={0}
                  value={formSub10Excl}
                  onChange={(e) => setFormSub10Excl(e.target.value)}
                  className="w-full rounded border border-slate-300 px-2.5 py-1.5 text-right font-mono"
                />
              </div>
              <div>
                <label className="block font-medium text-slate-700 mb-1">8%対象税抜(任意)</label>
                <input
                  type="number"
                  min={0}
                  value={formSub8Excl}
                  onChange={(e) => setFormSub8Excl(e.target.value)}
                  className="w-full rounded border border-slate-300 px-2.5 py-1.5 text-right font-mono"
                />
              </div>
              <div>
                <label className="block font-medium text-slate-700 mb-1">非課税対象(任意)</label>
                <input
                  type="number"
                  min={0}
                  value={formSub0}
                  onChange={(e) => setFormSub0(e.target.value)}
                  className="w-full rounded border border-slate-300 px-2.5 py-1.5 text-right font-mono"
                />
              </div>
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 text-xs">
              <div>
                <label className="block font-medium text-slate-700 mb-1">但し書き（領収書用）</label>
                <input
                  type="text"
                  value={formTadashi}
                  onChange={(e) => setFormTadashi(e.target.value)}
                  className="w-full rounded border border-slate-300 px-2.5 py-1.5"
                />
              </div>
              <div>
                <label className="block font-medium text-slate-700 mb-1">手形期日（任意）</label>
                <input
                  type="date"
                  value={formBillDueDate}
                  onChange={(e) => setFormBillDueDate(e.target.value)}
                  className="w-full rounded border border-slate-300 px-2.5 py-1.5"
                />
              </div>
            </div>

            <div>
              <label className="block text-xs font-medium text-slate-700 mb-1">備考</label>
              <input
                type="text"
                value={formRemarks}
                onChange={(e) => setFormRemarks(e.target.value)}
                className="w-full rounded border border-slate-300 px-2.5 py-1.5 text-xs"
              />
            </div>

            <div className="flex justify-end gap-2 pt-2 border-t border-slate-200">
              <button
                type="button"
                onClick={() => setModalOpen(false)}
                className="rounded-lg border border-slate-300 bg-white px-4 py-2 text-xs font-medium text-slate-700 cursor-pointer"
              >
                キャンセル
              </button>
              <button
                type="submit"
                disabled={saving}
                className="rounded-lg bg-blue-600 hover:bg-blue-700 disabled:opacity-60 px-4 py-2 text-xs font-semibold text-white cursor-pointer"
              >
                {saving ? '保存中...' : '登録する'}
              </button>
            </div>
          </form>
        </div>
      )}

      {/* 領収書スナップショット版履歴モーダル */}
      {receiptDetailModal !== null && (
        <div className="fixed inset-0 z-50 bg-slate-900/50 flex items-center justify-center p-4">
          <div className="bg-white rounded-xl max-w-3xl w-full max-h-[85vh] overflow-y-auto shadow-xl p-6 space-y-4">
            <div className="flex items-center justify-between border-b border-slate-200 pb-3">
              <div>
                <h2 className="text-base font-bold text-slate-900">
                  領収書スナップショット（入金No.{receiptDetailModal.receiptNo} /{' '}
                  {formatYen(receiptDetailModal.totalDeposit)}）
                </h2>
                <p className="text-xs text-slate-500 mt-0.5">
                  宛名: {receiptDetailModal.partnerName} / 但し: {receiptDetailModal.tadashi}
                </p>
              </div>
              <div className="flex items-center gap-2">
                {lookups.depositEnabled && (
                  <button
                    type="button"
                    disabled={saving}
                    onClick={() => void handleIssueReceiptSnapshot(receiptDetailModal.id)}
                    className="rounded-lg bg-emerald-600 hover:bg-emerald-700 disabled:opacity-60 px-3 py-1.5 text-xs font-semibold text-white cursor-pointer"
                  >
                    {receiptDetailModal.snapshots.length === 0
                      ? '領収書 (v1) を発行'
                      : '＜再発行＞として新版発行'}
                  </button>
                )}
                <button
                  type="button"
                  onClick={() => setReceiptDetailModal(null)}
                  className="rounded border border-slate-300 px-3 py-1.5 text-xs font-medium text-slate-700 cursor-pointer"
                >
                  閉じる
                </button>
              </div>
            </div>

            <table className="min-w-full divide-y divide-slate-200 text-xs">
              <thead className="bg-slate-50 text-slate-600">
                <tr>
                  <th className="px-3 py-2 text-center">版</th>
                  <th className="px-3 py-2 text-center">ラベル</th>
                  <th className="px-3 py-2 text-center">発行日時</th>
                  <th className="px-3 py-2 text-left">発行者</th>
                  <th className="px-3 py-2 text-right">PDF操作</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {receiptDetailModal.snapshots.length === 0 ? (
                  <tr>
                    <td colSpan={5} className="px-4 py-6 text-center text-slate-500">
                      領収書はまだ発行されていません。「領収書 (v1) を発行」を押下してください。
                    </td>
                  </tr>
                ) : (
                  receiptDetailModal.snapshots.map((snap) => (
                    <tr key={snap.id}>
                      <td className="px-3 py-2 text-center font-mono">v{snap.versionNo}</td>
                      <td className="px-3 py-2 text-center">
                        {snap.reissueLabel !== null ? (
                          <span className="px-1.5 py-0.5 rounded bg-red-50 border border-red-200 text-red-700 font-semibold">
                            {snap.reissueLabel}
                          </span>
                        ) : (
                          '初回発行'
                        )}
                      </td>
                      <td className="px-3 py-2 text-center font-mono">
                        {snap.issuedAt.slice(0, 19).replace('T', ' ')}
                      </td>
                      <td className="px-3 py-2">
                        {snap.issuedByName !== null ? snap.issuedByName : '-'}
                      </td>
                      <td className="px-3 py-2 text-right space-x-1.5">
                        <button
                          type="button"
                          onClick={() => setPreviewSnapshotId(snap.id)}
                          className="rounded border border-slate-300 bg-white px-2.5 py-1 font-medium text-slate-700 cursor-pointer"
                        >
                          プレビュー
                        </button>
                        <a
                          href={`/api/v1/snapshots/${encodeURIComponent(snap.id)}/pdf?download=1`}
                          className="rounded border border-blue-200 bg-blue-50 px-2.5 py-1 font-medium text-blue-700"
                        >
                          DL
                        </a>
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* PDFプレビューモーダル */}
      {previewSnapshotId !== null && (
        <div className="fixed inset-0 z-50 bg-slate-900/60 flex items-center justify-center p-4">
          <div className="bg-white rounded-xl w-full max-w-4xl h-[85vh] flex flex-col shadow-2xl overflow-hidden">
            <div className="px-4 py-3 border-b border-slate-200 flex items-center justify-between">
              <span className="text-sm font-bold text-slate-900">領収書スナップショット PDF プレビュー</span>
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
              title="領収書PDFプレビュー"
              src={`/api/v1/snapshots/${encodeURIComponent(previewSnapshotId)}/pdf`}
              className="flex-1 w-full border-0"
            />
          </div>
        </div>
      )}
    </div>
  );
}
