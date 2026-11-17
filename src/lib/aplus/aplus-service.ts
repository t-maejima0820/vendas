import type {
  AplusExportDto,
  AplusImportDto,
  AplusImportRowInput,
  GenerateAplusExportsInput,
  ImportAplusResultsInput,
  ImportAplusResultsOutput,
  UpdateAplusExportInput,
} from '@/lib/aplus/types';
import { calculatePartnersArBalances } from '@/lib/billing/ar-balance-service';
import { decryptField, isEncryptedField } from '@/lib/crypto/field-cipher';
import type { DbExecutor } from '@/lib/db/tenant-client';
import { requireFeature } from '@/lib/feature-flags/gate';
import { MasterDataError } from '@/lib/masters/error-mapper';
import { insertCashReceiptInternal } from '@/lib/receivables/receivables-service';

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DATE_REGEX = /^\d{4}-\d{2}-\d{2}$/;

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

function escapeCsvCell(value: string): string {
  const escaped = value.replace(/"/g, '""');
  return `"${escaped}"`;
}

function toZenginAscii(raw: string | null | undefined, length: number, padChar = ' '): string {
  const src = raw !== null && raw !== undefined ? raw : '';
  let out = '';
  for (const ch of src) {
    const code = ch.charCodeAt(0);
    if (code >= 0x20 && code <= 0x7e) {
      out += ch.toUpperCase();
    } else if (code >= 0xff01 && code <= 0xff5e) {
      out += String.fromCharCode(code - 0xfee0).toUpperCase();
    } else if (ch === '　') {
      out += ' ';
    } else {
      out += '*';
    }
  }
  if (out.length >= length) {
    return out.slice(0, length);
  }
  return out.padEnd(length, padChar);
}

function toZenginDigits(raw: string | number | bigint | null | undefined, length: number): string {
  const src = raw !== null && raw !== undefined ? String(raw) : '';
  const digits = src.replace(/\D/g, '');
  if (digits.length >= length) {
    return digits.slice(digits.length - length);
  }
  return digits.padStart(length, '0');
}

function computeTotalTransferAmount(row: {
  variable_amount: string;
  fixed_sales_total: string;
  fixed_advance_total: string;
  sales_total: string;
  advance_total: string;
  uncollected_total: string;
}): number {
  return (
    Number(row.variable_amount) +
    Number(row.fixed_sales_total) +
    Number(row.fixed_advance_total) +
    Number(row.sales_total) +
    Number(row.advance_total) +
    Number(row.uncollected_total)
  );
}

interface AplusExportRow extends Record<string, unknown> {
  id: string;
  partner_id: string;
  partner_code: string;
  partner_name: string;
  consignor_code: string;
  customer_no: string;
  breakdown_no: string;
  transfer_date: string;
  variable_amount: string;
  fixed_sales_total: string;
  fixed_advance_total: string;
  sales_total: string;
  advance_total: string;
  uncollected_total: string;
  prev_billed_amount: string;
  is_exported: boolean;
  bank_code: string | null;
  branch_code: string | null;
  bank_account_type: string | null;
  bank_account_no_enc: string | null;
  created_at: string;
}

function mapAplusExportRow(r: AplusExportRow): AplusExportDto {
  return {
    id: r.id,
    partnerId: r.partner_id,
    partnerCode: r.partner_code,
    partnerName: r.partner_name,
    consignorCode: r.consignor_code,
    customerNo: r.customer_no,
    breakdownNo: r.breakdown_no,
    transferDate: r.transfer_date.slice(0, 10),
    variableAmount: Number(r.variable_amount),
    fixedSalesTotal: Number(r.fixed_sales_total),
    fixedAdvanceTotal: Number(r.fixed_advance_total),
    salesTotal: Number(r.sales_total),
    advanceTotal: Number(r.advance_total),
    uncollectedTotal: Number(r.uncollected_total),
    prevBilledAmount: Number(r.prev_billed_amount),
    totalTransferAmount: computeTotalTransferAmount(r),
    isExported: r.is_exported,
    bankCode: r.bank_code,
    branchCode: r.branch_code,
    bankAccountType: r.bank_account_type,
    hasBankAccountNo: r.bank_account_no_enc !== null && r.bank_account_no_enc !== '',
    createdAt: r.created_at,
  };
}

export async function listAplusExports(
  tx: DbExecutor,
  tenantId: string,
  filter: { transferDate?: string | null } = {},
): Promise<AplusExportDto[]> {
  await requireFeature(tx, tenantId, 'aplus');
  const rawDate =
    filter.transferDate !== undefined &&
    filter.transferDate !== null &&
    filter.transferDate.trim() !== ''
      ? validateDateOnly(filter.transferDate, '振替日')
      : null;

  const rows = await tx.query<AplusExportRow>(
    `SELECT ae.id, ae.partner_id, bp.partner_code, bp.partner_name,
            ae.consignor_code, ae.customer_no, ae.breakdown_no,
            ae.transfer_date::text AS transfer_date,
            ae.variable_amount::text AS variable_amount,
            ae.fixed_sales_total::text AS fixed_sales_total,
            ae.fixed_advance_total::text AS fixed_advance_total,
            ae.sales_total::text AS sales_total,
            ae.advance_total::text AS advance_total,
            ae.uncollected_total::text AS uncollected_total,
            ae.prev_billed_amount::text AS prev_billed_amount,
            ae.is_exported,
            bp.bank_code, bp.branch_code, bp.bank_account_type, bp.bank_account_no_enc,
            ae.created_at::text AS created_at
       FROM aplus_exports ae
       JOIN business_partners bp ON bp.tenant_id = ae.tenant_id AND bp.id = ae.partner_id
      WHERE ($1::date IS NULL OR ae.transfer_date = $1::date)
      ORDER BY ae.transfer_date DESC, bp.partner_code ASC, ae.created_at DESC`,
    [rawDate],
  );

  return rows.map(mapAplusExportRow);
}

export async function generateAplusExports(
  tx: DbExecutor,
  tenantId: string,
  input: GenerateAplusExportsInput,
): Promise<AplusExportDto[]> {
  await requireFeature(tx, tenantId, 'aplus');
  const transferDate = validateDateOnly(input.transferDate, '振替日');
  const periodStart = validateDateOnly(input.periodStart, '集計開始日');
  const periodEnd = validateDateOnly(input.periodEnd, '集計終了日');
  if (periodStart > periodEnd) {
    throw new MasterDataError(
      400,
      'INVALID_PERIOD_RANGE',
      '集計開始日は終了日以前を指定してください。',
    );
  }
  const consignorCode = input.consignorCode.trim();
  if (consignorCode.length === 0 || consignorCode.length > 20) {
    throw new MasterDataError(
      400,
      'INVALID_CONSIGNOR_CODE',
      '委託者コードは1〜20文字で指定してください。',
    );
  }
  const breakdownNo =
    input.breakdownNo !== undefined && input.breakdownNo.trim() !== ''
      ? input.breakdownNo.trim()
      : '10';

  const partners = await tx.query<{
    id: string;
    partner_code: string;
  }>(
    `SELECT id, partner_code
       FROM business_partners
      WHERE is_deleted = false
        AND is_client = true
        AND is_aplus_enabled = true
      ORDER BY partner_code ASC`,
    [],
  );

  if (partners.length === 0) {
    throw new MasterDataError(
      400,
      'NO_APLUS_PARTNERS',
      'アプラス口座振替対象の取引先（is_aplus_enabled = true）が登録されていません。',
    );
  }

  if (input.replaceUnexported !== false) {
    await tx.query(
      'DELETE FROM aplus_exports WHERE transfer_date = $1::date AND is_exported = false',
      [transferDate],
    );
  }

  const existingExportedRows = await tx.query<{ partner_id: string }>(
    'SELECT partner_id FROM aplus_exports WHERE transfer_date = $1::date',
    [transferDate],
  );
  const existingPartnerSet = new Set(existingExportedRows.map((r) => r.partner_id));

  const targetPartners = partners.filter((p) => !existingPartnerSet.has(p.id));
  if (targetPartners.length === 0) {
    return listAplusExports(tx, tenantId, { transferDate });
  }

  const targetIds = targetPartners.map((p) => p.id);
  const arMap = await calculatePartnersArBalances(tx, {
    tenantId,
    partnerIds: targetIds,
    periodStart,
    periodEnd,
  });

  const salesAggRows = await tx.query<{
    partner_id: string;
    fixed_sales: string;
    fixed_advance: string;
    normal_sales: string;
    normal_advance: string;
  }>(
    `SELECT sh.partner_id,
            COALESCE(SUM(sh.total_amount) FILTER (
              WHERE sh.entry_type = 'SALE' AND (COALESCE(sh.sales_kubun, '') = '定額' OR COALESCE(bh.is_subscription_bill, false) = true)
            ), 0)::text AS fixed_sales,
            COALESCE(SUM(sh.total_amount) FILTER (
              WHERE sh.entry_type = 'ADVANCE' AND (COALESCE(sh.sales_kubun, '') = '定額' OR COALESCE(bh.is_subscription_bill, false) = true)
            ), 0)::text AS fixed_advance,
            COALESCE(SUM(sh.total_amount) FILTER (
              WHERE sh.entry_type = 'SALE' AND NOT (COALESCE(sh.sales_kubun, '') = '定額' OR COALESCE(bh.is_subscription_bill, false) = true)
            ), 0)::text AS normal_sales,
            COALESCE(SUM(sh.total_amount) FILTER (
              WHERE sh.entry_type = 'ADVANCE' AND NOT (COALESCE(sh.sales_kubun, '') = '定額' OR COALESCE(bh.is_subscription_bill, false) = true)
            ), 0)::text AS normal_advance
       FROM sales_headers sh
       LEFT JOIN billing_headers bh ON bh.tenant_id = sh.tenant_id AND bh.id = sh.billing_id
      WHERE sh.partner_id = ANY($1::uuid[])
        AND sh.slip_date >= $2::date
        AND sh.slip_date <= $3::date
      GROUP BY sh.partner_id`,
    [targetIds, periodStart, periodEnd],
  );
  const salesAggMap = new Map(salesAggRows.map((s) => [s.partner_id, s]));

  for (const p of targetPartners) {
    const sAgg = salesAggMap.get(p.id);
    const ar = arMap.get(p.id);
    const fixedSales = sAgg !== undefined ? sAgg.fixed_sales : '0';
    const fixedAdv = sAgg !== undefined ? sAgg.fixed_advance : '0';
    const normalSales = sAgg !== undefined ? sAgg.normal_sales : '0';
    const normalAdv = sAgg !== undefined ? sAgg.normal_advance : '0';
    const prevBilled = ar !== undefined ? ar.prevCarriedBalance.toString() : '0';
    const uncollected =
      ar !== undefined && ar.netCarriedBalance > 0n ? ar.netCarriedBalance.toString() : '0';

    await tx.query(
      `INSERT INTO aplus_exports (
         tenant_id, partner_id, consignor_code, customer_no, breakdown_no, transfer_date,
         variable_amount, fixed_sales_total, fixed_advance_total,
         sales_total, advance_total, uncollected_total, prev_billed_amount, is_exported
       ) VALUES (
         $1::uuid, $2::uuid, $3, $4, $5, $6::date,
         0, $7::numeric, $8::numeric,
         $9::numeric, $10::numeric, $11::numeric, $12::numeric, false
       )`,
      [
        tenantId,
        p.id,
        consignorCode,
        p.partner_code,
        breakdownNo,
        transferDate,
        fixedSales,
        fixedAdv,
        normalSales,
        normalAdv,
        uncollected,
        prevBilled,
      ],
    );
  }

  return listAplusExports(tx, tenantId, { transferDate });
}

export async function updateAplusExportRow(
  tx: DbExecutor,
  tenantId: string,
  exportId: string,
  input: UpdateAplusExportInput,
): Promise<AplusExportDto> {
  await requireFeature(tx, tenantId, 'aplus');
  validateUuid(exportId, 'アプラス出力行');

  const curRows = await tx.query<AplusExportRow>(
    `SELECT ae.id, ae.partner_id, bp.partner_code, bp.partner_name,
            ae.consignor_code, ae.customer_no, ae.breakdown_no,
            ae.transfer_date::text AS transfer_date,
            ae.variable_amount::text AS variable_amount,
            ae.fixed_sales_total::text AS fixed_sales_total,
            ae.fixed_advance_total::text AS fixed_advance_total,
            ae.sales_total::text AS sales_total,
            ae.advance_total::text AS advance_total,
            ae.uncollected_total::text AS uncollected_total,
            ae.prev_billed_amount::text AS prev_billed_amount,
            ae.is_exported,
            bp.bank_code, bp.branch_code, bp.bank_account_type, bp.bank_account_no_enc,
            ae.created_at::text AS created_at
       FROM aplus_exports ae
       JOIN business_partners bp ON bp.tenant_id = ae.tenant_id AND bp.id = ae.partner_id
      WHERE ae.id = $1::uuid
      FOR UPDATE`,
    [exportId],
  );
  const cur = curRows[0];
  if (cur === undefined) {
    throw new MasterDataError(404, 'APLUS_EXPORT_NOT_FOUND', '対象のアプラス振替データが見つかりません。');
  }

  const variableAmount =
    input.variableAmount !== undefined ? input.variableAmount : Number(cur.variable_amount);
  const uncollectedTotal =
    input.uncollectedTotal !== undefined ? input.uncollectedTotal : Number(cur.uncollected_total);
  const consignorCode =
    input.consignorCode !== undefined && input.consignorCode.trim() !== ''
      ? input.consignorCode.trim()
      : cur.consignor_code;
  const customerNo =
    input.customerNo !== undefined && input.customerNo.trim() !== ''
      ? input.customerNo.trim()
      : cur.customer_no;
  const breakdownNo =
    input.breakdownNo !== undefined && input.breakdownNo.trim() !== ''
      ? input.breakdownNo.trim()
      : cur.breakdown_no;

  if (!Number.isInteger(variableAmount) || !Number.isInteger(uncollectedTotal)) {
    throw new MasterDataError(400, 'INVALID_AMOUNT', '金額は整数で指定してください。');
  }

  await tx.query(
    `UPDATE aplus_exports
        SET variable_amount = $2::numeric,
            uncollected_total = $3::numeric,
            consignor_code = $4,
            customer_no = $5,
            breakdown_no = $6
      WHERE id = $1::uuid`,
    [exportId, variableAmount, uncollectedTotal, consignorCode, customerNo, breakdownNo],
  );

  const list = await listAplusExports(tx, tenantId, { transferDate: cur.transfer_date.slice(0, 10) });
  const updated = list.find((item) => item.id === exportId);
  if (updated === undefined) {
    throw new MasterDataError(404, 'APLUS_EXPORT_NOT_FOUND', '更新後のデータが見つかりません。');
  }
  return updated;
}

export async function deleteAplusExportRow(
  tx: DbExecutor,
  tenantId: string,
  exportId: string,
): Promise<void> {
  await requireFeature(tx, tenantId, 'aplus');
  validateUuid(exportId, 'アプラス出力行');
  const rows = await tx.query<{ id: string }>(
    'DELETE FROM aplus_exports WHERE id = $1::uuid RETURNING id',
    [exportId],
  );
  if (rows.length === 0) {
    throw new MasterDataError(404, 'APLUS_EXPORT_NOT_FOUND', '対象のアプラス振替データが見つかりません。');
  }
}

export async function downloadAplusExports(
  tx: DbExecutor,
  tenantId: string,
  params: {
    transferDate: string;
    format: 'csv' | 'zengin';
    encryptionKeyHex: string;
  },
): Promise<{ content: string; exportedCount: number; transferDate: string }> {
  await requireFeature(tx, tenantId, 'aplus');
  const transferDate = validateDateOnly(params.transferDate, '振替日');

  const rows = await tx.query<{
    id: string;
    partner_code: string;
    partner_name: string;
    consignor_code: string;
    customer_no: string;
    breakdown_no: string;
    transfer_date: string;
    variable_amount: string;
    fixed_sales_total: string;
    fixed_advance_total: string;
    sales_total: string;
    advance_total: string;
    uncollected_total: string;
    prev_billed_amount: string;
    bank_code: string | null;
    branch_code: string | null;
    bank_account_type: string | null;
    bank_account_no_enc: string | null;
    bank_account_holder: string | null;
  }>(
    `SELECT ae.id, bp.partner_code, bp.partner_name,
            ae.consignor_code, ae.customer_no, ae.breakdown_no,
            ae.transfer_date::text AS transfer_date,
            ae.variable_amount::text AS variable_amount,
            ae.fixed_sales_total::text AS fixed_sales_total,
            ae.fixed_advance_total::text AS fixed_advance_total,
            ae.sales_total::text AS sales_total,
            ae.advance_total::text AS advance_total,
            ae.uncollected_total::text AS uncollected_total,
            ae.prev_billed_amount::text AS prev_billed_amount,
            bp.bank_code, bp.branch_code, bp.bank_account_type,
            bp.bank_account_no_enc, bp.bank_account_holder
       FROM aplus_exports ae
       JOIN business_partners bp ON bp.tenant_id = ae.tenant_id AND bp.id = ae.partner_id
      WHERE ae.transfer_date = $1::date
      ORDER BY bp.partner_code ASC`,
    [transferDate],
  );

  if (rows.length === 0) {
    throw new MasterDataError(
      404,
      'APLUS_EXPORTS_EMPTY',
      `振替日 ${transferDate} のアプラス出力対象データがありません。`,
    );
  }

  const tsRows = await tx.query<{
    company_name: string;
    bank_code_1: string | null;
    branch_code_1: string | null;
    bank_account_type_1: string | null;
    bank_account_no_1_enc: string | null;
  }>(
    `SELECT company_name, bank_code_1, branch_code_1, bank_account_type_1, bank_account_no_1_enc
       FROM tenant_settings
      WHERE tenant_id = $1::uuid
      LIMIT 1`,
    [tenantId],
  );
  const ts = tsRows[0];
  if (ts === undefined) {
    throw new MasterDataError(404, 'TENANT_SETTINGS_NOT_FOUND', '自社設定が見つかりません。');
  }

  const bankRows = await tx.query<{ bank_code: string; bank_name: string }>(
    'SELECT bank_code, bank_name FROM banks',
    [],
  );
  const bankNameMap = new Map(bankRows.map((b) => [b.bank_code, b.bank_name]));
  const branchRows = await tx.query<{ bank_code: string; branch_code: string; branch_name: string }>(
    'SELECT bank_code, branch_code, branch_name FROM bank_branches',
    [],
  );
  const branchNameMap = new Map(
    branchRows.map((br) => [`${br.bank_code}:${br.branch_code}`, br.branch_name]),
  );

  // 出力フラグを記録
  const exportIds = rows.map((r) => r.id);
  await tx.query('UPDATE aplus_exports SET is_exported = true WHERE id = ANY($1::uuid[])', [
    exportIds,
  ]);

  if (params.format === 'csv') {
    const header = [
      '振替日',
      '委託者コード',
      '顧客番号',
      '取引先名',
      '種目区分',
      '定額売上',
      '定額立替',
      '通常売上',
      '通常立替',
      '未回収残高',
      '変動調整額',
      '振替依頼合計',
    ]
      .map(escapeCsvCell)
      .join(',');

    const csvLines = rows.map((r) =>
      [
        r.transfer_date.slice(0, 10),
        r.consignor_code,
        r.customer_no,
        r.partner_name,
        r.breakdown_no,
        r.fixed_sales_total,
        r.fixed_advance_total,
        r.sales_total,
        r.advance_total,
        r.uncollected_total,
        r.variable_amount,
        String(computeTotalTransferAmount(r)),
      ]
        .map(escapeCsvCell)
        .join(','),
    );

    return {
      content: `\uFEFF${[header, ...csvLines].join('\r\n')}`,
      exportedCount: rows.length,
      transferDate,
    };
  }

  // 全銀協口座振替データ（固定長120文字 × レコード）
  const firstConsignor = rows[0] !== undefined ? rows[0].consignor_code : '0000000001';
  const mmdd = `${transferDate.slice(5, 7)}${transferDate.slice(8, 10)}`;
  const issuerBankCode = ts.bank_code_1 !== null ? ts.bank_code_1 : '';
  const issuerBranchCode = ts.branch_code_1 !== null ? ts.branch_code_1 : '';
  const issuerBankName =
    ts.bank_code_1 !== null ? (bankNameMap.get(ts.bank_code_1) ?? '') : '';
  const issuerBranchName =
    ts.bank_code_1 !== null && ts.branch_code_1 !== null
      ? (branchNameMap.get(`${ts.bank_code_1}:${ts.branch_code_1}`) ?? '')
      : '';
  const issuerAccTypeDigit =
    ts.bank_account_type_1 === 'B2' ? '2' : '1';
  const issuerAccNo =
    ts.bank_account_no_1_enc !== null && isEncryptedField(ts.bank_account_no_1_enc)
      ? decryptField(ts.bank_account_no_1_enc, params.encryptionKeyHex)
      : '';

  // 1) ヘッダレコード (120 chars)
  const headerRec =
    '1' +
    '91' +
    '0' +
    toZenginDigits(firstConsignor, 10) +
    toZenginAscii(ts.company_name, 40) +
    mmdd +
    toZenginDigits(issuerBankCode, 4) +
    toZenginAscii(issuerBankName, 15) +
    toZenginDigits(issuerBranchCode, 3) +
    toZenginAscii(issuerBranchName, 15) +
    issuerAccTypeDigit +
    toZenginDigits(issuerAccNo, 7) +
    ' '.repeat(17);

  // 2) データレコード (各 120 chars)
  let totalAmount = 0n;
  const dataRecs = rows.map((r) => {
    const rawTotal = computeTotalTransferAmount(r);
    const transferYen = rawTotal > 0 ? BigInt(rawTotal) : 0n;
    totalAmount += transferYen;

    const pBankCode = r.bank_code !== null ? r.bank_code : '';
    const pBranchCode = r.branch_code !== null ? r.branch_code : '';
    const pBankName = r.bank_code !== null ? (bankNameMap.get(r.bank_code) ?? '') : '';
    const pBranchName =
      r.bank_code !== null && r.branch_code !== null
        ? (branchNameMap.get(`${r.bank_code}:${r.branch_code}`) ?? '')
        : '';
    const pAccType = r.bank_account_type === 'B2' ? '2' : '1';
    const pAccNo =
      r.bank_account_no_enc !== null && isEncryptedField(r.bank_account_no_enc)
        ? decryptField(r.bank_account_no_enc, params.encryptionKeyHex)
        : '';
    const holder =
      r.bank_account_holder !== null && r.bank_account_holder.trim() !== ''
        ? r.bank_account_holder
        : r.partner_name;

    return (
      '2' +
      toZenginDigits(pBankCode, 4) +
      toZenginAscii(pBankName, 15) +
      toZenginDigits(pBranchCode, 3) +
      toZenginAscii(pBranchName, 15) +
      ' '.repeat(4) +
      pAccType +
      toZenginDigits(pAccNo, 7) +
      toZenginAscii(holder, 30) +
      toZenginDigits(transferYen, 10) +
      '0' +
      toZenginAscii(r.customer_no, 20) +
      ' ' +
      ' '.repeat(8)
    );
  });

  // 3) トレーラレコード (120 chars)
  const trailerRec =
    '8' +
    toZenginDigits(rows.length, 6) +
    toZenginDigits(totalAmount, 12) +
    '0'.repeat(6) +
    '0'.repeat(12) +
    '0'.repeat(6) +
    '0'.repeat(12) +
    ' '.repeat(65);

  // 4) エンドレコード (120 chars)
  const endRec = '9' + ' '.repeat(119);

  return {
    content: [headerRec, ...dataRecs, trailerRec, endRec].join('\r\n'),
    exportedCount: rows.length,
    transferDate,
  };
}

export async function listAplusImports(
  tx: DbExecutor,
  tenantId: string,
  filter: { transferDate?: string | null; statusFilter?: 'ALL' | 'OK' | 'ERROR' } = {},
): Promise<AplusImportDto[]> {
  await requireFeature(tx, tenantId, 'aplus');
  const rawDate =
    filter.transferDate !== undefined &&
    filter.transferDate !== null &&
    filter.transferDate.trim() !== ''
      ? validateDateOnly(filter.transferDate, '振替日')
      : null;
  const stFilter =
    filter.statusFilter === 'OK' || filter.statusFilter === 'ERROR' ? filter.statusFilter : 'ALL';

  const rows = await tx.query<{
    id: string;
    created_date: string;
    transfer_date: string;
    customer_no: string;
    contractor_name: string | null;
    contract_amount: string;
    billed_amount: string;
    settled_amount: string;
    unpaid_amount: string;
    result_code: string;
    result_reason: string | null;
    created_at: string;
  }>(
    `SELECT id, created_date::text AS created_date, transfer_date::text AS transfer_date,
            customer_no, contractor_name,
            contract_amount::text AS contract_amount,
            billed_amount::text AS billed_amount,
            settled_amount::text AS settled_amount,
            unpaid_amount::text AS unpaid_amount,
            result_code, result_reason, created_at::text AS created_at
       FROM aplus_imports
      WHERE ($1::date IS NULL OR transfer_date = $1::date)
        AND (
          $2::text = 'ALL'
          OR ($2::text = 'OK' AND result_code = '0')
          OR ($2::text = 'ERROR' AND result_code <> '0')
        )
      ORDER BY transfer_date DESC, customer_no ASC, created_at DESC`,
    [rawDate, stFilter],
  );

  return rows.map((r) => ({
    id: r.id,
    createdDate: r.created_date.slice(0, 10),
    transferDate: r.transfer_date.slice(0, 10),
    customerNo: r.customer_no,
    contractorName: r.contractor_name,
    contractAmount: Number(r.contract_amount),
    billedAmount: Number(r.billed_amount),
    settledAmount: Number(r.settled_amount),
    unpaidAmount: Number(r.unpaid_amount),
    resultCode: r.result_code,
    resultReason: r.result_reason,
    isSettledOk: r.result_code === '0',
    createdAt: r.created_at,
  }));
}

function splitCsvLine(line: string): string[] {
  const result: string[] = [];
  let current = '';
  let inQuotes = false;
  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i];
    if (ch === undefined) continue;
    if (ch === '"') {
      if (inQuotes && line[i + 1] === '"') {
        current += '"';
        i += 1;
      } else {
        inQuotes = !inQuotes;
      }
    } else if (ch === ',' && !inQuotes) {
      result.push(current.trim());
      current = '';
    } else {
      current += ch;
    }
  }
  result.push(current.trim());
  return result;
}

function parseIntField(raw: string | undefined, fallbackVal = 0): number {
  if (raw === undefined || raw.trim() === '') return fallbackVal;
  const cleaned = raw.replace(/,/g, '').trim();
  const num = Number(cleaned);
  if (!Number.isFinite(num) || !Number.isInteger(num)) {
    throw new MasterDataError(400, 'INVALID_IMPORT_AMOUNT', `取込データの数値が不正です: ${raw}`);
  }
  return num;
}

function parseAplusRawText(rawText: string, defaultTransferDate?: string): AplusImportRowInput[] {
  const cleanText = rawText.replace(/^\uFEFF/, '');
  const lines = cleanText
    .split(/\r?\n/)
    .map((l) => l.replace(/\r$/, ''))
    .filter((l) => l.trim() !== '');

  if (lines.length === 0) {
    throw new MasterDataError(400, 'EMPTY_IMPORT_DATA', '取込データが空です。');
  }

  // 全銀120文字フォーマット判定
  const firstLine = lines[0];
  if (firstLine !== undefined && firstLine.length === 120 && firstLine.startsWith('1')) {
    const today = new Date().toISOString().slice(0, 10);
    let transferDate =
      defaultTransferDate !== undefined && defaultTransferDate.trim() !== ''
        ? validateDateOnly(defaultTransferDate, '振替日')
        : today;

    const mmdd = firstLine.slice(54, 58);
    if (defaultTransferDate === undefined && /^\d{4}$/.test(mmdd)) {
      const year = today.slice(0, 4);
      transferDate = `${year}-${mmdd.slice(0, 2)}-${mmdd.slice(2, 4)}`;
    }

    const parsed: AplusImportRowInput[] = [];
    for (const line of lines) {
      if (line.startsWith('2') && line.length >= 112) {
        const holder = line.slice(50, 80).trim();
        const reqAmt = Number(line.slice(80, 90));
        const customerNo = line.slice(91, 111).trim();
        const resultCode = line.slice(111, 112).trim() === '' ? '0' : line.slice(111, 112).trim();
        const settledAmt = resultCode === '0' ? reqAmt : 0;
        const unpaidAmt = resultCode === '0' ? 0 : reqAmt;
        parsed.push({
          createdDate: today,
          transferDate,
          customerNo,
          contractorName: holder !== '' ? holder : null,
          contractAmount: reqAmt,
          billedAmount: reqAmt,
          settledAmount: settledAmt,
          unpaidAmount: unpaidAmt,
          resultCode,
          resultReason: resultCode === '0' ? null : `全銀結果コード:${resultCode}`,
        });
      }
    }
    if (parsed.length === 0) {
      throw new MasterDataError(400, 'EMPTY_IMPORT_DATA', '全銀データレコード（区分2）が見つかりません。');
    }
    return parsed;
  }

  // CSV 形式
  const startIdx =
    firstLine !== undefined &&
    (firstLine.includes('customer') ||
      firstLine.includes('顧客') ||
      firstLine.includes('transferDate') ||
      firstLine.includes('振替日'))
      ? 1
      : 0;

  const out: AplusImportRowInput[] = [];
  const today = new Date().toISOString().slice(0, 10);
  for (let i = startIdx; i < lines.length; i += 1) {
    const line = lines[i];
    if (line === undefined) continue;
    const cols = splitCsvLine(line);
    if (cols.length < 5) {
      throw new MasterDataError(
        400,
        'INVALID_CSV_FORMAT',
        `${i + 1}行目のCSV列数が不足しています（作成日,振替日,顧客番号,契約者名,契約額,請求額,振替済額,未払額,結果コード,理由）。`,
      );
    }
    const createdDate = cols[0] !== undefined && cols[0] !== '' ? cols[0] : today;
    const transferDate =
      cols[1] !== undefined && cols[1] !== ''
        ? cols[1]
        : defaultTransferDate !== undefined
          ? defaultTransferDate
          : '';
    const customerNo = cols[2] !== undefined ? cols[2] : '';
    const contractorName = cols[3] !== undefined && cols[3] !== '' ? cols[3] : null;
    const contractAmount = parseIntField(cols[4], 0);
    const billedAmount = parseIntField(cols[5], contractAmount);
    const settledAmount = parseIntField(cols[6], 0);
    const unpaidAmount = parseIntField(cols[7], Math.max(0, billedAmount - settledAmount));
    const resultCode = cols[8] !== undefined && cols[8] !== '' ? cols[8] : '0';
    const resultReason = cols[9] !== undefined && cols[9] !== '' ? cols[9] : null;

    out.push({
      createdDate,
      transferDate,
      customerNo,
      contractorName,
      contractAmount,
      billedAmount,
      settledAmount,
      unpaidAmount,
      resultCode,
      resultReason,
    });
  }

  if (out.length === 0) {
    throw new MasterDataError(400, 'EMPTY_IMPORT_DATA', '取込対象の明細行がありません。');
  }
  return out;
}

export async function importAplusResults(
  tx: DbExecutor,
  tenantId: string,
  employeeId: string,
  input: ImportAplusResultsInput,
): Promise<ImportAplusResultsOutput> {
  await requireFeature(tx, tenantId, 'aplus');

  const rawRows: AplusImportRowInput[] =
    input.rows !== undefined && input.rows.length > 0
      ? input.rows
      : input.rawText !== undefined && input.rawText.trim() !== ''
        ? parseAplusRawText(input.rawText, input.defaultTransferDate)
        : [];

  if (rawRows.length === 0) {
    throw new MasterDataError(400, 'EMPTY_IMPORT_DATA', '取込対象の明細を指定してください。');
  }

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

  const today = new Date().toISOString().slice(0, 10);
  const existingRows = await tx.query<{ transfer_date: string; customer_no: string }>(
    'SELECT transfer_date::text AS transfer_date, customer_no FROM aplus_imports',
    [],
  );
  const existingKeys = new Set(
    existingRows.map((e) => `${e.transfer_date.slice(0, 10)}:${e.customer_no}`),
  );
  const batchKeys = new Set<string>();

  const cleanRows = rawRows.map((r, idx) => {
    const createdDate =
      r.createdDate !== undefined && r.createdDate.trim() !== ''
        ? validateDateOnly(r.createdDate, `${idx + 1}行目の作成日`)
        : today;
    const transferDate = validateDateOnly(r.transferDate, `${idx + 1}行目の振替日`);
    const customerNo = r.customerNo.trim();
    if (customerNo === '') {
      throw new MasterDataError(400, 'CUSTOMER_NO_REQUIRED', `${idx + 1}行目の顧客番号が未指定です。`);
    }
    const dedupeKey = `${transferDate}:${customerNo}`;
    if (existingKeys.has(dedupeKey) || batchKeys.has(dedupeKey)) {
      throw new MasterDataError(
        409,
        'APLUS_IMPORT_DUPLICATE',
        `振替日 ${transferDate}・顧客番号 ${customerNo} の取込結果は既に取り込み済みです（二重取込禁止）。`,
      );
    }
    batchKeys.add(dedupeKey);

    const billedAmount = r.billedAmount;
    const settledAmount = r.settledAmount;
    const contractAmount = r.contractAmount !== undefined ? r.contractAmount : billedAmount;
    const unpaidAmount =
      r.unpaidAmount !== undefined ? r.unpaidAmount : billedAmount - settledAmount;
    const resultCode = r.resultCode.trim();
    if (resultCode === '') {
      throw new MasterDataError(400, 'RESULT_CODE_REQUIRED', `${idx + 1}行目の結果コードが未指定です。`);
    }

    return {
      createdDate,
      transferDate,
      customerNo,
      contractorName: r.contractorName !== undefined ? r.contractorName : null,
      contractAmount,
      billedAmount,
      settledAmount,
      unpaidAmount,
      resultCode,
      resultReason: r.resultReason !== undefined ? r.resultReason : null,
    };
  });

  // アプラス入金方法コードをマスタ名称優先で動的解決（標準seedでは 'H' = アプラス）
  const pmRows = await tx.query<{ method_code: string }>(
    `SELECT method_code
       FROM payment_methods
      WHERE method_name LIKE '%アプラス%' OR method_code IN ('H', 'G')
      ORDER BY CASE
        WHEN method_name LIKE '%アプラス%' THEN 0
        WHEN method_code = 'H' THEN 1
        ELSE 2
      END
      LIMIT 1`,
    [],
  );
  const aplusMethodCode = pmRows[0] !== undefined ? pmRows[0].method_code : 'H';

  const autoCreateReceipts = input.autoCreateReceipts !== false;
  let settledCount = 0;
  let failedCount = 0;
  let autoCreatedReceiptCount = 0;
  const insertedItems: AplusImportDto[] = [];

  for (const r of cleanRows) {
    const insRows = await tx.query<{
      id: string;
      created_at: string;
    }>(
      `INSERT INTO aplus_imports (
         tenant_id, created_date, transfer_date, customer_no, contractor_name,
         contract_amount, billed_amount, settled_amount, unpaid_amount,
         result_code, result_reason
       ) VALUES (
         $1::uuid, $2::date, $3::date, $4, $5,
         $6::numeric, $7::numeric, $8::numeric, $9::numeric,
         $10, $11
       )
       RETURNING id, created_at::text AS created_at`,
      [
        tenantId,
        r.createdDate,
        r.transferDate,
        r.customerNo,
        r.contractorName,
        r.contractAmount,
        r.billedAmount,
        r.settledAmount,
        r.unpaidAmount,
        r.resultCode,
        r.resultReason,
      ],
    );
    const ins = insRows[0];
    if (ins === undefined) {
      throw new MasterDataError(500, 'APLUS_IMPORT_FAILED', 'アプラス結果データの保存に失敗しました。');
    }

    const isOk = r.resultCode === '0';
    if (isOk) {
      settledCount += 1;
      if (autoCreateReceipts && r.settledAmount > 0) {
        const pRows = await tx.query<{ id: string }>(
          `SELECT id
             FROM business_partners
            WHERE partner_code = $1 AND is_deleted = false
            LIMIT 1`,
          [r.customerNo],
        );
        const partner = pRows[0];
        if (partner !== undefined) {
          // 紐づけ可能な未完済請求書を検索（同額優先・古い請求日順）
          const openBillRows = await tx.query<{ billing_no: string }>(
            `SELECT billing_no::text AS billing_no
               FROM billing_headers
              WHERE partner_id = $1::uuid
                AND status IN ('N1', 'N2')
              ORDER BY CASE WHEN billing_amount = $2::numeric THEN 0 ELSE 1 END,
                       billing_date ASC,
                       billing_no ASC
              LIMIT 1`,
            [partner.id, r.settledAmount],
          );
          const matchedBillNo = openBillRows[0] !== undefined ? openBillRows[0].billing_no : null;

          await insertCashReceiptInternal(tx, {
            tenantId,
            employeeId,
            sourceKind: 'APLUS',
            openingBalanceDate,
            input: {
              receiptDate: r.transferDate,
              partnerId: partner.id,
              projectId: null,
              methodCode1: aplusMethodCode,
              deposit1: r.settledAmount,
              methodCode2: null,
              deposit2: 0,
              methodCode3: null,
              deposit3: 0,
              subtotal10Excl: 0,
              subtotal8Excl: 0,
              subtotal0: 0,
              tadashi: 'アプラス口座振替',
              billNo: matchedBillNo,
              billDueDate: null,
              remarks: `アプラス自動入金取込 (${r.transferDate} / 顧客番号:${r.customerNo})`,
            },
          });
          autoCreatedReceiptCount += 1;
        }
      }
    } else {
      failedCount += 1;
    }

    insertedItems.push({
      id: ins.id,
      createdDate: r.createdDate,
      transferDate: r.transferDate,
      customerNo: r.customerNo,
      contractorName: r.contractorName,
      contractAmount: r.contractAmount,
      billedAmount: r.billedAmount,
      settledAmount: r.settledAmount,
      unpaidAmount: r.unpaidAmount,
      resultCode: r.resultCode,
      resultReason: r.resultReason,
      isSettledOk: isOk,
      createdAt: ins.created_at,
    });
  }

  return {
    importedCount: insertedItems.length,
    settledCount,
    failedCount,
    autoCreatedReceiptCount,
    items: insertedItems,
  };
}
