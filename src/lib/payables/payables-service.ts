import type { DbExecutor } from '@/lib/db/tenant-client';
import type {
  PayableListPdfInput,
  SupplierPaymentListPdfInput,
} from '@/lib/domain/pdf-renderer';
import { isFeatureEnabled, requireFeature } from '@/lib/feature-flags/gate';
import { mapPgConstraintError, MasterDataError } from '@/lib/masters/error-mapper';
import { calculatePartnersApBalances } from '@/lib/payables/ap-balance-service';
import type {
  PayableBalanceFilter,
  PayableBalanceItemDto,
  PayableBalanceListResultDto,
  PayableLedgerItemDto,
  PayablesLookupsDto,
  SupplierPaymentDto,
  SupplierPaymentInput,
  SupplierPaymentListFilter,
  SupplierPaymentPageDto,
} from '@/lib/payables/types';
import { PAYABLE_STATUS_LABELS, type PayableStatus } from '@/lib/purchasing/types';

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DATE_REGEX = /^\d{4}-\d{2}-\d{2}$/;
const DIGITS_ONLY_REGEX = /^\d+$/;
const VALID_PAYABLE_STATUSES = new Set<PayableStatus>(['A1', 'A2']);

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

function addOneDayIso(dateStr: string): string {
  const parts = dateStr.split('-');
  const y = Number(parts[0]);
  const m = Number(parts[1]);
  const d = Number(parts[2]);
  const next = new Date(Date.UTC(y, m - 1, d + 1));
  return next.toISOString().slice(0, 10);
}

function defaultPeriodAfterCutoff(openingBalanceDate: string): {
  periodStart: string;
  periodEnd: string;
} {
  const now = new Date();
  const y = now.getUTCFullYear();
  const m = now.getUTCMonth() + 1;
  const lastDay = new Date(Date.UTC(y, m, 0)).getUTCDate();
  const yStr = String(y).padStart(4, '0');
  const mStr = String(m).padStart(2, '0');
  const monthStart = `${yStr}-${mStr}-01`;
  const monthEnd = `${yStr}-${mStr}-${String(lastDay).padStart(2, '0')}`;

  if (monthStart > openingBalanceDate) {
    return { periodStart: monthStart, periodEnd: monthEnd };
  }
  const nextDay = addOneDayIso(openingBalanceDate);
  const nextParts = nextDay.split('-');
  const ny = Number(nextParts[0]);
  const nm = Number(nextParts[1]);
  const nLastDay = new Date(Date.UTC(ny, nm, 0)).getUTCDate();
  return {
    periodStart: nextDay,
    periodEnd: `${String(ny).padStart(4, '0')}-${String(nm).padStart(2, '0')}-${String(nLastDay).padStart(2, '0')}`,
  };
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

function parsePayablesJson<T>(raw: T | string): T {
  if (typeof raw === 'string') {
    return JSON.parse(raw) as T;
  }
  return raw;
}

export async function getPayablesLookups(
  tx: DbExecutor,
  tenantId: string,
): Promise<PayablesLookupsDto> {
  const [payableEnabled, paymentEnabled, purchaseEnabled] = await Promise.all([
    isFeatureEnabled(tx, tenantId, 'payable'),
    isFeatureEnabled(tx, tenantId, 'payment'),
    isFeatureEnabled(tx, tenantId, 'purchase'),
  ]);

  if (!payableEnabled && !paymentEnabled) {
    await requireFeature(tx, tenantId, 'payable');
  }

  type TsJson = { opening_balance_date: string; default_ar_list_date_mode: number };
  type PartnerJson = {
    id: string;
    partner_code: string;
    partner_name: string;
    is_individual_honorific: boolean;
    representative_name: string | null;
    is_client: boolean;
    is_supplier: boolean;
  };
  type ProjectJson = {
    id: string;
    project_no: string;
    project_name: string;
    partner_id: string;
    status: string;
  };
  type MethodJson = { method_code: string; method_name: string };
  type ClosingJson = { code: string; name: string };

  const rows = await tx.query<{
    ts_json: TsJson | string | null;
    partners_json: PartnerJson[] | string;
    projects_json: ProjectJson[] | string;
    methods_json: MethodJson[] | string;
    closing_days_json: ClosingJson[] | string;
  }>(
    `SELECT
       (
         SELECT json_build_object(
           'opening_balance_date', ts.opening_balance_date::text,
           'default_ar_list_date_mode', ts.default_ar_list_date_mode
         )
           FROM tenant_settings ts
          WHERE ts.tenant_id = $1::uuid
          LIMIT 1
       ) AS ts_json,
       COALESCE(
         (
           SELECT json_agg(row_to_json(bp) ORDER BY bp.is_supplier DESC, bp.partner_code ASC)
             FROM (
               SELECT bp.id, bp.partner_code, bp.partner_name, bp.is_individual_honorific,
                      r.representative_name, bp.is_client, bp.is_supplier
                 FROM business_partners bp
                 LEFT JOIN representatives r ON r.tenant_id = bp.tenant_id AND r.id = bp.representative_id
                WHERE bp.is_deleted = false
             ) bp
         ),
         '[]'::json
       ) AS partners_json,
       COALESCE(
         (
           SELECT json_agg(
             json_build_object(
               'id', pj.id,
               'project_no', pj.project_no,
               'project_name', pj.project_name,
               'partner_id', pj.partner_id,
               'status', pj.status
             )
             ORDER BY pj.project_no_num DESC
           )
             FROM (
               SELECT id, project_no::text AS project_no, project_no AS project_no_num,
                      project_name, partner_id, status::text AS status
                 FROM projects
             ) pj
         ),
         '[]'::json
       ) AS projects_json,
       COALESCE(
         (
           SELECT json_agg(
             json_build_object('method_code', pm.method_code, 'method_name', pm.method_name)
             ORDER BY pm.method_code ASC
           )
             FROM payment_methods pm
         ),
         '[]'::json
       ) AS methods_json,
       COALESCE(
         (
           SELECT json_agg(
             json_build_object('code', cm.code, 'name', cm.name)
             ORDER BY cm.display_order ASC, cm.code ASC
           )
             FROM code_masters cm
            WHERE cm.domain_key = 'BILL_CLOSE' AND cm.is_active = true
         ),
         '[]'::json
       ) AS closing_days_json`,
    [tenantId],
  );

  const dbRow = rows[0];
  if (dbRow === undefined || dbRow.ts_json === null) {
    throw new MasterDataError(404, 'TENANT_SETTINGS_NOT_FOUND', '自社設定が見つかりません。');
  }

  const settings = parsePayablesJson<TsJson>(dbRow.ts_json);
  const partnerRows = parsePayablesJson<PartnerJson[]>(dbRow.partners_json);
  const projectRows = parsePayablesJson<ProjectJson[]>(dbRow.projects_json);
  const methodRows = parsePayablesJson<MethodJson[]>(dbRow.methods_json);
  const closingRows = parsePayablesJson<ClosingJson[]>(dbRow.closing_days_json);

  return {
    openingBalanceDate: settings.opening_balance_date.slice(0, 10),
    defaultArListDateMode: Number(settings.default_ar_list_date_mode),
    payableEnabled,
    paymentEnabled,
    purchaseEnabled,
    partners: partnerRows.map((p) => ({
      id: p.id,
      partnerCode: p.partner_code,
      partnerName: p.partner_name,
      isIndividualHonorific: p.is_individual_honorific,
      representativeName: p.representative_name,
      isClient: p.is_client,
      isSupplier: p.is_supplier,
    })),
    projects: projectRows.map((r) => ({
      id: r.id,
      projectNo: Number(r.project_no),
      projectName: r.project_name,
      partnerId: r.partner_id,
      status: r.status,
    })),
    paymentMethods: methodRows.map((m) => ({
      methodCode: m.method_code,
      methodName: m.method_name,
    })),
    closingDays: closingRows,
  };
}

/**
 * 買掛残高一覧集計（旧 rp_買掛一覧：ap-balance-service.ts 共用）
 * - periodStart > opening_balance_date を検証
 */
export async function listPayableBalances(
  tx: DbExecutor,
  tenantId: string,
  filter: PayableBalanceFilter = {},
): Promise<PayableBalanceListResultDto> {
  await requireFeature(tx, tenantId, 'payable');

  const tsRows = await tx.query<{ opening_balance_date: string }>(
    `SELECT opening_balance_date::text AS opening_balance_date
       FROM tenant_settings
      WHERE tenant_id = $1::uuid
      LIMIT 1`,
    [tenantId],
  );
  const ts = tsRows[0];
  if (ts === undefined) {
    throw new MasterDataError(404, 'TENANT_SETTINGS_NOT_FOUND', '自社設定が見つかりません。');
  }
  const openingBalanceDate = ts.opening_balance_date.slice(0, 10);
  const def = defaultPeriodAfterCutoff(openingBalanceDate);

  const rawStart = optTrimmed(filter.periodStart);
  const rawEnd = optTrimmed(filter.periodEnd);
  const periodStart =
    rawStart !== null ? validateDateOnly(rawStart, '集計期間開始日') : def.periodStart;
  const periodEnd = rawEnd !== null ? validateDateOnly(rawEnd, '集計期間終了日') : def.periodEnd;

  if (periodStart <= openingBalanceDate) {
    throw new MasterDataError(
      400,
      'PERIOD_BEFORE_CUTOFF',
      `集計開始日は期首残高基準日 (${openingBalanceDate}) より後の日付を指定してください。`,
    );
  }
  if (periodStart > periodEnd) {
    throw new MasterDataError(
      400,
      'INVALID_PERIOD_RANGE',
      '集計開始日は集計終了日以前を指定してください。',
    );
  }

  const rawSupplier = optTrimmed(filter.supplierId);
  if (rawSupplier !== null) {
    validateUuid(rawSupplier, '仕入先');
  }
  const closingDayCode = optTrimmed(filter.closingDayCode);
  const keyword = optTrimmed(filter.keyword);
  const onlyWithBalance = filter.onlyWithBalance === true;

  const partnerRows = await tx.query<{
    id: string;
    partner_code: string;
    partner_name: string;
    closing_day_code: string | null;
    closing_day_name: string | null;
  }>(
    `SELECT bp.id, bp.partner_code, bp.partner_name, bp.closing_day_code,
            cm.name AS closing_day_name
       FROM business_partners bp
       LEFT JOIN code_masters cm
         ON cm.tenant_id = bp.tenant_id
        AND cm.domain_key = 'BILL_CLOSE'
        AND cm.code = bp.closing_day_code
      WHERE bp.is_deleted = false
        AND ($1::uuid IS NULL OR bp.id = $1::uuid)
        AND ($2::text IS NULL OR bp.closing_day_code = $2)
        AND ($3::text IS NULL OR bp.partner_code ILIKE '%' || $3 || '%'
             OR bp.partner_name ILIKE '%' || $3 || '%')
        AND ($1::uuid IS NOT NULL
             OR bp.is_supplier = true
             OR bp.opening_ap_balance <> 0
             OR EXISTS (SELECT 1 FROM payable_ledgers pl WHERE pl.supplier_id = bp.id)
             OR EXISTS (SELECT 1 FROM supplier_payments sp WHERE sp.supplier_id = bp.id))
      ORDER BY bp.partner_code ASC`,
    [rawSupplier, closingDayCode, keyword],
  );

  if (partnerRows.length === 0) {
    return {
      openingBalanceDate,
      periodStart,
      periodEnd,
      items: [],
      totals: {
        supplierCount: 0,
        prevCarriedBalance: 0,
        periodPayableExcl: 0,
        periodPayableTax: 0,
        periodPayableIncl: 0,
        periodPaymentAmount: 0,
        periodNetDelta: 0,
        closingApBalance: 0,
      },
    };
  }

  const apMap = await calculatePartnersApBalances(tx, {
    tenantId,
    supplierIds: partnerRows.map((p) => p.id),
    periodStart,
    periodEnd,
  });

  const items: PayableBalanceItemDto[] = [];
  let sumPrevCarried = 0n;
  let sumPayExcl = 0n;
  let sumPayTax = 0n;
  let sumPayIncl = 0n;
  let sumPayment = 0n;
  let sumDelta = 0n;
  let sumClosingAp = 0n;

  for (const p of partnerRows) {
    const summary = apMap.get(p.id);
    if (summary === undefined) {
      continue;
    }
    if (
      onlyWithBalance &&
      summary.prevCarriedBalance === 0n &&
      summary.inPeriodPayablesIncl === 0n &&
      summary.periodPaymentAmount === 0n &&
      summary.closingApBalance === 0n
    ) {
      continue;
    }

    items.push({
      supplierId: p.id,
      partnerCode: p.partner_code,
      partnerName: p.partner_name,
      closingDayCode: p.closing_day_code,
      closingDayName: p.closing_day_name,
      openingApBalance: Number(summary.openingApBalance),
      prevCarriedBalance: Number(summary.prevCarriedBalance),
      periodPayableExcl: Number(summary.inPeriodPayablesExcl),
      periodPayableTax: Number(summary.inPeriodPayablesTax),
      periodPayableIncl: Number(summary.inPeriodPayablesIncl),
      periodPaymentAmount: Number(summary.periodPaymentAmount),
      periodNetDelta: Number(summary.periodNetDelta),
      closingApBalance: Number(summary.closingApBalance),
    });

    sumPrevCarried += summary.prevCarriedBalance;
    sumPayExcl += summary.inPeriodPayablesExcl;
    sumPayTax += summary.inPeriodPayablesTax;
    sumPayIncl += summary.inPeriodPayablesIncl;
    sumPayment += summary.periodPaymentAmount;
    sumDelta += summary.periodNetDelta;
    sumClosingAp += summary.closingApBalance;
  }

  return {
    openingBalanceDate,
    periodStart,
    periodEnd,
    items,
    totals: {
      supplierCount: items.length,
      prevCarriedBalance: Number(sumPrevCarried),
      periodPayableExcl: Number(sumPayExcl),
      periodPayableTax: Number(sumPayTax),
      periodPayableIncl: Number(sumPayIncl),
      periodPaymentAmount: Number(sumPayment),
      periodNetDelta: Number(sumDelta),
      closingApBalance: Number(sumClosingAp),
    },
  };
}

export async function exportPayableBalancesCsv(
  tx: DbExecutor,
  tenantId: string,
  filter: PayableBalanceFilter,
): Promise<string> {
  const result = await listPayableBalances(tx, tenantId, filter);
  const header = [
    '仕入先コード',
    '仕入先名',
    '締日',
    '集計開始日',
    '集計終了日',
    '前回繰越残高',
    '当期仕入(税抜)',
    '当期消費税',
    '当期仕入(税込)',
    '当期支払額',
    '当期増減',
    '当期末買掛残高',
  ].map(escapeCsvCell);

  const lines = [header.join(',')];
  for (const item of result.items) {
    lines.push(
      [
        item.partnerCode,
        item.partnerName,
        item.closingDayName !== null ? item.closingDayName : '',
        result.periodStart,
        result.periodEnd,
        String(item.prevCarriedBalance),
        String(item.periodPayableExcl),
        String(item.periodPayableTax),
        String(item.periodPayableIncl),
        String(item.periodPaymentAmount),
        String(item.periodNetDelta),
        String(item.closingApBalance),
      ]
        .map(escapeCsvCell)
        .join(','),
    );
  }
  return `\uFEFF${lines.join('\r\n')}`;
}

export async function buildPayableBalancesPdfInput(
  tx: DbExecutor,
  tenantId: string,
  filter: PayableBalanceFilter,
): Promise<PayableListPdfInput> {
  const result = await listPayableBalances(tx, tenantId, filter);
  const settingsRows = await tx.query<{ company_name: string }>(
    'SELECT company_name FROM tenant_settings WHERE tenant_id = $1::uuid LIMIT 1',
    [tenantId],
  );
  const companyName = settingsRows[0] !== undefined ? settingsRows[0].company_name : '自社';

  return {
    companyName,
    generatedDate: new Date().toISOString().slice(0, 10),
    filterSummary: `期間:${result.periodStart}〜${result.periodEnd}`,
    items: result.items.map((i) => ({
      partnerCode: i.partnerCode,
      partnerName: i.partnerName,
      closingDayName: i.closingDayName,
      prevCarriedBalance: i.prevCarriedBalance,
      periodPayableExcl: i.periodPayableExcl,
      periodPayableTax: i.periodPayableTax,
      periodPayableIncl: i.periodPayableIncl,
      periodPaymentAmount: i.periodPaymentAmount,
      periodNetDelta: i.periodNetDelta,
      closingApBalance: i.closingApBalance,
    })),
    totals: {
      count: result.totals.supplierCount,
      prevCarriedBalance: result.totals.prevCarriedBalance,
      periodPayableExcl: result.totals.periodPayableExcl,
      periodPayableTax: result.totals.periodPayableTax,
      periodPayableIncl: result.totals.periodPayableIncl,
      periodPaymentAmount: result.totals.periodPaymentAmount,
      periodNetDelta: result.totals.periodNetDelta,
      closingApBalance: result.totals.closingApBalance,
    },
  };
}

/**
 * 仕入No (bill_no) 指定時に payable_ledgers の消込ステータス（A1/A2）を自動連動する
 */
export async function syncPayableSettlementByPurchaseNo(
  tx: DbExecutor,
  supplierId: string,
  billNoRaw: string | null,
  employeeId: string,
): Promise<PayableStatus | null> {
  if (billNoRaw === null) {
    return null;
  }
  const trimmed = billNoRaw.trim();
  if (!DIGITS_ONLY_REGEX.test(trimmed)) {
    return null;
  }

  const ledgerRows = await tx.query<{
    id: string;
    purchase_date: string;
    payable_amount: string;
  }>(
    `SELECT pl.id, pl.purchase_date::text AS purchase_date, pl.payable_amount::text AS payable_amount
       FROM payable_ledgers pl
       JOIN purchases p ON p.tenant_id = pl.tenant_id AND p.id = pl.purchase_id
      WHERE pl.supplier_id = $1::uuid
        AND p.purchase_no = $2::bigint
      FOR UPDATE OF pl`,
    [supplierId, trimmed],
  );
  const ledger = ledgerRows[0];
  if (ledger === undefined) {
    return null;
  }

  const tsRows = await tx.query<{ opening_balance_date: string }>(
    'SELECT opening_balance_date::text AS opening_balance_date FROM tenant_settings LIMIT 1',
    [],
  );
  const openingBalanceDate =
    tsRows[0] !== undefined ? tsRows[0].opening_balance_date.slice(0, 10) : null;
  if (openingBalanceDate !== null && ledger.purchase_date.slice(0, 10) <= openingBalanceDate) {
    return null;
  }

  const sumRows = await tx.query<{ paid_sum: string }>(
    `SELECT COALESCE(SUM(
              amount_1 + amount_2 + amount_3 +
              deduction_amt_1 + deduction_amt_2 + deduction_amt_3
            ), 0)::text AS paid_sum
       FROM supplier_payments
      WHERE supplier_id = $1::uuid
        AND bill_no = $2`,
    [supplierId, trimmed],
  );
  const paidSum = BigInt(sumRows[0] !== undefined ? sumRows[0].paid_sum : '0');
  const payableAmt = BigInt(ledger.payable_amount);

  const nextStatus: PayableStatus = payableAmt > 0n && paidSum >= payableAmt ? 'A2' : 'A1';

  await tx.query(
    `UPDATE payable_ledgers
        SET status = $2::payable_status,
            updated_by = $3::uuid
      WHERE id = $1::uuid`,
    [ledger.id, nextStatus, employeeId],
  );

  return nextStatus;
}

export async function listPayableLedgers(
  tx: DbExecutor,
  tenantId: string,
  filter: {
    supplierId?: string | null;
    projectId?: string | null;
    status?: PayableStatus | null;
    keyword?: string | null;
    unpaidOnly?: boolean;
  } = {},
): Promise<PayableLedgerItemDto[]> {
  await requireFeature(tx, tenantId, 'payable');

  const rawSupplier = optTrimmed(filter.supplierId);
  if (rawSupplier !== null) {
    validateUuid(rawSupplier, '仕入先');
  }
  const rawProject = optTrimmed(filter.projectId);
  if (rawProject !== null) {
    validateUuid(rawProject, '案件');
  }
  const status =
    filter.status !== undefined && filter.status !== null && VALID_PAYABLE_STATUSES.has(filter.status)
      ? filter.status
      : null;
  const kw = optTrimmed(filter.keyword);
  const unpaidOnly = filter.unpaidOnly === true;

  const rows = await tx.query<{
    id: string;
    supplier_id: string;
    supplier_code: string;
    supplier_name: string;
    purchase_id: string;
    purchase_no: string;
    purchase_name: string;
    purchase_date: string;
    payable_amount: string;
    amount_10_excl: string;
    amount_8_excl: string;
    amount_0_non_tax: string;
    tax_total: string;
    paid_amount: string;
    status: PayableStatus;
    scheduled_pay_at: string | null;
    ordered_at: string | null;
    project_ids: string[] | null;
    project_summary: string | null;
  }>(
    `SELECT pl.id, pl.supplier_id, bp.partner_code AS supplier_code, bp.partner_name AS supplier_name,
            pl.purchase_id, p.purchase_no::text AS purchase_no, p.purchase_name,
            pl.purchase_date::text AS purchase_date,
            pl.payable_amount::text AS payable_amount,
            pl.amount_10_excl::text AS amount_10_excl,
            pl.amount_8_excl::text AS amount_8_excl,
            pl.amount_0_non_tax::text AS amount_0_non_tax,
            pl.tax_total::text AS tax_total,
            COALESCE((
              SELECT SUM(
                sp.amount_1 + sp.amount_2 + sp.amount_3 +
                sp.deduction_amt_1 + sp.deduction_amt_2 + sp.deduction_amt_3
              )
                FROM supplier_payments sp
               WHERE sp.supplier_id = pl.supplier_id
                 AND sp.bill_no = p.purchase_no::text
            ), 0)::text AS paid_amount,
            pl.status::text AS status,
            pl.scheduled_pay_at::text AS scheduled_pay_at,
            pl.ordered_at::text AS ordered_at,
            (SELECT ARRAY_AGG(DISTINCT line.project_id::text)
               FROM purchase_lines line
              WHERE line.purchase_id = p.id
                AND line.project_id IS NOT NULL) AS project_ids,
            (SELECT STRING_AGG(DISTINCT pj.project_no::text || ' ' || pj.project_name, ' / ')
               FROM purchase_lines line
               JOIN projects pj ON pj.tenant_id = line.tenant_id AND pj.id = line.project_id
              WHERE line.purchase_id = p.id) AS project_summary
       FROM payable_ledgers pl
       JOIN purchases p ON p.tenant_id = pl.tenant_id AND p.id = pl.purchase_id
       JOIN business_partners bp ON bp.tenant_id = pl.tenant_id AND bp.id = pl.supplier_id
      WHERE ($1::uuid IS NULL OR pl.supplier_id = $1::uuid)
        AND ($2::uuid IS NULL OR EXISTS (
              SELECT 1 FROM purchase_lines line
               WHERE line.purchase_id = p.id AND line.project_id = $2::uuid
            ))
        AND ($3::text IS NULL OR pl.status::text = $3)
        AND ($4::boolean = false OR pl.status = 'A1'::payable_status)
        AND ($5::text IS NULL OR p.purchase_no::text = $5
             OR p.purchase_name ILIKE '%' || $5 || '%'
             OR bp.partner_code ILIKE '%' || $5 || '%'
             OR bp.partner_name ILIKE '%' || $5 || '%')
      ORDER BY pl.purchase_date DESC, p.purchase_no DESC
      LIMIT 500`,
    [rawSupplier, rawProject, status, unpaidOnly, kw],
  );

  return rows.map((r) => {
    const payableAmount = Number(r.payable_amount);
    const paidAmount = Number(r.paid_amount);
    return {
      id: r.id,
      supplierId: r.supplier_id,
      supplierCode: r.supplier_code,
      supplierName: r.supplier_name,
      purchaseId: r.purchase_id,
      purchaseNo: Number(r.purchase_no),
      purchaseName: r.purchase_name,
      purchaseDate: r.purchase_date.slice(0, 10),
      payableAmount,
      amount10Excl: Number(r.amount_10_excl),
      amount8Excl: Number(r.amount_8_excl),
      amount0NonTax: Number(r.amount_0_non_tax),
      taxTotal: Number(r.tax_total),
      paidAmount,
      remainingAmount: payableAmount - paidAmount,
      status: r.status,
      scheduledPayAt: r.scheduled_pay_at !== null ? r.scheduled_pay_at.slice(0, 10) : null,
      orderedAt: r.ordered_at !== null ? r.ordered_at.slice(0, 10) : null,
      projectIds: Array.isArray(r.project_ids) ? r.project_ids : [],
      projectSummary: r.project_summary,
    };
  });
}

export async function updatePayableLedgerStatus(
  tx: DbExecutor,
  tenantId: string,
  employeeId: string,
  params: {
    ledgerId: string;
    status: PayableStatus;
    scheduledPayAt?: string | null;
  },
): Promise<{ id: string; status: PayableStatus; scheduledPayAt: string | null }> {
  await requireFeature(tx, tenantId, 'payment');
  validateUuid(params.ledgerId, '買掛台帳');
  if (!VALID_PAYABLE_STATUSES.has(params.status)) {
    throw new MasterDataError(400, 'INVALID_STATUS', '買掛ステータスは A1 / A2 を指定してください。');
  }
  const scheduledPayAt =
    params.scheduledPayAt !== undefined &&
    params.scheduledPayAt !== null &&
    params.scheduledPayAt.trim() !== ''
      ? validateDateOnly(params.scheduledPayAt, '支払予定日')
      : null;

  const tsRows = await tx.query<{ opening_balance_date: string }>(
    'SELECT opening_balance_date::text AS opening_balance_date FROM tenant_settings WHERE tenant_id = $1::uuid LIMIT 1',
    [tenantId],
  );
  const ts = tsRows[0];
  if (ts === undefined) {
    throw new MasterDataError(404, 'TENANT_SETTINGS_NOT_FOUND', '自社設定が見つかりません。');
  }
  const openingBalanceDate = ts.opening_balance_date.slice(0, 10);

  const lRows = await tx.query<{ id: string; purchase_date: string }>(
    'SELECT id, purchase_date::text AS purchase_date FROM payable_ledgers WHERE id = $1::uuid FOR UPDATE',
    [params.ledgerId],
  );
  const ledger = lRows[0];
  if (ledger === undefined) {
    throw new MasterDataError(404, 'PAYABLE_NOT_FOUND', '対象の買掛台帳が見つかりません。');
  }
  if (ledger.purchase_date.slice(0, 10) <= openingBalanceDate) {
    throw new MasterDataError(
      400,
      'PAYABLE_BEFORE_CUTOFF',
      `期首残高基準日(${openingBalanceDate})以前の買掛台帳ステータスは変更できません。`,
    );
  }

  await tx.query(
    `UPDATE payable_ledgers
        SET status = $2::payable_status,
            scheduled_pay_at = COALESCE($3::date, scheduled_pay_at),
            updated_by = $4::uuid
      WHERE id = $1::uuid`,
    [params.ledgerId, params.status, scheduledPayAt, employeeId],
  );

  const after = await tx.query<{ scheduled_pay_at: string | null }>(
    'SELECT scheduled_pay_at::text AS scheduled_pay_at FROM payable_ledgers WHERE id = $1::uuid LIMIT 1',
    [params.ledgerId],
  );
  const nextScheduled =
    after[0] !== undefined && after[0].scheduled_pay_at !== null
      ? after[0].scheduled_pay_at.slice(0, 10)
      : null;

  return {
    id: params.ledgerId,
    status: params.status,
    scheduledPayAt: nextScheduled,
  };
}

interface SupplierPaymentRow extends Record<string, unknown> {
  id: string;
  payment_no: string;
  payment_date: string;
  supplier_id: string;
  supplier_code: string;
  supplier_name: string;
  method_code_1: string | null;
  method_name_1: string | null;
  amount_1: string;
  method_code_2: string | null;
  method_name_2: string | null;
  amount_2: string;
  method_code_3: string | null;
  method_name_3: string | null;
  amount_3: string;
  deduction_code_1: string | null;
  deduction_name_1: string | null;
  deduction_amt_1: string;
  deduction_code_2: string | null;
  deduction_name_2: string | null;
  deduction_amt_2: string;
  deduction_code_3: string | null;
  deduction_name_3: string | null;
  deduction_amt_3: string;
  subtotal_10_excl: string;
  subtotal_8_excl: string;
  subtotal_0: string;
  summary_note: string | null;
  bill_no: string | null;
  bill_due_date: string | null;
  remarks: string | null;
  created_at: string;
  updated_at: string;
}

function mapSupplierPaymentRow(row: SupplierPaymentRow): SupplierPaymentDto {
  const amount1 = Number(row.amount_1);
  const amount2 = Number(row.amount_2);
  const amount3 = Number(row.amount_3);
  const deductionAmt1 = Number(row.deduction_amt_1);
  const deductionAmt2 = Number(row.deduction_amt_2);
  const deductionAmt3 = Number(row.deduction_amt_3);
  const paymentSubtotal = amount1 + amount2 + amount3;
  const deductionTotal = deductionAmt1 + deductionAmt2 + deductionAmt3;

  return {
    id: row.id,
    paymentNo: Number(row.payment_no),
    paymentDate: row.payment_date.slice(0, 10),
    supplierId: row.supplier_id,
    supplierCode: row.supplier_code,
    supplierName: row.supplier_name,
    methodCode1: row.method_code_1,
    methodName1: row.method_name_1,
    amount1,
    methodCode2: row.method_code_2,
    methodName2: row.method_name_2,
    amount2,
    methodCode3: row.method_code_3,
    methodName3: row.method_name_3,
    amount3,
    deductionCode1: row.deduction_code_1,
    deductionName1: row.deduction_name_1,
    deductionAmt1,
    deductionCode2: row.deduction_code_2,
    deductionName2: row.deduction_name_2,
    deductionAmt2,
    deductionCode3: row.deduction_code_3,
    deductionName3: row.deduction_name_3,
    deductionAmt3,
    paymentSubtotal,
    deductionTotal,
    totalPayment: paymentSubtotal + deductionTotal,
    subtotal10Excl: Number(row.subtotal_10_excl),
    subtotal8Excl: Number(row.subtotal_8_excl),
    subtotal0: Number(row.subtotal_0),
    summaryNote: row.summary_note,
    billNo: row.bill_no,
    billDueDate: row.bill_due_date !== null ? row.bill_due_date.slice(0, 10) : null,
    remarks: row.remarks,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export async function listSupplierPayments(
  tx: DbExecutor,
  tenantId: string,
  filter: SupplierPaymentListFilter = {},
): Promise<SupplierPaymentPageDto> {
  await requireFeature(tx, tenantId, 'payment');

  const kw = optTrimmed(filter.keyword);
  const rawSupplier = optTrimmed(filter.supplierId);
  if (rawSupplier !== null) {
    validateUuid(rawSupplier, '仕入先');
  }
  const rawFrom = optTrimmed(filter.dateFrom);
  const dateFrom = rawFrom !== null && DATE_REGEX.test(rawFrom) ? rawFrom : null;
  const rawTo = optTrimmed(filter.dateTo);
  const dateTo = rawTo !== null && DATE_REGEX.test(rawTo) ? rawTo : null;
  const billNo = optTrimmed(filter.billNo);

  const rawPage = filter.page === undefined ? 1 : filter.page;
  const rawSize = filter.pageSize === undefined ? 25 : filter.pageSize;
  const page = Number.isInteger(rawPage) && rawPage >= 1 ? rawPage : 1;
  const pageSize = Number.isInteger(rawSize) && rawSize >= 1 && rawSize <= 5000 ? rawSize : 25;
  const offset = (page - 1) * pageSize;

  const sumRows = await tx.query<{
    total_count: number;
    sum_pay_sub: string;
    sum_ded_tot: string;
    sum_total: string;
  }>(
    `SELECT COUNT(*)::int AS total_count,
            COALESCE(SUM(sp.amount_1 + sp.amount_2 + sp.amount_3), 0)::text AS sum_pay_sub,
            COALESCE(SUM(sp.deduction_amt_1 + sp.deduction_amt_2 + sp.deduction_amt_3), 0)::text AS sum_ded_tot,
            COALESCE(SUM(
              sp.amount_1 + sp.amount_2 + sp.amount_3 +
              sp.deduction_amt_1 + sp.deduction_amt_2 + sp.deduction_amt_3
            ), 0)::text AS sum_total
       FROM supplier_payments sp
       JOIN business_partners bp ON bp.tenant_id = sp.tenant_id AND bp.id = sp.supplier_id
      WHERE ($1::text IS NULL OR sp.payment_no::text = $1
             OR bp.partner_name ILIKE '%' || $1 || '%'
             OR bp.partner_code ILIKE '%' || $1 || '%'
             OR COALESCE(sp.summary_note, '') ILIKE '%' || $1 || '%'
             OR COALESCE(sp.bill_no, '') ILIKE '%' || $1 || '%')
        AND ($2::uuid IS NULL OR sp.supplier_id = $2::uuid)
        AND ($3::date IS NULL OR sp.payment_date >= $3::date)
        AND ($4::date IS NULL OR sp.payment_date <= $4::date)
        AND ($5::text IS NULL OR sp.bill_no = $5)`,
    [kw, rawSupplier, dateFrom, dateTo, billNo],
  );
  const sum = sumRows[0];

  const rows = await tx.query<SupplierPaymentRow>(
    `SELECT sp.id, sp.payment_no::text AS payment_no, sp.payment_date::text AS payment_date,
            sp.supplier_id, bp.partner_code AS supplier_code, bp.partner_name AS supplier_name,
            sp.method_code_1, pm1.method_name AS method_name_1, sp.amount_1::text AS amount_1,
            sp.method_code_2, pm2.method_name AS method_name_2, sp.amount_2::text AS amount_2,
            sp.method_code_3, pm3.method_name AS method_name_3, sp.amount_3::text AS amount_3,
            sp.deduction_code_1, dm1.method_name AS deduction_name_1, sp.deduction_amt_1::text AS deduction_amt_1,
            sp.deduction_code_2, dm2.method_name AS deduction_name_2, sp.deduction_amt_2::text AS deduction_amt_2,
            sp.deduction_code_3, dm3.method_name AS deduction_name_3, sp.deduction_amt_3::text AS deduction_amt_3,
            sp.subtotal_10_excl::text AS subtotal_10_excl,
            sp.subtotal_8_excl::text AS subtotal_8_excl,
            sp.subtotal_0::text AS subtotal_0,
            sp.summary_note, sp.bill_no, sp.bill_due_date::text AS bill_due_date, sp.remarks,
            sp.created_at::text AS created_at, sp.updated_at::text AS updated_at
       FROM supplier_payments sp
       JOIN business_partners bp ON bp.tenant_id = sp.tenant_id AND bp.id = sp.supplier_id
       LEFT JOIN payment_methods pm1 ON pm1.tenant_id = sp.tenant_id AND pm1.method_code = sp.method_code_1
       LEFT JOIN payment_methods pm2 ON pm2.tenant_id = sp.tenant_id AND pm2.method_code = sp.method_code_2
       LEFT JOIN payment_methods pm3 ON pm3.tenant_id = sp.tenant_id AND pm3.method_code = sp.method_code_3
       LEFT JOIN payment_methods dm1 ON dm1.tenant_id = sp.tenant_id AND dm1.method_code = sp.deduction_code_1
       LEFT JOIN payment_methods dm2 ON dm2.tenant_id = sp.tenant_id AND dm2.method_code = sp.deduction_code_2
       LEFT JOIN payment_methods dm3 ON dm3.tenant_id = sp.tenant_id AND dm3.method_code = sp.deduction_code_3
      WHERE ($1::text IS NULL OR sp.payment_no::text = $1
             OR bp.partner_name ILIKE '%' || $1 || '%'
             OR bp.partner_code ILIKE '%' || $1 || '%'
             OR COALESCE(sp.summary_note, '') ILIKE '%' || $1 || '%'
             OR COALESCE(sp.bill_no, '') ILIKE '%' || $1 || '%')
        AND ($2::uuid IS NULL OR sp.supplier_id = $2::uuid)
        AND ($3::date IS NULL OR sp.payment_date >= $3::date)
        AND ($4::date IS NULL OR sp.payment_date <= $4::date)
        AND ($5::text IS NULL OR sp.bill_no = $5)
      ORDER BY sp.payment_date DESC, sp.payment_no DESC
      LIMIT $6 OFFSET $7`,
    [kw, rawSupplier, dateFrom, dateTo, billNo, pageSize, offset],
  );

  return {
    items: rows.map(mapSupplierPaymentRow),
    summary: {
      totalCount: sum !== undefined ? Number(sum.total_count) : 0,
      sumPaymentSubtotal: sum !== undefined ? Number(sum.sum_pay_sub) : 0,
      sumDeductionTotal: sum !== undefined ? Number(sum.sum_ded_tot) : 0,
      sumTotalPayment: sum !== undefined ? Number(sum.sum_total) : 0,
    },
    page,
    pageSize,
  };
}

export async function getSupplierPaymentDetail(
  tx: DbExecutor,
  tenantId: string,
  paymentId: string,
): Promise<SupplierPaymentDto> {
  validateUuid(paymentId, '支払データ');
  await requireFeature(tx, tenantId, 'payment');

  const rows = await tx.query<SupplierPaymentRow>(
    `SELECT sp.id, sp.payment_no::text AS payment_no, sp.payment_date::text AS payment_date,
            sp.supplier_id, bp.partner_code AS supplier_code, bp.partner_name AS supplier_name,
            sp.method_code_1, pm1.method_name AS method_name_1, sp.amount_1::text AS amount_1,
            sp.method_code_2, pm2.method_name AS method_name_2, sp.amount_2::text AS amount_2,
            sp.method_code_3, pm3.method_name AS method_name_3, sp.amount_3::text AS amount_3,
            sp.deduction_code_1, dm1.method_name AS deduction_name_1, sp.deduction_amt_1::text AS deduction_amt_1,
            sp.deduction_code_2, dm2.method_name AS deduction_name_2, sp.deduction_amt_2::text AS deduction_amt_2,
            sp.deduction_code_3, dm3.method_name AS deduction_name_3, sp.deduction_amt_3::text AS deduction_amt_3,
            sp.subtotal_10_excl::text AS subtotal_10_excl,
            sp.subtotal_8_excl::text AS subtotal_8_excl,
            sp.subtotal_0::text AS subtotal_0,
            sp.summary_note, sp.bill_no, sp.bill_due_date::text AS bill_due_date, sp.remarks,
            sp.created_at::text AS created_at, sp.updated_at::text AS updated_at
       FROM supplier_payments sp
       JOIN business_partners bp ON bp.tenant_id = sp.tenant_id AND bp.id = sp.supplier_id
       LEFT JOIN payment_methods pm1 ON pm1.tenant_id = sp.tenant_id AND pm1.method_code = sp.method_code_1
       LEFT JOIN payment_methods pm2 ON pm2.tenant_id = sp.tenant_id AND pm2.method_code = sp.method_code_2
       LEFT JOIN payment_methods pm3 ON pm3.tenant_id = sp.tenant_id AND pm3.method_code = sp.method_code_3
       LEFT JOIN payment_methods dm1 ON dm1.tenant_id = sp.tenant_id AND dm1.method_code = sp.deduction_code_1
       LEFT JOIN payment_methods dm2 ON dm2.tenant_id = sp.tenant_id AND dm2.method_code = sp.deduction_code_2
       LEFT JOIN payment_methods dm3 ON dm3.tenant_id = sp.tenant_id AND dm3.method_code = sp.deduction_code_3
      WHERE sp.id = $1::uuid
      LIMIT 1`,
    [paymentId],
  );
  const row = rows[0];
  if (row === undefined) {
    throw new MasterDataError(404, 'PAYMENT_NOT_FOUND', '対象の支払データが見つかりません。');
  }
  return mapSupplierPaymentRow(row);
}

async function validateCleanPaymentRefs(
  tx: DbExecutor,
  input: SupplierPaymentInput,
  openingBalanceDate: string,
): Promise<{
  paymentDate: string;
  billDueDate: string | null;
  cleanMethod1: string | null;
  cleanMethod2: string | null;
  cleanMethod3: string | null;
  cleanDeduction1: string | null;
  cleanDeduction2: string | null;
  cleanDeduction3: string | null;
}> {
  const paymentDate = validateDateOnly(input.paymentDate, '支払日');
  if (paymentDate <= openingBalanceDate) {
    throw new MasterDataError(
      400,
      'PAYMENT_DATE_BEFORE_CUTOFF',
      `支払日は期首残高基準日 (${openingBalanceDate}) より後の日付を指定してください。`,
    );
  }
  validateUuid(input.supplierId, '仕入先');

  const total =
    input.amount1 +
    input.amount2 +
    input.amount3 +
    input.deductionAmt1 +
    input.deductionAmt2 +
    input.deductionAmt3;
  if (total <= 0) {
    throw new MasterDataError(
      400,
      'INVALID_PAYMENT_AMOUNT',
      '支払・控除の合計額は1円以上で入力してください。',
    );
  }

  const billDueDate =
    input.billDueDate !== null ? validateDateOnly(input.billDueDate, '手形期日') : null;

  const pRows = await tx.query<{ id: string }>(
    'SELECT id FROM business_partners WHERE id = $1::uuid AND is_deleted = false LIMIT 1',
    [input.supplierId],
  );
  if (pRows.length === 0) {
    throw new MasterDataError(404, 'SUPPLIER_NOT_FOUND', '指定された仕入先が見つかりません。');
  }

  const cleanMethod1 = optTrimmed(input.methodCode1);
  const cleanMethod2 = optTrimmed(input.methodCode2);
  const cleanMethod3 = optTrimmed(input.methodCode3);
  const cleanDeduction1 = optTrimmed(input.deductionCode1);
  const cleanDeduction2 = optTrimmed(input.deductionCode2);
  const cleanDeduction3 = optTrimmed(input.deductionCode3);

  const methodRows = await tx.query<{ method_code: string }>(
    'SELECT method_code FROM payment_methods',
    [],
  );
  const validCodes = new Set(methodRows.map((m) => m.method_code));
  for (const [label, code] of [
    ['支払方法1', cleanMethod1],
    ['支払方法2', cleanMethod2],
    ['支払方法3', cleanMethod3],
    ['控除方法1', cleanDeduction1],
    ['控除方法2', cleanDeduction2],
    ['控除方法3', cleanDeduction3],
  ] as const) {
    if (code !== null && !validCodes.has(code)) {
      throw new MasterDataError(
        400,
        'INVALID_PAYMENT_METHOD',
        `${label}の支払方法コード '${code}' がマスタに存在しません。`,
      );
    }
  }

  return {
    paymentDate,
    billDueDate,
    cleanMethod1,
    cleanMethod2,
    cleanMethod3,
    cleanDeduction1,
    cleanDeduction2,
    cleanDeduction3,
  };
}

export async function createSupplierPayment(
  tx: DbExecutor,
  tenantId: string,
  employeeId: string,
  input: SupplierPaymentInput,
): Promise<SupplierPaymentDto> {
  await requireFeature(tx, tenantId, 'payment');

  const tsRows = await tx.query<{ opening_balance_date: string }>(
    `SELECT opening_balance_date::text AS opening_balance_date
       FROM tenant_settings
      WHERE tenant_id = $1::uuid
      FOR UPDATE`,
    [tenantId],
  );
  const ts = tsRows[0];
  if (ts === undefined) {
    throw new MasterDataError(404, 'TENANT_SETTINGS_NOT_FOUND', '自社設定が見つかりません。');
  }
  const openingBalanceDate = ts.opening_balance_date.slice(0, 10);
  const refs = await validateCleanPaymentRefs(tx, input, openingBalanceDate);

  const maxRows = await tx.query<{ max_no: string }>(
    'SELECT COALESCE(MAX(payment_no), 0)::text AS max_no FROM supplier_payments',
    [],
  );
  const nextNo = BigInt(maxRows[0] !== undefined ? maxRows[0].max_no : '0') + 1n;

  let insertedId: string | undefined;
  try {
    const rows = await tx.query<{ id: string }>(
      `INSERT INTO supplier_payments (
         tenant_id, payment_no, payment_date, supplier_id,
         method_code_1, amount_1, method_code_2, amount_2, method_code_3, amount_3,
         deduction_code_1, deduction_amt_1, deduction_code_2, deduction_amt_2, deduction_code_3, deduction_amt_3,
         subtotal_10_excl, subtotal_8_excl, subtotal_0,
         summary_note, bill_no, bill_due_date, remarks,
         created_by, updated_by
       ) VALUES (
         $1::uuid, $2::bigint, $3::date, $4::uuid,
         $5, $6::numeric, $7, $8::numeric, $9, $10::numeric,
         $11, $12::numeric, $13, $14::numeric, $15, $16::numeric,
         $17::numeric, $18::numeric, $19::numeric,
         $20, $21, $22::date, $23,
         $24::uuid, $24::uuid
       ) RETURNING id`,
      [
        tenantId,
        nextNo.toString(),
        refs.paymentDate,
        input.supplierId,
        refs.cleanMethod1,
        input.amount1,
        refs.cleanMethod2,
        input.amount2,
        refs.cleanMethod3,
        input.amount3,
        refs.cleanDeduction1,
        input.deductionAmt1,
        refs.cleanDeduction2,
        input.deductionAmt2,
        refs.cleanDeduction3,
        input.deductionAmt3,
        input.subtotal10Excl,
        input.subtotal8Excl,
        input.subtotal0,
        input.summaryNote,
        input.billNo,
        refs.billDueDate,
        input.remarks,
        employeeId,
      ],
    );
    insertedId = rows[0]?.id;
  } catch (err) {
    throw mapPgConstraintError(err, { entityLabel: '支払データ' });
  }

  if (insertedId === undefined) {
    throw new MasterDataError(500, 'PAYMENT_INSERT_FAILED', '支払データの登録結果を取得できませんでした。');
  }

  if (input.billNo !== null) {
    await syncPayableSettlementByPurchaseNo(tx, input.supplierId, input.billNo, employeeId);
  }

  return getSupplierPaymentDetail(tx, tenantId, insertedId);
}

export async function updateSupplierPayment(
  tx: DbExecutor,
  tenantId: string,
  employeeId: string,
  paymentId: string,
  input: SupplierPaymentInput,
): Promise<SupplierPaymentDto> {
  validateUuid(paymentId, '支払データ');
  await requireFeature(tx, tenantId, 'payment');

  const tsRows = await tx.query<{ opening_balance_date: string }>(
    'SELECT opening_balance_date::text AS opening_balance_date FROM tenant_settings WHERE tenant_id = $1::uuid LIMIT 1',
    [tenantId],
  );
  const ts = tsRows[0];
  if (ts === undefined) {
    throw new MasterDataError(404, 'TENANT_SETTINGS_NOT_FOUND', '自社設定が見つかりません。');
  }
  const openingBalanceDate = ts.opening_balance_date.slice(0, 10);

  const oldRows = await tx.query<{
    id: string;
    payment_date: string;
    supplier_id: string;
    bill_no: string | null;
  }>(
    `SELECT id, payment_date::text AS payment_date, supplier_id, bill_no
       FROM supplier_payments
      WHERE id = $1::uuid
      FOR UPDATE`,
    [paymentId],
  );
  const oldRow = oldRows[0];
  if (oldRow === undefined) {
    throw new MasterDataError(404, 'PAYMENT_NOT_FOUND', '対象の支払データが見つかりません。');
  }
  if (oldRow.payment_date.slice(0, 10) <= openingBalanceDate) {
    throw new MasterDataError(
      400,
      'PAYMENT_DATE_BEFORE_CUTOFF',
      `期首残高基準日 (${openingBalanceDate}) 以前の支払データは変更できません。`,
    );
  }

  const refs = await validateCleanPaymentRefs(tx, input, openingBalanceDate);

  try {
    await tx.query(
      `UPDATE supplier_payments
          SET payment_date = $2::date,
              supplier_id = $3::uuid,
              method_code_1 = $4,
              amount_1 = $5::numeric,
              method_code_2 = $6,
              amount_2 = $7::numeric,
              method_code_3 = $8,
              amount_3 = $9::numeric,
              deduction_code_1 = $10,
              deduction_amt_1 = $11::numeric,
              deduction_code_2 = $12,
              deduction_amt_2 = $13::numeric,
              deduction_code_3 = $14,
              deduction_amt_3 = $15::numeric,
              subtotal_10_excl = $16::numeric,
              subtotal_8_excl = $17::numeric,
              subtotal_0 = $18::numeric,
              summary_note = $19,
              bill_no = $20,
              bill_due_date = $21::date,
              remarks = $22,
              updated_by = $23::uuid
        WHERE id = $1::uuid`,
      [
        paymentId,
        refs.paymentDate,
        input.supplierId,
        refs.cleanMethod1,
        input.amount1,
        refs.cleanMethod2,
        input.amount2,
        refs.cleanMethod3,
        input.amount3,
        refs.cleanDeduction1,
        input.deductionAmt1,
        refs.cleanDeduction2,
        input.deductionAmt2,
        refs.cleanDeduction3,
        input.deductionAmt3,
        input.subtotal10Excl,
        input.subtotal8Excl,
        input.subtotal0,
        input.summaryNote,
        input.billNo,
        refs.billDueDate,
        input.remarks,
        employeeId,
      ],
    );
  } catch (err) {
    throw mapPgConstraintError(err, { entityLabel: '支払データ' });
  }

  if (oldRow.bill_no !== null && (oldRow.bill_no !== input.billNo || oldRow.supplier_id !== input.supplierId)) {
    await syncPayableSettlementByPurchaseNo(tx, oldRow.supplier_id, oldRow.bill_no, employeeId);
  }
  if (input.billNo !== null) {
    await syncPayableSettlementByPurchaseNo(tx, input.supplierId, input.billNo, employeeId);
  }

  return getSupplierPaymentDetail(tx, tenantId, paymentId);
}

export async function deleteSupplierPayment(
  tx: DbExecutor,
  tenantId: string,
  employeeId: string,
  paymentId: string,
): Promise<{ id: string }> {
  validateUuid(paymentId, '支払データ');
  await requireFeature(tx, tenantId, 'payment');

  const tsRows = await tx.query<{ opening_balance_date: string }>(
    'SELECT opening_balance_date::text AS opening_balance_date FROM tenant_settings WHERE tenant_id = $1::uuid LIMIT 1',
    [tenantId],
  );
  const ts = tsRows[0];
  if (ts === undefined) {
    throw new MasterDataError(404, 'TENANT_SETTINGS_NOT_FOUND', '自社設定が見つかりません。');
  }
  const openingBalanceDate = ts.opening_balance_date.slice(0, 10);

  const oldRows = await tx.query<{
    id: string;
    payment_date: string;
    supplier_id: string;
    bill_no: string | null;
  }>(
    `SELECT id, payment_date::text AS payment_date, supplier_id, bill_no
       FROM supplier_payments
      WHERE id = $1::uuid
      FOR UPDATE`,
    [paymentId],
  );
  const oldRow = oldRows[0];
  if (oldRow === undefined) {
    throw new MasterDataError(404, 'PAYMENT_NOT_FOUND', '対象の支払データが見つかりません。');
  }
  if (oldRow.payment_date.slice(0, 10) <= openingBalanceDate) {
    throw new MasterDataError(
      400,
      'PAYMENT_DATE_BEFORE_CUTOFF',
      `期首残高基準日 (${openingBalanceDate}) 以前の支払データは削除できません。`,
    );
  }

  await tx.query('DELETE FROM supplier_payments WHERE id = $1::uuid', [paymentId]);

  if (oldRow.bill_no !== null) {
    await syncPayableSettlementByPurchaseNo(tx, oldRow.supplier_id, oldRow.bill_no, employeeId);
  }

  return { id: paymentId };
}

function summarizePaymentMethodsText(item: SupplierPaymentDto): string {
  const parts: string[] = [];
  if (item.amount1 > 0 || item.methodName1 !== null) {
    const label1 =
      item.methodName1 !== null
        ? item.methodName1
        : item.methodCode1 !== null
          ? item.methodCode1
          : '支払';
    parts.push(`${label1}:¥${item.amount1.toLocaleString('ja-JP')}`);
  }
  if (item.amount2 > 0) {
    const label2 =
      item.methodName2 !== null
        ? item.methodName2
        : item.methodCode2 !== null
          ? item.methodCode2
          : '支払2';
    parts.push(`${label2}:¥${item.amount2.toLocaleString('ja-JP')}`);
  }
  if (item.amount3 > 0) {
    const label3 =
      item.methodName3 !== null
        ? item.methodName3
        : item.methodCode3 !== null
          ? item.methodCode3
          : '支払3';
    parts.push(`${label3}:¥${item.amount3.toLocaleString('ja-JP')}`);
  }
  return parts.length > 0 ? parts.join(' / ') : '-';
}

export async function exportSupplierPaymentsCsv(
  tx: DbExecutor,
  tenantId: string,
  filter: SupplierPaymentListFilter,
): Promise<string> {
  const result = await listSupplierPayments(tx, tenantId, { ...filter, page: 1, pageSize: 5000 });
  const header = [
    '支払No',
    '支払日',
    '仕入先コード',
    '仕入先名',
    '支払方法内訳',
    '支払額計',
    '控除額計',
    '総充当額',
    '対象仕入No',
    '摘要',
    '備考',
  ].map(escapeCsvCell);

  const lines = [header.join(',')];
  for (const item of result.items) {
    lines.push(
      [
        String(item.paymentNo),
        item.paymentDate,
        item.supplierCode,
        item.supplierName,
        summarizePaymentMethodsText(item),
        String(item.paymentSubtotal),
        String(item.deductionTotal),
        String(item.totalPayment),
        item.billNo !== null ? item.billNo : '',
        item.summaryNote !== null ? item.summaryNote : '',
        item.remarks !== null ? item.remarks : '',
      ]
        .map(escapeCsvCell)
        .join(','),
    );
  }
  return `\uFEFF${lines.join('\r\n')}`;
}

export async function buildSupplierPaymentsPdfInput(
  tx: DbExecutor,
  tenantId: string,
  filter: SupplierPaymentListFilter,
): Promise<SupplierPaymentListPdfInput> {
  const result = await listSupplierPayments(tx, tenantId, { ...filter, page: 1, pageSize: 5000 });
  const settingsRows = await tx.query<{ company_name: string }>(
    'SELECT company_name FROM tenant_settings WHERE tenant_id = $1::uuid LIMIT 1',
    [tenantId],
  );
  const companyName = settingsRows[0] !== undefined ? settingsRows[0].company_name : '自社';

  return {
    companyName,
    generatedDate: new Date().toISOString().slice(0, 10),
    filterSummary: `対象件数:${result.summary.totalCount}件`,
    items: result.items.map((item) => ({
      paymentNo: item.paymentNo,
      paymentDate: item.paymentDate,
      supplierName: item.supplierName,
      methodsSummary: summarizePaymentMethodsText(item),
      deductionTotal: item.deductionTotal,
      paymentSubtotal: item.paymentSubtotal,
      totalPayment: item.totalPayment,
      billNo: item.billNo,
      note: item.summaryNote !== null ? item.summaryNote : item.remarks,
    })),
    totals: {
      count: result.summary.totalCount,
      paymentSubtotal: result.summary.sumPaymentSubtotal,
      deductionTotal: result.summary.sumDeductionTotal,
      totalPayment: result.summary.sumTotalPayment,
    },
  };
}

export { PAYABLE_STATUS_LABELS };
