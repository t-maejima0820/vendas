'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useMemo, useState } from 'react';
import {
  calculateSalesSlip,
  type RoundingMode,
  type SalesLineCalcInput,
  type TaxCode,
} from '@/lib/domain/calculations';
import type {
  EstimateIntelligenceOption,
  EstimateProductOption,
  QuotationTemplateVariant,
  SnapshotHistoryItemDto,
} from '@/lib/estimates/types';
import { normalizeNullableText, requestMasterApi } from '@/lib/masters/client-api';
import {
  APPROVAL_STATUS_LABELS,
  ENTRY_TYPE_LABELS,
  SALES_STATUS_LABELS,
  type ApprovalStatus,
  type SalesDetailDto,
  type SalesEditorLookupsDto,
  type SalesEntryType,
  type SalesInput,
  type SalesLineInput,
  type SalesStatus,
} from '@/lib/sales/types';

interface SalesEditorClientProps {
  mode: 'create' | 'edit';
  initialEntryType: SalesEntryType;
  lookups: SalesEditorLookupsDto;
  initialDetail: SalesDetailDto | null;
}

interface SalesLineRowState {
  localKey: string;
  productId: string | null;
  itemCode: string;
  itemName: string;
  unitName: string;
  targetMonthLabel: string;
  isHeading: boolean;
  quantity: string;
  masterUnitPrice: number | null;
  appliedUnitPrice: string;
  taxCode: TaxCode;
  remarks: string;
}

type EditorTab = 'details' | 'snapshots';

function createEmptyLine(key: string, isHeading: boolean = false): SalesLineRowState {
  return {
    localKey: key,
    productId: null,
    itemCode: '',
    itemName: '',
    unitName: isHeading ? '' : '式',
    targetMonthLabel: '',
    isHeading,
    quantity: isHeading ? '0' : '1',
    masterUnitPrice: null,
    appliedUnitPrice: '0',
    taxCode: 'A',
    remarks: '',
  };
}

function detailLineToState(line: SalesDetailDto['lines'][number], idx: number): SalesLineRowState {
  return {
    localKey: `${line.id}-${idx}`,
    productId: line.productId,
    itemCode: line.itemCode !== null ? line.itemCode : '',
    itemName: line.itemName,
    unitName: line.unitName !== null ? line.unitName : '',
    targetMonthLabel: line.targetMonthLabel !== null ? line.targetMonthLabel : '',
    isHeading: line.isHeading,
    quantity: String(line.quantity),
    masterUnitPrice: line.masterUnitPrice,
    appliedUnitPrice: String(line.appliedUnitPrice),
    taxCode: line.taxCode,
    remarks: line.remarks !== null ? line.remarks : '',
  };
}

function parseIntegerYenSafe(raw: string): bigint {
  const cleaned = raw.trim().replace(/,/g, '');
  if (/^-?\d+$/.test(cleaned)) {
    return BigInt(cleaned);
  }
  return 0n;
}

function parseQuantityForCalc(raw: string): string {
  const cleaned = raw.trim();
  if (/^-?\d+(\.\d{1,4})?$/.test(cleaned)) {
    return cleaned;
  }
  return '0';
}

function formatYenBigInt(val: bigint): string {
  return `¥${Number(val).toLocaleString('ja-JP')}`;
}

export default function SalesEditorClient({
  mode,
  initialEntryType,
  lookups,
  initialDetail,
}: SalesEditorClientProps) {
  const router = useRouter();
  const todayIso = new Date().toISOString().slice(0, 10);

  const isLocked =
    mode === 'edit' &&
    initialDetail !== null &&
    (initialDetail.status === 'K4' || initialDetail.status === 'K5');

  const [activeTab, setActiveTab] = useState<EditorTab>('details');
  const [lineSeq, setLineSeq] = useState(100);

  const [entryType, setEntryType] = useState<SalesEntryType>(
    initialDetail !== null ? initialDetail.entryType : initialEntryType,
  );
  const [slipName, setSlipName] = useState(
    initialDetail !== null ? initialDetail.slipName : '',
  );
  const [slipDate, setSlipDate] = useState(
    initialDetail !== null ? initialDetail.slipDate : todayIso,
  );
  const [partnerId, setPartnerId] = useState(
    initialDetail !== null ? initialDetail.partnerId : '',
  );
  const [projectId, setProjectId] = useState(
    initialDetail !== null && initialDetail.projectId !== null ? initialDetail.projectId : '',
  );
  const [honorific, setHonorific] = useState(
    initialDetail !== null ? initialDetail.honorific : '御中',
  );
  const [status, setStatus] = useState<SalesStatus>(
    initialDetail !== null ? initialDetail.status : 'K1',
  );
  const [salesKubun, setSalesKubun] = useState(
    initialDetail !== null && initialDetail.salesKubun !== null ? initialDetail.salesKubun : '',
  );
  const [roundingMode, setRoundingMode] = useState<RoundingMode>(
    initialDetail !== null ? initialDetail.roundingMode : lookups.defaultRoundingMode,
  );
  const [approvalStatus, setApprovalStatus] = useState<ApprovalStatus>(
    initialDetail !== null ? initialDetail.approvalStatus : 0,
  );
  const [approvalRemarks, setApprovalRemarks] = useState(
    initialDetail !== null && initialDetail.approvalRemarks !== null
      ? initialDetail.approvalRemarks
      : '',
  );

  const [lines, setLines] = useState<SalesLineRowState[]>(() => {
    if (initialDetail !== null && initialDetail.lines.length > 0) {
      return initialDetail.lines.map((l, idx) => detailLineToState(l, idx));
    }
    return [createEmptyLine('init-1', false)];
  });

  const [deliveryNotes, setDeliveryNotes] = useState<SnapshotHistoryItemDto[]>(
    initialDetail !== null ? initialDetail.deliveryNotes : [],
  );
  const [deliveryReceipts, setDeliveryReceipts] = useState<SnapshotHistoryItemDto[]>(
    initialDetail !== null ? initialDetail.deliveryReceipts : [],
  );

  const [pickerMode, setPickerMode] = useState<'none' | 'product' | 'intelligence'>('none');
  const [pickerTargetIndex, setPickerTargetIndex] = useState<number | null>(null);
  const [pickerKeyword, setPickerKeyword] = useState('');

  const [templateVariant, setTemplateVariant] = useState<QuotationTemplateVariant>(
    lookups.quotationTemplateRows === 20 ? '20_ROWS' : '10_ROWS',
  );
  const [issueDate, setIssueDate] = useState(todayIso);
  const [previewSnapshotId, setPreviewSnapshotId] = useState<string | null>(null);

  const [hasUnsavedChanges, setHasUnsavedChanges] = useState(false);
  const [saving, setSaving] = useState(false);
  const [issuingDocType, setIssuingDocType] = useState<'DELIVERY_NOTE' | 'DELIVERY_RECEIPT' | null>(null);
  const [bannerError, setBannerError] = useState<string | null>(null);
  const [bannerSuccess, setBannerSuccess] = useState<string | null>(null);

  // リアルタイム計算（Rule G4: calculations.ts の純粋関数呼び出し）
  const liveCalc = useMemo(() => {
    const calcInputs: SalesLineCalcInput[] = lines.map((line, idx) => ({
      lineNo: idx + 1,
      isHeading: line.isHeading,
      quantity: line.isHeading ? '0' : parseQuantityForCalc(line.quantity),
      appliedUnitPrice: line.isHeading ? 0n : parseIntegerYenSafe(line.appliedUnitPrice),
      taxCode: line.taxCode,
    }));
    const policy = initialDetail !== null ? initialDetail.taxCalcPolicy : lookups.taxCalcPolicy;
    return calculateSalesSlip(calcInputs, roundingMode, policy);
  }, [lines, roundingMode, initialDetail, lookups.taxCalcPolicy]);

  const filteredProducts = useMemo(() => {
    const kw = pickerKeyword.trim().toLowerCase();
    if (kw === '') return lookups.products.slice(0, 60);
    return lookups.products
      .filter(
        (p) =>
          p.productCode.toLowerCase().includes(kw) ||
          p.productName.toLowerCase().includes(kw) ||
          (p.productNameSub !== null && p.productNameSub.toLowerCase().includes(kw)),
      )
      .slice(0, 60);
  }, [lookups.products, pickerKeyword]);

  const filteredIntelligences = useMemo(() => {
    const kw = pickerKeyword.trim().toLowerCase();
    if (kw === '') return lookups.intelligences.slice(0, 60);
    return lookups.intelligences
      .filter((i) => i.itemName.toLowerCase().includes(kw))
      .slice(0, 60);
  }, [lookups.intelligences, pickerKeyword]);

  function nextLineKey(): string {
    const k = `row-${lineSeq}`;
    setLineSeq((s) => s + 1);
    return k;
  }

  function handlePartnerChange(newPartnerId: string) {
    if (isLocked) return;
    setPartnerId(newPartnerId);
    setHasUnsavedChanges(true);
    const partner = lookups.partners.find((p) => p.id === newPartnerId);
    if (partner !== undefined) {
      setHonorific(partner.isIndividualHonorific ? '様' : '御中');
    }
  }

  function updateLineAt(index: number, patch: Partial<SalesLineRowState>) {
    if (isLocked) return;
    setHasUnsavedChanges(true);
    setLines((prev) => prev.map((row, idx) => (idx === index ? { ...row, ...patch } : row)));
  }

  function addLine(isHeading: boolean, insertAfterIndex?: number) {
    if (isLocked) return;
    setHasUnsavedChanges(true);
    const fresh = createEmptyLine(nextLineKey(), isHeading);
    setLines((prev) => {
      if (insertAfterIndex === undefined) return [...prev, fresh];
      const next = [...prev];
      next.splice(insertAfterIndex + 1, 0, fresh);
      return next;
    });
  }

  function moveLine(index: number, dir: 'UP' | 'DOWN') {
    if (isLocked) return;
    const target = dir === 'UP' ? index - 1 : index + 1;
    if (target < 0 || target >= lines.length) return;
    setHasUnsavedChanges(true);
    setLines((prev) => {
      const next = [...prev];
      const current = next[index];
      const swap = next[target];
      if (current === undefined || swap === undefined) return prev;
      next[index] = swap;
      next[target] = current;
      return next;
    });
  }

  function removeLine(index: number) {
    if (isLocked) return;
    if (lines.length <= 1) {
      setBannerError('明細は最低1行必要です。');
      return;
    }
    setHasUnsavedChanges(true);
    setLines((prev) => prev.filter((_, idx) => idx !== index));
  }

  function applyProductToRow(prod: EstimateProductOption) {
    if (isLocked) return;
    setHasUnsavedChanges(true);
    const rowData: SalesLineRowState = {
      localKey:
        pickerTargetIndex !== null && lines[pickerTargetIndex] !== undefined
          ? lines[pickerTargetIndex].localKey
          : nextLineKey(),
      productId: prod.id,
      itemCode: prod.productCode,
      itemName: prod.productName,
      unitName: prod.unitName !== null ? prod.unitName : '',
      targetMonthLabel: '',
      isHeading: prod.isHeading,
      quantity: prod.isHeading ? '0' : '1',
      masterUnitPrice: prod.standardUnitPrice,
      appliedUnitPrice: String(prod.standardUnitPrice),
      taxCode: prod.defaultTaxCode,
      remarks: '',
    };
    if (pickerTargetIndex !== null) {
      setLines((prev) => prev.map((r, idx) => (idx === pickerTargetIndex ? rowData : r)));
    } else {
      setLines((prev) => [...prev, rowData]);
    }
    setPickerMode('none');
    setPickerKeyword('');
    setPickerTargetIndex(null);
  }

  function applyIntelligenceToRow(intel: EstimateIntelligenceOption) {
    if (isLocked) return;
    setHasUnsavedChanges(true);
    const rowData: SalesLineRowState = {
      localKey:
        pickerTargetIndex !== null && lines[pickerTargetIndex] !== undefined
          ? lines[pickerTargetIndex].localKey
          : nextLineKey(),
      productId: null,
      itemCode: '',
      itemName: intel.itemName,
      unitName: intel.unitName !== null ? intel.unitName : '',
      targetMonthLabel: '',
      isHeading: false,
      quantity: '1',
      masterUnitPrice: intel.unitPrice,
      appliedUnitPrice: String(intel.unitPrice),
      taxCode: intel.taxCode,
      remarks: '',
    };
    if (pickerTargetIndex !== null) {
      setLines((prev) => prev.map((r, idx) => (idx === pickerTargetIndex ? rowData : r)));
    } else {
      setLines((prev) => [...prev, rowData]);
    }
    setPickerMode('none');
    setPickerKeyword('');
    setPickerTargetIndex(null);
  }

  function buildPayload(): SalesInput {
    const lineInputs: SalesLineInput[] = lines.map((line) => ({
      productId: line.productId,
      itemCode: normalizeNullableText(line.itemCode),
      itemName: line.itemName.trim(),
      unitName: line.isHeading ? null : normalizeNullableText(line.unitName),
      targetMonthLabel: line.isHeading ? null : normalizeNullableText(line.targetMonthLabel),
      isHeading: line.isHeading,
      quantity: line.isHeading ? 0 : Number(parseQuantityForCalc(line.quantity)),
      masterUnitPrice: line.masterUnitPrice,
      appliedUnitPrice: line.isHeading ? 0 : Number(parseIntegerYenSafe(line.appliedUnitPrice)),
      taxCode: line.taxCode,
      remarks: normalizeNullableText(line.remarks),
    }));

    return {
      entryType,
      slipName: slipName.trim(),
      slipDate,
      partnerId,
      projectId: projectId.trim() !== '' ? projectId : null,
      honorific: honorific.trim(),
      status,
      salesKubun: normalizeNullableText(salesKubun),
      roundingMode,
      approvalRemarks: normalizeNullableText(approvalRemarks),
      lines: lineInputs,
    };
  }

  async function handleSave(e: React.FormEvent) {
    e.preventDefault();
    if (isLocked) return;
    setBannerError(null);
    setBannerSuccess(null);

    if (partnerId === '') {
      setBannerError('取引先を選択してください。');
      return;
    }
    if (slipName.trim() === '') {
      setBannerError('件名を入力してください。');
      return;
    }

    setSaving(true);
    const payload = buildPayload();
    const url =
      mode === 'create'
        ? '/api/v1/sales'
        : `/api/v1/sales/${encodeURIComponent(initialDetail !== null ? initialDetail.id : '')}`;
    const method = mode === 'create' ? 'POST' : 'PUT';

    const res = await requestMasterApi<{ item: SalesDetailDto }>(url, {
      method,
      body: JSON.stringify(payload),
    });
    setSaving(false);
    if (!res.ok) {
      setBannerError(res.error);
      return;
    }

    setHasUnsavedChanges(false);
    if (mode === 'create') {
      router.push(`/sales/${res.data.item.id}`);
      router.refresh();
      return;
    }

    setLines(res.data.item.lines.map((l, idx) => detailLineToState(l, idx)));
    setDeliveryNotes(res.data.item.deliveryNotes);
    setDeliveryReceipts(res.data.item.deliveryReceipts);
    setBannerSuccess(`${ENTRY_TYPE_LABELS[entryType]} #${res.data.item.slipNo} を保存しました。`);
    router.refresh();
  }

  async function handleApprovalAction(nextApprovalStatus: ApprovalStatus) {
    if (initialDetail === null || isLocked) return;
    setBannerError(null);
    setBannerSuccess(null);
    setSaving(true);
    const res = await requestMasterApi<{ updatedCount: number }>('/api/v1/sales/approval', {
      method: 'PATCH',
      body: JSON.stringify({
        ids: [initialDetail.id],
        approvalStatus: nextApprovalStatus,
        approvalRemarks: normalizeNullableText(approvalRemarks),
      }),
    });
    setSaving(false);
    if (!res.ok) {
      setBannerError(res.error);
      return;
    }
    setApprovalStatus(nextApprovalStatus);
    setBannerSuccess(`承認ステータスを「${APPROVAL_STATUS_LABELS[nextApprovalStatus]}」に更新しました。`);
    router.refresh();
  }

  async function handleDelete() {
    if (initialDetail === null || isLocked) return;
    if (!window.confirm(`${ENTRY_TYPE_LABELS[entryType]} #${initialDetail.slipNo} を削除しますか？`)) return;
    setBannerError(null);
    setSaving(true);
    const res = await requestMasterApi<{ ok: true }>(
      `/api/v1/sales/${encodeURIComponent(initialDetail.id)}`,
      { method: 'DELETE' },
    );
    setSaving(false);
    if (!res.ok) {
      setBannerError(res.error);
      return;
    }
    router.push(`/sales?tab=${entryType}`);
    router.refresh();
  }

  async function handleIssueSnapshot(docType: 'DELIVERY_NOTE' | 'DELIVERY_RECEIPT') {
    if (initialDetail === null) return;
    setBannerError(null);
    setBannerSuccess(null);
    setIssuingDocType(docType);

    const res = await requestMasterApi<{ item: SnapshotHistoryItemDto }>('/api/v1/snapshots', {
      method: 'POST',
      body: JSON.stringify({
        documentType: docType,
        sourceEntityId: initialDetail.id,
        templateVariant,
        issueDate,
      }),
    });
    setIssuingDocType(null);
    if (!res.ok) {
      setBannerError(res.error);
      return;
    }

    const created = res.data.item;
    if (docType === 'DELIVERY_NOTE') {
      setDeliveryNotes((prev) => [created, ...prev]);
    } else {
      setDeliveryReceipts((prev) => [created, ...prev]);
    }
    const label = docType === 'DELIVERY_NOTE' ? '納品書' : '受領書';
    setBannerSuccess(
      `${label} 第${created.versionNo}版${created.reissueLabel !== null ? ` (${created.reissueLabel})` : ''} を発行・凍結保存しました。`,
    );
    setPreviewSnapshotId(created.id);
  }

  const backHref = `/sales?tab=${entryType}`;
  const totalSnapshots = deliveryNotes.length + deliveryReceipts.length;

  return (
    <div className="max-w-7xl space-y-5">
      {/* ヘッダ */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <div className="flex items-center gap-2 text-xs text-slate-500 mb-1">
            <Link href={backHref} className="hover:text-blue-600 hover:underline">
              売上・立替一覧
            </Link>
            <span>/</span>
            <span>
              {mode === 'create'
                ? `新規${ENTRY_TYPE_LABELS[entryType]}作成`
                : `${ENTRY_TYPE_LABELS[entryType]} #${initialDetail?.slipNo}`}
            </span>
          </div>
          <h1 className="text-2xl font-bold text-slate-900">
            {mode === 'create'
              ? `新規${ENTRY_TYPE_LABELS[entryType]}伝票作成`
              : `${ENTRY_TYPE_LABELS[entryType]}伝票 #${initialDetail?.slipNo} — ${slipName !== '' ? slipName : '（件名なし）'}`}
          </h1>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          {mode === 'edit' &&
            initialDetail !== null &&
            !isLocked &&
            totalSnapshots === 0 && (
              <button
                type="button"
                disabled={saving}
                onClick={() => void handleDelete()}
                className="rounded-lg border border-red-200 bg-white hover:bg-red-50 px-3 py-2 text-xs font-medium text-red-700 cursor-pointer"
              >
                削除
              </button>
            )}
          <Link
            href={backHref}
            className="rounded-lg border border-slate-300 bg-white hover:bg-slate-50 px-3 py-2 text-xs font-medium text-slate-700"
          >
            一覧へ戻る
          </Link>
        </div>
      </div>

      {isLocked && (
        <div className="rounded-xl border border-purple-300 bg-purple-50 px-4 py-3 text-sm text-purple-900">
          <strong>請求確定ロック中（{initialDetail?.status}: {SALES_STATUS_LABELS[initialDetail!.status]}）</strong>
          ：請求確定済み（K4/K5）の伝票は改変防止ロックにより閲覧専用です。修正・削除は行えません。
        </div>
      )}

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

      {/* タブ */}
      <div className="flex items-center gap-2 border-b border-slate-200">
        <button
          type="button"
          onClick={() => setActiveTab('details')}
          className={`px-4 py-2.5 text-sm font-medium border-b-2 transition-colors cursor-pointer ${
            activeTab === 'details'
              ? 'border-blue-600 text-blue-700'
              : 'border-transparent text-slate-600 hover:text-slate-900'
          }`}
        >
          伝票明細・基本情報（{lines.length}行）
        </button>
        <button
          type="button"
          onClick={() => setActiveTab('snapshots')}
          className={`px-4 py-2.5 text-sm font-medium border-b-2 transition-colors cursor-pointer ${
            activeTab === 'snapshots'
              ? 'border-blue-600 text-blue-700'
              : 'border-transparent text-slate-600 hover:text-slate-900'
          }`}
        >
          納品書・受領書発行 ＆ 版履歴（{totalSnapshots}版）
        </button>
      </div>

      {activeTab === 'details' && (
        <form onSubmit={handleSave} className="space-y-5">
          {/* ヘッダ入力 */}
          <div className="rounded-xl bg-white border border-slate-200 p-5 shadow-xs space-y-4">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <h2 className="text-sm font-bold text-slate-800">伝票ヘッダ情報</h2>
              <div className="flex items-center gap-2 text-xs">
                <span className="text-slate-500">承認状態:</span>
                <span
                  className={`px-2 py-0.5 rounded-full font-semibold ${
                    approvalStatus === 1
                      ? 'bg-emerald-100 text-emerald-800'
                      : approvalStatus === 2
                        ? 'bg-red-100 text-red-700'
                        : 'bg-amber-100 text-amber-800'
                  }`}
                >
                  {APPROVAL_STATUS_LABELS[approvalStatus]}
                </span>
              </div>
            </div>

            <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
              <div>
                <label className="block text-xs font-medium text-slate-600 mb-1">伝票区分</label>
                {mode === 'create' && lookups.salesEnabled && lookups.tatekaeEnabled ? (
                  <select
                    value={entryType}
                    onChange={(e) => {
                      setEntryType(e.target.value as SalesEntryType);
                      setHasUnsavedChanges(true);
                    }}
                    className="w-full rounded-lg border border-slate-300 px-3 py-1.5 text-sm bg-white"
                  >
                    <option value="SALE">SALE（通常売上）</option>
                    <option value="ADVANCE">ADVANCE（立替金）</option>
                  </select>
                ) : (
                  <div className="rounded-lg border border-slate-200 bg-slate-50 px-3 py-1.5 text-sm font-semibold text-slate-700">
                    {entryType}: {ENTRY_TYPE_LABELS[entryType]}
                  </div>
                )}
              </div>

              <div>
                <label className="block text-xs font-medium text-slate-600 mb-1">
                  売上日 <span className="text-red-500">*</span>
                </label>
                <input
                  type="date"
                  required
                  disabled={isLocked}
                  value={slipDate}
                  onChange={(e) => {
                    setSlipDate(e.target.value);
                    setHasUnsavedChanges(true);
                  }}
                  className="w-full rounded-lg border border-slate-300 px-3 py-1.5 text-sm disabled:bg-slate-100"
                />
              </div>

              <div>
                <label className="block text-xs font-medium text-slate-600 mb-1">
                  取引先 <span className="text-red-500">*</span>
                </label>
                <select
                  required
                  disabled={isLocked}
                  value={partnerId}
                  onChange={(e) => handlePartnerChange(e.target.value)}
                  className="w-full rounded-lg border border-slate-300 px-3 py-1.5 text-sm bg-white disabled:bg-slate-100"
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
                <label className="block text-xs font-medium text-slate-600 mb-1">
                  敬称 <span className="text-red-500">*</span>
                </label>
                <div className="flex gap-1.5">
                  <input
                    type="text"
                    required
                    disabled={isLocked}
                    value={honorific}
                    onChange={(e) => {
                      setHonorific(e.target.value);
                      setHasUnsavedChanges(true);
                    }}
                    className="w-full rounded-lg border border-slate-300 px-3 py-1.5 text-sm disabled:bg-slate-100"
                  />
                  <button
                    type="button"
                    disabled={isLocked}
                    onClick={() => {
                      setHonorific('御中');
                      setHasUnsavedChanges(true);
                    }}
                    className="rounded border border-slate-300 px-2 py-1 text-xs text-slate-600 hover:bg-slate-50 shrink-0 disabled:opacity-40 cursor-pointer"
                  >
                    御中
                  </button>
                  <button
                    type="button"
                    disabled={isLocked}
                    onClick={() => {
                      setHonorific('様');
                      setHasUnsavedChanges(true);
                    }}
                    className="rounded border border-slate-300 px-2 py-1 text-xs text-slate-600 hover:bg-slate-50 shrink-0 disabled:opacity-40 cursor-pointer"
                  >
                    様
                  </button>
                </div>
              </div>

              <div className="md:col-span-2">
                <label className="block text-xs font-medium text-slate-600 mb-1">
                  件名 <span className="text-red-500">*</span>
                </label>
                <input
                  type="text"
                  required
                  disabled={isLocked}
                  value={slipName}
                  onChange={(e) => {
                    setSlipName(e.target.value);
                    setHasUnsavedChanges(true);
                  }}
                  placeholder="例: 本社ビル電気改修工事"
                  className="w-full rounded-lg border border-slate-300 px-3 py-1.5 text-sm disabled:bg-slate-100"
                />
              </div>

              <div className="md:col-span-2">
                <label className="block text-xs font-medium text-slate-600 mb-1">
                  紐付け案件（任意）
                </label>
                <select
                  disabled={isLocked}
                  value={projectId}
                  onChange={(e) => {
                    setProjectId(e.target.value);
                    setHasUnsavedChanges(true);
                  }}
                  className="w-full rounded-lg border border-slate-300 px-3 py-1.5 text-sm bg-white disabled:bg-slate-100"
                >
                  <option value="">（案件紐付けなし）</option>
                  {lookups.projects.map((pj) => (
                    <option key={pj.id} value={pj.id}>
                      #{pj.projectNo} {pj.projectName} ({pj.status})
                    </option>
                  ))}
                </select>
              </div>

              <div>
                <label className="block text-xs font-medium text-slate-600 mb-1">ステータス</label>
                {isLocked ? (
                  <div className="rounded-lg border border-slate-200 bg-slate-100 px-3 py-1.5 text-sm font-semibold text-purple-800">
                    {status}: {SALES_STATUS_LABELS[status]}
                  </div>
                ) : (
                  <select
                    value={status}
                    onChange={(e) => {
                      setStatus(e.target.value as SalesStatus);
                      setHasUnsavedChanges(true);
                    }}
                    className="w-full rounded-lg border border-slate-300 px-3 py-1.5 text-sm bg-white"
                  >
                    <option value="K1">K1: {SALES_STATUS_LABELS.K1}</option>
                    <option value="K2">K2: {SALES_STATUS_LABELS.K2}</option>
                    <option value="K3">K3: {SALES_STATUS_LABELS.K3}</option>
                    <option value="K6">K6: {SALES_STATUS_LABELS.K6}</option>
                  </select>
                )}
              </div>

              <div>
                <label className="block text-xs font-medium text-slate-600 mb-1">端数処理</label>
                <select
                  disabled={isLocked}
                  value={roundingMode}
                  onChange={(e) => {
                    setRoundingMode(e.target.value as RoundingMode);
                    setHasUnsavedChanges(true);
                  }}
                  className="w-full rounded-lg border border-slate-300 px-3 py-1.5 text-sm bg-white disabled:bg-slate-100"
                >
                  <option value="FLOOR">FLOOR（切捨）</option>
                  <option value="ROUND">ROUND（四捨五入）</option>
                  <option value="CEIL">CEIL（切上）</option>
                </select>
              </div>

              <div>
                <label className="block text-xs font-medium text-slate-600 mb-1">区分メモ</label>
                <input
                  type="text"
                  disabled={isLocked}
                  value={salesKubun}
                  onChange={(e) => {
                    setSalesKubun(e.target.value);
                    setHasUnsavedChanges(true);
                  }}
                  placeholder="例: 通常 / 追加工事"
                  className="w-full rounded-lg border border-slate-300 px-3 py-1.5 text-sm disabled:bg-slate-100"
                />
              </div>

              <div>
                <label className="block text-xs font-medium text-slate-600 mb-1">承認備考</label>
                <input
                  type="text"
                  disabled={isLocked}
                  value={approvalRemarks}
                  onChange={(e) => {
                    setApprovalRemarks(e.target.value);
                    setHasUnsavedChanges(true);
                  }}
                  placeholder="承認・差戻しコメント"
                  className="w-full rounded-lg border border-slate-300 px-3 py-1.5 text-sm disabled:bg-slate-100"
                />
              </div>
            </div>

            {mode === 'edit' && !isLocked && lookups.approvalFlowEnabled && (
              <div className="pt-3 border-t border-slate-100 flex flex-wrap items-center justify-between gap-2">
                <span className="text-xs text-slate-500">
                  承認フロー操作（現在の承認状態: <strong>{APPROVAL_STATUS_LABELS[approvalStatus]}</strong>）
                </span>
                <div className="flex items-center gap-2">
                  <button
                    type="button"
                    disabled={saving}
                    onClick={() => void handleApprovalAction(1)}
                    className="rounded-lg bg-emerald-600 hover:bg-emerald-700 px-3 py-1.5 text-xs font-semibold text-white cursor-pointer"
                  >
                    承認済にする
                  </button>
                  <button
                    type="button"
                    disabled={saving}
                    onClick={() => void handleApprovalAction(2)}
                    className="rounded-lg bg-amber-600 hover:bg-amber-700 px-3 py-1.5 text-xs font-semibold text-white cursor-pointer"
                  >
                    差戻す
                  </button>
                  <button
                    type="button"
                    disabled={saving}
                    onClick={() => void handleApprovalAction(0)}
                    className="rounded-lg border border-slate-300 bg-white hover:bg-slate-50 px-3 py-1.5 text-xs font-medium text-slate-700 cursor-pointer"
                  >
                    未承認に戻す
                  </button>
                </div>
              </div>
            )}
          </div>

          {/* 明細エディタ */}
          <div className="rounded-xl bg-white border border-slate-200 shadow-xs overflow-hidden">
            <div className="flex flex-wrap items-center justify-between gap-2 px-5 py-3 bg-slate-50 border-b border-slate-200">
              <div className="text-sm font-bold text-slate-800">明細エディタ（行数無制限）</div>
              {!isLocked && (
                <div className="flex flex-wrap items-center gap-2">
                  <button
                    type="button"
                    onClick={() => {
                      setPickerTargetIndex(null);
                      setPickerKeyword('');
                      setPickerMode('product');
                    }}
                    className="rounded-lg border border-blue-300 bg-blue-50 hover:bg-blue-100 px-3 py-1.5 text-xs font-medium text-blue-700 cursor-pointer"
                  >
                    商品マスタから追加
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      setPickerTargetIndex(null);
                      setPickerKeyword('');
                      setPickerMode('intelligence');
                    }}
                    className="rounded-lg border border-indigo-300 bg-indigo-50 hover:bg-indigo-100 px-3 py-1.5 text-xs font-medium text-indigo-700 cursor-pointer"
                  >
                    入力候補から追加
                  </button>
                  <button
                    type="button"
                    onClick={() => addLine(true)}
                    className="rounded-lg border border-slate-300 bg-white hover:bg-slate-100 px-3 py-1.5 text-xs font-medium text-slate-700 cursor-pointer"
                  >
                    ＋ 見出し行
                  </button>
                  <button
                    type="button"
                    onClick={() => addLine(false)}
                    className="rounded-lg bg-slate-800 hover:bg-slate-700 px-3 py-1.5 text-xs font-semibold text-white cursor-pointer"
                  >
                    ＋ 明細行
                  </button>
                </div>
              )}
            </div>

            <datalist id="sales-units-list">
              {lookups.units.map((u) => (
                <option key={u.id} value={u.unitName} />
              ))}
            </datalist>

            <div className="overflow-x-auto">
              <table className="min-w-full divide-y divide-slate-200 text-xs">
                <thead className="bg-slate-100 text-slate-600 font-semibold">
                  <tr>
                    <th className="px-2 py-2 text-center w-10">No</th>
                    <th className="px-2 py-2 text-center w-12">見出</th>
                    <th className="px-2 py-2 text-left min-w-56">品名・仕様 / 商品選択</th>
                    <th className="px-2 py-2 text-left w-24">対象月分</th>
                    <th className="px-2 py-2 text-left w-24">数量</th>
                    <th className="px-2 py-2 text-left w-20">単位</th>
                    <th className="px-2 py-2 text-left w-28">税区分</th>
                    <th className="px-2 py-2 text-right w-32">適用単価</th>
                    <th className="px-2 py-2 text-right w-28">金額</th>
                    <th className="px-2 py-2 text-right w-24">消費税</th>
                    <th className="px-2 py-2 text-right w-28">行合計(税込)</th>
                    <th className="px-2 py-2 text-left min-w-32">明細備考</th>
                    {!isLocked && <th className="px-2 py-2 text-center w-28">操作</th>}
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {lines.map((row, idx) => {
                    const lr = liveCalc.lineResults[idx];
                    return (
                      <tr
                        key={row.localKey}
                        className={row.isHeading ? 'bg-blue-50/60' : 'bg-white hover:bg-slate-50/70'}
                      >
                        <td className="px-2 py-2 text-center font-mono text-slate-500">
                          {idx + 1}
                        </td>
                        <td className="px-2 py-2 text-center">
                          <input
                            type="checkbox"
                            disabled={isLocked}
                            checked={row.isHeading}
                            onChange={(e) =>
                              updateLineAt(idx, {
                                isHeading: e.target.checked,
                                quantity: e.target.checked
                                  ? '0'
                                  : row.quantity === '0'
                                    ? '1'
                                    : row.quantity,
                              })
                            }
                          />
                        </td>
                        <td className="px-2 py-2 space-y-1">
                          <div className="flex gap-1">
                            <input
                              type="text"
                              required
                              disabled={isLocked}
                              value={row.itemName}
                              onChange={(e) => updateLineAt(idx, { itemName: e.target.value })}
                              className={`w-full rounded border border-slate-300 px-2 py-1 text-xs disabled:bg-slate-100 ${
                                row.isHeading ? 'font-bold text-blue-900' : 'text-slate-900'
                              }`}
                            />
                            {!isLocked && (
                              <>
                                <button
                                  type="button"
                                  onClick={() => {
                                    setPickerTargetIndex(idx);
                                    setPickerKeyword('');
                                    setPickerMode('product');
                                  }}
                                  className="rounded border border-slate-300 bg-white hover:bg-slate-100 px-1.5 py-1 text-[10px] text-slate-600 shrink-0 cursor-pointer"
                                >
                                  商品
                                </button>
                                <button
                                  type="button"
                                  onClick={() => {
                                    setPickerTargetIndex(idx);
                                    setPickerKeyword('');
                                    setPickerMode('intelligence');
                                  }}
                                  className="rounded border border-slate-300 bg-white hover:bg-slate-100 px-1.5 py-1 text-[10px] text-slate-600 shrink-0 cursor-pointer"
                                >
                                  候補
                                </button>
                              </>
                            )}
                          </div>
                          {row.itemCode !== '' && (
                            <div className="text-[10px] font-mono text-slate-400">
                              コード: {row.itemCode}
                            </div>
                          )}
                        </td>

                        <td className="px-2 py-2">
                          <input
                            type="text"
                            disabled={isLocked || row.isHeading}
                            value={row.isHeading ? '' : row.targetMonthLabel}
                            onChange={(e) => updateLineAt(idx, { targetMonthLabel: e.target.value })}
                            placeholder="例: 6月分"
                            className="w-full rounded border border-slate-300 px-2 py-1 text-center disabled:bg-slate-100"
                          />
                        </td>

                        <td className="px-2 py-2">
                          <input
                            type="text"
                            disabled={isLocked || row.isHeading}
                            value={row.isHeading ? '' : row.quantity}
                            onChange={(e) => updateLineAt(idx, { quantity: e.target.value })}
                            className="w-full rounded border border-slate-300 px-2 py-1 text-right font-mono disabled:bg-slate-100"
                          />
                        </td>

                        <td className="px-2 py-2">
                          <input
                            type="text"
                            list="sales-units-list"
                            disabled={isLocked || row.isHeading}
                            value={row.isHeading ? '' : row.unitName}
                            onChange={(e) => updateLineAt(idx, { unitName: e.target.value })}
                            className="w-full rounded border border-slate-300 px-2 py-1 text-center disabled:bg-slate-100"
                          />
                        </td>

                        <td className="px-2 py-2">
                          <select
                            disabled={isLocked || row.isHeading}
                            value={row.taxCode}
                            onChange={(e) => updateLineAt(idx, { taxCode: e.target.value as TaxCode })}
                            className="w-full rounded border border-slate-300 px-1.5 py-1 bg-white disabled:bg-slate-100"
                          >
                            {lookups.taxCodes.map((tc) => (
                              <option key={tc.taxCode} value={tc.taxCode}>
                                {tc.taxCode}: {tc.taxName}
                              </option>
                            ))}
                          </select>
                        </td>

                        <td className="px-2 py-2">
                          <input
                            type="text"
                            disabled={isLocked || row.isHeading}
                            value={row.isHeading ? '' : row.appliedUnitPrice}
                            onChange={(e) => updateLineAt(idx, { appliedUnitPrice: e.target.value })}
                            className="w-full rounded border border-slate-300 px-2 py-1 text-right font-mono disabled:bg-slate-100"
                          />
                          {row.masterUnitPrice !== null && !row.isHeading && (
                            <div className="text-[10px] text-slate-400 text-right font-mono">
                              基準: ¥{row.masterUnitPrice.toLocaleString('ja-JP')}
                            </div>
                          )}
                        </td>

                        <td className="px-2 py-2 text-right font-mono text-slate-900">
                          {row.isHeading || lr === undefined ? '-' : formatYenBigInt(lr.lineAmount)}
                        </td>

                        <td className="px-2 py-2 text-right font-mono text-slate-600">
                          {row.isHeading || lr === undefined ? '-' : formatYenBigInt(lr.lineTax)}
                        </td>

                        <td className="px-2 py-2 text-right font-mono font-semibold text-slate-900">
                          {row.isHeading || lr === undefined ? '-' : formatYenBigInt(lr.rowTotal)}
                        </td>

                        <td className="px-2 py-2">
                          <input
                            type="text"
                            disabled={isLocked}
                            value={row.remarks}
                            onChange={(e) => updateLineAt(idx, { remarks: e.target.value })}
                            className="w-full rounded border border-slate-300 px-2 py-1 disabled:bg-slate-100"
                          />
                        </td>

                        {!isLocked && (
                          <td className="px-2 py-2 text-center whitespace-nowrap">
                            <div className="inline-flex items-center gap-1">
                              <button
                                type="button"
                                disabled={idx === 0}
                                onClick={() => moveLine(idx, 'UP')}
                                className="rounded border border-slate-300 px-1.5 py-0.5 text-[11px] disabled:opacity-30 cursor-pointer"
                              >
                                ↑
                              </button>
                              <button
                                type="button"
                                disabled={idx === lines.length - 1}
                                onClick={() => moveLine(idx, 'DOWN')}
                                className="rounded border border-slate-300 px-1.5 py-0.5 text-[11px] disabled:opacity-30 cursor-pointer"
                              >
                                ↓
                              </button>
                              <button
                                type="button"
                                onClick={() => addLine(false, idx)}
                                className="rounded border border-slate-300 px-1.5 py-0.5 text-[11px] text-blue-700 cursor-pointer"
                              >
                                ＋
                              </button>
                              <button
                                type="button"
                                onClick={() => removeLine(idx)}
                                className="rounded border border-red-200 px-1.5 py-0.5 text-[11px] text-red-600 cursor-pointer"
                              >
                                ×
                              </button>
                            </div>
                          </td>
                        )}
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </div>

          {/* リアルタイム積算バー */}
          <div className="rounded-xl bg-slate-900 text-white p-5 shadow-sm flex flex-wrap items-center justify-between gap-4">
            <div className="grid grid-cols-2 md:grid-cols-4 gap-6 flex-1">
              <div>
                <div className="text-[11px] text-slate-400">税抜小計</div>
                <div className="text-base font-bold font-mono mt-0.5">
                  {formatYenBigInt(liveCalc.subtotalAmount)}
                </div>
              </div>
              <div>
                <div className="text-[11px] text-slate-400">消費税合計</div>
                <div className="text-base font-bold font-mono mt-0.5">
                  {formatYenBigInt(liveCalc.taxTotal)}
                </div>
                <div className="text-[10px] text-slate-400 font-mono">
                  10%: {formatYenBigInt(liveCalc.rate10Tax)} / 8%: {formatYenBigInt(liveCalc.rate8Tax)}
                </div>
              </div>
              <div>
                <div className="text-[11px] text-blue-300">税込合計金額</div>
                <div className="text-xl font-bold font-mono text-blue-200 mt-0.5">
                  {formatYenBigInt(liveCalc.totalAmount)}
                </div>
              </div>
              <div>
                <div className="text-[11px] text-slate-400">計算ポリシー</div>
                <div className="text-xs font-mono text-slate-300 mt-1">
                  {liveCalc.policy} / {liveCalc.roundingMode}
                </div>
              </div>
            </div>

            {!isLocked && (
              <button
                type="submit"
                disabled={saving}
                className="rounded-lg bg-blue-500 hover:bg-blue-400 px-6 py-2.5 text-sm font-bold text-white transition-colors cursor-pointer"
              >
                {saving ? '保存中...' : mode === 'create' ? '伝票を登録する' : '変更を保存する'}
              </button>
            )}
          </div>
        </form>
      )}

      {/* タブ2: 納品書・受領書スナップショット発行 ＆ 版履歴 */}
      {activeTab === 'snapshots' && (
        <div className="space-y-5">
          {mode === 'create' || initialDetail === null ? (
            <div className="rounded-xl border border-amber-200 bg-amber-50 p-4 text-sm text-amber-800">
              納品書・受領書を発行するには、先に伝票データを保存してください。
            </div>
          ) : (
            <>
              <div className="rounded-xl bg-white border border-slate-200 p-5 shadow-xs space-y-4">
                <div>
                  <h2 className="text-sm font-bold text-slate-800">
                    納品書・受領書の発行（イミュータブルスナップショット確定）
                  </h2>
                  <p className="text-xs text-slate-500 mt-0.5">
                    発行時点の自社情報・顧客情報・明細・金額を凍結保存し、以降の版履歴から100%同一PDFを再出力できます。
                  </p>
                </div>

                {hasUnsavedChanges && (
                  <div className="rounded-lg border border-amber-300 bg-amber-50 px-3 py-2 text-xs text-amber-900">
                    未保存の変更があります。最新内容を反映して発行する場合は、先に「伝票明細・基本情報」タブで保存してください。
                  </div>
                )}

                <div className="flex flex-wrap items-end gap-4">
                  <div>
                    <label className="block text-xs font-medium text-slate-600 mb-1">
                      帳票レイアウト
                    </label>
                    <select
                      value={templateVariant}
                      onChange={(e) => setTemplateVariant(e.target.value as QuotationTemplateVariant)}
                      className="rounded-lg border border-slate-300 px-3 py-1.5 text-sm bg-white"
                    >
                      <option value="10_ROWS">10_ROWS（標準10行・自動改ページ）</option>
                      <option value="20_ROWS">20_ROWS（20行明細・自動改ページ）</option>
                    </select>
                  </div>
                  <div>
                    <label className="block text-xs font-medium text-slate-600 mb-1">
                      帳票印字発行日
                    </label>
                    <input
                      type="date"
                      value={issueDate}
                      onChange={(e) => setIssueDate(e.target.value)}
                      className="rounded-lg border border-slate-300 px-3 py-1.5 text-sm"
                    />
                  </div>
                  <button
                    type="button"
                    disabled={issuingDocType !== null}
                    onClick={() => void handleIssueSnapshot('DELIVERY_NOTE')}
                    className="rounded-lg bg-indigo-600 hover:bg-indigo-700 px-4 py-2 text-sm font-semibold text-white cursor-pointer"
                  >
                    {issuingDocType === 'DELIVERY_NOTE'
                      ? '発行中...'
                      : deliveryNotes.length === 0
                        ? '納品書を発行（第1版）'
                        : `納品書を再発行（第${deliveryNotes[0]!.versionNo + 1}版）`}
                  </button>
                  <button
                    type="button"
                    disabled={issuingDocType !== null}
                    onClick={() => void handleIssueSnapshot('DELIVERY_RECEIPT')}
                    className="rounded-lg bg-teal-600 hover:bg-teal-700 px-4 py-2 text-sm font-semibold text-white cursor-pointer"
                  >
                    {issuingDocType === 'DELIVERY_RECEIPT'
                      ? '発行中...'
                      : deliveryReceipts.length === 0
                        ? '受領書を発行（第1版）'
                        : `受領書を再発行（第${deliveryReceipts[0]!.versionNo + 1}版）`}
                  </button>
                </div>
              </div>

              {[
                { title: '納品書 (DELIVERY_NOTE) 発行履歴', items: deliveryNotes },
                { title: '受領書 (DELIVERY_RECEIPT) 発行履歴', items: deliveryReceipts },
              ].map((section) => (
                <div
                  key={section.title}
                  className="rounded-xl bg-white border border-slate-200 shadow-xs overflow-hidden"
                >
                  <div className="px-5 py-3 bg-slate-50 border-b border-slate-200 text-sm font-bold text-slate-800">
                    {section.title}
                  </div>
                  <div className="overflow-x-auto">
                    <table className="min-w-full divide-y divide-slate-200 text-sm">
                      <thead className="bg-slate-50 text-xs text-slate-600">
                        <tr>
                          <th className="px-4 py-2 text-center">版番号</th>
                          <th className="px-4 py-2 text-center">発行区分</th>
                          <th className="px-4 py-2 text-center">テンプレート</th>
                          <th className="px-4 py-2 text-left">発行日時</th>
                          <th className="px-4 py-2 text-left">発行者</th>
                          <th className="px-4 py-2 text-left">SHA-256</th>
                          <th className="px-4 py-2 text-right">PDF操作</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-slate-100">
                        {section.items.length === 0 ? (
                          <tr>
                            <td colSpan={7} className="px-4 py-5 text-center text-sm text-slate-500">
                              まだ発行履歴がありません。
                            </td>
                          </tr>
                        ) : (
                          section.items.map((snap) => (
                            <tr key={snap.id} className="hover:bg-slate-50">
                              <td className="px-4 py-2 text-center font-mono font-bold">
                                v{snap.versionNo}
                              </td>
                              <td className="px-4 py-2 text-center">
                                {snap.isReissue ? (
                                  <span className="inline-flex px-2 py-0.5 rounded bg-red-50 border border-red-200 text-red-700 text-xs font-semibold">
                                    {snap.reissueLabel !== null ? snap.reissueLabel : '＜再発行＞'}
                                  </span>
                                ) : (
                                  <span className="inline-flex px-2 py-0.5 rounded bg-emerald-50 border border-emerald-200 text-emerald-700 text-xs font-semibold">
                                    初回発行
                                  </span>
                                )}
                              </td>
                              <td className="px-4 py-2 text-center font-mono text-xs text-slate-600">
                                {snap.templateVariant}
                              </td>
                              <td className="px-4 py-2 text-xs font-mono text-slate-700">
                                {snap.issuedAt.slice(0, 19).replace('T', ' ')}
                              </td>
                              <td className="px-4 py-2 text-xs text-slate-700">
                                {snap.issuedByName !== null ? snap.issuedByName : '-'}
                              </td>
                              <td
                                className="px-4 py-2 font-mono text-[11px] text-slate-500"
                                title={snap.payloadSha256}
                              >
                                {snap.payloadSha256.slice(0, 16)}…
                              </td>
                              <td className="px-4 py-2 text-right whitespace-nowrap space-x-2">
                                <button
                                  type="button"
                                  onClick={() => setPreviewSnapshotId(snap.id)}
                                  className="rounded border border-blue-300 bg-blue-50 hover:bg-blue-100 px-2.5 py-1 text-xs font-medium text-blue-700 cursor-pointer"
                                >
                                  印刷プレビュー
                                </button>
                                <a
                                  href={`/api/v1/snapshots/${encodeURIComponent(snap.id)}/pdf?download=1`}
                                  className="inline-block rounded border border-slate-300 bg-white hover:bg-slate-50 px-2.5 py-1 text-xs font-medium text-slate-700"
                                >
                                  PDFダウンロード
                                </a>
                              </td>
                            </tr>
                          ))
                        )}
                      </tbody>
                    </table>
                  </div>
                </div>
              ))}

              {previewSnapshotId !== null && (
                <div className="rounded-xl bg-white border border-slate-300 overflow-hidden shadow-sm">
                  <div className="flex items-center justify-between px-4 py-2.5 bg-slate-800 text-white text-xs">
                    <span className="font-semibold">帳票PDFプレビュー</span>
                    <div className="flex items-center gap-3">
                      <a
                        href={`/api/v1/snapshots/${encodeURIComponent(previewSnapshotId)}/pdf`}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="underline text-blue-200 hover:text-white"
                      >
                        別タブで開く
                      </a>
                      <button
                        type="button"
                        onClick={() => setPreviewSnapshotId(null)}
                        className="rounded bg-slate-700 hover:bg-slate-600 px-2 py-1 cursor-pointer"
                      >
                        閉じる
                      </button>
                    </div>
                  </div>
                  <iframe
                    title="帳票PDFプレビュー"
                    src={`/api/v1/snapshots/${encodeURIComponent(previewSnapshotId)}/pdf`}
                    className="w-full h-[760px] bg-slate-100"
                  />
                </div>
              )}
            </>
          )}
        </div>
      )}

      {/* 商品 / 入力候補ピッカーモーダル */}
      {pickerMode !== 'none' && (
        <div className="fixed inset-0 z-50 bg-slate-900/50 flex items-center justify-center p-4">
          <div className="bg-white rounded-xl max-w-3xl w-full max-h-[80vh] flex flex-col shadow-xl overflow-hidden">
            <div className="flex items-center justify-between px-5 py-3 border-b border-slate-200 bg-slate-50">
              <h3 className="text-sm font-bold text-slate-900">
                {pickerMode === 'product' ? '商品マスタから選択' : '入力候補マスタから選択'}
              </h3>
              <button
                type="button"
                onClick={() => setPickerMode('none')}
                className="text-xs text-slate-500 hover:text-slate-800 cursor-pointer"
              >
                閉じる ✕
              </button>
            </div>
            <div className="p-3 border-b border-slate-200">
              <input
                type="text"
                autoFocus
                value={pickerKeyword}
                onChange={(e) => setPickerKeyword(e.target.value)}
                placeholder="コードまたは名称で絞り込み..."
                className="w-full rounded-lg border border-slate-300 px-3 py-1.5 text-sm"
              />
            </div>
            <div className="overflow-y-auto flex-1 divide-y divide-slate-100 text-xs">
              {pickerMode === 'product'
                ? filteredProducts.map((p) => (
                    <button
                      key={p.id}
                      type="button"
                      onClick={() => applyProductToRow(p)}
                      className="w-full text-left px-4 py-2.5 hover:bg-blue-50 flex items-center justify-between gap-3 cursor-pointer"
                    >
                      <div>
                        <span className="font-mono text-slate-400 mr-2">{p.productCode}</span>
                        <span className="font-semibold text-slate-900">{p.productName}</span>
                      </div>
                      <div className="font-mono text-slate-700 shrink-0">
                        単価: ¥{p.standardUnitPrice.toLocaleString('ja-JP')} [{p.defaultTaxCode}]
                      </div>
                    </button>
                  ))
                : filteredIntelligences.map((i) => (
                    <button
                      key={i.id}
                      type="button"
                      onClick={() => applyIntelligenceToRow(i)}
                      className="w-full text-left px-4 py-2.5 hover:bg-indigo-50 flex items-center justify-between gap-3 cursor-pointer"
                    >
                      <span className="font-semibold text-slate-900">{i.itemName}</span>
                      <div className="font-mono text-slate-700 shrink-0">
                        単価: ¥{i.unitPrice.toLocaleString('ja-JP')} [{i.taxCode}]
                      </div>
                    </button>
                  ))}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
