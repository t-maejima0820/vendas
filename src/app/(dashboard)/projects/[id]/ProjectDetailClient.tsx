'use client';

import Decimal from 'decimal.js';
import Link from 'next/link';
import { useMemo, useState } from 'react';
import {
  calculateLineAmounts,
  calculateProjectProfit,
  type CostCategory,
  type RoundingMode,
  type TaxCode,
} from '@/lib/domain/calculations';
import { COST_CATEGORY_LABELS, type AttachmentDto } from '@/lib/estimates/types';
import { normalizeNullableText, requestMasterApi } from '@/lib/masters/client-api';
import type { CandidatePurchaseForCostDto, ProjectCostDetailDto } from '@/lib/project-costs/types';
import {
  COST_CATEGORY_LIST,
  PROJECT_STATUS_LABELS,
  type ProjectDetailDto,
  type ProjectInput,
  type ProjectStatus,
  type ProjectsLookupsDto,
} from '@/lib/projects/types';

interface ProjectDetailClientProps {
  todayIso: string;
  lookups: ProjectsLookupsDto;
  initialDetail: ProjectDetailDto;
  initialCandidates: CandidatePurchaseForCostDto[];
}

type DetailTab = 'LEDGER' | 'EDIT' | 'RELATIONS' | 'ATTACHMENTS';

interface EditFormState {
  projectName: string;
  projectDate: string;
  sitePlace: string;
  partnerId: string;
  orderKindCode: string;
  subStatusCode: string;
  status: ProjectStatus;
  periodStartDate: string;
  periodEndDate: string;
  actualStartDate: string;
  tempFinishDate: string;
  finishDate: string;
  salesEmployeeId: string;
  siteEmployeeId: string;
  unitName: string;
  contractUnitPriceStr: string;
  contractQuantityStr: string;
  taxCode: TaxCode;
  roundingMode: RoundingMode;
  budgets: Record<CostCategory, string>;
  remarks: string;
}

function formatYen(amount: number): string {
  return `¥${amount.toLocaleString('ja-JP')}`;
}

function parseIntOrZero(raw: string): number {
  const cleaned = raw.trim().replace(/,/g, '');
  if (cleaned === '') return 0;
  const num = Number(cleaned);
  return Number.isFinite(num) && Number.isInteger(num) ? num : 0;
}

function parseQtyForCalc(raw: string): string {
  const cleaned = raw.trim().replace(/,/g, '');
  if (cleaned === '') return '1';
  try {
    const dec = new Decimal(cleaned);
    if (!dec.isFinite()) return '1';
    return dec.toDecimalPlaces(4, Decimal.ROUND_HALF_UP).toString();
  } catch {
    return '1';
  }
}

function computeProgressWidth(ratePercent: string): string {
  try {
    const dec = new Decimal(ratePercent);
    if (!dec.isFinite() || dec.lte(0)) return '0%';
    if (dec.gte(100)) return '100%';
    return `${dec.toDecimalPlaces(1, Decimal.ROUND_HALF_UP).toFixed(1)}%`;
  } catch {
    return '0%';
  }
}

function buildEditFormState(detail: ProjectDetailDto): EditFormState {
  return {
    projectName: detail.projectName,
    projectDate: detail.projectDate,
    sitePlace: detail.sitePlace !== null ? detail.sitePlace : '',
    partnerId: detail.partnerId,
    orderKindCode: detail.orderKindCode !== null ? detail.orderKindCode : '',
    subStatusCode: detail.subStatusCode !== null ? detail.subStatusCode : '',
    status: detail.status,
    periodStartDate: detail.periodStartDate !== null ? detail.periodStartDate : '',
    periodEndDate: detail.periodEndDate !== null ? detail.periodEndDate : '',
    actualStartDate: detail.actualStartDate !== null ? detail.actualStartDate : '',
    tempFinishDate: detail.tempFinishDate !== null ? detail.tempFinishDate : '',
    finishDate: detail.finishDate !== null ? detail.finishDate : '',
    salesEmployeeId: detail.salesEmployeeId !== null ? detail.salesEmployeeId : '',
    siteEmployeeId: detail.siteEmployeeId !== null ? detail.siteEmployeeId : '',
    unitName: detail.unitName,
    contractUnitPriceStr: String(detail.contractUnitPrice),
    contractQuantityStr: String(detail.contractQuantity),
    taxCode: detail.taxCode,
    roundingMode: detail.roundingMode,
    budgets: {
      EXPENSE: String(detail.budgets.EXPENSE),
      LABOR: String(detail.budgets.LABOR),
      MATERIAL: String(detail.budgets.MATERIAL),
      OUTSOURCING: String(detail.budgets.OUTSOURCING),
      TEMPORARY: String(detail.budgets.TEMPORARY),
      INDIRECT: String(detail.budgets.INDIRECT),
    },
    remarks: detail.remarks !== null ? detail.remarks : '',
  };
}

export default function ProjectDetailClient({
  todayIso,
  lookups,
  initialDetail,
  initialCandidates,
}: ProjectDetailClientProps) {
  const [detail, setDetail] = useState<ProjectDetailDto>(initialDetail);
  const [candidates, setCandidates] = useState<CandidatePurchaseForCostDto[]>(initialCandidates);
  const [activeTab, setActiveTab] = useState<DetailTab>('LEDGER');
  const [message, setMessage] = useState<{ type: 'success' | 'error'; text: string } | null>(null);

  const [editForm, setEditForm] = useState<EditFormState>(() => buildEditFormState(initialDetail));
  const [saving, setSaving] = useState(false);

  // Import budget from quotation
  const [selectedQuotationId, setSelectedQuotationId] = useState<string>(() => {
    const picked = initialDetail.relatedQuotations.find((q) => q.isSelected);
    if (picked !== undefined) return picked.id;
    return initialDetail.relatedQuotations.length > 0 ? initialDetail.relatedQuotations[0]!.id : '';
  });
  const [updateContractAmount, setUpdateContractAmount] = useState(true);
  const [importingBudget, setImportingBudget] = useState(false);

  // Import cost from purchase modal
  const [purchaseModalOpen, setPurchaseModalOpen] = useState(false);
  const [importPurchaseId, setImportPurchaseId] = useState<string>(
    initialCandidates.length > 0 ? initialCandidates[0]!.purchaseId : '',
  );
  const [importCostCategory, setImportCostCategory] = useState<CostCategory>('MATERIAL');
  const [importSlipTitle, setImportSlipTitle] = useState('');
  const [importEntryDate, setImportEntryDate] = useState(todayIso);
  const [importingPurchase, setImportingPurchase] = useState(false);

  // Attachments
  const [uploadFile, setUploadFile] = useState<File | null>(null);
  const [uploadComment, setUploadComment] = useState('');
  const [uploadingAttachment, setUploadingAttachment] = useState(false);
  const [editingComments, setEditingComments] = useState<Record<string, string>>(() => {
    const map: Record<string, string> = {};
    for (const att of initialDetail.attachments) {
      map[att.id] = att.comment !== null ? att.comment : '';
    }
    return map;
  });

  const editPreview = useMemo(() => {
    const unitPriceBig = BigInt(parseIntOrZero(editForm.contractUnitPriceStr));
    const qtyStr = parseQtyForCalc(editForm.contractQuantityStr);
    const lineCalc = calculateLineAmounts({
      lineNo: 1,
      quantity: qtyStr,
      unitPrice: unitPriceBig,
      taxCode: editForm.taxCode,
      roundingMode: editForm.roundingMode,
    });

    const budgetBigInts: Record<CostCategory, bigint> = {
      EXPENSE: BigInt(parseIntOrZero(editForm.budgets.EXPENSE)),
      LABOR: BigInt(parseIntOrZero(editForm.budgets.LABOR)),
      MATERIAL: BigInt(parseIntOrZero(editForm.budgets.MATERIAL)),
      OUTSOURCING: BigInt(parseIntOrZero(editForm.budgets.OUTSOURCING)),
      TEMPORARY: BigInt(parseIntOrZero(editForm.budgets.TEMPORARY)),
      INDIRECT: BigInt(parseIntOrZero(editForm.budgets.INDIRECT)),
    };

    const actualExcl: Record<CostCategory, bigint> = {
      EXPENSE: 0n,
      LABOR: 0n,
      MATERIAL: 0n,
      OUTSOURCING: 0n,
      TEMPORARY: 0n,
      INDIRECT: 0n,
    };
    const actualIncl: Record<CostCategory, bigint> = {
      EXPENSE: 0n,
      LABOR: 0n,
      MATERIAL: 0n,
      OUTSOURCING: 0n,
      TEMPORARY: 0n,
      INDIRECT: 0n,
    };
    for (const comp of detail.categoryComparisons) {
      actualExcl[comp.category] = BigInt(comp.actualExclAmount);
      actualIncl[comp.category] = BigInt(comp.actualInclAmount);
    }

    const profit = calculateProjectProfit({
      costTaxMode: detail.costTaxMode,
      contractSubtotal: lineCalc.exclAmount,
      contractTotal: lineCalc.rowTotal,
      budgets: budgetBigInts,
      actualCostsExcl: actualExcl,
      actualCostsIncl: actualIncl,
    });

    return {
      contractSubtotal: Number(lineCalc.exclAmount),
      contractTax: Number(lineCalc.lineTax),
      contractTotal: Number(lineCalc.rowTotal),
      budgetTotal: Number(profit.budgetTotal),
      budgetGrossProfit: Number(profit.budgetGrossProfit),
      actualGrossProfit: Number(profit.actualGrossProfit),
      actualGrossMarginPercent: profit.actualGrossMarginPercent,
    };
  }, [editForm, detail.costTaxMode, detail.categoryComparisons]);

  function syncDetailState(nextDetail: ProjectDetailDto) {
    setDetail(nextDetail);
    setEditForm(buildEditFormState(nextDetail));
    const map: Record<string, string> = {};
    for (const att of nextDetail.attachments) {
      map[att.id] = att.comment !== null ? att.comment : '';
    }
    setEditingComments(map);
  }

  async function refreshProjectDetail() {
    const res = await requestMasterApi<{ ok: true; item: ProjectDetailDto }>(
      `/api/v1/projects/${detail.id}`,
    );
    if (res.ok) {
      syncDetailState(res.data.item);
    }
    if (lookups.costEnabled) {
      const candRes = await requestMasterApi<{
        ok: true;
        items: CandidatePurchaseForCostDto[];
      }>(`/api/v1/project-costs/from-purchase?projectId=${encodeURIComponent(detail.id)}`);
      if (candRes.ok) {
        setCandidates(candRes.data.items);
      }
    }
  }

  async function handleSaveProject(e: React.FormEvent) {
    e.preventDefault();
    setSaving(true);
    setMessage(null);

    const qtyNum = Number(parseQtyForCalc(editForm.contractQuantityStr));
    const payload: ProjectInput = {
      projectNo: detail.projectNo,
      projectName: editForm.projectName.trim(),
      projectDate: editForm.projectDate,
      sitePlace: normalizeNullableText(editForm.sitePlace),
      partnerId: editForm.partnerId,
      orderKindCode: normalizeNullableText(editForm.orderKindCode),
      subStatusCode: normalizeNullableText(editForm.subStatusCode),
      status: editForm.status,
      periodStartDate: normalizeNullableText(editForm.periodStartDate),
      periodEndDate: normalizeNullableText(editForm.periodEndDate),
      actualStartDate: normalizeNullableText(editForm.actualStartDate),
      tempFinishDate: normalizeNullableText(editForm.tempFinishDate),
      finishDate: normalizeNullableText(editForm.finishDate),
      salesEmployeeId: normalizeNullableText(editForm.salesEmployeeId),
      siteEmployeeId: normalizeNullableText(editForm.siteEmployeeId),
      unitName: editForm.unitName.trim() === '' ? '式' : editForm.unitName.trim(),
      contractUnitPrice: parseIntOrZero(editForm.contractUnitPriceStr),
      contractQuantity: Number.isFinite(qtyNum) && qtyNum > 0 ? qtyNum : 1,
      taxCode: editForm.taxCode,
      roundingMode: editForm.roundingMode,
      budgets: {
        EXPENSE: parseIntOrZero(editForm.budgets.EXPENSE),
        LABOR: parseIntOrZero(editForm.budgets.LABOR),
        MATERIAL: parseIntOrZero(editForm.budgets.MATERIAL),
        OUTSOURCING: parseIntOrZero(editForm.budgets.OUTSOURCING),
        TEMPORARY: parseIntOrZero(editForm.budgets.TEMPORARY),
        INDIRECT: parseIntOrZero(editForm.budgets.INDIRECT),
      },
      remarks: normalizeNullableText(editForm.remarks),
    };

    const res = await requestMasterApi<{ ok: true; item: ProjectDetailDto }>(
      `/api/v1/projects/${detail.id}`,
      {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      },
    );
    setSaving(false);

    if (!res.ok) {
      setMessage({ type: 'error', text: res.error });
      return;
    }

    syncDetailState(res.data.item);
    setMessage({ type: 'success', text: '案件情報・実行予算を更新しました。' });
  }

  async function handleImportBudgetFromQuotation() {
    setImportingBudget(true);
    setMessage(null);
    const res = await requestMasterApi<{ ok: true; item: ProjectDetailDto }>(
      `/api/v1/projects/${detail.id}/import-budget`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          quotationId: selectedQuotationId === '' ? null : selectedQuotationId,
          updateContractAmount,
        }),
      },
    );
    setImportingBudget(false);
    if (!res.ok) {
      setMessage({ type: 'error', text: res.error });
      return;
    }

    syncDetailState(res.data.item);
    setMessage({
      type: 'success',
      text: '見積書から実行予算6費目（および契約金額）を取り込みました。',
    });
  }

  async function handleImportCostFromPurchase(e: React.FormEvent) {
    e.preventDefault();
    if (importPurchaseId === '') return;
    setImportingPurchase(true);
    setMessage(null);

    const res = await requestMasterApi<{ ok: true; item: ProjectCostDetailDto }>(
      '/api/v1/project-costs/from-purchase',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          projectId: detail.id,
          purchaseId: importPurchaseId,
          costCategory: importCostCategory,
          slipTitle: normalizeNullableText(importSlipTitle),
          entryDate: importEntryDate,
          status: detail.status,
        }),
      },
    );
    setImportingPurchase(false);

    if (!res.ok) {
      setMessage({ type: 'error', text: res.error });
      return;
    }

    setPurchaseModalOpen(false);
    setImportSlipTitle('');
    await refreshProjectDetail();
    setMessage({
      type: 'success',
      text: `仕入伝票から原価伝票「${res.data.item.slipTitle}」を作成しました。`,
    });
  }

  async function handleUploadAttachment(e: React.FormEvent) {
    e.preventDefault();
    if (uploadFile === null) {
      setMessage({ type: 'error', text: 'アップロードする画像ファイルを選択してください。' });
      return;
    }
    setUploadingAttachment(true);
    setMessage(null);

    const fd = new FormData();
    fd.set('entityType', 'PROJECT');
    fd.set('entityId', detail.id);
    if (uploadComment.trim() !== '') {
      fd.set('comment', uploadComment.trim());
    }
    fd.set('file', uploadFile);

    const res = await requestMasterApi<{ ok: true; item: AttachmentDto }>('/api/v1/attachments', {
      method: 'POST',
      body: fd,
    });
    setUploadingAttachment(false);

    if (!res.ok) {
      setMessage({ type: 'error', text: res.error });
      return;
    }

    setUploadFile(null);
    setUploadComment('');
    await refreshProjectDetail();
    setMessage({ type: 'success', text: `現場写真「${res.data.item.originalName}」をアップロードしました。` });
  }

  async function handleUpdateAttachment(
    attachmentId: string,
    payload: { comment?: string | null; moveDirection?: 'UP' | 'DOWN' },
  ) {
    setMessage(null);
    const res = await requestMasterApi<{ ok: true; item: AttachmentDto }>(
      `/api/v1/attachments/${attachmentId}`,
      {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      },
    );
    if (!res.ok) {
      setMessage({ type: 'error', text: res.error });
      return;
    }
    await refreshProjectDetail();
  }

  async function handleDeleteAttachment(attachmentId: string, fileName: string) {
    if (!window.confirm(`添付画像「${fileName}」を削除しますか？`)) return;
    setMessage(null);
    const res = await requestMasterApi<{ ok: true }>(`/api/v1/attachments/${attachmentId}`, {
      method: 'DELETE',
    });
    if (!res.ok) {
      setMessage({ type: 'error', text: res.error });
      return;
    }
    await refreshProjectDetail();
    setMessage({ type: 'success', text: `添付画像「${fileName}」を削除しました。` });
  }

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <div className="flex items-center gap-2 text-xs text-slate-500">
            <Link href="/projects" className="text-blue-600 hover:underline">
              ← 案件一覧へ戻る
            </Link>
            <span>/</span>
            <span className="font-mono">No.{detail.projectNo}</span>
            <span
              className={`rounded-full px-2 py-0.5 font-semibold ${
                detail.status === 'C3'
                  ? 'bg-emerald-100 text-emerald-800'
                  : detail.status === 'C2'
                    ? 'bg-amber-100 text-amber-800'
                    : 'bg-blue-100 text-blue-800'
              }`}
            >
              {detail.status}: {PROJECT_STATUS_LABELS[detail.status]}
            </span>
          </div>
          <h1 className="mt-1 text-2xl font-bold text-slate-900">{detail.projectName}</h1>
          <div className="mt-1 text-sm text-slate-600">
            発注元: <span className="font-medium text-slate-900">{detail.partnerName}</span>
            {detail.sitePlace !== null && <span className="ml-3">現場: {detail.sitePlace}</span>}
            {detail.sourceQuotationNo !== null && (
              <span className="ml-3 font-mono text-xs bg-slate-100 px-2 py-0.5 rounded">
                取込元見積: #{detail.sourceQuotationNo}
              </span>
            )}
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          {lookups.costEnabled && (
            <>
              <Link
                href={`/costs?projectId=${detail.id}`}
                className="rounded-lg border border-blue-200 bg-blue-50 px-3.5 py-2 text-sm font-medium text-blue-700 hover:bg-blue-100"
              >
                この案件の原価伝票を管理
              </Link>
              <button
                type="button"
                onClick={() => {
                  setImportPurchaseId(
                    candidates.length > 0 ? candidates[0]!.purchaseId : '',
                  );
                  setPurchaseModalOpen(true);
                }}
                className="rounded-lg border border-slate-300 bg-white px-3.5 py-2 text-sm font-medium text-slate-700 hover:bg-slate-50"
              >
                仕入から原価取込
              </button>
            </>
          )}
          <a
            href={`/api/v1/projects/${detail.id}/ledger-export?format=csv`}
            className="rounded-lg border border-slate-300 bg-white px-3.5 py-2 text-sm font-medium text-slate-700 hover:bg-slate-50"
          >
            工事台帳 CSV
          </a>
          <a
            href={`/api/v1/projects/${detail.id}/ledger-export?format=pdf&inline=1`}
            target="_blank"
            rel="noopener noreferrer"
            className="rounded-lg bg-slate-900 px-4 py-2 text-sm font-semibold text-white hover:bg-slate-800"
          >
            工事台帳 PDF
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

      {/* Tabs */}
      <div className="border-b border-slate-200 flex flex-wrap gap-1">
        {(
          [
            { key: 'LEDGER', label: '工事台帳・6費目予実対比' },
            { key: 'EDIT', label: '基本情報・実行予算編集' },
            {
              key: 'RELATIONS',
              label: `関連伝票一覧 (${
                detail.relatedQuotations.length +
                detail.relatedSales.length +
                detail.relatedOrders.length +
                detail.relatedPurchases.length +
                detail.costHeaders.length
              })`,
            },
            {
              key: 'ATTACHMENTS',
              label: `現場添付画像 (${detail.attachments.length})`,
            },
          ] as const
        ).map((tab) => (
          <button
            key={tab.key}
            type="button"
            onClick={() => setActiveTab(tab.key)}
            className={`px-4 py-2.5 text-sm font-medium border-b-2 transition-colors ${
              activeTab === tab.key
                ? 'border-blue-600 text-blue-700'
                : 'border-transparent text-slate-600 hover:text-slate-900'
            }`}
          >
            {tab.label}
          </button>
        ))}
      </div>

      {/* Tab 1: 工事台帳・6費目予実対比 */}
      {activeTab === 'LEDGER' && (
        <div className="space-y-6">
          <div className="grid grid-cols-2 lg:grid-cols-5 gap-3">
            <div className="rounded-xl border border-slate-200 bg-white p-4">
              <div className="text-xs font-medium text-slate-500">請負契約額（税込）</div>
              <div className="mt-1 text-xl font-bold font-mono text-slate-900">
                {formatYen(detail.contractTotal)}
              </div>
              <div className="text-xs font-mono text-slate-500 mt-0.5">
                税抜 {formatYen(detail.contractSubtotal)} / 税 {formatYen(detail.contractTax)}
              </div>
            </div>

            <div className="rounded-xl border border-slate-200 bg-white p-4">
              <div className="text-xs font-medium text-slate-500">計上売上 / 立替金</div>
              <div className="mt-1 text-xl font-bold font-mono text-slate-900">
                {formatYen(detail.salesRecordedIncl)}
              </div>
              <div className="text-xs font-mono text-slate-500 mt-0.5">
                税抜 {formatYen(detail.salesRecordedExcl)} / 立替 {formatYen(detail.advanceRecordedIncl)}
              </div>
            </div>

            <div className="rounded-xl border border-slate-200 bg-white p-4">
              <div className="text-xs font-medium text-slate-500">実行予算合計 / 消化率</div>
              <div className="mt-1 text-xl font-bold font-mono text-blue-700">
                {formatYen(detail.budgetTotal)}
              </div>
              <div className="text-xs font-mono text-slate-500 mt-0.5">
                消化率 {detail.budgetConsumptionRatePercent}% / 予算残{' '}
                {formatYen(detail.budgetVarianceTotal)}
              </div>
            </div>

            <div className="rounded-xl border border-slate-200 bg-white p-4">
              <div className="text-xs font-medium text-slate-500">
                実績原価 ({detail.costTaxMode === 'TAX_EXCLUDED' ? '税抜基準' : '税込基準'})
              </div>
              <div className="mt-1 text-xl font-bold font-mono text-amber-700">
                {formatYen(detail.actualCostEvalTotal)}
              </div>
              <div className="text-xs font-mono text-slate-500 mt-0.5">
                税抜 {formatYen(detail.actualCostExclTotal)} / 税込{' '}
                {formatYen(detail.actualCostInclTotal)}
              </div>
            </div>

            <div className="rounded-xl border border-slate-200 bg-white p-4">
              <div className="text-xs font-medium text-slate-500">契約粗利 / 売上基準粗利</div>
              <div
                className={`mt-1 text-xl font-bold font-mono ${
                  detail.actualGrossProfit < 0 ? 'text-red-700' : 'text-emerald-700'
                }`}
              >
                {formatYen(detail.actualGrossProfit)} ({detail.actualGrossMarginPercent}%)
              </div>
              <div className="text-xs font-mono text-slate-500 mt-0.5">
                売上基準 {formatYen(detail.salesBasedGrossProfit)} ({detail.salesBasedGrossMarginPercent}%)
              </div>
            </div>
          </div>

          {/* 6-Category Comparison Table */}
          <div className="rounded-xl border border-slate-200 bg-white overflow-hidden">
            <div className="border-b border-slate-200 px-4 py-3 flex items-center justify-between">
              <h2 className="text-sm font-bold text-slate-900">原価6費目別 実行予算 vs 実績対比</h2>
              {detail.isOverBudget && (
                <span className="rounded-full bg-red-100 px-3 py-0.5 text-xs font-semibold text-red-700">
                  実行予算超過あり
                </span>
              )}
            </div>
            <div className="overflow-x-auto">
              <table className="min-w-full divide-y divide-slate-200 text-sm">
                <thead className="bg-slate-50 text-xs font-semibold text-slate-600">
                  <tr>
                    <th className="px-4 py-2.5 text-left">費目</th>
                    <th className="px-4 py-2.5 text-right">実行予算</th>
                    <th className="px-4 py-2.5 text-right">実績原価（税抜）</th>
                    <th className="px-4 py-2.5 text-right">実績原価（税込）</th>
                    <th className="px-4 py-2.5 text-right">評価基準実績</th>
                    <th className="px-4 py-2.5 text-right">予算残高</th>
                    <th className="px-4 py-2.5 text-left w-48">消化率</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {detail.categoryComparisons.map((item) => (
                    <tr key={item.category} className={item.isOverBudget ? 'bg-red-50/40' : ''}>
                      <td className="px-4 py-2.5 font-medium text-slate-900">
                        {item.categoryLabel}
                        <span className="ml-1.5 text-[10px] font-mono text-slate-400">
                          {item.category}
                        </span>
                      </td>
                      <td className="px-4 py-2.5 text-right font-mono">
                        {formatYen(item.budgetAmount)}
                      </td>
                      <td className="px-4 py-2.5 text-right font-mono text-slate-600">
                        {formatYen(item.actualExclAmount)}
                      </td>
                      <td className="px-4 py-2.5 text-right font-mono text-slate-600">
                        {formatYen(item.actualInclAmount)}
                      </td>
                      <td className="px-4 py-2.5 text-right font-mono font-semibold text-amber-700">
                        {formatYen(item.actualEvalAmount)}
                      </td>
                      <td
                        className={`px-4 py-2.5 text-right font-mono font-semibold ${
                          item.isOverBudget ? 'text-red-700' : 'text-emerald-700'
                        }`}
                      >
                        {formatYen(item.varianceAmount)}
                        {item.isOverBudget && (
                          <span className="ml-1 rounded bg-red-100 px-1.5 py-0.5 text-[10px]">
                            超過
                          </span>
                        )}
                      </td>
                      <td className="px-4 py-2.5">
                        <div className="flex items-center gap-2">
                          <div className="flex-1 h-2 rounded-full bg-slate-200 overflow-hidden">
                            <div
                              className={`h-full ${
                                item.isOverBudget ? 'bg-red-600' : 'bg-blue-600'
                              }`}
                              style={{ width: computeProgressWidth(item.consumptionRatePercent) }}
                            />
                          </div>
                          <span className="text-xs font-mono text-slate-700 w-14 text-right">
                            {item.consumptionRatePercent}%
                          </span>
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>

          {/* Cost Lines Ledger */}
          <div className="rounded-xl border border-slate-200 bg-white overflow-hidden">
            <div className="border-b border-slate-200 px-4 py-3 flex items-center justify-between">
              <h2 className="text-sm font-bold text-slate-900">
                工事台帳 原価明細（{detail.costLines.length}行 / {detail.costHeaders.length}伝票）
              </h2>
              {lookups.costEnabled && (
                <Link
                  href={`/costs?projectId=${detail.id}`}
                  className="text-xs font-medium text-blue-600 hover:underline"
                >
                  原価登録・編集画面を開く →
                </Link>
              )}
            </div>
            <div className="overflow-x-auto">
              <table className="min-w-full divide-y divide-slate-200 text-xs">
                <thead className="bg-slate-50 font-semibold text-slate-600">
                  <tr>
                    <th className="px-3 py-2 text-left">計上日</th>
                    <th className="px-3 py-2 text-left">費目</th>
                    <th className="px-3 py-2 text-left">伝票件名</th>
                    <th className="px-3 py-2 text-left">品名・摘要</th>
                    <th className="px-3 py-2 text-right">数量 / 単位</th>
                    <th className="px-3 py-2 text-right">単価</th>
                    <th className="px-3 py-2 text-right">税抜金額</th>
                    <th className="px-3 py-2 text-right">消費税</th>
                    <th className="px-3 py-2 text-right">税込合計</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {detail.costLines.length === 0 ? (
                    <tr>
                      <td colSpan={9} className="px-4 py-8 text-center text-slate-500">
                        まだ原価明細が登録されていません。
                      </td>
                    </tr>
                  ) : (
                    detail.costLines.map((line, idx) => (
                      <tr key={`${line.costHeaderId}-${line.lineNo}-${idx}`}>
                        <td className="px-3 py-2 font-mono">{line.entryDate}</td>
                        <td className="px-3 py-2">{line.categoryLabel}</td>
                        <td className="px-3 py-2">{line.slipTitle}</td>
                        <td className="px-3 py-2 font-medium text-slate-900">{line.itemName}</td>
                        <td className="px-3 py-2 text-right font-mono">
                          {line.quantity} {line.unitName !== null ? line.unitName : ''}
                        </td>
                        <td className="px-3 py-2 text-right font-mono">
                          {formatYen(line.appliedUnitPrice)}
                        </td>
                        <td className="px-3 py-2 text-right font-mono">
                          {formatYen(line.lineAmount)}
                        </td>
                        <td className="px-3 py-2 text-right font-mono">
                          {formatYen(line.lineTax)}
                        </td>
                        <td className="px-3 py-2 text-right font-mono font-semibold">
                          {formatYen(line.lineTotal)}
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

      {/* Tab 2: 基本情報・実行予算編集 */}
      {activeTab === 'EDIT' && (
        <div className="space-y-6">
          {/* Import from quotation */}
          <div className="rounded-xl border border-blue-200 bg-blue-50/70 p-4 space-y-3">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div>
                <h2 className="text-sm font-bold text-blue-900">見積書から実行予算6費目・契約額を取込</h2>
                <p className="text-xs text-blue-800">
                  関連する見積書（または選定見積）の明細原価を原価6費目別実行予算へ自動集計します。
                </p>
              </div>
            </div>
            {detail.relatedQuotations.length === 0 ? (
              <p className="text-xs text-slate-600">
                この案件に紐づく見積書がありません。見積画面で案件を関連付けるとここから予算取込が可能です。
              </p>
            ) : (
              <div className="flex flex-wrap items-center gap-3">
                <select
                  value={selectedQuotationId}
                  onChange={(e) => setSelectedQuotationId(e.target.value)}
                  className="rounded-lg border border-blue-300 bg-white px-3 py-1.5 text-sm min-w-[260px]"
                >
                  {detail.relatedQuotations.map((q) => (
                    <option key={q.id} value={q.id}>
                      #{q.quotationNo} {q.quotationName} (売価 {formatYen(q.subtotalAmount)} / 原価{' '}
                      {formatYen(q.costSubtotal)}){q.isSelected ? ' ★選定' : ''}
                    </option>
                  ))}
                </select>
                <label className="inline-flex items-center gap-2 text-xs text-slate-800 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={updateContractAmount}
                    onChange={(e) => setUpdateContractAmount(e.target.checked)}
                    className="rounded border-slate-300"
                  />
                  契約金額（売価合計）も見積値で上書き更新する
                </label>
                <button
                  type="button"
                  disabled={importingBudget}
                  onClick={handleImportBudgetFromQuotation}
                  className="rounded-lg bg-blue-600 px-4 py-1.5 text-sm font-semibold text-white hover:bg-blue-700 disabled:opacity-50"
                >
                  {importingBudget ? '取込中...' : '見積から予算・契約額取込'}
                </button>
              </div>
            )}
          </div>

          <form
            onSubmit={handleSaveProject}
            className="rounded-xl border border-slate-200 bg-white p-6 space-y-5 text-sm"
          >
            <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
              <div className="md:col-span-2">
                <label className="block text-xs font-semibold text-slate-700 mb-1">案件名 *</label>
                <input
                  type="text"
                  required
                  value={editForm.projectName}
                  onChange={(e) => setEditForm({ ...editForm, projectName: e.target.value })}
                  className="w-full rounded-lg border border-slate-300 px-3 py-2"
                />
              </div>

              <div>
                <label className="block text-xs font-semibold text-slate-700 mb-1">受注日 *</label>
                <input
                  type="date"
                  required
                  value={editForm.projectDate}
                  onChange={(e) => setEditForm({ ...editForm, projectDate: e.target.value })}
                  className="w-full rounded-lg border border-slate-300 px-3 py-2"
                />
              </div>

              <div>
                <label className="block text-xs font-semibold text-slate-700 mb-1">発注元取引先 *</label>
                <select
                  required
                  value={editForm.partnerId}
                  onChange={(e) => setEditForm({ ...editForm, partnerId: e.target.value })}
                  className="w-full rounded-lg border border-slate-300 px-3 py-2"
                >
                  {lookups.partners.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.partnerCode} : {p.partnerName}
                    </option>
                  ))}
                </select>
              </div>

              <div>
                <label className="block text-xs font-semibold text-slate-700 mb-1">現場住所</label>
                <input
                  type="text"
                  value={editForm.sitePlace}
                  onChange={(e) => setEditForm({ ...editForm, sitePlace: e.target.value })}
                  className="w-full rounded-lg border border-slate-300 px-3 py-2"
                />
              </div>

              <div>
                <label className="block text-xs font-semibold text-slate-700 mb-1">ステータス</label>
                <select
                  value={editForm.status}
                  onChange={(e) =>
                    setEditForm({ ...editForm, status: e.target.value as ProjectStatus })
                  }
                  className="w-full rounded-lg border border-slate-300 px-3 py-2"
                >
                  <option value="C1">C1: {PROJECT_STATUS_LABELS.C1}</option>
                  <option value="C2">C2: {PROJECT_STATUS_LABELS.C2}</option>
                  <option value="C3">C3: {PROJECT_STATUS_LABELS.C3}</option>
                </select>
              </div>

              <div>
                <label className="block text-xs font-semibold text-slate-700 mb-1">工事区分</label>
                <select
                  value={editForm.orderKindCode}
                  onChange={(e) => setEditForm({ ...editForm, orderKindCode: e.target.value })}
                  className="w-full rounded-lg border border-slate-300 px-3 py-2"
                >
                  <option value="">未選択</option>
                  {lookups.orderKinds.map((k) => (
                    <option key={k.code} value={k.code}>
                      {k.name}
                    </option>
                  ))}
                </select>
              </div>

              <div>
                <label className="block text-xs font-semibold text-slate-700 mb-1">工程詳細状態</label>
                <select
                  value={editForm.subStatusCode}
                  onChange={(e) => setEditForm({ ...editForm, subStatusCode: e.target.value })}
                  className="w-full rounded-lg border border-slate-300 px-3 py-2"
                >
                  <option value="">未選択</option>
                  {lookups.subStatuses.map((s) => (
                    <option key={s.code} value={s.code}>
                      {s.name}
                    </option>
                  ))}
                </select>
              </div>

              <div className="grid grid-cols-2 gap-2">
                <div>
                  <label className="block text-xs font-semibold text-slate-700 mb-1">営業担当</label>
                  <select
                    value={editForm.salesEmployeeId}
                    onChange={(e) =>
                      setEditForm({ ...editForm, salesEmployeeId: e.target.value })
                    }
                    className="w-full rounded-lg border border-slate-300 px-2 py-2 text-xs"
                  >
                    <option value="">未選択</option>
                    {lookups.employees.map((emp) => (
                      <option key={emp.id} value={emp.id}>
                        {emp.syainName}
                      </option>
                    ))}
                  </select>
                </div>
                <div>
                  <label className="block text-xs font-semibold text-slate-700 mb-1">現場担当</label>
                  <select
                    value={editForm.siteEmployeeId}
                    onChange={(e) =>
                      setEditForm({ ...editForm, siteEmployeeId: e.target.value })
                    }
                    className="w-full rounded-lg border border-slate-300 px-2 py-2 text-xs"
                  >
                    <option value="">未選択</option>
                    {lookups.employees.map((emp) => (
                      <option key={emp.id} value={emp.id}>
                        {emp.syainName}
                      </option>
                    ))}
                  </select>
                </div>
              </div>

              <div>
                <label className="block text-xs font-semibold text-slate-700 mb-1">予定着工日</label>
                <input
                  type="date"
                  value={editForm.periodStartDate}
                  onChange={(e) => setEditForm({ ...editForm, periodStartDate: e.target.value })}
                  className="w-full rounded-lg border border-slate-300 px-3 py-2"
                />
              </div>
              <div>
                <label className="block text-xs font-semibold text-slate-700 mb-1">予定完了日</label>
                <input
                  type="date"
                  value={editForm.periodEndDate}
                  onChange={(e) => setEditForm({ ...editForm, periodEndDate: e.target.value })}
                  className="w-full rounded-lg border border-slate-300 px-3 py-2"
                />
              </div>
              <div>
                <label className="block text-xs font-semibold text-slate-700 mb-1">
                  実着工日 / 引渡完了日
                </label>
                <div className="grid grid-cols-2 gap-2">
                  <input
                    type="date"
                    value={editForm.actualStartDate}
                    onChange={(e) =>
                      setEditForm({ ...editForm, actualStartDate: e.target.value })
                    }
                    className="rounded-lg border border-slate-300 px-2 py-2 text-xs"
                  />
                  <input
                    type="date"
                    value={editForm.finishDate}
                    onChange={(e) => setEditForm({ ...editForm, finishDate: e.target.value })}
                    className="rounded-lg border border-slate-300 px-2 py-2 text-xs"
                  />
                </div>
              </div>
            </div>

            {/* Contract Section */}
            <div className="rounded-xl border border-slate-200 bg-slate-50 p-4 space-y-3">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <h3 className="text-xs font-bold uppercase tracking-wider text-slate-700">
                  契約金額・消費税設定（calculations.ts リアルタイム計算）
                </h3>
                <div className="text-xs font-mono">
                  税抜 {formatYen(editPreview.contractSubtotal)} / 税{' '}
                  {formatYen(editPreview.contractTax)} / 税込{' '}
                  <span className="font-bold text-blue-700">{formatYen(editPreview.contractTotal)}</span>
                </div>
              </div>
              <div className="grid grid-cols-2 md:grid-cols-5 gap-3">
                <div>
                  <label className="block text-xs text-slate-600 mb-1">契約単価(円)</label>
                  <input
                    type="number"
                    value={editForm.contractUnitPriceStr}
                    onChange={(e) =>
                      setEditForm({ ...editForm, contractUnitPriceStr: e.target.value })
                    }
                    className="w-full rounded-lg border border-slate-300 bg-white px-3 py-1.5 font-mono text-right"
                  />
                </div>
                <div>
                  <label className="block text-xs text-slate-600 mb-1">数量</label>
                  <input
                    type="number"
                    step="0.0001"
                    value={editForm.contractQuantityStr}
                    onChange={(e) =>
                      setEditForm({ ...editForm, contractQuantityStr: e.target.value })
                    }
                    className="w-full rounded-lg border border-slate-300 bg-white px-3 py-1.5 font-mono text-right"
                  />
                </div>
                <div>
                  <label className="block text-xs text-slate-600 mb-1">単位</label>
                  <input
                    type="text"
                    value={editForm.unitName}
                    onChange={(e) => setEditForm({ ...editForm, unitName: e.target.value })}
                    className="w-full rounded-lg border border-slate-300 bg-white px-3 py-1.5"
                  />
                </div>
                <div>
                  <label className="block text-xs text-slate-600 mb-1">税区分</label>
                  <select
                    value={editForm.taxCode}
                    onChange={(e) =>
                      setEditForm({ ...editForm, taxCode: e.target.value as TaxCode })
                    }
                    className="w-full rounded-lg border border-slate-300 bg-white px-2.5 py-1.5"
                  >
                    {lookups.taxCodes.map((tc) => (
                      <option key={tc.taxCode} value={tc.taxCode}>
                        {tc.taxCode}: {tc.taxName}
                      </option>
                    ))}
                  </select>
                </div>
                <div>
                  <label className="block text-xs text-slate-600 mb-1">端数処理</label>
                  <select
                    value={editForm.roundingMode}
                    onChange={(e) =>
                      setEditForm({ ...editForm, roundingMode: e.target.value as RoundingMode })
                    }
                    className="w-full rounded-lg border border-slate-300 bg-white px-2.5 py-1.5"
                  >
                    <option value="FLOOR">切り捨て (FLOOR)</option>
                    <option value="ROUND">四捨五入 (ROUND)</option>
                    <option value="CEIL">切り上げ (CEIL)</option>
                  </select>
                </div>
              </div>
            </div>

            {/* Budgets */}
            <div className="rounded-xl border border-slate-200 bg-slate-50 p-4 space-y-3">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <h3 className="text-xs font-bold uppercase tracking-wider text-slate-700">
                  実行予算（原価6費目内訳）
                </h3>
                <div className="text-xs font-mono">
                  予算合計:{' '}
                  <span className="font-bold text-blue-700">{formatYen(editPreview.budgetTotal)}</span>{' '}
                  / 予算粗利:{' '}
                  <span className="font-bold">{formatYen(editPreview.budgetGrossProfit)}</span> /
                  実績粗利見込:{' '}
                  <span className="font-bold text-emerald-700">
                    {formatYen(editPreview.actualGrossProfit)} ({editPreview.actualGrossMarginPercent}%)
                  </span>
                </div>
              </div>
              <div className="grid grid-cols-2 md:grid-cols-6 gap-3">
                {COST_CATEGORY_LIST.map((cat) => (
                  <div key={cat}>
                    <label className="block text-xs font-medium text-slate-700 mb-1">
                      {COST_CATEGORY_LABELS[cat]}
                    </label>
                    <input
                      type="number"
                      value={editForm.budgets[cat]}
                      onChange={(e) =>
                        setEditForm({
                          ...editForm,
                          budgets: { ...editForm.budgets, [cat]: e.target.value },
                        })
                      }
                      className="w-full rounded-lg border border-slate-300 bg-white px-2.5 py-1.5 font-mono text-right"
                    />
                  </div>
                ))}
              </div>
            </div>

            <div>
              <label className="block text-xs font-semibold text-slate-700 mb-1">備考</label>
              <textarea
                rows={3}
                value={editForm.remarks}
                onChange={(e) => setEditForm({ ...editForm, remarks: e.target.value })}
                className="w-full rounded-lg border border-slate-300 px-3 py-2"
              />
            </div>

            <div className="flex justify-end">
              <button
                type="submit"
                disabled={saving}
                className="rounded-lg bg-blue-600 px-5 py-2 text-sm font-semibold text-white hover:bg-blue-700 disabled:opacity-50"
              >
                {saving ? '保存中...' : '変更を保存する'}
              </button>
            </div>
          </form>
        </div>
      )}

      {/* Tab 3: 関連伝票一覧 */}
      {activeTab === 'RELATIONS' && (
        <div className="space-y-6">
          {/* Cost Headers */}
          <div className="rounded-xl border border-slate-200 bg-white overflow-hidden">
            <div className="border-b border-slate-200 px-4 py-3 flex items-center justify-between">
              <h3 className="text-sm font-bold text-slate-900">
                原価6費目伝票 ({detail.costHeaders.length}件)
              </h3>
              {lookups.costEnabled && (
                <div className="flex items-center gap-2">
                  <button
                    type="button"
                    onClick={() => setPurchaseModalOpen(true)}
                    className="rounded-lg border border-slate-300 bg-white px-3 py-1 text-xs font-medium text-slate-700 hover:bg-slate-50"
                  >
                    仕入伝票から原価取込
                  </button>
                  <Link
                    href={`/costs?projectId=${detail.id}`}
                    className="rounded-lg bg-blue-600 px-3 py-1 text-xs font-semibold text-white hover:bg-blue-700"
                  >
                    原価画面を開く
                  </Link>
                </div>
              )}
            </div>
            <div className="overflow-x-auto">
              <table className="min-w-full divide-y divide-slate-200 text-xs">
                <thead className="bg-slate-50 text-slate-600">
                  <tr>
                    <th className="px-3 py-2 text-left">計上日</th>
                    <th className="px-3 py-2 text-left">費目</th>
                    <th className="px-3 py-2 text-left">伝票件名</th>
                    <th className="px-3 py-2 text-left">状態</th>
                    <th className="px-3 py-2 text-right">行数</th>
                    <th className="px-3 py-2 text-right">税抜金額</th>
                    <th className="px-3 py-2 text-right">税込合計</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {detail.costHeaders.length === 0 ? (
                    <tr>
                      <td colSpan={7} className="px-4 py-6 text-center text-slate-500">
                        原価伝票はありません。
                      </td>
                    </tr>
                  ) : (
                    detail.costHeaders.map((h) => (
                      <tr key={h.id}>
                        <td className="px-3 py-2 font-mono">{h.entryDate}</td>
                        <td className="px-3 py-2">{h.categoryLabel}</td>
                        <td className="px-3 py-2 font-medium text-slate-900">{h.slipTitle}</td>
                        <td className="px-3 py-2">{h.status}</td>
                        <td className="px-3 py-2 text-right font-mono">{h.lineCount}</td>
                        <td className="px-3 py-2 text-right font-mono">
                          {formatYen(h.subtotalAmount)}
                        </td>
                        <td className="px-3 py-2 text-right font-mono font-semibold">
                          {formatYen(h.totalAmount)}
                        </td>
                      </tr>
                    ))
                  )}
                </tbody>
              </table>
            </div>
          </div>

          {/* Quotations */}
          <div className="rounded-xl border border-slate-200 bg-white overflow-hidden">
            <div className="border-b border-slate-200 px-4 py-3 flex items-center justify-between">
              <h3 className="text-sm font-bold text-slate-900">
                関連見積書 ({detail.relatedQuotations.length}件)
              </h3>
              <Link href="/estimates" className="text-xs text-blue-600 hover:underline">
                見積管理へ →
              </Link>
            </div>
            <div className="overflow-x-auto">
              <table className="min-w-full divide-y divide-slate-200 text-xs">
                <thead className="bg-slate-50 text-slate-600">
                  <tr>
                    <th className="px-3 py-2 text-left">見積番号</th>
                    <th className="px-3 py-2 text-left">見積日</th>
                    <th className="px-3 py-2 text-left">見積件名</th>
                    <th className="px-3 py-2 text-left">状態 / 選定</th>
                    <th className="px-3 py-2 text-right">売価税込</th>
                    <th className="px-3 py-2 text-right">原価税抜</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {detail.relatedQuotations.length === 0 ? (
                    <tr>
                      <td colSpan={6} className="px-4 py-6 text-center text-slate-500">
                        関連見積書はありません。
                      </td>
                    </tr>
                  ) : (
                    detail.relatedQuotations.map((q) => (
                      <tr key={q.id}>
                        <td className="px-3 py-2 font-mono">{q.quotationNo}</td>
                        <td className="px-3 py-2 font-mono">{q.quotationDate}</td>
                        <td className="px-3 py-2 font-medium text-slate-900">{q.quotationName}</td>
                        <td className="px-3 py-2">
                          {q.status} {q.isSelected && <span className="text-blue-700 font-semibold">★選定</span>}
                        </td>
                        <td className="px-3 py-2 text-right font-mono">
                          {formatYen(q.totalAmount)}
                        </td>
                        <td className="px-3 py-2 text-right font-mono">
                          {formatYen(q.costSubtotal)}
                        </td>
                      </tr>
                    ))
                  )}
                </tbody>
              </table>
            </div>
          </div>

          {/* Sales */}
          <div className="rounded-xl border border-slate-200 bg-white overflow-hidden">
            <div className="border-b border-slate-200 px-4 py-3 flex items-center justify-between">
              <h3 className="text-sm font-bold text-slate-900">
                関連売上・立替伝票 ({detail.relatedSales.length}件)
              </h3>
              <Link href="/sales" className="text-xs text-blue-600 hover:underline">
                売上管理へ →
              </Link>
            </div>
            <div className="overflow-x-auto">
              <table className="min-w-full divide-y divide-slate-200 text-xs">
                <thead className="bg-slate-50 text-slate-600">
                  <tr>
                    <th className="px-3 py-2 text-left">種別 / 番号</th>
                    <th className="px-3 py-2 text-left">伝票日付</th>
                    <th className="px-3 py-2 text-left">件名</th>
                    <th className="px-3 py-2 text-left">状態</th>
                    <th className="px-3 py-2 text-right">税抜金額</th>
                    <th className="px-3 py-2 text-right">税込合計</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {detail.relatedSales.length === 0 ? (
                    <tr>
                      <td colSpan={6} className="px-4 py-6 text-center text-slate-500">
                        関連売上・立替伝票はありません。
                      </td>
                    </tr>
                  ) : (
                    detail.relatedSales.map((s) => (
                      <tr key={s.id}>
                        <td className="px-3 py-2 font-mono">
                          {s.entryType === 'ADVANCE' ? '立替' : '売上'} #{s.slipNo}
                        </td>
                        <td className="px-3 py-2 font-mono">{s.slipDate}</td>
                        <td className="px-3 py-2 font-medium text-slate-900">{s.slipName}</td>
                        <td className="px-3 py-2">{s.status}</td>
                        <td className="px-3 py-2 text-right font-mono">
                          {formatYen(s.subtotalAmount)}
                        </td>
                        <td className="px-3 py-2 text-right font-mono font-semibold">
                          {formatYen(s.totalAmount)}
                        </td>
                      </tr>
                    ))
                  )}
                </tbody>
              </table>
            </div>
          </div>

          {/* Orders & Purchases */}
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
            <div className="rounded-xl border border-slate-200 bg-white overflow-hidden">
              <div className="border-b border-slate-200 px-4 py-3 flex items-center justify-between">
                <h3 className="text-sm font-bold text-slate-900">
                  関連発注 ({detail.relatedOrders.length}件)
                </h3>
                <Link href="/purchasing?tab=ORDERS" className="text-xs text-blue-600 hover:underline">
                  発注画面へ →
                </Link>
              </div>
              <div className="overflow-x-auto">
                <table className="min-w-full divide-y divide-slate-200 text-xs">
                  <thead className="bg-slate-50 text-slate-600">
                    <tr>
                      <th className="px-3 py-2 text-left">発注番号 / 日付</th>
                      <th className="px-3 py-2 text-left">件名 / 仕入先</th>
                      <th className="px-3 py-2 text-right">金額</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100">
                    {detail.relatedOrders.length === 0 ? (
                      <tr>
                        <td colSpan={3} className="px-4 py-6 text-center text-slate-500">
                          関連発注明細はありません。
                        </td>
                      </tr>
                    ) : (
                      detail.relatedOrders.map((o) => (
                        <tr key={o.id}>
                          <td className="px-3 py-2 font-mono">
                            #{o.orderNo} ({o.orderDate})
                          </td>
                          <td className="px-3 py-2">
                            <div className="font-medium text-slate-900">{o.orderName}</div>
                            <div className="text-slate-500">{o.supplierName}</div>
                          </td>
                          <td className="px-3 py-2 text-right font-mono">
                            {formatYen(o.totalAmount)}
                          </td>
                        </tr>
                      ))
                    )}
                  </tbody>
                </table>
              </div>
            </div>

            <div className="rounded-xl border border-slate-200 bg-white overflow-hidden">
              <div className="border-b border-slate-200 px-4 py-3 flex items-center justify-between">
                <h3 className="text-sm font-bold text-slate-900">
                  関連仕入 ({detail.relatedPurchases.length}件)
                </h3>
                <Link
                  href="/purchasing?tab=PURCHASES"
                  className="text-xs text-blue-600 hover:underline"
                >
                  仕入画面へ →
                </Link>
              </div>
              <div className="overflow-x-auto">
                <table className="min-w-full divide-y divide-slate-200 text-xs">
                  <thead className="bg-slate-50 text-slate-600">
                    <tr>
                      <th className="px-3 py-2 text-left">仕入番号 / 日付</th>
                      <th className="px-3 py-2 text-left">件名 / 仕入先</th>
                      <th className="px-3 py-2 text-right">当案件行金額(税込)</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100">
                    {detail.relatedPurchases.length === 0 ? (
                      <tr>
                        <td colSpan={3} className="px-4 py-6 text-center text-slate-500">
                          関連仕入明細はありません。
                        </td>
                      </tr>
                    ) : (
                      detail.relatedPurchases.map((p) => (
                        <tr key={p.id}>
                          <td className="px-3 py-2 font-mono">
                            #{p.purchaseNo} ({p.purchaseDate})
                          </td>
                          <td className="px-3 py-2">
                            <div className="font-medium text-slate-900">{p.purchaseName}</div>
                            <div className="text-slate-500">{p.supplierName}</div>
                          </td>
                          <td className="px-3 py-2 text-right font-mono">
                            {formatYen(p.projectLineTotal)}
                          </td>
                        </tr>
                      ))
                    )}
                  </tbody>
                </table>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Tab 4: 現場添付画像 */}
      {activeTab === 'ATTACHMENTS' && (
        <div className="space-y-6">
          {!lookups.constructionImageEnabled ? (
            <div className="rounded-xl border border-amber-200 bg-amber-50 p-5 text-sm text-amber-900">
              <div className="font-bold">現場画像機能（constructionimage）は無効です</div>
              <p className="mt-1">
                このテナントでは `constructionimage` 機能フラグが無効化されているため、現場添付画像のアップロード・閲覧機能は利用できません。管理者設定画面から有効化できます。
              </p>
            </div>
          ) : (
            <>
              <form
                onSubmit={handleUploadAttachment}
                className="rounded-xl border border-slate-200 bg-white p-4 space-y-3"
              >
                <h3 className="text-sm font-bold text-slate-900">
                  現場画像アップロード（JPEG / PNG / WebP・5MB以内）
                </h3>
                <div className="flex flex-wrap items-center gap-3">
                  <input
                    type="file"
                    accept="image/jpeg,image/png,image/webp"
                    onChange={(e) => {
                      const files = e.target.files;
                      setUploadFile(files !== null && files.length > 0 ? files[0]! : null);
                    }}
                    className="text-sm"
                  />
                  <input
                    type="text"
                    value={uploadComment}
                    onChange={(e) => setUploadComment(e.target.value)}
                    placeholder="写真コメント・撮影箇所メモ"
                    className="flex-1 min-w-[200px] rounded-lg border border-slate-300 px-3 py-1.5 text-sm"
                  />
                  <button
                    type="submit"
                    disabled={uploadingAttachment || uploadFile === null}
                    className="rounded-lg bg-blue-600 px-4 py-1.5 text-sm font-semibold text-white hover:bg-blue-700 disabled:opacity-50"
                  >
                    {uploadingAttachment ? 'アップロード中...' : '画像をアップロード'}
                  </button>
                </div>
              </form>

              {detail.attachments.length === 0 ? (
                <div className="rounded-xl border border-slate-200 bg-white p-8 text-center text-sm text-slate-500">
                  まだ現場画像は登録されていません。
                </div>
              ) : (
                <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
                  {detail.attachments.map((att, idx) => (
                    <div
                      key={att.id}
                      className="rounded-xl border border-slate-200 bg-white overflow-hidden flex flex-col"
                    >
                      <div className="bg-slate-100 h-48 flex items-center justify-center overflow-hidden">
                        {/* eslint-disable-next-line @next/next/no-img-element */}
                        <img
                          src={att.signedUrl}
                          alt={att.originalName}
                          className="h-full w-full object-contain"
                        />
                      </div>
                      <div className="p-3 space-y-2 text-xs flex-1 flex flex-col justify-between">
                        <div>
                          <div className="font-semibold text-slate-900 truncate">
                            #{att.sortOrder} {att.originalName}
                          </div>
                          <div className="text-slate-500 font-mono">{att.mimeType}</div>
                        </div>

                        <div className="flex gap-1.5">
                          <input
                            type="text"
                            value={
                              editingComments[att.id] !== undefined ? editingComments[att.id] : ''
                            }
                            onChange={(e) =>
                              setEditingComments({
                                ...editingComments,
                                [att.id]: e.target.value,
                              })
                            }
                            placeholder="コメント"
                            className="flex-1 rounded border border-slate-300 px-2 py-1"
                          />
                          <button
                            type="button"
                            onClick={() =>
                              handleUpdateAttachment(att.id, {
                                comment: normalizeNullableText(
                                  editingComments[att.id] !== undefined
                                    ? editingComments[att.id]!
                                    : '',
                                ),
                              })
                            }
                            className="rounded border border-slate-300 bg-slate-50 px-2 py-1 hover:bg-slate-100"
                          >
                            保存
                          </button>
                        </div>

                        <div className="flex items-center justify-between pt-1 border-t border-slate-100">
                          <div className="flex gap-1">
                            <button
                              type="button"
                              disabled={idx === 0}
                              onClick={() =>
                                handleUpdateAttachment(att.id, { moveDirection: 'UP' })
                              }
                              className="rounded border border-slate-300 px-2 py-0.5 disabled:opacity-40"
                            >
                              ↑ 前へ
                            </button>
                            <button
                              type="button"
                              disabled={idx === detail.attachments.length - 1}
                              onClick={() =>
                                handleUpdateAttachment(att.id, { moveDirection: 'DOWN' })
                              }
                              className="rounded border border-slate-300 px-2 py-0.5 disabled:opacity-40"
                            >
                              ↓ 後へ
                            </button>
                          </div>
                          <button
                            type="button"
                            onClick={() => handleDeleteAttachment(att.id, att.originalName)}
                            className="rounded border border-red-200 px-2 py-0.5 text-red-600 hover:bg-red-50"
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

      {/* Import Cost from Purchase Modal */}
      {purchaseModalOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/50 p-4">
          <div className="w-full max-w-lg rounded-2xl bg-white shadow-xl border border-slate-200 p-6 space-y-4">
            <div className="flex items-center justify-between border-b border-slate-200 pb-3">
              <h2 className="text-base font-bold text-slate-900">仕入伝票から原価伝票を生成</h2>
              <button
                type="button"
                onClick={() => setPurchaseModalOpen(false)}
                className="text-sm text-slate-500 hover:text-slate-800"
              >
                ✕
              </button>
            </div>

            {candidates.length === 0 ? (
              <p className="text-sm text-slate-600">取込可能な仕入伝票がありません。</p>
            ) : (
              <form onSubmit={handleImportCostFromPurchase} className="space-y-3 text-sm">
                <div>
                  <label className="block text-xs font-semibold text-slate-700 mb-1">
                    取込元仕入伝票 *
                  </label>
                  <select
                    required
                    value={importPurchaseId}
                    onChange={(e) => setImportPurchaseId(e.target.value)}
                    className="w-full rounded-lg border border-slate-300 px-3 py-2"
                  >
                    {candidates.map((c) => (
                      <option key={c.purchaseId} value={c.purchaseId} disabled={c.isFullyImported}>
                        #{c.purchaseNo} ({c.purchaseDate}) {c.purchaseName} - {c.supplierName}{' '}
                        {c.isFullyImported ? '[取込済]' : `(${c.matchingLineCount}行対象)`}
                      </option>
                    ))}
                  </select>
                </div>

                <div className="grid grid-cols-2 gap-3">
                  <div>
                    <label className="block text-xs font-semibold text-slate-700 mb-1">
                      取込先費目 *
                    </label>
                    <select
                      value={importCostCategory}
                      onChange={(e) => setImportCostCategory(e.target.value as CostCategory)}
                      className="w-full rounded-lg border border-slate-300 px-3 py-2"
                    >
                      {COST_CATEGORY_LIST.map((cat) => (
                        <option key={cat} value={cat}>
                          {COST_CATEGORY_LABELS[cat]}
                        </option>
                      ))}
                    </select>
                  </div>
                  <div>
                    <label className="block text-xs font-semibold text-slate-700 mb-1">
                      計上日 *
                    </label>
                    <input
                      type="date"
                      required
                      value={importEntryDate}
                      onChange={(e) => setImportEntryDate(e.target.value)}
                      className="w-full rounded-lg border border-slate-300 px-3 py-2"
                    />
                  </div>
                </div>

                <div>
                  <label className="block text-xs font-semibold text-slate-700 mb-1">
                    原価伝票件名（空欄時は仕入件名を流用）
                  </label>
                  <input
                    type="text"
                    value={importSlipTitle}
                    onChange={(e) => setImportSlipTitle(e.target.value)}
                    className="w-full rounded-lg border border-slate-300 px-3 py-2"
                  />
                </div>

                <div className="flex justify-end gap-2 pt-2">
                  <button
                    type="button"
                    onClick={() => setPurchaseModalOpen(false)}
                    className="rounded-lg border border-slate-300 px-4 py-1.5 text-slate-700"
                  >
                    閉じる
                  </button>
                  <button
                    type="submit"
                    disabled={importingPurchase || importPurchaseId === ''}
                    className="rounded-lg bg-blue-600 px-4 py-1.5 font-semibold text-white hover:bg-blue-700 disabled:opacity-50"
                  >
                    {importingPurchase ? '取込中...' : '原価伝票を取込生成'}
                  </button>
                </div>
              </form>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
