'use client';

import { useMemo, useState } from 'react';
import { normalizeNullableText, requestMasterApi } from '@/lib/masters/client-api';
import {
  CODE_MASTER_DOMAINS,
  type CodeMasterDto,
  type CodeMasterInput,
  type PaymentMethodDto,
  type PaymentMethodInput,
  type TaxCodeDto,
  type TaxCodeUpdateInput,
  type UnitDto,
  type UnitInput,
} from '@/lib/masters/types';

interface CodesClientProps {
  initialCodeMasters: CodeMasterDto[];
  initialUnits: UnitDto[];
  initialPaymentMethods: PaymentMethodDto[];
  initialTaxCodes: TaxCodeDto[];
  isAdmin: boolean;
}

type CodeTab = 'code-masters' | 'units' | 'payment-methods' | 'tax-codes';

function formatPercent(rate: number): string {
  return `${Number((rate * 100).toFixed(2))}%`;
}

export default function CodesClient({
  initialCodeMasters,
  initialUnits,
  initialPaymentMethods,
  initialTaxCodes,
  isAdmin,
}: CodesClientProps) {
  const [activeTab, setActiveTab] = useState<CodeTab>('code-masters');
  const [bannerError, setBannerError] = useState<string | null>(null);
  const [bannerSuccess, setBannerSuccess] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  // --- 1. 汎用区分 ---
  const [codeMasters, setCodeMasters] = useState<CodeMasterDto[]>(initialCodeMasters);
  const [selectedDomainKey, setSelectedDomainKey] = useState<string>(
    CODE_MASTER_DOMAINS[0]?.domainKey ?? 'CATEGORY',
  );
  const [cmModalOpen, setCmModalOpen] = useState(false);
  const [editingCm, setEditingCm] = useState<CodeMasterDto | null>(null);
  const [cmCode, setCmCode] = useState('');
  const [cmName, setCmName] = useState('');
  const [cmOrder, setCmOrder] = useState('1');
  const [cmActive, setCmActive] = useState(true);
  const [cmModalError, setCmModalError] = useState<string | null>(null);

  const selectedDomainMeta = CODE_MASTER_DOMAINS.find((d) => d.domainKey === selectedDomainKey);
  const domainCounts = useMemo(() => {
    const map = new Map<string, number>();
    for (const item of codeMasters) {
      const prev = map.get(item.domainKey);
      map.set(item.domainKey, prev === undefined ? 1 : prev + 1);
    }
    return map;
  }, [codeMasters]);
  const currentDomainItems = useMemo(
    () => codeMasters.filter((c) => c.domainKey === selectedDomainKey),
    [codeMasters, selectedDomainKey],
  );

  // --- 2. 単位マスタ ---
  const [units, setUnits] = useState<UnitDto[]>(initialUnits);
  const [showDeletedUnits, setShowDeletedUnits] = useState(true);
  const [unitModalOpen, setUnitModalOpen] = useState(false);
  const [editingUnitId, setEditingUnitId] = useState<string | null>(null);
  const [unitCode, setUnitCode] = useState('');
  const [unitName, setUnitName] = useState('');
  const [conversionName, setConversionName] = useState('');
  const [conversionRatio, setConversionRatio] = useState('1');
  const [unitOrder, setUnitOrder] = useState('99999');
  const [unitDeleted, setUnitDeleted] = useState(false);
  const [unitModalError, setUnitModalError] = useState<string | null>(null);

  const visibleUnits = useMemo(
    () => (showDeletedUnits ? units : units.filter((u) => !u.isDeleted)),
    [units, showDeletedUnits],
  );

  // --- 3. 支払・回収方法 ---
  const [paymentMethods, setPaymentMethods] = useState<PaymentMethodDto[]>(initialPaymentMethods);
  const [pmModalOpen, setPmModalOpen] = useState(false);
  const [editingPm, setEditingPm] = useState<PaymentMethodDto | null>(null);
  const [pmCode, setPmCode] = useState('');
  const [pmName, setPmName] = useState('');
  const [pmModalError, setPmModalError] = useState<string | null>(null);

  // --- 4. 税区分 ---
  const [taxCodes, setTaxCodes] = useState<TaxCodeDto[]>(initialTaxCodes);
  const [taxModalOpen, setTaxModalOpen] = useState(false);
  const [editingTax, setEditingTax] = useState<TaxCodeDto | null>(null);
  const [taxName, setTaxName] = useState('');
  const [taxRate, setTaxRate] = useState('0.1000');
  const [markSymbol, setMarkSymbol] = useState('.');
  const [isInternal, setIsInternal] = useState(false);
  const [taxModalError, setTaxModalError] = useState<string | null>(null);

  // --------------------------------------------------------------------------
  // Handlers: Code Masters
  // --------------------------------------------------------------------------
  async function reloadCodeMasters() {
    const res = await requestMasterApi<{ items: CodeMasterDto[] }>('/api/v1/masters/code-masters');
    if (!res.ok) {
      setBannerError(res.error);
      return;
    }
    setCodeMasters(res.data.items);
  }

  function openCreateCodeMaster() {
    setEditingCm(null);
    setCmCode('');
    setCmName('');
    setCmOrder(String(currentDomainItems.length + 1));
    setCmActive(true);
    setCmModalError(null);
    setCmModalOpen(true);
  }

  function openEditCodeMaster(item: CodeMasterDto) {
    setEditingCm(item);
    setCmCode(item.code);
    setCmName(item.name);
    setCmOrder(String(item.displayOrder));
    setCmActive(item.isActive);
    setCmModalError(null);
    setCmModalOpen(true);
  }

  async function handleSaveCodeMaster(e: React.FormEvent) {
    e.preventDefault();
    setCmModalError(null);
    setBannerSuccess(null);
    const payload: CodeMasterInput = {
      domainKey: selectedDomainKey,
      code: cmCode.trim(),
      name: cmName.trim(),
      isActive: cmActive,
      displayOrder: Number(cmOrder.trim() === '' ? '0' : cmOrder.trim()),
    };
    setSaving(true);
    const url =
      editingCm === null
        ? '/api/v1/masters/code-masters'
        : `/api/v1/masters/code-masters/${encodeURIComponent(editingCm.id)}`;
    const method = editingCm === null ? 'POST' : 'PUT';
    const res = await requestMasterApi<{ item: CodeMasterDto }>(url, {
      method,
      body: JSON.stringify(payload),
    });
    setSaving(false);
    if (!res.ok) {
      setCmModalError(res.error);
      return;
    }
    setCmModalOpen(false);
    setBannerSuccess(`区分「${res.data.item.code}: ${res.data.item.name}」を保存しました。`);
    await reloadCodeMasters();
  }

  async function handleDeleteCodeMaster(item: CodeMasterDto) {
    setBannerError(null);
    setBannerSuccess(null);
    if (!window.confirm(`区分「${item.code}: ${item.name}」を削除しますか？`)) {
      return;
    }
    const res = await requestMasterApi<{ ok: true }>(
      `/api/v1/masters/code-masters/${encodeURIComponent(item.id)}`,
      { method: 'DELETE' },
    );
    if (!res.ok) {
      setBannerError(res.error);
      return;
    }
    setBannerSuccess(`区分「${item.code}: ${item.name}」を削除しました。`);
    await reloadCodeMasters();
  }

  // --------------------------------------------------------------------------
  // Handlers: Units
  // --------------------------------------------------------------------------
  async function reloadUnits() {
    const res = await requestMasterApi<{ items: UnitDto[] }>('/api/v1/masters/units');
    if (!res.ok) {
      setBannerError(res.error);
      return;
    }
    setUnits(res.data.items);
  }

  function openCreateUnit() {
    setEditingUnitId(null);
    setUnitCode('');
    setUnitName('');
    setConversionName('');
    setConversionRatio('1');
    setUnitOrder('99999');
    setUnitDeleted(false);
    setUnitModalError(null);
    setUnitModalOpen(true);
  }

  function openEditUnit(u: UnitDto) {
    setEditingUnitId(u.id);
    setUnitCode(u.unitCode);
    setUnitName(u.unitName);
    setConversionName(u.conversionName ?? '');
    setConversionRatio(String(u.conversionRatio));
    setUnitOrder(String(u.displayOrder));
    setUnitDeleted(u.isDeleted);
    setUnitModalError(null);
    setUnitModalOpen(true);
  }

  async function handleSaveUnit(e: React.FormEvent) {
    e.preventDefault();
    setUnitModalError(null);
    setBannerSuccess(null);
    const payload: UnitInput = {
      unitCode: unitCode.trim(),
      unitName: unitName.trim(),
      conversionName: normalizeNullableText(conversionName),
      conversionRatio: Number(conversionRatio.trim() === '' ? '1' : conversionRatio.trim()),
      displayOrder: Number(unitOrder.trim() === '' ? '99999' : unitOrder.trim()),
      isDeleted: unitDeleted,
    };
    setSaving(true);
    const url =
      editingUnitId === null
        ? '/api/v1/masters/units'
        : `/api/v1/masters/units/${encodeURIComponent(editingUnitId)}`;
    const method = editingUnitId === null ? 'POST' : 'PUT';
    const res = await requestMasterApi<{ item: UnitDto }>(url, {
      method,
      body: JSON.stringify(payload),
    });
    setSaving(false);
    if (!res.ok) {
      setUnitModalError(res.error);
      return;
    }
    setUnitModalOpen(false);
    setBannerSuccess(`単位「${res.data.item.unitName}」を保存しました。`);
    await reloadUnits();
  }

  // --------------------------------------------------------------------------
  // Handlers: Payment Methods
  // --------------------------------------------------------------------------
  async function reloadPaymentMethods() {
    const res = await requestMasterApi<{ items: PaymentMethodDto[] }>('/api/v1/masters/payment-methods');
    if (!res.ok) {
      setBannerError(res.error);
      return;
    }
    setPaymentMethods(res.data.items);
  }

  function openCreatePm() {
    setEditingPm(null);
    setPmCode('');
    setPmName('');
    setPmModalError(null);
    setPmModalOpen(true);
  }

  function openEditPm(pm: PaymentMethodDto) {
    setEditingPm(pm);
    setPmCode(pm.methodCode);
    setPmName(pm.methodName);
    setPmModalError(null);
    setPmModalOpen(true);
  }

  async function handleSavePm(e: React.FormEvent) {
    e.preventDefault();
    setPmModalError(null);
    setBannerSuccess(null);
    const payload: PaymentMethodInput = {
      methodCode: pmCode.trim(),
      methodName: pmName.trim(),
    };
    setSaving(true);
    const url =
      editingPm === null
        ? '/api/v1/masters/payment-methods'
        : `/api/v1/masters/payment-methods/${encodeURIComponent(editingPm.id)}`;
    const method = editingPm === null ? 'POST' : 'PUT';
    const res = await requestMasterApi<{ item: PaymentMethodDto }>(url, {
      method,
      body: JSON.stringify(payload),
    });
    setSaving(false);
    if (!res.ok) {
      setPmModalError(res.error);
      return;
    }
    setPmModalOpen(false);
    setBannerSuccess(`支払方法「${res.data.item.methodCode}: ${res.data.item.methodName}」を保存しました。`);
    await reloadPaymentMethods();
  }

  async function handleDeletePm(pm: PaymentMethodDto) {
    setBannerError(null);
    setBannerSuccess(null);
    if (!window.confirm(`支払方法「${pm.methodCode}: ${pm.methodName}」を削除しますか？`)) {
      return;
    }
    const res = await requestMasterApi<{ ok: true }>(
      `/api/v1/masters/payment-methods/${encodeURIComponent(pm.id)}`,
      { method: 'DELETE' },
    );
    if (!res.ok) {
      setBannerError(res.error);
      return;
    }
    setBannerSuccess(`支払方法「${pm.methodName}」を削除しました。`);
    await reloadPaymentMethods();
  }

  // --------------------------------------------------------------------------
  // Handlers: Tax Codes
  // --------------------------------------------------------------------------
  async function reloadTaxCodes() {
    const res = await requestMasterApi<{ items: TaxCodeDto[] }>('/api/v1/masters/tax-codes');
    if (!res.ok) {
      setBannerError(res.error);
      return;
    }
    setTaxCodes(res.data.items);
  }

  function openEditTax(tc: TaxCodeDto) {
    setEditingTax(tc);
    setTaxName(tc.taxName);
    setTaxRate(String(tc.taxRate));
    setMarkSymbol(tc.markSymbol);
    setIsInternal(tc.isInternal);
    setTaxModalError(null);
    setTaxModalOpen(true);
  }

  async function handleSaveTax(e: React.FormEvent) {
    e.preventDefault();
    if (editingTax === null) return;
    setTaxModalError(null);
    setBannerSuccess(null);
    const payload: TaxCodeUpdateInput = {
      taxName: taxName.trim(),
      taxRate: Number(taxRate.trim()),
      markSymbol: markSymbol.trim(),
      isInternal,
    };
    setSaving(true);
    const res = await requestMasterApi<{ item: TaxCodeDto }>(
      `/api/v1/masters/tax-codes/${encodeURIComponent(editingTax.id)}`,
      {
        method: 'PUT',
        body: JSON.stringify(payload),
      },
    );
    setSaving(false);
    if (!res.ok) {
      setTaxModalError(res.error);
      return;
    }
    setTaxModalOpen(false);
    setBannerSuccess(`税区分「${res.data.item.taxCode}: ${res.data.item.taxName}」を更新しました。`);
    await reloadTaxCodes();
  }

  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-xl font-bold text-slate-900">区分・単位・税・支払方法マスタ</h1>
        <p className="text-xs text-slate-500 mt-0.5">
          汎用区分全16ドメイン、単位、支払方法、税区分の4領域を一元管理します。
        </p>
      </div>

      {bannerError !== null && (
        <div className="rounded-lg border border-red-300 bg-red-50 px-4 py-3 text-sm text-red-700">
          {bannerError}
        </div>
      )}
      {bannerSuccess !== null && (
        <div className="rounded-lg border border-emerald-300 bg-emerald-50 px-4 py-3 text-sm text-emerald-800">
          {bannerSuccess}
        </div>
      )}

      <div className="flex flex-wrap border-b border-slate-200 gap-1">
        {(
          [
            ['code-masters', `1. 汎用区分（${CODE_MASTER_DOMAINS.length}種 / ${codeMasters.length}件）`],
            ['units', `2. 単位（${units.length}件）`],
            ['payment-methods', `3. 支払・回収方法（${paymentMethods.length}件）`],
            ['tax-codes', `4. 税区分（${taxCodes.length}件）`],
          ] as const
        ).map(([tabKey, label]) => (
          <button
            key={tabKey}
            type="button"
            onClick={() => {
              setActiveTab(tabKey);
              setBannerError(null);
            }}
            className={`rounded-t-lg px-4 py-2 text-xs font-semibold border-b-2 transition-colors ${
              activeTab === tabKey
                ? 'border-blue-600 text-blue-700 bg-white'
                : 'border-transparent text-slate-500 hover:text-slate-800'
            }`}
          >
            {label}
          </button>
        ))}
      </div>

      {/* Tab 1: 汎用区分16ドメイン */}
      {activeTab === 'code-masters' && (
        <div className="grid grid-cols-1 md:grid-cols-12 gap-4 items-start">
          <div className="md:col-span-4 rounded-xl border border-slate-200 bg-white overflow-hidden">
            <div className="border-b border-slate-200 bg-slate-50 px-4 py-2.5 text-xs font-bold text-slate-700">
              区分ドメイン（16種）
            </div>
            <div className="divide-y divide-slate-100 max-h-[540px] overflow-y-auto">
              {CODE_MASTER_DOMAINS.map((d) => {
                const rawCount = domainCounts.get(d.domainKey);
                const count = rawCount === undefined ? 0 : rawCount;
                const active = d.domainKey === selectedDomainKey;
                return (
                  <button
                    key={d.domainKey}
                    type="button"
                    onClick={() => setSelectedDomainKey(d.domainKey)}
                    className={`w-full text-left px-4 py-2.5 flex items-center justify-between transition-colors ${
                      active ? 'bg-blue-50 text-blue-700 font-semibold' : 'hover:bg-slate-50 text-slate-700'
                    }`}
                  >
                    <div>
                      <div className="text-xs">{d.label}</div>
                      <div className="text-[10px] font-mono text-slate-400">{d.domainKey}</div>
                    </div>
                    <span className="rounded-full bg-slate-100 px-2 py-0.5 font-mono text-[11px] text-slate-600">
                      {count}
                    </span>
                  </button>
                );
              })}
            </div>
          </div>

          <div className="md:col-span-8 rounded-xl border border-slate-200 bg-white overflow-hidden">
            <div className="flex flex-wrap items-center justify-between gap-2 border-b border-slate-200 bg-slate-50 px-4 py-3">
              <div>
                <h2 className="text-sm font-bold text-slate-900">
                  {selectedDomainMeta?.label ?? selectedDomainKey}（{selectedDomainKey}）
                </h2>
                <p className="text-[11px] text-slate-500">{selectedDomainMeta?.description ?? ''}</p>
              </div>
              <button
                type="button"
                onClick={openCreateCodeMaster}
                className="rounded-lg bg-blue-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-blue-700"
              >
                ＋ 区分コード追加
              </button>
            </div>

            <div className="overflow-x-auto">
              <table className="min-w-full divide-y divide-slate-200 text-xs">
                <thead className="bg-slate-50 text-left font-semibold text-slate-600">
                  <tr>
                    <th className="px-4 py-2">表示順</th>
                    <th className="px-4 py-2">コード</th>
                    <th className="px-4 py-2">名称</th>
                    <th className="px-4 py-2">状態</th>
                    <th className="px-4 py-2 text-right">操作</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {currentDomainItems.map((cm) => (
                    <tr key={cm.id} className={!cm.isActive ? 'bg-slate-50 opacity-60' : 'hover:bg-slate-50'}>
                      <td className="px-4 py-2 font-mono text-slate-500">{cm.displayOrder}</td>
                      <td className="px-4 py-2 font-mono font-semibold text-slate-800">{cm.code}</td>
                      <td className="px-4 py-2 font-medium text-slate-900">{cm.name}</td>
                      <td className="px-4 py-2 space-x-1">
                        {cm.isActive ? (
                          <span className="rounded bg-emerald-50 px-2 py-0.5 text-[11px] text-emerald-700">
                            有効
                          </span>
                        ) : (
                          <span className="rounded bg-slate-200 px-2 py-0.5 text-[11px] text-slate-600">
                            無効
                          </span>
                        )}
                        {cm.isProtected && (
                          <span className="rounded bg-amber-100 px-2 py-0.5 text-[11px] text-amber-800">
                            システム固定
                          </span>
                        )}
                      </td>
                      <td className="px-4 py-2 text-right space-x-1.5 whitespace-nowrap">
                        <button
                          type="button"
                          onClick={() => openEditCodeMaster(cm)}
                          className="rounded border border-slate-300 px-2.5 py-0.5 text-[11px] text-slate-700 hover:bg-slate-100"
                        >
                          編集
                        </button>
                        {!cm.isProtected && (
                          <button
                            type="button"
                            onClick={() => void handleDeleteCodeMaster(cm)}
                            className="rounded border border-red-200 px-2.5 py-0.5 text-[11px] text-red-600 hover:bg-red-50"
                          >
                            削除
                          </button>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        </div>
      )}

      {/* Tab 2: 単位マスタ */}
      {activeTab === 'units' && (
        <div className="rounded-xl border border-slate-200 bg-white overflow-hidden">
          <div className="flex flex-wrap items-center justify-between gap-2 border-b border-slate-200 bg-slate-50 px-4 py-3">
            <label className="flex items-center gap-2 text-xs text-slate-700">
              <input
                type="checkbox"
                checked={showDeletedUnits}
                onChange={(e) => setShowDeletedUnits(e.target.checked)}
              />
              論理削除済み単位も表示する
            </label>
            <button
              type="button"
              onClick={openCreateUnit}
              className="rounded-lg bg-blue-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-blue-700"
            >
              ＋ 新規単位登録
            </button>
          </div>
          <div className="overflow-x-auto">
            <table className="min-w-full divide-y divide-slate-200 text-xs">
              <thead className="bg-slate-50 text-left font-semibold text-slate-600">
                <tr>
                  <th className="px-4 py-2">表示順</th>
                  <th className="px-4 py-2">コード</th>
                  <th className="px-4 py-2">単位名</th>
                  <th className="px-4 py-2">換算単位名</th>
                  <th className="px-4 py-2 text-right">換算比率</th>
                  <th className="px-4 py-2">状態</th>
                  <th className="px-4 py-2 text-right">操作</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {visibleUnits.map((u) => (
                  <tr key={u.id} className={u.isDeleted ? 'bg-slate-50 opacity-60' : 'hover:bg-slate-50'}>
                    <td className="px-4 py-2 font-mono text-slate-500">{u.displayOrder}</td>
                    <td className="px-4 py-2 font-mono font-semibold text-slate-800">{u.unitCode}</td>
                    <td className="px-4 py-2 font-medium text-slate-900">{u.unitName}</td>
                    <td className="px-4 py-2 text-slate-600">{u.conversionName ?? '-'}</td>
                    <td className="px-4 py-2 text-right font-mono text-slate-700">{u.conversionRatio}</td>
                    <td className="px-4 py-2">
                      {u.isDeleted ? (
                        <span className="rounded bg-red-100 px-2 py-0.5 text-[11px] text-red-700">削除済</span>
                      ) : (
                        <span className="rounded bg-emerald-50 px-2 py-0.5 text-[11px] text-emerald-700">有効</span>
                      )}
                    </td>
                    <td className="px-4 py-2 text-right">
                      <button
                        type="button"
                        onClick={() => openEditUnit(u)}
                        className="rounded border border-slate-300 px-2.5 py-0.5 text-[11px] text-slate-700 hover:bg-slate-100"
                      >
                        編集
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* Tab 3: 支払・回収方法 */}
      {activeTab === 'payment-methods' && (
        <div className="rounded-xl border border-slate-200 bg-white overflow-hidden">
          <div className="flex items-center justify-between border-b border-slate-200 bg-slate-50 px-4 py-3">
            <span className="text-xs text-slate-600">
              標準コード A〜I はアプラス・振込手数料連携保護のため削除不可（名称編集のみ可能）です。
            </span>
            <button
              type="button"
              onClick={openCreatePm}
              className="rounded-lg bg-blue-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-blue-700"
            >
              ＋ 支払方法追加
            </button>
          </div>
          <div className="overflow-x-auto">
            <table className="min-w-full divide-y divide-slate-200 text-xs">
              <thead className="bg-slate-50 text-left font-semibold text-slate-600">
                <tr>
                  <th className="px-4 py-2">コード</th>
                  <th className="px-4 py-2">支払・回収方法名</th>
                  <th className="px-4 py-2">種別</th>
                  <th className="px-4 py-2 text-right">操作</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {paymentMethods.map((pm) => (
                  <tr key={pm.id} className="hover:bg-slate-50">
                    <td className="px-4 py-2 font-mono font-semibold text-slate-800">{pm.methodCode}</td>
                    <td className="px-4 py-2 font-medium text-slate-900">{pm.methodName}</td>
                    <td className="px-4 py-2">
                      {pm.isProtected ? (
                        <span className="rounded bg-amber-100 px-2 py-0.5 text-[11px] text-amber-800">
                          システム標準
                        </span>
                      ) : (
                        <span className="rounded bg-slate-100 px-2 py-0.5 text-[11px] text-slate-600">
                          ユーザー追加
                        </span>
                      )}
                    </td>
                    <td className="px-4 py-2 text-right space-x-1.5">
                      <button
                        type="button"
                        onClick={() => openEditPm(pm)}
                        className="rounded border border-slate-300 px-2.5 py-0.5 text-[11px] text-slate-700 hover:bg-slate-100"
                      >
                        編集
                      </button>
                      {!pm.isProtected && (
                        <button
                          type="button"
                          onClick={() => void handleDeletePm(pm)}
                          className="rounded border border-red-200 px-2.5 py-0.5 text-[11px] text-red-600 hover:bg-red-50"
                        >
                          削除
                        </button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* Tab 4: 税区分 */}
      {activeTab === 'tax-codes' && (
        <div className="rounded-xl border border-slate-200 bg-white overflow-hidden">
          <div className="border-b border-slate-200 bg-slate-50 px-4 py-3 text-xs text-slate-600">
            税区分 A〜E のシステムコードは削除・追加不可です。
            {!isAdmin && (
              <span className="ml-2 rounded bg-amber-100 px-2 py-0.5 font-semibold text-amber-900">
                ※ 管理者権限のみ変更可能（閲覧専用）
              </span>
            )}
          </div>
          <div className="overflow-x-auto">
            <table className="min-w-full divide-y divide-slate-200 text-xs">
              <thead className="bg-slate-50 text-left font-semibold text-slate-600">
                <tr>
                  <th className="px-4 py-2">税コード</th>
                  <th className="px-4 py-2">税区分名</th>
                  <th className="px-4 py-2 text-right">税率</th>
                  <th className="px-4 py-2">印字記号</th>
                  <th className="px-4 py-2">内外区分</th>
                  <th className="px-4 py-2 text-right">操作</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {taxCodes.map((tc) => (
                  <tr key={tc.id} className="hover:bg-slate-50">
                    <td className="px-4 py-2 font-mono font-bold text-slate-900">{tc.taxCode}</td>
                    <td className="px-4 py-2 font-medium text-slate-900">{tc.taxName}</td>
                    <td className="px-4 py-2 text-right font-mono text-slate-800">
                      {formatPercent(tc.taxRate)} ({tc.taxRate})
                    </td>
                    <td className="px-4 py-2 font-mono text-slate-700">{tc.markSymbol}</td>
                    <td className="px-4 py-2">
                      {tc.isInternal ? (
                        <span className="rounded bg-indigo-50 px-2 py-0.5 text-[11px] text-indigo-700">内税</span>
                      ) : (
                        <span className="rounded bg-slate-100 px-2 py-0.5 text-[11px] text-slate-700">外税/非課税</span>
                      )}
                    </td>
                    <td className="px-4 py-2 text-right">
                      {isAdmin ? (
                        <button
                          type="button"
                          onClick={() => openEditTax(tc)}
                          className="rounded border border-slate-300 px-2.5 py-0.5 text-[11px] text-slate-700 hover:bg-slate-100"
                        >
                          編集
                        </button>
                      ) : (
                        <span className="text-[11px] text-slate-400">閲覧のみ</span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* Modal: 汎用区分 */}
      {cmModalOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/50 p-4">
          <div className="w-full max-w-md rounded-xl bg-white shadow-xl border border-slate-200">
            <div className="flex items-center justify-between border-b border-slate-200 px-5 py-3.5">
              <h3 className="text-sm font-bold text-slate-900">
                {editingCm === null ? '区分コード追加' : '区分コード編集'}
              </h3>
              <button type="button" onClick={() => setCmModalOpen(false)} className="text-sm text-slate-500">
                ✕
              </button>
            </div>
            <form onSubmit={(e) => void handleSaveCodeMaster(e)} className="p-5 space-y-3">
              {cmModalError !== null && (
                <div className="rounded border border-red-300 bg-red-50 px-3 py-2 text-xs text-red-700">
                  {cmModalError}
                </div>
              )}
              <div>
                <label className="block text-xs font-medium text-slate-700 mb-1">ドメイン</label>
                <input
                  type="text"
                  disabled
                  value={`${selectedDomainMeta?.label ?? ''} (${selectedDomainKey})`}
                  className="w-full rounded-lg border border-slate-200 bg-slate-100 px-3 py-1.5 text-xs text-slate-600"
                />
              </div>
              <div>
                <label className="block text-xs font-medium text-slate-700 mb-1">コード *</label>
                <input
                  type="text"
                  required
                  disabled={editingCm?.isProtected === true}
                  value={cmCode}
                  onChange={(e) => setCmCode(e.target.value)}
                  className="w-full rounded-lg border border-slate-300 px-3 py-1.5 text-sm font-mono disabled:bg-slate-100"
                />
              </div>
              <div>
                <label className="block text-xs font-medium text-slate-700 mb-1">名称 *</label>
                <input
                  type="text"
                  required
                  value={cmName}
                  onChange={(e) => setCmName(e.target.value)}
                  className="w-full rounded-lg border border-slate-300 px-3 py-1.5 text-sm"
                />
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-xs font-medium text-slate-700 mb-1">表示順</label>
                  <input
                    type="number"
                    min={0}
                    value={cmOrder}
                    onChange={(e) => setCmOrder(e.target.value)}
                    className="w-full rounded-lg border border-slate-300 px-3 py-1.5 text-sm font-mono"
                  />
                </div>
                <div className="flex items-end pb-1">
                  <label className="flex items-center gap-2 text-xs text-slate-700">
                    <input
                      type="checkbox"
                      disabled={editingCm?.isProtected === true}
                      checked={cmActive}
                      onChange={(e) => setCmActive(e.target.checked)}
                    />
                    有効フラグ
                  </label>
                </div>
              </div>
              <div className="flex justify-end gap-2 pt-3 border-t border-slate-200">
                <button
                  type="button"
                  onClick={() => setCmModalOpen(false)}
                  className="rounded-lg border border-slate-300 px-3 py-1.5 text-xs"
                >
                  キャンセル
                </button>
                <button
                  type="submit"
                  disabled={saving}
                  className="rounded-lg bg-blue-600 px-4 py-1.5 text-xs font-medium text-white hover:bg-blue-700 disabled:opacity-50"
                >
                  保存
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* Modal: 単位 */}
      {unitModalOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/50 p-4">
          <div className="w-full max-w-md rounded-xl bg-white shadow-xl border border-slate-200">
            <div className="flex items-center justify-between border-b border-slate-200 px-5 py-3.5">
              <h3 className="text-sm font-bold text-slate-900">
                {editingUnitId === null ? '新規単位登録' : '単位の編集'}
              </h3>
              <button type="button" onClick={() => setUnitModalOpen(false)} className="text-sm text-slate-500">
                ✕
              </button>
            </div>
            <form onSubmit={(e) => void handleSaveUnit(e)} className="p-5 space-y-3">
              {unitModalError !== null && (
                <div className="rounded border border-red-300 bg-red-50 px-3 py-2 text-xs text-red-700">
                  {unitModalError}
                </div>
              )}
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-xs font-medium text-slate-700 mb-1">単位コード *</label>
                  <input
                    type="text"
                    required
                    value={unitCode}
                    onChange={(e) => setUnitCode(e.target.value)}
                    className="w-full rounded-lg border border-slate-300 px-3 py-1.5 text-sm font-mono"
                  />
                </div>
                <div>
                  <label className="block text-xs font-medium text-slate-700 mb-1">単位名 *</label>
                  <input
                    type="text"
                    required
                    value={unitName}
                    onChange={(e) => setUnitName(e.target.value)}
                    className="w-full rounded-lg border border-slate-300 px-3 py-1.5 text-sm"
                  />
                </div>
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-xs font-medium text-slate-700 mb-1">換算単位名</label>
                  <input
                    type="text"
                    value={conversionName}
                    onChange={(e) => setConversionName(e.target.value)}
                    className="w-full rounded-lg border border-slate-300 px-3 py-1.5 text-sm"
                  />
                </div>
                <div>
                  <label className="block text-xs font-medium text-slate-700 mb-1">換算比率</label>
                  <input
                    type="number"
                    step="0.0001"
                    min={0}
                    value={conversionRatio}
                    onChange={(e) => setConversionRatio(e.target.value)}
                    className="w-full rounded-lg border border-slate-300 px-3 py-1.5 text-sm font-mono"
                  />
                </div>
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-xs font-medium text-slate-700 mb-1">表示順</label>
                  <input
                    type="number"
                    min={0}
                    value={unitOrder}
                    onChange={(e) => setUnitOrder(e.target.value)}
                    className="w-full rounded-lg border border-slate-300 px-3 py-1.5 text-sm font-mono"
                  />
                </div>
                <div className="flex items-end pb-1">
                  <label className="flex items-center gap-2 text-xs text-red-700">
                    <input
                      type="checkbox"
                      checked={unitDeleted}
                      onChange={(e) => setUnitDeleted(e.target.checked)}
                    />
                    論理削除フラグ
                  </label>
                </div>
              </div>
              <div className="flex justify-end gap-2 pt-3 border-t border-slate-200">
                <button
                  type="button"
                  onClick={() => setUnitModalOpen(false)}
                  className="rounded-lg border border-slate-300 px-3 py-1.5 text-xs"
                >
                  キャンセル
                </button>
                <button
                  type="submit"
                  disabled={saving}
                  className="rounded-lg bg-blue-600 px-4 py-1.5 text-xs font-medium text-white hover:bg-blue-700 disabled:opacity-50"
                >
                  保存
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* Modal: 支払方法 */}
      {pmModalOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/50 p-4">
          <div className="w-full max-w-md rounded-xl bg-white shadow-xl border border-slate-200">
            <div className="flex items-center justify-between border-b border-slate-200 px-5 py-3.5">
              <h3 className="text-sm font-bold text-slate-900">
                {editingPm === null ? '支払方法の追加' : '支払方法の編集'}
              </h3>
              <button type="button" onClick={() => setPmModalOpen(false)} className="text-sm text-slate-500">
                ✕
              </button>
            </div>
            <form onSubmit={(e) => void handleSavePm(e)} className="p-5 space-y-3">
              {pmModalError !== null && (
                <div className="rounded border border-red-300 bg-red-50 px-3 py-2 text-xs text-red-700">
                  {pmModalError}
                </div>
              )}
              <div>
                <label className="block text-xs font-medium text-slate-700 mb-1">方法コード *</label>
                <input
                  type="text"
                  required
                  disabled={editingPm?.isProtected === true}
                  value={pmCode}
                  onChange={(e) => setPmCode(e.target.value)}
                  className="w-full rounded-lg border border-slate-300 px-3 py-1.5 text-sm font-mono disabled:bg-slate-100"
                />
              </div>
              <div>
                <label className="block text-xs font-medium text-slate-700 mb-1">方法名 *</label>
                <input
                  type="text"
                  required
                  value={pmName}
                  onChange={(e) => setPmName(e.target.value)}
                  className="w-full rounded-lg border border-slate-300 px-3 py-1.5 text-sm"
                />
              </div>
              <div className="flex justify-end gap-2 pt-3 border-t border-slate-200">
                <button
                  type="button"
                  onClick={() => setPmModalOpen(false)}
                  className="rounded-lg border border-slate-300 px-3 py-1.5 text-xs"
                >
                  キャンセル
                </button>
                <button
                  type="submit"
                  disabled={saving}
                  className="rounded-lg bg-blue-600 px-4 py-1.5 text-xs font-medium text-white hover:bg-blue-700 disabled:opacity-50"
                >
                  保存
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* Modal: 税区分 */}
      {taxModalOpen && editingTax !== null && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/50 p-4">
          <div className="w-full max-w-md rounded-xl bg-white shadow-xl border border-slate-200">
            <div className="flex items-center justify-between border-b border-slate-200 px-5 py-3.5">
              <h3 className="text-sm font-bold text-slate-900">
                税区分「{editingTax.taxCode}」の編集（管理者専用）
              </h3>
              <button type="button" onClick={() => setTaxModalOpen(false)} className="text-sm text-slate-500">
                ✕
              </button>
            </div>
            <form onSubmit={(e) => void handleSaveTax(e)} className="p-5 space-y-3">
              {taxModalError !== null && (
                <div className="rounded border border-red-300 bg-red-50 px-3 py-2 text-xs text-red-700">
                  {taxModalError}
                </div>
              )}
              <div>
                <label className="block text-xs font-medium text-slate-700 mb-1">税区分名 *</label>
                <input
                  type="text"
                  required
                  value={taxName}
                  onChange={(e) => setTaxName(e.target.value)}
                  className="w-full rounded-lg border border-slate-300 px-3 py-1.5 text-sm"
                />
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-xs font-medium text-slate-700 mb-1">税率（0〜1） *</label>
                  <input
                    type="number"
                    step="0.0001"
                    min={0}
                    max={1}
                    required
                    value={taxRate}
                    onChange={(e) => setTaxRate(e.target.value)}
                    className="w-full rounded-lg border border-slate-300 px-3 py-1.5 text-sm font-mono"
                  />
                </div>
                <div>
                  <label className="block text-xs font-medium text-slate-700 mb-1">印字記号 *</label>
                  <input
                    type="text"
                    required
                    value={markSymbol}
                    onChange={(e) => setMarkSymbol(e.target.value)}
                    className="w-full rounded-lg border border-slate-300 px-3 py-1.5 text-sm font-mono"
                  />
                </div>
              </div>
              <label className="flex items-center gap-2 text-xs text-slate-700">
                <input
                  type="checkbox"
                  checked={isInternal}
                  onChange={(e) => setIsInternal(e.target.checked)}
                />
                内税区分として扱う（is_internal）
              </label>
              <div className="flex justify-end gap-2 pt-3 border-t border-slate-200">
                <button
                  type="button"
                  onClick={() => setTaxModalOpen(false)}
                  className="rounded-lg border border-slate-300 px-3 py-1.5 text-xs"
                >
                  キャンセル
                </button>
                <button
                  type="submit"
                  disabled={saving}
                  className="rounded-lg bg-blue-600 px-4 py-1.5 text-xs font-medium text-white hover:bg-blue-700 disabled:opacity-50"
                >
                  更新する
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}
