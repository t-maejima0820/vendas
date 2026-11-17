'use client';

import Link from 'next/link';
import { useMemo, useState } from 'react';
import {
  calculateSubscriptionContractLine,
  type RoundingMode,
  type TaxCode,
} from '@/lib/domain/calculations';
import { requestMasterApi, normalizeNullableText } from '@/lib/masters/client-api';
import {
  APPROVAL_STATUS_LABELS,
  ENTRY_TYPE_LABELS,
  type ApprovalStatus,
  type SalesEntryType,
} from '@/lib/sales/types';
import {
  SUBSCRIPTION_OUTPUT_TYPES,
  type ExecuteSubscriptionBillingResultDto,
  type SubscriptionBillingHistoryItemDto,
  type SubscriptionContractDto,
  type SubscriptionContractInput,
  type SubscriptionListResultDto,
  type SubscriptionLookupsDto,
  type SubscriptionMonthlyApprovalItemDto,
  type SubscriptionMonthlyApprovalResultDto,
  type SubscriptionOutputType,
} from '@/lib/subscriptions/types';

interface SubscriptionsClientProps {
  lookups: SubscriptionLookupsDto;
  initialContracts: SubscriptionListResultDto;
  initialMonthlyFlows: SubscriptionMonthlyApprovalResultDto;
  initialBillingHistory: SubscriptionBillingHistoryItemDto[];
}

function formatYen(amount: number): string {
  return `¥${amount.toLocaleString('ja-JP')}`;
}

function formatMonthDisplay(yyyymm: string): string {
  if (yyyymm.length !== 6) return yyyymm;
  return `${yyyymm.slice(0, 4)}-${yyyymm.slice(4, 6)}`;
}

function parseIntegerYenSafe(raw: string): bigint {
  const cleaned = raw.trim().replace(/,/g, '');
  if (/^-?\d+$/.test(cleaned)) {
    return BigInt(cleaned);
  }
  return 0n;
}

function parseQuantitySafe(raw: string): string {
  const cleaned = raw.trim();
  if (/^-?\d+(\.\d{1,4})?$/.test(cleaned)) {
    return cleaned;
  }
  return '0';
}

export default function SubscriptionsClient({
  lookups,
  initialContracts,
  initialMonthlyFlows,
  initialBillingHistory,
}: SubscriptionsClientProps) {
  const [activeTab, setActiveTab] = useState<'contracts' | 'flows'>('contracts');

  // 契約一覧状態
  const [contractsData, setContractsData] = useState<SubscriptionListResultDto>(initialContracts);
  const [kw, setKw] = useState('');
  const [filterPartnerId, setFilterPartnerId] = useState('');
  const [filterEntryType, setFilterEntryType] = useState<'ALL' | SalesEntryType>('ALL');
  const [filterActive, setFilterActive] = useState<'ALL' | 'ACTIVE' | 'INACTIVE'>('ALL');

  // 契約編集モーダル状態
  const [modalOpen, setModalOpen] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [formPartnerId, setFormPartnerId] = useState('');
  const [formEntryType, setFormEntryType] = useState<SalesEntryType>('SALE');
  const [formSeqNo, setFormSeqNo] = useState('');
  const [formProductId, setFormProductId] = useState('');
  const [formItemName, setFormItemName] = useState('');
  const [formMonthLabel, setFormMonthLabel] = useState('');
  const [formUnitName, setFormUnitName] = useState('式');
  const [formQuantity, setFormQuantity] = useState('1');
  const [formMasterPrice, setFormMasterPrice] = useState<number | null>(null);
  const [formAppliedPrice, setFormAppliedPrice] = useState('0');
  const [formTaxCode, setFormTaxCode] = useState<TaxCode>('A');
  const [formRoundingMode, setFormRoundingMode] = useState<RoundingMode>(lookups.defaultRoundingMode);
  const [formOutputType, setFormOutputType] = useState<SubscriptionOutputType>('印刷');
  const [formIsActive, setFormIsActive] = useState(true);
  const [modalError, setModalError] = useState<string | null>(null);

  // 月次承認フロー状態
  const [flowsData, setFlowsData] = useState<SubscriptionMonthlyApprovalResultDto>(initialMonthlyFlows);
  const [monthInput, setMonthInput] = useState(formatMonthDisplay(initialMonthlyFlows.targetMonth));
  const [flowKw, setFlowKw] = useState('');
  const [flowEntryType, setFlowEntryType] = useState<'ALL' | SalesEntryType>('ALL');
  const [flowRemarksMap, setFlowRemarksMap] = useState<Record<string, string>>(() => {
    const map: Record<string, string> = {};
    for (const item of initialMonthlyFlows.items) {
      map[`${item.partnerId}:${item.entryType}`] = item.remarks !== null ? item.remarks : '';
    }
    return map;
  });
  const [selectedFlowKeys, setSelectedFlowKeys] = useState<string[]>([]);
  const [billingHistory, setBillingHistory] = useState<SubscriptionBillingHistoryItemDto[]>(
    initialBillingHistory,
  );
  const [execBillingDate, setExecBillingDate] = useState(() =>
    new Date().toISOString().slice(0, 10),
  );
  const [execPaymentDueDate, setExecPaymentDueDate] = useState('');
  const [execTemplateVariant, setExecTemplateVariant] = useState<'10_ROWS' | '20_ROWS'>(
    lookups.quotationTemplateRows,
  );
  const [previewSnapshotId, setPreviewSnapshotId] = useState<string | null>(null);

  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [bannerError, setBannerError] = useState<string | null>(null);
  const [bannerSuccess, setBannerSuccess] = useState<string | null>(null);

  // モーダル内リアルタイム税計算（Rule G4: calculations.ts）
  const liveModalCalc = useMemo(() => {
    return calculateSubscriptionContractLine({
      quantity: parseQuantitySafe(formQuantity),
      appliedUnitPrice: parseIntegerYenSafe(formAppliedPrice),
      taxCode: formTaxCode,
      roundingMode: formRoundingMode,
    });
  }, [formQuantity, formAppliedPrice, formTaxCode, formRoundingMode]);

  async function reloadContracts() {
    setLoading(true);
    setBannerError(null);
    const params = new URLSearchParams();
    if (kw.trim() !== '') params.set('q', kw.trim());
    if (filterPartnerId !== '') params.set('partnerId', filterPartnerId);
    if (filterEntryType !== 'ALL') params.set('entryType', filterEntryType);
    if (filterActive !== 'ALL') params.set('active', filterActive);

    const res = await requestMasterApi<SubscriptionListResultDto>(
      `/api/v1/subscriptions?${params.toString()}`,
    );
    setLoading(false);
    if (!res.ok) {
      setBannerError(res.error);
      return;
    }
    setContractsData({
      items: res.data.items,
      partnerSummaries: res.data.partnerSummaries,
      totals: res.data.totals,
    });
  }

  async function reloadMonthlyFlows(targetMonthStr: string = monthInput) {
    setLoading(true);
    setBannerError(null);
    const yyyymm = targetMonthStr.replace(/-/g, '');
    const params = new URLSearchParams();
    params.set('targetMonth', yyyymm);
    if (flowKw.trim() !== '') params.set('q', flowKw.trim());
    if (flowEntryType !== 'ALL') params.set('entryType', flowEntryType);

    const [res, histRes] = await Promise.all([
      requestMasterApi<SubscriptionMonthlyApprovalResultDto>(
        `/api/v1/subscriptions/approval-flows?${params.toString()}`,
      ),
      requestMasterApi<{ items: SubscriptionBillingHistoryItemDto[] }>(
        `/api/v1/subscriptions/execute-billing?targetMonth=${encodeURIComponent(yyyymm)}`,
      ),
    ]);
    setLoading(false);
    if (!res.ok) {
      setBannerError(res.error);
      return;
    }
    if (histRes.ok) {
      setBillingHistory(histRes.data.items);
    }
    setSelectedFlowKeys([]);
    setFlowsData({
      targetMonth: res.data.targetMonth,
      items: res.data.items,
      totals: res.data.totals,
    });
    const nextRemarks: Record<string, string> = {};
    for (const item of res.data.items) {
      nextRemarks[`${item.partnerId}:${item.entryType}`] =
        item.remarks !== null ? item.remarks : '';
    }
    setFlowRemarksMap(nextRemarks);
  }

  function openCreateModal() {
    setEditingId(null);
    setFormPartnerId('');
    setFormEntryType('SALE');
    setFormSeqNo('');
    setFormProductId('');
    setFormItemName('');
    setFormMonthLabel('');
    setFormUnitName('式');
    setFormQuantity('1');
    setFormMasterPrice(null);
    setFormAppliedPrice('0');
    setFormTaxCode('A');
    setFormRoundingMode(lookups.defaultRoundingMode);
    setFormOutputType('印刷');
    setFormIsActive(true);
    setModalError(null);
    setModalOpen(true);
  }

  function openEditModal(item: SubscriptionContractDto) {
    setEditingId(item.id);
    setFormPartnerId(item.partnerId);
    setFormEntryType(item.entryType);
    setFormSeqNo(String(item.subscSeqNo));
    setFormProductId(item.productId !== null ? item.productId : '');
    setFormItemName(item.itemName);
    setFormMonthLabel(item.monthLabel !== null ? item.monthLabel : '');
    setFormUnitName(item.unitName !== null ? item.unitName : '');
    setFormQuantity(String(item.quantity));
    setFormMasterPrice(item.masterUnitPrice);
    setFormAppliedPrice(String(item.appliedUnitPrice));
    setFormTaxCode(item.taxCode);
    setFormRoundingMode(item.roundingMode);
    setFormOutputType(item.outputType);
    setFormIsActive(item.isActive);
    setModalError(null);
    setModalOpen(true);
  }

  function handleSelectProduct(prodId: string) {
    setFormProductId(prodId);
    const prod = lookups.products.find((p) => p.id === prodId);
    if (prod !== undefined) {
      setFormItemName(prod.productName);
      setFormUnitName(prod.unitName !== null ? prod.unitName : '');
      setFormMasterPrice(prod.standardUnitPrice);
      setFormAppliedPrice(String(prod.standardUnitPrice));
      setFormTaxCode(prod.defaultTaxCode);
    }
  }

  async function handleSaveContract(e: React.FormEvent) {
    e.preventDefault();
    setModalError(null);
    setBannerSuccess(null);

    if (formPartnerId === '') {
      setModalError('取引先を選択してください。');
      return;
    }

    const seqTrimmed = formSeqNo.trim();
    const subscSeqNo = seqTrimmed !== '' ? Number(seqTrimmed) : null;

    const payload: SubscriptionContractInput = {
      partnerId: formPartnerId,
      entryType: formEntryType,
      subscSeqNo,
      productId: formProductId !== '' ? formProductId : null,
      itemName: formItemName.trim(),
      monthLabel: normalizeNullableText(formMonthLabel),
      unitName: normalizeNullableText(formUnitName),
      quantity: Number(parseQuantitySafe(formQuantity)),
      masterUnitPrice: formMasterPrice,
      appliedUnitPrice: Number(parseIntegerYenSafe(formAppliedPrice)),
      taxCode: formTaxCode,
      roundingMode: formRoundingMode,
      outputType: formOutputType,
      isActive: formIsActive,
    };

    setSaving(true);
    const url =
      editingId === null
        ? '/api/v1/subscriptions'
        : `/api/v1/subscriptions/${encodeURIComponent(editingId)}`;
    const method = editingId === null ? 'POST' : 'PUT';
    const res = await requestMasterApi<{ item: SubscriptionContractDto }>(url, {
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
      editingId === null
        ? `定額契約「${res.data.item.itemName}」を登録しました。`
        : `定額契約「${res.data.item.itemName}」を更新しました。`,
    );
    await reloadContracts();
    if (activeTab === 'flows') {
      await reloadMonthlyFlows();
    }
  }

  async function handleDeleteContract(item: SubscriptionContractDto) {
    if (!window.confirm(`定額契約「${item.partnerName} - ${item.itemName}」を削除しますか？`)) return;
    setBannerError(null);
    setBannerSuccess(null);
    setSaving(true);
    const res = await requestMasterApi<{ ok: true }>(
      `/api/v1/subscriptions/${encodeURIComponent(item.id)}`,
      { method: 'DELETE' },
    );
    setSaving(false);
    if (!res.ok) {
      setBannerError(res.error);
      return;
    }
    setBannerSuccess(`定額契約「${item.itemName}」を削除しました。`);
    await reloadContracts();
  }

  function toggleFlowKey(key: string) {
    setSelectedFlowKeys((prev) =>
      prev.includes(key) ? prev.filter((k) => k !== key) : [...prev, key],
    );
  }

  function toggleAllFlowKeys() {
    const allKeys = flowsData.items.map((i) => `${i.partnerId}:${i.entryType}`);
    if (allKeys.length === 0) return;
    if (selectedFlowKeys.length === allKeys.length) {
      setSelectedFlowKeys([]);
    } else {
      setSelectedFlowKeys(allKeys);
    }
  }

  async function updateFlowRows(
    targets: SubscriptionMonthlyApprovalItemDto[],
    flowStatus: ApprovalStatus,
  ) {
    if (targets.length === 0) return;
    setBannerError(null);
    setBannerSuccess(null);
    setSaving(true);
    const res = await requestMasterApi<{ updatedCount: number }>(
      '/api/v1/subscriptions/approval-flows',
      {
        method: 'PUT',
        body: JSON.stringify({
          targetMonth: flowsData.targetMonth,
          items: targets.map((t) => {
            const key = `${t.partnerId}:${t.entryType}`;
            const rawRem = flowRemarksMap[key] !== undefined ? flowRemarksMap[key] : '';
            return {
              partnerId: t.partnerId,
              entryType: t.entryType,
              flowStatus,
              remarks: normalizeNullableText(rawRem),
            };
          }),
        }),
      },
    );
    setSaving(false);
    if (!res.ok) {
      setBannerError(res.error);
      return;
    }
    setBannerSuccess(
      `${res.data.updatedCount}件の月次承認ステータスを「${APPROVAL_STATUS_LABELS[flowStatus]}」に更新しました。`,
    );
    await reloadMonthlyFlows();
  }

  async function handleExecuteSubscriptionBilling(
    specificTargets?: Array<{ partnerId: string; entryType: SalesEntryType }>,
  ) {
    setBannerError(null);
    setBannerSuccess(null);
    setSaving(true);
    const res = await requestMasterApi<ExecuteSubscriptionBillingResultDto>(
      '/api/v1/subscriptions/execute-billing',
      {
        method: 'POST',
        body: JSON.stringify({
          targetMonth: flowsData.targetMonth,
          billingDate: execBillingDate,
          paymentDueDate: normalizeNullableText(execPaymentDueDate),
          templateVariant: execTemplateVariant,
          targets: specificTargets,
        }),
      },
    );
    setSaving(false);
    if (!res.ok) {
      setBannerError(res.error);
      return;
    }
    setBannerSuccess(
      `対象年月 ${res.data.targetMonth} の定額請求一括確定を完了しました（${res.data.executedCount}件確定・定額請求書スナップショット発行済み）。`,
    );
    await reloadMonthlyFlows();
  }

  return (
    <div className="max-w-7xl space-y-5">
      {/* ヘッダ */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold text-slate-900">定額サブスク契約 ＆ 月次承認管理</h1>
          <p className="text-sm text-slate-600 mt-1">
            顧客別の定額請求契約（通常売上・立替）の登録と、月次請求対象確認・承認フロー管理を行います。
          </p>
        </div>

        {activeTab === 'contracts' && (
          <button
            type="button"
            onClick={openCreateModal}
            className="rounded-lg bg-blue-600 hover:bg-blue-700 px-4 py-2 text-xs font-semibold text-white cursor-pointer"
          >
            ＋ 新規契約登録
          </button>
        )}
      </div>

      {/* タブ */}
      <div className="flex items-center gap-2 border-b border-slate-200">
        <button
          type="button"
          onClick={() => setActiveTab('contracts')}
          className={`px-4 py-2.5 text-sm font-medium border-b-2 transition-colors cursor-pointer ${
            activeTab === 'contracts'
              ? 'border-blue-600 text-blue-700'
              : 'border-transparent text-slate-600 hover:text-slate-900'
          }`}
        >
          定額契約マスタ（{contractsData.totals.totalContracts}件）
        </button>
        <button
          type="button"
          onClick={() => {
            setActiveTab('flows');
            void reloadMonthlyFlows();
          }}
          className={`px-4 py-2.5 text-sm font-medium border-b-2 transition-colors cursor-pointer ${
            activeTab === 'flows'
              ? 'border-blue-600 text-blue-700'
              : 'border-transparent text-slate-600 hover:text-slate-900'
          }`}
        >
          月次対象確認・承認フロー
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

      {activeTab === 'contracts' ? (
        <>
          {/* サマリ */}
          <div className="grid grid-cols-2 lg:grid-cols-5 gap-3">
            <div className="rounded-xl bg-white border border-slate-200 p-4 shadow-xs">
              <div className="text-xs font-medium text-slate-500">登録契約数</div>
              <div className="text-xl font-bold text-slate-900 mt-1 font-mono">
                {contractsData.totals.totalContracts} 件
              </div>
            </div>
            <div className="rounded-xl bg-white border border-slate-200 p-4 shadow-xs">
              <div className="text-xs font-medium text-slate-500">稼働中契約数</div>
              <div className="text-xl font-bold text-emerald-700 mt-1 font-mono">
                {contractsData.totals.activeContracts} 件
              </div>
            </div>
            <div className="rounded-xl bg-white border border-slate-200 p-4 shadow-xs">
              <div className="text-xs font-medium text-slate-500">月額 売上税込合計</div>
              <div className="text-xl font-bold text-slate-900 mt-1 font-mono">
                {formatYen(contractsData.totals.activeSalesInclTotal)}
              </div>
            </div>
            <div className="rounded-xl bg-white border border-slate-200 p-4 shadow-xs">
              <div className="text-xs font-medium text-slate-500">月額 立替税込合計</div>
              <div className="text-xl font-bold text-slate-900 mt-1 font-mono">
                {formatYen(contractsData.totals.activeAdvanceInclTotal)}
              </div>
            </div>
            <div className="rounded-xl bg-blue-50 border border-blue-200 p-4 shadow-xs">
              <div className="text-xs font-semibold text-blue-700">月額 総合計（税込）</div>
              <div className="text-xl font-bold text-blue-900 mt-1 font-mono">
                {formatYen(contractsData.totals.activeCombinedInclTotal)}
              </div>
            </div>
          </div>

          {/* フィルタ */}
          <form
            onSubmit={(e) => {
              e.preventDefault();
              void reloadContracts();
            }}
            className="rounded-xl bg-white border border-slate-200 p-4 shadow-xs"
          >
            <div className="grid grid-cols-1 md:grid-cols-5 gap-3">
              <div>
                <label className="block text-xs font-medium text-slate-600 mb-1">キーワード</label>
                <input
                  type="text"
                  value={kw}
                  onChange={(e) => setKw(e.target.value)}
                  placeholder="取引先名 / 品名"
                  className="w-full rounded-lg border border-slate-300 px-3 py-1.5 text-sm"
                />
              </div>
              <div>
                <label className="block text-xs font-medium text-slate-600 mb-1">取引先</label>
                <select
                  value={filterPartnerId}
                  onChange={(e) => setFilterPartnerId(e.target.value)}
                  className="w-full rounded-lg border border-slate-300 px-2.5 py-1.5 text-sm bg-white"
                >
                  <option value="">すべて</option>
                  {lookups.partners.map((p) => (
                    <option key={p.id} value={p.id}>
                      [{p.partnerCode}] {p.partnerName}
                    </option>
                  ))}
                </select>
              </div>
              <div>
                <label className="block text-xs font-medium text-slate-600 mb-1">区分</label>
                <select
                  value={filterEntryType}
                  onChange={(e) => setFilterEntryType(e.target.value as 'ALL' | SalesEntryType)}
                  className="w-full rounded-lg border border-slate-300 px-2.5 py-1.5 text-sm bg-white"
                >
                  <option value="ALL">すべて</option>
                  <option value="SALE">通常売上</option>
                  <option value="ADVANCE">立替金</option>
                </select>
              </div>
              <div>
                <label className="block text-xs font-medium text-slate-600 mb-1">状態</label>
                <select
                  value={filterActive}
                  onChange={(e) => setFilterActive(e.target.value as 'ALL' | 'ACTIVE' | 'INACTIVE')}
                  className="w-full rounded-lg border border-slate-300 px-2.5 py-1.5 text-sm bg-white"
                >
                  <option value="ALL">すべて</option>
                  <option value="ACTIVE">稼働中のみ</option>
                  <option value="INACTIVE">停止中のみ</option>
                </select>
              </div>
              <div className="flex items-end">
                <button
                  type="submit"
                  disabled={loading}
                  className="w-full rounded-lg bg-slate-800 hover:bg-slate-700 px-4 py-1.5 text-xs font-semibold text-white cursor-pointer"
                >
                  {loading ? '読込中...' : '絞り込む'}
                </button>
              </div>
            </div>
          </form>

          {/* 取引先別月額サマリ */}
          {contractsData.partnerSummaries.length > 0 && (
            <div className="rounded-xl bg-white border border-slate-200 shadow-xs overflow-hidden">
              <div className="px-4 py-2.5 bg-slate-50 border-b border-slate-200 text-xs font-bold text-slate-700">
                取引先別 月額合計サマリ（稼働中契約）
              </div>
              <div className="overflow-x-auto">
                <table className="min-w-full divide-y divide-slate-200 text-xs">
                  <thead className="bg-slate-50 text-slate-600">
                    <tr>
                      <th className="px-3 py-2 text-left">取引先</th>
                      <th className="px-3 py-2 text-right">稼働契約数</th>
                      <th className="px-3 py-2 text-right">通常売上(税込)</th>
                      <th className="px-3 py-2 text-right">立替金(税込)</th>
                      <th className="px-3 py-2 text-right">月額合計(税込)</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100">
                    {contractsData.partnerSummaries.map((ps) => (
                      <tr key={ps.partnerId} className="hover:bg-slate-50">
                        <td className="px-3 py-2 font-medium text-slate-900">
                          <span className="font-mono text-slate-400 mr-1.5">{ps.partnerCode}</span>
                          {ps.partnerName}
                        </td>
                        <td className="px-3 py-2 text-right font-mono">{ps.activeCount}</td>
                        <td className="px-3 py-2 text-right font-mono">{formatYen(ps.salesInclTotal)}</td>
                        <td className="px-3 py-2 text-right font-mono">{formatYen(ps.advanceInclTotal)}</td>
                        <td className="px-3 py-2 text-right font-mono font-bold text-slate-900">
                          {formatYen(ps.combinedInclTotal)}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}

          {/* 契約一覧テーブル */}
          <div className="rounded-xl bg-white border border-slate-200 shadow-xs overflow-hidden">
            <div className="overflow-x-auto">
              <table className="min-w-full divide-y divide-slate-200 text-sm">
                <thead className="bg-slate-50 text-xs font-semibold text-slate-600">
                  <tr>
                    <th className="px-3 py-2.5 text-left">取引先</th>
                    <th className="px-3 py-2.5 text-center">区分 / 連番</th>
                    <th className="px-3 py-2.5 text-left">品名 / 月分</th>
                    <th className="px-3 py-2.5 text-right">数量 / 単位</th>
                    <th className="px-3 py-2.5 text-right">適用単価</th>
                    <th className="px-3 py-2.5 text-center">税区分 / 端数</th>
                    <th className="px-3 py-2.5 text-right">税抜金額</th>
                    <th className="px-3 py-2.5 text-right">消費税</th>
                    <th className="px-3 py-2.5 text-right">税込金額</th>
                    <th className="px-3 py-2.5 text-center">出力 / 状態</th>
                    <th className="px-3 py-2.5 text-right">操作</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {contractsData.items.length === 0 ? (
                    <tr>
                      <td colSpan={11} className="px-4 py-8 text-center text-sm text-slate-500">
                        定額契約が登録されていません。
                      </td>
                    </tr>
                  ) : (
                    contractsData.items.map((item) => (
                      <tr key={item.id} className="hover:bg-slate-50/80">
                        <td className="px-3 py-2.5 text-xs">
                          <div className="font-medium text-slate-900">{item.partnerName}</div>
                          <div className="font-mono text-slate-400">{item.partnerCode}</div>
                        </td>
                        <td className="px-3 py-2.5 text-center whitespace-nowrap">
                          <span
                            className={`inline-flex px-2 py-0.5 rounded text-[11px] font-semibold mr-1 ${
                              item.entryType === 'ADVANCE'
                                ? 'bg-purple-100 text-purple-800'
                                : 'bg-blue-100 text-blue-800'
                            }`}
                          >
                            {ENTRY_TYPE_LABELS[item.entryType]}
                          </span>
                          <span className="font-mono text-xs text-slate-600">#{item.subscSeqNo}</span>
                        </td>
                        <td className="px-3 py-2.5">
                          <div className="font-medium text-slate-900">{item.itemName}</div>
                          {item.monthLabel !== null && (
                            <div className="text-[11px] text-slate-500">月分表記: {item.monthLabel}</div>
                          )}
                        </td>
                        <td className="px-3 py-2.5 text-right font-mono text-xs">
                          {item.quantity} {item.unitName !== null ? item.unitName : ''}
                        </td>
                        <td className="px-3 py-2.5 text-right font-mono text-xs">
                          <div>{formatYen(item.appliedUnitPrice)}</div>
                          {item.masterUnitPrice !== null && (
                            <div className="text-[10px] text-slate-400">
                              基準: {formatYen(item.masterUnitPrice)}
                            </div>
                          )}
                        </td>
                        <td className="px-3 py-2.5 text-center font-mono text-xs">
                          {item.taxCode} / {item.roundingMode}
                        </td>
                        <td className="px-3 py-2.5 text-right font-mono text-xs">
                          {formatYen(item.exclAmount)}
                        </td>
                        <td className="px-3 py-2.5 text-right font-mono text-xs text-slate-600">
                          {formatYen(item.lineTax)}
                        </td>
                        <td className="px-3 py-2.5 text-right font-mono text-xs font-bold text-slate-900">
                          {formatYen(item.rowTotal)}
                        </td>
                        <td className="px-3 py-2.5 text-center whitespace-nowrap text-xs">
                          <span className="mr-1.5 text-slate-600">{item.outputType}</span>
                          {item.isActive ? (
                            <span className="px-1.5 py-0.5 rounded bg-emerald-100 text-emerald-800 text-[10px] font-semibold">
                              稼働中
                            </span>
                          ) : (
                            <span className="px-1.5 py-0.5 rounded bg-slate-200 text-slate-600 text-[10px] font-semibold">
                              停止
                            </span>
                          )}
                        </td>
                        <td className="px-3 py-2.5 text-right whitespace-nowrap space-x-1.5">
                          <button
                            type="button"
                            onClick={() => openEditModal(item)}
                            className="rounded border border-slate-300 bg-white hover:bg-slate-50 px-2 py-1 text-xs font-medium text-slate-700 cursor-pointer"
                          >
                            編集
                          </button>
                          <button
                            type="button"
                            disabled={saving}
                            onClick={() => void handleDeleteContract(item)}
                            className="rounded border border-red-200 bg-white hover:bg-red-50 px-2 py-1 text-xs font-medium text-red-700 cursor-pointer"
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
          </div>
        </>
      ) : (
        /* 月次対象確認・承認フロータブ */
        <div className="space-y-4">
          <div className="grid grid-cols-2 lg:grid-cols-5 gap-3">
            <div className="rounded-xl bg-white border border-slate-200 p-4 shadow-xs">
              <div className="text-xs font-medium text-slate-500">対象取引先×区分</div>
              <div className="text-xl font-bold text-slate-900 mt-1 font-mono">
                {flowsData.totals.targetCount} 件
              </div>
            </div>
            <div className="rounded-xl bg-white border border-slate-200 p-4 shadow-xs">
              <div className="text-xs font-medium text-slate-500">承認済</div>
              <div className="text-xl font-bold text-emerald-700 mt-1 font-mono">
                {flowsData.totals.approvedCount} 件
              </div>
            </div>
            <div className="rounded-xl bg-white border border-slate-200 p-4 shadow-xs">
              <div className="text-xs font-medium text-slate-500">未承認</div>
              <div className="text-xl font-bold text-amber-700 mt-1 font-mono">
                {flowsData.totals.pendingCount} 件
              </div>
            </div>
            <div className="rounded-xl bg-white border border-slate-200 p-4 shadow-xs">
              <div className="text-xs font-medium text-slate-500">差戻し</div>
              <div className="text-xl font-bold text-red-700 mt-1 font-mono">
                {flowsData.totals.rejectedCount} 件
              </div>
            </div>
            <div className="rounded-xl bg-blue-50 border border-blue-200 p-4 shadow-xs">
              <div className="text-xs font-semibold text-blue-700">当月予定税込総額</div>
              <div className="text-xl font-bold text-blue-900 mt-1 font-mono">
                {formatYen(flowsData.totals.totalInclAmount)}
              </div>
            </div>
          </div>

          <form
            onSubmit={(e) => {
              e.preventDefault();
              void reloadMonthlyFlows();
            }}
            className="rounded-xl bg-white border border-slate-200 p-4 shadow-xs flex flex-wrap items-end gap-3"
          >
            <div>
              <label className="block text-xs font-medium text-slate-600 mb-1">対象年月</label>
              <input
                type="month"
                required
                value={monthInput}
                onChange={(e) => setMonthInput(e.target.value)}
                className="rounded-lg border border-slate-300 px-3 py-1.5 text-sm"
              />
            </div>
            <div>
              <label className="block text-xs font-medium text-slate-600 mb-1">区分</label>
              <select
                value={flowEntryType}
                onChange={(e) => setFlowEntryType(e.target.value as 'ALL' | SalesEntryType)}
                className="rounded-lg border border-slate-300 px-2.5 py-1.5 text-sm bg-white"
              >
                <option value="ALL">すべて</option>
                <option value="SALE">通常売上</option>
                <option value="ADVANCE">立替金</option>
              </select>
            </div>
            <div className="flex-1 min-w-48">
              <label className="block text-xs font-medium text-slate-600 mb-1">取引先検索</label>
              <input
                type="text"
                value={flowKw}
                onChange={(e) => setFlowKw(e.target.value)}
                placeholder="取引先名・コード"
                className="w-full rounded-lg border border-slate-300 px-3 py-1.5 text-sm"
              />
            </div>
            <button
              type="submit"
              disabled={loading}
              className="rounded-lg bg-slate-800 hover:bg-slate-700 px-4 py-1.5 text-xs font-semibold text-white cursor-pointer"
            >
              {loading ? '読込中...' : '対象月を表示'}
            </button>
          </form>

          {/* 定額一括請求確定パネル */}
          <div className="rounded-xl border border-indigo-200 bg-indigo-50/70 p-4 shadow-xs space-y-3">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div>
                <h2 className="text-sm font-bold text-indigo-950">
                  定額一括請求確定（FIXED_INVOICE 自動発行）
                </h2>
                <p className="text-xs text-indigo-800 mt-0.5">
                  {lookups.approvalFlowEnabled
                    ? '承認フロー有効中：月次承認ステータスが「承認済」かつ未確定の対象に対して請求確定・定額売上伝票(K4)作成・FIXED_INVOICE発行を一括実行します。'
                    : '稼働中の定額契約（未確定分）に対して請求確定・定額売上伝票(K4)作成・FIXED_INVOICE発行を一括実行します。'}
                  （期首基準日: {lookups.openingBalanceDate} より後の請求日を指定してください）
                </p>
              </div>
              <span className="px-2 py-0.5 rounded bg-white border border-indigo-200 text-xs font-mono text-indigo-900">
                対象年月: {flowsData.targetMonth}
              </span>
            </div>

            <div className="flex flex-wrap items-end gap-3">
              <div>
                <label className="block text-xs font-medium text-indigo-950 mb-1">
                  請求日 *
                </label>
                <input
                  type="date"
                  value={execBillingDate}
                  onChange={(e) => setExecBillingDate(e.target.value)}
                  className="rounded-lg border border-indigo-300 bg-white px-2.5 py-1.5 text-sm"
                />
              </div>
              <div>
                <label className="block text-xs font-medium text-indigo-950 mb-1">
                  支払期限（空欄時: 取引先マスタから自動提案）
                </label>
                <input
                  type="date"
                  value={execPaymentDueDate}
                  onChange={(e) => setExecPaymentDueDate(e.target.value)}
                  className="rounded-lg border border-indigo-300 bg-white px-2.5 py-1.5 text-sm"
                />
              </div>
              <div>
                <label className="block text-xs font-medium text-indigo-950 mb-1">
                  帳票明細行数
                </label>
                <select
                  value={execTemplateVariant}
                  onChange={(e) =>
                    setExecTemplateVariant(e.target.value as '10_ROWS' | '20_ROWS')
                  }
                  className="rounded-lg border border-indigo-300 bg-white px-2.5 py-1.5 text-sm"
                >
                  <option value="10_ROWS">10行枠</option>
                  <option value="20_ROWS">20行枠</option>
                </select>
              </div>

              <div className="flex flex-wrap items-center gap-2 ml-auto">
                {selectedFlowKeys.length > 0 && (
                  <button
                    type="button"
                    disabled={saving}
                    onClick={() => {
                      const targets = flowsData.items
                        .filter((i) =>
                          selectedFlowKeys.includes(`${i.partnerId}:${i.entryType}`),
                        )
                        .map((i) => ({
                          partnerId: i.partnerId,
                          entryType: i.entryType,
                        }));
                      void handleExecuteSubscriptionBilling(targets);
                    }}
                    className="rounded-lg bg-emerald-600 hover:bg-emerald-700 disabled:opacity-60 px-3.5 py-2 text-xs font-semibold text-white cursor-pointer"
                  >
                    選択分 ({selectedFlowKeys.length}件) を定額請求確定
                  </button>
                )}
                <button
                  type="button"
                  disabled={saving}
                  onClick={() => void handleExecuteSubscriptionBilling()}
                  className="rounded-lg bg-indigo-700 hover:bg-indigo-800 disabled:opacity-60 px-4 py-2 text-xs font-semibold text-white cursor-pointer"
                >
                  {saving ? '確定実行中...' : '対象月を一括請求確定'}
                </button>
              </div>
            </div>
          </div>

          {selectedFlowKeys.length > 0 && (
            <div className="rounded-xl border border-blue-200 bg-blue-50 px-4 py-2.5 flex flex-wrap items-center justify-between gap-2">
              <span className="text-xs font-semibold text-blue-900">
                {selectedFlowKeys.length} 件を選択中（対象年月: {flowsData.targetMonth}）
              </span>
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  disabled={saving}
                  onClick={() => {
                    const targets = flowsData.items.filter((i) =>
                      selectedFlowKeys.includes(`${i.partnerId}:${i.entryType}`),
                    );
                    void updateFlowRows(targets, 1);
                  }}
                  className="rounded bg-emerald-600 hover:bg-emerald-700 px-3 py-1 text-xs font-semibold text-white cursor-pointer"
                >
                  一括承認済
                </button>
                <button
                  type="button"
                  disabled={saving}
                  onClick={() => {
                    const targets = flowsData.items.filter((i) =>
                      selectedFlowKeys.includes(`${i.partnerId}:${i.entryType}`),
                    );
                    void updateFlowRows(targets, 2);
                  }}
                  className="rounded bg-amber-600 hover:bg-amber-700 px-3 py-1 text-xs font-semibold text-white cursor-pointer"
                >
                  一括差戻し
                </button>
                <button
                  type="button"
                  disabled={saving}
                  onClick={() => {
                    const targets = flowsData.items.filter((i) =>
                      selectedFlowKeys.includes(`${i.partnerId}:${i.entryType}`),
                    );
                    void updateFlowRows(targets, 0);
                  }}
                  className="rounded border border-slate-300 bg-white px-3 py-1 text-xs font-medium text-slate-700 cursor-pointer"
                >
                  未承認へ戻す
                </button>
              </div>
            </div>
          )}

          <div className="rounded-xl bg-white border border-slate-200 shadow-xs overflow-hidden">
            <div className="overflow-x-auto">
              <table className="min-w-full divide-y divide-slate-200 text-sm">
                <thead className="bg-slate-50 text-xs font-semibold text-slate-600">
                  <tr>
                    <th className="px-3 py-2.5 text-center w-9">
                      <input
                        type="checkbox"
                        checked={
                          flowsData.items.length > 0 &&
                          selectedFlowKeys.length === flowsData.items.length
                        }
                        onChange={toggleAllFlowKeys}
                      />
                    </th>
                    <th className="px-3 py-2.5 text-left">取引先</th>
                    <th className="px-3 py-2.5 text-center">区分</th>
                    <th className="px-3 py-2.5 text-right">契約数</th>
                    <th className="px-3 py-2.5 text-right">税抜予定</th>
                    <th className="px-3 py-2.5 text-right">消費税</th>
                    <th className="px-3 py-2.5 text-right">税込予定</th>
                    <th className="px-3 py-2.5 text-center">承認状態</th>
                    <th className="px-3 py-2.5 text-left min-w-44">承認備考</th>
                    <th className="px-3 py-2.5 text-right">操作</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {flowsData.items.length === 0 ? (
                    <tr>
                      <td colSpan={10} className="px-4 py-8 text-center text-sm text-slate-500">
                        稼働中の定額契約がありません。
                      </td>
                    </tr>
                  ) : (
                    flowsData.items.map((item) => {
                      const key = `${item.partnerId}:${item.entryType}`;
                      return (
                        <tr key={key} className="hover:bg-slate-50/80">
                          <td className="px-3 py-2.5 text-center">
                            <input
                              type="checkbox"
                              checked={selectedFlowKeys.includes(key)}
                              onChange={() => toggleFlowKey(key)}
                            />
                          </td>
                          <td className="px-3 py-2.5 text-xs">
                            <div className="font-medium text-slate-900">{item.partnerName}</div>
                            <div className="font-mono text-slate-400">{item.partnerCode}</div>
                          </td>
                          <td className="px-3 py-2.5 text-center">
                            <span
                              className={`inline-flex px-2 py-0.5 rounded text-[11px] font-semibold ${
                                item.entryType === 'ADVANCE'
                                  ? 'bg-purple-100 text-purple-800'
                                  : 'bg-blue-100 text-blue-800'
                              }`}
                            >
                              {ENTRY_TYPE_LABELS[item.entryType]}
                            </span>
                          </td>
                          <td className="px-3 py-2.5 text-right font-mono text-xs">
                            {item.activeContractCount}
                          </td>
                          <td className="px-3 py-2.5 text-right font-mono text-xs">
                            {formatYen(item.subtotalExcl)}
                          </td>
                          <td className="px-3 py-2.5 text-right font-mono text-xs text-slate-600">
                            {formatYen(item.taxTotal)}
                          </td>
                          <td className="px-3 py-2.5 text-right font-mono text-xs font-bold text-slate-900">
                            {formatYen(item.totalIncl)}
                          </td>
                          <td className="px-3 py-2.5 text-center">
                            <span
                              className={`inline-flex px-2 py-0.5 rounded-full text-[11px] font-semibold ${
                                item.flowStatus === 1
                                  ? 'bg-emerald-100 text-emerald-800'
                                  : item.flowStatus === 2
                                    ? 'bg-red-100 text-red-700'
                                    : 'bg-amber-100 text-amber-800'
                              }`}
                            >
                              {APPROVAL_STATUS_LABELS[item.flowStatus]}
                            </span>
                            {item.updatedByName !== null && (
                              <div className="text-[10px] text-slate-400 mt-0.5">
                                {item.updatedByName}
                              </div>
                            )}
                          </td>
                          <td className="px-3 py-2.5">
                            <input
                              type="text"
                              value={flowRemarksMap[key] !== undefined ? flowRemarksMap[key] : ''}
                              onChange={(e) =>
                                setFlowRemarksMap((prev) => ({ ...prev, [key]: e.target.value }))
                              }
                              placeholder="承認・差戻し備考"
                              className="w-full rounded border border-slate-300 px-2 py-1 text-xs"
                            />
                          </td>
                          <td className="px-3 py-2.5 text-right whitespace-nowrap space-x-1">
                            {item.isAlreadyBilled ? (
                              <span className="inline-flex px-2 py-0.5 rounded bg-blue-100 text-blue-800 text-[11px] font-semibold">
                                請求確定済
                              </span>
                            ) : (
                              <>
                                <button
                                  type="button"
                                  disabled={saving}
                                  onClick={() => void updateFlowRows([item], 1)}
                                  className="rounded bg-emerald-600 hover:bg-emerald-700 px-2 py-1 text-xs font-medium text-white cursor-pointer"
                                >
                                  承認
                                </button>
                                <button
                                  type="button"
                                  disabled={saving}
                                  onClick={() => void updateFlowRows([item], 2)}
                                  className="rounded bg-amber-600 hover:bg-amber-700 px-2 py-1 text-xs font-medium text-white cursor-pointer"
                                >
                                  差戻し
                                </button>
                              </>
                            )}
                          </td>
                        </tr>
                      );
                    })
                  )}
                </tbody>
              </table>
            </div>
          </div>

          {/* 確定済み定額請求履歴（subscription_billings） */}
          <div className="rounded-xl bg-white border border-slate-200 shadow-xs overflow-hidden">
            <div className="px-4 py-3 bg-slate-50 border-b border-slate-200 flex items-center justify-between">
              <h3 className="text-xs font-bold text-slate-800">
                定額請求 確定済み履歴（対象年月: {flowsData.targetMonth} / {billingHistory.length}件）
              </h3>
              <Link
                href="/billing?tab=ISSUED"
                className="text-xs font-medium text-blue-600 hover:underline"
              >
                請求一覧画面へ →
              </Link>
            </div>
            <div className="overflow-x-auto">
              <table className="min-w-full divide-y divide-slate-200 text-xs">
                <thead className="bg-slate-50 text-slate-600">
                  <tr>
                    <th className="px-3 py-2 text-left">取引先</th>
                    <th className="px-3 py-2 text-center">区分</th>
                    <th className="px-3 py-2 text-center">請求No</th>
                    <th className="px-3 py-2 text-center">請求日</th>
                    <th className="px-3 py-2 text-right">請求金額(税込)</th>
                    <th className="px-3 py-2 text-center">出力方法</th>
                    <th className="px-3 py-2 text-left">結果メッセージ</th>
                    <th className="px-3 py-2 text-right">帳票 / 詳細</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {billingHistory.length === 0 ? (
                    <tr>
                      <td colSpan={8} className="px-4 py-6 text-center text-slate-500">
                        対象年月の定額請求確定履歴はまだありません。
                      </td>
                    </tr>
                  ) : (
                    billingHistory.map((hist) => (
                      <tr key={hist.id} className="hover:bg-slate-50">
                        <td className="px-3 py-2">
                          <span className="font-mono text-slate-400 mr-1.5">
                            {hist.partnerCode}
                          </span>
                          <span className="font-medium text-slate-900">{hist.partnerName}</span>
                        </td>
                        <td className="px-3 py-2 text-center">
                          <span className="px-2 py-0.5 rounded bg-slate-100 text-slate-700 font-semibold">
                            {ENTRY_TYPE_LABELS[hist.entryType]}
                          </span>
                        </td>
                        <td className="px-3 py-2 text-center font-mono">
                          {hist.billingId !== null && hist.billingNo !== null ? (
                            <Link
                              href={`/billing/${hist.billingId}`}
                              className="text-blue-600 hover:underline font-semibold"
                            >
                              #{hist.billingNo}
                            </Link>
                          ) : (
                            '-'
                          )}
                        </td>
                        <td className="px-3 py-2 text-center font-mono">{hist.billingDate}</td>
                        <td className="px-3 py-2 text-right font-mono font-bold text-slate-900">
                          {formatYen(hist.billedAmount)}
                        </td>
                        <td className="px-3 py-2 text-center">{hist.outputType}</td>
                        <td className="px-3 py-2 text-slate-600">{hist.resultMessage}</td>
                        <td className="px-3 py-2 text-right whitespace-nowrap space-x-1.5">
                          {hist.latestSnapshotId !== null && (
                            <>
                              <button
                                type="button"
                                onClick={() => setPreviewSnapshotId(hist.latestSnapshotId)}
                                className="rounded border border-slate-300 bg-white hover:bg-slate-50 px-2 py-0.5 font-medium text-slate-700 cursor-pointer"
                              >
                                PDFプレビュー
                              </button>
                              <a
                                href={`/api/v1/snapshots/${encodeURIComponent(hist.latestSnapshotId)}/pdf?download=1`}
                                className="rounded border border-blue-200 bg-blue-50 hover:bg-blue-100 px-2 py-0.5 font-medium text-blue-700"
                              >
                                DL
                              </a>
                            </>
                          )}
                          {hist.billingId !== null && (
                            <Link
                              href={`/billing/${hist.billingId}`}
                              className="rounded border border-slate-300 bg-white hover:bg-slate-50 px-2 py-0.5 font-medium text-slate-700"
                            >
                              請求詳細
                            </Link>
                          )}
                        </td>
                      </tr>
                    ))
                  )}
                </tbody>
              </table>
            </div>
          </div>

          {previewSnapshotId !== null && (
            <div className="fixed inset-0 z-50 bg-slate-900/60 flex items-center justify-center p-4">
              <div className="bg-white rounded-xl w-full max-w-4xl h-[85vh] flex flex-col shadow-2xl overflow-hidden">
                <div className="px-4 py-3 border-b border-slate-200 flex items-center justify-between">
                  <span className="text-sm font-bold text-slate-900">
                    定額請求書（FIXED_INVOICE）印刷プレビュー
                  </span>
                  <div className="flex items-center gap-2">
                    <a
                      href={`/api/v1/snapshots/${encodeURIComponent(previewSnapshotId)}/pdf?download=1`}
                      className="rounded bg-blue-600 hover:bg-blue-700 px-3 py-1 text-xs font-semibold text-white"
                    >
                      PDFダウンロード
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
                  title="定額請求書PDFプレビュー"
                  src={`/api/v1/snapshots/${encodeURIComponent(previewSnapshotId)}/pdf`}
                  className="flex-1 w-full border-0"
                />
              </div>
            </div>
          )}
        </div>
      )}

      {/* 契約作成・編集モーダル */}
      {modalOpen && (
        <div className="fixed inset-0 z-50 bg-slate-900/50 flex items-center justify-center p-4">
          <form
            onSubmit={handleSaveContract}
            className="bg-white rounded-xl max-w-2xl w-full max-h-[90vh] overflow-y-auto shadow-xl p-6 space-y-4"
          >
            <div className="flex items-center justify-between border-b border-slate-200 pb-3">
              <h2 className="text-base font-bold text-slate-900">
                {editingId === null ? '新規定額契約の登録' : '定額契約の編集'}
              </h2>
              <button
                type="button"
                onClick={() => setModalOpen(false)}
                className="text-xs text-slate-500 hover:text-slate-800 cursor-pointer"
              >
                閉じる ✕
              </button>
            </div>

            {modalError !== null && (
              <div className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-800">
                {modalError}
              </div>
            )}

            <div className="grid grid-cols-1 md:grid-cols-2 gap-3 text-sm">
              <div className="md:col-span-2">
                <label className="block text-xs font-medium text-slate-600 mb-1">
                  取引先 <span className="text-red-500">*</span>
                </label>
                <select
                  required
                  value={formPartnerId}
                  onChange={(e) => setFormPartnerId(e.target.value)}
                  className="w-full rounded-lg border border-slate-300 px-3 py-1.5 bg-white"
                >
                  <option value="">-- 取引先を選択 --</option>
                  {lookups.partners.map((p) => (
                    <option key={p.id} value={p.id}>
                      [{p.partnerCode}] {p.partnerName}
                    </option>
                  ))}
                </select>
              </div>

              <div>
                <label className="block text-xs font-medium text-slate-600 mb-1">区分</label>
                <select
                  value={formEntryType}
                  onChange={(e) => setFormEntryType(e.target.value as SalesEntryType)}
                  className="w-full rounded-lg border border-slate-300 px-3 py-1.5 bg-white"
                >
                  <option value="SALE">通常売上 (SALE)</option>
                  <option value="ADVANCE">立替金 (ADVANCE)</option>
                </select>
              </div>

              <div>
                <label className="block text-xs font-medium text-slate-600 mb-1">
                  契約連番（空欄で自動採番）
                </label>
                <input
                  type="number"
                  min={1}
                  value={formSeqNo}
                  onChange={(e) => setFormSeqNo(e.target.value)}
                  placeholder="自動"
                  className="w-full rounded-lg border border-slate-300 px-3 py-1.5"
                />
              </div>

              <div className="md:col-span-2">
                <label className="block text-xs font-medium text-slate-600 mb-1">
                  商品マスタから引用（任意）
                </label>
                <select
                  value={formProductId}
                  onChange={(e) => handleSelectProduct(e.target.value)}
                  className="w-full rounded-lg border border-slate-300 px-3 py-1.5 bg-white"
                >
                  <option value="">（手入力 / 商品未紐付）</option>
                  {lookups.products.map((pr) => (
                    <option key={pr.id} value={pr.id}>
                      [{pr.productCode}] {pr.productName} (¥{pr.standardUnitPrice.toLocaleString('ja-JP')})
                    </option>
                  ))}
                </select>
              </div>

              <div className="md:col-span-2">
                <label className="block text-xs font-medium text-slate-600 mb-1">
                  品名 <span className="text-red-500">*</span>
                </label>
                <input
                  type="text"
                  required
                  value={formItemName}
                  onChange={(e) => setFormItemName(e.target.value)}
                  className="w-full rounded-lg border border-slate-300 px-3 py-1.5"
                />
              </div>

              <div>
                <label className="block text-xs font-medium text-slate-600 mb-1">月分ラベル</label>
                <input
                  type="text"
                  value={formMonthLabel}
                  onChange={(e) => setFormMonthLabel(e.target.value)}
                  placeholder="例: 当月分 / 翌月分"
                  className="w-full rounded-lg border border-slate-300 px-3 py-1.5"
                />
              </div>

              <div>
                <label className="block text-xs font-medium text-slate-600 mb-1">単位</label>
                <input
                  type="text"
                  list="subsc-units-list"
                  value={formUnitName}
                  onChange={(e) => setFormUnitName(e.target.value)}
                  className="w-full rounded-lg border border-slate-300 px-3 py-1.5"
                />
                <datalist id="subsc-units-list">
                  {lookups.units.map((u) => (
                    <option key={u.id} value={u.unitName} />
                  ))}
                </datalist>
              </div>

              <div>
                <label className="block text-xs font-medium text-slate-600 mb-1">数量</label>
                <input
                  type="text"
                  required
                  value={formQuantity}
                  onChange={(e) => setFormQuantity(e.target.value)}
                  className="w-full rounded-lg border border-slate-300 px-3 py-1.5 text-right font-mono"
                />
              </div>

              <div>
                <label className="block text-xs font-medium text-slate-600 mb-1">
                  適用単価 <span className="text-red-500">*</span>
                </label>
                <input
                  type="text"
                  required
                  value={formAppliedPrice}
                  onChange={(e) => setFormAppliedPrice(e.target.value)}
                  className="w-full rounded-lg border border-slate-300 px-3 py-1.5 text-right font-mono"
                />
                {formMasterPrice !== null && (
                  <div className="text-[11px] text-slate-400 text-right mt-0.5 font-mono">
                    基準単価: {formatYen(formMasterPrice)}
                  </div>
                )}
              </div>

              <div>
                <label className="block text-xs font-medium text-slate-600 mb-1">税区分</label>
                <select
                  value={formTaxCode}
                  onChange={(e) => setFormTaxCode(e.target.value as TaxCode)}
                  className="w-full rounded-lg border border-slate-300 px-3 py-1.5 bg-white"
                >
                  {lookups.taxCodes.map((tc) => (
                    <option key={tc.taxCode} value={tc.taxCode}>
                      {tc.taxCode}: {tc.taxName}
                    </option>
                  ))}
                </select>
              </div>

              <div>
                <label className="block text-xs font-medium text-slate-600 mb-1">端数処理</label>
                <select
                  value={formRoundingMode}
                  onChange={(e) => setFormRoundingMode(e.target.value as RoundingMode)}
                  className="w-full rounded-lg border border-slate-300 px-3 py-1.5 bg-white"
                >
                  <option value="FLOOR">FLOOR（切捨）</option>
                  <option value="ROUND">ROUND（四捨五入）</option>
                  <option value="CEIL">CEIL（切上）</option>
                </select>
              </div>

              <div>
                <label className="block text-xs font-medium text-slate-600 mb-1">出力方法</label>
                <select
                  value={formOutputType}
                  onChange={(e) => setFormOutputType(e.target.value as SubscriptionOutputType)}
                  className="w-full rounded-lg border border-slate-300 px-3 py-1.5 bg-white"
                >
                  {SUBSCRIPTION_OUTPUT_TYPES.map((ot) => (
                    <option key={ot} value={ot}>
                      {ot}
                    </option>
                  ))}
                </select>
              </div>

              <div className="flex items-end pb-1.5">
                <label className="inline-flex items-center gap-2 text-sm text-slate-700 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={formIsActive}
                    onChange={(e) => setFormIsActive(e.target.checked)}
                  />
                  <span>契約有効（月次請求対象に含める）</span>
                </label>
              </div>
            </div>

            <div className="rounded-lg bg-slate-900 text-white p-3 flex items-center justify-between text-xs font-mono">
              <span>税抜: {formatYen(Number(liveModalCalc.exclAmount))}</span>
              <span>消費税: {formatYen(Number(liveModalCalc.lineTax))}</span>
              <span className="font-bold text-blue-200">
                税込合計: {formatYen(Number(liveModalCalc.rowTotal))}
              </span>
            </div>

            <div className="flex justify-end gap-2 pt-2">
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
                className="rounded-lg bg-blue-600 hover:bg-blue-700 px-5 py-2 text-xs font-semibold text-white cursor-pointer"
              >
                {saving ? '保存中...' : '保存する'}
              </button>
            </div>
          </form>
        </div>
      )}
    </div>
  );
}
