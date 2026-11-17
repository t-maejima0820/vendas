'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useMemo, useState } from 'react';
import {
  calculateQuotationSlip,
  type CostCategory,
  type QuotationLineCalcInput,
  type RoundingMode,
  type TaxCalcPolicy,
  type TaxCode,
} from '@/lib/domain/calculations';
import {
  COST_CATEGORY_LABELS,
  QUOTATION_STATUS_LABELS,
  type AttachmentDto,
  type EstimateEditorLookupsDto,
  type EstimateIntelligenceOption,
  type EstimateProductOption,
  type QuotationDetailDto,
  type QuotationInput,
  type QuotationLineInput,
  type QuotationStatus,
  type QuotationTemplateVariant,
  type SnapshotHistoryItemDto,
} from '@/lib/estimates/types';
import { normalizeNullableText, requestMasterApi } from '@/lib/masters/client-api';

interface EstimateEditorClientProps {
  mode: 'create' | 'edit';
  lookups: EstimateEditorLookupsDto;
  initialDetail: QuotationDetailDto | null;
}

interface LineRowState {
  localKey: string;
  productId: string | null;
  itemCode: string;
  itemName: string;
  unitName: string;
  isHeading: boolean;
  quantity: string;
  taxCode: TaxCode;
  costCategory: '' | CostCategory;
  masterUnitPrice: number | null;
  appliedUnitPrice: string;
  masterCostPrice: number | null;
  appliedCostPrice: string;
  remarks: string;
}

type EditorTab = 'details' | 'attachments' | 'snapshots';

function createEmptyLine(indexKey: string, isHeading: boolean = false): LineRowState {
  return {
    localKey: indexKey,
    productId: null,
    itemCode: '',
    itemName: '',
    unitName: isHeading ? '' : '式',
    isHeading,
    quantity: isHeading ? '0' : '1',
    taxCode: 'A',
    costCategory: '',
    masterUnitPrice: null,
    appliedUnitPrice: '0',
    masterCostPrice: null,
    appliedCostPrice: '0',
    remarks: '',
  };
}

function detailLineToState(line: QuotationDetailDto['lines'][number], idx: number): LineRowState {
  return {
    localKey: `${line.id}-${idx}`,
    productId: line.productId,
    itemCode: line.itemCode !== null ? line.itemCode : '',
    itemName: line.itemName,
    unitName: line.unitName !== null ? line.unitName : '',
    isHeading: line.isHeading,
    quantity: String(line.quantity),
    taxCode: line.taxCode,
    costCategory: line.costCategory !== null ? line.costCategory : '',
    masterUnitPrice: line.masterUnitPrice,
    appliedUnitPrice: String(line.appliedUnitPrice),
    masterCostPrice: line.masterCostPrice,
    appliedCostPrice: String(line.appliedCostPrice),
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

export default function EstimateEditorClient({
  mode,
  lookups,
  initialDetail,
}: EstimateEditorClientProps) {
  const router = useRouter();
  const todayIso = new Date().toISOString().slice(0, 10);

  const [activeTab, setActiveTab] = useState<EditorTab>('details');
  const [lineSeq, setLineSeq] = useState(100);

  // ヘッダフォーム状態
  const [quotationName, setQuotationName] = useState(
    initialDetail !== null ? initialDetail.quotationName : '',
  );
  const [quotationDate, setQuotationDate] = useState(
    initialDetail !== null ? initialDetail.quotationDate : todayIso,
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
  const [validityPeriod, setValidityPeriod] = useState(
    initialDetail !== null && initialDetail.validityPeriod !== null
      ? initialDetail.validityPeriod
      : '発行日より1ヶ月',
  );
  const [deliveryDate, setDeliveryDate] = useState(
    initialDetail !== null && initialDetail.deliveryDate !== null ? initialDetail.deliveryDate : '',
  );
  const [status, setStatus] = useState<QuotationStatus>(
    initialDetail !== null ? initialDetail.status : 'Q1',
  );
  const [isAdvanceType, setIsAdvanceType] = useState(
    initialDetail !== null ? initialDetail.isAdvanceType : false,
  );
  const [isSelected, setIsSelected] = useState(
    initialDetail !== null ? initialDetail.isSelected : false,
  );
  const [roundingMode, setRoundingMode] = useState<RoundingMode>(
    initialDetail !== null ? initialDetail.roundingMode : lookups.defaultRoundingMode,
  );
  const [taxCalcPolicy, setTaxCalcPolicy] = useState<TaxCalcPolicy>(
    initialDetail !== null && initialDetail.taxCalcPolicy !== 'LEGACY_LINE_SUM'
      ? initialDetail.taxCalcPolicy
      : lookups.taxCalcPolicy,
  );
  const [remarks, setRemarks] = useState(
    initialDetail !== null && initialDetail.remarks !== null ? initialDetail.remarks : '',
  );

  // 明細行状態
  const [lines, setLines] = useState<LineRowState[]>(() => {
    if (initialDetail !== null && initialDetail.lines.length > 0) {
      return initialDetail.lines.map((l, idx) => detailLineToState(l, idx));
    }
    return [createEmptyLine('init-1', false)];
  });

  // 添付画像・スナップショット状態
  const [attachments, setAttachments] = useState<AttachmentDto[]>(
    initialDetail !== null ? initialDetail.attachments : [],
  );
  const [attachmentComments, setAttachmentComments] = useState<Record<string, string>>(() => {
    const map: Record<string, string> = {};
    if (initialDetail !== null) {
      for (const att of initialDetail.attachments) {
        map[att.id] = att.comment !== null ? att.comment : '';
      }
    }
    return map;
  });
  const [snapshots, setSnapshots] = useState<SnapshotHistoryItemDto[]>(
    initialDetail !== null ? initialDetail.snapshots : [],
  );

  // ピッカーモーダル状態（商品マスタ / 入力候補）
  const [pickerMode, setPickerMode] = useState<'none' | 'product' | 'intelligence'>('none');
  const [pickerTargetIndex, setPickerTargetIndex] = useState<number | null>(null);
  const [pickerKeyword, setPickerKeyword] = useState('');

  // スナップショット発行設定・プレビューモーダル
  const [templateVariant, setTemplateVariant] = useState<QuotationTemplateVariant>(
    lookups.quotationTemplateRows === 20 ? '20_ROWS' : '10_ROWS',
  );
  const [issueDate, setIssueDate] = useState(todayIso);
  const [previewSnapshotId, setPreviewSnapshotId] = useState<string | null>(null);

  // UI操作状態
  const [hasUnsavedChanges, setHasUnsavedChanges] = useState(false);
  const [saving, setSaving] = useState(false);
  const [issuing, setIssuing] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [dragOver, setDragOver] = useState(false);
  const [bannerError, setBannerError] = useState<string | null>(null);
  const [bannerSuccess, setBannerSuccess] = useState<string | null>(null);

  // リアルタイム計算（Rule G4: calculations.ts の純粋関数を直接呼び出し）
  const liveCalc = useMemo(() => {
    const calcInputs: QuotationLineCalcInput[] = lines.map((line, idx) => ({
      lineNo: idx + 1,
      isHeading: line.isHeading,
      quantity: line.isHeading ? '0' : parseQuantityForCalc(line.quantity),
      appliedUnitPrice: line.isHeading ? 0n : parseIntegerYenSafe(line.appliedUnitPrice),
      appliedCostPrice: line.isHeading ? 0n : parseIntegerYenSafe(line.appliedCostPrice),
      taxCode: line.taxCode,
    }));
    return calculateQuotationSlip(calcInputs, roundingMode, taxCalcPolicy);
  }, [lines, roundingMode, taxCalcPolicy]);

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
    setPartnerId(newPartnerId);
    setHasUnsavedChanges(true);
    const partner = lookups.partners.find((p) => p.id === newPartnerId);
    if (partner !== undefined) {
      setHonorific(partner.isIndividualHonorific ? '様' : '御中');
    }
  }

  function updateLineAt(index: number, patch: Partial<LineRowState>) {
    setHasUnsavedChanges(true);
    setLines((prev) =>
      prev.map((row, idx) => (idx === index ? { ...row, ...patch } : row)),
    );
  }

  function addLine(isHeading: boolean, insertAfterIndex?: number) {
    setHasUnsavedChanges(true);
    const fresh = createEmptyLine(nextLineKey(), isHeading);
    setLines((prev) => {
      if (insertAfterIndex === undefined) {
        return [...prev, fresh];
      }
      const next = [...prev];
      next.splice(insertAfterIndex + 1, 0, fresh);
      return next;
    });
  }

  function moveLine(index: number, dir: 'UP' | 'DOWN') {
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
    if (lines.length <= 1) {
      setBannerError('明細は最低1行必要です。');
      return;
    }
    setHasUnsavedChanges(true);
    setLines((prev) => prev.filter((_, idx) => idx !== index));
  }

  function applyProductToRow(prod: EstimateProductOption) {
    setHasUnsavedChanges(true);
    const rowData: LineRowState = {
      localKey:
        pickerTargetIndex !== null && lines[pickerTargetIndex] !== undefined
          ? lines[pickerTargetIndex].localKey
          : nextLineKey(),
      productId: prod.id,
      itemCode: prod.productCode,
      itemName: prod.productName,
      unitName: prod.unitName !== null ? prod.unitName : '',
      isHeading: prod.isHeading,
      quantity: prod.isHeading ? '0' : '1',
      taxCode: prod.defaultTaxCode,
      costCategory: '',
      masterUnitPrice: prod.standardUnitPrice,
      appliedUnitPrice: String(prod.standardUnitPrice),
      masterCostPrice: prod.standardCostPrice,
      appliedCostPrice: String(prod.standardCostPrice),
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
    setHasUnsavedChanges(true);
    const rowData: LineRowState = {
      localKey:
        pickerTargetIndex !== null && lines[pickerTargetIndex] !== undefined
          ? lines[pickerTargetIndex].localKey
          : nextLineKey(),
      productId: null,
      itemCode: '',
      itemName: intel.itemName,
      unitName: intel.unitName !== null ? intel.unitName : '',
      isHeading: false,
      quantity: '1',
      taxCode: intel.taxCode,
      costCategory: '',
      masterUnitPrice: intel.unitPrice,
      appliedUnitPrice: String(intel.unitPrice),
      masterCostPrice: intel.costPrice,
      appliedCostPrice: String(intel.costPrice),
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

  function buildPayload(): QuotationInput {
    const lineInputs: QuotationLineInput[] = lines.map((line) => ({
      productId: line.productId,
      itemCode: normalizeNullableText(line.itemCode),
      itemName: line.itemName.trim(),
      unitName: line.isHeading ? null : normalizeNullableText(line.unitName),
      isHeading: line.isHeading,
      quantity: line.isHeading ? 0 : Number(parseQuantityForCalc(line.quantity)),
      taxCode: line.taxCode,
      costCategory: line.isHeading || line.costCategory === '' ? null : line.costCategory,
      masterUnitPrice: line.masterUnitPrice,
      appliedUnitPrice: line.isHeading ? 0 : Number(parseIntegerYenSafe(line.appliedUnitPrice)),
      masterCostPrice: line.masterCostPrice,
      appliedCostPrice: line.isHeading ? 0 : Number(parseIntegerYenSafe(line.appliedCostPrice)),
      remarks: normalizeNullableText(line.remarks),
    }));

    return {
      quotationName: quotationName.trim(),
      quotationDate,
      partnerId,
      projectId: projectId.trim() !== '' ? projectId : null,
      honorific: honorific.trim(),
      validityPeriod: normalizeNullableText(validityPeriod),
      deliveryDate: normalizeNullableText(deliveryDate),
      status,
      isAdvanceType,
      isSelected,
      roundingMode,
      taxCalcPolicy,
      remarks: normalizeNullableText(remarks),
      lines: lineInputs,
    };
  }

  async function handleSave(e: React.FormEvent) {
    e.preventDefault();
    setBannerError(null);
    setBannerSuccess(null);

    if (partnerId === '') {
      setBannerError('取引先を選択してください。');
      return;
    }
    if (quotationName.trim() === '') {
      setBannerError('件名を入力してください。');
      return;
    }

    setSaving(true);
    const payload = buildPayload();
    const url =
      mode === 'create'
        ? '/api/v1/estimates'
        : `/api/v1/estimates/${encodeURIComponent(initialDetail !== null ? initialDetail.id : '')}`;
    const method = mode === 'create' ? 'POST' : 'PUT';

    const res = await requestMasterApi<{ item: QuotationDetailDto }>(url, {
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
      router.push(`/estimates/${res.data.item.id}`);
      router.refresh();
      return;
    }

    setLines(res.data.item.lines.map((l, idx) => detailLineToState(l, idx)));
    setSnapshots(res.data.item.snapshots);
    setAttachments(res.data.item.attachments);
    setBannerSuccess(`見積 #${res.data.item.quotationNo} を保存しました。`);
    router.refresh();
  }

  async function handleDuplicate() {
    if (initialDetail === null) return;
    setBannerError(null);
    setSaving(true);
    const res = await requestMasterApi<{ item: QuotationDetailDto }>(
      `/api/v1/estimates/${encodeURIComponent(initialDetail.id)}/duplicate`,
      { method: 'POST' },
    );
    setSaving(false);
    if (!res.ok) {
      setBannerError(res.error);
      return;
    }
    router.push(`/estimates/${res.data.item.id}`);
  }

  async function handleTransferToSales() {
    if (initialDetail === null) return;
    const targetLabel = initialDetail.isAdvanceType ? '立替金伝票' : '売上伝票';
    if (
      !window.confirm(
        `見積 #${initialDetail.quotationNo} の明細を引き継いで${targetLabel}を作成し、この見積を「注文確定 (Q2)」に更新しますか？`,
      )
    ) {
      return;
    }
    setBannerError(null);
    setSaving(true);
    const res = await requestMasterApi<{ item: { id: string } }>('/api/v1/sales/from-estimate', {
      method: 'POST',
      body: JSON.stringify({
        quotationId: initialDetail.id,
        entryType: initialDetail.isAdvanceType ? 'ADVANCE' : 'SALE',
        updateQuotationStatusToQ2: true,
      }),
    });
    setSaving(false);
    if (!res.ok) {
      setBannerError(res.error);
      return;
    }
    router.push(`/sales/${res.data.item.id}`);
  }

  async function handleDeleteQuotation() {
    if (initialDetail === null) return;
    if (!window.confirm(`見積 #${initialDetail.quotationNo} を削除しますか？`)) return;
    setBannerError(null);
    setSaving(true);
    const res = await requestMasterApi<{ ok: true }>(
      `/api/v1/estimates/${encodeURIComponent(initialDetail.id)}`,
      { method: 'DELETE' },
    );
    setSaving(false);
    if (!res.ok) {
      setBannerError(res.error);
      return;
    }
    router.push('/estimates');
    router.refresh();
  }

  async function handleIssueSnapshot(
    docType: 'ESTIMATE' | 'ESTIMATE_SUMMARY_COVER' | 'ESTIMATE_SUMMARY_DETAIL' = 'ESTIMATE',
  ) {
    if (initialDetail === null) return;
    setBannerError(null);
    setBannerSuccess(null);
    setIssuing(true);
    const res = await requestMasterApi<{ item: SnapshotHistoryItemDto }>(
      '/api/v1/snapshots',
      {
        method: 'POST',
        body: JSON.stringify({
          documentType: docType,
          sourceEntityId: initialDetail.id,
          templateVariant,
          issueDate,
        }),
      },
    );
    setIssuing(false);
    if (!res.ok) {
      setBannerError(res.error);
      return;
    }
    const created = res.data.item;
    setSnapshots((prev) => [created, ...prev]);
    const labelMap: Record<typeof docType, string> = {
      ESTIMATE: '見積書',
      ESTIMATE_SUMMARY_COVER: 'まとめ見積書（鑑）',
      ESTIMATE_SUMMARY_DETAIL: 'まとめ見積書（明細）',
    };
    setBannerSuccess(
      `${labelMap[docType]} 第${created.versionNo}版${created.reissueLabel !== null ? ` (${created.reissueLabel})` : ''} を発行・凍結保存しました。`,
    );
    setPreviewSnapshotId(created.id);
  }

  async function handleUploadFiles(fileList: FileList | null) {
    if (initialDetail === null || fileList === null || fileList.length === 0) return;
    setBannerError(null);
    setBannerSuccess(null);
    setUploading(true);

    let uploadedCount = 0;
    for (const file of Array.from(fileList)) {
      const formData = new FormData();
      formData.append('entityType', 'QUOTATION');
      formData.append('entityId', initialDetail.id);
      formData.append('comment', '');
      formData.append('file', file);

      const res = await fetch('/api/v1/attachments', {
        method: 'POST',
        body: formData,
      });
      const json = (await res.json()) as {
        ok?: boolean;
        error?: string;
        item?: AttachmentDto;
      };
      if (!res.ok || json.ok !== true || json.item === undefined) {
        setUploading(false);
        setBannerError(
          typeof json.error === 'string' && json.error.length > 0
            ? `${file.name}: ${json.error}`
            : `${file.name}: アップロードに失敗しました。`,
        );
        return;
      }
      const added = json.item;
      setAttachments((prev) => [...prev, added]);
      setAttachmentComments((prev) => ({
        ...prev,
        [added.id]: added.comment !== null ? added.comment : '',
      }));
      uploadedCount += 1;
    }
    setUploading(false);
    setBannerSuccess(`${uploadedCount}件の添付画像を登録しました。`);
  }

  async function reloadAttachmentsList() {
    if (initialDetail === null) return;
    const res = await requestMasterApi<{ items: AttachmentDto[] }>(
      `/api/v1/attachments?entityType=QUOTATION&entityId=${encodeURIComponent(initialDetail.id)}`,
    );
    if (!res.ok) {
      setBannerError(res.error);
      return;
    }
    setAttachments(res.data.items);
    const map: Record<string, string> = {};
    for (const att of res.data.items) {
      map[att.id] = att.comment !== null ? att.comment : '';
    }
    setAttachmentComments(map);
  }

  async function handleSaveAttachmentComment(attId: string) {
    setBannerError(null);
    const commentText = attachmentComments[attId] !== undefined ? attachmentComments[attId] : '';
    const res = await requestMasterApi<{ item: AttachmentDto }>(
      `/api/v1/attachments/${encodeURIComponent(attId)}`,
      {
        method: 'PATCH',
        body: JSON.stringify({ comment: normalizeNullableText(commentText) }),
      },
    );
    if (!res.ok) {
      setBannerError(res.error);
      return;
    }
    setAttachments((prev) => prev.map((a) => (a.id === attId ? res.data.item : a)));
    setBannerSuccess('画像コメントを保存しました。');
  }

  async function handleMoveAttachment(attId: string, moveDirection: 'UP' | 'DOWN') {
    setBannerError(null);
    const res = await requestMasterApi<{ item: AttachmentDto }>(
      `/api/v1/attachments/${encodeURIComponent(attId)}`,
      {
        method: 'PATCH',
        body: JSON.stringify({ moveDirection }),
      },
    );
    if (!res.ok) {
      setBannerError(res.error);
      return;
    }
    await reloadAttachmentsList();
  }

  async function handleDeleteAttachment(att: AttachmentDto) {
    if (!window.confirm(`添付画像「${att.originalName}」を削除しますか？`)) return;
    setBannerError(null);
    const res = await requestMasterApi<{ ok: true }>(
      `/api/v1/attachments/${encodeURIComponent(att.id)}`,
      { method: 'DELETE' },
    );
    if (!res.ok) {
      setBannerError(res.error);
      return;
    }
    await reloadAttachmentsList();
    setBannerSuccess(`添付画像「${att.originalName}」を削除しました。`);
  }

  return (
    <div className="max-w-7xl space-y-5">
      {/* ヘッダバー */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <div className="flex items-center gap-2 text-xs text-slate-500 mb-1">
            <Link href="/estimates" className="hover:text-blue-600 hover:underline">
              見積一覧
            </Link>
            <span>/</span>
            <span>{mode === 'create' ? '新規作成' : `見積 #${initialDetail?.quotationNo}`}</span>
          </div>
          <h1 className="text-2xl font-bold text-slate-900">
            {mode === 'create'
              ? '新規見積作成'
              : `見積編集 #${initialDetail?.quotationNo} — ${quotationName || initialDetail?.quotationName}`}
          </h1>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          {mode === 'edit' && initialDetail !== null && (
            <>
              <button
                type="button"
                disabled={saving || hasUnsavedChanges}
                title={hasUnsavedChanges ? '転記前に変更を保存してください' : undefined}
                onClick={() => void handleTransferToSales()}
                className="rounded-lg bg-emerald-600 hover:bg-emerald-700 disabled:opacity-50 px-3 py-2 text-xs font-semibold text-white cursor-pointer"
              >
                {initialDetail.isAdvanceType ? '立替伝票へ転記' : '売上伝票へ転記'}
              </button>
              <button
                type="button"
                disabled={saving}
                onClick={() => void handleDuplicate()}
                className="rounded-lg border border-slate-300 bg-white hover:bg-slate-50 px-3 py-2 text-xs font-medium text-slate-700 cursor-pointer"
              >
                複写して新規作成
              </button>
              {snapshots.length === 0 && (
                <button
                  type="button"
                  disabled={saving}
                  onClick={() => void handleDeleteQuotation()}
                  className="rounded-lg border border-red-200 bg-white hover:bg-red-50 px-3 py-2 text-xs font-medium text-red-700 cursor-pointer"
                >
                  削除
                </button>
              )}
            </>
          )}
          <Link
            href="/estimates"
            className="rounded-lg border border-slate-300 bg-white hover:bg-slate-50 px-3 py-2 text-xs font-medium text-slate-700"
          >
            一覧へ戻る
          </Link>
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

      {/* タブナビゲーション */}
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
          見積明細・基本情報（{lines.length}行）
        </button>

        {lookups.estimateImageEnabled && (
          <button
            type="button"
            onClick={() => setActiveTab('attachments')}
            className={`px-4 py-2.5 text-sm font-medium border-b-2 transition-colors cursor-pointer ${
              activeTab === 'attachments'
                ? 'border-blue-600 text-blue-700'
                : 'border-transparent text-slate-600 hover:text-slate-900'
            }`}
          >
            添付画像（{attachments.length}枚）
          </button>
        )}

        <button
          type="button"
          onClick={() => setActiveTab('snapshots')}
          className={`px-4 py-2.5 text-sm font-medium border-b-2 transition-colors cursor-pointer ${
            activeTab === 'snapshots'
              ? 'border-blue-600 text-blue-700'
              : 'border-transparent text-slate-600 hover:text-slate-900'
          }`}
        >
          帳票発行・版履歴（{snapshots.length}版）
        </button>
      </div>

      {/* タブ1: 見積ヘッダ＋明細エディタ */}
      {activeTab === 'details' && (
        <form onSubmit={handleSave} className="space-y-5">
          {/* ヘッダ入力 */}
          <div className="rounded-xl bg-white border border-slate-200 p-5 shadow-xs space-y-4">
            <h2 className="text-sm font-bold text-slate-800">見積ヘッダ情報</h2>
            <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
              <div>
                <label className="block text-xs font-medium text-slate-600 mb-1">
                  見積日 <span className="text-red-500">*</span>
                </label>
                <input
                  type="date"
                  required
                  value={quotationDate}
                  onChange={(e) => {
                    setQuotationDate(e.target.value);
                    setHasUnsavedChanges(true);
                  }}
                  className="w-full rounded-lg border border-slate-300 px-3 py-1.5 text-sm text-slate-900"
                />
              </div>

              <div className="md:col-span-2">
                <label className="block text-xs font-medium text-slate-600 mb-1">
                  取引先 <span className="text-red-500">*</span>
                </label>
                <select
                  required
                  value={partnerId}
                  onChange={(e) => handlePartnerChange(e.target.value)}
                  className="w-full rounded-lg border border-slate-300 px-3 py-1.5 text-sm text-slate-900 bg-white"
                >
                  <option value="">-- 取引先を選択 --</option>
                  {lookups.partners.map((p) => (
                    <option key={p.id} value={p.id}>
                      [{p.partnerCode}] {p.partnerName}
                      {p.isIndividualHonorific ? ' (個人敬称:様)' : ''}
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
                    value={honorific}
                    onChange={(e) => {
                      setHonorific(e.target.value);
                      setHasUnsavedChanges(true);
                    }}
                    className="w-full rounded-lg border border-slate-300 px-3 py-1.5 text-sm text-slate-900"
                  />
                  <button
                    type="button"
                    onClick={() => {
                      setHonorific('御中');
                      setHasUnsavedChanges(true);
                    }}
                    className="rounded border border-slate-300 px-2 py-1 text-xs text-slate-600 hover:bg-slate-50 cursor-pointer shrink-0"
                  >
                    御中
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      setHonorific('様');
                      setHasUnsavedChanges(true);
                    }}
                    className="rounded border border-slate-300 px-2 py-1 text-xs text-slate-600 hover:bg-slate-50 cursor-pointer shrink-0"
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
                  value={quotationName}
                  onChange={(e) => {
                    setQuotationName(e.target.value);
                    setHasUnsavedChanges(true);
                  }}
                  placeholder="例: 本社ビル空調改修工事"
                  className="w-full rounded-lg border border-slate-300 px-3 py-1.5 text-sm text-slate-900"
                />
              </div>

              <div className="md:col-span-2">
                <label className="block text-xs font-medium text-slate-600 mb-1">
                  紐付け案件（任意）
                </label>
                <select
                  value={projectId}
                  onChange={(e) => {
                    setProjectId(e.target.value);
                    setHasUnsavedChanges(true);
                  }}
                  className="w-full rounded-lg border border-slate-300 px-3 py-1.5 text-sm text-slate-900 bg-white"
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
                <select
                  value={status}
                  onChange={(e) => {
                    setStatus(e.target.value as QuotationStatus);
                    setHasUnsavedChanges(true);
                  }}
                  className="w-full rounded-lg border border-slate-300 px-3 py-1.5 text-sm text-slate-900 bg-white"
                >
                  <option value="Q1">Q1: {QUOTATION_STATUS_LABELS.Q1}</option>
                  <option value="Q2">Q2: {QUOTATION_STATUS_LABELS.Q2}</option>
                  <option value="Q3">Q3: {QUOTATION_STATUS_LABELS.Q3}</option>
                </select>
              </div>

              <div>
                <label className="block text-xs font-medium text-slate-600 mb-1">有効期限</label>
                <input
                  type="text"
                  value={validityPeriod}
                  onChange={(e) => {
                    setValidityPeriod(e.target.value);
                    setHasUnsavedChanges(true);
                  }}
                  className="w-full rounded-lg border border-slate-300 px-3 py-1.5 text-sm text-slate-900"
                />
              </div>

              <div>
                <label className="block text-xs font-medium text-slate-600 mb-1">納期</label>
                <input
                  type="text"
                  value={deliveryDate}
                  onChange={(e) => {
                    setDeliveryDate(e.target.value);
                    setHasUnsavedChanges(true);
                  }}
                  placeholder="例: 別途ご相談"
                  className="w-full rounded-lg border border-slate-300 px-3 py-1.5 text-sm text-slate-900"
                />
              </div>

              <div>
                <label className="block text-xs font-medium text-slate-600 mb-1">端数処理</label>
                <select
                  value={roundingMode}
                  onChange={(e) => {
                    setRoundingMode(e.target.value as RoundingMode);
                    setHasUnsavedChanges(true);
                  }}
                  className="w-full rounded-lg border border-slate-300 px-3 py-1.5 text-sm text-slate-900 bg-white"
                >
                  <option value="FLOOR">FLOOR（切捨）</option>
                  <option value="ROUND">ROUND（四捨五入）</option>
                  <option value="CEIL">CEIL（切上）</option>
                </select>
              </div>

              <div>
                <label className="block text-xs font-medium text-slate-600 mb-1">
                  消費税計算方式
                </label>
                <select
                  value={taxCalcPolicy}
                  onChange={(e) => {
                    setTaxCalcPolicy(e.target.value as TaxCalcPolicy);
                    setHasUnsavedChanges(true);
                  }}
                  className="w-full rounded-lg border border-slate-300 px-3 py-1.5 text-sm text-slate-900 bg-white"
                >
                  <option value="SLIP_BY_RATE">SLIP_BY_RATE（伝票税率別）</option>
                  <option value="INVOICE_BY_RATE">INVOICE_BY_RATE（請求時税率別）</option>
                </select>
              </div>

              <div className="flex items-end gap-5 pb-1.5 md:col-span-2">
                <label className="inline-flex items-center gap-2 text-sm text-slate-700 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={isSelected}
                    onChange={(e) => {
                      setIsSelected(e.target.checked);
                      setHasUnsavedChanges(true);
                    }}
                    className="rounded border-slate-300"
                  />
                  <span>案件採用フラグ (is_selected)</span>
                </label>
                <label className="inline-flex items-center gap-2 text-sm text-slate-700 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={isAdvanceType}
                    onChange={(e) => {
                      setIsAdvanceType(e.target.checked);
                      setHasUnsavedChanges(true);
                    }}
                    className="rounded border-slate-300"
                  />
                  <span>立替区分 (T)</span>
                </label>
              </div>

              <div className="md:col-span-4">
                <label className="block text-xs font-medium text-slate-600 mb-1">見積備考</label>
                <textarea
                  rows={2}
                  value={remarks}
                  onChange={(e) => {
                    setRemarks(e.target.value);
                    setHasUnsavedChanges(true);
                  }}
                  placeholder="見積書の下部備考欄に印字されます"
                  className="w-full rounded-lg border border-slate-300 px-3 py-1.5 text-sm text-slate-900"
                />
              </div>
            </div>
          </div>

          {/* 明細エディタ */}
          <div className="rounded-xl bg-white border border-slate-200 shadow-xs overflow-hidden">
            <div className="flex flex-wrap items-center justify-between gap-2 px-5 py-3 bg-slate-50 border-b border-slate-200">
              <div className="text-sm font-bold text-slate-800">
                明細エディタ（売価・原価同時積算 / 行数無制限）
              </div>
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
            </div>

            <datalist id="estimate-units-list">
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
                    <th className="px-2 py-2 text-left w-24">数量</th>
                    <th className="px-2 py-2 text-left w-20">単位</th>
                    <th className="px-2 py-2 text-left w-28">税区分</th>
                    <th className="px-2 py-2 text-left w-24">原価費目</th>
                    <th className="px-2 py-2 text-right w-32">適用売価単価</th>
                    <th className="px-2 py-2 text-right w-28">売価金額</th>
                    <th className="px-2 py-2 text-right w-32">適用原価単価</th>
                    <th className="px-2 py-2 text-right w-28">原価金額</th>
                    <th className="px-2 py-2 text-left min-w-32">明細備考</th>
                    <th className="px-2 py-2 text-center w-28">操作</th>
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
                            checked={row.isHeading}
                            onChange={(e) =>
                              updateLineAt(idx, {
                                isHeading: e.target.checked,
                                quantity: e.target.checked ? '0' : row.quantity === '0' ? '1' : row.quantity,
                              })
                            }
                            title="見出し行として表示"
                          />
                        </td>
                        <td className="px-2 py-2 space-y-1">
                          <div className="flex gap-1">
                            <input
                              type="text"
                              required
                              value={row.itemName}
                              onChange={(e) => updateLineAt(idx, { itemName: e.target.value })}
                              placeholder={row.isHeading ? '例: 1. 電気設備工事一式' : '品名・仕様'}
                              className={`w-full rounded border border-slate-300 px-2 py-1 text-xs ${
                                row.isHeading ? 'font-bold text-blue-900 bg-white' : 'text-slate-900'
                              }`}
                            />
                            <button
                              type="button"
                              onClick={() => {
                                setPickerTargetIndex(idx);
                                setPickerKeyword('');
                                setPickerMode('product');
                              }}
                              title="商品マスタから選択"
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
                              title="入力候補から選択"
                              className="rounded border border-slate-300 bg-white hover:bg-slate-100 px-1.5 py-1 text-[10px] text-slate-600 shrink-0 cursor-pointer"
                            >
                              候補
                            </button>
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
                            disabled={row.isHeading}
                            value={row.isHeading ? '' : row.quantity}
                            onChange={(e) => updateLineAt(idx, { quantity: e.target.value })}
                            className="w-full rounded border border-slate-300 px-2 py-1 text-right font-mono disabled:bg-slate-100"
                          />
                        </td>

                        <td className="px-2 py-2">
                          <input
                            type="text"
                            list="estimate-units-list"
                            disabled={row.isHeading}
                            value={row.isHeading ? '' : row.unitName}
                            onChange={(e) => updateLineAt(idx, { unitName: e.target.value })}
                            className="w-full rounded border border-slate-300 px-2 py-1 text-center disabled:bg-slate-100"
                          />
                        </td>

                        <td className="px-2 py-2">
                          <select
                            disabled={row.isHeading}
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
                          <select
                            disabled={row.isHeading}
                            value={row.costCategory}
                            onChange={(e) =>
                              updateLineAt(idx, { costCategory: e.target.value as '' | CostCategory })
                            }
                            className="w-full rounded border border-slate-300 px-1.5 py-1 bg-white disabled:bg-slate-100"
                          >
                            <option value="">（未指定）</option>
                            {(Object.keys(COST_CATEGORY_LABELS) as CostCategory[]).map((cat) => (
                              <option key={cat} value={cat}>
                                {COST_CATEGORY_LABELS[cat]}
                              </option>
                            ))}
                          </select>
                        </td>

                        <td className="px-2 py-2">
                          <input
                            type="text"
                            disabled={row.isHeading}
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

                        <td className="px-2 py-2 text-right font-mono font-semibold text-slate-900">
                          {row.isHeading || lr === undefined ? '-' : formatYenBigInt(lr.lineAmount)}
                        </td>

                        <td className="px-2 py-2">
                          <input
                            type="text"
                            disabled={row.isHeading}
                            value={row.isHeading ? '' : row.appliedCostPrice}
                            onChange={(e) => updateLineAt(idx, { appliedCostPrice: e.target.value })}
                            className="w-full rounded border border-slate-300 px-2 py-1 text-right font-mono disabled:bg-slate-100"
                          />
                          {row.masterCostPrice !== null && !row.isHeading && (
                            <div className="text-[10px] text-slate-400 text-right font-mono">
                              基準: ¥{row.masterCostPrice.toLocaleString('ja-JP')}
                            </div>
                          )}
                        </td>

                        <td className="px-2 py-2 text-right font-mono text-slate-700">
                          {row.isHeading || lr === undefined ? '-' : formatYenBigInt(lr.costAmount)}
                        </td>

                        <td className="px-2 py-2">
                          <input
                            type="text"
                            value={row.remarks}
                            onChange={(e) => updateLineAt(idx, { remarks: e.target.value })}
                            className="w-full rounded border border-slate-300 px-2 py-1"
                          />
                        </td>

                        <td className="px-2 py-2 text-center whitespace-nowrap">
                          <div className="inline-flex items-center gap-1">
                            <button
                              type="button"
                              disabled={idx === 0}
                              onClick={() => moveLine(idx, 'UP')}
                              title="上へ移動"
                              className="rounded border border-slate-300 px-1.5 py-0.5 text-[11px] disabled:opacity-30 cursor-pointer"
                            >
                              ↑
                            </button>
                            <button
                              type="button"
                              disabled={idx === lines.length - 1}
                              onClick={() => moveLine(idx, 'DOWN')}
                              title="下へ移動"
                              className="rounded border border-slate-300 px-1.5 py-0.5 text-[11px] disabled:opacity-30 cursor-pointer"
                            >
                              ↓
                            </button>
                            <button
                              type="button"
                              onClick={() => addLine(false, idx)}
                              title="この行の下に新規行を挿入"
                              className="rounded border border-slate-300 px-1.5 py-0.5 text-[11px] text-blue-700 cursor-pointer"
                            >
                              ＋
                            </button>
                            <button
                              type="button"
                              onClick={() => removeLine(idx)}
                              title="行を削除"
                              className="rounded border border-red-200 px-1.5 py-0.5 text-[11px] text-red-600 cursor-pointer"
                            >
                              ×
                            </button>
                          </div>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </div>

          {/* リアルタイム積算集計フッター */}
          <div className="rounded-xl bg-slate-900 text-white p-5 shadow-sm flex flex-wrap items-center justify-between gap-4">
            <div className="grid grid-cols-2 md:grid-cols-6 gap-5 flex-1">
              <div>
                <div className="text-[11px] text-slate-400">売価税抜小計</div>
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
                <div className="text-[11px] text-blue-300">税込御見積合計</div>
                <div className="text-xl font-bold font-mono text-blue-200 mt-0.5">
                  {formatYenBigInt(liveCalc.totalAmount)}
                </div>
              </div>
              <div>
                <div className="text-[11px] text-slate-400">予定原価（税抜）</div>
                <div className="text-base font-bold font-mono mt-0.5">
                  {formatYenBigInt(liveCalc.costSubtotal)}
                </div>
              </div>
              <div>
                <div className="text-[11px] text-emerald-300">予定粗利額（税抜）</div>
                <div className="text-base font-bold font-mono text-emerald-300 mt-0.5">
                  {formatYenBigInt(liveCalc.grossProfitExcl)}
                </div>
              </div>
              <div>
                <div className="text-[11px] text-emerald-300">予定粗利率</div>
                <div className="text-base font-bold font-mono text-emerald-300 mt-0.5">
                  {liveCalc.grossMarginExclPercent}%
                </div>
              </div>
            </div>

            <div className="flex items-center gap-3 shrink-0">
              <button
                type="submit"
                disabled={saving}
                className="rounded-lg bg-blue-500 hover:bg-blue-400 px-6 py-2.5 text-sm font-bold text-white transition-colors cursor-pointer"
              >
                {saving ? '保存中...' : mode === 'create' ? '見積を登録する' : '変更を保存する'}
              </button>
            </div>
          </div>
        </form>
      )}

      {/* タブ2: 添付画像（estimateimage 有効時のみ表示） */}
      {activeTab === 'attachments' && lookups.estimateImageEnabled && (
        <div className="rounded-xl bg-white border border-slate-200 p-5 shadow-xs space-y-4">
          {mode === 'create' || initialDetail === null ? (
            <div className="rounded-lg border border-amber-200 bg-amber-50 p-4 text-sm text-amber-800">
              添付画像を登録するには、まず「見積明細・基本情報」タブで必須項目を入力して見積を登録してください。
            </div>
          ) : (
            <>
              <div
                onDragOver={(e) => {
                  e.preventDefault();
                  setDragOver(true);
                }}
                onDragLeave={() => setDragOver(false)}
                onDrop={(e) => {
                  e.preventDefault();
                  setDragOver(false);
                  void handleUploadFiles(e.dataTransfer.files);
                }}
                className={`rounded-xl border-2 border-dashed p-6 text-center transition-colors ${
                  dragOver ? 'border-blue-500 bg-blue-50' : 'border-slate-300 bg-slate-50'
                }`}
              >
                <p className="text-sm font-medium text-slate-700">
                  現場写真・参考図面をここにドラッグ＆ドロップ、またはファイルを選択
                </p>
                <p className="text-xs text-slate-500 mt-1">
                  対応形式: JPEG / PNG / WebP のみ（1ファイル上限 5MB・マジックバイト検証実施 / 枚数無制限）
                </p>
                <label className="mt-3 inline-block rounded-lg bg-slate-800 hover:bg-slate-700 px-4 py-2 text-xs font-semibold text-white cursor-pointer">
                  {uploading ? 'アップロード中...' : '画像ファイルを選択'}
                  <input
                    type="file"
                    accept="image/jpeg,image/png,image/webp"
                    multiple
                    disabled={uploading}
                    onChange={(e) => {
                      void handleUploadFiles(e.target.files);
                      e.target.value = '';
                    }}
                    className="hidden"
                  />
                </label>
              </div>

              {attachments.length === 0 ? (
                <p className="text-sm text-slate-500 text-center py-6">
                  登録されている添付画像はありません。
                </p>
              ) : (
                <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                  {attachments.map((att, idx) => (
                    <div
                      key={att.id}
                      className="rounded-xl border border-slate-200 p-3 flex gap-3 bg-white"
                    >
                      <div className="w-32 h-28 rounded-lg bg-slate-100 border border-slate-200 overflow-hidden shrink-0 flex items-center justify-center">
                        <img
                          src={att.signedUrl}
                          alt={att.originalName}
                          className="w-full h-full object-cover"
                        />
                      </div>
                      <div className="flex-1 min-w-0 space-y-2">
                        <div className="flex items-center justify-between gap-2">
                          <span className="text-xs font-bold text-slate-800 truncate">
                            #{att.sortOrder} {att.originalName}
                          </span>
                          <span className="text-[11px] font-mono text-slate-400 shrink-0">
                            {att.mimeType}
                          </span>
                        </div>
                        <div className="flex gap-1.5">
                          <input
                            type="text"
                            value={attachmentComments[att.id] !== undefined ? attachmentComments[att.id] : ''}
                            onChange={(e) =>
                              setAttachmentComments((prev) => ({
                                ...prev,
                                [att.id]: e.target.value,
                              }))
                            }
                            placeholder="見積書に印字するコメント"
                            className="w-full rounded border border-slate-300 px-2 py-1 text-xs"
                          />
                          <button
                            type="button"
                            onClick={() => void handleSaveAttachmentComment(att.id)}
                            className="rounded border border-slate-300 bg-white hover:bg-slate-50 px-2 py-1 text-xs font-medium text-slate-700 shrink-0 cursor-pointer"
                          >
                            保存
                          </button>
                        </div>
                        <div className="flex items-center justify-between pt-1">
                          <div className="flex items-center gap-1">
                            <button
                              type="button"
                              disabled={idx === 0}
                              onClick={() => void handleMoveAttachment(att.id, 'UP')}
                              className="rounded border border-slate-300 px-2 py-0.5 text-xs disabled:opacity-30 cursor-pointer"
                            >
                              ↑ 前へ
                            </button>
                            <button
                              type="button"
                              disabled={idx === attachments.length - 1}
                              onClick={() => void handleMoveAttachment(att.id, 'DOWN')}
                              className="rounded border border-slate-300 px-2 py-0.5 text-xs disabled:opacity-30 cursor-pointer"
                            >
                              ↓ 後へ
                            </button>
                          </div>
                          <button
                            type="button"
                            onClick={() => void handleDeleteAttachment(att)}
                            className="rounded border border-red-200 bg-white hover:bg-red-50 px-2 py-0.5 text-xs text-red-700 cursor-pointer"
                          >
                            削除
                          </button>
                        </div>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </>
          )}
        </div>
      )}

      {/* タブ3: 帳票発行・版履歴（イミュータブルスナップショット） */}
      {activeTab === 'snapshots' && (
        <div className="space-y-5">
          {mode === 'create' || initialDetail === null ? (
            <div className="rounded-xl border border-amber-200 bg-amber-50 p-4 text-sm text-amber-800">
              見積書を発行するには、先に見積データを保存してください。
            </div>
          ) : (
            <>
              <div className="rounded-xl bg-white border border-slate-200 p-5 shadow-xs space-y-4">
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <div>
                    <h2 className="text-sm font-bold text-slate-800">
                      見積書の発行（イミュータブルスナップショット確定）
                    </h2>
                    <p className="text-xs text-slate-500 mt-0.5">
                      発行時点の自社情報（T番号・暗号化口座）・取引先情報・明細・添付画像コメントを凍結保存し、以降の履歴から100%同一PDFを再出力できます。
                    </p>
                  </div>
                </div>

                {hasUnsavedChanges && (
                  <div className="rounded-lg border border-amber-300 bg-amber-50 px-3 py-2 text-xs text-amber-900">
                    画面上の入力内容に未保存の変更があります。最新内容を反映して見積書を発行する場合は、先に「見積明細・基本情報」タブで保存してください。
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
                    disabled={issuing}
                    onClick={() => void handleIssueSnapshot('ESTIMATE')}
                    className="rounded-lg bg-indigo-600 hover:bg-indigo-700 px-4 py-2 text-sm font-semibold text-white transition-colors cursor-pointer"
                  >
                    {issuing
                      ? '発行中...'
                      : snapshots.filter((s) => s.documentType === 'ESTIMATE').length === 0
                        ? '見積書を発行（第1版）'
                        : `見積書を再発行（第${snapshots.filter((s) => s.documentType === 'ESTIMATE')[0]!.versionNo + 1}版）`}
                  </button>
                  <button
                    type="button"
                    disabled={issuing}
                    onClick={() => void handleIssueSnapshot('ESTIMATE_SUMMARY_COVER')}
                    className="rounded-lg border border-indigo-300 bg-indigo-50 hover:bg-indigo-100 px-3.5 py-2 text-sm font-semibold text-indigo-800 transition-colors cursor-pointer"
                  >
                    まとめ見積(鑑)
                  </button>
                  <button
                    type="button"
                    disabled={issuing}
                    onClick={() => void handleIssueSnapshot('ESTIMATE_SUMMARY_DETAIL')}
                    className="rounded-lg border border-slate-300 bg-white hover:bg-slate-50 px-3.5 py-2 text-sm font-semibold text-slate-700 transition-colors cursor-pointer"
                  >
                    まとめ見積(明細)
                  </button>
                </div>
              </div>

              {/* 発行履歴一覧 */}
              <div className="rounded-xl bg-white border border-slate-200 shadow-xs overflow-hidden">
                <div className="px-5 py-3 bg-slate-50 border-b border-slate-200 text-sm font-bold text-slate-800">
                  発行済みスナップショット版履歴
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
                        <th className="px-4 py-2 text-left">SHA-256（改ざん検証）</th>
                        <th className="px-4 py-2 text-right">PDF操作</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-slate-100">
                      {snapshots.length === 0 ? (
                        <tr>
                          <td colSpan={7} className="px-4 py-6 text-center text-sm text-slate-500">
                            まだ見積書が発行されていません。
                          </td>
                        </tr>
                      ) : (
                        snapshots.map((snap) => (
                          <tr key={snap.id} className="hover:bg-slate-50">
                            <td className="px-4 py-2.5 text-center font-mono font-bold text-slate-900">
                              <div>v{snap.versionNo}</div>
                              <div className="text-[10px] font-normal text-slate-500">
                                {snap.documentType === 'ESTIMATE_SUMMARY_COVER'
                                  ? 'まとめ(鑑)'
                                  : snap.documentType === 'ESTIMATE_SUMMARY_DETAIL'
                                    ? 'まとめ(明細)'
                                    : '通常見積'}
                              </div>
                            </td>
                            <td className="px-4 py-2.5 text-center">
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
                            <td className="px-4 py-2.5 text-center font-mono text-xs text-slate-600">
                              {snap.templateVariant}
                            </td>
                            <td className="px-4 py-2.5 text-xs font-mono text-slate-700">
                              {snap.issuedAt.slice(0, 19).replace('T', ' ')}
                            </td>
                            <td className="px-4 py-2.5 text-xs text-slate-700">
                              {snap.issuedByName !== null ? snap.issuedByName : '-'}
                            </td>
                            <td
                              className="px-4 py-2.5 font-mono text-[11px] text-slate-500"
                              title={snap.payloadSha256}
                            >
                              {snap.payloadSha256.slice(0, 16)}…
                            </td>
                            <td className="px-4 py-2.5 text-right whitespace-nowrap space-x-2">
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

              {/* PDFプレビュー領域 */}
              {previewSnapshotId !== null && (
                <div className="rounded-xl bg-white border border-slate-300 overflow-hidden shadow-sm">
                  <div className="flex items-center justify-between px-4 py-2.5 bg-slate-800 text-white text-xs">
                    <span className="font-semibold">見積書PDFプレビュー</span>
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
                    title="見積書PDFプレビュー"
                    src={`/api/v1/snapshots/${encodeURIComponent(previewSnapshotId)}/pdf`}
                    className="w-full h-[760px] bg-slate-100"
                  />
                </div>
              )}
            </>
          )}
        </div>
      )}

      {/* 商品マスタ / 入力候補検索モーダル */}
      {pickerMode !== 'none' && (
        <div className="fixed inset-0 z-50 bg-slate-900/50 flex items-center justify-center p-4">
          <div className="bg-white rounded-xl max-w-3xl w-full max-h-[80vh] flex flex-col shadow-xl overflow-hidden">
            <div className="flex items-center justify-between px-5 py-3 border-b border-slate-200 bg-slate-50">
              <h3 className="text-sm font-bold text-slate-900">
                {pickerMode === 'product'
                  ? '商品マスタから選択（基準単価を保持し適用単価へコピー）'
                  : '入力候補マスタから選択'}
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
                        {p.unitName !== null && (
                          <span className="ml-2 text-slate-500">({p.unitName})</span>
                        )}
                      </div>
                      <div className="font-mono text-right text-slate-700 shrink-0">
                        売価: ¥{p.standardUnitPrice.toLocaleString('ja-JP')} / 原価: ¥
                        {p.standardCostPrice.toLocaleString('ja-JP')} [{p.defaultTaxCode}]
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
                      <div>
                        <span className="font-semibold text-slate-900">{i.itemName}</span>
                        {i.unitName !== null && (
                          <span className="ml-2 text-slate-500">({i.unitName})</span>
                        )}
                      </div>
                      <div className="font-mono text-right text-slate-700 shrink-0">
                        売価: ¥{i.unitPrice.toLocaleString('ja-JP')} / 原価: ¥
                        {i.costPrice.toLocaleString('ja-JP')} [{i.taxCode}]
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
