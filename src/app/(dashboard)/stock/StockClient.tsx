'use client';

import Link from 'next/link';
import { useMemo, useState } from 'react';
import { requestMasterApi } from '@/lib/masters/client-api';
import type { StockPageDto, StockProductItemDto } from '@/lib/stock/stock-service';

interface StockClientProps {
  initialPage: StockPageDto;
}

function formatYen(amount: number): string {
  return `¥${amount.toLocaleString('ja-JP')}`;
}

export default function StockClient({ initialPage }: StockClientProps) {
  const [pageData, setPageData] = useState<StockPageDto>(initialPage);
  const [keyword, setKeyword] = useState('');
  const [managedOnly, setManagedOnly] = useState(false);
  const [loading, setLoading] = useState(false);
  const [message, setMessage] = useState<{ type: 'success' | 'error'; text: string } | null>(null);

  const [editingId, setEditingId] = useState<string | null>(null);
  const [editQtyStr, setEditQtyStr] = useState('0');
  const [editManaged, setEditManaged] = useState(true);
  const [savingId, setSavingId] = useState<string | null>(null);

  const exportCsvHref = useMemo(() => {
    const qs = new URLSearchParams({ format: 'csv' });
    if (keyword.trim() !== '') qs.set('keyword', keyword.trim());
    if (managedOnly) qs.set('managedOnly', '1');
    return `/api/v1/stock/export?${qs.toString()}`;
  }, [keyword, managedOnly]);

  const exportPdfHref = useMemo(() => {
    const qs = new URLSearchParams({ format: 'pdf', inline: '1' });
    if (keyword.trim() !== '') qs.set('keyword', keyword.trim());
    if (managedOnly) qs.set('managedOnly', '1');
    return `/api/v1/stock/export?${qs.toString()}`;
  }, [keyword, managedOnly]);

  async function fetchStock(nextKeyword = keyword, nextManaged = managedOnly) {
    setLoading(true);
    setMessage(null);
    const qs = new URLSearchParams();
    if (nextKeyword.trim() !== '') qs.set('keyword', nextKeyword.trim());
    if (nextManaged) qs.set('managedOnly', '1');
    const res = await requestMasterApi<StockPageDto & { ok: true }>(
      `/api/v1/stock?${qs.toString()}`,
    );
    setLoading(false);
    if (!res.ok) {
      setMessage({ type: 'error', text: res.error });
      return;
    }
    setPageData(res.data);
  }

  function startEdit(item: StockProductItemDto) {
    setEditingId(item.id);
    setEditQtyStr(String(item.stockQuantity));
    setEditManaged(item.isStockManaged);
  }

  async function saveEdit(productId: string) {
    const qty = Number(editQtyStr.trim());
    if (!Number.isFinite(qty)) {
      setMessage({ type: 'error', text: '在庫数は数値で入力してください。' });
      return;
    }
    setSavingId(productId);
    setMessage(null);
    const res = await requestMasterApi<{ ok: true; item: StockProductItemDto }>(
      '/api/v1/stock',
      {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          productId,
          isStockManaged: editManaged,
          stockQuantity: qty,
        }),
      },
    );
    setSavingId(null);
    if (!res.ok) {
      setMessage({ type: 'error', text: res.error });
      return;
    }
    setEditingId(null);
    setMessage({
      type: 'success',
      text: `商品「${res.data.item.productName}」の在庫数を更新しました。`,
    });
    await fetchStock();
  }

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold text-slate-900">在庫・受払照会管理</h1>
          <p className="text-sm text-slate-600 mt-0.5">
            商品マスタの実在庫数調整と、確定仕入(P3)・売上出荷・工事原価消費の受払突合
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <Link
            href="/masters/products"
            className="rounded-lg border border-slate-300 bg-white px-3.5 py-2 text-sm font-medium text-slate-700 hover:bg-slate-50"
          >
            商品マスタへ
          </Link>
          <a
            href={exportCsvHref}
            className="rounded-lg border border-slate-300 bg-white px-3.5 py-2 text-sm font-medium text-slate-700 hover:bg-slate-50"
          >
            在庫一覧 CSV
          </a>
          <a
            href={exportPdfHref}
            target="_blank"
            rel="noopener noreferrer"
            className="rounded-lg bg-slate-900 px-4 py-2 text-sm font-semibold text-white hover:bg-slate-800"
          >
            在庫一覧 PDF
          </a>
        </div>
      </div>

      {message !== null && (
        <div
          className={`rounded-lg border px-4 py-3 text-sm ${
            message.type === 'error'
              ? 'border-red-200 bg-red-50 text-red-800'
              : 'border-emerald-200 bg-emerald-50 text-emerald-800'
          }`}
        >
          {message.text}
        </div>
      )}

      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
        <div className="rounded-xl border border-slate-200 bg-white p-4">
          <div className="text-xs font-medium text-slate-500">対象商品数 / 在庫管理対象</div>
          <div className="mt-1 text-xl font-bold text-slate-900">
            {pageData.totalCount}件{' '}
            <span className="text-sm font-normal text-blue-700">
              （管理中 {pageData.managedCount}件）
            </span>
          </div>
        </div>
        <div className="rounded-xl border border-slate-200 bg-white p-4">
          <div className="text-xs font-medium text-slate-500">総在庫数量合計</div>
          <div className="mt-1 text-xl font-bold font-mono text-slate-900">
            {pageData.totalStockQuantity.toLocaleString('ja-JP')}
          </div>
        </div>
        <div className="rounded-xl border border-slate-200 bg-white p-4">
          <div className="text-xs font-medium text-slate-500">棚卸在庫評価額合計（基準原価ベース）</div>
          <div className="mt-1 text-xl font-bold font-mono text-emerald-700">
            {formatYen(pageData.totalValuation)}
          </div>
        </div>
      </div>

      <form
        onSubmit={(e) => {
          e.preventDefault();
          void fetchStock();
        }}
        className="rounded-xl border border-slate-200 bg-white p-4 flex flex-wrap items-center gap-3"
      >
        <input
          type="text"
          value={keyword}
          onChange={(e) => setKeyword(e.target.value)}
          placeholder="商品コード・商品名で検索"
          className="flex-1 min-w-[220px] rounded-lg border border-slate-300 px-3 py-1.5 text-sm"
        />
        <label className="inline-flex items-center gap-2 text-sm text-slate-700 cursor-pointer">
          <input
            type="checkbox"
            checked={managedOnly}
            onChange={(e) => setManagedOnly(e.target.checked)}
            className="rounded border-slate-300"
          />
          在庫管理対象のみ表示
        </label>
        <button
          type="submit"
          disabled={loading}
          className="rounded-lg bg-slate-900 px-4 py-1.5 text-sm font-medium text-white hover:bg-slate-800"
        >
          {loading ? '検索中...' : '検索'}
        </button>
      </form>

      <div className="rounded-xl border border-slate-200 bg-white overflow-hidden">
        <div className="overflow-x-auto">
          <table className="min-w-full divide-y divide-slate-200 text-sm">
            <thead className="bg-slate-50 text-xs font-semibold text-slate-600">
              <tr>
                <th className="px-3 py-2.5 text-left">商品CD / 商品名</th>
                <th className="px-3 py-2.5 text-left">分類 / 単位</th>
                <th className="px-3 py-2.5 text-center">管理フラグ</th>
                <th className="px-3 py-2.5 text-right">仕入累計(P3)</th>
                <th className="px-3 py-2.5 text-right">売上/原価出庫</th>
                <th className="px-3 py-2.5 text-right">現在在庫数</th>
                <th className="px-3 py-2.5 text-right">基準原価 / 評価額</th>
                <th className="px-3 py-2.5 text-right">操作</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {pageData.items.length === 0 ? (
                <tr>
                  <td colSpan={8} className="px-4 py-10 text-center text-slate-500">
                    該当する商品データがありません。
                  </td>
                </tr>
              ) : (
                pageData.items.map((item) => {
                  const isEditing = editingId === item.id;
                  return (
                    <tr key={item.id} className="hover:bg-slate-50/70">
                      <td className="px-3 py-2.5">
                        <div className="font-mono text-xs text-slate-500">{item.productCode}</div>
                        <div className="font-medium text-slate-900">{item.productName}</div>
                      </td>
                      <td className="px-3 py-2.5 text-xs text-slate-600">
                        <div>{item.categoryName}</div>
                        <div>単位: {item.unitName}</div>
                      </td>
                      <td className="px-3 py-2.5 text-center">
                        {isEditing ? (
                          <label className="inline-flex items-center gap-1 text-xs">
                            <input
                              type="checkbox"
                              checked={editManaged}
                              onChange={(e) => setEditManaged(e.target.checked)}
                            />
                            管理中
                          </label>
                        ) : (
                          <span
                            className={`rounded-full px-2 py-0.5 text-xs font-semibold ${
                              item.isStockManaged
                                ? 'bg-blue-100 text-blue-800'
                                : 'bg-slate-100 text-slate-600'
                            }`}
                          >
                            {item.isStockManaged ? '管理中' : '対象外'}
                          </span>
                        )}
                      </td>
                      <td className="px-3 py-2.5 text-right font-mono text-xs">
                        {item.purchasedQty.toLocaleString('ja-JP')}
                      </td>
                      <td className="px-3 py-2.5 text-right font-mono text-xs text-slate-600">
                        売上 {item.soldQty.toLocaleString('ja-JP')} / 原価{' '}
                        {item.costConsumedQty.toLocaleString('ja-JP')}
                      </td>
                      <td className="px-3 py-2.5 text-right font-mono font-semibold">
                        {isEditing ? (
                          <input
                            type="number"
                            step="0.0001"
                            value={editQtyStr}
                            onChange={(e) => setEditQtyStr(e.target.value)}
                            className="w-24 rounded border border-blue-400 px-2 py-1 text-right"
                          />
                        ) : (
                          item.stockQuantity.toLocaleString('ja-JP')
                        )}
                      </td>
                      <td className="px-3 py-2.5 text-right font-mono text-xs">
                        <div>単価 {formatYen(item.standardCostPrice)}</div>
                        <div className="font-semibold text-emerald-700">
                          {formatYen(item.stockValuation)}
                        </div>
                      </td>
                      <td className="px-3 py-2.5 text-right whitespace-nowrap">
                        {isEditing ? (
                          <div className="flex justify-end gap-1">
                            <button
                              type="button"
                              disabled={savingId === item.id}
                              onClick={() => void saveEdit(item.id)}
                              className="rounded bg-blue-600 px-2.5 py-1 text-xs font-semibold text-white"
                            >
                              保存
                            </button>
                            <button
                              type="button"
                              onClick={() => setEditingId(null)}
                              className="rounded border border-slate-300 px-2 py-1 text-xs"
                            >
                              取消
                            </button>
                          </div>
                        ) : (
                          <button
                            type="button"
                            onClick={() => startEdit(item)}
                            className="rounded border border-slate-300 bg-white px-2.5 py-1 text-xs font-medium text-slate-700 hover:bg-slate-50"
                          >
                            在庫調整
                          </button>
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
    </div>
  );
}
