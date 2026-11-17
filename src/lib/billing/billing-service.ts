import {
  calculatePartnersArBalances,
  calculateSinglePartnerArBalance,
  getMonthStartForDate,
  proposePaymentDueDate,
} from '@/lib/billing/ar-balance-service';
import {
  RECEIVABLE_STATUS_LABELS,
  type BillingCandidateListResultDto,
  type BillingCandidatePartnerGroupDto,
  type BillingCandidateSlipDto,
  type BillingDetailDto,
  type BillingDocumentType,
  type BillingExportTarget,
  type BillingLinkedSlipDto,
  type BillingLinkedSlipLineDto,
  type BillingListFilter,
  type BillingListItemDto,
  type BillingLookupsDto,
  type BillingPageDto,
  type ConfirmBillingRequestInput,
  type ReceivableStatus,
} from '@/lib/billing/types';
import { withBillingTransition, type DbExecutor } from '@/lib/db/tenant-client';
import {
  calculateInvoiceSummary,
  calculateSlipTotals,
  type RoundingMode,
  type SlipTotalsResult,
  type TaxCalcPolicy,
  type TaxCode,
} from '@/lib/domain/calculations';
import {
  renderBillingDetailListPdf,
  renderBillingListPdf,
  renderBillingSimpleListPdf,
} from '@/lib/domain/pdf-renderer';
import { getEstimateEditorLookups } from '@/lib/estimates/estimates-service';
import type { QuotationTemplateVariant, SnapshotHistoryItemDto } from '@/lib/estimates/types';
import { isFeatureEnabled, requireFeature } from '@/lib/feature-flags/gate';
import { mapPgConstraintError, MasterDataError } from '@/lib/masters/error-mapper';
import {
  ENTRY_TYPE_LABELS,
  SALES_STATUS_LABELS,
  type ApprovalStatus,
  type SalesEntryType,
  type SalesStatus,
} from '@/lib/sales/types';
import {
  issueBillingSnapshot,
  type BillingSnapshotDocumentType,
} from '@/lib/snapshots/snapshot-service';

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DATE_REGEX = /^\d{4}-\d{2}-\d{2}$/;
const VALID_RECEIVABLE_STATUSES = new Set<ReceivableStatus>(['N1', 'N2', 'N3', 'N4']);

function validateUuid(id: string, label: string): void {
  if (!UUID_REGEX.test(id)) {
    throw new MasterDataError(400, 'INVALID_ID', `${label}IDの形式が不正です。`);
  }
}

function validateDateOnly(raw: string, label: string): string {
  const trimmed = raw.trim().slice(0, 10);
  if (!DATE_REGEX.test(trimmed)) {
    throw new MasterDataError(400, 'INVALID_DATE', `${label}は YYYY-MM-DD 形式で指定してください。`);
  }
  const parts = trimmed.split('-');
  const y = Number(parts[0]);
  const m = Number(parts[1]);
  const d = Number(parts[2]);
  const check = new Date(Date.UTC(y, m - 1, d));
  if (
    check.getUTCFullYear() !== y ||
    check.getUTCMonth() + 1 !== m ||
    check.getUTCDate() !== d
  ) {
    throw new MasterDataError(400, 'INVALID_DATE', `${label}の日付が存在しません。`);
  }
  return trimmed;
}

function optTrimmed(raw: string | null | undefined): string | null {
  if (raw === undefined || raw === null) {
    return null;
  }
  const t = raw.trim();
  return t === '' ? null : t;
}

function escapeCsvCell(value: string): string {
  const escaped = value.replace(/"/g, '""');
  return `"${escaped}"`;
}

async function requireAnyBillingReadFeature(tx: DbExecutor, tenantId: string): Promise<void> {
  const [summaryOk, issueOk, fixedOk] = await Promise.all([
    isFeatureEnabled(tx, tenantId, 'billsummary'),
    isFeatureEnabled(tx, tenantId, 'billissue'),
    isFeatureEnabled(tx, tenantId, 'fixedbill'),
  ]);
  if (!summaryOk && !issueOk && !fixedOk) {
    await requireFeature(tx, tenantId, 'billissue');
  }
}

async function requireCandidateReadFeature(tx: DbExecutor, tenantId: string): Promise<void> {
  const [summaryOk, issueOk] = await Promise.all([
    isFeatureEnabled(tx, tenantId, 'billsummary'),
    isFeatureEnabled(tx, tenantId, 'billissue'),
  ]);
  if (!summaryOk && !issueOk) {
    await requireFeature(tx, tenantId, 'billsummary');
  }
}

function currentIsoMonthBounds(): { monthStart: string; monthEnd: string } {
  const now = new Date();
  const y = now.getUTCFullYear();
  const m = now.getUTCMonth() + 1;
  const lastDay = new Date(Date.UTC(y, m, 0)).getUTCDate();
  const yStr = String(y).padStart(4, '0');
  const mStr = String(m).padStart(2, '0');
  return {
    monthStart: `${yStr}-${mStr}-01`,
    monthEnd: `${yStr}-${mStr}-${String(lastDay).padStart(2, '0')}`,
  };
}

function resolveDefaultRounding(slips: ReadonlyArray<{ rounding_mode: RoundingMode }>, fallback: RoundingMode): RoundingMode {
  const first = slips[0];
  return first !== undefined ? first.rounding_mode : fallback;
}

function buildSlipTotalsForBilling(
  lines: ReadonlyArray<{
    line_no: number;
    is_heading: boolean;
    quantity: string;
    applied_unit_price: string;
    tax_code: TaxCode;
  }>,
  roundingMode: RoundingMode,
  policy: TaxCalcPolicy,
): SlipTotalsResult {
  return calculateSlipTotals(
    lines.map((l) => ({
      lineNo: Number(l.line_no),
      quantity: l.is_heading ? '0' : l.quantity,
      unitPrice: l.is_heading ? 0n : BigInt(l.applied_unit_price),
      taxCode: l.tax_code,
      roundingMode,
    })),
    roundingMode,
    policy,
  );
}

export async function getBillingLookups(
  tx: DbExecutor,
  tenantId: string,
): Promise<BillingLookupsDto> {
  const [baseLookups, settingsRows, closingRows, billsummaryEnabled, billissueEnabled, fixedbillEnabled] =
    await Promise.all([
      getEstimateEditorLookups(tx, tenantId),
      tx.query<{
        opening_balance_date: string;
        approval_flow_enabled: boolean;
        allow_billing_date_warning_skip: boolean;
        show_invoice_carryover: boolean;
      }>(
        `SELECT opening_balance_date::text AS opening_balance_date,
                approval_flow_enabled,
                allow_billing_date_warning_skip,
                show_invoice_carryover
           FROM tenant_settings
          WHERE tenant_id = $1::uuid
          LIMIT 1`,
        [tenantId],
      ),
      tx.query<{ code: string; name: string }>(
        `SELECT code, name
           FROM code_masters
          WHERE domain_key = 'BILL_CLOSE' AND is_active = true
          ORDER BY display_order ASC, code ASC`,
        [],
      ),
      isFeatureEnabled(tx, tenantId, 'billsummary'),
      isFeatureEnabled(tx, tenantId, 'billissue'),
      isFeatureEnabled(tx, tenantId, 'fixedbill'),
    ]);

  const settings = settingsRows[0];
  if (settings === undefined) {
    throw new MasterDataError(404, 'TENANT_SETTINGS_NOT_FOUND', '自社設定が見つかりません。');
  }

  return {
    openingBalanceDate: settings.opening_balance_date.slice(0, 10),
    approvalFlowEnabled: settings.approval_flow_enabled,
    allowBillingDateWarningSkip: settings.allow_billing_date_warning_skip,
    showInvoiceCarryover: settings.show_invoice_carryover,
    taxCalcPolicy: baseLookups.taxCalcPolicy,
    defaultRoundingMode: baseLookups.defaultRoundingMode,
    quotationTemplateRows: baseLookups.quotationTemplateRows === 20 ? '20_ROWS' : '10_ROWS',
    billsummaryEnabled,
    billissueEnabled,
    fixedbillEnabled,
    partners: baseLookups.partners,
    closingDays: closingRows,
  };
}

export interface BillingCandidateFilter {
  dateFrom?: string | null;
  dateTo?: string | null;
  closingDayCode?: string | null;
  partnerId?: string | null;
  keyword?: string | null;
  balancePeriodStart?: string | null;
  balancePeriodEnd?: string | null;
}

export async function listBillingCandidates(
  tx: DbExecutor,
  tenantId: string,
  filter: BillingCandidateFilter,
): Promise<BillingCandidateListResultDto> {
  await requireCandidateReadFeature(tx, tenantId);

  const settingsRows = await tx.query<{
    tax_calc_policy: TaxCalcPolicy;
    default_rounding_mode: RoundingMode;
    approval_flow_enabled: boolean;
    allow_billing_date_warning_skip: boolean;
  }>(
    `SELECT tax_calc_policy::text AS tax_calc_policy,
            default_rounding_mode::text AS default_rounding_mode,
            approval_flow_enabled,
            allow_billing_date_warning_skip
       FROM tenant_settings
      WHERE tenant_id = $1::uuid
      LIMIT 1`,
    [tenantId],
  );
  const settings = settingsRows[0];
  if (settings === undefined) {
    throw new MasterDataError(404, 'TENANT_SETTINGS_NOT_FOUND', '自社設定が見つかりません。');
  }

  const rawDateFrom = optTrimmed(filter.dateFrom);
  const dateFrom = rawDateFrom !== null ? validateDateOnly(rawDateFrom, '売上日開始') : null;
  const rawDateTo = optTrimmed(filter.dateTo);
  const dateTo = rawDateTo !== null ? validateDateOnly(rawDateTo, '売上日終了') : null;
  const closingDayCode = optTrimmed(filter.closingDayCode);
  const rawPartnerId = optTrimmed(filter.partnerId);
  if (rawPartnerId !== null) {
    validateUuid(rawPartnerId, '取引先');
  }
  const kw = optTrimmed(filter.keyword);

  const curMonth = currentIsoMonthBounds();
  const rawBalStart = optTrimmed(filter.balancePeriodStart);
  const rawBalEnd = optTrimmed(filter.balancePeriodEnd);
  let balancePeriodStart =
    rawBalStart !== null
      ? validateDateOnly(rawBalStart, '残高基準開始日')
      : dateFrom !== null
        ? dateFrom
        : dateTo !== null
          ? getMonthStartForDate(dateTo)
          : curMonth.monthStart;
  const balancePeriodEnd =
    rawBalEnd !== null
      ? validateDateOnly(rawBalEnd, '残高基準終了日')
      : dateTo !== null
        ? dateTo
        : curMonth.monthEnd;
  if (balancePeriodStart > balancePeriodEnd) {
    balancePeriodStart = getMonthStartForDate(balancePeriodEnd);
  }

  const slipRows = await tx.query<{
    id: string;
    entry_type: SalesEntryType;
    slip_no: string;
    slip_name: string;
    slip_date: string;
    partner_id: string;
    partner_code: string;
    partner_name: string;
    closing_day_code: string | null;
    closing_day_name: string | null;
    collection_day_code: string | null;
    status: SalesStatus;
    approval_status: number;
    rounding_mode: RoundingMode;
    subtotal_amount: string;
    tax_total: string;
    total_amount: string;
    line_count: number;
  }>(
    `SELECT sh.id,
            sh.entry_type::text AS entry_type,
            sh.slip_no::text AS slip_no,
            sh.slip_name,
            sh.slip_date::text AS slip_date,
            sh.partner_id,
            bp.partner_code,
            bp.partner_name,
            bp.closing_day_code,
            cm.name AS closing_day_name,
            bp.collection_day_code,
            sh.status::text AS status,
            sh.approval_status,
            sh.rounding_mode::text AS rounding_mode,
            sh.subtotal_amount::text AS subtotal_amount,
            sh.tax_total::text AS tax_total,
            sh.total_amount::text AS total_amount,
            (SELECT COUNT(*)::int FROM sales_lines sl WHERE sl.sales_header_id = sh.id) AS line_count
       FROM sales_headers sh
       JOIN business_partners bp ON bp.tenant_id = sh.tenant_id AND bp.id = sh.partner_id
       LEFT JOIN code_masters cm
         ON cm.tenant_id = bp.tenant_id
        AND cm.domain_key = 'BILL_CLOSE'
        AND cm.code = bp.closing_day_code
      WHERE sh.billing_id IS NULL
        AND sh.status IN ('K1', 'K2', 'K3')
        AND ($1::date IS NULL OR sh.slip_date >= $1::date)
        AND ($2::date IS NULL OR sh.slip_date <= $2::date)
        AND ($3::text IS NULL OR bp.closing_day_code = $3)
        AND ($4::uuid IS NULL OR sh.partner_id = $4::uuid)
        AND (
          $5::text IS NULL
          OR bp.partner_name ILIKE '%' || $5 || '%'
          OR bp.partner_code ILIKE '%' || $5 || '%'
          OR sh.slip_name ILIKE '%' || $5 || '%'
          OR CAST(sh.slip_no AS text) ILIKE '%' || $5 || '%'
        )
      ORDER BY bp.partner_code ASC, sh.slip_date ASC, sh.entry_type ASC, sh.slip_no ASC`,
    [dateFrom, dateTo, closingDayCode, rawPartnerId, kw],
  );

  if (slipRows.length === 0) {
    return {
      balancePeriodStart,
      balancePeriodEnd,
      taxCalcPolicy: settings.tax_calc_policy,
      approvalFlowEnabled: settings.approval_flow_enabled,
      allowBillingDateWarningSkip: settings.allow_billing_date_warning_skip,
      groups: [],
      totals: {
        partnerCount: 0,
        slipCount: 0,
        unapprovedSlipCount: 0,
        currentBillingAmount: 0,
      },
    };
  }

  const slipIds = slipRows.map((s) => s.id);
  const lineRows = await tx.query<{
    sales_header_id: string;
    line_no: number;
    is_heading: boolean;
    quantity: string;
    applied_unit_price: string;
    tax_code: TaxCode;
  }>(
    `SELECT sales_header_id, line_no, is_heading,
            quantity::text AS quantity,
            applied_unit_price::text AS applied_unit_price,
            tax_code
       FROM sales_lines
      WHERE sales_header_id = ANY($1::uuid[])
      ORDER BY sales_header_id, line_no ASC`,
    [slipIds],
  );

  const linesBySlip = new Map<string, typeof lineRows>();
  for (const lr of lineRows) {
    const arr = linesBySlip.get(lr.sales_header_id);
    if (arr !== undefined) {
      arr.push(lr);
    } else {
      linesBySlip.set(lr.sales_header_id, [lr]);
    }
  }

  interface PartnerGroupAccum {
    partnerId: string;
    partnerCode: string;
    partnerName: string;
    closingDayCode: string | null;
    closingDayName: string | null;
    collectionDayCode: string | null;
    slipsRaw: typeof slipRows;
  }

  const groupMap = new Map<string, PartnerGroupAccum>();
  for (const s of slipRows) {
    const existing = groupMap.get(s.partner_id);
    if (existing !== undefined) {
      existing.slipsRaw.push(s);
    } else {
      groupMap.set(s.partner_id, {
        partnerId: s.partner_id,
        partnerCode: s.partner_code,
        partnerName: s.partner_name,
        closingDayCode: s.closing_day_code,
        closingDayName: s.closing_day_name,
        collectionDayCode: s.collection_day_code,
        slipsRaw: [s],
      });
    }
  }

  const partnerIds = Array.from(groupMap.keys());
  const arBalances = await calculatePartnersArBalances(tx, {
    tenantId,
    partnerIds,
    periodStart: balancePeriodStart,
    periodEnd: balancePeriodEnd,
  });

  const groups: BillingCandidatePartnerGroupDto[] = [];
  let totalSlipCount = 0;
  let totalUnapprovedCount = 0;
  let totalBillingAmount = 0;

  for (const acc of groupMap.values()) {
    const ar = arBalances.get(acc.partnerId);
    if (ar === undefined) {
      throw new MasterDataError(500, 'AR_BALANCE_MISSING', '取引先の売掛残高計算に失敗しました。');
    }

    const slipTotals: SlipTotalsResult[] = acc.slipsRaw.map((sr) => {
      const sLines = linesBySlip.get(sr.id);
      return buildSlipTotalsForBilling(
        sLines !== undefined ? sLines : [],
        sr.rounding_mode,
        settings.tax_calc_policy,
      );
    });

    const billingRounding = resolveDefaultRounding(acc.slipsRaw, settings.default_rounding_mode);
    const invSummary = calculateInvoiceSummary({
      slips: slipTotals,
      prevCarriedBalance: ar.prevCarriedBalance,
      periodReceiptAmount: ar.periodReceiptAmount,
      roundingMode: billingRounding,
      policy: settings.tax_calc_policy,
    });

    const slipsDto: BillingCandidateSlipDto[] = acc.slipsRaw.map((sr) => ({
      id: sr.id,
      entryType: sr.entry_type,
      slipNo: Number(sr.slip_no),
      slipName: sr.slip_name,
      slipDate: sr.slip_date.slice(0, 10),
      status: sr.status,
      approvalStatus: sr.approval_status === 1 ? 1 : sr.approval_status === 2 ? 2 : 0,
      roundingMode: sr.rounding_mode,
      subtotalAmount: Number(sr.subtotal_amount),
      taxTotal: Number(sr.tax_total),
      totalAmount: Number(sr.total_amount),
      lineCount: Number(sr.line_count),
    }));

    const aggregatedCount = slipsDto.filter((s) => s.status === 'K3').length;
    const unapprovedCount = slipsDto.filter((s) => s.approvalStatus !== 1).length;

    totalSlipCount += slipsDto.length;
    totalUnapprovedCount += unapprovedCount;
    const currBillAmt = Number(invSummary.billingAmount);
    totalBillingAmount += currBillAmt;

    groups.push({
      partnerId: acc.partnerId,
      partnerCode: acc.partnerCode,
      partnerName: acc.partnerName,
      closingDayCode: acc.closingDayCode,
      closingDayName: acc.closingDayName,
      collectionDayCode: acc.collectionDayCode,
      proposedPaymentDueDate: proposePaymentDueDate(
        balancePeriodEnd,
        acc.closingDayCode,
        acc.collectionDayCode,
      ),
      slipCount: slipsDto.length,
      aggregatedCount,
      unapprovedCount,
      prevCarriedBalance: Number(invSummary.prevCarriedBalance),
      periodReceiptAmount: Number(invSummary.periodReceiptAmount),
      netCarriedBalance: Number(invSummary.netCarriedBalance),
      amount10Excl: Number(invSummary.amount10Excl),
      amount8Excl: Number(invSummary.amount8Excl),
      amount0NonTax: Number(invSummary.amount0NonTax),
      tax10Amount: Number(invSummary.tax10Amount),
      tax8Amount: Number(invSummary.tax8Amount),
      taxAdjustmentAmount: Number(invSummary.taxAdjustmentAmount),
      taxTotal: Number(invSummary.taxTotal),
      currentBillingAmount: currBillAmt,
      closingArBalance: Number(invSummary.closingArBalance),
      slips: slipsDto,
    });
  }

  return {
    balancePeriodStart,
    balancePeriodEnd,
    taxCalcPolicy: settings.tax_calc_policy,
    approvalFlowEnabled: settings.approval_flow_enabled,
    allowBillingDateWarningSkip: settings.allow_billing_date_warning_skip,
    groups,
    totals: {
      partnerCount: groups.length,
      slipCount: totalSlipCount,
      unapprovedSlipCount: totalUnapprovedCount,
      currentBillingAmount: totalBillingAmount,
    },
  };
}

/**
 * 請求集計候補のステータス切替（K2 請求待ち ⇔ K3 集計済み）
 */
export async function updateCandidateAggregationStatus(
  tx: DbExecutor,
  tenantId: string,
  employeeId: string,
  input: { slipIds: readonly string[]; targetStatus: 'K2' | 'K3' },
): Promise<{ updatedCount: number }> {
  await requireFeature(tx, tenantId, 'billsummary');
  if (input.targetStatus !== 'K2' && input.targetStatus !== 'K3') {
    throw new MasterDataError(400, 'INVALID_STATUS', '集計状態は K2 または K3 を指定してください。');
  }
  const uniqueIds = Array.from(new Set(input.slipIds.map((id) => id.trim()).filter((id) => id !== '')));
  if (uniqueIds.length === 0) {
    throw new MasterDataError(400, 'SLIP_IDS_REQUIRED', '対象伝票を1件以上選択してください。');
  }
  for (const sid of uniqueIds) {
    validateUuid(sid, '売上・立替伝票');
  }

  const tsRows = await tx.query<{
    approval_flow_enabled: boolean;
    allow_billing_date_warning_skip: boolean;
  }>(
    `SELECT approval_flow_enabled, allow_billing_date_warning_skip
       FROM tenant_settings
      WHERE tenant_id = $1::uuid
      LIMIT 1`,
    [tenantId],
  );
  const settings = tsRows[0];

  const rows = await tx.query<{
    id: string;
    status: SalesStatus;
    approval_status: number;
    billing_id: string | null;
  }>(
    `SELECT id, status::text AS status, approval_status, billing_id
       FROM sales_headers
      WHERE id = ANY($1::uuid[])
      FOR UPDATE`,
    [uniqueIds],
  );
  if (rows.length !== uniqueIds.length) {
    throw new MasterDataError(404, 'SALES_NOT_FOUND', '指定された伝票の一部が見つかりません。');
  }

  for (const r of rows) {
    if (r.status === 'K4' || r.status === 'K5' || r.billing_id !== null) {
      throw new MasterDataError(
        409,
        'SLIP_ALREADY_BILLED',
        '既に請求済み（K4/K5）の伝票は集計状態を変更できません。',
      );
    }
    if (
      input.targetStatus === 'K3' &&
      settings !== undefined &&
      settings.approval_flow_enabled &&
      !settings.allow_billing_date_warning_skip &&
      r.approval_status !== 1
    ) {
      throw new MasterDataError(
        409,
        'UNAPPROVED_SLIP_BLOCKED',
        '承認フローが有効かつ警告スキップ不可のため、未承認の伝票を集計済み(K3)にできません。',
      );
    }
  }

  await tx.query(
    `UPDATE sales_headers
        SET status = $2::sales_status,
            updated_by = $3::uuid
      WHERE id = ANY($1::uuid[])`,
    [uniqueIds, input.targetStatus, employeeId],
  );

  return { updatedCount: rows.length };
}

/**
 * 通常請求確定処理（単一ACIDトランザクション・withBillingTransition使用）
 * - billing_date > opening_balance_date を検証
 * - 請求鏡4数値・税調整額を calculations.ts で厳密計算して billing_headers を作成
 * - 対象 sales_headers を K4 / billing_id / billing_date に遷移し、初回スナップショット v1 を発行
 */
export async function confirmBilling(
  tx: DbExecutor,
  tenantId: string,
  employeeId: string,
  input: ConfirmBillingRequestInput,
): Promise<{
  billings: BillingListItemDto[];
  snapshots: Awaited<ReturnType<typeof issueBillingSnapshot>>[];
}> {
  await requireFeature(tx, tenantId, 'billissue');
  const billingDate = validateDateOnly(input.billingDate, '請求日');

  const tsRows = await tx.query<{
    opening_balance_date: string;
    tax_calc_policy: TaxCalcPolicy;
    default_rounding_mode: RoundingMode;
    approval_flow_enabled: boolean;
    allow_billing_date_warning_skip: boolean;
    quotation_template_rows: number;
  }>(
    `SELECT opening_balance_date::text AS opening_balance_date,
            tax_calc_policy::text AS tax_calc_policy,
            default_rounding_mode::text AS default_rounding_mode,
            approval_flow_enabled,
            allow_billing_date_warning_skip,
            quotation_template_rows
       FROM tenant_settings
      WHERE tenant_id = $1::uuid
      FOR UPDATE`,
    [tenantId],
  );
  const settings = tsRows[0];
  if (settings === undefined) {
    throw new MasterDataError(404, 'TENANT_SETTINGS_NOT_FOUND', '自社設定が見つかりません。');
  }

  const openingBalanceDate = settings.opening_balance_date.slice(0, 10);
  if (billingDate <= openingBalanceDate) {
    throw new MasterDataError(
      400,
      'BILLING_DATE_BEFORE_CUTOFF',
      `請求日は期首残高基準日 (${openingBalanceDate}) より後の日付を指定してください。`,
    );
  }

  const periodStart =
    input.targetPeriodStart !== undefined && input.targetPeriodStart !== null
      ? validateDateOnly(input.targetPeriodStart, '集計期間開始日')
      : getMonthStartForDate(billingDate);
  const periodEnd =
    input.targetPeriodEnd !== undefined && input.targetPeriodEnd !== null
      ? validateDateOnly(input.targetPeriodEnd, '集計期間終了日')
      : billingDate;
  if (periodStart > periodEnd) {
    throw new MasterDataError(
      400,
      'INVALID_PERIOD_RANGE',
      '集計期間開始日は終了日以前を指定してください。',
    );
  }

  const maxNoRows = await tx.query<{ max_no: string }>(
    'SELECT COALESCE(MAX(billing_no), 0)::text AS max_no FROM billing_headers',
    [],
  );
  let nextBillingNo = BigInt(maxNoRows[0] !== undefined ? maxNoRows[0].max_no : '0');

  const seenSlipIds = new Set<string>();
  const createdBillingIds: string[] = [];
  const snapshots: Awaited<ReturnType<typeof issueBillingSnapshot>>[] = [];

  for (const item of input.items) {
    validateUuid(item.partnerId, '取引先');
    const uniqueSlipIds = Array.from(new Set(item.slipIds));
    if (uniqueSlipIds.length === 0) {
      throw new MasterDataError(400, 'SLIP_IDS_REQUIRED', '請求対象の売上伝票を指定してください。');
    }
    for (const sid of uniqueSlipIds) {
      validateUuid(sid, '売上・立替伝票');
      if (seenSlipIds.has(sid)) {
        throw new MasterDataError(400, 'DUPLICATE_SLIP_ID', '同一伝票が複数の請求に重複指定されています。');
      }
      seenSlipIds.add(sid);
    }

    const partnerRows = await tx.query<{
      id: string;
      closing_day_code: string | null;
      collection_day_code: string | null;
    }>(
      `SELECT id, closing_day_code, collection_day_code
         FROM business_partners
        WHERE id = $1::uuid
        LIMIT 1`,
      [item.partnerId],
    );
    const partner = partnerRows[0];
    if (partner === undefined) {
      throw new MasterDataError(404, 'PARTNER_NOT_FOUND', '指定された取引先が見つかりません。');
    }

    const slipRows = await tx.query<{
      id: string;
      partner_id: string;
      status: SalesStatus;
      approval_status: number;
      billing_id: string | null;
      rounding_mode: RoundingMode;
    }>(
      `SELECT id, partner_id, status::text AS status, approval_status, billing_id,
              rounding_mode::text AS rounding_mode
         FROM sales_headers
        WHERE id = ANY($1::uuid[])
        FOR UPDATE`,
      [uniqueSlipIds],
    );
    if (slipRows.length !== uniqueSlipIds.length) {
      throw new MasterDataError(404, 'SALES_NOT_FOUND', '指定された売上・立替伝票が見つかりません。');
    }

    for (const sr of slipRows) {
      if (sr.partner_id !== item.partnerId) {
        throw new MasterDataError(
          400,
          'SLIP_PARTNER_MISMATCH',
          '異なる取引先の伝票を同一の請求書にまとめることはできません。',
        );
      }
      if (sr.status === 'K4' || sr.status === 'K5' || sr.billing_id !== null) {
        throw new MasterDataError(
          409,
          'SLIP_ALREADY_BILLED',
          '既に請求済み（K4/K5）の伝票が含まれています。',
        );
      }
      if (settings.approval_flow_enabled && sr.approval_status !== 1) {
        const canBypass = settings.allow_billing_date_warning_skip && input.allowUnapproved === true;
        if (!canBypass) {
          throw new MasterDataError(
            409,
            'UNAPPROVED_SLIPS_INCLUDED',
            '未承認の売上・立替伝票が含まれているため請求確定できません。',
          );
        }
      }
    }

    const lineRows = await tx.query<{
      sales_header_id: string;
      line_no: number;
      is_heading: boolean;
      quantity: string;
      applied_unit_price: string;
      tax_code: TaxCode;
    }>(
      `SELECT sales_header_id, line_no, is_heading,
              quantity::text AS quantity,
              applied_unit_price::text AS applied_unit_price,
              tax_code
         FROM sales_lines
        WHERE sales_header_id = ANY($1::uuid[])
        ORDER BY sales_header_id, line_no ASC`,
      [uniqueSlipIds],
    );

    const linesBySlip = new Map<string, typeof lineRows>();
    for (const lr of lineRows) {
      const bucket = linesBySlip.get(lr.sales_header_id);
      if (bucket !== undefined) {
        bucket.push(lr);
      } else {
        linesBySlip.set(lr.sales_header_id, [lr]);
      }
    }

    const slipTotals: SlipTotalsResult[] = slipRows.map((sr) => {
      const sLines = linesBySlip.get(sr.id);
      return buildSlipTotalsForBilling(
        sLines !== undefined ? sLines : [],
        sr.rounding_mode,
        settings.tax_calc_policy,
      );
    });

    const billingRounding = resolveDefaultRounding(slipRows, settings.default_rounding_mode);
    const ar = await calculateSinglePartnerArBalance(tx, {
      tenantId,
      partnerId: item.partnerId,
      periodStart,
      periodEnd,
    });

    const inv = calculateInvoiceSummary({
      slips: slipTotals,
      prevCarriedBalance: ar.prevCarriedBalance,
      periodReceiptAmount: ar.periodReceiptAmount,
      roundingMode: billingRounding,
      policy: settings.tax_calc_policy,
    });

    const paymentDueDate =
      item.paymentDueDate !== undefined &&
      item.paymentDueDate !== null &&
      item.paymentDueDate.trim() !== ''
        ? validateDateOnly(item.paymentDueDate, '支払期限')
        : proposePaymentDueDate(billingDate, partner.closing_day_code, partner.collection_day_code);

    nextBillingNo += 1n;

    let insertedBillingId: string;
    try {
      const insRows = await tx.query<{ id: string }>(
        `INSERT INTO billing_headers (
           tenant_id, billing_no, partner_id, billing_date,
           target_period_start, target_period_end, payment_due_date,
           is_subscription_bill, tax_calc_policy, rounding_mode,
           amount_10_excl, amount_8_excl, amount_0_non_tax,
           tax_10_amount, tax_8_amount, tax_adjustment_amount,
           tax_total, billing_amount,
           prev_carried_balance, period_receipt_amount, net_carried_balance, closing_ar_balance,
           status, created_by, updated_by
         ) VALUES (
           $1::uuid, $2::bigint, $3::uuid, $4::date,
           $5::date, $6::date, $7::date,
           false, $8::tax_calc_policy, $9::rounding_mode,
           $10::numeric, $11::numeric, $12::numeric,
           $13::numeric, $14::numeric, $15::numeric,
           $16::numeric, $17::numeric,
           $18::numeric, $19::numeric, $20::numeric, $21::numeric,
           'N1'::receivable_status, $22::uuid, $22::uuid
         )
         RETURNING id`,
        [
          tenantId,
          nextBillingNo.toString(),
          item.partnerId,
          billingDate,
          periodStart,
          periodEnd,
          paymentDueDate,
          settings.tax_calc_policy,
          billingRounding,
          inv.amount10Excl.toString(),
          inv.amount8Excl.toString(),
          inv.amount0NonTax.toString(),
          inv.tax10Amount.toString(),
          inv.tax8Amount.toString(),
          inv.taxAdjustmentAmount.toString(),
          inv.taxTotal.toString(),
          inv.billingAmount.toString(),
          inv.prevCarriedBalance.toString(),
          inv.periodReceiptAmount.toString(),
          inv.netCarriedBalance.toString(),
          inv.closingArBalance.toString(),
          employeeId,
        ],
      );
      const inserted = insRows[0];
      if (inserted === undefined) {
        throw new MasterDataError(500, 'BILLING_INSERT_FAILED', '請求データの登録に失敗しました。');
      }
      insertedBillingId = inserted.id;
    } catch (err) {
      throw mapPgConstraintError(err, { entityLabel: '請求データ' });
    }

    await withBillingTransition(tx, async () => {
      await tx.query(
        `UPDATE sales_headers
            SET status = 'K4'::sales_status,
                billing_id = $2::uuid,
                billing_date = $3::date,
                updated_by = $4::uuid
          WHERE id = ANY($1::uuid[])`,
        [uniqueSlipIds, insertedBillingId, billingDate, employeeId],
      );
    });

    const docType: BillingSnapshotDocumentType =
      item.documentType !== undefined && item.documentType !== 'FIXED_INVOICE'
        ? item.documentType
        : 'INVOICE';
    const templateVariant: QuotationTemplateVariant =
      item.templateVariant !== undefined
        ? item.templateVariant
        : settings.quotation_template_rows === 20
          ? '20_ROWS'
          : '10_ROWS';

    const mainSnap = await issueBillingSnapshot(tx, {
      tenantId,
      employeeId,
      billingId: insertedBillingId,
      documentType: docType,
      templateVariant,
      issueDate: billingDate,
      forceReissue: false,
    });
    snapshots.push(mainSnap);

    if (
      (docType === 'INVOICE_COVER' || docType === 'INVOICE_COVER_MEMO_SUM') &&
      item.issueCoverDetail !== false
    ) {
      const detailSnap = await issueBillingSnapshot(tx, {
        tenantId,
        employeeId,
        billingId: insertedBillingId,
        documentType: 'INVOICE_COVER_DETAIL',
        templateVariant,
        issueDate: billingDate,
        forceReissue: false,
      });
      snapshots.push(detailSnap);
    }

    createdBillingIds.push(insertedBillingId);
  }

  const billings: BillingListItemDto[] = [];
  for (const bid of createdBillingIds) {
    billings.push(await getBillingHeaderSummaryById(tx, bid));
  }

  return { billings, snapshots };
}

/**
 * 請求書再発行（版番号インクリメント ＆ ＜再発行＞付与 ＆ 紐づく sales_headers.status = 'K5' 更新）
 */
export async function reissueBillingSnapshot(
  tx: DbExecutor,
  tenantId: string,
  employeeId: string,
  params: {
    billingId: string;
    documentType: BillingDocumentType;
    templateVariant?: QuotationTemplateVariant;
    issueDate?: string;
    issueCoverDetail?: boolean;
  },
): Promise<{
  snapshots: Awaited<ReturnType<typeof issueBillingSnapshot>>[];
}> {
  validateUuid(params.billingId, '請求ヘッダ');

  const bRows = await tx.query<{ id: string; is_subscription_bill: boolean }>(
    `SELECT id, is_subscription_bill
       FROM billing_headers
      WHERE id = $1::uuid
      FOR UPDATE`,
    [params.billingId],
  );
  const billing = bRows[0];
  if (billing === undefined) {
    throw new MasterDataError(404, 'BILLING_NOT_FOUND', '対象の請求データが見つかりません。');
  }

  if (params.documentType === 'FIXED_INVOICE' || billing.is_subscription_bill) {
    const fixedOk = await isFeatureEnabled(tx, tenantId, 'fixedbill');
    if (!fixedOk) {
      await requireFeature(tx, tenantId, 'billissue');
    }
  } else {
    await requireFeature(tx, tenantId, 'billissue');
  }

  const issued: Awaited<ReturnType<typeof issueBillingSnapshot>>[] = [];
  const mainSnap = await issueBillingSnapshot(tx, {
    tenantId,
    employeeId,
    billingId: params.billingId,
    documentType: params.documentType,
    templateVariant: params.templateVariant,
    issueDate: params.issueDate,
    forceReissue: true,
  });
  issued.push(mainSnap);

  if (
    (params.documentType === 'INVOICE_COVER' || params.documentType === 'INVOICE_COVER_MEMO_SUM') &&
    params.issueCoverDetail === true
  ) {
    const detailSnap = await issueBillingSnapshot(tx, {
      tenantId,
      employeeId,
      billingId: params.billingId,
      documentType: 'INVOICE_COVER_DETAIL',
      templateVariant: params.templateVariant,
      issueDate: params.issueDate,
      forceReissue: true,
    });
    issued.push(detailSnap);
  }

  await withBillingTransition(tx, async () => {
    await tx.query(
      `UPDATE sales_headers
          SET status = 'K5'::sales_status,
              updated_by = $2::uuid
        WHERE billing_id = $1::uuid`,
      [params.billingId, employeeId],
    );
  });

  return { snapshots: issued };
}

/**
 * 請求確定取消（未入金 N1 のみ許可。N2〜N4 は 409 Conflict）
 * - 通常請求: withBillingTransition 内で sales_headers を K2 へロールバックし billing_headers を削除
 * - 定額一括請求: withBillingTransition 内で subscription_billings と自動生成 sales_headers を削除し billing_headers を削除
 * - document_snapshots は不変監査証跡として一切 UPDATE/DELETE しない
 */
export async function cancelBilling(
  tx: DbExecutor,
  tenantId: string,
  employeeId: string,
  billingId: string,
): Promise<{ cancelledBillingId: string; billingNo: number; restoredSlipCount: number }> {
  validateUuid(billingId, '請求ヘッダ');

  const tsRows = await tx.query<{ opening_balance_date: string }>(
    `SELECT opening_balance_date::text AS opening_balance_date
       FROM tenant_settings
      WHERE tenant_id = $1::uuid
      LIMIT 1`,
    [tenantId],
  );
  const openingBalanceDate =
    tsRows[0] !== undefined ? tsRows[0].opening_balance_date.slice(0, 10) : null;

  const bRows = await tx.query<{
    id: string;
    partner_id: string;
    billing_no: string;
    billing_date: string;
    status: ReceivableStatus;
    is_subscription_bill: boolean;
  }>(
    `SELECT id, partner_id, billing_no::text AS billing_no, billing_date::text AS billing_date,
            status::text AS status, is_subscription_bill
       FROM billing_headers
      WHERE id = $1::uuid
      FOR UPDATE`,
    [billingId],
  );
  const billing = bRows[0];
  if (billing === undefined) {
    throw new MasterDataError(404, 'BILLING_NOT_FOUND', '対象の請求データが見つかりません。');
  }

  if (billing.is_subscription_bill) {
    const fixedOk = await isFeatureEnabled(tx, tenantId, 'fixedbill');
    if (!fixedOk) {
      await requireFeature(tx, tenantId, 'billissue');
    }
  } else {
    await requireFeature(tx, tenantId, 'billissue');
  }

  if (openingBalanceDate !== null && billing.billing_date.slice(0, 10) <= openingBalanceDate) {
    throw new MasterDataError(
      409,
      'CUTOFF_DATE_LOCKED',
      `期首残高基準日 (${openingBalanceDate}) 以前の請求データは取消できません。`,
    );
  }

  if (billing.status !== 'N1') {
    throw new MasterDataError(
      409,
      'BILLING_ALREADY_SETTLED',
      `ステータスが ${RECEIVABLE_STATUS_LABELS[billing.status]} (${billing.status}) のため、入金消込済みの請求は取消できません。`,
    );
  }

  const crRefRows = await tx.query<{ cnt: number }>(
    `SELECT COUNT(*)::int AS cnt
       FROM cash_receipts
      WHERE partner_id = $1::uuid
        AND bill_no = $2`,
    [billing.partner_id, billing.billing_no],
  );
  if (crRefRows[0] !== undefined && Number(crRefRows[0].cnt) > 0) {
    throw new MasterDataError(
      409,
      'BILLING_ALREADY_SETTLED',
      `請求番号 ${billing.billing_no} に紐づく入金データが ${crRefRows[0].cnt} 件存在するため、請求確定を取消できません。`,
    );
  }

  let affectedCount = 0;
  await withBillingTransition(tx, async () => {
    if (billing.is_subscription_bill) {
      await tx.query('DELETE FROM subscription_billings WHERE billing_id = $1::uuid', [billingId]);
      const delSales = await tx.query<{ id: string }>(
        'DELETE FROM sales_headers WHERE billing_id = $1::uuid RETURNING id',
        [billingId],
      );
      affectedCount = delSales.length;
    } else {
      const updSales = await tx.query<{ id: string }>(
        `UPDATE sales_headers
            SET status = 'K2'::sales_status,
                billing_id = NULL,
                billing_date = NULL,
                updated_by = $2::uuid
          WHERE billing_id = $1::uuid
          RETURNING id`,
        [billingId, employeeId],
      );
      affectedCount = updSales.length;
    }
  });

  await tx.query('DELETE FROM billing_headers WHERE id = $1::uuid', [billingId]);

  return {
    cancelledBillingId: billingId,
    billingNo: Number(billing.billing_no),
    restoredSlipCount: affectedCount,
  };
}

interface BillingHeaderRow extends Record<string, unknown> {
  id: string;
  billing_no: string;
  partner_id: string;
  partner_code: string;
  partner_name: string;
  billing_date: string;
  target_period_start: string | null;
  target_period_end: string | null;
  payment_due_date: string | null;
  is_subscription_bill: boolean;
  tax_calc_policy: TaxCalcPolicy;
  rounding_mode: RoundingMode;
  amount_10_excl: string;
  amount_8_excl: string;
  amount_0_non_tax: string;
  tax_10_amount: string;
  tax_8_amount: string;
  tax_adjustment_amount: string;
  tax_total: string;
  billing_amount: string;
  prev_carried_balance: string;
  period_receipt_amount: string;
  net_carried_balance: string;
  closing_ar_balance: string;
  status: ReceivableStatus;
  slip_count: number;
  snapshot_count: number;
  latest_snapshot_id: string | null;
  latest_snapshot_doc_type: BillingDocumentType | null;
  latest_snapshot_ver: number | null;
  created_at: string;
  updated_at: string;
}

function mapBillingListItemRow(row: BillingHeaderRow): BillingListItemDto {
  const billingAmt = BigInt(row.billing_amount);
  const taxTotal = BigInt(row.tax_total);
  return {
    id: row.id,
    billingNo: Number(row.billing_no),
    partnerId: row.partner_id,
    partnerCode: row.partner_code,
    partnerName: row.partner_name,
    billingDate: row.billing_date.slice(0, 10),
    targetPeriodStart:
      row.target_period_start !== null ? row.target_period_start.slice(0, 10) : null,
    targetPeriodEnd: row.target_period_end !== null ? row.target_period_end.slice(0, 10) : null,
    paymentDueDate: row.payment_due_date !== null ? row.payment_due_date.slice(0, 10) : null,
    isSubscriptionBill: row.is_subscription_bill,
    taxCalcPolicy: row.tax_calc_policy,
    roundingMode: row.rounding_mode,
    amount10Excl: Number(row.amount_10_excl),
    amount8Excl: Number(row.amount_8_excl),
    amount0NonTax: Number(row.amount_0_non_tax),
    tax10Amount: Number(row.tax_10_amount),
    tax8Amount: Number(row.tax_8_amount),
    taxAdjustmentAmount: Number(row.tax_adjustment_amount),
    taxTotal: Number(taxTotal),
    currentExclAmount: Number(billingAmt - taxTotal),
    billingAmount: Number(billingAmt),
    prevCarriedBalance: Number(row.prev_carried_balance),
    periodReceiptAmount: Number(row.period_receipt_amount),
    netCarriedBalance: Number(row.net_carried_balance),
    closingArBalance: Number(row.closing_ar_balance),
    status: row.status,
    slipCount: Number(row.slip_count),
    snapshotCount: Number(row.snapshot_count),
    latestSnapshotId: row.latest_snapshot_id,
    latestSnapshotDocType: row.latest_snapshot_doc_type,
    latestSnapshotVersion:
      row.latest_snapshot_ver !== null ? Number(row.latest_snapshot_ver) : null,
    updatedAt: row.updated_at,
  };
}

async function getBillingHeaderSummaryById(
  tx: DbExecutor,
  billingId: string,
): Promise<BillingListItemDto> {
  const rows = await tx.query<BillingHeaderRow>(
    `SELECT bh.id, bh.billing_no::text AS billing_no, bh.partner_id,
            bp.partner_code, bp.partner_name,
            bh.billing_date::text AS billing_date,
            bh.target_period_start::text AS target_period_start,
            bh.target_period_end::text AS target_period_end,
            bh.payment_due_date::text AS payment_due_date,
            bh.is_subscription_bill,
            bh.tax_calc_policy::text AS tax_calc_policy,
            bh.rounding_mode::text AS rounding_mode,
            bh.amount_10_excl::text AS amount_10_excl,
            bh.amount_8_excl::text AS amount_8_excl,
            bh.amount_0_non_tax::text AS amount_0_non_tax,
            bh.tax_10_amount::text AS tax_10_amount,
            bh.tax_8_amount::text AS tax_8_amount,
            bh.tax_adjustment_amount::text AS tax_adjustment_amount,
            bh.tax_total::text AS tax_total,
            bh.billing_amount::text AS billing_amount,
            bh.prev_carried_balance::text AS prev_carried_balance,
            bh.period_receipt_amount::text AS period_receipt_amount,
            bh.net_carried_balance::text AS net_carried_balance,
            bh.closing_ar_balance::text AS closing_ar_balance,
            bh.status::text AS status,
            (SELECT COUNT(*)::int FROM sales_headers sh WHERE sh.billing_id = bh.id) AS slip_count,
            (SELECT COUNT(*)::int FROM document_snapshots ds
              WHERE ds.source_entity_type = 'BILLING_HEADER'
                AND ds.source_entity_id = bh.id) AS snapshot_count,
            (SELECT ds.id FROM document_snapshots ds
              WHERE ds.source_entity_type = 'BILLING_HEADER'
                AND ds.source_entity_id = bh.id
              ORDER BY ds.issued_at DESC, ds.version_no DESC
              LIMIT 1) AS latest_snapshot_id,
            (SELECT ds.document_type::text FROM document_snapshots ds
              WHERE ds.source_entity_type = 'BILLING_HEADER'
                AND ds.source_entity_id = bh.id
              ORDER BY ds.issued_at DESC, ds.version_no DESC
              LIMIT 1) AS latest_snapshot_doc_type,
            (SELECT ds.version_no FROM document_snapshots ds
              WHERE ds.source_entity_type = 'BILLING_HEADER'
                AND ds.source_entity_id = bh.id
              ORDER BY ds.issued_at DESC, ds.version_no DESC
              LIMIT 1) AS latest_snapshot_ver,
            bh.created_at::text AS created_at,
            bh.updated_at::text AS updated_at
       FROM billing_headers bh
       JOIN business_partners bp ON bp.tenant_id = bh.tenant_id AND bp.id = bh.partner_id
      WHERE bh.id = $1::uuid
      LIMIT 1`,
    [billingId],
  );
  const row = rows[0];
  if (row === undefined) {
    throw new MasterDataError(404, 'BILLING_NOT_FOUND', '請求データが見つかりません。');
  }
  return mapBillingListItemRow(row);
}

export type { BillingListFilter };

function normalizeBillingListFilter(filter: BillingListFilter): {
  kw: string | null;
  partnerId: string | null;
  status: ReceivableStatus | null;
  subKind: 'ALL' | 'STANDARD' | 'SUBSCRIPTION';
  dateFrom: string | null;
  dateTo: string | null;
  page: number;
  pageSize: number;
  offset: number;
} {
  const kw = optTrimmed(filter.keyword);
  const rawPartner = optTrimmed(filter.partnerId);
  if (rawPartner !== null) {
    validateUuid(rawPartner, '取引先');
  }
  const status =
    filter.status !== undefined && filter.status !== null && VALID_RECEIVABLE_STATUSES.has(filter.status)
      ? filter.status
      : null;
  const subKind =
    filter.isSubscription === 'STANDARD' || filter.isSubscription === 'SUBSCRIPTION'
      ? filter.isSubscription
      : 'ALL';
  const rawFrom = optTrimmed(filter.dateFrom);
  const dateFrom = rawFrom !== null && DATE_REGEX.test(rawFrom) ? rawFrom : null;
  const rawTo = optTrimmed(filter.dateTo);
  const dateTo = rawTo !== null && DATE_REGEX.test(rawTo) ? rawTo : null;

  const rawPage = filter.page === undefined ? 1 : filter.page;
  const rawSize = filter.pageSize === undefined ? 25 : filter.pageSize;
  const page = Number.isInteger(rawPage) && rawPage >= 1 ? rawPage : 1;
  const pageSize = Number.isInteger(rawSize) && rawSize >= 1 && rawSize <= 5000 ? rawSize : 25;
  const offset = (page - 1) * pageSize;

  return {
    kw,
    partnerId: rawPartner,
    status,
    subKind,
    dateFrom,
    dateTo,
    page,
    pageSize,
    offset,
  };
}

export async function listBillingHeaders(
  tx: DbExecutor,
  tenantId: string,
  filter: BillingListFilter,
): Promise<BillingPageDto> {
  await requireAnyBillingReadFeature(tx, tenantId);
  const f = normalizeBillingListFilter(filter);

  const sumRows = await tx.query<{
    total_count: number;
    sum_billing: string;
    sum_tax: string;
    sum_prev: string;
    sum_receipt: string;
    sum_closing: string;
  }>(
    `SELECT COUNT(*)::int AS total_count,
            COALESCE(SUM(bh.billing_amount), 0)::text AS sum_billing,
            COALESCE(SUM(bh.tax_total), 0)::text AS sum_tax,
            COALESCE(SUM(bh.prev_carried_balance), 0)::text AS sum_prev,
            COALESCE(SUM(bh.period_receipt_amount), 0)::text AS sum_receipt,
            COALESCE(SUM(bh.closing_ar_balance), 0)::text AS sum_closing
       FROM billing_headers bh
       JOIN business_partners bp ON bp.tenant_id = bh.tenant_id AND bp.id = bh.partner_id
      WHERE (
          $1::text IS NULL
          OR CAST(bh.billing_no AS text) ILIKE '%' || $1 || '%'
          OR bp.partner_name ILIKE '%' || $1 || '%'
          OR bp.partner_code ILIKE '%' || $1 || '%'
        )
        AND ($2::uuid IS NULL OR bh.partner_id = $2::uuid)
        AND ($3::text IS NULL OR bh.status::text = $3)
        AND (
          $4::text = 'ALL'
          OR ($4::text = 'STANDARD' AND bh.is_subscription_bill = false)
          OR ($4::text = 'SUBSCRIPTION' AND bh.is_subscription_bill = true)
        )
        AND ($5::date IS NULL OR bh.billing_date >= $5::date)
        AND ($6::date IS NULL OR bh.billing_date <= $6::date)`,
    [f.kw, f.partnerId, f.status, f.subKind, f.dateFrom, f.dateTo],
  );
  const sum = sumRows[0];

  const rows = await tx.query<BillingHeaderRow>(
    `SELECT bh.id, bh.billing_no::text AS billing_no, bh.partner_id,
            bp.partner_code, bp.partner_name,
            bh.billing_date::text AS billing_date,
            bh.target_period_start::text AS target_period_start,
            bh.target_period_end::text AS target_period_end,
            bh.payment_due_date::text AS payment_due_date,
            bh.is_subscription_bill,
            bh.tax_calc_policy::text AS tax_calc_policy,
            bh.rounding_mode::text AS rounding_mode,
            bh.amount_10_excl::text AS amount_10_excl,
            bh.amount_8_excl::text AS amount_8_excl,
            bh.amount_0_non_tax::text AS amount_0_non_tax,
            bh.tax_10_amount::text AS tax_10_amount,
            bh.tax_8_amount::text AS tax_8_amount,
            bh.tax_adjustment_amount::text AS tax_adjustment_amount,
            bh.tax_total::text AS tax_total,
            bh.billing_amount::text AS billing_amount,
            bh.prev_carried_balance::text AS prev_carried_balance,
            bh.period_receipt_amount::text AS period_receipt_amount,
            bh.net_carried_balance::text AS net_carried_balance,
            bh.closing_ar_balance::text AS closing_ar_balance,
            bh.status::text AS status,
            (SELECT COUNT(*)::int FROM sales_headers sh WHERE sh.billing_id = bh.id) AS slip_count,
            (SELECT COUNT(*)::int FROM document_snapshots ds
              WHERE ds.source_entity_type = 'BILLING_HEADER'
                AND ds.source_entity_id = bh.id) AS snapshot_count,
            (SELECT ds.id FROM document_snapshots ds
              WHERE ds.source_entity_type = 'BILLING_HEADER'
                AND ds.source_entity_id = bh.id
              ORDER BY ds.issued_at DESC, ds.version_no DESC
              LIMIT 1) AS latest_snapshot_id,
            (SELECT ds.document_type::text FROM document_snapshots ds
              WHERE ds.source_entity_type = 'BILLING_HEADER'
                AND ds.source_entity_id = bh.id
              ORDER BY ds.issued_at DESC, ds.version_no DESC
              LIMIT 1) AS latest_snapshot_doc_type,
            (SELECT ds.version_no FROM document_snapshots ds
              WHERE ds.source_entity_type = 'BILLING_HEADER'
                AND ds.source_entity_id = bh.id
              ORDER BY ds.issued_at DESC, ds.version_no DESC
              LIMIT 1) AS latest_snapshot_ver,
            bh.created_at::text AS created_at,
            bh.updated_at::text AS updated_at
       FROM billing_headers bh
       JOIN business_partners bp ON bp.tenant_id = bh.tenant_id AND bp.id = bh.partner_id
      WHERE (
          $1::text IS NULL
          OR CAST(bh.billing_no AS text) ILIKE '%' || $1 || '%'
          OR bp.partner_name ILIKE '%' || $1 || '%'
          OR bp.partner_code ILIKE '%' || $1 || '%'
        )
        AND ($2::uuid IS NULL OR bh.partner_id = $2::uuid)
        AND ($3::text IS NULL OR bh.status::text = $3)
        AND (
          $4::text = 'ALL'
          OR ($4::text = 'STANDARD' AND bh.is_subscription_bill = false)
          OR ($4::text = 'SUBSCRIPTION' AND bh.is_subscription_bill = true)
        )
        AND ($5::date IS NULL OR bh.billing_date >= $5::date)
        AND ($6::date IS NULL OR bh.billing_date <= $6::date)
      ORDER BY bh.billing_date DESC, bh.billing_no DESC
      LIMIT $7 OFFSET $8`,
    [f.kw, f.partnerId, f.status, f.subKind, f.dateFrom, f.dateTo, f.pageSize, f.offset],
  );

  return {
    items: rows.map(mapBillingListItemRow),
    summary: {
      totalCount: sum !== undefined ? Number(sum.total_count) : 0,
      sumBillingAmount: sum !== undefined ? Number(sum.sum_billing) : 0,
      sumTaxTotal: sum !== undefined ? Number(sum.sum_tax) : 0,
      sumPrevCarried: sum !== undefined ? Number(sum.sum_prev) : 0,
      sumPeriodReceipt: sum !== undefined ? Number(sum.sum_receipt) : 0,
      sumClosingAr: sum !== undefined ? Number(sum.sum_closing) : 0,
    },
    page: f.page,
    pageSize: f.pageSize,
  };
}

export async function getBillingDetail(
  tx: DbExecutor,
  tenantId: string,
  billingId: string,
): Promise<BillingDetailDto> {
  await requireAnyBillingReadFeature(tx, tenantId);
  validateUuid(billingId, '請求ヘッダ');

  const headerRows = await tx.query<BillingHeaderRow>(
    `SELECT bh.id, bh.billing_no::text AS billing_no, bh.partner_id,
            bp.partner_code, bp.partner_name,
            bh.billing_date::text AS billing_date,
            bh.target_period_start::text AS target_period_start,
            bh.target_period_end::text AS target_period_end,
            bh.payment_due_date::text AS payment_due_date,
            bh.is_subscription_bill,
            bh.tax_calc_policy::text AS tax_calc_policy,
            bh.rounding_mode::text AS rounding_mode,
            bh.amount_10_excl::text AS amount_10_excl,
            bh.amount_8_excl::text AS amount_8_excl,
            bh.amount_0_non_tax::text AS amount_0_non_tax,
            bh.tax_10_amount::text AS tax_10_amount,
            bh.tax_8_amount::text AS tax_8_amount,
            bh.tax_adjustment_amount::text AS tax_adjustment_amount,
            bh.tax_total::text AS tax_total,
            bh.billing_amount::text AS billing_amount,
            bh.prev_carried_balance::text AS prev_carried_balance,
            bh.period_receipt_amount::text AS period_receipt_amount,
            bh.net_carried_balance::text AS net_carried_balance,
            bh.closing_ar_balance::text AS closing_ar_balance,
            bh.status::text AS status,
            (SELECT COUNT(*)::int FROM sales_headers sh WHERE sh.billing_id = bh.id) AS slip_count,
            (SELECT COUNT(*)::int FROM document_snapshots ds
              WHERE ds.source_entity_type = 'BILLING_HEADER'
                AND ds.source_entity_id = bh.id) AS snapshot_count,
            (SELECT ds.id FROM document_snapshots ds
              WHERE ds.source_entity_type = 'BILLING_HEADER'
                AND ds.source_entity_id = bh.id
              ORDER BY ds.issued_at DESC, ds.version_no DESC
              LIMIT 1) AS latest_snapshot_id,
            (SELECT ds.document_type::text FROM document_snapshots ds
              WHERE ds.source_entity_type = 'BILLING_HEADER'
                AND ds.source_entity_id = bh.id
              ORDER BY ds.issued_at DESC, ds.version_no DESC
              LIMIT 1) AS latest_snapshot_doc_type,
            (SELECT ds.version_no FROM document_snapshots ds
              WHERE ds.source_entity_type = 'BILLING_HEADER'
                AND ds.source_entity_id = bh.id
              ORDER BY ds.issued_at DESC, ds.version_no DESC
              LIMIT 1) AS latest_snapshot_ver,
            bh.created_at::text AS created_at,
            bh.updated_at::text AS updated_at
       FROM billing_headers bh
       JOIN business_partners bp ON bp.tenant_id = bh.tenant_id AND bp.id = bh.partner_id
      WHERE bh.id = $1::uuid
      LIMIT 1`,
    [billingId],
  );
  const header = headerRows[0];
  if (header === undefined) {
    throw new MasterDataError(404, 'BILLING_NOT_FOUND', '請求データが見つかりません。');
  }

  const slipRows = await tx.query<{
    id: string;
    entry_type: SalesEntryType;
    slip_no: string;
    slip_name: string;
    slip_date: string;
    status: SalesStatus;
    sales_kubun: string | null;
    subtotal_amount: string;
    tax_total: string;
    total_amount: string;
  }>(
    `SELECT id, entry_type::text AS entry_type, slip_no::text AS slip_no,
            slip_name, slip_date::text AS slip_date, status::text AS status,
            sales_kubun, subtotal_amount::text AS subtotal_amount,
            tax_total::text AS tax_total, total_amount::text AS total_amount
       FROM sales_headers
      WHERE billing_id = $1::uuid
      ORDER BY slip_date ASC, entry_type ASC, slip_no ASC`,
    [billingId],
  );

  const lineRows = await tx.query<{
    id: string;
    sales_header_id: string;
    line_no: number;
    item_code: string | null;
    item_name: string;
    unit_name: string | null;
    target_month_label: string | null;
    is_heading: boolean;
    quantity: string;
    applied_unit_price: string;
    tax_code: TaxCode;
    line_amount: string;
    line_tax: string;
    row_total: string;
    remarks: string | null;
  }>(
    `SELECT sl.id, sl.sales_header_id, sl.line_no, sl.item_code, sl.item_name,
            sl.unit_name, sl.target_month_label, sl.is_heading,
            sl.quantity::text AS quantity,
            sl.applied_unit_price::text AS applied_unit_price,
            sl.tax_code,
            sl.line_amount::text AS line_amount,
            sl.line_tax::text AS line_tax,
            sl.row_total::text AS row_total,
            sl.remarks
       FROM sales_lines sl
       JOIN sales_headers sh ON sh.tenant_id = sl.tenant_id AND sh.id = sl.sales_header_id
      WHERE sh.billing_id = $1::uuid
      ORDER BY sh.slip_date ASC, sh.slip_no ASC, sl.line_no ASC`,
    [billingId],
  );

  const linesBySlip = new Map<string, BillingLinkedSlipLineDto[]>();
  for (const lr of lineRows) {
    const lineAmt = BigInt(lr.line_amount);
    const lineTax = BigInt(lr.line_tax);
    const isInternal = lr.tax_code === 'D' || lr.tax_code === 'E';
    const exclAmt = isInternal ? lineAmt - lineTax : lineAmt;

    const lineDto: BillingLinkedSlipLineDto = {
      id: lr.id,
      lineNo: Number(lr.line_no),
      itemCode: lr.item_code,
      itemName: lr.item_name,
      unitName: lr.unit_name,
      targetMonthLabel: lr.target_month_label,
      isHeading: lr.is_heading,
      quantity: Number(lr.quantity),
      appliedUnitPrice: Number(lr.applied_unit_price),
      taxCode: lr.tax_code,
      lineAmount: Number(lineAmt),
      lineTax: Number(lineTax),
      exclAmount: Number(exclAmt),
      rowTotal: Number(lr.row_total),
      remarks: lr.remarks,
    };

    const existing = linesBySlip.get(lr.sales_header_id);
    if (existing !== undefined) {
      existing.push(lineDto);
    } else {
      linesBySlip.set(lr.sales_header_id, [lineDto]);
    }
  }

  const slips: BillingLinkedSlipDto[] = slipRows.map((sr) => {
    const sLines = linesBySlip.get(sr.id);
    return {
      id: sr.id,
      entryType: sr.entry_type,
      slipNo: Number(sr.slip_no),
      slipName: sr.slip_name,
      slipDate: sr.slip_date.slice(0, 10),
      status: sr.status,
      salesKubun: sr.sales_kubun,
      subtotalAmount: Number(sr.subtotal_amount),
      taxTotal: Number(sr.tax_total),
      totalAmount: Number(sr.total_amount),
      lines: sLines !== undefined ? sLines : [],
    };
  });

  const snapRows = await tx.query<{
    id: string;
    document_type: BillingDocumentType;
    source_entity_type: SnapshotHistoryItemDto['sourceEntityType'];
    source_entity_id: string;
    document_no: string;
    version_no: number;
    is_reissue: boolean;
    reissue_label: string | null;
    template_variant: string;
    issued_at: string;
    issued_by: string | null;
    issued_by_name: string | null;
    payload_sha256: string;
  }>(
    `SELECT ds.id, ds.document_type::text AS document_type, ds.source_entity_type,
            ds.source_entity_id, ds.document_no, ds.version_no, ds.is_reissue,
            ds.reissue_label, ds.template_variant, ds.issued_at::text AS issued_at,
            ds.issued_by, e.syain_name AS issued_by_name, ds.payload_sha256
       FROM document_snapshots ds
       LEFT JOIN employees e ON e.tenant_id = ds.tenant_id AND e.id = ds.issued_by
      WHERE ds.source_entity_type = 'BILLING_HEADER'
        AND ds.source_entity_id = $1::uuid
      ORDER BY ds.issued_at DESC, ds.document_type ASC, ds.version_no DESC`,
    [billingId],
  );

  const snapshots: SnapshotHistoryItemDto[] = snapRows.map((r) => ({
    id: r.id,
    documentType: r.document_type,
    sourceEntityType: r.source_entity_type,
    sourceEntityId: r.source_entity_id,
    documentNo: r.document_no,
    versionNo: Number(r.version_no),
    isReissue: r.is_reissue,
    reissueLabel: r.reissue_label,
    templateVariant: r.template_variant,
    issuedAt: r.issued_at,
    issuedBy: r.issued_by,
    issuedByName: r.issued_by_name,
    payloadSha256: r.payload_sha256,
  }));

  return {
    ...mapBillingListItemRow(header),
    createdAt: header.created_at,
    slips,
    snapshots,
  };
}

interface BillingSimpleRow extends Record<string, unknown> {
  billing_no: string;
  billing_date: string;
  partner_code: string;
  partner_name: string;
  slip_no: string;
  slip_date: string;
  entry_type: SalesEntryType;
  slip_name: string;
  slip_status: SalesStatus;
  subtotal_amount: string;
  tax_total: string;
  total_amount: string;
}

interface BillingDetailRow extends Record<string, unknown> {
  billing_no: string;
  billing_date: string;
  partner_code: string;
  partner_name: string;
  slip_no: string;
  line_no: number;
  item_name: string;
  quantity: string;
  unit_name: string | null;
  applied_unit_price: string;
  tax_code: TaxCode;
  line_amount: string;
  line_tax: string;
  row_total: string;
}

async function queryBillingSimpleRows(
  tx: DbExecutor,
  f: ReturnType<typeof normalizeBillingListFilter>,
): Promise<BillingSimpleRow[]> {
  return tx.query<BillingSimpleRow>(
    `SELECT bh.billing_no::text AS billing_no,
            bh.billing_date::text AS billing_date,
            bp.partner_code,
            bp.partner_name,
            sh.slip_no::text AS slip_no,
            sh.slip_date::text AS slip_date,
            sh.entry_type::text AS entry_type,
            sh.slip_name,
            sh.status::text AS slip_status,
            sh.subtotal_amount::text AS subtotal_amount,
            sh.tax_total::text AS tax_total,
            sh.total_amount::text AS total_amount
       FROM sales_headers sh
       JOIN billing_headers bh ON bh.tenant_id = sh.tenant_id AND bh.id = sh.billing_id
       JOIN business_partners bp ON bp.tenant_id = bh.tenant_id AND bp.id = bh.partner_id
      WHERE (
          $1::text IS NULL
          OR CAST(bh.billing_no AS text) ILIKE '%' || $1 || '%'
          OR bp.partner_name ILIKE '%' || $1 || '%'
          OR bp.partner_code ILIKE '%' || $1 || '%'
        )
        AND ($2::uuid IS NULL OR bh.partner_id = $2::uuid)
        AND ($3::text IS NULL OR bh.status::text = $3)
        AND (
          $4::text = 'ALL'
          OR ($4::text = 'STANDARD' AND bh.is_subscription_bill = false)
          OR ($4::text = 'SUBSCRIPTION' AND bh.is_subscription_bill = true)
        )
        AND ($5::date IS NULL OR bh.billing_date >= $5::date)
        AND ($6::date IS NULL OR bh.billing_date <= $6::date)
      ORDER BY bh.billing_date DESC, bh.billing_no DESC, sh.slip_date ASC, sh.slip_no ASC
      LIMIT 5000`,
    [f.kw, f.partnerId, f.status, f.subKind, f.dateFrom, f.dateTo],
  );
}

async function queryBillingDetailRows(
  tx: DbExecutor,
  f: ReturnType<typeof normalizeBillingListFilter>,
): Promise<BillingDetailRow[]> {
  return tx.query<BillingDetailRow>(
    `SELECT bh.billing_no::text AS billing_no,
            bh.billing_date::text AS billing_date,
            bp.partner_code,
            bp.partner_name,
            sh.slip_no::text AS slip_no,
            sl.line_no,
            sl.item_name,
            sl.quantity::text AS quantity,
            sl.unit_name,
            sl.applied_unit_price::text AS applied_unit_price,
            sl.tax_code,
            sl.line_amount::text AS line_amount,
            sl.line_tax::text AS line_tax,
            sl.row_total::text AS row_total
       FROM sales_lines sl
       JOIN sales_headers sh ON sh.tenant_id = sl.tenant_id AND sh.id = sl.sales_header_id
       JOIN billing_headers bh ON bh.tenant_id = sh.tenant_id AND bh.id = sh.billing_id
       JOIN business_partners bp ON bp.tenant_id = bh.tenant_id AND bp.id = bh.partner_id
      WHERE sl.is_heading = false
        AND (
          $1::text IS NULL
          OR CAST(bh.billing_no AS text) ILIKE '%' || $1 || '%'
          OR bp.partner_name ILIKE '%' || $1 || '%'
          OR bp.partner_code ILIKE '%' || $1 || '%'
        )
        AND ($2::uuid IS NULL OR bh.partner_id = $2::uuid)
        AND ($3::text IS NULL OR bh.status::text = $3)
        AND (
          $4::text = 'ALL'
          OR ($4::text = 'STANDARD' AND bh.is_subscription_bill = false)
          OR ($4::text = 'SUBSCRIPTION' AND bh.is_subscription_bill = true)
        )
        AND ($5::date IS NULL OR bh.billing_date >= $5::date)
        AND ($6::date IS NULL OR bh.billing_date <= $6::date)
      ORDER BY bh.billing_date DESC, bh.billing_no DESC, sh.slip_no ASC, sl.line_no ASC
      LIMIT 5000`,
    [f.kw, f.partnerId, f.status, f.subKind, f.dateFrom, f.dateTo],
  );
}

function buildFilterSummaryText(f: ReturnType<typeof normalizeBillingListFilter>): string {
  const parts: string[] = [];
  if (f.kw !== null) parts.push(`検索:${f.kw}`);
  if (f.status !== null) parts.push(`状態:${RECEIVABLE_STATUS_LABELS[f.status]}`);
  if (f.subKind === 'STANDARD') parts.push('区分:通常請求');
  if (f.subKind === 'SUBSCRIPTION') parts.push('区分:定額請求');
  if (f.dateFrom !== null || f.dateTo !== null) {
    parts.push(`請求日:${f.dateFrom !== null ? f.dateFrom : ''}〜${f.dateTo !== null ? f.dateTo : ''}`);
  }
  return parts.length > 0 ? parts.join(' / ') : '全件';
}

export async function exportBillingListCsv(
  tx: DbExecutor,
  tenantId: string,
  target: BillingExportTarget,
  filter: BillingListFilter,
): Promise<string> {
  await requireAnyBillingReadFeature(tx, tenantId);
  const f = normalizeBillingListFilter({ ...filter, page: 1, pageSize: 5000 });

  if (target === 'standard') {
    const page = await listBillingHeaders(tx, tenantId, { ...filter, page: 1, pageSize: 5000 });
    const header = [
      '請求番号',
      '請求日',
      '支払期限',
      '取引先コード',
      '取引先名',
      '種別',
      '状態',
      '前回繰越',
      '当月入金',
      '差引繰越',
      '今回税抜',
      '消費税',
      'インボイス調整額',
      '今回請求税込',
      '今回売掛残高',
    ]
      .map(escapeCsvCell)
      .join(',');

    const lines = page.items.map((item) =>
      [
        String(item.billingNo),
        item.billingDate,
        item.paymentDueDate !== null ? item.paymentDueDate : '',
        item.partnerCode,
        item.partnerName,
        item.isSubscriptionBill ? '定額' : '通常',
        `${item.status}:${RECEIVABLE_STATUS_LABELS[item.status]}`,
        String(item.prevCarriedBalance),
        String(item.periodReceiptAmount),
        String(item.netCarriedBalance),
        String(item.currentExclAmount),
        String(item.taxTotal),
        String(item.taxAdjustmentAmount),
        String(item.billingAmount),
        String(item.closingArBalance),
      ]
        .map(escapeCsvCell)
        .join(','),
    );
    return `\uFEFF${[header, ...lines].join('\r\n')}`;
  }

  if (target === 'simple') {
    const rows = await queryBillingSimpleRows(tx, f);
    const header = [
      '請求番号',
      '請求日',
      '取引先コード',
      '取引先名',
      '伝票番号',
      '売上日',
      '区分',
      '件名',
      '伝票状態',
      '伝票税抜',
      '伝票消費税',
      '伝票税込',
    ]
      .map(escapeCsvCell)
      .join(',');

    const lines = rows.map((r) =>
      [
        r.billing_no,
        r.billing_date.slice(0, 10),
        r.partner_code,
        r.partner_name,
        r.slip_no,
        r.slip_date.slice(0, 10),
        ENTRY_TYPE_LABELS[r.entry_type],
        r.slip_name,
        `${r.slip_status}:${SALES_STATUS_LABELS[r.slip_status]}`,
        r.subtotal_amount,
        r.tax_total,
        r.total_amount,
      ]
        .map(escapeCsvCell)
        .join(','),
    );
    return `\uFEFF${[header, ...lines].join('\r\n')}`;
  }

  const detailRows = await queryBillingDetailRows(tx, f);
  const header = [
    '請求番号',
    '請求日',
    '取引先コード',
    '取引先名',
    '伝票番号',
    '行',
    '品名・仕様',
    '数量',
    '単位',
    '適用単価',
    '税区分',
    '税抜金額',
    '消費税',
    '税込行計',
  ]
    .map(escapeCsvCell)
    .join(',');

  const lines = detailRows.map((r) => {
    const lineAmt = BigInt(r.line_amount);
    const lineTax = BigInt(r.line_tax);
    const isInternal = r.tax_code === 'D' || r.tax_code === 'E';
    const exclAmt = isInternal ? lineAmt - lineTax : lineAmt;
    return [
      r.billing_no,
      r.billing_date.slice(0, 10),
      r.partner_code,
      r.partner_name,
      r.slip_no,
      String(r.line_no),
      r.item_name,
      r.quantity,
      r.unit_name !== null ? r.unit_name : '',
      r.applied_unit_price,
      r.tax_code,
      exclAmt.toString(),
      lineTax.toString(),
      r.row_total,
    ]
      .map(escapeCsvCell)
      .join(',');
  });

  return `\uFEFF${[header, ...lines].join('\r\n')}`;
}

export async function exportBillingListPdf(
  tx: DbExecutor,
  tenantId: string,
  target: BillingExportTarget,
  filter: BillingListFilter,
): Promise<Uint8Array> {
  await requireAnyBillingReadFeature(tx, tenantId);
  const f = normalizeBillingListFilter({ ...filter, page: 1, pageSize: 5000 });

  const settingsRows = await tx.query<{ company_name: string }>(
    'SELECT company_name FROM tenant_settings WHERE tenant_id = $1::uuid LIMIT 1',
    [tenantId],
  );
  const companyName = settingsRows[0] !== undefined ? settingsRows[0].company_name : '自社';
  const generatedDate = new Date().toISOString().slice(0, 10);
  const filterSummary = buildFilterSummaryText(f);

  if (target === 'standard') {
    const page = await listBillingHeaders(tx, tenantId, { ...filter, page: 1, pageSize: 5000 });
    let sumExcl = 0;
    for (const item of page.items) {
      sumExcl += item.currentExclAmount;
    }
    return renderBillingListPdf({
      companyName,
      generatedDate,
      filterSummary,
      items: page.items.map((item) => ({
        billingNo: item.billingNo,
        billingDate: item.billingDate,
        paymentDueDate: item.paymentDueDate,
        partnerName: item.partnerName,
        isSubscriptionBill: item.isSubscriptionBill,
        statusLabel: RECEIVABLE_STATUS_LABELS[item.status],
        prevCarriedBalance: item.prevCarriedBalance,
        periodReceiptAmount: item.periodReceiptAmount,
        netCarriedBalance: item.netCarriedBalance,
        currentExclAmount: item.currentExclAmount,
        taxTotal: item.taxTotal,
        billingAmount: item.billingAmount,
        closingArBalance: item.closingArBalance,
      })),
      totals: {
        count: page.items.length,
        prevCarriedBalance: page.summary.sumPrevCarried,
        periodReceiptAmount: page.summary.sumPeriodReceipt,
        currentExclAmount: sumExcl,
        taxTotal: page.summary.sumTaxTotal,
        billingAmount: page.summary.sumBillingAmount,
        closingArBalance: page.summary.sumClosingAr,
      },
    });
  }

  if (target === 'simple') {
    const rows = await queryBillingSimpleRows(tx, f);
    let sumExcl = 0;
    let sumTax = 0;
    let sumTotal = 0;
    const items = rows.map((r) => {
      const excl = Number(r.subtotal_amount);
      const tax = Number(r.tax_total);
      const total = Number(r.total_amount);
      sumExcl += excl;
      sumTax += tax;
      sumTotal += total;
      return {
        billingNo: Number(r.billing_no),
        billingDate: r.billing_date.slice(0, 10),
        partnerName: r.partner_name,
        slipNo: Number(r.slip_no),
        slipDate: r.slip_date.slice(0, 10),
        entryTypeLabel: ENTRY_TYPE_LABELS[r.entry_type],
        slipName: r.slip_name,
        slipStatusLabel: SALES_STATUS_LABELS[r.slip_status],
        subtotalAmount: excl,
        taxTotal: tax,
        totalAmount: total,
      };
    });
    return renderBillingSimpleListPdf({
      companyName,
      generatedDate,
      filterSummary,
      items,
      totals: {
        count: items.length,
        subtotalAmount: sumExcl,
        taxTotal: sumTax,
        totalAmount: sumTotal,
      },
    });
  }

  const detailRows = await queryBillingDetailRows(tx, f);
  let sumExcl = 0;
  let sumTax = 0;
  let sumRowTotal = 0;
  const items = detailRows.map((r) => {
    const lineAmt = BigInt(r.line_amount);
    const lineTaxBig = BigInt(r.line_tax);
    const isInternal = r.tax_code === 'D' || r.tax_code === 'E';
    const exclBig = isInternal ? lineAmt - lineTaxBig : lineAmt;
    const exclAmount = Number(exclBig);
    const lineTax = Number(lineTaxBig);
    const rowTotal = Number(r.row_total);
    sumExcl += exclAmount;
    sumTax += lineTax;
    sumRowTotal += rowTotal;
    return {
      billingNo: Number(r.billing_no),
      billingDate: r.billing_date.slice(0, 10),
      partnerName: r.partner_name,
      slipNo: Number(r.slip_no),
      lineNo: Number(r.line_no),
      itemName: r.item_name,
      quantity: Number(r.quantity),
      unitName: r.unit_name,
      appliedUnitPrice: Number(r.applied_unit_price),
      taxCode: r.tax_code,
      exclAmount,
      lineTax,
      rowTotal,
    };
  });

  return renderBillingDetailListPdf({
    companyName,
    generatedDate,
    filterSummary,
    items,
    totals: {
      count: items.length,
      exclAmount: sumExcl,
      lineTax: sumTax,
      rowTotal: sumRowTotal,
    },
  });
}

// 未使用警告防止のため明示型参照を維持
export type { ApprovalStatus };
