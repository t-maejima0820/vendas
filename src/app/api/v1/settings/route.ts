import { NextResponse } from 'next/server';
import { ApiError, withApiHandler } from '@/lib/api/handler';
import type { CostTaxMode, RoundingMode, TaxCalcPolicy } from '@/lib/domain/calculations';
import { requireEnv } from '@/lib/env';
import {
  getTenantSettingsForAdmin,
  SettingsValidationError,
  updateTenantSettingsForAdmin,
  type UpdateTenantSettingsInput,
} from '@/lib/settings/settings-service';

function readNullableString(obj: Record<string, unknown>, key: string): string | null {
  const val = obj[key];
  if (val === undefined || val === null) return null;
  if (typeof val !== 'string') {
    throw new SettingsValidationError(`項目 '${key}' は文字列である必要があります`);
  }
  return val;
}

function readRequiredBoolean(obj: Record<string, unknown>, key: string): boolean {
  const val = obj[key];
  if (typeof val !== 'boolean') {
    throw new SettingsValidationError(`項目 '${key}' は真偽値である必要があります`);
  }
  return val;
}

function readAccountType(obj: Record<string, unknown>, key: string): 'B1' | 'B2' | null {
  const val = readNullableString(obj, key);
  if (val === null || val.trim() === '') return null;
  if (val === 'B1' || val === 'B2') return val;
  throw new SettingsValidationError(`項目 '${key}' は B1 または B2 である必要があります`);
}

function parseUpdateInput(rawBody: unknown): UpdateTenantSettingsInput {
  if (rawBody === null || typeof rawBody !== 'object') {
    throw new ApiError(400, 'INVALID_PAYLOAD', '設定データ形式が不正です。');
  }
  const obj = rawBody as Record<string, unknown>;
  if (typeof obj['companyName'] !== 'string') {
    throw new SettingsValidationError('会社名は必須です');
  }

  const fiscalClosingMonth = Number(obj['fiscalClosingMonth']);
  const defaultApprovalBillingDate = Number(obj['defaultApprovalBillingDate']);
  const defaultArListDateMode = Number(obj['defaultArListDateMode']);
  const quotationTemplateRows = Number(obj['quotationTemplateRows']);

  if (!Array.isArray(obj['features'])) {
    throw new SettingsValidationError('機能権限一覧 (features) が不正です');
  }
  const features = obj['features'].map((item) => {
    if (item === null || typeof item !== 'object') {
      throw new SettingsValidationError('機能権限アイテムの形式が不正です');
    }
    const fObj = item as Record<string, unknown>;
    if (typeof fObj['featureCode'] !== 'string' || typeof fObj['isEnabled'] !== 'boolean') {
      throw new SettingsValidationError('機能権限の各項目には featureCode と isEnabled が必要です');
    }
    return {
      featureCode: fObj['featureCode'],
      isEnabled: fObj['isEnabled'],
    };
  });

  const costTaxMode = obj['costTaxMode'] as CostTaxMode;
  const taxCalcPolicy = obj['taxCalcPolicy'] as TaxCalcPolicy;
  const defaultRoundingMode = obj['defaultRoundingMode'] as RoundingMode;

  return {
    companyName: obj['companyName'],
    invoiceRegistrationNo: readNullableString(obj, 'invoiceRegistrationNo'),
    corporateNo: readNullableString(obj, 'corporateNo'),
    postalCode: readNullableString(obj, 'postalCode'),
    address1: readNullableString(obj, 'address1'),
    address2: readNullableString(obj, 'address2'),
    tel: readNullableString(obj, 'tel'),
    fax: readNullableString(obj, 'fax'),
    email: readNullableString(obj, 'email'),
    representativeTitle: readNullableString(obj, 'representativeTitle'),
    representativeName: readNullableString(obj, 'representativeName'),
    fiscalClosingMonth,
    billingMemo: readNullableString(obj, 'billingMemo'),
    bankCode1: readNullableString(obj, 'bankCode1'),
    branchCode1: readNullableString(obj, 'branchCode1'),
    bankAccountType1: readAccountType(obj, 'bankAccountType1'),
    bankAccountNo1: readNullableString(obj, 'bankAccountNo1'),
    bankAccountHolder1: readNullableString(obj, 'bankAccountHolder1'),
    bankCode2: readNullableString(obj, 'bankCode2'),
    branchCode2: readNullableString(obj, 'branchCode2'),
    bankAccountType2: readAccountType(obj, 'bankAccountType2'),
    bankAccountNo2: readNullableString(obj, 'bankAccountNo2'),
    bankAccountHolder2: readNullableString(obj, 'bankAccountHolder2'),
    approvalFlowEnabled: readRequiredBoolean(obj, 'approvalFlowEnabled'),
    allowBillingDateWarningSkip: readRequiredBoolean(obj, 'allowBillingDateWarningSkip'),
    defaultApprovalBillingDate:
      defaultApprovalBillingDate === 0 || defaultApprovalBillingDate === 1 || defaultApprovalBillingDate === 2
        ? defaultApprovalBillingDate
        : (99 as 0),
    defaultArListDateMode:
      defaultArListDateMode === 0 || defaultArListDateMode === 1 ? defaultArListDateMode : (99 as 0),
    quotationTemplateRows: quotationTemplateRows === 10 || quotationTemplateRows === 20 ? quotationTemplateRows : (99 as 10),
    showInvoiceCarryover: readRequiredBoolean(obj, 'showInvoiceCarryover'),
    costTaxMode,
    taxCalcPolicy,
    defaultRoundingMode,
    features,
  };
}

export const GET = withApiHandler({ requireAdmin: true }, async ({ user, tx }) => {
  const encKey = requireEnv('FIELD_ENCRYPTION_KEY_HEX');
  const data = await getTenantSettingsForAdmin(tx, user.tenantId, encKey);
  return NextResponse.json({ ok: true, data });
});

export const PUT = withApiHandler({ requireAdmin: true }, async ({ req, user, tx }) => {
  let rawBody: unknown;
  try {
    rawBody = await req.json();
  } catch (err) {
    throw new ApiError(
      400,
      'INVALID_JSON',
      err instanceof Error ? 'JSON形式のリクエストが不正です。' : 'JSON形式のリクエストが不正です。',
    );
  }

  const parsed = parseUpdateInput(rawBody);
  const encKey = requireEnv('FIELD_ENCRYPTION_KEY_HEX');
  const updated = await updateTenantSettingsForAdmin(tx, user.tenantId, parsed, encKey);
  return NextResponse.json({ ok: true, data: updated });
});
