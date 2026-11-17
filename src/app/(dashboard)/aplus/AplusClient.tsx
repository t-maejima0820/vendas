'use client';

import { useState } from 'react';
import type {
  AplusExportDto,
  AplusImportDto,
  ImportAplusResultsOutput,
} from '@/lib/aplus/types';
import { requestMasterApi } from '@/lib/masters/client-api';

interface AplusClientProps {
  defaultConsignorCode: string;
  openingBalanceDate: string;
  defaultTransferDate: string;
  defaultPeriodStart: string;
  defaultPeriodEnd: string;
  initialExports: AplusExportDto[];
  initialImports: AplusImportDto[];
}

function formatYen(amount: number): string {
  return `¥${amount.toLocaleString('ja-JP')}`;
}

export default function AplusClient({
  defaultConsignorCode,
  openingBalanceDate,
  defaultTransferDate,
  defaultPeriodStart,
  defaultPeriodEnd,
  initialExports,
  initialImports,
}: AplusClientProps) {
  const [activeTab, setActiveTab] = useState<'EXPORTS' | 'IMPORTS'>('EXPORTS');

  // 振替データ作成・出力タブ
  const [exportsList, setExportsList] = useState<AplusExportDto[]>(initialExports);
  const [transferDate, setTransferDate] = useState(defaultTransferDate);
  const [consignorCode, setConsignorCode] = useState(defaultConsignorCode);
  const [periodStart, setPeriodStart] = useState(defaultPeriodStart);
  const [periodEnd, setPeriodEnd] = useState(defaultPeriodEnd);
  const [varEdits, setVarEdits] = useState<Record<string, string>>({});

  // 結果取込タブ
  const [importsList, setImportsList] = useState<AplusImportDto[]>(initialImports);
  const [rawText, setRawText] = useState('');
  const [importDefaultDate, setImportDefaultDate] = useState(defaultTransferDate);
  const [autoCreateReceipts, setAutoCreateReceipts] = useState(true);
  const [importFilter, setImportFilter] = useState<'ALL' | 'OK' | 'ERROR'>('ALL');

  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [bannerError, setBannerError] = useState<string | null>(null);
  const [bannerSuccess, setBannerSuccess] = useState<string | null>(null);

  async function reloadExports(filterDate?: string) {
    setLoading(true);
    setBannerError(null);
    const params = new URLSearchParams();
    if (filterDate !== undefined && filterDate !== '') {
      params.set('transferDate', filterDate);
    }
    const res = await requestMasterApi<{ items: AplusExportDto[] }>(
      `/api/v1/aplus/exports?${params.toString()}`,
    );
    setLoading(false);
    if (!res.ok) {
      setBannerError(res.error);
      return;
    }
    setExportsList(res.data.items);
  }

  async function reloadImports(statusFilter: 'ALL' | 'OK' | 'ERROR' = importFilter) {
    setLoading(true);
    setBannerError(null);
    const params = new URLSearchParams();
    if (statusFilter !== 'ALL') params.set('statusFilter', statusFilter);
    const res = await requestMasterApi<{ items: AplusImportDto[] }>(
      `/api/v1/aplus/imports?${params.toString()}`,
    );
    setLoading(false);
    if (!res.ok) {
      setBannerError(res.error);
      return;
    }
    setImportsList(res.data.items);
  }

  async function handleGenerateExports(e: React.FormEvent) {
    e.preventDefault();
    setBannerError(null);
    setBannerSuccess(null);
    setSaving(true);
    const res = await requestMasterApi<{ items: AplusExportDto[] }>('/api/v1/aplus/exports', {
      method: 'POST',
      body: JSON.stringify({
        transferDate,
        consignorCode,
        periodStart,
        periodEnd,
        replaceUnexported: true,
      }),
    });
    setSaving(false);
    if (!res.ok) {
      setBannerError(res.error);
      return;
    }
    setExportsList(res.data.items);
    setBannerSuccess(`振替日 ${transferDate} の依頼データを ${res.data.items.length}件 作成しました。`);
  }

  async function handleUpdateVariableAmount(row: AplusExportDto) {
    const rawVal = varEdits[row.id];
    if (rawVal === undefined) return;
    const num = Number(rawVal.trim());
    if (!Number.isFinite(num) || !Number.isInteger(num)) {
      setBannerError('変動調整額は整数で入力してください。');
      return;
    }
    setBannerError(null);
    setBannerSuccess(null);
    setSaving(true);
    const res = await requestMasterApi<{ item: AplusExportDto }>(
      `/api/v1/aplus/exports/${encodeURIComponent(row.id)}`,
      {
        method: 'PATCH',
        body: JSON.stringify({ variableAmount: num }),
      },
    );
    setSaving(false);
    if (!res.ok) {
      setBannerError(res.error);
      return;
    }
    setBannerSuccess(`${row.partnerName} の変動調整額を更新しました。`);
    await reloadExports(transferDate);
  }

  async function handleImportFile(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (file === undefined) return;
    const text = await file.text();
    setRawText(text);
  }

  async function handleExecuteImport(e: React.FormEvent) {
    e.preventDefault();
    setBannerError(null);
    setBannerSuccess(null);
    setSaving(true);
    const res = await requestMasterApi<ImportAplusResultsOutput>('/api/v1/aplus/imports', {
      method: 'POST',
      body: JSON.stringify({
        rawText,
        defaultTransferDate: importDefaultDate,
        autoCreateReceipts,
      }),
    });
    setSaving(false);
    if (!res.ok) {
      setBannerError(res.error);
      return;
    }
    setRawText('');
    setBannerSuccess(
      `取込完了: 全${res.data.importedCount}件（振替済: ${res.data.settledCount}件 / 振替不能: ${res.data.failedCount}件 / 自動入金生成: ${res.data.autoCreatedReceiptCount}件）`,
    );
    await reloadImports(importFilter);
  }

  const failedImportsCount = importsList.filter((i) => !i.isSettledOk).length;

  return (
    <div className="max-w-7xl space-y-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold text-slate-900">アプラス口座振替連携</h1>
          <p className="text-sm text-slate-600 mt-1">
            口座振替依頼データの作成・出力（CSV / 全銀固定長120B）および振替結果取込・自動入金生成を行います。
          </p>
        </div>
        <span className="px-2.5 py-1 rounded bg-white border border-slate-200 text-xs font-mono text-slate-600">
          期首基準日: {openingBalanceDate}
        </span>
      </div>

      {/* タブ */}
      <div className="flex items-center gap-2 border-b border-slate-200">
        <button
          type="button"
          onClick={() => setActiveTab('EXPORTS')}
          className={`px-4 py-2.5 text-sm font-medium border-b-2 transition-colors cursor-pointer ${
            activeTab === 'EXPORTS'
              ? 'border-blue-600 text-blue-700'
              : 'border-transparent text-slate-600 hover:text-slate-900'
          }`}
        >
          振替データ作成・出力（{exportsList.length}件）
        </button>
        <button
          type="button"
          onClick={() => {
            setActiveTab('IMPORTS');
            void reloadImports(importFilter);
          }}
          className={`px-4 py-2.5 text-sm font-medium border-b-2 transition-colors cursor-pointer ${
            activeTab === 'IMPORTS'
              ? 'border-blue-600 text-blue-700'
              : 'border-transparent text-slate-600 hover:text-slate-900'
          }`}
        >
          振替結果取込・未収確認（不能: {failedImportsCount}件）
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

      {/* 1. 振替データ作成・出力タブ */}
      {activeTab === 'EXPORTS' ? (
        <div className="space-y-4">
          <form
            onSubmit={handleGenerateExports}
            className="rounded-xl bg-white border border-slate-200 p-4 shadow-xs flex flex-wrap items-end gap-3"
          >
            <div>
              <label className="block text-xs font-medium text-slate-600 mb-1">振替日 *</label>
              <input
                type="date"
                required
                value={transferDate}
                onChange={(e) => setTransferDate(e.target.value)}
                className="rounded-lg border border-slate-300 px-2.5 py-1.5 text-sm"
              />
            </div>
            <div>
              <label className="block text-xs font-medium text-slate-600 mb-1">委託者番号 *</label>
              <input
                type="text"
                required
                value={consignorCode}
                onChange={(e) => setConsignorCode(e.target.value)}
                className="rounded-lg border border-slate-300 px-2.5 py-1.5 text-sm font-mono w-32"
              />
            </div>
            <div>
              <label className="block text-xs font-medium text-slate-600 mb-1">対象期間(開始)</label>
              <input
                type="date"
                required
                value={periodStart}
                onChange={(e) => setPeriodStart(e.target.value)}
                className="rounded-lg border border-slate-300 px-2.5 py-1.5 text-sm"
              />
            </div>
            <div>
              <label className="block text-xs font-medium text-slate-600 mb-1">対象期間(終了)</label>
              <input
                type="date"
                required
                value={periodEnd}
                onChange={(e) => setPeriodEnd(e.target.value)}
                className="rounded-lg border border-slate-300 px-2.5 py-1.5 text-sm"
              />
            </div>
            <button
              type="submit"
              disabled={saving}
              className="rounded-lg bg-blue-600 hover:bg-blue-700 disabled:opacity-60 px-4 py-2 text-xs font-semibold text-white cursor-pointer"
            >
              {saving ? '集計中...' : '依頼データ集計生成'}
            </button>
            <div className="ml-auto flex items-center gap-2">
              <a
                href={`/api/v1/aplus/exports/download?transferDate=${encodeURIComponent(transferDate)}&format=csv`}
                className="rounded-lg border border-slate-300 bg-white hover:bg-slate-50 px-3 py-2 text-xs font-semibold text-slate-700"
              >
                CSVダウンロード
              </a>
              <a
                href={`/api/v1/aplus/exports/download?transferDate=${encodeURIComponent(transferDate)}&format=zengin`}
                className="rounded-lg bg-slate-800 hover:bg-slate-700 px-3 py-2 text-xs font-semibold text-white"
              >
                全銀固定長(120B)出力
              </a>
            </div>
          </form>

          <div className="rounded-xl bg-white border border-slate-200 shadow-xs overflow-hidden">
            <div className="overflow-x-auto">
              <table className="min-w-full divide-y divide-slate-200 text-xs">
                <thead className="bg-slate-50 text-slate-600">
                  <tr>
                    <th className="px-3 py-2.5 text-center">振替日</th>
                    <th className="px-3 py-2.5 text-left">顧客番号 / 取引先</th>
                    <th className="px-3 py-2.5 text-right">定額売上</th>
                    <th className="px-3 py-2.5 text-right">通常売上</th>
                    <th className="px-3 py-2.5 text-right">立替計</th>
                    <th className="px-3 py-2.5 text-right">未回収残高</th>
                    <th className="px-3 py-2.5 text-right">変動調整額</th>
                    <th className="px-3 py-2.5 text-right">振替合計額</th>
                    <th className="px-3 py-2.5 text-center">出力状態</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {exportsList.length === 0 ? (
                    <tr>
                      <td colSpan={9} className="px-4 py-8 text-center text-slate-500">
                        アプラス依頼データはまだ作成されていません。
                      </td>
                    </tr>
                  ) : (
                    exportsList.map((row) => {
                      const editVal =
                        varEdits[row.id] !== undefined
                          ? varEdits[row.id]
                          : String(row.variableAmount);
                      return (
                        <tr key={row.id} className="hover:bg-slate-50">
                          <td className="px-3 py-2 text-center font-mono">{row.transferDate}</td>
                          <td className="px-3 py-2">
                            <span className="font-mono text-slate-400 mr-1.5">
                              {row.customerNo}
                            </span>
                            <span className="font-medium text-slate-900">{row.partnerName}</span>
                          </td>
                          <td className="px-3 py-2 text-right font-mono">
                            {formatYen(row.fixedSalesTotal)}
                          </td>
                          <td className="px-3 py-2 text-right font-mono">
                            {formatYen(row.salesTotal)}
                          </td>
                          <td className="px-3 py-2 text-right font-mono">
                            {formatYen(row.fixedAdvanceTotal + row.advanceTotal)}
                          </td>
                          <td className="px-3 py-2 text-right font-mono">
                            {formatYen(row.uncollectedTotal)}
                          </td>
                          <td className="px-3 py-2 text-right">
                            <div className="inline-flex items-center gap-1">
                              <input
                                type="number"
                                value={editVal}
                                onChange={(e) =>
                                  setVarEdits((prev) => ({ ...prev, [row.id]: e.target.value }))
                                }
                                className="w-24 rounded border border-slate-300 px-1.5 py-0.5 text-right font-mono text-xs"
                              />
                              <button
                                type="button"
                                disabled={saving}
                                onClick={() => void handleUpdateVariableAmount(row)}
                                className="rounded border border-slate-300 bg-white hover:bg-slate-100 px-2 py-0.5 text-[11px] font-medium cursor-pointer"
                              >
                                更新
                              </button>
                            </div>
                          </td>
                          <td className="px-3 py-2 text-right font-mono font-bold text-blue-900">
                            {formatYen(row.totalTransferAmount)}
                          </td>
                          <td className="px-3 py-2 text-center">
                            {row.isExported ? (
                              <span className="px-2 py-0.5 rounded bg-emerald-100 text-emerald-800 font-semibold">
                                出力済
                              </span>
                            ) : (
                              <span className="px-2 py-0.5 rounded bg-amber-100 text-amber-800 font-semibold">
                                未出力
                              </span>
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
      ) : (
        /* 2. 振替結果取込・未収確認タブ */
        <div className="space-y-4">
          <form
            onSubmit={handleExecuteImport}
            className="rounded-xl bg-white border border-slate-200 p-4 shadow-xs space-y-3"
          >
            <div className="flex flex-wrap items-end gap-3">
              <div>
                <label className="block text-xs font-medium text-slate-600 mb-1">
                  結果ファイル選択（CSV / 全銀固定長）
                </label>
                <input
                  type="file"
                  accept=".csv,.txt"
                  onChange={(e) => void handleImportFile(e)}
                  className="text-xs text-slate-600"
                />
              </div>
              <div>
                <label className="block text-xs font-medium text-slate-600 mb-1">既定振替日</label>
                <input
                  type="date"
                  value={importDefaultDate}
                  onChange={(e) => setImportDefaultDate(e.target.value)}
                  className="rounded-lg border border-slate-300 px-2.5 py-1.5 text-sm"
                />
              </div>
              <label className="inline-flex items-center gap-1.5 text-xs text-slate-700 pb-2 cursor-pointer">
                <input
                  type="checkbox"
                  checked={autoCreateReceipts}
                  onChange={(e) => setAutoCreateReceipts(e.target.checked)}
                />
                振替成功行 (result_code = &apos;0&apos;) を自動で入金データ（cash_receipts）へ反映
              </label>
            </div>

            <div>
              <label className="block text-xs font-medium text-slate-600 mb-1">
                取込テキスト内容（作成日,振替日,顧客番号,契約者名,契約額,請求額,振替済額,未払額,結果コード,理由 または 全銀120B）
              </label>
              <textarea
                rows={4}
                required
                value={rawText}
                onChange={(e) => setRawText(e.target.value)}
                placeholder="2026-07-28,2026-07-28,10001,株式会社テスト,50000,50000,50000,0,0,"
                className="w-full rounded-lg border border-slate-300 p-2.5 text-xs font-mono"
              />
            </div>

            <div className="flex justify-end">
              <button
                type="submit"
                disabled={saving}
                className="rounded-lg bg-blue-600 hover:bg-blue-700 disabled:opacity-60 px-4 py-2 text-xs font-semibold text-white cursor-pointer"
              >
                {saving ? '取込中...' : '振替結果を一括取込'}
              </button>
            </div>
          </form>

          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2 text-xs">
              <span className="font-semibold text-slate-700">結果フィルタ:</span>
              {(['ALL', 'OK', 'ERROR'] as const).map((f) => (
                <button
                  key={f}
                  type="button"
                  disabled={loading}
                  onClick={() => {
                    setImportFilter(f);
                    void reloadImports(f);
                  }}
                  className={`rounded-lg px-3 py-1 font-semibold cursor-pointer ${
                    importFilter === f
                      ? 'bg-slate-800 text-white'
                      : 'bg-white border border-slate-300 text-slate-700 hover:bg-slate-50'
                  }`}
                >
                  {f === 'ALL' ? 'すべて' : f === 'OK' ? '振替済 (0)' : '振替不能アラート (!=0)'}
                </button>
              ))}
            </div>
          </div>

          <div className="rounded-xl bg-white border border-slate-200 shadow-xs overflow-hidden">
            <div className="overflow-x-auto">
              <table className="min-w-full divide-y divide-slate-200 text-xs">
                <thead className="bg-slate-50 text-slate-600">
                  <tr>
                    <th className="px-3 py-2.5 text-center">振替日</th>
                    <th className="px-3 py-2.5 text-left">顧客番号 / 契約者名</th>
                    <th className="px-3 py-2.5 text-right">請求額</th>
                    <th className="px-3 py-2.5 text-right">振替済額</th>
                    <th className="px-3 py-2.5 text-right">未払額</th>
                    <th className="px-3 py-2.5 text-center">結果コード</th>
                    <th className="px-3 py-2.5 text-left">結果理由 / 状態</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {importsList.length === 0 ? (
                    <tr>
                      <td colSpan={7} className="px-4 py-8 text-center text-slate-500">
                        振替結果データはありません。
                      </td>
                    </tr>
                  ) : (
                    importsList.map((imp) => (
                      <tr
                        key={imp.id}
                        className={imp.isSettledOk ? 'hover:bg-slate-50' : 'bg-red-50/70'}
                      >
                        <td className="px-3 py-2 text-center font-mono">{imp.transferDate}</td>
                        <td className="px-3 py-2">
                          <span className="font-mono text-slate-400 mr-1.5">{imp.customerNo}</span>
                          <span className="font-medium text-slate-900">
                            {imp.contractorName !== null ? imp.contractorName : '-'}
                          </span>
                        </td>
                        <td className="px-3 py-2 text-right font-mono">
                          {formatYen(imp.billedAmount)}
                        </td>
                        <td className="px-3 py-2 text-right font-mono text-emerald-700 font-semibold">
                          {formatYen(imp.settledAmount)}
                        </td>
                        <td className="px-3 py-2 text-right font-mono text-red-700 font-semibold">
                          {formatYen(imp.unpaidAmount)}
                        </td>
                        <td className="px-3 py-2 text-center font-mono">
                          <span
                            className={`px-2 py-0.5 rounded font-semibold ${
                              imp.isSettledOk
                                ? 'bg-emerald-100 text-emerald-800'
                                : 'bg-red-100 text-red-800'
                            }`}
                          >
                            {imp.resultCode}
                          </span>
                        </td>
                        <td className="px-3 py-2">
                          {imp.isSettledOk
                            ? '正常引落（振替済）'
                            : imp.resultReason !== null
                              ? `未収アラート: ${imp.resultReason}`
                              : '未収アラート: 振替不能'}
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
    </div>
  );
}
