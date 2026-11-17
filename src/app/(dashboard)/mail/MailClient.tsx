'use client';

import Link from 'next/link';
import { useMemo, useState } from 'react';
import type {
  MailComposeResultDto,
  MailOverviewDto,
} from '@/lib/mail/mail-service';
import { requestMasterApi } from '@/lib/masters/client-api';

interface MailClientProps {
  initialOverview: MailOverviewDto;
}

export default function MailClient({ initialOverview }: MailClientProps) {
  const [overview, setOverview] = useState<MailOverviewDto>(initialOverview);
  const [keyword, setKeyword] = useState('');
  const [mailEnabledOnly, setMailEnabledOnly] = useState(false);
  const [loading, setLoading] = useState(false);
  const [message, setMessage] = useState<{ type: 'success' | 'error'; text: string } | null>(null);

  const [selectedPartnerId, setSelectedPartnerId] = useState<string>(
    initialOverview.targets.length > 0 ? initialOverview.targets[0]!.partnerId : '',
  );
  const [selectedTemplateId, setSelectedTemplateId] = useState<string>(
    initialOverview.templates.length > 0 ? initialOverview.templates[0]!.id : '',
  );
  const [docKind, setDocKind] = useState<'BILLING' | 'ESTIMATE' | 'PURCHASE_ORDER'>('BILLING');
  const [preview, setPreview] = useState<MailComposeResultDto | null>(null);
  const [composing, setComposing] = useState(false);

  const exportCsvHref = useMemo(() => {
    const qs = new URLSearchParams({ format: 'csv' });
    if (keyword.trim() !== '') qs.set('keyword', keyword.trim());
    if (mailEnabledOnly) qs.set('mailEnabledOnly', '1');
    return `/api/v1/mail/export?${qs.toString()}`;
  }, [keyword, mailEnabledOnly]);

  const exportPdfHref = useMemo(() => {
    const qs = new URLSearchParams({ format: 'pdf', inline: '1' });
    if (keyword.trim() !== '') qs.set('keyword', keyword.trim());
    if (mailEnabledOnly) qs.set('mailEnabledOnly', '1');
    return `/api/v1/mail/export?${qs.toString()}`;
  }, [keyword, mailEnabledOnly]);

  async function fetchOverview() {
    setLoading(true);
    setMessage(null);
    const qs = new URLSearchParams();
    if (keyword.trim() !== '') qs.set('keyword', keyword.trim());
    if (mailEnabledOnly) qs.set('mailEnabledOnly', '1');

    const res = await requestMasterApi<MailOverviewDto & { ok: true }>(
      `/api/v1/mail?${qs.toString()}`,
    );
    setLoading(false);
    if (!res.ok) {
      setMessage({ type: 'error', text: res.error });
      return;
    }
    setOverview(res.data);
  }

  async function handleComposePreview(e: React.FormEvent) {
    e.preventDefault();
    if (selectedPartnerId === '' || selectedTemplateId === '') {
      setMessage({ type: 'error', text: '送信先取引先とメール定型文を選択してください。' });
      return;
    }
    setComposing(true);
    setMessage(null);
    const res = await requestMasterApi<{ ok: true; preview: MailComposeResultDto }>(
      '/api/v1/mail',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          partnerId: selectedPartnerId,
          templateId: selectedTemplateId,
          docKind,
        }),
      },
    );
    setComposing(false);
    if (!res.ok) {
      setMessage({ type: 'error', text: res.error });
      return;
    }
    setPreview(res.data.preview);
  }

  async function handleCopyBody() {
    if (preview === null) return;
    await navigator.clipboard.writeText(`件名: ${preview.subject}\n宛先: ${preview.to}\n\n${preview.body}`);
    setMessage({ type: 'success', text: 'メール件名・本文をクリップボードへコピーしました。' });
  }

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold text-slate-900">帳票メール送付支援・定型文プレビュー</h1>
          <p className="text-sm text-slate-600 mt-0.5">
            定型文テンプレートの差し込み生成と取引先別メール送信設定・最新帳票確認（送信許可:{' '}
            {overview.mailEnabledCount} / {overview.totalCount}件）
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <Link
            href="/masters/auxiliary"
            className="rounded-lg border border-slate-300 bg-white px-3.5 py-2 text-sm font-medium text-slate-700 hover:bg-slate-50"
          >
            メール定型文マスタ編集
          </Link>
          <a
            href={exportCsvHref}
            className="rounded-lg border border-slate-300 bg-white px-3.5 py-2 text-sm font-medium text-slate-700 hover:bg-slate-50"
          >
            宛先一覧 CSV
          </a>
          <a
            href={exportPdfHref}
            target="_blank"
            rel="noopener noreferrer"
            className="rounded-lg bg-slate-900 px-4 py-2 text-sm font-semibold text-white hover:bg-slate-800"
          >
            宛先一覧 PDF
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

      <div className="grid grid-cols-1 lg:grid-cols-12 gap-6">
        {/* Left: Target Partners */}
        <div className="lg:col-span-7 space-y-4">
          <form
            onSubmit={(e) => {
              e.preventDefault();
              void fetchOverview();
            }}
            className="rounded-xl border border-slate-200 bg-white p-3.5 flex flex-wrap items-center gap-3"
          >
            <input
              type="text"
              value={keyword}
              onChange={(e) => setKeyword(e.target.value)}
              placeholder="取引先コード・名称・Emailで絞込"
              className="flex-1 min-w-[180px] rounded-lg border border-slate-300 px-3 py-1.5 text-sm"
            />
            <label className="inline-flex items-center gap-1.5 text-xs text-slate-700 cursor-pointer">
              <input
                type="checkbox"
                checked={mailEnabledOnly}
                onChange={(e) => setMailEnabledOnly(e.target.checked)}
                className="rounded border-slate-300"
              />
              送信許可のみ
            </label>
            <button
              type="submit"
              disabled={loading}
              className="rounded-lg bg-slate-900 px-4 py-1.5 text-sm font-medium text-white"
            >
              検索
            </button>
          </form>

          <div className="rounded-xl border border-slate-200 bg-white overflow-hidden">
            <div className="overflow-x-auto max-h-[540px] overflow-y-auto">
              <table className="min-w-full divide-y divide-slate-200 text-xs">
                <thead className="bg-slate-50 font-semibold text-slate-600 sticky top-0">
                  <tr>
                    <th className="px-3 py-2 text-left">取引先</th>
                    <th className="px-3 py-2 text-center">送信</th>
                    <th className="px-3 py-2 text-left">宛先設定 (見積To / 請求To)</th>
                    <th className="px-3 py-2 text-left">最新帳票</th>
                    <th className="px-3 py-2 text-right">選択</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {overview.targets.map((t) => (
                    <tr
                      key={t.partnerId}
                      className={selectedPartnerId === t.partnerId ? 'bg-blue-50/70' : ''}
                    >
                      <td className="px-3 py-2">
                        <div className="font-mono text-slate-400">{t.partnerCode}</div>
                        <div className="font-medium text-slate-900">{t.partnerName}</div>
                      </td>
                      <td className="px-3 py-2 text-center">
                        <span
                          className={`rounded-full px-2 py-0.5 font-semibold ${
                            t.sendMailEnabled
                              ? 'bg-emerald-100 text-emerald-800'
                              : 'bg-slate-100 text-slate-500'
                          }`}
                        >
                          {t.sendMailEnabled ? '許可' : '無効'}
                        </span>
                      </td>
                      <td className="px-3 py-2 text-slate-600">
                        <div>見積: {t.estimateMailTo !== null ? t.estimateMailTo : '-'}</div>
                        <div>請求: {t.billMailTo !== null ? t.billMailTo : '-'}</div>
                      </td>
                      <td className="px-3 py-2">
                        {t.latestDocNo !== '' ? (
                          <div>
                            <div className="font-medium">
                              {t.latestDocTypeLabel} #{t.latestDocNo}
                            </div>
                            <div className="text-slate-500 font-mono">
                              ¥{t.latestDocAmount.toLocaleString('ja-JP')} ({t.latestDocDate})
                            </div>
                          </div>
                        ) : (
                          <span className="text-slate-400">-</span>
                        )}
                      </td>
                      <td className="px-3 py-2 text-right">
                        <button
                          type="button"
                          onClick={() => setSelectedPartnerId(t.partnerId)}
                          className="rounded border border-blue-300 bg-white px-2.5 py-1 font-medium text-blue-700 hover:bg-blue-50"
                        >
                          選択
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        </div>

        {/* Right: Compose & Merge Preview */}
        <div className="lg:col-span-5 space-y-4">
          <form
            onSubmit={handleComposePreview}
            className="rounded-xl border border-slate-200 bg-white p-5 space-y-3 text-sm"
          >
            <h2 className="text-base font-bold text-slate-900">差し込みメール生成</h2>
            <div>
              <label className="block text-xs font-semibold text-slate-700 mb-1">送信先取引先</label>
              <select
                required
                value={selectedPartnerId}
                onChange={(e) => setSelectedPartnerId(e.target.value)}
                className="w-full rounded-lg border border-slate-300 px-3 py-2"
              >
                <option value="">選択してください</option>
                {overview.targets.map((t) => (
                  <option key={t.partnerId} value={t.partnerId}>
                    {t.partnerCode} : {t.partnerName}
                  </option>
                ))}
              </select>
            </div>

            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="block text-xs font-semibold text-slate-700 mb-1">
                  定型文テンプレート
                </label>
                <select
                  required
                  value={selectedTemplateId}
                  onChange={(e) => setSelectedTemplateId(e.target.value)}
                  className="w-full rounded-lg border border-slate-300 px-2.5 py-2"
                >
                  {overview.templates.length === 0 ? (
                    <option value="">テンプレートなし</option>
                  ) : (
                    overview.templates.map((tmpl) => (
                      <option key={tmpl.id} value={tmpl.id}>
                        #{tmpl.templateNo} {tmpl.templateName}
                      </option>
                    ))
                  )}
                </select>
              </div>
              <div>
                <label className="block text-xs font-semibold text-slate-700 mb-1">帳票用途</label>
                <select
                  value={docKind}
                  onChange={(e) =>
                    setDocKind(e.target.value as 'BILLING' | 'ESTIMATE' | 'PURCHASE_ORDER')
                  }
                  className="w-full rounded-lg border border-slate-300 px-2.5 py-2"
                >
                  <option value="BILLING">請求書送付</option>
                  <option value="ESTIMATE">見積書送付</option>
                  <option value="PURCHASE_ORDER">発注書送付</option>
                </select>
              </div>
            </div>

            <button
              type="submit"
              disabled={composing || overview.templates.length === 0}
              className="w-full rounded-lg bg-blue-600 px-4 py-2 font-semibold text-white hover:bg-blue-700 disabled:opacity-50"
            >
              {composing ? '生成中...' : 'テンプレート差し込みプレビュー生成'}
            </button>
          </form>

          {preview !== null && (
            <div className="rounded-xl border border-slate-200 bg-white p-5 space-y-3 text-xs">
              <div className="flex items-center justify-between border-b border-slate-200 pb-2">
                <span className="font-bold text-slate-900 text-sm">メールプレビュー</span>
                <div className="flex gap-2">
                  <button
                    type="button"
                    onClick={() => void handleCopyBody()}
                    className="rounded border border-slate-300 px-2.5 py-1 font-medium text-slate-700 hover:bg-slate-50"
                  >
                    本文コピー
                  </button>
                  <a
                    href={preview.mailtoHref}
                    className="rounded bg-emerald-600 px-3 py-1 font-semibold text-white hover:bg-emerald-700"
                  >
                    メーラーで開く
                  </a>
                </div>
              </div>
              <div>
                <span className="font-semibold text-slate-500">To:</span> {preview.to || '(未設定)'}
              </div>
              {preview.cc !== '' && (
                <div>
                  <span className="font-semibold text-slate-500">Cc:</span> {preview.cc}
                </div>
              )}
              <div>
                <span className="font-semibold text-slate-500">件名:</span>{' '}
                <strong className="text-slate-900">{preview.subject}</strong>
              </div>
              <pre className="whitespace-pre-wrap rounded-lg bg-slate-50 border border-slate-200 p-3 text-slate-800 font-sans leading-relaxed">
                {preview.body}
              </pre>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
