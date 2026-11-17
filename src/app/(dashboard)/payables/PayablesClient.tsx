'use client';

import Link from 'next/link';
import { useState } from 'react';
import { computePageCount } from '@/lib/estimates/types';
import { normalizeNullableText, requestMasterApi } from '@/lib/masters/client-api';
import type {
  PayableBalanceListResultDto,
  PayableLedgerItemDto,
  PayablesLookupsDto,
  SupplierPaymentDto,
  SupplierPaymentInput,
  SupplierPaymentPageDto,
} from '@/lib/payables/types';
import { PAYABLE_STATUS_LABELS, type PayableStatus } from '@/lib/purchasing/types';

interface PayablesClientProps {
  initialTab: 'BALANCES' | 'LEDGERS' | 'PAYMENTS';
  defaultPaymentDate: string;
  lookups: PayablesLookupsDto;
  initialBalances: PayableBalanceListResultDto | null;
  initialLedgers: PayableLedgerItemDto[];
  initialPayments: SupplierPaymentPageDto | null;
  prefillSupplierId: string | null;
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

export default function PayablesClient({
  initialTab,
  defaultPaymentDate,
  lookups,
  initialBalances,
  initialLedgers,
  initialPayments,
  prefillSupplierId,
  prefillBillNo,
  prefillAmount,
}: PayablesClientProps) {
  const [activeTab, setActiveTab] = useState<'BALANCES' | 'LEDGERS' | 'PAYMENTS'>(initialTab);
  const [bannerError, setBannerError] = useState<string | null>(null);
  const [bannerSuccess, setBannerSuccess] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);

  // 買掛残高一覧タブ
  const [balancesData, setBalancesData] = useState<PayableBalanceListResultDto | null>(
    initialBalances,
  );
  const [balStart, setBalStart] = useState(
    initialBalances !== null ? initialBalances.periodStart : defaultPaymentDate,
  );
  const [balEnd, setBalEnd] = useState(
    initialBalances !== null ? initialBalances.periodEnd : defaultPaymentDate,
  );
  const [balClosingDay, setBalClosingDay] = useState('');
  const [balKw, setBalKw] = useState('');
  const [balOnlyWithBalance, setBalOnlyWithBalance] = useState(true);

  // 買掛台帳タブ
  const [ledgerItems, setLedgerItems] = useState<PayableLedgerItemDto[]>(initialLedgers);
  const [ledgerStatus, setLedgerStatus] = useState<'' | PayableStatus>('');
  const [ledgerProjectId, setLedgerProjectId] = useState('');
  const [ledgerKw, setLedgerKw] = useState('');
  const [ledgerUnpaidOnly, setLedgerUnpaidOnly] = useState(false);

  // 支払履歴タブ
  const [paymentsData, setPaymentsData] = useState<SupplierPaymentPageDto | null>(initialPayments);
  const [payKw, setPayKw] = useState('');
  const [paySupplierId, setPaySupplierId] = useState('');
  const [payDateFrom, setPayDateFrom] = useState('');
  const [payDateTo, setPayDateTo] = useState('');

  // 支払登録/編集モーダル
  const hasPrefill =
    prefillSupplierId !== null && prefillSupplierId !== '' && lookups.paymentEnabled;
  const [modalOpen, setModalOpen] = useState(hasPrefill);
  const [editingPaymentId, setEditingPaymentId] = useState<string | null>(null);
  const [formPaymentDate, setFormPaymentDate] = useState(
    defaultPaymentDate > lookups.openingBalanceDate ? defaultPaymentDate : '',
  );
  const [formSupplierId, setFormSupplierId] = useState(
    hasPrefill && prefillSupplierId !== null ? prefillSupplierId : '',
  );
  const [formRefProjectId, setFormRefProjectId] = useState('');
  const [formMethod1, setFormMethod1] = useState('D');
  const [formAmount1, setFormAmount1] = useState(
    hasPrefill && prefillAmount !== null && Number.isFinite(prefillAmount)
      ? String(prefillAmount)
      : '0',
  );
  const [formMethod2, setFormMethod2] = useState('');
  const [formAmount2, setFormAmount2] = useState('0');
  const [formMethod3, setFormMethod3] = useState('');
  const [formAmount3, setFormAmount3] = useState('0');
  const [formDed1, setFormDed1] = useState('G');
  const [formDedAmt1, setFormDedAmt1] = useState('0');
  const [formDed2, setFormDed2] = useState('');
  const [formDedAmt2, setFormDedAmt2] = useState('0');
  const [formDed3, setFormDed3] = useState('');
  const [formDedAmt3, setFormDedAmt3] = useState('0');
  const [formSub10Excl, setFormSub10Excl] = useState('0');
  const [formSub8Excl, setFormSub8Excl] = useState('0');
  const [formSub0, setFormSub0] = useState('0');
  const [formSummaryNote, setFormSummaryNote] = useState('');
  const [formBillNo, setFormBillNo] = useState(
    hasPrefill && prefillBillNo !== null ? prefillBillNo : '',
  );
  const [formBillDueDate, setFormBillDueDate] = useState('');
  const [formRemarks, setFormRemarks] = useState('');
  const [modalError, setModalError] = useState<string | null>(null);

  function buildBalancesQueryString(): string {
    const sp = new URLSearchParams();
    if (balStart.trim() !== '') sp.set('periodStart', balStart.trim());
    if (balEnd.trim() !== '') sp.set('periodEnd', balEnd.trim());
    if (balClosingDay !== '') sp.set('closingDayCode', balClosingDay);
    if (balKw.trim() !== '') sp.set('q', balKw.trim());
    if (balOnlyWithBalance) sp.set('onlyWithBalance', '1');
    return sp.toString();
  }

  function buildPaymentsQueryString(page: number): string {
    const sp = new URLSearchParams();
    sp.set('page', String(page));
    sp.set('pageSize', '25');
    if (payKw.trim() !== '') sp.set('q', payKw.trim());
    if (paySupplierId !== '') sp.set('supplierId', paySupplierId);
    if (payDateFrom !== '') sp.set('dateFrom', payDateFrom);
    if (payDateTo !== '') sp.set('dateTo', payDateTo);
    return sp.toString();
  }

  async function reloadBalances() {
    if (!lookups.payableEnabled) return;
    setLoading(true);
    setBannerError(null);
    const res = await requestMasterApi<PayableBalanceListResultDto>(
      `/api/v1/payables/balances?${buildBalancesQueryString()}`,
    );
    setLoading(false);
    if (!res.ok) {
      setBannerError(res.error);
      return;
    }
    setBalancesData(res.data);
  }

  async function reloadLedgers() {
    if (!lookups.payableEnabled) return;
    setLoading(true);
    setBannerError(null);
    const sp = new URLSearchParams();
    if (ledgerStatus !== '') sp.set('status', ledgerStatus);
    if (ledgerProjectId !== '') sp.set('projectId', ledgerProjectId);
    if (ledgerKw.trim() !== '') sp.set('q', ledgerKw.trim());
    if (ledgerUnpaidOnly) sp.set('unpaidOnly', '1');

    const res = await requestMasterApi<{ items: PayableLedgerItemDto[] }>(
      `/api/v1/payables/ledgers?${sp.toString()}`,
    );
    setLoading(false);
    if (!res.ok) {
      setBannerError(res.error);
      return;
    }
    setLedgerItems(res.data.items);
  }

  async function reloadPayments(page = 1) {
    if (!lookups.paymentEnabled) return;
    setLoading(true);
    setBannerError(null);
    const res = await requestMasterApi<SupplierPaymentPageDto>(
      `/api/v1/payables/payments?${buildPaymentsQueryString(page)}`,
    );
    setLoading(false);
    if (!res.ok) {
      setBannerError(res.error);
      return;
    }
    setPaymentsData(res.data);
  }

  function openNewPaymentModal(prefill?: {
    supplierId?: string;
    billNo?: string;
    amount?: number;
    summaryNote?: string;
  }) {
    setEditingPaymentId(null);
    setFormPaymentDate(
      defaultPaymentDate > lookups.openingBalanceDate ? defaultPaymentDate : '',
    );
    setFormSupplierId(prefill !== undefined && prefill.supplierId !== undefined ? prefill.supplierId : '');
    setFormRefProjectId('');
    setFormMethod1('D');
    setFormAmount1(
      prefill !== undefined && prefill.amount !== undefined && prefill.amount > 0
        ? String(prefill.amount)
        : '0',
    );
    setFormMethod2('');
    setFormAmount2('0');
    setFormMethod3('');
    setFormAmount3('0');
    setFormDed1('G');
    setFormDedAmt1('0');
    setFormDed2('');
    setFormDedAmt2('0');
    setFormDed3('');
    setFormDedAmt3('0');
    setFormSub10Excl('0');
    setFormSub8Excl('0');
    setFormSub0('0');
    setFormSummaryNote(
      prefill !== undefined && prefill.summaryNote !== undefined ? prefill.summaryNote : '',
    );
    setFormBillNo(prefill !== undefined && prefill.billNo !== undefined ? prefill.billNo : '');
    setFormBillDueDate('');
    setFormRemarks('');
    setModalError(null);
    setModalOpen(true);
  }

  function openEditPaymentModal(item: SupplierPaymentDto) {
    setEditingPaymentId(item.id);
    setFormPaymentDate(item.paymentDate);
    setFormSupplierId(item.supplierId);
    setFormRefProjectId('');
    setFormMethod1(item.methodCode1 ?? 'D');
    setFormAmount1(String(item.amount1));
    setFormMethod2(item.methodCode2 ?? '');
    setFormAmount2(String(item.amount2));
    setFormMethod3(item.methodCode3 ?? '');
    setFormAmount3(String(item.amount3));
    setFormDed1(item.deductionCode1 ?? 'G');
    setFormDedAmt1(String(item.deductionAmt1));
    setFormDed2(item.deductionCode2 ?? '');
    setFormDedAmt2(String(item.deductionAmt2));
    setFormDed3(item.deductionCode3 ?? '');
    setFormDedAmt3(String(item.deductionAmt3));
    setFormSub10Excl(String(item.subtotal10Excl));
    setFormSub8Excl(String(item.subtotal8Excl));
    setFormSub0(String(item.subtotal0));
    setFormSummaryNote(item.summaryNote ?? '');
    setFormBillNo(item.billNo ?? '');
    setFormBillDueDate(item.billDueDate ?? '');
    setFormRemarks(item.remarks ?? '');
    setModalError(null);
    setModalOpen(true);
  }

  async function handleSavePayment(e: React.FormEvent) {
    e.preventDefault();
    setModalError(null);
    setBannerSuccess(null);

    if (formPaymentDate <= lookups.openingBalanceDate) {
      setModalError(
        `支払日は期首残高基準日（${lookups.openingBalanceDate}）より後の日付を指定してください。`,
      );
      return;
    }

    const payload: SupplierPaymentInput = {
      paymentDate: formPaymentDate,
      supplierId: formSupplierId,
      methodCode1: normalizeNullableText(formMethod1),
      amount1: parseIntInput(formAmount1),
      methodCode2: normalizeNullableText(formMethod2),
      amount2: parseIntInput(formAmount2),
      methodCode3: normalizeNullableText(formMethod3),
      amount3: parseIntInput(formAmount3),
      deductionCode1: normalizeNullableText(formDed1),
      deductionAmt1: parseIntInput(formDedAmt1),
      deductionCode2: normalizeNullableText(formDed2),
      deductionAmt2: parseIntInput(formDedAmt2),
      deductionCode3: normalizeNullableText(formDed3),
      deductionAmt3: parseIntInput(formDedAmt3),
      subtotal10Excl: parseIntInput(formSub10Excl),
      subtotal8Excl: parseIntInput(formSub8Excl),
      subtotal0: parseIntInput(formSub0),
      summaryNote: normalizeNullableText(formSummaryNote),
      billNo: normalizeNullableText(formBillNo),
      billDueDate: normalizeNullableText(formBillDueDate),
      remarks: normalizeNullableText(formRemarks),
    };

    setSaving(true);
    const url =
      editingPaymentId !== null
        ? `/api/v1/payables/payments/${encodeURIComponent(editingPaymentId)}`
        : '/api/v1/payables/payments';
    const method = editingPaymentId !== null ? 'PUT' : 'POST';
    const res = await requestMasterApi<{ item: SupplierPaymentDto }>(url, {
      method,
      body: JSON.stringify(payload),
    });
    setSaving(false);

    if (!res.ok) {
      setModalError(res.error);
      return;
    }

    setModalOpen(false);
    setBannerSuccess(
      `支払No.${res.data.item.paymentNo}（総充当額 ${formatYen(res.data.item.totalPayment)}）を保存しました。`,
    );
    await Promise.all([reloadPayments(1), reloadLedgers(), reloadBalances()]);
  }

  async function handleDeletePayment(item: SupplierPaymentDto) {
    if (!window.confirm(`支払No.${item.paymentNo}（${formatYen(item.totalPayment)}）を削除しますか？`)) {
      return;
    }
    setBannerError(null);
    setBannerSuccess(null);
    const res = await requestMasterApi<{ ok: boolean }>(
      `/api/v1/payables/payments/${encodeURIComponent(item.id)}`,
      { method: 'DELETE' },
    );
    if (!res.ok) {
      setBannerError(res.error);
      return;
    }
    setBannerSuccess(`支払No.${item.paymentNo} を削除し、買掛ステータスを再同期しました。`);
    await Promise.all([reloadPayments(1), reloadLedgers(), reloadBalances()]);
  }

  async function handleManualLedgerStatusChange(ledgerId: string, nextStatus: PayableStatus) {
    setBannerError(null);
    setBannerSuccess(null);
    const res = await requestMasterApi<{ item: { id: string; status: PayableStatus } }>(
      '/api/v1/payables/ledgers',
      {
        method: 'PATCH',
        body: JSON.stringify({ ledgerId, status: nextStatus }),
      },
    );
    if (!res.ok) {
      setBannerError(res.error);
      return;
    }
    setBannerSuccess(`買掛消込ステータスを ${PAYABLE_STATUS_LABELS[nextStatus]} に更新しました。`);
    await reloadLedgers();
  }

  const candidateLedgersForModal = ledgerItems.filter((l) => {
    if (formSupplierId !== '' && l.supplierId !== formSupplierId) return false;
    if (formRefProjectId !== '' && !l.projectIds.includes(formRefProjectId)) return false;
    return true;
  });

  const modalTotalPayment =
    parseIntInput(formAmount1) +
    parseIntInput(formAmount2) +
    parseIntInput(formAmount3) +
    parseIntInput(formDedAmt1) +
    parseIntInput(formDedAmt2) +
    parseIntInput(formDedAmt3);

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold text-slate-900">買掛・支払管理</h1>
          <p className="text-sm text-slate-600 mt-1">
            旧買掛集計バグ（opening_ap_balance 誤参照）を是正した期間買掛残高推移、仕入確定（P3）買掛台帳の消込、および支払登録・出力を行います。
            <span className="ml-2 text-xs text-slate-500">
              （期首残高基準日: <span className="font-mono">{lookups.openingBalanceDate}</span>）
            </span>
          </p>
        </div>
        {lookups.purchaseEnabled && (
          <Link
            href="/purchasing?tab=PURCHASES"
            className="rounded-lg border border-slate-300 bg-white px-3 py-2 text-xs font-medium text-slate-700 hover:bg-slate-50"
          >
            ← 発注・仕入管理へ
          </Link>
        )}
      </div>

      {/* タブ */}
      <div className="flex items-center gap-2 border-b border-slate-200">
        {lookups.payableEnabled && (
          <>
            <button
              type="button"
              onClick={() => setActiveTab('BALANCES')}
              className={`px-4 py-2.5 text-sm font-semibold border-b-2 transition-colors ${
                activeTab === 'BALANCES'
                  ? 'border-blue-600 text-blue-700'
                  : 'border-transparent text-slate-500 hover:text-slate-700'
              }`}
            >
              買掛残高一覧（rp_買掛一覧）
            </button>
            <button
              type="button"
              onClick={() => setActiveTab('LEDGERS')}
              className={`px-4 py-2.5 text-sm font-semibold border-b-2 transition-colors ${
                activeTab === 'LEDGERS'
                  ? 'border-blue-600 text-blue-700'
                  : 'border-transparent text-slate-500 hover:text-slate-700'
              }`}
            >
              買掛台帳・未払一覧
            </button>
          </>
        )}
        {lookups.paymentEnabled && (
          <button
            type="button"
            onClick={() => setActiveTab('PAYMENTS')}
            className={`px-4 py-2.5 text-sm font-semibold border-b-2 transition-colors ${
              activeTab === 'PAYMENTS'
                ? 'border-blue-600 text-blue-700'
                : 'border-transparent text-slate-500 hover:text-slate-700'
            }`}
          >
            支払履歴・登録
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

      {/* === タブ1: 買掛残高一覧 === */}
      {activeTab === 'BALANCES' && lookups.payableEnabled && (
        <section className="space-y-4">
          <div className="rounded-xl border border-slate-200 bg-white p-4 space-y-3">
            <div className="grid grid-cols-1 md:grid-cols-6 gap-3 items-end">
              <div>
                <label className="block text-xs font-medium text-slate-600 mb-1">
                  集計開始日 (&gt; {lookups.openingBalanceDate})
                </label>
                <input
                  type="date"
                  value={balStart}
                  onChange={(e) => setBalStart(e.target.value)}
                  className="w-full rounded-lg border border-slate-300 px-3 py-1.5 text-sm"
                />
              </div>
              <div>
                <label className="block text-xs font-medium text-slate-600 mb-1">集計終了日</label>
                <input
                  type="date"
                  value={balEnd}
                  onChange={(e) => setBalEnd(e.target.value)}
                  className="w-full rounded-lg border border-slate-300 px-3 py-1.5 text-sm"
                />
              </div>
              <div>
                <label className="block text-xs font-medium text-slate-600 mb-1">締日区分</label>
                <select
                  value={balClosingDay}
                  onChange={(e) => setBalClosingDay(e.target.value)}
                  className="w-full rounded-lg border border-slate-300 px-2 py-1.5 text-sm"
                >
                  <option value="">すべて</option>
                  {lookups.closingDays.map((c) => (
                    <option key={c.code} value={c.code}>
                      {c.name}
                    </option>
                  ))}
                </select>
              </div>
              <div className="md:col-span-2">
                <label className="block text-xs font-medium text-slate-600 mb-1">
                  仕入先コード・名称検索
                </label>
                <input
                  type="text"
                  value={balKw}
                  onChange={(e) => setBalKw(e.target.value)}
                  placeholder="仕入先名・コード"
                  className="w-full rounded-lg border border-slate-300 px-3 py-1.5 text-sm"
                />
              </div>
              <div className="flex gap-2">
                <button
                  type="button"
                  onClick={reloadBalances}
                  disabled={loading}
                  className="w-full rounded-lg bg-slate-800 px-3 py-1.5 text-sm font-medium text-white hover:bg-slate-700 disabled:opacity-50"
                >
                  集計する
                </button>
              </div>
            </div>

            <div className="flex flex-wrap items-center justify-between gap-2 pt-2 border-t border-slate-100 text-xs">
              <label className="inline-flex items-center gap-2 text-slate-700">
                <input
                  type="checkbox"
                  checked={balOnlyWithBalance}
                  onChange={(e) => setBalOnlyWithBalance(e.target.checked)}
                />
                <span>残高・期間内取引のある仕入先のみ表示</span>
              </label>
              <div className="flex items-center gap-2">
                <a
                  href={`/api/v1/payables/export?format=csv&${buildBalancesQueryString()}`}
                  className="rounded border border-slate-300 bg-white px-2.5 py-1 text-xs font-medium text-slate-700 hover:bg-slate-50"
                >
                  CSV出力
                </a>
                <a
                  href={`/api/v1/payables/export?format=pdf&${buildBalancesQueryString()}`}
                  className="rounded border border-slate-300 bg-white px-2.5 py-1 text-xs font-medium text-slate-700 hover:bg-slate-50"
                >
                  PDF出力（rp_買掛一覧）
                </a>
              </div>
            </div>
          </div>

          {balancesData !== null && (
            <>
              <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
                <div className="rounded-xl border border-slate-200 bg-white p-3">
                  <div className="text-xs text-slate-500">前回繰越買掛残高</div>
                  <div className="text-lg font-bold text-slate-900 mt-0.5">
                    {formatYen(balancesData.totals.prevCarriedBalance)}
                  </div>
                </div>
                <div className="rounded-xl border border-slate-200 bg-white p-3">
                  <div className="text-xs text-slate-500">当期仕入計上額（税込）</div>
                  <div className="text-lg font-bold text-slate-900 mt-0.5">
                    {formatYen(balancesData.totals.periodPayableIncl)}
                  </div>
                </div>
                <div className="rounded-xl border border-slate-200 bg-white p-3">
                  <div className="text-xs text-slate-500">当期支払額</div>
                  <div className="text-lg font-bold text-emerald-700 mt-0.5">
                    {formatYen(balancesData.totals.periodPaymentAmount)}
                  </div>
                </div>
                <div className="rounded-xl border border-blue-200 bg-blue-50 p-3">
                  <div className="text-xs text-blue-700">当期末買掛残高</div>
                  <div className="text-lg font-bold text-blue-900 mt-0.5">
                    {formatYen(balancesData.totals.closingApBalance)}
                  </div>
                </div>
              </div>

              <div className="rounded-xl border border-slate-200 bg-white overflow-x-auto">
                <table className="min-w-full text-sm">
                  <thead className="bg-slate-50 border-b border-slate-200 text-xs text-slate-600">
                    <tr>
                      <th className="px-3 py-2 text-left">コード</th>
                      <th className="px-3 py-2 text-left">仕入先名</th>
                      <th className="px-3 py-2 text-center">締日</th>
                      <th className="px-3 py-2 text-right">前回繰越残高</th>
                      <th className="px-3 py-2 text-right">当期仕入(税抜)</th>
                      <th className="px-3 py-2 text-right">当期消費税</th>
                      <th className="px-3 py-2 text-right">当期仕入(税込)</th>
                      <th className="px-3 py-2 text-right">当期支払額</th>
                      <th className="px-3 py-2 text-right">当期増減</th>
                      <th className="px-3 py-2 text-right">当期末買掛残高</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100">
                    {balancesData.items.length === 0 ? (
                      <tr>
                        <td colSpan={10} className="px-4 py-8 text-center text-slate-500">
                          該当する仕入先の買掛残高データはありません。
                        </td>
                      </tr>
                    ) : (
                      balancesData.items.map((row) => (
                        <tr key={row.supplierId} className="hover:bg-slate-50">
                          <td className="px-3 py-2 font-mono text-xs text-slate-500">
                            {row.partnerCode}
                          </td>
                          <td className="px-3 py-2 font-medium text-slate-900">
                            {row.partnerName}
                          </td>
                          <td className="px-3 py-2 text-center text-xs text-slate-600">
                            {row.closingDayName !== null ? row.closingDayName : '-'}
                          </td>
                          <td className="px-3 py-2 text-right font-mono">
                            {formatYen(row.prevCarriedBalance)}
                          </td>
                          <td className="px-3 py-2 text-right font-mono">
                            {formatYen(row.periodPayableExcl)}
                          </td>
                          <td className="px-3 py-2 text-right font-mono text-slate-600">
                            {formatYen(row.periodPayableTax)}
                          </td>
                          <td className="px-3 py-2 text-right font-mono font-medium">
                            {formatYen(row.periodPayableIncl)}
                          </td>
                          <td className="px-3 py-2 text-right font-mono text-emerald-700">
                            {formatYen(row.periodPaymentAmount)}
                          </td>
                          <td className="px-3 py-2 text-right font-mono">
                            {formatYen(row.periodNetDelta)}
                          </td>
                          <td className="px-3 py-2 text-right font-mono font-bold text-slate-900">
                            {formatYen(row.closingApBalance)}
                          </td>
                        </tr>
                      ))
                    )}
                  </tbody>
                </table>
              </div>
            </>
          )}
        </section>
      )}

      {/* === タブ2: 買掛台帳・未払一覧 === */}
      {activeTab === 'LEDGERS' && lookups.payableEnabled && (
        <section className="space-y-4">
          <div className="rounded-xl border border-slate-200 bg-white p-4 grid grid-cols-1 md:grid-cols-5 gap-3 items-end">
            <div>
              <label className="block text-xs font-medium text-slate-600 mb-1">検索</label>
              <input
                type="text"
                value={ledgerKw}
                onChange={(e) => setLedgerKw(e.target.value)}
                placeholder="仕入No・件名・仕入先"
                className="w-full rounded-lg border border-slate-300 px-3 py-1.5 text-sm"
              />
            </div>
            <div>
              <label className="block text-xs font-medium text-slate-600 mb-1">案件参照</label>
              <select
                value={ledgerProjectId}
                onChange={(e) => setLedgerProjectId(e.target.value)}
                className="w-full rounded-lg border border-slate-300 px-2 py-1.5 text-sm"
              >
                <option value="">すべて</option>
                {lookups.projects.map((pj) => (
                  <option key={pj.id} value={pj.id}>
                    {pj.projectNo} {pj.projectName}
                  </option>
                ))}
              </select>
            </div>
            <div>
              <label className="block text-xs font-medium text-slate-600 mb-1">状態</label>
              <select
                value={ledgerStatus}
                onChange={(e) => setLedgerStatus(e.target.value as '' | PayableStatus)}
                className="w-full rounded-lg border border-slate-300 px-2 py-1.5 text-sm"
              >
                <option value="">すべて</option>
                <option value="A1">A1: 未払</option>
                <option value="A2">A2: 支払済</option>
              </select>
            </div>
            <label className="inline-flex items-center gap-2 text-sm text-slate-700 pb-1.5">
              <input
                type="checkbox"
                checked={ledgerUnpaidOnly}
                onChange={(e) => setLedgerUnpaidOnly(e.target.checked)}
              />
              <span>未払のみ表示</span>
            </label>
            <button
              type="button"
              onClick={reloadLedgers}
              disabled={loading}
              className="rounded-lg bg-slate-800 px-3 py-1.5 text-sm font-medium text-white hover:bg-slate-700"
            >
              検索
            </button>
          </div>

          <div className="rounded-xl border border-slate-200 bg-white overflow-x-auto">
            <table className="min-w-full text-sm">
              <thead className="bg-slate-50 border-b border-slate-200 text-xs text-slate-600">
                <tr>
                  <th className="px-3 py-2 text-right">仕入No</th>
                  <th className="px-3 py-2 text-left">仕入日</th>
                  <th className="px-3 py-2 text-left">仕入先名</th>
                  <th className="px-3 py-2 text-left">件名 / 関連案件</th>
                  <th className="px-3 py-2 text-left">支払予定日</th>
                  <th className="px-3 py-2 text-right">買掛金額</th>
                  <th className="px-3 py-2 text-right">既払額</th>
                  <th className="px-3 py-2 text-right">残高</th>
                  <th className="px-3 py-2 text-center">消込状態</th>
                  <th className="px-3 py-2 text-right">操作</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {ledgerItems.length === 0 ? (
                  <tr>
                    <td colSpan={10} className="px-4 py-8 text-center text-slate-500">
                      確定済（P3）の買掛台帳データはありません。
                    </td>
                  </tr>
                ) : (
                  ledgerItems.map((item) => (
                    <tr key={item.id} className="hover:bg-slate-50">
                      <td className="px-3 py-2 text-right font-mono font-semibold">
                        {item.purchaseNo}
                      </td>
                      <td className="px-3 py-2 font-mono text-xs">{item.purchaseDate}</td>
                      <td className="px-3 py-2 font-medium text-slate-900">{item.supplierName}</td>
                      <td className="px-3 py-2">
                        <div className="font-medium text-slate-900">{item.purchaseName}</div>
                        {item.projectSummary !== null && (
                          <div className="text-[11px] text-slate-500">{item.projectSummary}</div>
                        )}
                      </td>
                      <td className="px-3 py-2 font-mono text-xs text-slate-600">
                        {item.scheduledPayAt !== null ? item.scheduledPayAt : '-'}
                      </td>
                      <td className="px-3 py-2 text-right font-mono">
                        {formatYen(item.payableAmount)}
                      </td>
                      <td className="px-3 py-2 text-right font-mono text-emerald-700">
                        {formatYen(item.paidAmount)}
                      </td>
                      <td className="px-3 py-2 text-right font-mono font-semibold">
                        {formatYen(item.remainingAmount)}
                      </td>
                      <td className="px-3 py-2 text-center">
                        {lookups.paymentEnabled ? (
                          <select
                            value={item.status}
                            onChange={(e) =>
                              handleManualLedgerStatusChange(
                                item.id,
                                e.target.value as PayableStatus,
                              )
                            }
                            className="rounded border border-slate-300 px-2 py-0.5 text-xs"
                          >
                            <option value="A1">A1: 未払</option>
                            <option value="A2">A2: 支払済</option>
                          </select>
                        ) : (
                          <span className="text-xs">{PAYABLE_STATUS_LABELS[item.status]}</span>
                        )}
                      </td>
                      <td className="px-3 py-2 text-right">
                        {lookups.paymentEnabled && (
                          <button
                            type="button"
                            onClick={() =>
                              openNewPaymentModal({
                                supplierId: item.supplierId,
                                billNo: String(item.purchaseNo),
                                amount: item.remainingAmount > 0 ? item.remainingAmount : item.payableAmount,
                                summaryNote: item.purchaseName,
                              })
                            }
                            className="rounded border border-emerald-300 bg-emerald-50 px-2.5 py-1 text-xs font-medium text-emerald-800 hover:bg-emerald-100"
                          >
                            支払登録
                          </button>
                        )}
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
        </section>
      )}

      {/* === タブ3: 支払履歴・登録 === */}
      {activeTab === 'PAYMENTS' && lookups.paymentEnabled && paymentsData !== null && (
        <section className="space-y-4">
          <div className="rounded-xl border border-slate-200 bg-white p-4 space-y-3">
            <div className="grid grid-cols-1 md:grid-cols-6 gap-3 items-end">
              <div className="md:col-span-2">
                <label className="block text-xs font-medium text-slate-600 mb-1">検索</label>
                <input
                  type="text"
                  value={payKw}
                  onChange={(e) => setPayKw(e.target.value)}
                  placeholder="支払No・仕入先・対象仕入No・摘要"
                  className="w-full rounded-lg border border-slate-300 px-3 py-1.5 text-sm"
                />
              </div>
              <div>
                <label className="block text-xs font-medium text-slate-600 mb-1">仕入先</label>
                <select
                  value={paySupplierId}
                  onChange={(e) => setPaySupplierId(e.target.value)}
                  className="w-full rounded-lg border border-slate-300 px-2 py-1.5 text-sm"
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
                <label className="block text-xs font-medium text-slate-600 mb-1">支払日(自)</label>
                <input
                  type="date"
                  value={payDateFrom}
                  onChange={(e) => setPayDateFrom(e.target.value)}
                  className="w-full rounded-lg border border-slate-300 px-2 py-1.5 text-sm"
                />
              </div>
              <div>
                <label className="block text-xs font-medium text-slate-600 mb-1">支払日(至)</label>
                <input
                  type="date"
                  value={payDateTo}
                  onChange={(e) => setPayDateTo(e.target.value)}
                  className="w-full rounded-lg border border-slate-300 px-2 py-1.5 text-sm"
                />
              </div>
              <div className="flex gap-2">
                <button
                  type="button"
                  onClick={() => reloadPayments(1)}
                  disabled={loading}
                  className="rounded-lg bg-slate-800 px-3 py-1.5 text-sm font-medium text-white hover:bg-slate-700"
                >
                  検索
                </button>
                <button
                  type="button"
                  onClick={() => openNewPaymentModal()}
                  className="rounded-lg bg-blue-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-blue-700"
                >
                  + 新規支払
                </button>
              </div>
            </div>

            <div className="flex flex-wrap items-center justify-between gap-2 pt-2 border-t border-slate-100 text-xs text-slate-600">
              <span>
                件数: {paymentsData.summary.totalCount} 件 | 支払計:{' '}
                <strong className="font-mono">{formatYen(paymentsData.summary.sumPaymentSubtotal)}</strong> |
                控除計:{' '}
                <strong className="font-mono">{formatYen(paymentsData.summary.sumDeductionTotal)}</strong> |
                総充当額:{' '}
                <strong className="font-mono text-blue-800">
                  {formatYen(paymentsData.summary.sumTotalPayment)}
                </strong>
              </span>
              <div className="flex gap-2">
                <a
                  href={`/api/v1/payables/payments/export?format=csv&${buildPaymentsQueryString(1)}`}
                  className="rounded border border-slate-300 bg-white px-2.5 py-1 text-xs font-medium text-slate-700 hover:bg-slate-50"
                >
                  CSV出力
                </a>
                <a
                  href={`/api/v1/payables/payments/export?format=pdf&${buildPaymentsQueryString(1)}`}
                  className="rounded border border-slate-300 bg-white px-2.5 py-1 text-xs font-medium text-slate-700 hover:bg-slate-50"
                >
                  支払一覧PDF出力
                </a>
              </div>
            </div>
          </div>

          <div className="rounded-xl border border-slate-200 bg-white overflow-x-auto">
            <table className="min-w-full text-sm">
              <thead className="bg-slate-50 border-b border-slate-200 text-xs text-slate-600">
                <tr>
                  <th className="px-3 py-2 text-right">支払No</th>
                  <th className="px-3 py-2 text-left">支払日</th>
                  <th className="px-3 py-2 text-left">仕入先名</th>
                  <th className="px-3 py-2 text-right">支払額計</th>
                  <th className="px-3 py-2 text-right">控除額計</th>
                  <th className="px-3 py-2 text-right">総充当額</th>
                  <th className="px-3 py-2 text-left">対象仕入No</th>
                  <th className="px-3 py-2 text-left">摘要・備考</th>
                  <th className="px-3 py-2 text-right">操作</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {paymentsData.items.length === 0 ? (
                  <tr>
                    <td colSpan={9} className="px-4 py-8 text-center text-slate-500">
                      登録された支払履歴はありません。
                    </td>
                  </tr>
                ) : (
                  paymentsData.items.map((item) => (
                    <tr key={item.id} className="hover:bg-slate-50">
                      <td className="px-3 py-2 text-right font-mono font-semibold">
                        {item.paymentNo}
                      </td>
                      <td className="px-3 py-2 font-mono text-xs">{item.paymentDate}</td>
                      <td className="px-3 py-2 font-medium text-slate-900">{item.supplierName}</td>
                      <td className="px-3 py-2 text-right font-mono">
                        {formatYen(item.paymentSubtotal)}
                      </td>
                      <td className="px-3 py-2 text-right font-mono text-slate-600">
                        {formatYen(item.deductionTotal)}
                      </td>
                      <td className="px-3 py-2 text-right font-mono font-bold text-slate-900">
                        {formatYen(item.totalPayment)}
                      </td>
                      <td className="px-3 py-2 font-mono text-xs">
                        {item.billNo !== null ? `仕入No.${item.billNo}` : '-'}
                      </td>
                      <td className="px-3 py-2 text-xs text-slate-600">
                        {item.summaryNote ?? item.remarks ?? '-'}
                      </td>
                      <td className="px-3 py-2 text-right whitespace-nowrap space-x-1.5">
                        <button
                          type="button"
                          onClick={() => openEditPaymentModal(item)}
                          className="rounded border border-slate-300 px-2 py-1 text-xs text-slate-700 hover:bg-slate-100"
                        >
                          編集
                        </button>
                        <button
                          type="button"
                          onClick={() => handleDeletePayment(item)}
                          className="rounded border border-red-200 px-2 py-1 text-xs text-red-700 hover:bg-red-50"
                        >
                          削除
                        </button>
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>

          <div className="flex items-center justify-between text-xs text-slate-600">
            <span>
              ページ {paymentsData.page} /{' '}
              {computePageCount(paymentsData.summary.totalCount, paymentsData.pageSize)}
            </span>
            <div className="flex gap-2">
              <button
                type="button"
                disabled={paymentsData.page <= 1}
                onClick={() => reloadPayments(paymentsData.page - 1)}
                className="rounded border border-slate-300 px-2.5 py-1 disabled:opacity-40"
              >
                前へ
              </button>
              <button
                type="button"
                disabled={
                  paymentsData.page >=
                  computePageCount(paymentsData.summary.totalCount, paymentsData.pageSize)
                }
                onClick={() => reloadPayments(paymentsData.page + 1)}
                className="rounded border border-slate-300 px-2.5 py-1 disabled:opacity-40"
              >
                次へ
              </button>
            </div>
          </div>
        </section>
      )}

      {/* === 支払登録/編集モーダル === */}
      {modalOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
          <div className="w-full max-w-3xl max-h-[92vh] overflow-y-auto rounded-2xl bg-white shadow-xl border border-slate-200 p-6 space-y-4">
            <div className="flex items-center justify-between border-b border-slate-200 pb-3">
              <div>
                <h2 className="text-lg font-bold text-slate-900">
                  {editingPaymentId !== null ? '支払データ編集' : '新規支払登録'}
                </h2>
                <p className="text-xs text-slate-500 mt-0.5">
                  支払日は期首残高基準日（{lookups.openingBalanceDate}）より後の日付のみ登録可能です。
                </p>
              </div>
              <button
                type="button"
                onClick={() => setModalOpen(false)}
                className="rounded-lg border border-slate-300 px-3 py-1 text-xs text-slate-600 hover:bg-slate-100"
              >
                閉じる
              </button>
            </div>

            {modalError !== null && (
              <div className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-800">
                {modalError}
              </div>
            )}

            <form onSubmit={handleSavePayment} className="space-y-4">
              <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                <div>
                  <label className="block text-xs font-medium text-slate-700 mb-1">支払日 *</label>
                  <input
                    type="date"
                    required
                    value={formPaymentDate}
                    onChange={(e) => setFormPaymentDate(e.target.value)}
                    className="w-full rounded-lg border border-slate-300 px-3 py-1.5 text-sm"
                  />
                </div>
                <div>
                  <label className="block text-xs font-medium text-slate-700 mb-1">仕入先 *</label>
                  <select
                    required
                    value={formSupplierId}
                    onChange={(e) => setFormSupplierId(e.target.value)}
                    className="w-full rounded-lg border border-slate-300 px-2 py-1.5 text-sm"
                  >
                    <option value="">-- 仕入先を選択 --</option>
                    {lookups.partners.map((p) => (
                      <option key={p.id} value={p.id}>
                        {p.partnerCode} {p.partnerName}
                      </option>
                    ))}
                  </select>
                </div>
                <div>
                  <label className="block text-xs font-medium text-slate-700 mb-1">
                    案件参照選択（買掛絞込・摘要補完）
                  </label>
                  <select
                    value={formRefProjectId}
                    onChange={(e) => {
                      const nextProjId = e.target.value;
                      setFormRefProjectId(nextProjId);
                      const proj = lookups.projects.find((pj) => pj.id === nextProjId);
                      if (proj !== undefined && formSummaryNote.trim() === '') {
                        setFormSummaryNote(`案件No.${proj.projectNo} ${proj.projectName}`);
                      }
                    }}
                    className="w-full rounded-lg border border-slate-300 px-2 py-1.5 text-sm"
                  >
                    <option value="">（指定なし）</option>
                    {lookups.projects.map((pj) => (
                      <option key={pj.id} value={pj.id}>
                        {pj.projectNo} {pj.projectName}
                      </option>
                    ))}
                  </select>
                </div>
                <div>
                  <label className="block text-xs font-medium text-slate-700 mb-1">
                    対象仕入No（買掛消込連動）
                  </label>
                  <div className="flex gap-1.5">
                    <input
                      type="text"
                      value={formBillNo}
                      onChange={(e) => setFormBillNo(e.target.value)}
                      placeholder="例: 8"
                      className="w-28 rounded-lg border border-slate-300 px-2 py-1.5 text-sm font-mono"
                    />
                    <select
                      value=""
                      onChange={(e) => {
                        const l = candidateLedgersForModal.find(
                          (item) => String(item.purchaseNo) === e.target.value,
                        );
                        if (l === undefined) return;
                        setFormSupplierId(l.supplierId);
                        setFormBillNo(String(l.purchaseNo));
                        if (parseIntInput(formAmount1) === 0) {
                          setFormAmount1(String(l.remainingAmount > 0 ? l.remainingAmount : l.payableAmount));
                        }
                        if (formSummaryNote.trim() === '') {
                          setFormSummaryNote(l.purchaseName);
                        }
                      }}
                      className="flex-1 rounded-lg border border-slate-300 px-2 py-1.5 text-xs"
                    >
                      <option value="">買掛候補から選択...</option>
                      {candidateLedgersForModal.map((l) => (
                        <option key={l.id} value={String(l.purchaseNo)}>
                          仕入No.{l.purchaseNo} ({l.supplierName}) 残{formatYen(l.remainingAmount)}
                        </option>
                      ))}
                    </select>
                  </div>
                </div>
              </div>

              {/* 支払内訳1〜3 */}
              <div className="rounded-xl border border-slate-200 p-3 space-y-2">
                <div className="text-xs font-semibold text-slate-700">支払方法内訳（1〜3）</div>
                <div className="grid grid-cols-1 md:grid-cols-3 gap-2">
                  {[
                    { code: formMethod1, setCode: setFormMethod1, amt: formAmount1, setAmt: setFormAmount1, label: '支払1' },
                    { code: formMethod2, setCode: setFormMethod2, amt: formAmount2, setAmt: setFormAmount2, label: '支払2' },
                    { code: formMethod3, setCode: setFormMethod3, amt: formAmount3, setAmt: setFormAmount3, label: '支払3' },
                  ].map((slot) => (
                    <div key={slot.label} className="space-y-1">
                      <label className="text-[11px] text-slate-500">{slot.label}</label>
                      <select
                        value={slot.code}
                        onChange={(e) => slot.setCode(e.target.value)}
                        className="w-full rounded border border-slate-300 px-2 py-1 text-xs"
                      >
                        <option value="">（なし）</option>
                        {lookups.paymentMethods.map((m) => (
                          <option key={m.methodCode} value={m.methodCode}>
                            {m.methodCode}: {m.methodName}
                          </option>
                        ))}
                      </select>
                      <input
                        type="number"
                        min={0}
                        value={slot.amt}
                        onChange={(e) => slot.setAmt(e.target.value)}
                        className="w-full rounded border border-slate-300 px-2 py-1 text-xs text-right font-mono"
                      />
                    </div>
                  ))}
                </div>
              </div>

              {/* 控除内訳1〜3 */}
              <div className="rounded-xl border border-slate-200 p-3 space-y-2">
                <div className="text-xs font-semibold text-slate-700">
                  控除内訳（振込手数料・相殺など 1〜3）
                </div>
                <div className="grid grid-cols-1 md:grid-cols-3 gap-2">
                  {[
                    { code: formDed1, setCode: setFormDed1, amt: formDedAmt1, setAmt: setFormDedAmt1, label: '控除1' },
                    { code: formDed2, setCode: setFormDed2, amt: formDedAmt2, setAmt: setFormDedAmt2, label: '控除2' },
                    { code: formDed3, setCode: setFormDed3, amt: formDedAmt3, setAmt: setFormDedAmt3, label: '控除3' },
                  ].map((slot) => (
                    <div key={slot.label} className="space-y-1">
                      <label className="text-[11px] text-slate-500">{slot.label}</label>
                      <select
                        value={slot.code}
                        onChange={(e) => slot.setCode(e.target.value)}
                        className="w-full rounded border border-slate-300 px-2 py-1 text-xs"
                      >
                        <option value="">（なし）</option>
                        {lookups.paymentMethods.map((m) => (
                          <option key={m.methodCode} value={m.methodCode}>
                            {m.methodCode}: {m.methodName}
                          </option>
                        ))}
                      </select>
                      <input
                        type="number"
                        min={0}
                        value={slot.amt}
                        onChange={(e) => slot.setAmt(e.target.value)}
                        className="w-full rounded border border-slate-300 px-2 py-1 text-xs text-right font-mono"
                      />
                    </div>
                  ))}
                </div>
              </div>

              <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
                <div>
                  <label className="block text-xs font-medium text-slate-700 mb-1">手形期日</label>
                  <input
                    type="date"
                    value={formBillDueDate}
                    onChange={(e) => setFormBillDueDate(e.target.value)}
                    className="w-full rounded-lg border border-slate-300 px-3 py-1.5 text-sm"
                  />
                </div>
                <div>
                  <label className="block text-xs font-medium text-slate-700 mb-1">摘要</label>
                  <input
                    type="text"
                    value={formSummaryNote}
                    onChange={(e) => setFormSummaryNote(e.target.value)}
                    className="w-full rounded-lg border border-slate-300 px-3 py-1.5 text-sm"
                  />
                </div>
                <div>
                  <label className="block text-xs font-medium text-slate-700 mb-1">備考</label>
                  <input
                    type="text"
                    value={formRemarks}
                    onChange={(e) => setFormRemarks(e.target.value)}
                    className="w-full rounded-lg border border-slate-300 px-3 py-1.5 text-sm"
                  />
                </div>
              </div>

              <div className="flex items-center justify-between border-t border-slate-200 pt-3">
                <div className="text-sm font-bold text-slate-900">
                  総充当額（支払＋控除）: <span className="font-mono text-blue-700">{formatYen(modalTotalPayment)}</span>
                </div>
                <div className="flex gap-2">
                  <button
                    type="button"
                    onClick={() => setModalOpen(false)}
                    className="rounded-lg border border-slate-300 px-4 py-2 text-sm text-slate-700 hover:bg-slate-50"
                  >
                    キャンセル
                  </button>
                  <button
                    type="submit"
                    disabled={saving}
                    className="rounded-lg bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-50"
                  >
                    {saving ? '保存中...' : '支払を保存'}
                  </button>
                </div>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}
