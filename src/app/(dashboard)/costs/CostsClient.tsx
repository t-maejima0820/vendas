'use client';

import Decimal from 'decimal.js';
import Link from 'next/link';
import { useMemo, useState } from 'react';
import {
  calculateSalesSlip,
  type CostCategory,
  type RoundingMode,
  type TaxCode,
} from '@/lib/domain/calculations';
import { COST_CATEGORY_LABELS, computePageCount } from '@/lib/estimates/types';
import { normalizeNullableText, requestMasterApi } from '@/lib/masters/client-api';
import type {
  CandidatePurchaseForCostDto,
  ProjectCostDetailDto,
  ProjectCostInput,
  ProjectCostLineInput,
  ProjectCostPageDto,
} from '@/lib/project-costs/types';
import {
  COST_CATEGORY_LIST,
  PROJECT_STATUS_LABELS,
  type ProjectStatus,
  type ProjectsLookupsDto,
} from '@/lib/projects/types';

export interface CostProjectOption {
  id: string;
  projectNo: number;
  projectName: string;
  status: ProjectStatus;
  partnerName: string;
}

interface CostsClientProps {
  todayIso: string;
  lookups: ProjectsLookupsDto;
  projectOptions: CostProjectOption[];
  initialCategory: CostCategory | null;
  initialProjectId: string;
  initialPage: ProjectCostPageDto;
}

interface CostFilterState {
  costCategory: '' | CostCategory;
  projectId: string;
  status: '' | ProjectStatus;
  dateFrom: string;
  dateTo: string;
  keyword: string;
}

interface CostFormLineState {
  key: string;
  productId: string | null;
  itemCode: string;
  itemName: string;
  unitName: string;
  isHeading: boolean;
  quantityStr: string;
  taxCode: TaxCode;
  masterUnitPrice: number | null;
  appliedUnitPriceStr: string;
  remarks: string;
}

interface CostFormState {
  id: string | null;
  projectId: string;
  costCategory: CostCategory;
  slipTitle: string;
  entryDate: string;
  status: ProjectStatus;
  roundingMode: RoundingMode;
  lines: CostFormLineState[];
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
  if (cleaned === '') return '0';
  try {
    const dec = new Decimal(cleaned);
    if (!dec.isFinite()) return '0';
    return dec.toDecimalPlaces(4, Decimal.ROUND_HALF_UP).toString();
  } catch {
    return '0';
  }
}

function newEmptyCostLine(seed: number): CostFormLineState {
  return {
    key: `cl-${seed}-${Date.now()}`,
    productId: null,
    itemCode: '',
    itemName: '',
    unitName: '式',
    isHeading: false,
    quantityStr: '1',
    taxCode: 'A',
    masterUnitPrice: null,
    appliedUnitPriceStr: '0',
    remarks: '',
  };
}

function buildFilterQuery(filters: CostFilterState, page: number, pageSize: number): URLSearchParams {
  const qs = new URLSearchParams();
  if (filters.costCategory !== '') qs.set('costCategory', filters.costCategory);
  if (filters.projectId !== '') qs.set('projectId', filters.projectId);
  if (filters.status !== '') qs.set('status', filters.status);
  if (filters.dateFrom !== '') qs.set('dateFrom', filters.dateFrom);
  if (filters.dateTo !== '') qs.set('dateTo', filters.dateTo);
  if (filters.keyword.trim() !== '') qs.set('keyword', filters.keyword.trim());
  qs.set('page', String(page));
  qs.set('pageSize', String(pageSize));
  return qs;
}

function buildInitialCostForm(
  todayIso: string,
  lookups: ProjectsLookupsDto,
  projectOptions: CostProjectOption[],
  defaultProjectId: string,
  defaultCategory: CostCategory | null,
): CostFormState {
  const pickedProject =
    defaultProjectId !== ''
      ? defaultProjectId
      : projectOptions.length > 0
        ? projectOptions[0]!.id
        : '';
  return {
    id: null,
    projectId: pickedProject,
    costCategory: defaultCategory !== null ? defaultCategory : 'EXPENSE',
    slipTitle: '',
    entryDate: todayIso,
    status: 'C2',
    roundingMode: lookups.defaultRoundingMode,
    lines: [newEmptyCostLine(1)],
  };
}

export default function CostsClient({
  todayIso,
  lookups,
  projectOptions,
  initialCategory,
  initialProjectId,
  initialPage,
}: CostsClientProps) {
  const [pageData, setPageData] = useState<ProjectCostPageDto>(initialPage);
  const [filters, setFilters] = useState<CostFilterState>({
    costCategory: initialCategory !== null ? initialCategory : '',
    projectId: initialProjectId,
    status: '',
    dateFrom: '',
    dateTo: '',
    keyword: '',
  });
  const [loading, setLoading] = useState(false);
  const [message, setMessage] = useState<{ type: 'success' | 'error'; text: string } | null>(null);

  // Create/Edit Modal
  const [editorOpen, setEditorOpen] = useState(false);
  const [form, setForm] = useState<CostFormState>(() =>
    buildInitialCostForm(todayIso, lookups, projectOptions, initialProjectId, initialCategory),
  );
  const [lineSeed, setLineSeed] = useState(10);
  const [selectedProductId, setSelectedProductId] = useState('');
  const [selectedIntelId, setSelectedIntelId] = useState('');
  const [submitting, setSubmitting] = useState(false);

  // Import from Purchase Modal
  const [purchaseModalOpen, setPurchaseModalOpen] = useState(false);
  const [importProjectId, setImportProjectId] = useState(
    initialProjectId !== ''
      ? initialProjectId
      : projectOptions.length > 0
        ? projectOptions[0]!.id
        : '',
  );
  const [candidates, setCandidates] = useState<CandidatePurchaseForCostDto[]>([]);
  const [candidatesLoading, setCandidatesLoading] = useState(false);
  const [importPurchaseId, setImportPurchaseId] = useState('');
  const [importCategory, setImportCategory] = useState<CostCategory>(
    initialCategory !== null ? initialCategory : 'MATERIAL',
  );
  const [importSlipTitle, setImportSlipTitle] = useState('');
  const [importEntryDate, setImportEntryDate] = useState(todayIso);
  const [importStatus, setImportStatus] = useState<ProjectStatus>('C2');
  const [importing, setImporting] = useState(false);

  const totalPages = computePageCount(pageData.summary.totalCount, pageData.pageSize);

  const exportCsvHref = useMemo(() => {
    const qs = buildFilterQuery(filters, 1, 25);
    qs.set('format', 'csv');
    return `/api/v1/project-costs/export?${qs.toString()}`;
  }, [filters]);

  const exportPdfHref = useMemo(() => {
    const qs = buildFilterQuery(filters, 1, 25);
    qs.set('format', 'pdf');
    qs.set('inline', '1');
    return `/api/v1/project-costs/export?${qs.toString()}`;
  }, [filters]);

  const slipPreview = useMemo(() => {
    const calcInputs = form.lines.map((line, idx) => ({
      lineNo: idx + 1,
      isHeading: line.isHeading,
      quantity: line.isHeading ? '0' : parseQtyForCalc(line.quantityStr),
      appliedUnitPrice: line.isHeading ? 0n : BigInt(parseIntOrZero(line.appliedUnitPriceStr)),
      taxCode: line.isHeading ? ('C' as TaxCode) : line.taxCode,
    }));
    return calculateSalesSlip(calcInputs, form.roundingMode, lookups.taxCalcPolicy);
  }, [form.lines, form.roundingMode, lookups.taxCalcPolicy]);

  const cutoffWarning =
    form.status === 'C3' && form.entryDate !== '' && form.entryDate <= lookups.openingBalanceDate;

  async function fetchCosts(targetFilters: CostFilterState, page: number) {
    setLoading(true);
    setMessage(null);
    const qs = buildFilterQuery(targetFilters, page, pageData.pageSize);
    const res = await requestMasterApi<ProjectCostPageDto & { ok: true }>(
      `/api/v1/project-costs?${qs.toString()}`,
    );
    setLoading(false);
    if (!res.ok) {
      setMessage({ type: 'error', text: res.error });
      return;
    }
    setPageData(res.data);
  }

  async function handleSelectCategoryTab(category: '' | CostCategory) {
    const next = { ...filters, costCategory: category };
    setFilters(next);
    await fetchCosts(next, 1);
  }

  async function handleSearch(e: React.FormEvent) {
    e.preventDefault();
    await fetchCosts(filters, 1);
  }

  async function handleResetFilters() {
    const reset: CostFilterState = {
      costCategory: '',
      projectId: '',
      status: '',
      dateFrom: '',
      dateTo: '',
      keyword: '',
    };
    setFilters(reset);
    await fetchCosts(reset, 1);
  }

  function openNewCostModal() {
    setForm(
      buildInitialCostForm(
        todayIso,
        lookups,
        projectOptions,
        filters.projectId,
        filters.costCategory !== '' ? filters.costCategory : null,
      ),
    );
    setSelectedProductId('');
    setSelectedIntelId('');
    setEditorOpen(true);
  }

  async function openEditCostModal(costId: string) {
    setMessage(null);
    const res = await requestMasterApi<{ ok: true; item: ProjectCostDetailDto }>(
      `/api/v1/project-costs/${costId}`,
    );
    if (!res.ok) {
      setMessage({ type: 'error', text: res.error });
      return;
    }
    const item = res.data.item;
    setForm({
      id: item.id,
      projectId: item.projectId,
      costCategory: item.costCategory,
      slipTitle: item.slipTitle,
      entryDate: item.entryDate,
      status: item.status,
      roundingMode: item.roundingMode,
      lines: item.lines.map((l, idx) => ({
        key: `${l.id}-${idx}`,
        productId: l.productId,
        itemCode: l.itemCode !== null ? l.itemCode : '',
        itemName: l.itemName,
        unitName: l.unitName !== null ? l.unitName : '式',
        isHeading: l.quantity === 0 && l.appliedUnitPrice === 0,
        quantityStr: String(l.quantity),
        taxCode: l.taxCode,
        masterUnitPrice: l.masterUnitPrice,
        appliedUnitPriceStr: String(l.appliedUnitPrice),
        remarks: l.remarks !== null ? l.remarks : '',
      })),
    });
    setEditorOpen(true);
  }

  function addProductLine() {
    if (selectedProductId === '') return;
    const prod = lookups.products.find((p) => p.id === selectedProductId);
    if (prod === undefined) return;
    const nextSeed = lineSeed + 1;
    setLineSeed(nextSeed);
    setForm((prev) => ({
      ...prev,
      lines: [
        ...prev.lines,
        {
          key: `prod-${nextSeed}`,
          productId: prod.id,
          itemCode: prod.productCode,
          itemName: prod.productName,
          unitName: prod.unitName !== null ? prod.unitName : '式',
          isHeading: prod.isHeading,
          quantityStr: prod.isHeading ? '0' : '1',
          taxCode: prod.defaultTaxCode,
          masterUnitPrice: prod.standardCostPrice,
          appliedUnitPriceStr: String(prod.standardCostPrice),
          remarks: '',
        },
      ],
    }));
    setSelectedProductId('');
  }

  function addIntelLine() {
    if (selectedIntelId === '') return;
    const intel = lookups.intelligences.find((i) => i.id === selectedIntelId);
    if (intel === undefined) return;
    const nextSeed = lineSeed + 1;
    setLineSeed(nextSeed);
    setForm((prev) => ({
      ...prev,
      lines: [
        ...prev.lines,
        {
          key: `intel-${nextSeed}`,
          productId: null,
          itemCode: '',
          itemName: intel.itemName,
          unitName: intel.unitName !== null ? intel.unitName : '式',
          isHeading: false,
          quantityStr: '1',
          taxCode: intel.taxCode,
          masterUnitPrice: intel.costPrice,
          appliedUnitPriceStr: String(intel.costPrice),
          remarks: '',
        },
      ],
    }));
    setSelectedIntelId('');
  }

  function addEmptyLine() {
    const nextSeed = lineSeed + 1;
    setLineSeed(nextSeed);
    setForm((prev) => ({
      ...prev,
      lines: [...prev.lines, newEmptyCostLine(nextSeed)],
    }));
  }

  function removeLine(index: number) {
    setForm((prev) => ({
      ...prev,
      lines: prev.lines.filter((_, idx) => idx !== index),
    }));
  }

  function moveLine(index: number, dir: -1 | 1) {
    const target = index + dir;
    if (target < 0 || target >= form.lines.length) return;
    setForm((prev) => {
      const copied = [...prev.lines];
      const temp = copied[index]!;
      copied[index] = copied[target]!;
      copied[target] = temp;
      return { ...prev, lines: copied };
    });
  }

  function updateLineField(index: number, patch: Partial<CostFormLineState>) {
    setForm((prev) => ({
      ...prev,
      lines: prev.lines.map((line, idx) => (idx === index ? { ...line, ...patch } : line)),
    }));
  }

  async function handleSaveCost(e: React.FormEvent) {
    e.preventDefault();
    if (form.lines.length === 0) {
      setMessage({ type: 'error', text: '明細を1行以上追加してください。' });
      return;
    }
    setSubmitting(true);
    setMessage(null);

    const payloadLines: ProjectCostLineInput[] = form.lines.map((line) => ({
      productId: line.productId,
      itemCode: normalizeNullableText(line.itemCode),
      itemName: line.itemName.trim(),
      unitName: normalizeNullableText(line.unitName),
      isHeading: line.isHeading,
      quantity: line.isHeading ? 0 : Number(parseQtyForCalc(line.quantityStr)),
      taxCode: line.isHeading ? 'C' : line.taxCode,
      masterUnitPrice: line.masterUnitPrice,
      appliedUnitPrice: line.isHeading ? 0 : parseIntOrZero(line.appliedUnitPriceStr),
      remarks: normalizeNullableText(line.remarks),
    }));

    const payload: ProjectCostInput = {
      projectId: form.projectId,
      costCategory: form.costCategory,
      slipTitle: form.slipTitle.trim(),
      entryDate: form.entryDate,
      status: form.status,
      roundingMode: form.roundingMode,
      lines: payloadLines,
    };

    const url =
      form.id === null ? '/api/v1/project-costs' : `/api/v1/project-costs/${form.id}`;
    const method = form.id === null ? 'POST' : 'PUT';

    const res = await requestMasterApi<{ ok: true; item: ProjectCostDetailDto }>(url, {
      method,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    setSubmitting(false);

    if (!res.ok) {
      setMessage({ type: 'error', text: res.error });
      return;
    }

    setEditorOpen(false);
    setMessage({
      type: 'success',
      text: `原価伝票「${res.data.item.slipTitle}」（${res.data.item.categoryLabel}）を保存しました。`,
    });
    await fetchCosts(filters, form.id === null ? 1 : pageData.page);
  }

  async function handleDeleteCost(costId: string, slipTitle: string) {
    if (!window.confirm(`原価伝票「${slipTitle}」を削除してもよろしいですか？`)) return;
    setMessage(null);
    const res = await requestMasterApi<{ ok: true }>(`/api/v1/project-costs/${costId}`, {
      method: 'DELETE',
    });
    if (!res.ok) {
      setMessage({ type: 'error', text: res.error });
      return;
    }
    setMessage({ type: 'success', text: `原価伝票「${slipTitle}」を削除しました。` });
    await fetchCosts(filters, pageData.page);
  }

  async function loadPurchaseCandidates(targetProjectId: string) {
    if (targetProjectId === '') {
      setCandidates([]);
      setImportPurchaseId('');
      return;
    }
    setCandidatesLoading(true);
    const res = await requestMasterApi<{ ok: true; items: CandidatePurchaseForCostDto[] }>(
      `/api/v1/project-costs/from-purchase?projectId=${encodeURIComponent(targetProjectId)}`,
    );
    setCandidatesLoading(false);
    if (!res.ok) {
      setMessage({ type: 'error', text: res.error });
      return;
    }
    setCandidates(res.data.items);
    const firstAvail = res.data.items.find((c) => !c.isFullyImported);
    setImportPurchaseId(firstAvail !== undefined ? firstAvail.purchaseId : '');
  }

  async function openPurchaseImportModal() {
    const pid =
      filters.projectId !== ''
        ? filters.projectId
        : projectOptions.length > 0
          ? projectOptions[0]!.id
          : '';
    setImportProjectId(pid);
    setImportCategory(filters.costCategory !== '' ? filters.costCategory : 'MATERIAL');
    setImportSlipTitle('');
    setImportEntryDate(todayIso);
    setImportStatus('C2');
    setPurchaseModalOpen(true);
    await loadPurchaseCandidates(pid);
  }

  async function handleImportFromPurchaseSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (importProjectId === '' || importPurchaseId === '') return;
    setImporting(true);
    setMessage(null);

    const res = await requestMasterApi<{ ok: true; item: ProjectCostDetailDto }>(
      '/api/v1/project-costs/from-purchase',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          projectId: importProjectId,
          purchaseId: importPurchaseId,
          costCategory: importCategory,
          slipTitle: normalizeNullableText(importSlipTitle),
          entryDate: importEntryDate,
          status: importStatus,
        }),
      },
    );
    setImporting(false);
    if (!res.ok) {
      setMessage({ type: 'error', text: res.error });
      return;
    }
    setPurchaseModalOpen(false);
    setMessage({
      type: 'success',
      text: `仕入伝票から原価伝票「${res.data.item.slipTitle}」を生成しました。`,
    });
    await fetchCosts(filters, 1);
  }

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold text-slate-900">原価6費目管理</h1>
          <p className="text-sm text-slate-600 mt-0.5">
            経費・労務費・材料費・外注費・仮設費・諸経費の原価伝票登録と仕入転記取込（期首基準日:{' '}
            <span className="font-mono">{lookups.openingBalanceDate}</span>）
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          {lookups.constructionEnabled && (
            <Link
              href="/projects"
              className="rounded-lg border border-slate-300 bg-white px-3.5 py-2 text-sm font-medium text-slate-700 hover:bg-slate-50"
            >
              案件・工事台帳へ
            </Link>
          )}
          <a
            href={exportCsvHref}
            className="rounded-lg border border-slate-300 bg-white px-3.5 py-2 text-sm font-medium text-slate-700 hover:bg-slate-50"
          >
            原価一覧 CSV
          </a>
          <a
            href={exportPdfHref}
            target="_blank"
            rel="noopener noreferrer"
            className="rounded-lg border border-slate-300 bg-white px-3.5 py-2 text-sm font-medium text-slate-700 hover:bg-slate-50"
          >
            原価一覧 PDF
          </a>
          <button
            type="button"
            onClick={openPurchaseImportModal}
            className="rounded-lg border border-blue-200 bg-blue-50 px-3.5 py-2 text-sm font-medium text-blue-700 hover:bg-blue-100"
          >
            仕入伝票から原価取込
          </button>
          <button
            type="button"
            onClick={openNewCostModal}
            className="rounded-lg bg-blue-600 px-4 py-2 text-sm font-semibold text-white hover:bg-blue-700"
          >
            ＋ 原価伝票登録
          </button>
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

      {/* Category Tabs */}
      <div className="flex flex-wrap gap-1.5 border-b border-slate-200 pb-2">
        <button
          type="button"
          onClick={() => handleSelectCategoryTab('')}
          className={`rounded-lg px-3.5 py-1.5 text-sm font-medium transition-colors ${
            filters.costCategory === ''
              ? 'bg-slate-900 text-white'
              : 'bg-white border border-slate-300 text-slate-700 hover:bg-slate-50'
          }`}
        >
          全費目
        </button>
        {COST_CATEGORY_LIST.map((cat) => {
          const isSelected = filters.costCategory === cat;
          const catSummary = pageData.summary.byCategory.find((c) => c.category === cat);
          return (
            <button
              key={cat}
              type="button"
              onClick={() => handleSelectCategoryTab(cat)}
              className={`rounded-lg px-3 py-1.5 text-sm font-medium transition-colors ${
                isSelected
                  ? 'bg-blue-600 text-white'
                  : 'bg-white border border-slate-300 text-slate-700 hover:bg-slate-50'
              }`}
            >
              {COST_CATEGORY_LABELS[cat]}
              {catSummary !== undefined && (
                <span className="ml-1.5 text-xs opacity-80">({catSummary.headerCount})</span>
              )}
            </button>
          );
        })}
      </div>

      {/* Category & Total KPI Strip */}
      <div className="grid grid-cols-2 md:grid-cols-4 lg:grid-cols-7 gap-2.5">
        <div className="rounded-xl border border-slate-300 bg-slate-900 text-white p-3">
          <div className="text-[11px] opacity-80">検索結果合計 ({pageData.summary.totalCount}件)</div>
          <div className="mt-1 text-base font-bold font-mono">
            {formatYen(pageData.summary.totalAmount)}
          </div>
          <div className="text-[11px] font-mono opacity-80">
            税抜 {formatYen(pageData.summary.subtotalAmount)}
          </div>
        </div>
        {pageData.summary.byCategory.map((cat) => (
          <div key={cat.category} className="rounded-xl border border-slate-200 bg-white p-3">
            <div className="text-[11px] font-medium text-slate-500">
              {cat.categoryLabel} ({cat.headerCount}件)
            </div>
            <div className="mt-1 text-sm font-bold font-mono text-slate-900">
              {formatYen(cat.totalAmount)}
            </div>
            <div className="text-[11px] font-mono text-slate-500">
              税抜 {formatYen(cat.subtotalAmount)}
            </div>
          </div>
        ))}
      </div>

      {/* Search Filters */}
      <form
        onSubmit={handleSearch}
        className="rounded-xl border border-slate-200 bg-white p-4 grid grid-cols-1 md:grid-cols-6 gap-3 items-end"
      >
        <div className="md:col-span-2">
          <label className="block text-xs font-medium text-slate-600 mb-1">対象案件</label>
          <select
            value={filters.projectId}
            onChange={(e) => setFilters({ ...filters, projectId: e.target.value })}
            className="w-full rounded-lg border border-slate-300 px-3 py-1.5 text-sm"
          >
            <option value="">すべての案件</option>
            {projectOptions.map((p) => (
              <option key={p.id} value={p.id}>
                No.{p.projectNo} : {p.projectName} ({p.partnerName})
              </option>
            ))}
          </select>
        </div>

        <div>
          <label className="block text-xs font-medium text-slate-600 mb-1">ステータス</label>
          <select
            value={filters.status}
            onChange={(e) =>
              setFilters({ ...filters, status: e.target.value as '' | ProjectStatus })
            }
            className="w-full rounded-lg border border-slate-300 px-3 py-1.5 text-sm"
          >
            <option value="">すべて</option>
            <option value="C1">C1: {PROJECT_STATUS_LABELS.C1}</option>
            <option value="C2">C2: {PROJECT_STATUS_LABELS.C2}</option>
            <option value="C3">C3: {PROJECT_STATUS_LABELS.C3}</option>
          </select>
        </div>

        <div>
          <label className="block text-xs font-medium text-slate-600 mb-1">計上日 From</label>
          <input
            type="date"
            value={filters.dateFrom}
            onChange={(e) => setFilters({ ...filters, dateFrom: e.target.value })}
            className="w-full rounded-lg border border-slate-300 px-2.5 py-1.5 text-sm"
          />
        </div>

        <div>
          <label className="block text-xs font-medium text-slate-600 mb-1">計上日 To</label>
          <input
            type="date"
            value={filters.dateTo}
            onChange={(e) => setFilters({ ...filters, dateTo: e.target.value })}
            className="w-full rounded-lg border border-slate-300 px-2.5 py-1.5 text-sm"
          />
        </div>

        <div>
          <label className="block text-xs font-medium text-slate-600 mb-1">件名/明細キーワード</label>
          <input
            type="text"
            value={filters.keyword}
            onChange={(e) => setFilters({ ...filters, keyword: e.target.value })}
            placeholder="伝票件名・品名"
            className="w-full rounded-lg border border-slate-300 px-3 py-1.5 text-sm"
          />
        </div>

        <div className="md:col-span-6 flex justify-end gap-2">
          <button
            type="button"
            onClick={handleResetFilters}
            className="rounded-lg border border-slate-300 bg-white px-3.5 py-1.5 text-sm text-slate-700 hover:bg-slate-50"
          >
            リセット
          </button>
          <button
            type="submit"
            disabled={loading}
            className="rounded-lg bg-slate-900 px-4 py-1.5 text-sm font-medium text-white hover:bg-slate-800 disabled:opacity-50"
          >
            {loading ? '検索中...' : '検索'}
          </button>
        </div>
      </form>

      {/* Table */}
      <div className="rounded-xl border border-slate-200 bg-white overflow-hidden">
        <div className="overflow-x-auto">
          <table className="min-w-full divide-y divide-slate-200 text-sm">
            <thead className="bg-slate-50 text-xs font-semibold text-slate-600">
              <tr>
                <th className="px-3 py-2.5 text-left">計上日 / 状態</th>
                <th className="px-3 py-2.5 text-left">案件番号・案件名</th>
                <th className="px-3 py-2.5 text-left">費目</th>
                <th className="px-3 py-2.5 text-left">原価伝票件名</th>
                <th className="px-3 py-2.5 text-right">行数</th>
                <th className="px-3 py-2.5 text-right">税抜金額</th>
                <th className="px-3 py-2.5 text-right">消費税</th>
                <th className="px-3 py-2.5 text-right">税込合計</th>
                <th className="px-3 py-2.5 text-right">操作</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {pageData.items.length === 0 ? (
                <tr>
                  <td colSpan={9} className="px-4 py-10 text-center text-slate-500">
                    原価伝票がありません。
                  </td>
                </tr>
              ) : (
                pageData.items.map((row) => (
                  <tr key={row.id} className="hover:bg-slate-50/70">
                    <td className="px-3 py-2.5 whitespace-nowrap">
                      <div className="font-mono text-slate-900">{row.entryDate}</div>
                      <span
                        className={`inline-block rounded px-1.5 py-0.5 text-[10px] font-semibold ${
                          row.status === 'C3'
                            ? 'bg-emerald-100 text-emerald-800'
                            : 'bg-amber-100 text-amber-800'
                        }`}
                      >
                        {row.status}: {PROJECT_STATUS_LABELS[row.status]}
                      </span>
                    </td>
                    <td className="px-3 py-2.5">
                      <Link
                        href={`/projects/${row.projectId}`}
                        className="text-blue-700 hover:underline font-medium"
                      >
                        <span className="font-mono mr-1">#{row.projectNo}</span>
                        {row.projectName}
                      </Link>
                      <div className="text-xs text-slate-500">{row.partnerName}</div>
                    </td>
                    <td className="px-3 py-2.5 whitespace-nowrap">
                      <span className="rounded-md bg-slate-100 px-2 py-0.5 text-xs font-medium text-slate-800">
                        {row.categoryLabel}
                      </span>
                    </td>
                    <td className="px-3 py-2.5">
                      <div className="font-medium text-slate-900">{row.slipTitle}</div>
                      {row.hasPurchaseLink && (
                        <span className="inline-block rounded bg-indigo-100 px-1.5 py-0.5 text-[10px] font-medium text-indigo-800">
                          仕入連携済
                        </span>
                      )}
                    </td>
                    <td className="px-3 py-2.5 text-right font-mono">{row.lineCount}</td>
                    <td className="px-3 py-2.5 text-right font-mono">
                      {formatYen(row.subtotalAmount)}
                    </td>
                    <td className="px-3 py-2.5 text-right font-mono">
                      {formatYen(row.taxTotal)}
                    </td>
                    <td className="px-3 py-2.5 text-right font-mono font-semibold text-slate-900">
                      {formatYen(row.totalAmount)}
                    </td>
                    <td className="px-3 py-2.5 text-right whitespace-nowrap">
                      <div className="flex justify-end gap-1.5">
                        <button
                          type="button"
                          onClick={() => openEditCostModal(row.id)}
                          className="rounded border border-slate-300 bg-white px-2.5 py-1 text-xs font-medium text-slate-700 hover:bg-slate-50"
                        >
                          編集
                        </button>
                        <button
                          type="button"
                          onClick={() => handleDeleteCost(row.id, row.slipTitle)}
                          className="rounded border border-red-200 bg-white px-2.5 py-1 text-xs text-red-600 hover:bg-red-50"
                        >
                          削除
                        </button>
                      </div>
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>

        <div className="flex items-center justify-between border-t border-slate-200 bg-slate-50 px-4 py-2.5 text-xs text-slate-600">
          <div>
            全 {pageData.summary.totalCount} 件（ページ {pageData.page} / {totalPages}）
          </div>
          <div className="flex items-center gap-2">
            <button
              type="button"
              disabled={pageData.page <= 1 || loading}
              onClick={() => fetchCosts(filters, pageData.page - 1)}
              className="rounded border border-slate-300 bg-white px-2.5 py-1 disabled:opacity-40"
            >
              前へ
            </button>
            <button
              type="button"
              disabled={pageData.page >= totalPages || loading}
              onClick={() => fetchCosts(filters, pageData.page + 1)}
              className="rounded border border-slate-300 bg-white px-2.5 py-1 disabled:opacity-40"
            >
              次へ
            </button>
          </div>
        </div>
      </div>

      {/* Create / Edit Cost Slip Modal */}
      {editorOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/50 p-4">
          <div className="w-full max-w-5xl rounded-2xl bg-white shadow-xl border border-slate-200 max-h-[92vh] flex flex-col">
            <div className="flex items-center justify-between border-b border-slate-200 px-6 py-4">
              <h2 className="text-lg font-bold text-slate-900">
                {form.id === null ? '新規原価伝票登録' : '原価伝票編集'}
              </h2>
              <button
                type="button"
                onClick={() => setEditorOpen(false)}
                className="rounded-lg px-2.5 py-1 text-sm text-slate-500 hover:bg-slate-100"
              >
                ✕ 閉じる
              </button>
            </div>

            <form onSubmit={handleSaveCost} className="overflow-y-auto p-6 space-y-5 text-sm">
              {cutoffWarning && (
                <div className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-800">
                  注意: 期首残高基準日（{lookups.openingBalanceDate}）以前の計上日で確定（C3）登録・変更はできません。
                </div>
              )}

              <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
                <div className="md:col-span-2">
                  <label className="block text-xs font-semibold text-slate-700 mb-1">
                    対象案件 *
                  </label>
                  <select
                    required
                    value={form.projectId}
                    onChange={(e) => setForm({ ...form, projectId: e.target.value })}
                    className="w-full rounded-lg border border-slate-300 px-3 py-2"
                  >
                    <option value="">案件を選択してください</option>
                    {projectOptions.map((p) => (
                      <option key={p.id} value={p.id}>
                        No.{p.projectNo} : {p.projectName} ({p.partnerName})
                      </option>
                    ))}
                  </select>
                </div>

                <div>
                  <label className="block text-xs font-semibold text-slate-700 mb-1">
                    原価費目 *
                  </label>
                  <select
                    value={form.costCategory}
                    onChange={(e) =>
                      setForm({ ...form, costCategory: e.target.value as CostCategory })
                    }
                    className="w-full rounded-lg border border-slate-300 px-3 py-2"
                  >
                    {COST_CATEGORY_LIST.map((cat) => (
                      <option key={cat} value={cat}>
                        {COST_CATEGORY_LABELS[cat]}
                      </option>
                    ))}
                  </select>
                </div>

                <div className="md:col-span-2">
                  <label className="block text-xs font-semibold text-slate-700 mb-1">
                    原価伝票件名 *
                  </label>
                  <input
                    type="text"
                    required
                    value={form.slipTitle}
                    onChange={(e) => setForm({ ...form, slipTitle: e.target.value })}
                    placeholder="例: 電気資材・作業員外注費"
                    className="w-full rounded-lg border border-slate-300 px-3 py-2"
                  />
                </div>

                <div className="grid grid-cols-3 gap-2">
                  <div>
                    <label className="block text-xs font-semibold text-slate-700 mb-1">計上日 *</label>
                    <input
                      type="date"
                      required
                      value={form.entryDate}
                      onChange={(e) => setForm({ ...form, entryDate: e.target.value })}
                      className="w-full rounded-lg border border-slate-300 px-2 py-2 text-xs"
                    />
                  </div>
                  <div>
                    <label className="block text-xs font-semibold text-slate-700 mb-1">状態</label>
                    <select
                      value={form.status}
                      onChange={(e) =>
                        setForm({ ...form, status: e.target.value as ProjectStatus })
                      }
                      className="w-full rounded-lg border border-slate-300 px-2 py-2 text-xs"
                    >
                      <option value="C1">C1: 新規</option>
                      <option value="C2">C2: 仕掛</option>
                      <option value="C3">C3: 確定</option>
                    </select>
                  </div>
                  <div>
                    <label className="block text-xs font-semibold text-slate-700 mb-1">端数</label>
                    <select
                      value={form.roundingMode}
                      onChange={(e) =>
                        setForm({ ...form, roundingMode: e.target.value as RoundingMode })
                      }
                      className="w-full rounded-lg border border-slate-300 px-2 py-2 text-xs"
                    >
                      <option value="FLOOR">切捨</option>
                      <option value="ROUND">四捨五入</option>
                      <option value="CEIL">切上</option>
                    </select>
                  </div>
                </div>
              </div>

              {/* Quick-add masters */}
              <div className="flex flex-wrap items-center gap-2 rounded-xl border border-slate-200 bg-slate-50 p-3 text-xs">
                <select
                  value={selectedProductId}
                  onChange={(e) => setSelectedProductId(e.target.value)}
                  className="rounded-lg border border-slate-300 bg-white px-2.5 py-1.5 max-w-[260px]"
                >
                  <option value="">商品マスタから追加...</option>
                  {lookups.products.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.productCode} : {p.productName} ({formatYen(p.standardCostPrice)})
                    </option>
                  ))}
                </select>
                <button
                  type="button"
                  onClick={addProductLine}
                  disabled={selectedProductId === ''}
                  className="rounded-lg border border-slate-300 bg-white px-3 py-1.5 font-medium disabled:opacity-40"
                >
                  ＋ 商品追加
                </button>

                <select
                  value={selectedIntelId}
                  onChange={(e) => setSelectedIntelId(e.target.value)}
                  className="rounded-lg border border-slate-300 bg-white px-2.5 py-1.5 max-w-[240px]"
                >
                  <option value="">インテリジェンス追加...</option>
                  {lookups.intelligences.map((i) => (
                    <option key={i.id} value={i.id}>
                      {i.itemName} ({formatYen(i.costPrice)})
                    </option>
                  ))}
                </select>
                <button
                  type="button"
                  onClick={addIntelLine}
                  disabled={selectedIntelId === ''}
                  className="rounded-lg border border-slate-300 bg-white px-3 py-1.5 font-medium disabled:opacity-40"
                >
                  ＋ 履歴追加
                </button>

                <button
                  type="button"
                  onClick={addEmptyLine}
                  className="ml-auto rounded-lg bg-slate-900 px-3 py-1.5 font-medium text-white hover:bg-slate-800"
                >
                  ＋ 空行を追加
                </button>
              </div>

              {/* Lines Editor */}
              <div className="overflow-x-auto rounded-xl border border-slate-200">
                <table className="min-w-full divide-y divide-slate-200 text-xs">
                  <thead className="bg-slate-50 font-semibold text-slate-600">
                    <tr>
                      <th className="px-2 py-2 w-8">#</th>
                      <th className="px-2 py-2 text-left">品名・作業内容 *</th>
                      <th className="px-2 py-2 w-20 text-left">単位</th>
                      <th className="px-2 py-2 w-24 text-right">数量</th>
                      <th className="px-2 py-2 w-28 text-right">原価単価(円)</th>
                      <th className="px-2 py-2 w-28 text-left">税区分</th>
                      <th className="px-2 py-2 w-28 text-right">小計(税込)</th>
                      <th className="px-2 py-2 w-32 text-left">備考</th>
                      <th className="px-2 py-2 w-20 text-right">操作</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100">
                    {form.lines.map((line, idx) => {
                      const calcLine = slipPreview.lineResults[idx];
                      return (
                        <tr key={line.key}>
                          <td className="px-2 py-1.5 font-mono text-slate-500">{idx + 1}</td>
                          <td className="px-2 py-1.5">
                            <input
                              type="text"
                              required
                              value={line.itemName}
                              onChange={(e) => updateLineField(idx, { itemName: e.target.value })}
                              className="w-full min-w-[180px] rounded border border-slate-300 px-2 py-1"
                            />
                          </td>
                          <td className="px-2 py-1.5">
                            <input
                              type="text"
                              value={line.unitName}
                              onChange={(e) => updateLineField(idx, { unitName: e.target.value })}
                              className="w-full rounded border border-slate-300 px-2 py-1"
                            />
                          </td>
                          <td className="px-2 py-1.5">
                            <input
                              type="number"
                              step="0.0001"
                              value={line.quantityStr}
                              onChange={(e) =>
                                updateLineField(idx, { quantityStr: e.target.value })
                              }
                              className="w-full rounded border border-slate-300 px-2 py-1 text-right font-mono"
                            />
                          </td>
                          <td className="px-2 py-1.5">
                            <input
                              type="number"
                              value={line.appliedUnitPriceStr}
                              onChange={(e) =>
                                updateLineField(idx, { appliedUnitPriceStr: e.target.value })
                              }
                              className="w-full rounded border border-slate-300 px-2 py-1 text-right font-mono"
                            />
                          </td>
                          <td className="px-2 py-1.5">
                            <select
                              value={line.taxCode}
                              onChange={(e) =>
                                updateLineField(idx, { taxCode: e.target.value as TaxCode })
                              }
                              className="w-full rounded border border-slate-300 px-1.5 py-1"
                            >
                              {lookups.taxCodes.map((tc) => (
                                <option key={tc.taxCode} value={tc.taxCode}>
                                  {tc.taxCode}: {tc.taxName}
                                </option>
                              ))}
                            </select>
                          </td>
                          <td className="px-2 py-1.5 text-right font-mono font-semibold">
                            {calcLine !== undefined ? formatYen(Number(calcLine.rowTotal)) : '¥0'}
                          </td>
                          <td className="px-2 py-1.5">
                            <input
                              type="text"
                              value={line.remarks}
                              onChange={(e) => updateLineField(idx, { remarks: e.target.value })}
                              className="w-full rounded border border-slate-300 px-2 py-1"
                            />
                          </td>
                          <td className="px-2 py-1.5 text-right whitespace-nowrap">
                            <button
                              type="button"
                              disabled={idx === 0}
                              onClick={() => moveLine(idx, -1)}
                              className="px-1 text-slate-500 disabled:opacity-30"
                            >
                              ↑
                            </button>
                            <button
                              type="button"
                              disabled={idx === form.lines.length - 1}
                              onClick={() => moveLine(idx, 1)}
                              className="px-1 text-slate-500 disabled:opacity-30"
                            >
                              ↓
                            </button>
                            <button
                              type="button"
                              disabled={form.lines.length <= 1}
                              onClick={() => removeLine(idx)}
                              className="ml-1 text-red-600 disabled:opacity-30"
                            >
                              ✕
                            </button>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>

              {/* Real-time Totals */}
              <div className="flex flex-wrap items-center justify-between gap-4 rounded-xl border border-slate-200 bg-slate-50 px-4 py-3 text-sm">
                <div className="text-xs text-slate-600">
                  端数・税計算方式: <span className="font-mono">{lookups.taxCalcPolicy}</span>
                </div>
                <div className="flex items-center gap-6 font-mono">
                  <span>
                    税抜合計: <strong>{formatYen(Number(slipPreview.subtotalAmount))}</strong>
                  </span>
                  <span>
                    消費税: <strong>{formatYen(Number(slipPreview.taxTotal))}</strong>
                  </span>
                  <span className="text-base text-blue-700">
                    税込合計: <strong>{formatYen(Number(slipPreview.totalAmount))}</strong>
                  </span>
                </div>
              </div>

              <div className="flex justify-end gap-2 border-t border-slate-200 pt-4">
                <button
                  type="button"
                  onClick={() => setEditorOpen(false)}
                  className="rounded-lg border border-slate-300 bg-white px-4 py-2 text-sm text-slate-700 hover:bg-slate-50"
                >
                  キャンセル
                </button>
                <button
                  type="submit"
                  disabled={submitting || cutoffWarning}
                  className="rounded-lg bg-blue-600 px-5 py-2 text-sm font-semibold text-white hover:bg-blue-700 disabled:opacity-50"
                >
                  {submitting ? '保存中...' : '原価伝票を保存する'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* Import from Purchase Modal */}
      {purchaseModalOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/50 p-4">
          <div className="w-full max-w-xl rounded-2xl bg-white shadow-xl border border-slate-200 p-6 space-y-4">
            <div className="flex items-center justify-between border-b border-slate-200 pb-3">
              <h2 className="text-base font-bold text-slate-900">仕入伝票から原価伝票を取込生成</h2>
              <button
                type="button"
                onClick={() => setPurchaseModalOpen(false)}
                className="text-sm text-slate-500 hover:text-slate-800"
              >
                ✕
              </button>
            </div>

            <form onSubmit={handleImportFromPurchaseSubmit} className="space-y-3 text-sm">
              <div>
                <label className="block text-xs font-semibold text-slate-700 mb-1">
                  取込先案件 *
                </label>
                <select
                  required
                  value={importProjectId}
                  onChange={async (e) => {
                    const pid = e.target.value;
                    setImportProjectId(pid);
                    await loadPurchaseCandidates(pid);
                  }}
                  className="w-full rounded-lg border border-slate-300 px-3 py-2"
                >
                  <option value="">案件を選択してください</option>
                  {projectOptions.map((p) => (
                    <option key={p.id} value={p.id}>
                      No.{p.projectNo} : {p.projectName} ({p.partnerName})
                    </option>
                  ))}
                </select>
              </div>

              <div>
                <label className="block text-xs font-semibold text-slate-700 mb-1">
                  対象仕入伝票 *
                </label>
                {candidatesLoading ? (
                  <div className="text-xs text-slate-500 py-2">仕入候補を読み込み中...</div>
                ) : (
                  <select
                    required
                    value={importPurchaseId}
                    onChange={(e) => setImportPurchaseId(e.target.value)}
                    className="w-full rounded-lg border border-slate-300 px-3 py-2"
                  >
                    <option value="">選択してください</option>
                    {candidates.map((c) => (
                      <option
                        key={c.purchaseId}
                        value={c.purchaseId}
                        disabled={c.isFullyImported}
                      >
                        #{c.purchaseNo} ({c.purchaseDate}) {c.purchaseName} - {c.supplierName}{' '}
                        {c.isProjectLinked ? '[案件紐付]' : ''}{' '}
                        {c.isFullyImported ? '[取込済]' : `(${c.matchingLineCount}行)`}
                      </option>
                    ))}
                  </select>
                )}
              </div>

              <div className="grid grid-cols-3 gap-3">
                <div>
                  <label className="block text-xs font-semibold text-slate-700 mb-1">費目 *</label>
                  <select
                    value={importCategory}
                    onChange={(e) => setImportCategory(e.target.value as CostCategory)}
                    className="w-full rounded-lg border border-slate-300 px-2.5 py-2"
                  >
                    {COST_CATEGORY_LIST.map((cat) => (
                      <option key={cat} value={cat}>
                        {COST_CATEGORY_LABELS[cat]}
                      </option>
                    ))}
                  </select>
                </div>
                <div>
                  <label className="block text-xs font-semibold text-slate-700 mb-1">計上日 *</label>
                  <input
                    type="date"
                    required
                    value={importEntryDate}
                    onChange={(e) => setImportEntryDate(e.target.value)}
                    className="w-full rounded-lg border border-slate-300 px-2.5 py-2"
                  />
                </div>
                <div>
                  <label className="block text-xs font-semibold text-slate-700 mb-1">状態</label>
                  <select
                    value={importStatus}
                    onChange={(e) => setImportStatus(e.target.value as ProjectStatus)}
                    className="w-full rounded-lg border border-slate-300 px-2.5 py-2"
                  >
                    <option value="C1">C1: 新規</option>
                    <option value="C2">C2: 仕掛</option>
                    <option value="C3">C3: 確定</option>
                  </select>
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
                  disabled={importing || importPurchaseId === ''}
                  className="rounded-lg bg-blue-600 px-4 py-1.5 font-semibold text-white hover:bg-blue-700 disabled:opacity-50"
                >
                  {importing ? '取込中...' : '仕入から原価伝票を生成'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}
