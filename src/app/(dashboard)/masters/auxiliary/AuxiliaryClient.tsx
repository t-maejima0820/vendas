'use client';

import { useState } from 'react';
import { normalizeNullableText, requestMasterApi } from '@/lib/masters/client-api';
import {
  computeTotalPages,
  type InputIntelligenceDto,
  type InputIntelligenceInput,
  type InputIntelligencePageDto,
  type MailTemplateDto,
  type MailTemplateInput,
  type TaxCodeDto,
  type TaxOfficeDto,
  type TaxOfficeInput,
  type UnitDto,
} from '@/lib/masters/types';

interface AuxiliaryClientProps {
  initialMailTemplates: MailTemplateDto[];
  initialIntelligencePage: InputIntelligencePageDto;
  initialTaxOffices: TaxOfficeDto[];
  taxCodes: TaxCodeDto[];
  units: UnitDto[];
}

type AuxTab = 'mail-templates' | 'intelligences' | 'tax-offices';

function formatYen(value: number): string {
  return `¥${value.toLocaleString('ja-JP')}`;
}

export default function AuxiliaryClient({
  initialMailTemplates,
  initialIntelligencePage,
  initialTaxOffices,
  taxCodes,
  units,
}: AuxiliaryClientProps) {
  const [activeTab, setActiveTab] = useState<AuxTab>('mail-templates');
  const [bannerError, setBannerError] = useState<string | null>(null);
  const [bannerSuccess, setBannerSuccess] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  // --- 1. メール定型文 ---
  const [templates, setTemplates] = useState<MailTemplateDto[]>(initialMailTemplates);
  const [tplKeyword, setTplKeyword] = useState('');
  const [previewTemplate, setPreviewTemplate] = useState<MailTemplateDto | null>(null);
  const [tplModalOpen, setTplModalOpen] = useState(false);
  const [editingTplId, setEditingTplId] = useState<string | null>(null);
  const [tplNo, setTplNo] = useState('1');
  const [tplName, setTplName] = useState('');
  const [tplSubject, setTplSubject] = useState('');
  const [tplIntro, setTplIntro] = useState('');
  const [tplMain, setTplMain] = useState('');
  const [tplFooter, setTplFooter] = useState('');
  const [tplModalError, setTplModalError] = useState<string | null>(null);

  // --- 2. 入力候補 ---
  const [intelPage, setIntelPage] = useState<InputIntelligencePageDto>(initialIntelligencePage);
  const [intelKeyword, setIntelKeyword] = useState('');
  const [intelTaxFilter, setIntelTaxFilter] = useState('');
  const [intelLoading, setIntelLoading] = useState(false);
  const [intelModalOpen, setIntelModalOpen] = useState(false);
  const [editingIntelId, setEditingIntelId] = useState<string | null>(null);
  const [intelItemName, setIntelItemName] = useState('');
  const [intelUnitName, setIntelUnitName] = useState('');
  const [intelUnitPrice, setIntelUnitPrice] = useState('0');
  const [intelCostPrice, setIntelCostPrice] = useState('0');
  const [intelTaxCode, setIntelTaxCode] = useState<'A' | 'B' | 'C' | 'D' | 'E'>('A');
  const [intelModalError, setIntelModalError] = useState<string | null>(null);

  // --- 3. 税務署 ---
  const [taxOffices, setTaxOffices] = useState<TaxOfficeDto[]>(initialTaxOffices);
  const [toKeyword, setToKeyword] = useState('');
  const [toModalOpen, setToModalOpen] = useState(false);
  const [editingToId, setEditingToId] = useState<string | null>(null);
  const [toCode, setToCode] = useState('');
  const [toName, setToName] = useState('');
  const [toNo, setToNo] = useState('');
  const [toModalError, setToModalError] = useState<string | null>(null);

  const intelTotalPages = computeTotalPages(intelPage.totalCount, intelPage.pageSize);
  const taxMap = new Map(taxCodes.map((tc) => [tc.taxCode, tc]));

  // --------------------------------------------------------------------------
  // Mail Templates
  // --------------------------------------------------------------------------
  async function reloadTemplates(kw: string = tplKeyword) {
    const params = new URLSearchParams();
    if (kw.trim() !== '') params.set('q', kw.trim());
    const qStr = params.toString();
    const url =
      qStr !== '' ? `/api/v1/masters/mail-templates?${qStr}` : '/api/v1/masters/mail-templates';
    const res = await requestMasterApi<{ items: MailTemplateDto[] }>(url);
    if (!res.ok) {
      setBannerError(res.error);
      return;
    }
    setTemplates(res.data.items);
  }

  function openCreateTemplate() {
    let maxNo = 0;
    for (const t of templates) {
      if (t.templateNo > maxNo) maxNo = t.templateNo;
    }
    setEditingTplId(null);
    setTplNo(String(maxNo + 1));
    setTplName('');
    setTplSubject('');
    setTplIntro('');
    setTplMain('');
    setTplFooter('');
    setTplModalError(null);
    setTplModalOpen(true);
  }

  function openEditTemplate(t: MailTemplateDto) {
    setEditingTplId(t.id);
    setTplNo(String(t.templateNo));
    setTplName(t.templateName);
    setTplSubject(t.subject);
    setTplIntro(t.bodyIntro ?? '');
    setTplMain(t.bodyMain ?? '');
    setTplFooter(t.bodyFooter ?? '');
    setTplModalError(null);
    setTplModalOpen(true);
  }

  async function handleSaveTemplate(e: React.FormEvent) {
    e.preventDefault();
    setTplModalError(null);
    setBannerSuccess(null);
    const payload: MailTemplateInput = {
      templateNo: Number(tplNo.trim()),
      templateName: tplName.trim(),
      subject: tplSubject.trim(),
      bodyIntro: tplIntro.length > 0 ? tplIntro : null,
      bodyMain: tplMain.length > 0 ? tplMain : null,
      bodyFooter: tplFooter.length > 0 ? tplFooter : null,
    };
    setSaving(true);
    const url =
      editingTplId === null
        ? '/api/v1/masters/mail-templates'
        : `/api/v1/masters/mail-templates/${encodeURIComponent(editingTplId)}`;
    const method = editingTplId === null ? 'POST' : 'PUT';
    const res = await requestMasterApi<{ item: MailTemplateDto }>(url, {
      method,
      body: JSON.stringify(payload),
    });
    setSaving(false);
    if (!res.ok) {
      setTplModalError(res.error);
      return;
    }
    setTplModalOpen(false);
    setBannerSuccess(`メール定型文「${res.data.item.templateName}」を保存しました。`);
    await reloadTemplates();
  }

  async function handleDeleteTemplate(t: MailTemplateDto) {
    setBannerError(null);
    setBannerSuccess(null);
    if (!window.confirm(`メール定型文「${t.templateNo}: ${t.templateName}」を削除しますか？`)) {
      return;
    }
    const res = await requestMasterApi<{ ok: true }>(
      `/api/v1/masters/mail-templates/${encodeURIComponent(t.id)}`,
      { method: 'DELETE' },
    );
    if (!res.ok) {
      setBannerError(res.error);
      return;
    }
    if (previewTemplate?.id === t.id) setPreviewTemplate(null);
    setBannerSuccess(`メール定型文「${t.templateName}」を削除しました。`);
    await reloadTemplates();
  }

  // --------------------------------------------------------------------------
  // Input Intelligences
  // --------------------------------------------------------------------------
  async function reloadIntelligences(opts?: { q?: string; taxCode?: string; page?: number }) {
    const q = opts?.q !== undefined ? opts.q : intelKeyword;
    const taxCode = opts?.taxCode !== undefined ? opts.taxCode : intelTaxFilter;
    const page = opts?.page !== undefined ? opts.page : intelPage.page;

    setIntelLoading(true);
    setBannerError(null);
    const params = new URLSearchParams();
    if (q.trim() !== '') params.set('q', q.trim());
    if (taxCode !== '') params.set('taxCode', taxCode);
    params.set('page', String(page));
    params.set('pageSize', String(intelPage.pageSize));

    const res = await requestMasterApi<InputIntelligencePageDto>(
      `/api/v1/masters/intelligences?${params.toString()}`,
    );
    setIntelLoading(false);
    if (!res.ok) {
      setBannerError(res.error);
      return;
    }
    setIntelPage({
      items: res.data.items,
      totalCount: res.data.totalCount,
      page: res.data.page,
      pageSize: res.data.pageSize,
    });
  }

  function openCreateIntel() {
    setEditingIntelId(null);
    setIntelItemName('');
    setIntelUnitName('式');
    setIntelUnitPrice('0');
    setIntelCostPrice('0');
    setIntelTaxCode('A');
    setIntelModalError(null);
    setIntelModalOpen(true);
  }

  function openEditIntel(row: InputIntelligenceDto) {
    setEditingIntelId(row.id);
    setIntelItemName(row.itemName);
    setIntelUnitName(row.unitName ?? '');
    setIntelUnitPrice(String(row.unitPrice));
    setIntelCostPrice(String(row.costPrice));
    setIntelTaxCode(row.taxCode);
    setIntelModalError(null);
    setIntelModalOpen(true);
  }

  async function handleSaveIntel(e: React.FormEvent) {
    e.preventDefault();
    setIntelModalError(null);
    setBannerSuccess(null);
    const payload: InputIntelligenceInput = {
      itemName: intelItemName.trim(),
      unitName: normalizeNullableText(intelUnitName),
      unitPrice: Number(intelUnitPrice.trim() === '' ? '0' : intelUnitPrice.trim()),
      costPrice: Number(intelCostPrice.trim() === '' ? '0' : intelCostPrice.trim()),
      taxCode: intelTaxCode,
    };
    setSaving(true);
    const url =
      editingIntelId === null
        ? '/api/v1/masters/intelligences'
        : `/api/v1/masters/intelligences/${encodeURIComponent(editingIntelId)}`;
    const method = editingIntelId === null ? 'POST' : 'PUT';
    const res = await requestMasterApi<{ item: InputIntelligenceDto }>(url, {
      method,
      body: JSON.stringify(payload),
    });
    setSaving(false);
    if (!res.ok) {
      setIntelModalError(res.error);
      return;
    }
    setIntelModalOpen(false);
    setBannerSuccess(`入力候補「${res.data.item.itemName}」を保存しました。`);
    await reloadIntelligences();
  }

  async function handleDeleteIntel(row: InputIntelligenceDto) {
    setBannerError(null);
    setBannerSuccess(null);
    if (!window.confirm(`入力候補「${row.itemName}」を削除しますか？`)) {
      return;
    }
    const res = await requestMasterApi<{ ok: true }>(
      `/api/v1/masters/intelligences/${encodeURIComponent(row.id)}`,
      { method: 'DELETE' },
    );
    if (!res.ok) {
      setBannerError(res.error);
      return;
    }
    setBannerSuccess(`入力候補「${row.itemName}」を削除しました。`);
    await reloadIntelligences();
  }

  // --------------------------------------------------------------------------
  // Tax Offices
  // --------------------------------------------------------------------------
  async function reloadTaxOffices(kw: string = toKeyword) {
    const params = new URLSearchParams();
    if (kw.trim() !== '') params.set('q', kw.trim());
    const qStr = params.toString();
    const url = qStr !== '' ? `/api/v1/masters/tax-offices?${qStr}` : '/api/v1/masters/tax-offices';
    const res = await requestMasterApi<{ items: TaxOfficeDto[] }>(url);
    if (!res.ok) {
      setBannerError(res.error);
      return;
    }
    setTaxOffices(res.data.items);
  }

  function openCreateTaxOffice() {
    setEditingToId(null);
    setToCode('');
    setToName('');
    setToNo('');
    setToModalError(null);
    setToModalOpen(true);
  }

  function openEditTaxOffice(to: TaxOfficeDto) {
    setEditingToId(to.id);
    setToCode(to.taxOfficeCode);
    setToName(to.taxOfficeName);
    setToNo(to.taxOfficeNo ?? '');
    setToModalError(null);
    setToModalOpen(true);
  }

  async function handleSaveTaxOffice(e: React.FormEvent) {
    e.preventDefault();
    setToModalError(null);
    setBannerSuccess(null);
    const payload: TaxOfficeInput = {
      taxOfficeCode: toCode.trim(),
      taxOfficeName: toName.trim(),
      taxOfficeNo: normalizeNullableText(toNo),
    };
    setSaving(true);
    const url =
      editingToId === null
        ? '/api/v1/masters/tax-offices'
        : `/api/v1/masters/tax-offices/${encodeURIComponent(editingToId)}`;
    const method = editingToId === null ? 'POST' : 'PUT';
    const res = await requestMasterApi<{ item: TaxOfficeDto }>(url, {
      method,
      body: JSON.stringify(payload),
    });
    setSaving(false);
    if (!res.ok) {
      setToModalError(res.error);
      return;
    }
    setToModalOpen(false);
    setBannerSuccess(`税務署「${res.data.item.taxOfficeName}」を保存しました。`);
    await reloadTaxOffices();
  }

  async function handleDeleteTaxOffice(to: TaxOfficeDto) {
    setBannerError(null);
    setBannerSuccess(null);
    if (!window.confirm(`税務署「${to.taxOfficeCode}: ${to.taxOfficeName}」を削除しますか？`)) {
      return;
    }
    const res = await requestMasterApi<{ ok: true }>(
      `/api/v1/masters/tax-offices/${encodeURIComponent(to.id)}`,
      { method: 'DELETE' },
    );
    if (!res.ok) {
      setBannerError(res.error);
      return;
    }
    setBannerSuccess(`税務署「${to.taxOfficeName}」を削除しました。`);
    await reloadTaxOffices();
  }

  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-xl font-bold text-slate-900">補助業務マスタ</h1>
        <p className="text-xs text-slate-500 mt-0.5">
          メール定型文、見積/売上明細入力サジェスト候補（旧 T_Intelligence）、所轄税務署マスタを管理します。
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
            ['mail-templates', `1. メール定型文（${templates.length}件）`],
            ['intelligences', `2. 品名・単価入力候補（${intelPage.totalCount}件）`],
            ['tax-offices', `3. 税務署マスタ（${taxOffices.length}件）`],
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

      {/* Tab 1: メール定型文 */}
      {activeTab === 'mail-templates' && (
        <div className="space-y-4">
          <div className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-slate-200 bg-white p-3">
            <form
              onSubmit={(e) => {
                e.preventDefault();
                void reloadTemplates();
              }}
              className="flex flex-1 min-w-[240px] gap-2"
            >
              <input
                type="text"
                value={tplKeyword}
                onChange={(e) => setTplKeyword(e.target.value)}
                placeholder="番号・テンプレート名・件名で検索"
                className="flex-1 rounded-lg border border-slate-300 px-3 py-1.5 text-sm"
              />
              <button
                type="submit"
                className="rounded-lg bg-slate-800 px-4 py-1.5 text-xs font-medium text-white hover:bg-slate-900"
              >
                検索
              </button>
            </form>
            <button
              type="button"
              onClick={openCreateTemplate}
              className="rounded-lg bg-blue-600 px-4 py-1.5 text-xs font-medium text-white hover:bg-blue-700"
            >
              ＋ 新規テンプレート
            </button>
          </div>

          <div className="grid grid-cols-1 lg:grid-cols-12 gap-4 items-start">
            <div className="lg:col-span-7 overflow-x-auto rounded-xl border border-slate-200 bg-white">
              <table className="min-w-full divide-y divide-slate-200 text-xs">
                <thead className="bg-slate-50 text-left font-semibold text-slate-600">
                  <tr>
                    <th className="px-3 py-2.5">番号</th>
                    <th className="px-3 py-2.5">テンプレート名 / 件名</th>
                    <th className="px-3 py-2.5 text-right">操作</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {templates.length === 0 ? (
                    <tr>
                      <td colSpan={3} className="px-4 py-8 text-center text-slate-500">
                        該当するテンプレートがありません。
                      </td>
                    </tr>
                  ) : (
                    templates.map((t) => (
                      <tr
                        key={t.id}
                        className={`hover:bg-slate-50 ${previewTemplate?.id === t.id ? 'bg-blue-50/60' : ''}`}
                      >
                        <td className="px-3 py-2.5 font-mono font-semibold text-slate-700">
                          No.{t.templateNo}
                        </td>
                        <td className="px-3 py-2.5">
                          <div className="font-medium text-slate-900">{t.templateName}</div>
                          <div className="text-[11px] text-slate-500">件名: {t.subject}</div>
                        </td>
                        <td className="px-3 py-2.5 text-right whitespace-nowrap space-x-1.5">
                          <button
                            type="button"
                            onClick={() => setPreviewTemplate(t)}
                            className="rounded border border-blue-200 bg-blue-50 px-2 py-0.5 text-[11px] text-blue-700 hover:bg-blue-100"
                          >
                            プレビュー
                          </button>
                          <button
                            type="button"
                            onClick={() => openEditTemplate(t)}
                            className="rounded border border-slate-300 px-2 py-0.5 text-[11px] text-slate-700 hover:bg-slate-100"
                          >
                            編集
                          </button>
                          <button
                            type="button"
                            onClick={() => void handleDeleteTemplate(t)}
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

            <div className="lg:col-span-5 rounded-xl border border-slate-200 bg-white p-4">
              <div className="text-xs font-bold text-slate-700 border-b border-slate-100 pb-2 mb-3">
                メール本文プレビュー
              </div>
              {previewTemplate === null ? (
                <p className="text-xs text-slate-400 py-8 text-center">
                  左の一覧から「プレビュー」を押すとメール文面を確認できます。
                </p>
              ) : (
                <div className="space-y-3 text-xs">
                  <div>
                    <span className="font-semibold text-slate-500">件名: </span>
                    <span className="font-semibold text-slate-900">{previewTemplate.subject}</span>
                  </div>
                  <pre className="whitespace-pre-wrap rounded-lg bg-slate-50 border border-slate-200 p-3 text-xs font-sans text-slate-800 leading-relaxed">
                    {[previewTemplate.bodyIntro, previewTemplate.bodyMain, previewTemplate.bodyFooter]
                      .filter((s): s is string => s !== null && s !== '')
                      .join('\n\n')}
                  </pre>
                </div>
              )}
            </div>
          </div>
        </div>
      )}

      {/* Tab 2: 品名・単価入力候補 */}
      {activeTab === 'intelligences' && (
        <div className="space-y-4">
          <div className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-slate-200 bg-white p-3">
            <form
              onSubmit={(e) => {
                e.preventDefault();
                void reloadIntelligences({ page: 1 });
              }}
              className="flex flex-wrap flex-1 min-w-[260px] gap-2"
            >
              <input
                type="text"
                value={intelKeyword}
                onChange={(e) => setIntelKeyword(e.target.value)}
                placeholder="品名・単位名で検索"
                className="flex-1 min-w-[180px] rounded-lg border border-slate-300 px-3 py-1.5 text-sm"
              />
              <select
                value={intelTaxFilter}
                onChange={(e) => setIntelTaxFilter(e.target.value)}
                className="rounded-lg border border-slate-300 px-2.5 py-1.5 text-sm"
              >
                <option value="">税区分: すべて</option>
                {taxCodes.map((tc) => (
                  <option key={tc.taxCode} value={tc.taxCode}>
                    {tc.taxCode}: {tc.taxName}
                  </option>
                ))}
              </select>
              <button
                type="submit"
                disabled={intelLoading}
                className="rounded-lg bg-slate-800 px-4 py-1.5 text-xs font-medium text-white hover:bg-slate-900"
              >
                {intelLoading ? '検索中...' : '検索'}
              </button>
            </form>
            <button
              type="button"
              onClick={openCreateIntel}
              className="rounded-lg bg-blue-600 px-4 py-1.5 text-xs font-medium text-white hover:bg-blue-700"
            >
              ＋ 新規候補登録
            </button>
          </div>

          <div className="overflow-x-auto rounded-xl border border-slate-200 bg-white">
            <table className="min-w-full divide-y divide-slate-200 text-xs">
              <thead className="bg-slate-50 text-left font-semibold text-slate-600">
                <tr>
                  <th className="px-4 py-2.5">品名</th>
                  <th className="px-4 py-2.5">単位名</th>
                  <th className="px-4 py-2.5 text-right">標準売価単価</th>
                  <th className="px-4 py-2.5 text-right">標準原価単価</th>
                  <th className="px-4 py-2.5">税区分</th>
                  <th className="px-4 py-2.5 text-right">操作</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {intelPage.items.length === 0 ? (
                  <tr>
                    <td colSpan={6} className="px-4 py-8 text-center text-slate-500">
                      該当する入力候補がありません。
                    </td>
                  </tr>
                ) : (
                  intelPage.items.map((row) => {
                    const tc = taxMap.get(row.taxCode);
                    return (
                      <tr key={row.id} className="hover:bg-slate-50">
                        <td className="px-4 py-2.5 font-medium text-slate-900">{row.itemName}</td>
                        <td className="px-4 py-2.5 text-slate-600">{row.unitName ?? '-'}</td>
                        <td className="px-4 py-2.5 text-right font-mono text-slate-800">
                          {formatYen(row.unitPrice)}
                        </td>
                        <td className="px-4 py-2.5 text-right font-mono text-slate-600">
                          {formatYen(row.costPrice)}
                        </td>
                        <td className="px-4 py-2.5 text-slate-700">
                          {row.taxCode}: {tc !== undefined ? tc.taxName : ''}
                        </td>
                        <td className="px-4 py-2.5 text-right whitespace-nowrap space-x-1.5">
                          <button
                            type="button"
                            onClick={() => openEditIntel(row)}
                            className="rounded border border-slate-300 px-2.5 py-0.5 text-[11px] text-slate-700 hover:bg-slate-100"
                          >
                            編集
                          </button>
                          <button
                            type="button"
                            onClick={() => void handleDeleteIntel(row)}
                            className="rounded border border-red-200 px-2.5 py-0.5 text-[11px] text-red-600 hover:bg-red-50"
                          >
                            削除
                          </button>
                        </td>
                      </tr>
                    );
                  })
                )}
              </tbody>
            </table>

            <div className="flex items-center justify-between border-t border-slate-200 bg-slate-50 px-4 py-2.5 text-xs text-slate-600">
              <span>
                ページ {intelPage.page} / {intelTotalPages}（全 {intelPage.totalCount} 件）
              </span>
              <div className="space-x-2">
                <button
                  type="button"
                  disabled={intelLoading || intelPage.page <= 1}
                  onClick={() => void reloadIntelligences({ page: intelPage.page - 1 })}
                  className="rounded border border-slate-300 bg-white px-3 py-1 disabled:opacity-40"
                >
                  ← 前へ
                </button>
                <button
                  type="button"
                  disabled={intelLoading || intelPage.page >= intelTotalPages}
                  onClick={() => void reloadIntelligences({ page: intelPage.page + 1 })}
                  className="rounded border border-slate-300 bg-white px-3 py-1 disabled:opacity-40"
                >
                  次へ →
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Tab 3: 税務署マスタ */}
      {activeTab === 'tax-offices' && (
        <div className="space-y-4">
          <div className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-slate-200 bg-white p-3">
            <form
              onSubmit={(e) => {
                e.preventDefault();
                void reloadTaxOffices();
              }}
              className="flex flex-1 min-w-[240px] gap-2"
            >
              <input
                type="text"
                value={toKeyword}
                onChange={(e) => setToKeyword(e.target.value)}
                placeholder="税務署コード・税務署名・署番号で検索"
                className="flex-1 rounded-lg border border-slate-300 px-3 py-1.5 text-sm"
              />
              <button
                type="submit"
                className="rounded-lg bg-slate-800 px-4 py-1.5 text-xs font-medium text-white hover:bg-slate-900"
              >
                検索
              </button>
            </form>
            <button
              type="button"
              onClick={openCreateTaxOffice}
              className="rounded-lg bg-blue-600 px-4 py-1.5 text-xs font-medium text-white hover:bg-blue-700"
            >
              ＋ 新規税務署登録
            </button>
          </div>

          <div className="overflow-x-auto rounded-xl border border-slate-200 bg-white">
            <table className="min-w-full divide-y divide-slate-200 text-xs">
              <thead className="bg-slate-50 text-left font-semibold text-slate-600">
                <tr>
                  <th className="px-4 py-2.5">税務署コード</th>
                  <th className="px-4 py-2.5">税務署名</th>
                  <th className="px-4 py-2.5">署番号</th>
                  <th className="px-4 py-2.5 text-right">顧問紐付件数</th>
                  <th className="px-4 py-2.5 text-right">操作</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {taxOffices.length === 0 ? (
                  <tr>
                    <td colSpan={5} className="px-4 py-8 text-center text-slate-500">
                      該当する税務署がありません。
                    </td>
                  </tr>
                ) : (
                  taxOffices.map((to) => (
                    <tr key={to.id} className="hover:bg-slate-50">
                      <td className="px-4 py-2.5 font-mono font-semibold text-slate-800">
                        {to.taxOfficeCode}
                      </td>
                      <td className="px-4 py-2.5 font-medium text-slate-900">{to.taxOfficeName}</td>
                      <td className="px-4 py-2.5 font-mono text-slate-600">{to.taxOfficeNo ?? '-'}</td>
                      <td className="px-4 py-2.5 text-right">
                        <span className="rounded-full bg-slate-100 px-2.5 py-0.5 font-mono text-slate-700">
                          {to.linkedAdvisoryCount}件
                        </span>
                      </td>
                      <td className="px-4 py-2.5 text-right whitespace-nowrap space-x-1.5">
                        <button
                          type="button"
                          onClick={() => openEditTaxOffice(to)}
                          className="rounded border border-slate-300 px-2.5 py-0.5 text-[11px] text-slate-700 hover:bg-slate-100"
                        >
                          編集
                        </button>
                        <button
                          type="button"
                          onClick={() => void handleDeleteTaxOffice(to)}
                          className="rounded border border-red-200 px-2.5 py-0.5 text-[11px] text-red-600 hover:bg-red-50"
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
      )}

      {/* Modal: メール定型文 */}
      {tplModalOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/50 p-4">
          <div className="w-full max-w-2xl rounded-xl bg-white shadow-xl border border-slate-200 max-h-[92vh] overflow-y-auto">
            <div className="flex items-center justify-between border-b border-slate-200 px-5 py-3.5">
              <h3 className="text-sm font-bold text-slate-900">
                {editingTplId === null ? '新規メール定型文登録' : 'メール定型文の編集'}
              </h3>
              <button type="button" onClick={() => setTplModalOpen(false)} className="text-sm text-slate-500">
                ✕
              </button>
            </div>
            <form onSubmit={(e) => void handleSaveTemplate(e)} className="p-5 space-y-3">
              {tplModalError !== null && (
                <div className="rounded border border-red-300 bg-red-50 px-3 py-2 text-xs text-red-700">
                  {tplModalError}
                </div>
              )}
              <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
                <div>
                  <label className="block text-xs font-medium text-slate-700 mb-1">定型文番号 *</label>
                  <input
                    type="number"
                    min={1}
                    required
                    value={tplNo}
                    onChange={(e) => setTplNo(e.target.value)}
                    className="w-full rounded-lg border border-slate-300 px-3 py-1.5 text-sm font-mono"
                  />
                </div>
                <div className="md:col-span-2">
                  <label className="block text-xs font-medium text-slate-700 mb-1">テンプレート名 *</label>
                  <input
                    type="text"
                    required
                    value={tplName}
                    onChange={(e) => setTplName(e.target.value)}
                    className="w-full rounded-lg border border-slate-300 px-3 py-1.5 text-sm"
                  />
                </div>
              </div>
              <div>
                <label className="block text-xs font-medium text-slate-700 mb-1">メール件名 *</label>
                <input
                  type="text"
                  required
                  value={tplSubject}
                  onChange={(e) => setTplSubject(e.target.value)}
                  className="w-full rounded-lg border border-slate-300 px-3 py-1.5 text-sm"
                />
              </div>
              <div>
                <label className="block text-xs font-medium text-slate-700 mb-1">冒頭挨拶文（body_intro）</label>
                <textarea
                  rows={2}
                  value={tplIntro}
                  onChange={(e) => setTplIntro(e.target.value)}
                  className="w-full rounded-lg border border-slate-300 px-3 py-1.5 text-xs"
                />
              </div>
              <div>
                <label className="block text-xs font-medium text-slate-700 mb-1">本文（body_main）</label>
                <textarea
                  rows={4}
                  value={tplMain}
                  onChange={(e) => setTplMain(e.target.value)}
                  className="w-full rounded-lg border border-slate-300 px-3 py-1.5 text-xs"
                />
              </div>
              <div>
                <label className="block text-xs font-medium text-slate-700 mb-1">署名・フッター（body_footer）</label>
                <textarea
                  rows={3}
                  value={tplFooter}
                  onChange={(e) => setTplFooter(e.target.value)}
                  className="w-full rounded-lg border border-slate-300 px-3 py-1.5 text-xs"
                />
              </div>
              <div className="flex justify-end gap-2 pt-3 border-t border-slate-200">
                <button
                  type="button"
                  onClick={() => setTplModalOpen(false)}
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

      {/* Modal: 入力候補 */}
      {intelModalOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/50 p-4">
          <div className="w-full max-w-md rounded-xl bg-white shadow-xl border border-slate-200">
            <div className="flex items-center justify-between border-b border-slate-200 px-5 py-3.5">
              <h3 className="text-sm font-bold text-slate-900">
                {editingIntelId === null ? '新規入力候補の登録' : '入力候補の編集'}
              </h3>
              <button type="button" onClick={() => setIntelModalOpen(false)} className="text-sm text-slate-500">
                ✕
              </button>
            </div>
            <form onSubmit={(e) => void handleSaveIntel(e)} className="p-5 space-y-3">
              {intelModalError !== null && (
                <div className="rounded border border-red-300 bg-red-50 px-3 py-2 text-xs text-red-700">
                  {intelModalError}
                </div>
              )}
              <div>
                <label className="block text-xs font-medium text-slate-700 mb-1">品名 *</label>
                <input
                  type="text"
                  required
                  value={intelItemName}
                  onChange={(e) => setIntelItemName(e.target.value)}
                  className="w-full rounded-lg border border-slate-300 px-3 py-1.5 text-sm"
                />
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-xs font-medium text-slate-700 mb-1">単位名</label>
                  <input
                    type="text"
                    list="unit-name-suggestions"
                    value={intelUnitName}
                    onChange={(e) => setIntelUnitName(e.target.value)}
                    className="w-full rounded-lg border border-slate-300 px-3 py-1.5 text-sm"
                  />
                  <datalist id="unit-name-suggestions">
                    {units
                      .filter((u) => !u.isDeleted)
                      .map((u) => (
                        <option key={u.id} value={u.unitName} />
                      ))}
                  </datalist>
                </div>
                <div>
                  <label className="block text-xs font-medium text-slate-700 mb-1">税区分 *</label>
                  <select
                    value={intelTaxCode}
                    onChange={(e) =>
                      setIntelTaxCode(e.target.value as 'A' | 'B' | 'C' | 'D' | 'E')
                    }
                    className="w-full rounded-lg border border-slate-300 px-2.5 py-1.5 text-sm"
                  >
                    {taxCodes.map((tc) => (
                      <option key={tc.taxCode} value={tc.taxCode}>
                        {tc.taxCode}: {tc.taxName}
                      </option>
                    ))}
                  </select>
                </div>
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-xs font-medium text-slate-700 mb-1">標準売価単価（円）</label>
                  <input
                    type="number"
                    step={1}
                    value={intelUnitPrice}
                    onChange={(e) => setIntelUnitPrice(e.target.value)}
                    className="w-full rounded-lg border border-slate-300 px-3 py-1.5 text-sm font-mono"
                  />
                </div>
                <div>
                  <label className="block text-xs font-medium text-slate-700 mb-1">標準原価単価（円）</label>
                  <input
                    type="number"
                    step={1}
                    value={intelCostPrice}
                    onChange={(e) => setIntelCostPrice(e.target.value)}
                    className="w-full rounded-lg border border-slate-300 px-3 py-1.5 text-sm font-mono"
                  />
                </div>
              </div>
              <div className="flex justify-end gap-2 pt-3 border-t border-slate-200">
                <button
                  type="button"
                  onClick={() => setIntelModalOpen(false)}
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

      {/* Modal: 税務署 */}
      {toModalOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/50 p-4">
          <div className="w-full max-w-md rounded-xl bg-white shadow-xl border border-slate-200">
            <div className="flex items-center justify-between border-b border-slate-200 px-5 py-3.5">
              <h3 className="text-sm font-bold text-slate-900">
                {editingToId === null ? '新規税務署登録' : '税務署情報の編集'}
              </h3>
              <button type="button" onClick={() => setToModalOpen(false)} className="text-sm text-slate-500">
                ✕
              </button>
            </div>
            <form onSubmit={(e) => void handleSaveTaxOffice(e)} className="p-5 space-y-3">
              {toModalError !== null && (
                <div className="rounded border border-red-300 bg-red-50 px-3 py-2 text-xs text-red-700">
                  {toModalError}
                </div>
              )}
              <div>
                <label className="block text-xs font-medium text-slate-700 mb-1">税務署コード *</label>
                <input
                  type="text"
                  required
                  value={toCode}
                  onChange={(e) => setToCode(e.target.value)}
                  className="w-full rounded-lg border border-slate-300 px-3 py-1.5 text-sm font-mono"
                />
              </div>
              <div>
                <label className="block text-xs font-medium text-slate-700 mb-1">税務署名 *</label>
                <input
                  type="text"
                  required
                  value={toName}
                  onChange={(e) => setToName(e.target.value)}
                  className="w-full rounded-lg border border-slate-300 px-3 py-1.5 text-sm"
                />
              </div>
              <div>
                <label className="block text-xs font-medium text-slate-700 mb-1">署番号</label>
                <input
                  type="text"
                  value={toNo}
                  onChange={(e) => setToNo(e.target.value)}
                  className="w-full rounded-lg border border-slate-300 px-3 py-1.5 text-sm font-mono"
                />
              </div>
              <div className="flex justify-end gap-2 pt-3 border-t border-slate-200">
                <button
                  type="button"
                  onClick={() => setToModalOpen(false)}
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
    </div>
  );
}
