'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import {
  ALL_BILLING_DOCUMENT_TYPES,
  BILLING_DOCUMENT_TYPE_LABELS,
  RECEIVABLE_STATUS_LABELS,
  type BillingDetailDto,
  type BillingDocumentType,
  type BillingLookupsDto,
} from '@/lib/billing/types';
import type { QuotationTemplateVariant, SnapshotHistoryItemDto } from '@/lib/estimates/types';
import { requestMasterApi } from '@/lib/masters/client-api';
import { ENTRY_TYPE_LABELS, SALES_STATUS_LABELS } from '@/lib/sales/types';

interface BillingDetailClientProps {
  lookups: BillingLookupsDto;
  initialDetail: BillingDetailDto;
}

function formatYen(amount: number): string {
  return `¥${amount.toLocaleString('ja-JP')}`;
}

function getDocLabel(docType: string): string {
  if (docType in BILLING_DOCUMENT_TYPE_LABELS) {
    return BILLING_DOCUMENT_TYPE_LABELS[docType as BillingDocumentType];
  }
  return docType;
}

export default function BillingDetailClient({
  lookups,
  initialDetail,
}: BillingDetailClientProps) {
  const router = useRouter();
  const [detail, setDetail] = useState<BillingDetailDto>(initialDetail);
  const [reissueDocType, setReissueDocType] = useState<BillingDocumentType>(
    initialDetail.isSubscriptionBill ? 'FIXED_INVOICE' : 'INVOICE',
  );
  const [templateVariant, setTemplateVariant] = useState<QuotationTemplateVariant>(
    lookups.quotationTemplateRows,
  );
  const [issueCoverDetail, setIssueCoverDetail] = useState(true);
  const [previewSnapshotId, setPreviewSnapshotId] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [bannerError, setBannerError] = useState<string | null>(null);
  const [bannerSuccess, setBannerSuccess] = useState<string | null>(null);

  async function refreshDetail() {
    const res = await requestMasterApi<BillingDetailDto>(
      `/api/v1/billing/${encodeURIComponent(detail.id)}`,
    );
    if (res.ok) {
      setDetail(res.data);
    }
  }

  async function handleReissue() {
    setBannerError(null);
    setBannerSuccess(null);
    setSaving(true);
    const res = await requestMasterApi<{ snapshots: SnapshotHistoryItemDto[] }>(
      `/api/v1/billing/${encodeURIComponent(detail.id)}/reissue`,
      {
        method: 'POST',
        body: JSON.stringify({
          documentType: reissueDocType,
          templateVariant,
          issueCoverDetail,
        }),
      },
    );
    setSaving(false);
    if (!res.ok) {
      setBannerError(res.error);
      return;
    }
    const first = res.data.snapshots[0];
    setBannerSuccess(
      `${getDocLabel(reissueDocType)}（${first !== undefined ? `v${first.versionNo}` : '新版'} ＜再発行＞）を発行し、売上伝票を K5（再発行）へ更新しました。`,
    );
    await refreshDetail();
  }

  async function handleCancelBilling() {
    setBannerError(null);
    setBannerSuccess(null);
    setSaving(true);
    const res = await requestMasterApi<{ cancelledBillingId: string; billingNo: number }>(
      `/api/v1/billing/${encodeURIComponent(detail.id)}/cancel`,
      { method: 'POST' },
    );
    setSaving(false);
    if (!res.ok) {
      setBannerError(res.error);
      return;
    }
    router.push('/billing?tab=ISSUED');
    router.refresh();
  }

  const canCancel =
    detail.status === 'N1' &&
    detail.billingDate > lookups.openingBalanceDate &&
    (detail.isSubscriptionBill ? lookups.fixedbillEnabled || lookups.billissueEnabled : lookups.billissueEnabled);

  return (
    <div className="max-w-7xl space-y-5">
      {/* ヘッダ */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <div className="flex items-center gap-2 text-xs text-slate-500 mb-1">
            <Link href="/billing?tab=ISSUED" className="text-blue-600 hover:underline">
              ← 請求一覧へ戻る
            </Link>
            <span>/</span>
            <span className="font-mono">請求No. {detail.billingNo}</span>
          </div>
          <h1 className="text-2xl font-bold text-slate-900">
            請求詳細 #{detail.billingNo} — {detail.partnerName}
          </h1>
          <div className="flex flex-wrap items-center gap-2 mt-1 text-xs text-slate-600">
            <span className="px-2 py-0.5 rounded bg-slate-100 font-mono">
              請求日: {detail.billingDate}
            </span>
            <span className="px-2 py-0.5 rounded bg-slate-100 font-mono">
              支払期限: {detail.paymentDueDate !== null ? detail.paymentDueDate : '-'}
            </span>
            <span className="px-2 py-0.5 rounded bg-amber-50 text-amber-800 font-semibold">
              {detail.status}:{RECEIVABLE_STATUS_LABELS[detail.status]}
            </span>
            <span className="px-2 py-0.5 rounded bg-slate-100 font-mono">
              {detail.taxCalcPolicy} / {detail.roundingMode}
            </span>
            {detail.isSubscriptionBill && (
              <span className="px-2 py-0.5 rounded bg-indigo-100 text-indigo-800 font-semibold">
                定額一括請求
              </span>
            )}
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <Link
            href={`/receivables?tab=RECEIPTS&partnerId=${encodeURIComponent(detail.partnerId)}&billNo=${encodeURIComponent(String(detail.billingNo))}&amount=${encodeURIComponent(String(detail.billingAmount))}`}
            className="rounded-lg bg-emerald-600 hover:bg-emerald-700 px-3.5 py-2 text-xs font-semibold text-white"
          >
            入金登録・消込管理へ →
          </Link>
          {detail.latestSnapshotId !== null && (
            <button
              type="button"
              onClick={() => setPreviewSnapshotId(detail.latestSnapshotId)}
              className="rounded-lg border border-slate-300 bg-white hover:bg-slate-50 px-3.5 py-2 text-xs font-semibold text-slate-700 cursor-pointer"
            >
              最新版PDFプレビュー
            </button>
          )}
          <button
            type="button"
            disabled={saving || !canCancel}
            onClick={() => void handleCancelBilling()}
            className="rounded-lg border border-red-300 bg-white hover:bg-red-50 disabled:opacity-40 px-3.5 py-2 text-xs font-semibold text-red-700 cursor-pointer"
          >
            請求確定を取消（K2ロールバック）
          </button>
        </div>
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

      {/* 鏡5数値 ＆ 税率別内訳 */}
      <div className="grid grid-cols-2 lg:grid-cols-5 gap-3">
        <div className="rounded-xl bg-white border border-slate-200 p-4 shadow-xs">
          <div className="text-xs text-slate-500">前回繰越残高</div>
          <div className="text-xl font-bold text-slate-900 mt-1 font-mono">
            {formatYen(detail.prevCarriedBalance)}
          </div>
        </div>
        <div className="rounded-xl bg-white border border-slate-200 p-4 shadow-xs">
          <div className="text-xs text-slate-500">当期御入金額</div>
          <div className="text-xl font-bold text-emerald-700 mt-1 font-mono">
            {formatYen(detail.periodReceiptAmount)}
          </div>
        </div>
        <div className="rounded-xl bg-white border border-slate-200 p-4 shadow-xs">
          <div className="text-xs text-slate-500">差引繰越額</div>
          <div className="text-xl font-bold text-slate-900 mt-1 font-mono">
            {formatYen(detail.netCarriedBalance)}
          </div>
        </div>
        <div className="rounded-xl bg-blue-50 border border-blue-200 p-4 shadow-xs">
          <div className="text-xs font-semibold text-blue-700">今回御請求額(税込)</div>
          <div className="text-xl font-bold text-blue-900 mt-1 font-mono">
            {formatYen(detail.billingAmount)}
          </div>
        </div>
        <div className="rounded-xl bg-slate-900 text-white p-4 shadow-xs">
          <div className="text-xs text-slate-300">今回売掛残高</div>
          <div className="text-xl font-bold mt-1 font-mono">
            {formatYen(detail.closingArBalance)}
          </div>
        </div>
      </div>

      <div className="rounded-xl bg-white border border-slate-200 p-4 shadow-xs flex flex-wrap gap-6 text-xs">
        <div>
          <span className="text-slate-500">10%対象(税抜):</span>{' '}
          <span className="font-mono font-semibold">{formatYen(detail.amount10Excl)}</span> / 税:{' '}
          <span className="font-mono font-semibold">{formatYen(detail.tax10Amount)}</span>
        </div>
        <div>
          <span className="text-slate-500">8%対象(税抜):</span>{' '}
          <span className="font-mono font-semibold">{formatYen(detail.amount8Excl)}</span> / 税:{' '}
          <span className="font-mono font-semibold">{formatYen(detail.tax8Amount)}</span>
        </div>
        <div>
          <span className="text-slate-500">非課税:</span>{' '}
          <span className="font-mono font-semibold">{formatYen(detail.amount0NonTax)}</span>
        </div>
        <div>
          <span className="text-slate-500">インボイス端数調整額:</span>{' '}
          <span className="font-mono font-bold text-blue-800">
            {formatYen(detail.taxAdjustmentAmount)}
          </span>
        </div>
        <div>
          <span className="text-slate-500">消費税合計:</span>{' '}
          <span className="font-mono font-bold">{formatYen(detail.taxTotal)}</span>
        </div>
      </div>

      {/* 請求書 再発行 ＆ スナップショット版履歴パネル */}
      <div className="rounded-xl bg-white border border-slate-200 p-4 shadow-xs space-y-4">
        <div className="flex flex-wrap items-end justify-between gap-3 border-b border-slate-200 pb-3">
          <div>
            <h2 className="text-sm font-bold text-slate-900">
              請求書スナップショット発行・版履歴（＜再発行＞・K5更新）
            </h2>
            <p className="text-xs text-slate-500 mt-0.5">
              新規版発行時は ＜再発行＞ ラベル付きの不変スナップショットを追加し、売上伝票ステータスを K5 へ更新します。過去版は当時マスタ凍結のまま再出力できます。
            </p>
          </div>
          {lookups.billissueEnabled && (
            <div className="flex flex-wrap items-end gap-2">
              <select
                value={reissueDocType}
                onChange={(e) => setReissueDocType(e.target.value as BillingDocumentType)}
                className="rounded-lg border border-slate-300 bg-white px-2.5 py-1.5 text-xs"
              >
                {ALL_BILLING_DOCUMENT_TYPES.map((dt) => (
                  <option key={dt} value={dt}>
                    {BILLING_DOCUMENT_TYPE_LABELS[dt]}
                  </option>
                ))}
              </select>
              <select
                value={templateVariant}
                onChange={(e) => setTemplateVariant(e.target.value as QuotationTemplateVariant)}
                className="rounded-lg border border-slate-300 bg-white px-2.5 py-1.5 text-xs"
              >
                <option value="10_ROWS">10行枠</option>
                <option value="20_ROWS">20行枠</option>
              </select>
              {(reissueDocType === 'INVOICE_COVER' ||
                reissueDocType === 'INVOICE_COVER_MEMO_SUM') && (
                <label className="inline-flex items-center gap-1 text-xs text-slate-700 pb-1.5 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={issueCoverDetail}
                    onChange={(e) => setIssueCoverDetail(e.target.checked)}
                  />
                  鏡明細も発行
                </label>
              )}
              <button
                type="button"
                disabled={saving}
                onClick={() => void handleReissue()}
                className="rounded-lg bg-blue-600 hover:bg-blue-700 disabled:opacity-60 px-3.5 py-1.5 text-xs font-semibold text-white cursor-pointer"
              >
                {saving ? '発行中...' : '新規版として再発行'}
              </button>
            </div>
          )}
        </div>

        <div className="overflow-x-auto">
          <table className="min-w-full divide-y divide-slate-200 text-xs">
            <thead className="bg-slate-50 text-slate-600">
              <tr>
                <th className="px-3 py-2 text-left">帳票種別</th>
                <th className="px-3 py-2 text-center">版 / ラベル</th>
                <th className="px-3 py-2 text-center">枠</th>
                <th className="px-3 py-2 text-center">発行日時</th>
                <th className="px-3 py-2 text-left">発行者</th>
                <th className="px-3 py-2 text-left">SHA-256</th>
                <th className="px-3 py-2 text-right">PDF操作</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {detail.snapshots.length === 0 ? (
                <tr>
                  <td colSpan={7} className="px-4 py-6 text-center text-slate-500">
                    スナップショット履歴がありません。
                  </td>
                </tr>
              ) : (
                detail.snapshots.map((snap) => (
                  <tr key={snap.id} className="hover:bg-slate-50">
                    <td className="px-3 py-2 font-medium text-slate-900">
                      {getDocLabel(snap.documentType)}
                    </td>
                    <td className="px-3 py-2 text-center font-mono">
                      v{snap.versionNo}{' '}
                      {snap.reissueLabel !== null && (
                        <span className="ml-1 px-1.5 py-0.5 rounded bg-red-50 border border-red-200 text-red-700 font-semibold">
                          {snap.reissueLabel}
                        </span>
                      )}
                    </td>
                    <td className="px-3 py-2 text-center font-mono">{snap.templateVariant}</td>
                    <td className="px-3 py-2 text-center font-mono">
                      {snap.issuedAt.slice(0, 19).replace('T', ' ')}
                    </td>
                    <td className="px-3 py-2">
                      {snap.issuedByName !== null ? snap.issuedByName : '-'}
                    </td>
                    <td className="px-3 py-2 font-mono text-[10px] text-slate-500">
                      {snap.payloadSha256.slice(0, 16)}...
                    </td>
                    <td className="px-3 py-2 text-right whitespace-nowrap space-x-1.5">
                      <button
                        type="button"
                        onClick={() => setPreviewSnapshotId(snap.id)}
                        className="rounded border border-slate-300 bg-white hover:bg-slate-50 px-2.5 py-1 font-medium text-slate-700 cursor-pointer"
                      >
                        プレビュー
                      </button>
                      <a
                        href={`/api/v1/snapshots/${encodeURIComponent(snap.id)}/pdf?download=1`}
                        className="rounded border border-blue-200 bg-blue-50 hover:bg-blue-100 px-2.5 py-1 font-medium text-blue-700"
                      >
                        ダウンロード
                      </a>
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </div>

      {/* 紐づく売上・立替伝票一覧 */}
      <div className="space-y-3">
        <h2 className="text-base font-bold text-slate-900">
          紐づく売上・立替伝票（{detail.slips.length}件）
        </h2>
        {detail.slips.map((slip) => (
          <div
            key={slip.id}
            className="rounded-xl bg-white border border-slate-200 shadow-xs overflow-hidden"
          >
            <div className="px-4 py-2.5 bg-slate-50 border-b border-slate-200 flex flex-wrap items-center justify-between gap-2 text-xs">
              <div className="flex items-center gap-2">
                <span className="px-2 py-0.5 rounded bg-blue-100 text-blue-800 font-semibold">
                  {ENTRY_TYPE_LABELS[slip.entryType]}
                </span>
                <Link
                  href={`/sales/${slip.id}`}
                  className="font-mono font-bold text-blue-600 hover:underline"
                >
                  伝票No.{slip.slipNo}
                </Link>
                <span className="font-mono text-slate-500">{slip.slipDate}</span>
                <span className="font-medium text-slate-900">
                  {slip.slipName !== '' ? slip.slipName : '（件名なし）'}
                </span>
                <span className="px-1.5 py-0.5 rounded bg-slate-200 text-slate-700 font-mono">
                  {slip.status}:{SALES_STATUS_LABELS[slip.status]}
                </span>
              </div>
              <div className="font-mono font-bold text-slate-900">
                税抜 {formatYen(slip.subtotalAmount)} / 税 {formatYen(slip.taxTotal)} / 税込{' '}
                {formatYen(slip.totalAmount)}
              </div>
            </div>
            <div className="overflow-x-auto">
              <table className="min-w-full divide-y divide-slate-200 text-xs">
                <thead className="bg-slate-50/70 text-slate-600">
                  <tr>
                    <th className="px-3 py-1.5 text-center w-12">行</th>
                    <th className="px-3 py-1.5 text-left">品名・仕様</th>
                    <th className="px-3 py-1.5 text-right">数量 / 単位</th>
                    <th className="px-3 py-1.5 text-right">単価</th>
                    <th className="px-3 py-1.5 text-center">税区分</th>
                    <th className="px-3 py-1.5 text-right">税抜金額</th>
                    <th className="px-3 py-1.5 text-right">消費税</th>
                    <th className="px-3 py-1.5 text-right">行税込計</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {slip.lines.map((line) => (
                    <tr key={line.id}>
                      <td className="px-3 py-1.5 text-center font-mono text-slate-500">
                        {line.lineNo}
                      </td>
                      <td className="px-3 py-1.5 font-medium text-slate-900">
                        {line.isHeading ? `【${line.itemName}】` : line.itemName}
                        {line.targetMonthLabel !== null && (
                          <span className="ml-1.5 text-slate-400">[{line.targetMonthLabel}]</span>
                        )}
                      </td>
                      <td className="px-3 py-1.5 text-right font-mono">
                        {line.isHeading
                          ? '-'
                          : `${line.quantity} ${line.unitName !== null ? line.unitName : ''}`}
                      </td>
                      <td className="px-3 py-1.5 text-right font-mono">
                        {line.isHeading ? '-' : formatYen(line.appliedUnitPrice)}
                      </td>
                      <td className="px-3 py-1.5 text-center font-mono">{line.taxCode}</td>
                      <td className="px-3 py-1.5 text-right font-mono">
                        {line.isHeading ? '-' : formatYen(line.exclAmount)}
                      </td>
                      <td className="px-3 py-1.5 text-right font-mono text-slate-600">
                        {line.isHeading ? '-' : formatYen(line.lineTax)}
                      </td>
                      <td className="px-3 py-1.5 text-right font-mono font-semibold text-slate-900">
                        {line.isHeading ? '-' : formatYen(line.rowTotal)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        ))}
      </div>

      {/* PDFプレビューモーダル */}
      {previewSnapshotId !== null && (
        <div className="fixed inset-0 z-50 bg-slate-900/60 flex items-center justify-center p-4">
          <div className="bg-white rounded-xl w-full max-w-4xl h-[85vh] flex flex-col shadow-2xl overflow-hidden">
            <div className="px-4 py-3 border-b border-slate-200 flex items-center justify-between">
              <span className="text-sm font-bold text-slate-900">請求書スナップショット PDF プレビュー</span>
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
              title="請求書PDFプレビュー"
              src={`/api/v1/snapshots/${encodeURIComponent(previewSnapshotId)}/pdf`}
              className="flex-1 w-full border-0"
            />
          </div>
        </div>
      )}
    </div>
  );
}
