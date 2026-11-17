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
import { COST_CATEGORY_LABELS, computePageCount } from '@/lib/estimates/types';
import { normalizeNullableText, requestMasterApi } from '@/lib/masters/client-api';
import {
  COST_CATEGORY_LIST,
  PROJECT_STATUS_LABELS,
  type ProjectDetailDto,
  type ProjectInput,
  type ProjectPageDto,
  type ProjectStatus,
  type ProjectsLookupsDto,
} from '@/lib/projects/types';

interface ProjectsClientProps {
  todayIso: string;
  lookups: ProjectsLookupsDto;
  initialPage: ProjectPageDto;
}

interface FilterState {
  keyword: string;
  status: '' | ProjectStatus;
  orderKindCode: string;
  employeeId: string;
  dateFrom: string;
  dateTo: string;
  overBudgetOnly: boolean;
}

interface CreateFormState {
  projectName: string;
  projectDate: string;
  sitePlace: string;
  partnerId: string;
  orderKindCode: string;
  subStatusCode: string;
  status: ProjectStatus;
  periodStartDate: string;
  periodEndDate: string;
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

function buildQueryParams(filters: FilterState, page: number, pageSize: number): URLSearchParams {
  const qs = new URLSearchParams();
  if (filters.keyword.trim() !== '') qs.set('keyword', filters.keyword.trim());
  if (filters.status !== '') qs.set('status', filters.status);
  if (filters.orderKindCode !== '') qs.set('orderKindCode', filters.orderKindCode);
  if (filters.employeeId !== '') qs.set('employeeId', filters.employeeId);
  if (filters.dateFrom !== '') qs.set('dateFrom', filters.dateFrom);
  if (filters.dateTo !== '') qs.set('dateTo', filters.dateTo);
  if (filters.overBudgetOnly) qs.set('overBudgetOnly', '1');
  qs.set('page', String(page));
  qs.set('pageSize', String(pageSize));
  return qs;
}

function createInitialForm(todayIso: string, lookups: ProjectsLookupsDto): CreateFormState {
  const clientPartners = lookups.partners.filter((p) => p.isClient);
  const firstPartnerId =
    clientPartners.length > 0
      ? clientPartners[0]!.id
      : lookups.partners.length > 0
        ? lookups.partners[0]!.id
        : '';

  return {
    projectName: '',
    projectDate: todayIso,
    sitePlace: '',
    partnerId: firstPartnerId,
    orderKindCode: lookups.orderKinds.length > 0 ? lookups.orderKinds[0]!.code : '',
    subStatusCode: lookups.subStatuses.length > 0 ? lookups.subStatuses[0]!.code : '',
    status: 'C1',
    periodStartDate: '',
    periodEndDate: '',
    salesEmployeeId: '',
    siteEmployeeId: '',
    unitName: '式',
    contractUnitPriceStr: '0',
    contractQuantityStr: '1',
    taxCode: 'A',
    roundingMode: lookups.defaultRoundingMode,
    budgets: {
      EXPENSE: '0',
      LABOR: '0',
      MATERIAL: '0',
      OUTSOURCING: '0',
      TEMPORARY: '0',
      INDIRECT: '0',
    },
    remarks: '',
  };
}

const ZERO_BIGINT_COSTS: Readonly<Record<CostCategory, bigint>> = {
  EXPENSE: 0n,
  LABOR: 0n,
  MATERIAL: 0n,
  OUTSOURCING: 0n,
  TEMPORARY: 0n,
  INDIRECT: 0n,
};

export default function ProjectsClient({
  todayIso,
  lookups,
  initialPage,
}: ProjectsClientProps) {
  const [pageData, setPageData] = useState<ProjectPageDto>(initialPage);
  const [filters, setFilters] = useState<FilterState>({
    keyword: '',
    status: '',
    orderKindCode: '',
    employeeId: '',
    dateFrom: '',
    dateTo: '',
    overBudgetOnly: false,
  });
  const [loading, setLoading] = useState(false);
  const [message, setMessage] = useState<{ type: 'success' | 'error'; text: string } | null>(null);

  const [createOpen, setCreateOpen] = useState(false);
  const [partnerFilter, setPartnerFilter] = useState('');
  const [form, setForm] = useState<CreateFormState>(() => createInitialForm(todayIso, lookups));
  const [submitting, setSubmitting] = useState(false);

  const totalPages = computePageCount(pageData.summary.totalCount, pageData.pageSize);

  const exportCsvHref = useMemo(() => {
    const qs = buildQueryParams(filters, 1, 25);
    qs.set('format', 'csv');
    return `/api/v1/projects/export?${qs.toString()}`;
  }, [filters]);

  const exportPdfHref = useMemo(() => {
    const qs = buildQueryParams(filters, 1, 25);
    qs.set('format', 'pdf');
    qs.set('inline', '1');
    return `/api/v1/projects/export?${qs.toString()}`;
  }, [filters]);

  const filteredPartners = useMemo(() => {
    const q = partnerFilter.trim().toLowerCase();
    const list = lookups.partners.filter((p) => {
      if (q === '') return true;
      return (
        p.partnerName.toLowerCase().includes(q) || p.partnerCode.toLowerCase().includes(q)
      );
    });
    return list;
  }, [lookups.partners, partnerFilter]);

  const createPreview = useMemo(() => {
    const unitPriceBig = BigInt(parseIntOrZero(form.contractUnitPriceStr));
    const qtyStr = parseQtyForCalc(form.contractQuantityStr);
    const lineCalc = calculateLineAmounts({
      lineNo: 1,
      quantity: qtyStr,
      unitPrice: unitPriceBig,
      taxCode: form.taxCode,
      roundingMode: form.roundingMode,
    });
    const budgetBigInts: Record<CostCategory, bigint> = {
      EXPENSE: BigInt(parseIntOrZero(form.budgets.EXPENSE)),
      LABOR: BigInt(parseIntOrZero(form.budgets.LABOR)),
      MATERIAL: BigInt(parseIntOrZero(form.budgets.MATERIAL)),
      OUTSOURCING: BigInt(parseIntOrZero(form.budgets.OUTSOURCING)),
      TEMPORARY: BigInt(parseIntOrZero(form.budgets.TEMPORARY)),
      INDIRECT: BigInt(parseIntOrZero(form.budgets.INDIRECT)),
    };
    const profit = calculateProjectProfit({
      costTaxMode: lookups.costTaxMode,
      contractSubtotal: lineCalc.exclAmount,
      contractTotal: lineCalc.rowTotal,
      budgets: budgetBigInts,
      actualCostsExcl: ZERO_BIGINT_COSTS,
      actualCostsIncl: ZERO_BIGINT_COSTS,
    });
    return {
      contractSubtotal: Number(lineCalc.exclAmount),
      contractTax: Number(lineCalc.lineTax),
      contractTotal: Number(lineCalc.rowTotal),
      budgetTotal: Number(profit.budgetTotal),
      budgetGrossProfit: Number(profit.budgetGrossProfit),
    };
  }, [form, lookups.costTaxMode]);

  async function fetchProjects(targetFilters: FilterState, page: number) {
    setLoading(true);
    setMessage(null);
    const qs = buildQueryParams(targetFilters, page, pageData.pageSize);
    const res = await requestMasterApi<ProjectPageDto & { ok: true }>(
      `/api/v1/projects?${qs.toString()}`,
    );
    setLoading(false);
    if (!res.ok) {
      setMessage({ type: 'error', text: res.error });
      return;
    }
    setPageData(res.data);
  }

  async function handleSearch(e: React.FormEvent) {
    e.preventDefault();
    await fetchProjects(filters, 1);
  }

  async function handleResetFilters() {
    const empty: FilterState = {
      keyword: '',
      status: '',
      orderKindCode: '',
      employeeId: '',
      dateFrom: '',
      dateTo: '',
      overBudgetOnly: false,
    };
    setFilters(empty);
    await fetchProjects(empty, 1);
  }

  async function handleCreateSubmit(e: React.FormEvent) {
    e.preventDefault();
    setSubmitting(true);
    setMessage(null);

    const qtyNum = Number(parseQtyForCalc(form.contractQuantityStr));
    const payload: ProjectInput = {
      projectName: form.projectName.trim(),
      projectDate: form.projectDate,
      sitePlace: normalizeNullableText(form.sitePlace),
      partnerId: form.partnerId,
      orderKindCode: normalizeNullableText(form.orderKindCode),
      subStatusCode: normalizeNullableText(form.subStatusCode),
      status: form.status,
      periodStartDate: normalizeNullableText(form.periodStartDate),
      periodEndDate: normalizeNullableText(form.periodEndDate),
      actualStartDate: null,
      tempFinishDate: null,
      finishDate: null,
      salesEmployeeId: normalizeNullableText(form.salesEmployeeId),
      siteEmployeeId: normalizeNullableText(form.siteEmployeeId),
      unitName: form.unitName.trim() === '' ? '式' : form.unitName.trim(),
      contractUnitPrice: parseIntOrZero(form.contractUnitPriceStr),
      contractQuantity: Number.isFinite(qtyNum) && qtyNum > 0 ? qtyNum : 1,
      taxCode: form.taxCode,
      roundingMode: form.roundingMode,
      budgets: {
        EXPENSE: parseIntOrZero(form.budgets.EXPENSE),
        LABOR: parseIntOrZero(form.budgets.LABOR),
        MATERIAL: parseIntOrZero(form.budgets.MATERIAL),
        OUTSOURCING: parseIntOrZero(form.budgets.OUTSOURCING),
        TEMPORARY: parseIntOrZero(form.budgets.TEMPORARY),
        INDIRECT: parseIntOrZero(form.budgets.INDIRECT),
      },
      remarks: normalizeNullableText(form.remarks),
    };

    const res = await requestMasterApi<{ ok: true; item: ProjectDetailDto }>('/api/v1/projects', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    setSubmitting(false);

    if (!res.ok) {
      setMessage({ type: 'error', text: res.error });
      return;
    }

    setCreateOpen(false);
    setForm(createInitialForm(todayIso, lookups));
    setMessage({
      type: 'success',
      text: `案件 No.${res.data.item.projectNo}「${res.data.item.projectName}」を登録しました。`,
    });
    await fetchProjects(filters, 1);
  }

  async function handleDeleteProject(projectId: string, projectNo: number, projectName: string) {
    const confirmed = window.confirm(
      `案件 No.${projectNo}「${projectName}」を削除してもよろしいですか？\n※見積・売上・発注・原価等に紐づく案件は削除できません。`,
    );
    if (!confirmed) return;

    setMessage(null);
    const res = await requestMasterApi<{ ok: true; deletedId: string }>(
      `/api/v1/projects/${projectId}`,
      { method: 'DELETE' },
    );
    if (!res.ok) {
      setMessage({ type: 'error', text: res.error });
      return;
    }
    setMessage({ type: 'success', text: `案件 No.${projectNo} を削除しました。` });
    await fetchProjects(filters, pageData.page);
  }

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold text-slate-900">案件・実行予算・工事台帳</h1>
          <p className="text-sm text-slate-600 mt-0.5">
            原価基準: <span className="font-semibold">{lookups.costTaxMode === 'TAX_EXCLUDED' ? '税抜原価基準' : '税込原価基準'}</span> / 期首基準日:{' '}
            <span className="font-mono">{lookups.openingBalanceDate}</span>
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          {lookups.costEnabled && (
            <Link
              href="/costs"
              className="rounded-lg border border-slate-300 bg-white px-3.5 py-2 text-sm font-medium text-slate-700 hover:bg-slate-50"
            >
              原価6費目管理へ
            </Link>
          )}
          <a
            href={exportCsvHref}
            className="rounded-lg border border-slate-300 bg-white px-3.5 py-2 text-sm font-medium text-slate-700 hover:bg-slate-50"
          >
            工事一覧 CSV
          </a>
          <a
            href={exportPdfHref}
            target="_blank"
            rel="noopener noreferrer"
            className="rounded-lg border border-slate-300 bg-white px-3.5 py-2 text-sm font-medium text-slate-700 hover:bg-slate-50"
          >
            工事一覧 PDF
          </a>
          <button
            type="button"
            onClick={() => {
              setForm(createInitialForm(todayIso, lookups));
              setPartnerFilter('');
              setCreateOpen(true);
            }}
            className="rounded-lg bg-blue-600 px-4 py-2 text-sm font-semibold text-white hover:bg-blue-700"
          >
            ＋ 新規案件登録
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

      {/* KPI Summary Cards */}
      <div className="grid grid-cols-2 lg:grid-cols-5 gap-3">
        <div className="rounded-xl border border-slate-200 bg-white p-4">
          <div className="text-xs font-medium text-slate-500">検索一致件数 / 超過</div>
          <div className="mt-1 flex items-baseline gap-2">
            <span className="text-xl font-bold text-slate-900">{pageData.summary.totalCount}件</span>
            {pageData.summary.overBudgetCount > 0 && (
              <span className="rounded-full bg-red-100 px-2 py-0.5 text-xs font-semibold text-red-700">
                予算超過 {pageData.summary.overBudgetCount}件
              </span>
            )}
          </div>
        </div>

        <div className="rounded-xl border border-slate-200 bg-white p-4">
          <div className="text-xs font-medium text-slate-500">契約総額（税込）</div>
          <div className="mt-1 text-xl font-bold text-slate-900 font-mono">
            {formatYen(pageData.summary.contractTotal)}
          </div>
          <div className="text-xs text-slate-500 font-mono mt-0.5">
            税抜 {formatYen(pageData.summary.contractSubtotal)}
          </div>
        </div>

        <div className="rounded-xl border border-slate-200 bg-white p-4">
          <div className="text-xs font-medium text-slate-500">実行予算合計</div>
          <div className="mt-1 text-xl font-bold text-blue-700 font-mono">
            {formatYen(pageData.summary.budgetTotal)}
          </div>
          <div className="text-xs text-slate-500 font-mono mt-0.5">
            予算粗利 {formatYen(pageData.summary.budgetGrossProfit)}
          </div>
        </div>

        <div className="rounded-xl border border-slate-200 bg-white p-4">
          <div className="text-xs font-medium text-slate-500">
            実績原価合計（{pageData.costTaxMode === 'TAX_EXCLUDED' ? '税抜評価' : '税込評価'}）
          </div>
          <div className="mt-1 text-xl font-bold text-amber-700 font-mono">
            {formatYen(pageData.summary.actualCostEvalTotal)}
          </div>
          <div className="text-xs text-slate-500 font-mono mt-0.5">
            税抜 {formatYen(pageData.summary.actualCostExclTotal)} / 税込{' '}
            {formatYen(pageData.summary.actualCostInclTotal)}
          </div>
        </div>

        <div className="rounded-xl border border-slate-200 bg-white p-4">
          <div className="text-xs font-medium text-slate-500">実績粗利 / 計上売上(税込)</div>
          <div
            className={`mt-1 text-xl font-bold font-mono ${
              pageData.summary.actualGrossProfit < 0 ? 'text-red-700' : 'text-emerald-700'
            }`}
          >
            {formatYen(pageData.summary.actualGrossProfit)}
          </div>
          <div className="text-xs text-slate-500 font-mono mt-0.5">
            計上売上 {formatYen(pageData.summary.salesRecordedIncl)}
          </div>
        </div>
      </div>

      {/* Filters */}
      <form
        onSubmit={handleSearch}
        className="rounded-xl border border-slate-200 bg-white p-4 space-y-3"
      >
        <div className="grid grid-cols-1 md:grid-cols-3 lg:grid-cols-6 gap-3">
          <div className="lg:col-span-2">
            <label className="block text-xs font-medium text-slate-600 mb-1">
              キーワード（番号・案件名・現場・取引先）
            </label>
            <input
              type="text"
              value={filters.keyword}
              onChange={(e) => setFilters({ ...filters, keyword: e.target.value })}
              placeholder="案件名・案件番号・現場住所・顧客名"
              className="w-full rounded-lg border border-slate-300 px-3 py-1.5 text-sm"
            />
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
            <label className="block text-xs font-medium text-slate-600 mb-1">工事区分</label>
            <select
              value={filters.orderKindCode}
              onChange={(e) => setFilters({ ...filters, orderKindCode: e.target.value })}
              className="w-full rounded-lg border border-slate-300 px-3 py-1.5 text-sm"
            >
              <option value="">すべて</option>
              {lookups.orderKinds.map((k) => (
                <option key={k.code} value={k.code}>
                  {k.name}
                </option>
              ))}
            </select>
          </div>

          <div>
            <label className="block text-xs font-medium text-slate-600 mb-1">担当者</label>
            <select
              value={filters.employeeId}
              onChange={(e) => setFilters({ ...filters, employeeId: e.target.value })}
              className="w-full rounded-lg border border-slate-300 px-3 py-1.5 text-sm"
            >
              <option value="">すべて</option>
              {lookups.employees.map((emp) => (
                <option key={emp.id} value={emp.id}>
                  {emp.syainName}
                </option>
              ))}
            </select>
          </div>

          <div className="flex items-end">
            <label className="inline-flex items-center gap-2 text-sm text-slate-700 cursor-pointer pb-1.5">
              <input
                type="checkbox"
                checked={filters.overBudgetOnly}
                onChange={(e) => setFilters({ ...filters, overBudgetOnly: e.target.checked })}
                className="rounded border-slate-300"
              />
              予算超過のみ
            </label>
          </div>
        </div>

        <div className="flex flex-wrap items-end justify-between gap-3">
          <div className="flex flex-wrap items-center gap-2 text-sm">
            <span className="text-xs font-medium text-slate-600">受注日:</span>
            <input
              type="date"
              value={filters.dateFrom}
              onChange={(e) => setFilters({ ...filters, dateFrom: e.target.value })}
              className="rounded-lg border border-slate-300 px-2.5 py-1 text-sm"
            />
            <span className="text-slate-400">〜</span>
            <input
              type="date"
              value={filters.dateTo}
              onChange={(e) => setFilters({ ...filters, dateTo: e.target.value })}
              className="rounded-lg border border-slate-300 px-2.5 py-1 text-sm"
            />
          </div>

          <div className="flex items-center gap-2">
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
        </div>
      </form>

      {/* Projects Table */}
      <div className="rounded-xl border border-slate-200 bg-white overflow-hidden">
        <div className="overflow-x-auto">
          <table className="min-w-full divide-y divide-slate-200 text-sm">
            <thead className="bg-slate-50 text-xs font-semibold text-slate-600">
              <tr>
                <th className="px-3 py-2.5 text-left">案件番号 / 受注日</th>
                <th className="px-3 py-2.5 text-left">案件名 / 現場</th>
                <th className="px-3 py-2.5 text-left">発注元 / 区分</th>
                <th className="px-3 py-2.5 text-left">状態 / 担当</th>
                <th className="px-3 py-2.5 text-right">契約金額(税込)</th>
                <th className="px-3 py-2.5 text-right">実行予算</th>
                <th className="px-3 py-2.5 text-right">実績原価</th>
                <th className="px-3 py-2.5 text-right">粗利 / 粗利率</th>
                <th className="px-3 py-2.5 text-right">予算残 / 操作</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {pageData.items.length === 0 ? (
                <tr>
                  <td colSpan={9} className="px-4 py-10 text-center text-slate-500">
                    条件に一致する案件がありません。
                  </td>
                </tr>
              ) : (
                pageData.items.map((row) => (
                  <tr key={row.id} className="hover:bg-slate-50/70">
                    <td className="px-3 py-2.5 whitespace-nowrap">
                      <Link
                        href={`/projects/${row.id}`}
                        className="font-mono font-semibold text-blue-700 hover:underline"
                      >
                        {row.projectNo}
                      </Link>
                      <div className="text-xs text-slate-500 font-mono">{row.projectDate}</div>
                    </td>
                    <td className="px-3 py-2.5 min-w-[200px]">
                      <Link
                        href={`/projects/${row.id}`}
                        className="font-medium text-slate-900 hover:text-blue-700 hover:underline"
                      >
                        {row.projectName}
                      </Link>
                      {row.sitePlace !== null && (
                        <div className="text-xs text-slate-500 truncate max-w-[260px]">
                          現場: {row.sitePlace}
                        </div>
                      )}
                    </td>
                    <td className="px-3 py-2.5">
                      <div className="text-slate-900">{row.partnerName}</div>
                      <div className="text-xs text-slate-500">
                        {row.orderKindName !== null ? row.orderKindName : '区分未設定'}
                      </div>
                    </td>
                    <td className="px-3 py-2.5 whitespace-nowrap">
                      <span
                        className={`inline-block rounded-full px-2 py-0.5 text-xs font-semibold ${
                          row.status === 'C3'
                            ? 'bg-emerald-100 text-emerald-800'
                            : row.status === 'C2'
                              ? 'bg-amber-100 text-amber-800'
                              : 'bg-blue-100 text-blue-800'
                        }`}
                      >
                        {row.status}: {PROJECT_STATUS_LABELS[row.status]}
                      </span>
                      <div className="text-xs text-slate-500 mt-0.5">
                        {row.salesEmployeeName !== null ? row.salesEmployeeName : '営業未定'} /{' '}
                        {row.siteEmployeeName !== null ? row.siteEmployeeName : '現場未定'}
                      </div>
                    </td>
                    <td className="px-3 py-2.5 text-right font-mono whitespace-nowrap">
                      <div className="font-semibold text-slate-900">
                        {formatYen(row.contractTotal)}
                      </div>
                      <div className="text-xs text-slate-500">
                        税抜 {formatYen(row.contractSubtotal)}
                      </div>
                    </td>
                    <td className="px-3 py-2.5 text-right font-mono whitespace-nowrap">
                      <div className="text-blue-700 font-medium">{formatYen(row.budgetTotal)}</div>
                    </td>
                    <td className="px-3 py-2.5 text-right font-mono whitespace-nowrap">
                      <div className="font-medium text-amber-700">
                        {formatYen(row.actualCostEvalTotal)}
                      </div>
                      <div className="text-xs text-slate-500">
                        {row.costHeaderCount}件 (税込 {formatYen(row.actualCostInclTotal)})
                      </div>
                    </td>
                    <td className="px-3 py-2.5 text-right font-mono whitespace-nowrap">
                      <div
                        className={`font-semibold ${
                          row.actualGrossProfit < 0 ? 'text-red-700' : 'text-emerald-700'
                        }`}
                      >
                        {formatYen(row.actualGrossProfit)}
                      </div>
                      <div className="text-xs text-slate-500">{row.actualGrossMarginPercent}%</div>
                    </td>
                    <td className="px-3 py-2.5 text-right whitespace-nowrap">
                      <div
                        className={`font-mono text-xs font-semibold ${
                          row.isOverBudget ? 'text-red-700' : 'text-slate-700'
                        }`}
                      >
                        {formatYen(row.budgetVarianceTotal)}
                        {row.isOverBudget && (
                          <span className="ml-1 rounded bg-red-100 px-1.5 py-0.5 text-[10px] text-red-700">
                            超過
                          </span>
                        )}
                      </div>
                      <div className="mt-1 flex items-center justify-end gap-2">
                        <Link
                          href={`/projects/${row.id}`}
                          className="rounded border border-blue-200 bg-blue-50 px-2 py-0.5 text-xs font-medium text-blue-700 hover:bg-blue-100"
                        >
                          工事台帳
                        </Link>
                        <button
                          type="button"
                          onClick={() => handleDeleteProject(row.id, row.projectNo, row.projectName)}
                          className="rounded border border-red-200 bg-white px-2 py-0.5 text-xs text-red-600 hover:bg-red-50"
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

        {/* Pagination */}
        <div className="flex items-center justify-between border-t border-slate-200 bg-slate-50 px-4 py-2.5 text-xs text-slate-600">
          <div>
            全 {pageData.summary.totalCount} 件（ページ {pageData.page} / {totalPages}）
          </div>
          <div className="flex items-center gap-2">
            <button
              type="button"
              disabled={pageData.page <= 1 || loading}
              onClick={() => fetchProjects(filters, pageData.page - 1)}
              className="rounded border border-slate-300 bg-white px-2.5 py-1 disabled:opacity-40"
            >
              前へ
            </button>
            <button
              type="button"
              disabled={pageData.page >= totalPages || loading}
              onClick={() => fetchProjects(filters, pageData.page + 1)}
              className="rounded border border-slate-300 bg-white px-2.5 py-1 disabled:opacity-40"
            >
              次へ
            </button>
          </div>
        </div>
      </div>

      {/* Create Modal */}
      {createOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/50 p-4 overflow-y-auto">
          <div className="w-full max-w-4xl rounded-2xl bg-white shadow-xl border border-slate-200 max-h-[92vh] flex flex-col">
            <div className="flex items-center justify-between border-b border-slate-200 px-6 py-4">
              <h2 className="text-lg font-bold text-slate-900">新規案件登録（契約・実行予算）</h2>
              <button
                type="button"
                onClick={() => setCreateOpen(false)}
                className="rounded-lg px-2.5 py-1 text-sm text-slate-500 hover:bg-slate-100"
              >
                ✕ 閉じる
              </button>
            </div>

            <form onSubmit={handleCreateSubmit} className="overflow-y-auto p-6 space-y-5 text-sm">
              <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
                <div className="md:col-span-2">
                  <label className="block text-xs font-semibold text-slate-700 mb-1">
                    案件名 *
                  </label>
                  <input
                    type="text"
                    required
                    value={form.projectName}
                    onChange={(e) => setForm({ ...form, projectName: e.target.value })}
                    placeholder="例: 本社ビル空調改修工事"
                    className="w-full rounded-lg border border-slate-300 px-3 py-2"
                  />
                </div>

                <div>
                  <label className="block text-xs font-semibold text-slate-700 mb-1">
                    受注日 *
                  </label>
                  <input
                    type="date"
                    required
                    value={form.projectDate}
                    onChange={(e) => setForm({ ...form, projectDate: e.target.value })}
                    className="w-full rounded-lg border border-slate-300 px-3 py-2"
                  />
                </div>

                <div className="md:col-span-2">
                  <label className="block text-xs font-semibold text-slate-700 mb-1">
                    発注元取引先 *（検索絞込可）
                  </label>
                  <div className="flex gap-2">
                    <input
                      type="text"
                      value={partnerFilter}
                      onChange={(e) => setPartnerFilter(e.target.value)}
                      placeholder="コード/名前絞込"
                      className="w-36 rounded-lg border border-slate-300 px-2.5 py-2 text-xs"
                    />
                    <select
                      required
                      value={form.partnerId}
                      onChange={(e) => setForm({ ...form, partnerId: e.target.value })}
                      className="flex-1 rounded-lg border border-slate-300 px-3 py-2"
                    >
                      <option value="">選択してください</option>
                      {filteredPartners.map((p) => (
                        <option key={p.id} value={p.id}>
                          {p.partnerCode} : {p.partnerName}
                        </option>
                      ))}
                    </select>
                  </div>
                </div>

                <div>
                  <label className="block text-xs font-semibold text-slate-700 mb-1">
                    ステータス
                  </label>
                  <select
                    value={form.status}
                    onChange={(e) =>
                      setForm({ ...form, status: e.target.value as ProjectStatus })
                    }
                    className="w-full rounded-lg border border-slate-300 px-3 py-2"
                  >
                    <option value="C1">C1: {PROJECT_STATUS_LABELS.C1}</option>
                    <option value="C2">C2: {PROJECT_STATUS_LABELS.C2}</option>
                    <option value="C3">C3: {PROJECT_STATUS_LABELS.C3}</option>
                  </select>
                </div>

                <div className="md:col-span-2">
                  <label className="block text-xs font-semibold text-slate-700 mb-1">
                    工事場所・現場住所
                  </label>
                  <input
                    type="text"
                    value={form.sitePlace}
                    onChange={(e) => setForm({ ...form, sitePlace: e.target.value })}
                    className="w-full rounded-lg border border-slate-300 px-3 py-2"
                  />
                </div>

                <div>
                  <label className="block text-xs font-semibold text-slate-700 mb-1">
                    工事区分 / 工程詳細状態
                  </label>
                  <div className="grid grid-cols-2 gap-2">
                    <select
                      value={form.orderKindCode}
                      onChange={(e) => setForm({ ...form, orderKindCode: e.target.value })}
                      className="rounded-lg border border-slate-300 px-2 py-2 text-xs"
                    >
                      <option value="">区分なし</option>
                      {lookups.orderKinds.map((k) => (
                        <option key={k.code} value={k.code}>
                          {k.name}
                        </option>
                      ))}
                    </select>
                    <select
                      value={form.subStatusCode}
                      onChange={(e) => setForm({ ...form, subStatusCode: e.target.value })}
                      className="rounded-lg border border-slate-300 px-2 py-2 text-xs"
                    >
                      <option value="">詳細状態なし</option>
                      {lookups.subStatuses.map((s) => (
                        <option key={s.code} value={s.code}>
                          {s.name}
                        </option>
                      ))}
                    </select>
                  </div>
                </div>

                <div>
                  <label className="block text-xs font-semibold text-slate-700 mb-1">
                    工期（予定開始〜完了）
                  </label>
                  <div className="flex items-center gap-1">
                    <input
                      type="date"
                      value={form.periodStartDate}
                      onChange={(e) => setForm({ ...form, periodStartDate: e.target.value })}
                      className="w-full rounded-lg border border-slate-300 px-2 py-2 text-xs"
                    />
                    <span>〜</span>
                    <input
                      type="date"
                      value={form.periodEndDate}
                      onChange={(e) => setForm({ ...form, periodEndDate: e.target.value })}
                      className="w-full rounded-lg border border-slate-300 px-2 py-2 text-xs"
                    />
                  </div>
                </div>

                <div>
                  <label className="block text-xs font-semibold text-slate-700 mb-1">
                    営業担当
                  </label>
                  <select
                    value={form.salesEmployeeId}
                    onChange={(e) => setForm({ ...form, salesEmployeeId: e.target.value })}
                    className="w-full rounded-lg border border-slate-300 px-3 py-2"
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
                  <label className="block text-xs font-semibold text-slate-700 mb-1">
                    現場担当
                  </label>
                  <select
                    value={form.siteEmployeeId}
                    onChange={(e) => setForm({ ...form, siteEmployeeId: e.target.value })}
                    className="w-full rounded-lg border border-slate-300 px-3 py-2"
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

              {/* Contract Calculation Section */}
              <div className="rounded-xl border border-slate-200 bg-slate-50 p-4 space-y-3">
                <div className="flex items-center justify-between">
                  <h3 className="text-xs font-bold uppercase tracking-wider text-slate-700">
                    請負契約金額（calculations.ts リアルタイム計算）
                  </h3>
                  <div className="text-xs font-mono text-slate-800">
                    税抜: <span className="font-bold">{formatYen(createPreview.contractSubtotal)}</span>{' '}
                    / 消費税: <span className="font-bold">{formatYen(createPreview.contractTax)}</span>{' '}
                    / 税込合計:{' '}
                    <span className="font-bold text-blue-700">
                      {formatYen(createPreview.contractTotal)}
                    </span>
                  </div>
                </div>

                <div className="grid grid-cols-2 md:grid-cols-5 gap-3">
                  <div>
                    <label className="block text-xs text-slate-600 mb-1">契約単価(円)</label>
                    <input
                      type="number"
                      value={form.contractUnitPriceStr}
                      onChange={(e) =>
                        setForm({ ...form, contractUnitPriceStr: e.target.value })
                      }
                      className="w-full rounded-lg border border-slate-300 bg-white px-3 py-1.5 font-mono text-right"
                    />
                  </div>
                  <div>
                    <label className="block text-xs text-slate-600 mb-1">数量</label>
                    <input
                      type="number"
                      step="0.0001"
                      value={form.contractQuantityStr}
                      onChange={(e) =>
                        setForm({ ...form, contractQuantityStr: e.target.value })
                      }
                      className="w-full rounded-lg border border-slate-300 bg-white px-3 py-1.5 font-mono text-right"
                    />
                  </div>
                  <div>
                    <label className="block text-xs text-slate-600 mb-1">単位</label>
                    <input
                      type="text"
                      value={form.unitName}
                      onChange={(e) => setForm({ ...form, unitName: e.target.value })}
                      className="w-full rounded-lg border border-slate-300 bg-white px-3 py-1.5"
                    />
                  </div>
                  <div>
                    <label className="block text-xs text-slate-600 mb-1">税区分</label>
                    <select
                      value={form.taxCode}
                      onChange={(e) => setForm({ ...form, taxCode: e.target.value as TaxCode })}
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
                      value={form.roundingMode}
                      onChange={(e) =>
                        setForm({ ...form, roundingMode: e.target.value as RoundingMode })
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

              {/* 6-Category Budget Breakdown */}
              <div className="rounded-xl border border-slate-200 bg-slate-50 p-4 space-y-3">
                <div className="flex items-center justify-between">
                  <h3 className="text-xs font-bold uppercase tracking-wider text-slate-700">
                    実行予算（原価6費目内訳）
                  </h3>
                  <div className="text-xs font-mono">
                    予算合計: <span className="font-bold text-blue-700">{formatYen(createPreview.budgetTotal)}</span>{' '}
                    / 予算粗利:{' '}
                    <span className="font-bold text-emerald-700">
                      {formatYen(createPreview.budgetGrossProfit)}
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
                        value={form.budgets[cat]}
                        onChange={(e) =>
                          setForm({
                            ...form,
                            budgets: { ...form.budgets, [cat]: e.target.value },
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
                  rows={2}
                  value={form.remarks}
                  onChange={(e) => setForm({ ...form, remarks: e.target.value })}
                  className="w-full rounded-lg border border-slate-300 px-3 py-2"
                />
              </div>

              <div className="flex justify-end gap-2 border-t border-slate-200 pt-4">
                <button
                  type="button"
                  onClick={() => setCreateOpen(false)}
                  className="rounded-lg border border-slate-300 bg-white px-4 py-2 text-sm text-slate-700 hover:bg-slate-50"
                >
                  キャンセル
                </button>
                <button
                  type="submit"
                  disabled={submitting}
                  className="rounded-lg bg-blue-600 px-5 py-2 text-sm font-semibold text-white hover:bg-blue-700 disabled:opacity-50"
                >
                  {submitting ? '登録中...' : '案件を登録する'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}
