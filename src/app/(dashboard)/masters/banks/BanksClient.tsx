'use client';

import { useState } from 'react';
import { normalizeNullableText, requestMasterApi } from '@/lib/masters/client-api';
import {
  computeTotalPages,
  type BankBranchDto,
  type BankBranchInput,
  type BankBranchPageDto,
  type BankDto,
  type BankInput,
} from '@/lib/masters/types';

interface BanksClientProps {
  initialBanks: BankDto[];
  initialBranchPage: BankBranchPageDto;
}

export default function BanksClient({ initialBanks, initialBranchPage }: BanksClientProps) {
  const [banks, setBanks] = useState<BankDto[]>(initialBanks);
  const [bankKeyword, setBankKeyword] = useState('');
  const [selectedBankId, setSelectedBankId] = useState<string>('');

  const [branchPage, setBranchPage] = useState<BankBranchPageDto>(initialBranchPage);
  const [branchKeyword, setBranchKeyword] = useState('');

  const [loadingBanks, setLoadingBanks] = useState(false);
  const [loadingBranches, setLoadingBranches] = useState(false);
  const [saving, setSaving] = useState(false);
  const [bannerError, setBannerError] = useState<string | null>(null);
  const [bannerSuccess, setBannerSuccess] = useState<string | null>(null);

  const [bankModalOpen, setBankModalOpen] = useState(false);
  const [editingBankId, setEditingBankId] = useState<string | null>(null);
  const [bankCode, setBankCode] = useState('');
  const [bankName, setBankName] = useState('');
  const [bankFurigana, setBankFurigana] = useState('');
  const [bankModalError, setBankModalError] = useState<string | null>(null);

  const [branchModalOpen, setBranchModalOpen] = useState(false);
  const [editingBranchId, setEditingBranchId] = useState<string | null>(null);
  const [branchParentBankId, setBranchParentBankId] = useState('');
  const [branchCode, setBranchCode] = useState('');
  const [branchName, setBranchName] = useState('');
  const [branchFurigana, setBranchFurigana] = useState('');
  const [branchModalError, setBranchModalError] = useState<string | null>(null);

  const totalPages = computeTotalPages(branchPage.totalCount, branchPage.pageSize);
  const selectedBank = banks.find((b) => b.id === selectedBankId);

  async function reloadBanks(kw: string = bankKeyword) {
    setLoadingBanks(true);
    setBannerError(null);
    const params = new URLSearchParams();
    if (kw.trim() !== '') params.set('q', kw.trim());
    const qStr = params.toString();
    const url = qStr !== '' ? `/api/v1/masters/banks?${qStr}` : '/api/v1/masters/banks';
    const result = await requestMasterApi<{ items: BankDto[] }>(url);
    setLoadingBanks(false);
    if (!result.ok) {
      setBannerError(result.error);
      return;
    }
    setBanks(result.data.items);
  }

  async function reloadBranches(opts?: { bankId?: string; q?: string; page?: number }) {
    const bId = opts?.bankId !== undefined ? opts.bankId : selectedBankId;
    const kw = opts?.q !== undefined ? opts.q : branchKeyword;
    const p = opts?.page !== undefined ? opts.page : branchPage.page;

    setLoadingBranches(true);
    setBannerError(null);
    const params = new URLSearchParams();
    if (bId !== '') params.set('bankId', bId);
    if (kw.trim() !== '') params.set('q', kw.trim());
    params.set('page', String(p));
    params.set('pageSize', String(branchPage.pageSize));

    const result = await requestMasterApi<BankBranchPageDto>(
      `/api/v1/masters/banks/branches?${params.toString()}`,
    );
    setLoadingBranches(false);
    if (!result.ok) {
      setBannerError(result.error);
      return;
    }
    setBranchPage({
      items: result.data.items,
      totalCount: result.data.totalCount,
      page: result.data.page,
      pageSize: result.data.pageSize,
    });
  }

  function openCreateBank() {
    setEditingBankId(null);
    setBankCode('');
    setBankName('');
    setBankFurigana('');
    setBankModalError(null);
    setBankModalOpen(true);
  }

  function openEditBank(b: BankDto) {
    setEditingBankId(b.id);
    setBankCode(b.bankCode);
    setBankName(b.bankName);
    setBankFurigana(b.furigana ?? '');
    setBankModalError(null);
    setBankModalOpen(true);
  }

  async function handleSaveBank(e: React.FormEvent) {
    e.preventDefault();
    setBankModalError(null);
    setBannerSuccess(null);

    const payload: BankInput = {
      bankCode: bankCode.trim(),
      bankName: bankName.trim(),
      furigana: normalizeNullableText(bankFurigana),
    };
    setSaving(true);
    const url =
      editingBankId === null
        ? '/api/v1/masters/banks'
        : `/api/v1/masters/banks/${encodeURIComponent(editingBankId)}`;
    const method = editingBankId === null ? 'POST' : 'PUT';
    const result = await requestMasterApi<{ item: BankDto }>(url, {
      method,
      body: JSON.stringify(payload),
    });
    setSaving(false);
    if (!result.ok) {
      setBankModalError(result.error);
      return;
    }
    setBankModalOpen(false);
    setBannerSuccess(
      editingBankId === null
        ? `銀行「${result.data.item.bankName}」を登録しました。`
        : `銀行「${result.data.item.bankName}」を更新しました。`,
    );
    await reloadBanks();
    await reloadBranches({ page: 1 });
  }

  async function handleDeleteBank(b: BankDto) {
    setBannerError(null);
    setBannerSuccess(null);
    if (!window.confirm(`銀行「${b.bankName}（${b.bankCode}）」を削除しますか？`)) {
      return;
    }
    const result = await requestMasterApi<{ ok: true }>(
      `/api/v1/masters/banks/${encodeURIComponent(b.id)}`,
      { method: 'DELETE' },
    );
    if (!result.ok) {
      setBannerError(result.error);
      return;
    }
    if (selectedBankId === b.id) {
      setSelectedBankId('');
    }
    setBannerSuccess(`銀行「${b.bankName}」を削除しました。`);
    await reloadBanks();
    await reloadBranches({ bankId: selectedBankId === b.id ? '' : selectedBankId, page: 1 });
  }

  function openCreateBranch() {
    setEditingBranchId(null);
    setBranchParentBankId(selectedBankId !== '' ? selectedBankId : (banks[0]?.id ?? ''));
    setBranchCode('');
    setBranchName('');
    setBranchFurigana('');
    setBranchModalError(null);
    setBranchModalOpen(true);
  }

  function openEditBranch(br: BankBranchDto) {
    setEditingBranchId(br.id);
    setBranchParentBankId(br.bankId);
    setBranchCode(br.branchCode);
    setBranchName(br.branchName);
    setBranchFurigana(br.furigana ?? '');
    setBranchModalError(null);
    setBranchModalOpen(true);
  }

  async function handleSaveBranch(e: React.FormEvent) {
    e.preventDefault();
    setBranchModalError(null);
    setBannerSuccess(null);
    const payload: BankBranchInput = {
      bankId: branchParentBankId,
      branchCode: branchCode.trim(),
      branchName: branchName.trim(),
      furigana: normalizeNullableText(branchFurigana),
    };
    setSaving(true);
    const url =
      editingBranchId === null
        ? '/api/v1/masters/banks/branches'
        : `/api/v1/masters/banks/branches/${encodeURIComponent(editingBranchId)}`;
    const method = editingBranchId === null ? 'POST' : 'PUT';
    const result = await requestMasterApi<{ item: BankBranchDto }>(url, {
      method,
      body: JSON.stringify(payload),
    });
    setSaving(false);
    if (!result.ok) {
      setBranchModalError(result.error);
      return;
    }
    setBranchModalOpen(false);
    setBannerSuccess(
      editingBranchId === null
        ? `支店「${result.data.item.branchName}」を登録しました。`
        : `支店「${result.data.item.branchName}」を更新しました。`,
    );
    await reloadBanks();
    await reloadBranches();
  }

  async function handleDeleteBranch(br: BankBranchDto) {
    setBannerError(null);
    setBannerSuccess(null);
    if (!window.confirm(`支店「${br.bankName} ${br.branchName}（${br.branchCode}）」を削除しますか？`)) {
      return;
    }
    const result = await requestMasterApi<{ ok: true }>(
      `/api/v1/masters/banks/branches/${encodeURIComponent(br.id)}`,
      { method: 'DELETE' },
    );
    if (!result.ok) {
      setBannerError(result.error);
      return;
    }
    setBannerSuccess(`支店「${br.branchName}」を削除しました。`);
    await reloadBanks();
    await reloadBranches();
  }

  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-xl font-bold text-slate-900">金融機関・支店マスタ</h1>
        <p className="text-xs text-slate-500 mt-0.5">
          銀行マスタと配下の支店マスタ（1,300件規模対応ページネーション検索）を管理します。
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

      <div className="grid grid-cols-1 lg:grid-cols-12 gap-4 items-start">
        {/* 左ペイン: 銀行マスタ */}
        <section className="lg:col-span-5 rounded-xl border border-slate-200 bg-white overflow-hidden">
          <div className="flex items-center justify-between border-b border-slate-200 px-4 py-3 bg-slate-50">
            <h2 className="text-sm font-bold text-slate-800">銀行一覧（{banks.length}行）</h2>
            <button
              type="button"
              onClick={openCreateBank}
              className="rounded-lg bg-blue-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-blue-700"
            >
              ＋ 新規銀行
            </button>
          </div>

          <form
            onSubmit={(e) => {
              e.preventDefault();
              void reloadBanks();
            }}
            className="flex gap-2 p-3 border-b border-slate-100"
          >
            <input
              type="text"
              value={bankKeyword}
              onChange={(e) => setBankKeyword(e.target.value)}
              placeholder="銀行コード・銀行名・カナ"
              className="flex-1 rounded-lg border border-slate-300 px-2.5 py-1 text-xs"
            />
            <button
              type="submit"
              disabled={loadingBanks}
              className="rounded-lg bg-slate-800 px-3 py-1 text-xs font-medium text-white hover:bg-slate-900"
            >
              検索
            </button>
          </form>

          <div className="divide-y divide-slate-100 max-h-[540px] overflow-y-auto">
            <div
              onClick={() => {
                setSelectedBankId('');
                void reloadBranches({ bankId: '', page: 1 });
              }}
              className={`cursor-pointer px-4 py-2.5 text-xs font-semibold flex items-center justify-between ${
                selectedBankId === '' ? 'bg-blue-50 text-blue-700' : 'text-slate-600 hover:bg-slate-50'
              }`}
            >
              <span>すべての銀行の支店を表示</span>
              <span className="font-mono text-[11px]">ALL</span>
            </div>
            {banks.map((b) => {
              const isSelected = selectedBankId === b.id;
              return (
                <div
                  key={b.id}
                  onClick={() => {
                    setSelectedBankId(b.id);
                    void reloadBranches({ bankId: b.id, page: 1 });
                  }}
                  className={`cursor-pointer px-4 py-2.5 flex items-center justify-between gap-2 ${
                    isSelected ? 'bg-blue-50/90' : 'hover:bg-slate-50'
                  }`}
                >
                  <div className="min-w-0">
                    <div className="flex items-center gap-2">
                      <span className="font-mono text-xs font-semibold text-slate-700">{b.bankCode}</span>
                      <span className="text-sm font-medium text-slate-900 truncate">{b.bankName}</span>
                    </div>
                    <div className="text-[11px] text-slate-500">
                      {b.furigana ?? '-'} ・ 支店 {b.branchCount}件
                    </div>
                  </div>
                  <div
                    className="flex items-center gap-1 shrink-0"
                    onClick={(e) => e.stopPropagation()}
                  >
                    <button
                      type="button"
                      onClick={() => openEditBank(b)}
                      className="rounded border border-slate-300 px-2 py-0.5 text-[11px] text-slate-700 hover:bg-white"
                    >
                      編集
                    </button>
                    <button
                      type="button"
                      onClick={() => void handleDeleteBank(b)}
                      className="rounded border border-red-200 px-2 py-0.5 text-[11px] text-red-600 hover:bg-red-50"
                    >
                      削除
                    </button>
                  </div>
                </div>
              );
            })}
          </div>
        </section>

        {/* 右ペイン: 支店マスタ */}
        <section className="lg:col-span-7 rounded-xl border border-slate-200 bg-white overflow-hidden">
          <div className="flex flex-wrap items-center justify-between gap-2 border-b border-slate-200 px-4 py-3 bg-slate-50">
            <div>
              <h2 className="text-sm font-bold text-slate-800">
                支店一覧（全 {branchPage.totalCount.toLocaleString('ja-JP')} 件）
              </h2>
              <p className="text-[11px] text-slate-500">
                対象銀行: {selectedBank !== undefined ? `${selectedBank.bankCode} ${selectedBank.bankName}` : 'すべての銀行'}
              </p>
            </div>
            <button
              type="button"
              disabled={banks.length === 0}
              onClick={openCreateBranch}
              className="rounded-lg bg-blue-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-blue-700 disabled:opacity-50"
            >
              ＋ 新規支店
            </button>
          </div>

          <form
            onSubmit={(e) => {
              e.preventDefault();
              void reloadBranches({ page: 1 });
            }}
            className="flex gap-2 p-3 border-b border-slate-100"
          >
            <input
              type="text"
              value={branchKeyword}
              onChange={(e) => setBranchKeyword(e.target.value)}
              placeholder="支店コード・支店名・カナ・銀行名で検索"
              className="flex-1 rounded-lg border border-slate-300 px-3 py-1.5 text-sm"
            />
            <button
              type="submit"
              disabled={loadingBranches}
              className="rounded-lg bg-slate-800 px-4 py-1.5 text-xs font-medium text-white hover:bg-slate-900"
            >
              {loadingBranches ? '読込中...' : '検索'}
            </button>
          </form>

          <div className="overflow-x-auto">
            <table className="min-w-full divide-y divide-slate-200 text-xs">
              <thead className="bg-slate-50 text-left font-semibold text-slate-600">
                <tr>
                  <th className="px-3 py-2">銀行</th>
                  <th className="px-3 py-2">支店コード</th>
                  <th className="px-3 py-2">支店名 / カナ</th>
                  <th className="px-3 py-2 text-right">操作</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {branchPage.items.length === 0 ? (
                  <tr>
                    <td colSpan={4} className="px-4 py-8 text-center text-slate-500">
                      該当する支店データがありません。
                    </td>
                  </tr>
                ) : (
                  branchPage.items.map((br) => (
                    <tr key={br.id} className="hover:bg-slate-50">
                      <td className="px-3 py-2 text-slate-600">
                        <span className="font-mono text-[11px]">{br.bankCode}</span> {br.bankName}
                      </td>
                      <td className="px-3 py-2 font-mono font-semibold text-slate-800">{br.branchCode}</td>
                      <td className="px-3 py-2">
                        <div className="font-medium text-slate-900">{br.branchName}</div>
                        {br.furigana !== null && <div className="text-[11px] text-slate-400">{br.furigana}</div>}
                      </td>
                      <td className="px-3 py-2 text-right whitespace-nowrap space-x-1.5">
                        <button
                          type="button"
                          onClick={() => openEditBranch(br)}
                          className="rounded border border-slate-300 px-2 py-0.5 text-[11px] text-slate-700 hover:bg-slate-100"
                        >
                          編集
                        </button>
                        <button
                          type="button"
                          onClick={() => void handleDeleteBranch(br)}
                          className="rounded border border-red-200 px-2 py-0.5 text-[11px] text-red-600 hover:bg-red-50"
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

          <div className="flex items-center justify-between border-t border-slate-200 bg-slate-50 px-4 py-2.5 text-xs text-slate-600">
            <span>
              ページ {branchPage.page} / {totalPages}（全 {branchPage.totalCount.toLocaleString('ja-JP')} 件）
            </span>
            <div className="space-x-2">
              <button
                type="button"
                disabled={loadingBranches || branchPage.page <= 1}
                onClick={() => void reloadBranches({ page: branchPage.page - 1 })}
                className="rounded border border-slate-300 bg-white px-3 py-1 disabled:opacity-40"
              >
                ← 前へ
              </button>
              <button
                type="button"
                disabled={loadingBranches || branchPage.page >= totalPages}
                onClick={() => void reloadBranches({ page: branchPage.page + 1 })}
                className="rounded border border-slate-300 bg-white px-3 py-1 disabled:opacity-40"
              >
                次へ →
              </button>
            </div>
          </div>
        </section>
      </div>

      {bankModalOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/50 p-4">
          <div className="w-full max-w-md rounded-xl bg-white shadow-xl border border-slate-200">
            <div className="flex items-center justify-between border-b border-slate-200 px-5 py-3.5">
              <h3 className="text-sm font-bold text-slate-900">
                {editingBankId === null ? '新規銀行登録' : '銀行情報の編集'}
              </h3>
              <button type="button" onClick={() => setBankModalOpen(false)} className="text-sm text-slate-500">
                ✕
              </button>
            </div>
            <form onSubmit={(e) => void handleSaveBank(e)} className="p-5 space-y-3">
              {bankModalError !== null && (
                <div className="rounded border border-red-300 bg-red-50 px-3 py-2 text-xs text-red-700">
                  {bankModalError}
                </div>
              )}
              <div>
                <label className="block text-xs font-medium text-slate-700 mb-1">銀行コード *</label>
                <input
                  type="text"
                  required
                  value={bankCode}
                  onChange={(e) => setBankCode(e.target.value)}
                  placeholder="0001"
                  className="w-full rounded-lg border border-slate-300 px-3 py-1.5 text-sm font-mono"
                />
              </div>
              <div>
                <label className="block text-xs font-medium text-slate-700 mb-1">銀行名 *</label>
                <input
                  type="text"
                  required
                  value={bankName}
                  onChange={(e) => setBankName(e.target.value)}
                  className="w-full rounded-lg border border-slate-300 px-3 py-1.5 text-sm"
                />
              </div>
              <div>
                <label className="block text-xs font-medium text-slate-700 mb-1">フリガナ</label>
                <input
                  type="text"
                  value={bankFurigana}
                  onChange={(e) => setBankFurigana(e.target.value)}
                  className="w-full rounded-lg border border-slate-300 px-3 py-1.5 text-sm"
                />
              </div>
              <div className="flex justify-end gap-2 pt-3 border-t border-slate-200">
                <button
                  type="button"
                  onClick={() => setBankModalOpen(false)}
                  className="rounded-lg border border-slate-300 px-3 py-1.5 text-xs"
                >
                  キャンセル
                </button>
                <button
                  type="submit"
                  disabled={saving}
                  className="rounded-lg bg-blue-600 px-4 py-1.5 text-xs font-medium text-white hover:bg-blue-700 disabled:opacity-50"
                >
                  {saving ? '保存中...' : '保存する'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {branchModalOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/50 p-4">
          <div className="w-full max-w-md rounded-xl bg-white shadow-xl border border-slate-200">
            <div className="flex items-center justify-between border-b border-slate-200 px-5 py-3.5">
              <h3 className="text-sm font-bold text-slate-900">
                {editingBranchId === null ? '新規支店登録' : '支店情報の編集'}
              </h3>
              <button type="button" onClick={() => setBranchModalOpen(false)} className="text-sm text-slate-500">
                ✕
              </button>
            </div>
            <form onSubmit={(e) => void handleSaveBranch(e)} className="p-5 space-y-3">
              {branchModalError !== null && (
                <div className="rounded border border-red-300 bg-red-50 px-3 py-2 text-xs text-red-700">
                  {branchModalError}
                </div>
              )}
              <div>
                <label className="block text-xs font-medium text-slate-700 mb-1">親銀行 *</label>
                <select
                  required
                  value={branchParentBankId}
                  onChange={(e) => setBranchParentBankId(e.target.value)}
                  className="w-full rounded-lg border border-slate-300 px-2.5 py-1.5 text-sm"
                >
                  {banks.map((b) => (
                    <option key={b.id} value={b.id}>
                      {b.bankCode}: {b.bankName}
                    </option>
                  ))}
                </select>
              </div>
              <div>
                <label className="block text-xs font-medium text-slate-700 mb-1">支店コード *</label>
                <input
                  type="text"
                  required
                  value={branchCode}
                  onChange={(e) => setBranchCode(e.target.value)}
                  placeholder="001"
                  className="w-full rounded-lg border border-slate-300 px-3 py-1.5 text-sm font-mono"
                />
              </div>
              <div>
                <label className="block text-xs font-medium text-slate-700 mb-1">支店名 *</label>
                <input
                  type="text"
                  required
                  value={branchName}
                  onChange={(e) => setBranchName(e.target.value)}
                  className="w-full rounded-lg border border-slate-300 px-3 py-1.5 text-sm"
                />
              </div>
              <div>
                <label className="block text-xs font-medium text-slate-700 mb-1">フリガナ</label>
                <input
                  type="text"
                  value={branchFurigana}
                  onChange={(e) => setBranchFurigana(e.target.value)}
                  className="w-full rounded-lg border border-slate-300 px-3 py-1.5 text-sm"
                />
              </div>
              <div className="flex justify-end gap-2 pt-3 border-t border-slate-200">
                <button
                  type="button"
                  onClick={() => setBranchModalOpen(false)}
                  className="rounded-lg border border-slate-300 px-3 py-1.5 text-xs"
                >
                  キャンセル
                </button>
                <button
                  type="submit"
                  disabled={saving}
                  className="rounded-lg bg-blue-600 px-4 py-1.5 text-xs font-medium text-white hover:bg-blue-700 disabled:opacity-50"
                >
                  {saving ? '保存中...' : '保存する'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}
