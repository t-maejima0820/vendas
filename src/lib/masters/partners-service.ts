import { decryptField, encryptField, isEncryptedField } from '@/lib/crypto/field-cipher';
import type { DbExecutor } from '@/lib/db/tenant-client';
import { mapPgConstraintError, MasterDataError } from '@/lib/masters/error-mapper';
import type {
  BusinessPartnerDetailDto,
  BusinessPartnerInput,
  BusinessPartnerListItemDto,
  PartnerAdvisoryProfileDto,
  PartnerAdvisoryProfileInput,
} from '@/lib/masters/types';

export interface PartnerListFilter {
  keyword?: string | null;
  role?: 'ALL' | 'CLIENT' | 'SUPPLIER' | 'APLUS' | null;
  categoryCode?: string | null;
  stateCode?: string | null;
  includeDeleted?: boolean;
}

type PartnerListRow = {
  id: string;
  partner_code: string;
  partner_name: string;
  furigana: string | null;
  category_code: string | null;
  state_code: string | null;
  is_client: boolean;
  is_supplier: boolean;
  is_aplus_enabled: boolean;
  tel: string | null;
  representative_id: string | null;
  representative_name: string | null;
  assigned_employee_id: string | null;
  assigned_employee_name: string | null;
  opening_ar_balance: string | number;
  opening_ap_balance: string | number;
  is_deleted: boolean;
  updated_at: string;
};

type PartnerDetailRow = PartnerListRow & {
  is_individual_honorific: boolean;
  postal_code: string | null;
  address1: string | null;
  address2: string | null;
  send_mail_enabled: boolean;
  email: string | null;
  estimate_mail_to: string | null;
  estimate_mail_cc: string | null;
  bill_mail_to: string | null;
  bill_mail_cc: string | null;
  invoice_no: string | null;
  billing_destination_name: string | null;
  closing_day_code: string | null;
  collection_day_code: string | null;
  receipt_method_code: string | null;
  payment_method_code: string | null;
  bank_code: string | null;
  branch_code: string | null;
  bank_account_type: 'B1' | 'B2' | null;
  bank_account_no_enc: string | null;
  bank_account_holder: string | null;
  opening_balance_date: string | null;
};

type AdvisoryRow = {
  id: string;
  corporate_no: string | null;
  established_at_text: string | null;
  business_description: string | null;
  capital_text: string | null;
  fiscal_closing_month: number | null;
  advisory_fee: string | number;
  settlement_fee: string | number;
  payroll_closing_code: string | null;
  payroll_pay_code: string | null;
  labor_insurance_code: string | null;
  social_insurance_code: string | null;
  labor_insurance_no: string | null;
  employment_ins_office_no: string | null;
  pension_office_no: string | null;
  pension_serial_no: string | null;
  tax_office_id: string | null;
  tax_office_name: string | null;
  tax_office_serial_no: string | null;
  income_tax_code: string | null;
  consumption_tax_code: string | null;
  resident_tax_code: string | null;
  tax_transfer_info_enc: string | null;
  labor_bank_account_enc: string | null;
  social_bank_account_enc: string | null;
};

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function optTrimmed(val: string | null | undefined): string | null {
  if (val === null || val === undefined) {
    return null;
  }
  const trimmed = val.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function validateUuidOrNull(val: string | null, label: string): string | null {
  const trimmed = optTrimmed(val);
  if (trimmed === null) {
    return null;
  }
  if (!UUID_REGEX.test(trimmed)) {
    throw new MasterDataError(400, 'INVALID_UUID', `${label}のID形式が不正です。`);
  }
  return trimmed;
}

function validatePartnerId(id: string): void {
  if (!UUID_REGEX.test(id)) {
    throw new MasterDataError(400, 'INVALID_ID', '取引先IDの形式が不正です。');
  }
}

function encryptOptionalField(plain: string | null, encKeyHex: string): string | null {
  const cleaned = optTrimmed(plain);
  if (cleaned === null) {
    return null;
  }
  return encryptField(cleaned, encKeyHex);
}

function decryptOptionalField(stored: string | null, encKeyHex: string): string | null {
  if (stored === null || stored === '') {
    return null;
  }
  return isEncryptedField(stored) ? decryptField(stored, encKeyHex) : stored;
}

function validateIntegerAmount(value: number | undefined, label: string): number {
  if (value === undefined) {
    return 0;
  }
  if (!Number.isInteger(value) || Math.abs(value) > 999999999999) {
    throw new MasterDataError(400, 'INVALID_AMOUNT', `${label}は整数値で入力してください。`);
  }
  return value;
}

function hasAnyAdvisoryContent(profile: PartnerAdvisoryProfileInput): boolean {
  return (
    optTrimmed(profile.corporateNo) !== null ||
    optTrimmed(profile.establishedAtText) !== null ||
    optTrimmed(profile.businessDescription) !== null ||
    optTrimmed(profile.capitalText) !== null ||
    profile.fiscalClosingMonth !== null ||
    profile.advisoryFee !== 0 ||
    profile.settlementFee !== 0 ||
    optTrimmed(profile.payrollClosingCode) !== null ||
    optTrimmed(profile.payrollPayCode) !== null ||
    optTrimmed(profile.laborInsuranceCode) !== null ||
    optTrimmed(profile.socialInsuranceCode) !== null ||
    optTrimmed(profile.laborInsuranceNo) !== null ||
    optTrimmed(profile.employmentInsOfficeNo) !== null ||
    optTrimmed(profile.pensionOfficeNo) !== null ||
    optTrimmed(profile.pensionSerialNo) !== null ||
    optTrimmed(profile.taxOfficeId) !== null ||
    optTrimmed(profile.taxOfficeSerialNo) !== null ||
    optTrimmed(profile.incomeTaxCode) !== null ||
    optTrimmed(profile.consumptionTaxCode) !== null ||
    optTrimmed(profile.residentTaxCode) !== null ||
    optTrimmed(profile.taxTransferInfo) !== null ||
    optTrimmed(profile.laborBankAccount) !== null ||
    optTrimmed(profile.socialBankAccount) !== null
  );
}

function validateAdvisoryInput(profile: PartnerAdvisoryProfileInput): PartnerAdvisoryProfileInput {
  if (
    profile.fiscalClosingMonth !== null &&
    (!Number.isInteger(profile.fiscalClosingMonth) ||
      profile.fiscalClosingMonth < 0 ||
      profile.fiscalClosingMonth > 12)
  ) {
    throw new MasterDataError(400, 'INVALID_CLOSING_MONTH', '決算月は0〜12の整数で指定してください。');
  }
  return {
    corporateNo: optTrimmed(profile.corporateNo),
    establishedAtText: optTrimmed(profile.establishedAtText),
    businessDescription: optTrimmed(profile.businessDescription),
    capitalText: optTrimmed(profile.capitalText),
    fiscalClosingMonth: profile.fiscalClosingMonth,
    advisoryFee: validateIntegerAmount(profile.advisoryFee, '顧問料'),
    settlementFee: validateIntegerAmount(profile.settlementFee, '決算料'),
    payrollClosingCode: optTrimmed(profile.payrollClosingCode),
    payrollPayCode: optTrimmed(profile.payrollPayCode),
    laborInsuranceCode: optTrimmed(profile.laborInsuranceCode),
    socialInsuranceCode: optTrimmed(profile.socialInsuranceCode),
    laborInsuranceNo: optTrimmed(profile.laborInsuranceNo),
    employmentInsOfficeNo: optTrimmed(profile.employmentInsOfficeNo),
    pensionOfficeNo: optTrimmed(profile.pensionOfficeNo),
    pensionSerialNo: optTrimmed(profile.pensionSerialNo),
    taxOfficeId: validateUuidOrNull(profile.taxOfficeId, '税務署'),
    taxOfficeSerialNo: optTrimmed(profile.taxOfficeSerialNo),
    incomeTaxCode: optTrimmed(profile.incomeTaxCode),
    consumptionTaxCode: optTrimmed(profile.consumptionTaxCode),
    residentTaxCode: optTrimmed(profile.residentTaxCode),
    taxTransferInfo: optTrimmed(profile.taxTransferInfo),
    laborBankAccount: optTrimmed(profile.laborBankAccount),
    socialBankAccount: optTrimmed(profile.socialBankAccount),
  };
}

function validatePartnerInput(input: BusinessPartnerInput) {
  const partnerCode = input.partnerCode.trim();
  if (partnerCode.length === 0 || partnerCode.length > 40) {
    throw new MasterDataError(400, 'INVALID_PARTNER_CODE', '取引先コードは1〜40文字で入力してください。');
  }
  const partnerName = input.partnerName.trim();
  if (partnerName.length === 0 || partnerName.length > 150) {
    throw new MasterDataError(400, 'INVALID_PARTNER_NAME', '取引先名は1〜150文字で入力してください。');
  }

  const rawAccountType = optTrimmed(input.bankAccountType);
  let bankAccountType: 'B1' | 'B2' | null = null;
  if (rawAccountType === 'B1' || rawAccountType === 'B2') {
    bankAccountType = rawAccountType;
  } else if (rawAccountType !== null) {
    throw new MasterDataError(400, 'INVALID_BANK_ACCOUNT_TYPE', '口座種別は B1（普通）または B2（当座）を選択してください。');
  }

  return {
    partnerCode,
    categoryCode: optTrimmed(input.categoryCode),
    stateCode: optTrimmed(input.stateCode),
    partnerName,
    furigana: optTrimmed(input.furigana),
    representativeId: validateUuidOrNull(input.representativeId, '代表者'),
    isIndividualHonorific: Boolean(input.isIndividualHonorific),
    postalCode: optTrimmed(input.postalCode),
    address1: optTrimmed(input.address1),
    address2: optTrimmed(input.address2),
    tel: optTrimmed(input.tel),
    isClient: Boolean(input.isClient),
    isSupplier: Boolean(input.isSupplier),
    isAplusEnabled: Boolean(input.isAplusEnabled),
    sendMailEnabled: Boolean(input.sendMailEnabled),
    email: optTrimmed(input.email),
    estimateMailTo: optTrimmed(input.estimateMailTo),
    estimateMailCc: optTrimmed(input.estimateMailCc),
    billMailTo: optTrimmed(input.billMailTo),
    billMailCc: optTrimmed(input.billMailCc),
    invoiceNo: optTrimmed(input.invoiceNo),
    billingDestinationName: optTrimmed(input.billingDestinationName),
    closingDayCode: optTrimmed(input.closingDayCode),
    collectionDayCode: optTrimmed(input.collectionDayCode),
    receiptMethodCode: optTrimmed(input.receiptMethodCode),
    paymentMethodCode: optTrimmed(input.paymentMethodCode),
    assignedEmployeeId: validateUuidOrNull(input.assignedEmployeeId, '担当社員'),
    openingArBalance:
      input.openingArBalance === undefined ? undefined : validateIntegerAmount(input.openingArBalance, '期首売掛残高'),
    openingApBalance:
      input.openingApBalance === undefined ? undefined : validateIntegerAmount(input.openingApBalance, '期首買掛残高'),
    bankCode: optTrimmed(input.bankCode),
    branchCode: optTrimmed(input.branchCode),
    bankAccountType,
    bankAccountNo: optTrimmed(input.bankAccountNo),
    bankAccountHolder: optTrimmed(input.bankAccountHolder),
    isDeleted: Boolean(input.isDeleted),
    advisoryProfile: input.advisoryProfile === null ? null : validateAdvisoryInput(input.advisoryProfile),
  };
}

function mapListRow(row: PartnerListRow): BusinessPartnerListItemDto {
  return {
    id: row.id,
    partnerCode: row.partner_code,
    partnerName: row.partner_name,
    furigana: row.furigana,
    categoryCode: row.category_code,
    stateCode: row.state_code,
    isClient: row.is_client,
    isSupplier: row.is_supplier,
    isAplusEnabled: row.is_aplus_enabled,
    tel: row.tel,
    representativeId: row.representative_id,
    representativeName: row.representative_name,
    assignedEmployeeId: row.assigned_employee_id,
    assignedEmployeeName: row.assigned_employee_name,
    openingArBalance: Number(row.opening_ar_balance),
    openingApBalance: Number(row.opening_ap_balance),
    isDeleted: row.is_deleted,
    updatedAt: row.updated_at,
  };
}

function mapAdvisoryRow(row: AdvisoryRow, encKeyHex: string): PartnerAdvisoryProfileDto {
  return {
    id: row.id,
    corporateNo: row.corporate_no,
    establishedAtText: row.established_at_text,
    businessDescription: row.business_description,
    capitalText: row.capital_text,
    fiscalClosingMonth: row.fiscal_closing_month,
    advisoryFee: Number(row.advisory_fee),
    settlementFee: Number(row.settlement_fee),
    payrollClosingCode: row.payroll_closing_code,
    payrollPayCode: row.payroll_pay_code,
    laborInsuranceCode: row.labor_insurance_code,
    socialInsuranceCode: row.social_insurance_code,
    laborInsuranceNo: row.labor_insurance_no,
    employmentInsOfficeNo: row.employment_ins_office_no,
    pensionOfficeNo: row.pension_office_no,
    pensionSerialNo: row.pension_serial_no,
    taxOfficeId: row.tax_office_id,
    taxOfficeName: row.tax_office_name,
    taxOfficeSerialNo: row.tax_office_serial_no,
    incomeTaxCode: row.income_tax_code,
    consumptionTaxCode: row.consumption_tax_code,
    residentTaxCode: row.resident_tax_code,
    taxTransferInfo: decryptOptionalField(row.tax_transfer_info_enc, encKeyHex),
    laborBankAccount: decryptOptionalField(row.labor_bank_account_enc, encKeyHex),
    socialBankAccount: decryptOptionalField(row.social_bank_account_enc, encKeyHex),
  };
}

export async function listBusinessPartners(
  tx: DbExecutor,
  filter: PartnerListFilter = {},
): Promise<BusinessPartnerListItemDto[]> {
  const kw = optTrimmed(filter.keyword);
  const roleParam = filter.role !== undefined && filter.role !== null && filter.role !== 'ALL' ? filter.role : null;
  const catParam = optTrimmed(filter.categoryCode);
  const stateParam = optTrimmed(filter.stateCode);
  const includeDeleted = filter.includeDeleted === true;

  const rows = await tx.query<PartnerListRow>(
    `SELECT
       bp.id,
       bp.partner_code,
       bp.partner_name,
       bp.furigana,
       bp.category_code,
       bp.state_code,
       bp.is_client,
       bp.is_supplier,
       bp.is_aplus_enabled,
       bp.tel,
       bp.representative_id,
       r.representative_name,
       bp.assigned_employee_id,
       e.syain_name AS assigned_employee_name,
       bp.opening_ar_balance::text AS opening_ar_balance,
       bp.opening_ap_balance::text AS opening_ap_balance,
       bp.is_deleted,
       bp.updated_at::text AS updated_at
     FROM business_partners bp
     LEFT JOIN representatives r
       ON r.tenant_id = bp.tenant_id AND r.id = bp.representative_id
     LEFT JOIN employees e
       ON e.tenant_id = bp.tenant_id AND e.id = bp.assigned_employee_id
     WHERE (
       $1::text IS NULL
       OR bp.partner_code ILIKE '%' || $1 || '%'
       OR bp.partner_name ILIKE '%' || $1 || '%'
       OR COALESCE(bp.furigana, '') ILIKE '%' || $1 || '%'
       OR COALESCE(bp.tel, '') ILIKE '%' || $1 || '%'
     )
     AND (
       $2::text IS NULL
       OR ($2 = 'CLIENT' AND bp.is_client = true)
       OR ($2 = 'SUPPLIER' AND bp.is_supplier = true)
       OR ($2 = 'APLUS' AND bp.is_aplus_enabled = true)
     )
     AND ($3::text IS NULL OR bp.category_code = $3)
     AND ($4::text IS NULL OR bp.state_code = $4)
     AND ($5::boolean = true OR bp.is_deleted = false)
     ORDER BY bp.partner_code ASC`,
    [kw, roleParam, catParam, stateParam, includeDeleted],
  );
  return rows.map(mapListRow);
}

export async function getBusinessPartnerDetail(
  tx: DbExecutor,
  id: string,
  encKeyHex: string,
): Promise<BusinessPartnerDetailDto> {
  validatePartnerId(id);

  const partnerRows = await tx.query<PartnerDetailRow>(
    `SELECT
       bp.id,
       bp.partner_code,
       bp.partner_name,
       bp.furigana,
       bp.category_code,
       bp.state_code,
       bp.is_client,
       bp.is_supplier,
       bp.is_aplus_enabled,
       bp.tel,
       bp.representative_id,
       r.representative_name,
       bp.assigned_employee_id,
       e.syain_name AS assigned_employee_name,
       bp.opening_ar_balance::text AS opening_ar_balance,
       bp.opening_ap_balance::text AS opening_ap_balance,
       bp.is_deleted,
       bp.updated_at::text AS updated_at,
       bp.is_individual_honorific,
       bp.postal_code,
       bp.address1,
       bp.address2,
       bp.send_mail_enabled,
       bp.email,
       bp.estimate_mail_to,
       bp.estimate_mail_cc,
       bp.bill_mail_to,
       bp.bill_mail_cc,
       bp.invoice_no,
       bp.billing_destination_name,
       bp.closing_day_code,
       bp.collection_day_code,
       bp.receipt_method_code,
       bp.payment_method_code,
       bp.bank_code,
       bp.branch_code,
       bp.bank_account_type,
       bp.bank_account_no_enc,
       bp.bank_account_holder,
       (SELECT ts.opening_balance_date::text FROM tenant_settings ts WHERE ts.tenant_id = bp.tenant_id LIMIT 1) AS opening_balance_date
     FROM business_partners bp
     LEFT JOIN representatives r
       ON r.tenant_id = bp.tenant_id AND r.id = bp.representative_id
     LEFT JOIN employees e
       ON e.tenant_id = bp.tenant_id AND e.id = bp.assigned_employee_id
     WHERE bp.id = $1::uuid`,
    [id],
  );

  if (partnerRows.length === 0) {
    throw new MasterDataError(404, 'PARTNER_NOT_FOUND', '指定された取引先が見つかりません。');
  }

  const advRows = await tx.query<AdvisoryRow>(
    `SELECT
       ap.id,
       ap.corporate_no,
       ap.established_at_text,
       ap.business_description,
       ap.capital_text,
       ap.fiscal_closing_month,
       ap.advisory_fee::text AS advisory_fee,
       ap.settlement_fee::text AS settlement_fee,
       ap.payroll_closing_code,
       ap.payroll_pay_code,
       ap.labor_insurance_code,
       ap.social_insurance_code,
       ap.labor_insurance_no,
       ap.employment_ins_office_no,
       ap.pension_office_no,
       ap.pension_serial_no,
       ap.tax_office_id,
       taxoff.tax_office_name,
       ap.tax_office_serial_no,
       ap.income_tax_code,
       ap.consumption_tax_code,
       ap.resident_tax_code,
       ap.tax_transfer_info_enc,
       ap.labor_bank_account_enc,
       ap.social_bank_account_enc
     FROM partner_advisory_profiles ap
     LEFT JOIN tax_offices taxoff
       ON taxoff.tenant_id = ap.tenant_id AND taxoff.id = ap.tax_office_id
     WHERE ap.partner_id = $1::uuid`,
    [id],
  );

  const row = partnerRows[0];
  if (row === undefined) {
    throw new MasterDataError(404, 'PARTNER_NOT_FOUND', '指定された取引先が見つかりません。');
  }
  const advRow = advRows[0];

  return {
    ...mapListRow(row),
    isIndividualHonorific: row.is_individual_honorific,
    postalCode: row.postal_code,
    address1: row.address1,
    address2: row.address2,
    sendMailEnabled: row.send_mail_enabled,
    email: row.email,
    estimateMailTo: row.estimate_mail_to,
    estimateMailCc: row.estimate_mail_cc,
    billMailTo: row.bill_mail_to,
    billMailCc: row.bill_mail_cc,
    invoiceNo: row.invoice_no,
    billingDestinationName: row.billing_destination_name,
    closingDayCode: row.closing_day_code,
    collectionDayCode: row.collection_day_code,
    receiptMethodCode: row.receipt_method_code,
    paymentMethodCode: row.payment_method_code,
    bankCode: row.bank_code,
    branchCode: row.branch_code,
    bankAccountType: row.bank_account_type,
    bankAccountNo: decryptOptionalField(row.bank_account_no_enc, encKeyHex),
    bankAccountHolder: row.bank_account_holder,
    openingBalanceDate: row.opening_balance_date,
    advisoryProfile: advRow !== undefined ? mapAdvisoryRow(advRow, encKeyHex) : null,
  };
}

async function upsertAdvisoryProfile(
  tx: DbExecutor,
  tenantId: string,
  partnerId: string,
  profile: PartnerAdvisoryProfileInput,
  encKeyHex: string,
): Promise<void> {
  const taxTransferEnc = encryptOptionalField(profile.taxTransferInfo, encKeyHex);
  const laborBankEnc = encryptOptionalField(profile.laborBankAccount, encKeyHex);
  const socialBankEnc = encryptOptionalField(profile.socialBankAccount, encKeyHex);

  await tx.query(
    `INSERT INTO partner_advisory_profiles (
       tenant_id, partner_id, corporate_no, established_at_text, business_description,
       capital_text, fiscal_closing_month, advisory_fee, settlement_fee,
       payroll_closing_code, payroll_pay_code, labor_insurance_code, social_insurance_code,
       labor_insurance_no, employment_ins_office_no, pension_office_no, pension_serial_no,
       tax_office_id, tax_office_serial_no, income_tax_code, consumption_tax_code,
       resident_tax_code, tax_transfer_info_enc, labor_bank_account_enc, social_bank_account_enc
     ) VALUES (
       $1::uuid, $2::uuid, $3, $4, $5, $6, $7, $8, $9,
       $10, $11, $12, $13, $14, $15, $16, $17,
       $18::uuid, $19, $20, $21, $22, $23, $24, $25
     )
     ON CONFLICT (tenant_id, partner_id) DO UPDATE SET
       corporate_no = EXCLUDED.corporate_no,
       established_at_text = EXCLUDED.established_at_text,
       business_description = EXCLUDED.business_description,
       capital_text = EXCLUDED.capital_text,
       fiscal_closing_month = EXCLUDED.fiscal_closing_month,
       advisory_fee = EXCLUDED.advisory_fee,
       settlement_fee = EXCLUDED.settlement_fee,
       payroll_closing_code = EXCLUDED.payroll_closing_code,
       payroll_pay_code = EXCLUDED.payroll_pay_code,
       labor_insurance_code = EXCLUDED.labor_insurance_code,
       social_insurance_code = EXCLUDED.social_insurance_code,
       labor_insurance_no = EXCLUDED.labor_insurance_no,
       employment_ins_office_no = EXCLUDED.employment_ins_office_no,
       pension_office_no = EXCLUDED.pension_office_no,
       pension_serial_no = EXCLUDED.pension_serial_no,
       tax_office_id = EXCLUDED.tax_office_id,
       tax_office_serial_no = EXCLUDED.tax_office_serial_no,
       income_tax_code = EXCLUDED.income_tax_code,
       consumption_tax_code = EXCLUDED.consumption_tax_code,
       resident_tax_code = EXCLUDED.resident_tax_code,
       tax_transfer_info_enc = EXCLUDED.tax_transfer_info_enc,
       labor_bank_account_enc = EXCLUDED.labor_bank_account_enc,
       social_bank_account_enc = EXCLUDED.social_bank_account_enc`,
    [
      tenantId,
      partnerId,
      profile.corporateNo,
      profile.establishedAtText,
      profile.businessDescription,
      profile.capitalText,
      profile.fiscalClosingMonth,
      profile.advisoryFee,
      profile.settlementFee,
      profile.payrollClosingCode,
      profile.payrollPayCode,
      profile.laborInsuranceCode,
      profile.socialInsuranceCode,
      profile.laborInsuranceNo,
      profile.employmentInsOfficeNo,
      profile.pensionOfficeNo,
      profile.pensionSerialNo,
      profile.taxOfficeId,
      profile.taxOfficeSerialNo,
      profile.incomeTaxCode,
      profile.consumptionTaxCode,
      profile.residentTaxCode,
      taxTransferEnc,
      laborBankEnc,
      socialBankEnc,
    ],
  );
}

export async function createBusinessPartner(
  tx: DbExecutor,
  tenantId: string,
  input: BusinessPartnerInput,
  options: { isAdmin: boolean; encKeyHex: string },
): Promise<BusinessPartnerDetailDto> {
  const clean = validatePartnerInput(input);
  const openingAr = clean.openingArBalance !== undefined ? clean.openingArBalance : 0;
  const openingAp = clean.openingApBalance !== undefined ? clean.openingApBalance : 0;

  if (!options.isAdmin && (openingAr !== 0 || openingAp !== 0)) {
    throw new MasterDataError(
      403,
      'ADMIN_REQUIRED_FOR_OPENING_BALANCE',
      '期首売掛・買掛残高の初期設定は管理者のみ変更できます。',
    );
  }

  const bankAccountNoEnc = encryptOptionalField(clean.bankAccountNo, options.encKeyHex);

  let insertedId: string;
  try {
    const insertedRows = await tx.query<{ id: string }>(
      `INSERT INTO business_partners (
         tenant_id, partner_code, category_code, state_code, partner_name, furigana,
         representative_id, is_individual_honorific, postal_code, address1, address2, tel,
         is_client, is_supplier, is_aplus_enabled, send_mail_enabled,
         email, estimate_mail_to, estimate_mail_cc, bill_mail_to, bill_mail_cc,
         invoice_no, billing_destination_name, closing_day_code, collection_day_code,
         receipt_method_code, payment_method_code, assigned_employee_id,
         opening_ar_balance, opening_ap_balance,
         bank_code, branch_code, bank_account_type, bank_account_no_enc, bank_account_holder,
         is_deleted
       ) VALUES (
         $1::uuid, $2, $3, $4, $5, $6,
         $7::uuid, $8, $9, $10, $11, $12,
         $13, $14, $15, $16,
         $17, $18, $19, $20, $21,
         $22, $23, $24, $25,
         $26, $27, $28::uuid,
         $29, $30,
         $31, $32, $33, $34, $35,
         $36
       )
       RETURNING id`,
      [
        tenantId,
        clean.partnerCode,
        clean.categoryCode,
        clean.stateCode,
        clean.partnerName,
        clean.furigana,
        clean.representativeId,
        clean.isIndividualHonorific,
        clean.postalCode,
        clean.address1,
        clean.address2,
        clean.tel,
        clean.isClient,
        clean.isSupplier,
        clean.isAplusEnabled,
        clean.sendMailEnabled,
        clean.email,
        clean.estimateMailTo,
        clean.estimateMailCc,
        clean.billMailTo,
        clean.billMailCc,
        clean.invoiceNo,
        clean.billingDestinationName,
        clean.closingDayCode,
        clean.collectionDayCode,
        clean.receiptMethodCode,
        clean.paymentMethodCode,
        clean.assignedEmployeeId,
        openingAr,
        openingAp,
        clean.bankCode,
        clean.branchCode,
        clean.bankAccountType,
        bankAccountNoEnc,
        clean.bankAccountHolder,
        clean.isDeleted,
      ],
    );
    const insertedRow = insertedRows[0];
    if (insertedRow === undefined) {
      throw new MasterDataError(500, 'INSERT_FAILED', '取引先の登録結果を取得できませんでした。');
    }
    insertedId = insertedRow.id;

    if (clean.advisoryProfile !== null && hasAnyAdvisoryContent(clean.advisoryProfile)) {
      await upsertAdvisoryProfile(tx, tenantId, insertedId, clean.advisoryProfile, options.encKeyHex);
    }
  } catch (err) {
    throw mapPgConstraintError(err, {
      entityLabel: '取引先',
      defaultUniqueMessage: `取引先コード「${clean.partnerCode}」は既に登録されています。別のコードを指定してください。`,
      defaultFkMessage: '指定された代表者・担当社員・税務署の参照が無効です。',
    });
  }

  return getBusinessPartnerDetail(tx, insertedId, options.encKeyHex);
}

export async function updateBusinessPartner(
  tx: DbExecutor,
  tenantId: string,
  id: string,
  input: BusinessPartnerInput,
  options: { isAdmin: boolean; encKeyHex: string },
): Promise<BusinessPartnerDetailDto> {
  validatePartnerId(id);
  const clean = validatePartnerInput(input);

  const existingRows = await tx.query<{
    opening_ar_balance: string | number;
    opening_ap_balance: string | number;
  }>(
    `SELECT opening_ar_balance::text AS opening_ar_balance, opening_ap_balance::text AS opening_ap_balance
     FROM business_partners
     WHERE id = $1::uuid
     FOR UPDATE`,
    [id],
  );
  const existing = existingRows[0];
  if (existing === undefined) {
    throw new MasterDataError(404, 'PARTNER_NOT_FOUND', '指定された取引先が見つかりません。');
  }

  const existingAr = Number(existing.opening_ar_balance);
  const existingAp = Number(existing.opening_ap_balance);

  let nextAr = existingAr;
  let nextAp = existingAp;
  if (options.isAdmin) {
    nextAr = clean.openingArBalance !== undefined ? clean.openingArBalance : existingAr;
    nextAp = clean.openingApBalance !== undefined ? clean.openingApBalance : existingAp;
  } else {
    const arChanged = clean.openingArBalance !== undefined && clean.openingArBalance !== existingAr;
    const apChanged = clean.openingApBalance !== undefined && clean.openingApBalance !== existingAp;
    if (arChanged || apChanged) {
      throw new MasterDataError(
        403,
        'ADMIN_REQUIRED_FOR_OPENING_BALANCE',
        '期首売掛・買掛残高の変更は管理者のみ実行できます。',
      );
    }
  }

  const bankAccountNoEnc = encryptOptionalField(clean.bankAccountNo, options.encKeyHex);

  try {
    await tx.query(
      `UPDATE business_partners
       SET
         partner_code = $2,
         category_code = $3,
         state_code = $4,
         partner_name = $5,
         furigana = $6,
         representative_id = $7::uuid,
         is_individual_honorific = $8,
         postal_code = $9,
         address1 = $10,
         address2 = $11,
         tel = $12,
         is_client = $13,
         is_supplier = $14,
         is_aplus_enabled = $15,
         send_mail_enabled = $16,
         email = $17,
         estimate_mail_to = $18,
         estimate_mail_cc = $19,
         bill_mail_to = $20,
         bill_mail_cc = $21,
         invoice_no = $22,
         billing_destination_name = $23,
         closing_day_code = $24,
         collection_day_code = $25,
         receipt_method_code = $26,
         payment_method_code = $27,
         assigned_employee_id = $28::uuid,
         opening_ar_balance = $29,
         opening_ap_balance = $30,
         bank_code = $31,
         branch_code = $32,
         bank_account_type = $33,
         bank_account_no_enc = $34,
         bank_account_holder = $35,
         is_deleted = $36
       WHERE id = $1::uuid`,
      [
        id,
        clean.partnerCode,
        clean.categoryCode,
        clean.stateCode,
        clean.partnerName,
        clean.furigana,
        clean.representativeId,
        clean.isIndividualHonorific,
        clean.postalCode,
        clean.address1,
        clean.address2,
        clean.tel,
        clean.isClient,
        clean.isSupplier,
        clean.isAplusEnabled,
        clean.sendMailEnabled,
        clean.email,
        clean.estimateMailTo,
        clean.estimateMailCc,
        clean.billMailTo,
        clean.billMailCc,
        clean.invoiceNo,
        clean.billingDestinationName,
        clean.closingDayCode,
        clean.collectionDayCode,
        clean.receiptMethodCode,
        clean.paymentMethodCode,
        clean.assignedEmployeeId,
        nextAr,
        nextAp,
        clean.bankCode,
        clean.branchCode,
        clean.bankAccountType,
        bankAccountNoEnc,
        clean.bankAccountHolder,
        clean.isDeleted,
      ],
    );

    if (clean.advisoryProfile !== null) {
      const advExistRows = await tx.query<{ id: string }>(
        `SELECT id FROM partner_advisory_profiles WHERE partner_id = $1::uuid LIMIT 1`,
        [id],
      );
      if (advExistRows.length > 0 || hasAnyAdvisoryContent(clean.advisoryProfile)) {
        await upsertAdvisoryProfile(tx, tenantId, id, clean.advisoryProfile, options.encKeyHex);
      }
    }
  } catch (err) {
    throw mapPgConstraintError(err, {
      entityLabel: '取引先',
      defaultUniqueMessage: `取引先コード「${clean.partnerCode}」は既に他の取引先に登録されています。`,
      defaultFkMessage: '指定された代表者・担当社員・税務署の参照が無効です。',
    });
  }

  return getBusinessPartnerDetail(tx, id, options.encKeyHex);
}
