'use client';

import { useMemo, useState } from 'react';
import { normalizeNullableText, requestMasterApi } from '@/lib/masters/client-api';
import type { MasterLookupsDto, ProductDto, ProductInput } from '@/lib/masters/types';

interface ProductsClientProps {
  initialItems: ProductDto[];
  lookups: MasterLookupsDto;
}

interface ProductFormState {
  productCode: string;
  productName: string;
  productNameSub: string;
  monthFlagCode: string;
  capacity: string;
  unitId: string;
  standardUnitPrice: string;
  standardPurchasePrice: string;
  standardCostPrice: string;
  defaultTaxCode: 'A' | 'B' | 'C' | 'D' | 'E';
  itemCategoryCode: string;
  kubun: string;
  isStockManaged: boolean;
  stockQuantity: string;
  isSubscriptionTarget: boolean;
  isHeading: boolean;
  isDeleted: boolean;
}

function emptyProductForm(): ProductFormState {
  return {
    productCode: '',
    productName: '',
    productNameSub: '',
    monthFlagCode: 'A',
    capacity: '0',
    unitId: '',
    standardUnitPrice: '0',
    standardPurchasePrice: '0',
    standardCostPrice: '0',
    defaultTaxCode: 'A',
    itemCategoryCode: '',
    kubun: '',
    isStockManaged: false,
    stockQuantity: '0',
    isSubscriptionTarget: false,
    isHeading: false,
    isDeleted: false,
  };
}

function formFromProduct(p: ProductDto): ProductFormState {
  return {
    productCode: p.productCode,
    productName: p.productName,
    productNameSub: p.productNameSub ?? '',
    monthFlagCode: p.monthFlagCode ?? '',
    capacity: String(p.capacity),
    unitId: p.unitId ?? '',
    standardUnitPrice: String(p.standardUnitPrice),
    standardPurchasePrice: String(p.standardPurchasePrice),
    standardCostPrice: String(p.standardCostPrice),
    defaultTaxCode: p.defaultTaxCode,
    itemCategoryCode: p.itemCategoryCode ?? '',
    kubun: p.kubun ?? '',
    isStockManaged: p.isStockManaged,
    stockQuantity: String(p.stockQuantity),
    isSubscriptionTarget: p.isSubscriptionTarget,
    isHeading: p.isHeading,
    isDeleted: p.isDeleted,
  };
}

function formatYen(value: number): string {
  return `¥${value.toLocaleString('ja-JP')}`;
}

export default function ProductsClient({ initialItems, lookups }: ProductsClientProps) {
  const [items, setItems] = useState<ProductDto[]>(initialItems);
  const [keyword, setKeyword] = useState('');
  const [categoryCode, setCategoryCode] = useState('');
  const [headingOnly, setHeadingOnly] = useState(false);
  const [subscriptionOnly, setSubscriptionOnly] = useState(false);
  const [includeDeleted, setIncludeDeleted] = useState(false);

  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [bannerError, setBannerError] = useState<string | null>(null);
  const [bannerSuccess, setBannerSuccess] = useState<string | null>(null);

  const [modalOpen, setModalOpen] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [modalError, setModalError] = useState<string | null>(null);
  const [form, setForm] = useState<ProductFormState>(() => emptyProductForm());

  const itemClassMap = useMemo(
    () => new Map(lookups.itemClasses.map((c) => [c.code, c.name])),
    [lookups.itemClasses],
  );
  const taxCodeMap = useMemo(
    () => new Map(lookups.taxCodes.map((t) => [t.taxCode, t])),
    [lookups.taxCodes],
  );

  async function reloadList() {
    setLoading(true);
    setBannerError(null);
    const params = new URLSearchParams();
    if (keyword.trim() !== '') params.set('q', keyword.trim());
    if (categoryCode !== '') params.set('categoryCode', categoryCode);
    if (headingOnly) params.set('headingOnly', 'true');
    if (subscriptionOnly) params.set('subscriptionOnly', 'true');
    if (includeDeleted) params.set('includeDeleted', 'true');

    const queryStr = params.toString();
    const url = queryStr !== '' ? `/api/v1/masters/products?${queryStr}` : '/api/v1/masters/products';
    const result = await requestMasterApi<{ items: ProductDto[] }>(url);
    setLoading(false);
    if (!result.ok) {
      setBannerError(result.error);
      return;
    }
    setItems(result.data.items);
  }

  function openCreateModal() {
    setEditingId(null);
    setModalError(null);
    setForm(emptyProductForm());
    setModalOpen(true);
  }

  function openEditModal(item: ProductDto) {
    setEditingId(item.id);
    setModalError(null);
    setForm(formFromProduct(item));
    setModalOpen(true);
  }

  async function handleSave(e: React.FormEvent) {
    e.preventDefault();
    setModalError(null);
    setBannerSuccess(null);

    if (form.productCode.trim() === '' || form.productName.trim() === '') {
      setModalError('商品コードと商品名は必須です。');
      return;
    }

    const unitPrice = Number(form.standardUnitPrice.trim() === '' ? '0' : form.standardUnitPrice.trim());
    const purchasePrice = Number(
      form.standardPurchasePrice.trim() === '' ? '0' : form.standardPurchasePrice.trim(),
    );
    const costPrice = Number(form.standardCostPrice.trim() === '' ? '0' : form.standardCostPrice.trim());
    const capacity = Number(form.capacity.trim() === '' ? '0' : form.capacity.trim());
    const stockQuantity = Number(form.stockQuantity.trim() === '' ? '0' : form.stockQuantity.trim());

    if (!Number.isInteger(unitPrice) || !Number.isInteger(purchasePrice) || !Number.isInteger(costPrice)) {
      setModalError('販売単価・仕入単価・原価単価は整数で入力してください。');
      return;
    }

    const payload: ProductInput = {
      productCode: form.productCode.trim(),
      productName: form.productName.trim(),
      productNameSub: normalizeNullableText(form.productNameSub),
      monthFlagCode: normalizeNullableText(form.monthFlagCode),
      capacity,
      unitId: normalizeNullableText(form.unitId),
      standardUnitPrice: unitPrice,
      standardPurchasePrice: purchasePrice,
      standardCostPrice: costPrice,
      defaultTaxCode: form.defaultTaxCode,
      itemCategoryCode: normalizeNullableText(form.itemCategoryCode),
      kubun: normalizeNullableText(form.kubun),
      isStockManaged: form.isStockManaged,
      stockQuantity,
      isSubscriptionTarget: form.isSubscriptionTarget,
      isHeading: form.isHeading,
      isDeleted: form.isDeleted,
    };

    setSaving(true);
    const url =
      editingId === null
        ? '/api/v1/masters/products'
        : `/api/v1/masters/products/${encodeURIComponent(editingId)}`;
    const method = editingId === null ? 'POST' : 'PUT';

    const result = await requestMasterApi<{ item: ProductDto }>(url, {
      method,
      body: JSON.stringify(payload),
    });
    setSaving(false);

    if (!result.ok) {
      setModalError(result.error);
      return;
    }

    setModalOpen(false);
    setBannerSuccess(
      editingId === null
        ? `商品「${result.data.item.productName}」を登録しました。`
        : `商品「${result.data.item.productName}」を更新しました。`,
    );
    await reloadList();
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-xl font-bold text-slate-900">商品・工事項目マスタ</h1>
          <p className="text-xs text-slate-500 mt-0.5">
            販売・仕入・原価の3単価、消費税区分、単位、見出し行・定額請求対象フラグを管理します。
          </p>
        </div>
        <button
          type="button"
          onClick={openCreateModal}
          className="rounded-lg bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700"
        >
          ＋ 新規商品登録
        </button>
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

      <form
        onSubmit={(e) => {
          e.preventDefault();
          void reloadList();
        }}
        className="flex flex-wrap items-center gap-2 rounded-xl border border-slate-200 bg-white p-3"
      >
        <input
          type="text"
          value={keyword}
          onChange={(e) => setKeyword(e.target.value)}
          placeholder="商品コード・商品名・サブ名称で検索"
          className="flex-1 min-w-[200px] rounded-lg border border-slate-300 px-3 py-1.5 text-sm"
        />
        <select
          value={categoryCode}
          onChange={(e) => setCategoryCode(e.target.value)}
          className="rounded-lg border border-slate-300 px-2.5 py-1.5 text-sm"
        >
          <option value="">商品分類: すべて</option>
          {lookups.itemClasses.map((ic) => (
            <option key={ic.code} value={ic.code}>
              {ic.code}: {ic.name}
            </option>
          ))}
        </select>
        <label className="flex items-center gap-1.5 text-xs text-slate-600 px-1">
          <input
            type="checkbox"
            checked={headingOnly}
            onChange={(e) => setHeadingOnly(e.target.checked)}
          />
          見出しのみ
        </label>
        <label className="flex items-center gap-1.5 text-xs text-slate-600 px-1">
          <input
            type="checkbox"
            checked={subscriptionOnly}
            onChange={(e) => setSubscriptionOnly(e.target.checked)}
          />
          定額対象のみ
        </label>
        <label className="flex items-center gap-1.5 text-xs text-slate-600 px-1">
          <input
            type="checkbox"
            checked={includeDeleted}
            onChange={(e) => setIncludeDeleted(e.target.checked)}
          />
          削除済含む
        </label>
        <button
          type="submit"
          disabled={loading}
          className="rounded-lg bg-slate-800 px-4 py-1.5 text-sm font-medium text-white hover:bg-slate-900 disabled:opacity-50"
        >
          {loading ? '検索中...' : '検索'}
        </button>
      </form>

      <div className="overflow-x-auto rounded-xl border border-slate-200 bg-white">
        <table className="min-w-full divide-y divide-slate-200 text-sm">
          <thead className="bg-slate-50 text-left text-xs font-semibold text-slate-600">
            <tr>
              <th className="px-3 py-2.5">コード</th>
              <th className="px-3 py-2.5">商品名 / サブ名称</th>
              <th className="px-3 py-2.5">分類 / 単位</th>
              <th className="px-3 py-2.5 text-right">販売単価</th>
              <th className="px-3 py-2.5 text-right">仕入 / 原価</th>
              <th className="px-3 py-2.5">税区分</th>
              <th className="px-3 py-2.5">フラグ / 在庫</th>
              <th className="px-3 py-2.5 text-right">操作</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {items.length === 0 ? (
              <tr>
                <td colSpan={8} className="px-4 py-8 text-center text-sm text-slate-500">
                  該当する商品がありません。
                </td>
              </tr>
            ) : (
              items.map((item) => {
                const taxInfo = taxCodeMap.get(item.defaultTaxCode);
                return (
                  <tr
                    key={item.id}
                    className={`hover:bg-slate-50 ${item.isDeleted ? 'opacity-60 bg-slate-50' : ''}`}
                  >
                    <td className="px-3 py-2.5 font-mono text-xs text-slate-700">{item.productCode}</td>
                    <td className="px-3 py-2.5">
                      <div className="font-medium text-slate-900 flex items-center gap-1.5">
                        {item.isHeading && (
                          <span className="rounded bg-slate-200 px-1.5 py-0.5 text-[10px] font-semibold text-slate-700">
                            見出し
                          </span>
                        )}
                        <span>{item.productName}</span>
                      </div>
                      {item.productNameSub !== null && (
                        <div className="text-xs text-slate-500">{item.productNameSub}</div>
                      )}
                    </td>
                    <td className="px-3 py-2.5 text-xs text-slate-600">
                      <div>
                        {item.itemCategoryCode !== null
                          ? (itemClassMap.get(item.itemCategoryCode) ?? item.itemCategoryCode)
                          : '-'}
                      </div>
                      <div className="text-slate-400">
                        単位: {item.unitName ?? '-'} / 容量: {item.capacity}
                      </div>
                    </td>
                    <td className="px-3 py-2.5 text-right font-mono text-xs font-semibold text-slate-900">
                      {formatYen(item.standardUnitPrice)}
                    </td>
                    <td className="px-3 py-2.5 text-right font-mono text-xs text-slate-600">
                      <div>仕入: {formatYen(item.standardPurchasePrice)}</div>
                      <div className="text-slate-400">原価: {formatYen(item.standardCostPrice)}</div>
                    </td>
                    <td className="px-3 py-2.5 text-xs text-slate-700">
                      {item.defaultTaxCode}: {taxInfo !== undefined ? taxInfo.taxName : ''}
                    </td>
                    <td className="px-3 py-2.5 text-xs space-x-1 whitespace-nowrap">
                      {item.isSubscriptionTarget && (
                        <span className="rounded bg-indigo-50 px-1.5 py-0.5 text-[11px] font-medium text-indigo-700">
                          定額
                        </span>
                      )}
                      {item.isStockManaged && (
                        <span className="rounded bg-emerald-50 px-1.5 py-0.5 text-[11px] font-mono text-emerald-700">
                          在庫: {item.stockQuantity}
                        </span>
                      )}
                      {item.isDeleted && (
                        <span className="rounded bg-red-100 px-1.5 py-0.5 text-[11px] text-red-700">
                          削除済
                        </span>
                      )}
                    </td>
                    <td className="px-3 py-2.5 text-right whitespace-nowrap">
                      <button
                        type="button"
                        onClick={() => openEditModal(item)}
                        className="rounded border border-slate-300 px-3 py-1 text-xs font-medium text-slate-700 hover:bg-slate-100"
                      >
                        編集
                      </button>
                    </td>
                  </tr>
                );
              })
            )}
          </tbody>
        </table>
      </div>

      {modalOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/50 p-4">
          <div className="w-full max-w-3xl rounded-xl bg-white shadow-xl border border-slate-200 max-h-[90vh] overflow-y-auto">
            <div className="flex items-center justify-between border-b border-slate-200 px-6 py-4">
              <h2 className="text-base font-bold text-slate-900">
                {editingId === null ? '新規商品登録' : `商品情報の編集: ${form.productCode}`}
              </h2>
              <button
                type="button"
                onClick={() => setModalOpen(false)}
                className="text-sm text-slate-500 hover:text-slate-800"
              >
                ✕ 閉じる
              </button>
            </div>
            <form onSubmit={(e) => void handleSave(e)} className="p-6 space-y-4">
              {modalError !== null && (
                <div className="rounded-lg border border-red-300 bg-red-50 px-3 py-2 text-xs text-red-700">
                  {modalError}
                </div>
              )}

              <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
                <div>
                  <label className="block text-xs font-medium text-slate-700 mb-1">
                    商品コード <span className="text-red-500">*</span>
                  </label>
                  <input
                    type="text"
                    required
                    value={form.productCode}
                    onChange={(e) => setForm({ ...form, productCode: e.target.value })}
                    className="w-full rounded-lg border border-slate-300 px-3 py-1.5 text-sm font-mono"
                  />
                </div>
                <div className="md:col-span-2">
                  <label className="block text-xs font-medium text-slate-700 mb-1">
                    商品名 <span className="text-red-500">*</span>
                  </label>
                  <input
                    type="text"
                    required
                    value={form.productName}
                    onChange={(e) => setForm({ ...form, productName: e.target.value })}
                    className="w-full rounded-lg border border-slate-300 px-3 py-1.5 text-sm"
                  />
                </div>
              </div>

              <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
                <div className="md:col-span-2">
                  <label className="block text-xs font-medium text-slate-700 mb-1">サブ名称・規格</label>
                  <input
                    type="text"
                    value={form.productNameSub}
                    onChange={(e) => setForm({ ...form, productNameSub: e.target.value })}
                    className="w-full rounded-lg border border-slate-300 px-3 py-1.5 text-sm"
                  />
                </div>
                <div>
                  <label className="block text-xs font-medium text-slate-700 mb-1">任意区分</label>
                  <input
                    type="text"
                    value={form.kubun}
                    onChange={(e) => setForm({ ...form, kubun: e.target.value })}
                    className="w-full rounded-lg border border-slate-300 px-3 py-1.5 text-sm"
                  />
                </div>
              </div>

              <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
                <div>
                  <label className="block text-xs font-medium text-slate-700 mb-1">標準販売単価（円）</label>
                  <input
                    type="number"
                    step={1}
                    value={form.standardUnitPrice}
                    onChange={(e) => setForm({ ...form, standardUnitPrice: e.target.value })}
                    className="w-full rounded-lg border border-slate-300 px-3 py-1.5 text-sm font-mono"
                  />
                </div>
                <div>
                  <label className="block text-xs font-medium text-slate-700 mb-1">標準仕入単価（円）</label>
                  <input
                    type="number"
                    step={1}
                    value={form.standardPurchasePrice}
                    onChange={(e) => setForm({ ...form, standardPurchasePrice: e.target.value })}
                    className="w-full rounded-lg border border-slate-300 px-3 py-1.5 text-sm font-mono"
                  />
                </div>
                <div>
                  <label className="block text-xs font-medium text-slate-700 mb-1">標準原価単価（円）</label>
                  <input
                    type="number"
                    step={1}
                    value={form.standardCostPrice}
                    onChange={(e) => setForm({ ...form, standardCostPrice: e.target.value })}
                    className="w-full rounded-lg border border-slate-300 px-3 py-1.5 text-sm font-mono"
                  />
                </div>
                <div>
                  <label className="block text-xs font-medium text-slate-700 mb-1">標準税区分</label>
                  <select
                    value={form.defaultTaxCode}
                    onChange={(e) =>
                      setForm({
                        ...form,
                        defaultTaxCode: e.target.value as 'A' | 'B' | 'C' | 'D' | 'E',
                      })
                    }
                    className="w-full rounded-lg border border-slate-300 px-2.5 py-1.5 text-sm"
                  >
                    {lookups.taxCodes.map((tc) => (
                      <option key={tc.taxCode} value={tc.taxCode}>
                        {tc.taxCode}: {tc.taxName}（印: {tc.markSymbol}）
                      </option>
                    ))}
                  </select>
                </div>
              </div>

              <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
                <div>
                  <label className="block text-xs font-medium text-slate-700 mb-1">単位</label>
                  <select
                    value={form.unitId}
                    onChange={(e) => setForm({ ...form, unitId: e.target.value })}
                    className="w-full rounded-lg border border-slate-300 px-2.5 py-1.5 text-sm"
                  >
                    <option value="">（未選択）</option>
                    {lookups.units.map((u) => (
                      <option key={u.id} value={u.id}>
                        {u.unitCode}: {u.unitName}
                      </option>
                    ))}
                  </select>
                </div>
                <div>
                  <label className="block text-xs font-medium text-slate-700 mb-1">容量・換算係数</label>
                  <input
                    type="number"
                    step="0.0001"
                    value={form.capacity}
                    onChange={(e) => setForm({ ...form, capacity: e.target.value })}
                    className="w-full rounded-lg border border-slate-300 px-3 py-1.5 text-sm font-mono"
                  />
                </div>
                <div>
                  <label className="block text-xs font-medium text-slate-700 mb-1">商品/原価分類</label>
                  <select
                    value={form.itemCategoryCode}
                    onChange={(e) => setForm({ ...form, itemCategoryCode: e.target.value })}
                    className="w-full rounded-lg border border-slate-300 px-2.5 py-1.5 text-sm"
                  >
                    <option value="">（未選択）</option>
                    {lookups.itemClasses.map((ic) => (
                      <option key={ic.code} value={ic.code}>
                        {ic.code}: {ic.name}
                      </option>
                    ))}
                  </select>
                </div>
                <div>
                  <label className="block text-xs font-medium text-slate-700 mb-1">月対象フラグ</label>
                  <select
                    value={form.monthFlagCode}
                    onChange={(e) => setForm({ ...form, monthFlagCode: e.target.value })}
                    className="w-full rounded-lg border border-slate-300 px-2.5 py-1.5 text-sm"
                  >
                    <option value="">（未選択）</option>
                    {lookups.monthFlags.map((mf) => (
                      <option key={mf.code} value={mf.code}>
                        {mf.code}: {mf.name}
                      </option>
                    ))}
                  </select>
                </div>
              </div>

              <div className="flex flex-wrap items-center gap-6 rounded-lg bg-slate-50 border border-slate-200 px-4 py-3 text-xs">
                <label className="flex items-center gap-2 font-medium text-slate-700">
                  <input
                    type="checkbox"
                    checked={form.isHeading}
                    onChange={(e) => setForm({ ...form, isHeading: e.target.checked })}
                  />
                  見出し行フラグ（帳票セクション見出し用）
                </label>
                <label className="flex items-center gap-2 font-medium text-slate-700">
                  <input
                    type="checkbox"
                    checked={form.isSubscriptionTarget}
                    onChange={(e) => setForm({ ...form, isSubscriptionTarget: e.target.checked })}
                  />
                  定額（サブスク）請求対象
                </label>
                <label className="flex items-center gap-2 font-medium text-slate-700">
                  <input
                    type="checkbox"
                    checked={form.isStockManaged}
                    onChange={(e) => setForm({ ...form, isStockManaged: e.target.checked })}
                  />
                  在庫管理対象
                </label>
                {form.isStockManaged && (
                  <div className="flex items-center gap-2">
                    <span className="text-slate-600">現在庫数:</span>
                    <input
                      type="number"
                      step="0.0001"
                      value={form.stockQuantity}
                      onChange={(e) => setForm({ ...form, stockQuantity: e.target.value })}
                      className="w-28 rounded border border-slate-300 bg-white px-2 py-1 text-xs font-mono"
                    />
                  </div>
                )}
                <label className="flex items-center gap-2 font-medium text-red-700">
                  <input
                    type="checkbox"
                    checked={form.isDeleted}
                    onChange={(e) => setForm({ ...form, isDeleted: e.target.checked })}
                  />
                  削除（無効化）フラグ
                </label>
              </div>

              <div className="flex justify-end gap-2 pt-4 border-t border-slate-200">
                <button
                  type="button"
                  onClick={() => setModalOpen(false)}
                  className="rounded-lg border border-slate-300 px-4 py-2 text-sm text-slate-700 hover:bg-slate-100"
                >
                  キャンセル
                </button>
                <button
                  type="submit"
                  disabled={saving}
                  className="rounded-lg bg-blue-600 px-5 py-2 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-50"
                >
                  {saving ? '保存中...' : '商品を保存する'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}
