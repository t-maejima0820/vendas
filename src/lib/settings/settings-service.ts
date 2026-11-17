import { decryptField, encryptField } from '@/lib/crypto/field-cipher';
import type { DbExecutor } from '@/lib/db/tenant-client';
import type { CostTaxMode, RoundingMode, TaxCalcPolicy } from '@/lib/domain/calculations';
import { clearFeatureCacheForTx } from '@/lib/feature-flags/gate';

export class SettingsValidationError extends Error {
  readonly statusCode: number;
  readonly safeMessage: string;

  constructor(message: string, statusCode: number = 400) {
    super(message);
    this.name = 'SettingsValidationError';
    this.statusCode = statusCode;
    this.safeMessage = message;
  }
}

export interface FeatureAuthorityItem {
  featureCode: string;
  featureName: string;
  isEnabled: boolean;
  displayOrder: number;
  isFixed: boolean;
}

export interface TenantSettingsDto {
  companyCode: string;
  companyName: string;
  invoiceRegistrationNo: string | null;
  corporateNo: string | null;
  postalCode: string | null;
  address1: string | null;
  address2: string | null;
  tel: string | null;
  fax: string | null;
  email: string | null;
  representativeTitle: string | null;
  representativeName: string | null;
  fiscalClosingMonth: number;
  billingMemo: string | null;
  bankCode1: string | null;
  branchCode1: string | null;
  bankAccountType1: 'B1' | 'B2' | null;
  bankAccountNo1: string | null;
  bankAccountHolder1: string | null;
  bankCode2: string | null;
  branchCode2: string | null;
  bankAccountType2: 'B1' | 'B2' | null;
  bankAccountNo2: string | null;
  bankAccountHolder2: string | null;
  approvalFlowEnabled: boolean;
  allowBillingDateWarningSkip: boolean;
  defaultApprovalBillingDate: 0 | 1 | 2;
  defaultArListDateMode: 0 | 1;
  quotationTemplateRows: 10 | 20;
  showInvoiceCarryover: boolean;
  costTaxMode: CostTaxMode;
  taxCalcPolicy: TaxCalcPolicy;
  defaultRoundingMode: RoundingMode;
  openingBalanceDate: string;
  features: FeatureAuthorityItem[];
}

export interface UpdateTenantSettingsInput {
  companyName: string;
  invoiceRegistrationNo: string | null;
  corporateNo: string | null;
  postalCode: string | null;
  address1: string | null;
  address2: string | null;
  tel: string | null;
  fax: string | null;
  email: string | null;
  representativeTitle: string | null;
  representativeName: string | null;
  fiscalClosingMonth: number;
  billingMemo: string | null;
  bankCode1: string | null;
  branchCode1: string | null;
  bankAccountType1: 'B1' | 'B2' | null;
  bankAccountNo1: string | null;
  bankAccountHolder1: string | null;
  bankCode2: string | null;
  branchCode2: string | null;
  bankAccountType2: 'B1' | 'B2' | null;
  bankAccountNo2: string | null;
  bankAccountHolder2: string | null;
  approvalFlowEnabled: boolean;
  allowBillingDateWarningSkip: boolean;
  defaultApprovalBillingDate: 0 | 1 | 2;
  defaultArListDateMode: 0 | 1;
  quotationTemplateRows: 10 | 20;
  showInvoiceCarryover: boolean;
  costTaxMode: CostTaxMode;
  taxCalcPolicy: TaxCalcPolicy;
  defaultRoundingMode: RoundingMode;
  features: Array<{ featureCode: string; isEnabled: boolean }>;
}

function normalizeNullableText(v: string | null | undefined): string | null {
  if (v === null || v === undefined) return null;
  const trimmed = v.trim();
  return trimmed === '' ? null : trimmed;
}

export async function getTenantSettingsForAdmin(
  tx: DbExecutor,
  tenantId: string,
  encryptionKeyHex: string,
): Promise<TenantSettingsDto> {
  const settingsRows = await tx.query<{
    company_code: string;
    company_name: string;
    invoice_registration_no: string | null;
    corporate_no: string | null;
    postal_code: string | null;
    address1: string | null;
    address2: string | null;
    tel: string | null;
    fax: string | null;
    email: string | null;
    representative_title: string | null;
    representative_name: string | null;
    fiscal_closing_month: number;
    billing_memo: string | null;
    bank_code_1: string | null;
    branch_code_1: string | null;
    bank_account_type_1: 'B1' | 'B2' | null;
    bank_account_no_1_enc: string | null;
    bank_account_holder_1: string | null;
    bank_code_2: string | null;
    branch_code_2: string | null;
    bank_account_type_2: 'B1' | 'B2' | null;
    bank_account_no_2_enc: string | null;
    bank_account_holder_2: string | null;
    approval_flow_enabled: boolean;
    allow_billing_date_warning_skip: boolean;
    default_approval_billing_date: number;
    default_ar_list_date_mode: number;
    quotation_template_rows: number;
    show_invoice_carryover: boolean;
    cost_tax_mode: CostTaxMode;
    tax_calc_policy: TaxCalcPolicy;
    default_rounding_mode: RoundingMode;
    opening_balance_date: string | Date;
    features_json:
      | Array<{
          feature_code: string;
          feature_name: string;
          is_enabled: boolean;
          display_order: number;
          is_fixed: boolean;
        }>
      | string;
  }>(
    `SELECT ts.company_code, ts.company_name, ts.invoice_registration_no, ts.corporate_no,
            ts.postal_code, ts.address1, ts.address2, ts.tel, ts.fax, ts.email,
            ts.representative_title, ts.representative_name, ts.fiscal_closing_month, ts.billing_memo,
            ts.bank_code_1, ts.branch_code_1, ts.bank_account_type_1, ts.bank_account_no_1_enc, ts.bank_account_holder_1,
            ts.bank_code_2, ts.branch_code_2, ts.bank_account_type_2, ts.bank_account_no_2_enc, ts.bank_account_holder_2,
            ts.approval_flow_enabled, ts.allow_billing_date_warning_skip,
            ts.default_approval_billing_date, ts.default_ar_list_date_mode,
            ts.quotation_template_rows, ts.show_invoice_carryover,
            ts.cost_tax_mode::text AS cost_tax_mode,
            ts.tax_calc_policy::text AS tax_calc_policy,
            ts.default_rounding_mode::text AS default_rounding_mode,
            ts.opening_balance_date::text AS opening_balance_date,
            COALESCE(
              (
                SELECT json_agg(
                  json_build_object(
                    'feature_code', tfa.feature_code,
                    'feature_name', tfa.feature_name,
                    'is_enabled', tfa.is_enabled,
                    'display_order', tfa.display_order,
                    'is_fixed', tfa.is_fixed
                  )
                  ORDER BY tfa.display_order ASC, tfa.feature_code ASC
                )
                  FROM tenant_feature_authorities tfa
                 WHERE tfa.tenant_id = ts.tenant_id
              ),
              '[]'::json
            ) AS features_json
       FROM tenant_settings ts
      WHERE ts.tenant_id = $1
      LIMIT 1`,
    [tenantId],
  );

  const row = settingsRows[0];
  if (row === undefined) {
    throw new SettingsValidationError('テナント設定が見つかりません', 404);
  }

  const featureRows = Array.isArray(row.features_json)
    ? row.features_json
    : (JSON.parse(row.features_json) as Array<{
        feature_code: string;
        feature_name: string;
        is_enabled: boolean;
        display_order: number;
        is_fixed: boolean;
      }>);

  const decBank1 =
    row.bank_account_no_1_enc === null ? null : decryptField(row.bank_account_no_1_enc, encryptionKeyHex);
  const decBank2 =
    row.bank_account_no_2_enc === null ? null : decryptField(row.bank_account_no_2_enc, encryptionKeyHex);

  const openingDateStr =
    typeof row.opening_balance_date === 'string'
      ? row.opening_balance_date.slice(0, 10)
      : row.opening_balance_date.toISOString().slice(0, 10);

  return {
    companyCode: row.company_code,
    companyName: row.company_name,
    invoiceRegistrationNo: row.invoice_registration_no,
    corporateNo: row.corporate_no,
    postalCode: row.postal_code,
    address1: row.address1,
    address2: row.address2,
    tel: row.tel,
    fax: row.fax,
    email: row.email,
    representativeTitle: row.representative_title,
    representativeName: row.representative_name,
    fiscalClosingMonth: row.fiscal_closing_month,
    billingMemo: row.billing_memo,
    bankCode1: row.bank_code_1,
    branchCode1: row.branch_code_1,
    bankAccountType1: row.bank_account_type_1,
    bankAccountNo1: decBank1,
    bankAccountHolder1: row.bank_account_holder_1,
    bankCode2: row.bank_code_2,
    branchCode2: row.branch_code_2,
    bankAccountType2: row.bank_account_type_2,
    bankAccountNo2: decBank2,
    bankAccountHolder2: row.bank_account_holder_2,
    approvalFlowEnabled: row.approval_flow_enabled,
    allowBillingDateWarningSkip: row.allow_billing_date_warning_skip,
    defaultApprovalBillingDate:
      row.default_approval_billing_date === 1 || row.default_approval_billing_date === 2
        ? row.default_approval_billing_date
        : 0,
    defaultArListDateMode: row.default_ar_list_date_mode === 1 ? 1 : 0,
    quotationTemplateRows: row.quotation_template_rows === 20 ? 20 : 10,
    showInvoiceCarryover: row.show_invoice_carryover,
    costTaxMode: row.cost_tax_mode,
    taxCalcPolicy: row.tax_calc_policy,
    defaultRoundingMode: row.default_rounding_mode,
    openingBalanceDate: openingDateStr,
    features: featureRows.map((f) => ({
      featureCode: f.feature_code,
      featureName: f.feature_name,
      isEnabled: f.is_enabled,
      displayOrder: f.display_order,
      isFixed: f.is_fixed,
    })),
  };
}

export async function updateTenantSettingsForAdmin(
  tx: DbExecutor,
  tenantId: string,
  input: UpdateTenantSettingsInput,
  encryptionKeyHex: string,
): Promise<TenantSettingsDto> {
  const companyName = input.companyName.trim();
  if (companyName === '') {
    throw new SettingsValidationError('会社名は必須です');
  }

  const invoiceNo = normalizeNullableText(input.invoiceRegistrationNo);
  if (invoiceNo !== null && !/^T[0-9]{13}$/.test(invoiceNo)) {
    throw new SettingsValidationError('インボイス登録番号は T + 13桁の半角数字で入力してください');
  }

  const corporateNo = normalizeNullableText(input.corporateNo);
  if (corporateNo !== null && !/^[0-9]{13}$/.test(corporateNo)) {
    throw new SettingsValidationError('法人番号は 13桁の半角数字で入力してください');
  }

  if (
    !Number.isInteger(input.fiscalClosingMonth) ||
    input.fiscalClosingMonth < 0 ||
    input.fiscalClosingMonth > 12
  ) {
    throw new SettingsValidationError('決算月は 0〜12 の整数で指定してください');
  }

  if (input.bankAccountType1 !== null && input.bankAccountType1 !== 'B1' && input.bankAccountType1 !== 'B2') {
    throw new SettingsValidationError('口座1の預金種別は普通(B1)または当座(B2)を指定してください');
  }
  if (input.bankAccountType2 !== null && input.bankAccountType2 !== 'B1' && input.bankAccountType2 !== 'B2') {
    throw new SettingsValidationError('口座2の預金種別は普通(B1)または当座(B2)を指定してください');
  }

  const bankNo1Plain = normalizeNullableText(input.bankAccountNo1);
  const bankNo2Plain = normalizeNullableText(input.bankAccountNo2);
  if (bankNo1Plain !== null && !/^[0-9A-Za-z-]{1,20}$/.test(bankNo1Plain)) {
    throw new SettingsValidationError('口座1の口座番号の形式が不正です');
  }
  if (bankNo2Plain !== null && !/^[0-9A-Za-z-]{1,20}$/.test(bankNo2Plain)) {
    throw new SettingsValidationError('口座2の口座番号の形式が不正です');
  }

  if (input.taxCalcPolicy !== 'SLIP_BY_RATE' && input.taxCalcPolicy !== 'INVOICE_BY_RATE') {
    throw new SettingsValidationError('消費税計算方式は SLIP_BY_RATE または INVOICE_BY_RATE を選択してください');
  }
  if (
    input.defaultRoundingMode !== 'FLOOR' &&
    input.defaultRoundingMode !== 'ROUND' &&
    input.defaultRoundingMode !== 'CEIL'
  ) {
    throw new SettingsValidationError('既定端数処理が不正です');
  }
  if (input.costTaxMode !== 'TAX_EXCLUDED' && input.costTaxMode !== 'TAX_INCLUDED') {
    throw new SettingsValidationError('原価管理税表示区分が不正です');
  }
  if (input.quotationTemplateRows !== 10 && input.quotationTemplateRows !== 20) {
    throw new SettingsValidationError('見積書テンプレート行数は 10 または 20 を指定してください');
  }
  if (
    input.defaultApprovalBillingDate !== 0 &&
    input.defaultApprovalBillingDate !== 1 &&
    input.defaultApprovalBillingDate !== 2
  ) {
    throw new SettingsValidationError('承認デフォルト請求日の指定が不正です');
  }
  if (input.defaultArListDateMode !== 0 && input.defaultArListDateMode !== 1) {
    throw new SettingsValidationError('売掛一覧デフォルト日付の指定が不正です');
  }

  // 固定機能のOFF変更禁止チェック
  const existingFeatures = await tx.query<{
    feature_code: string;
    feature_name: string;
    is_fixed: boolean;
  }>(
    `SELECT feature_code, feature_name, is_fixed
       FROM tenant_feature_authorities
      WHERE tenant_id = $1`,
    [tenantId],
  );
  const featureMetaMap = new Map(existingFeatures.map((f) => [f.feature_code, f]));

  const featureCodes: string[] = [];
  const featureEnabledFlags: boolean[] = [];
  for (const item of input.features) {
    const meta = featureMetaMap.get(item.featureCode);
    if (meta === undefined) {
      throw new SettingsValidationError(`不明な機能コードが含まれています: ${item.featureCode}`);
    }
    if (meta.is_fixed && !item.isEnabled) {
      throw new SettingsValidationError(
        `必須固定機能「${meta.feature_name}」(${meta.feature_code}) は無効化できません`,
      );
    }
    featureCodes.push(item.featureCode);
    featureEnabledFlags.push(Boolean(item.isEnabled));
  }

  const bankNo1Enc = bankNo1Plain === null ? null : encryptField(bankNo1Plain, encryptionKeyHex);
  const bankNo2Enc = bankNo2Plain === null ? null : encryptField(bankNo2Plain, encryptionKeyHex);

  await tx.query(
    `UPDATE tenant_settings
        SET company_name = $2,
            invoice_registration_no = $3,
            corporate_no = $4,
            postal_code = $5,
            address1 = $6,
            address2 = $7,
            tel = $8,
            fax = $9,
            email = $10,
            representative_title = $11,
            representative_name = $12,
            fiscal_closing_month = $13,
            billing_memo = $14,
            bank_code_1 = $15,
            branch_code_1 = $16,
            bank_account_type_1 = $17,
            bank_account_no_1_enc = $18,
            bank_account_holder_1 = $19,
            bank_code_2 = $20,
            branch_code_2 = $21,
            bank_account_type_2 = $22,
            bank_account_no_2_enc = $23,
            bank_account_holder_2 = $24,
            approval_flow_enabled = $25,
            allow_billing_date_warning_skip = $26,
            default_approval_billing_date = $27,
            default_ar_list_date_mode = $28,
            quotation_template_rows = $29,
            show_invoice_carryover = $30,
            cost_tax_mode = $31::cost_tax_display_mode,
            tax_calc_policy = $32::tax_calc_policy,
            default_rounding_mode = $33::rounding_mode
      WHERE tenant_id = $1`,
    [
      tenantId,
      companyName,
      invoiceNo,
      corporateNo,
      normalizeNullableText(input.postalCode),
      normalizeNullableText(input.address1),
      normalizeNullableText(input.address2),
      normalizeNullableText(input.tel),
      normalizeNullableText(input.fax),
      normalizeNullableText(input.email),
      normalizeNullableText(input.representativeTitle),
      normalizeNullableText(input.representativeName),
      input.fiscalClosingMonth,
      normalizeNullableText(input.billingMemo),
      normalizeNullableText(input.bankCode1),
      normalizeNullableText(input.branchCode1),
      input.bankAccountType1,
      bankNo1Enc,
      normalizeNullableText(input.bankAccountHolder1),
      normalizeNullableText(input.bankCode2),
      normalizeNullableText(input.branchCode2),
      input.bankAccountType2,
      bankNo2Enc,
      normalizeNullableText(input.bankAccountHolder2),
      input.approvalFlowEnabled,
      input.allowBillingDateWarningSkip,
      input.defaultApprovalBillingDate,
      input.defaultArListDateMode,
      input.quotationTemplateRows,
      input.showInvoiceCarryover,
      input.costTaxMode,
      input.taxCalcPolicy,
      input.defaultRoundingMode,
    ],
  );

  if (featureCodes.length > 0) {
    await tx.query(
      `UPDATE tenant_feature_authorities AS tfa
          SET is_enabled = u.is_enabled
         FROM UNNEST($2::text[], $3::boolean[]) AS u(feature_code, is_enabled)
        WHERE tfa.tenant_id = $1
          AND tfa.feature_code = u.feature_code`,
      [tenantId, featureCodes, featureEnabledFlags],
    );
    clearFeatureCacheForTx(tx);
  }

  return getTenantSettingsForAdmin(tx, tenantId, encryptionKeyHex);
}
