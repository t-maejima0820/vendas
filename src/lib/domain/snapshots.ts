import crypto from 'node:crypto';
import { decryptField, isEncryptedField } from '@/lib/crypto/field-cipher';
import type { CostTaxMode, RoundingMode, TaxCalcPolicy, TaxCode } from '@/lib/domain/calculations';

export type DocumentType =
  | 'ESTIMATE'
  | 'ESTIMATE_SUMMARY_COVER'
  | 'ESTIMATE_SUMMARY_DETAIL'
  | 'PURCHASE_ORDER'
  | 'DELIVERY_NOTE'
  | 'DELIVERY_RECEIPT'
  | 'INVOICE'
  | 'INVOICE_STANDALONE'
  | 'INVOICE_COVER'
  | 'INVOICE_COVER_MEMO_SUM'
  | 'INVOICE_COVER_DETAIL'
  | 'FIXED_INVOICE'
  | 'RECEIPT';

/**
 * 是正3準拠:
 * DocumentSnapshotPayload.issuer.bankAccounts[].accountNoEnc は
 * AES-256-GCM ("enc:v1:...") 暗号化済み文字列のまま不変凍結し、PDFレンダリング時に復号する
 */
export interface SnapshotBankAccount {
  bankName: string | null;
  branchName: string | null;
  accountTypeLabel: string | null;
  accountNoEnc: string | null;
  accountHolder: string | null;
}

export interface DecryptedBankAccount {
  bankName: string | null;
  branchName: string | null;
  accountTypeLabel: string | null;
  accountNo: string | null;
  accountHolder: string | null;
}

export interface DocumentSnapshotPayload {
  schemaVersion: 1;
  documentType: DocumentType;
  templateVariant: string;
  documentNo: string;
  issueDate: string;
  isReissue: boolean;
  reissueLabel: string | null;

  issuer: {
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
    billingMemo: string | null;
    bankAccounts: SnapshotBankAccount[];
  };

  recipient: {
    partnerCode: string;
    partnerName: string;
    representativeCode: number | null;
    representativeName: string | null;
    isIndividualHonorific: boolean;
    resolvedAddressee: string;
    honorific: string;
    resolvedPostalCode: string | null;
    resolvedAddress: string | null;
  };

  header: {
    title: string;
    projectNo: number | null;
    projectName: string | null;
    validityPeriod: string | null;
    deliveryDate: string | null;
    deliveryPlace?: string | null;
    paymentDueDate: string | null;
    roundingMode: RoundingMode;
    taxCalcPolicy: TaxCalcPolicy;
    costTaxMode?: CostTaxMode;
    subtotalAmount: number;
    taxTotal: number;
    taxAdjustmentAmount: number;
    totalAmount: number;
    taxBreakdown: {
      rate10Excl: number;
      rate10Tax: number;
      rate8Excl: number;
      rate8Tax: number;
      nonTaxAmount: number;
    };
    showCarryover: boolean;
    mirrorSummary: {
      prevCarriedBalance: number;
      periodReceiptAmount: number;
      netCarriedBalance: number;
      currentBillingAmount: number;
      closingArBalance: number;
    } | null;
    remarks: string | null;
  };

  lines: Array<{
    lineNo: number;
    sourceSlipNo: number | null;
    sourceSlipDate: string | null;
    advanceMark: 'T' | null;
    itemCode: string | null;
    itemName: string;
    capacityLabel: string | null;
    unitName: string | null;
    targetMonthLabel: string | null;
    isHeading: boolean;
    quantity: number;
    appliedUnitPrice: number;
    lineAmount: number;
    taxCode: TaxCode;
    taxRate: number;
    taxMarkSymbol: '.' | '※' | '非' | '内';
    isInternalTax: boolean;
    lineTax: number;
    rowTotal: number;
    remarks: string | null;
  }>;

  receiptSpecific?: {
    tadashi: string | null;
    totalDeposit: number;
    paymentBreakdowns: Array<{
      methodCode: string;
      methodName: string;
      amount: number;
    }>;
    billNo: string | null;
    billDueDate: string | null;
  };

  attachments: Array<{
    sortOrder: number;
    storageKey: string;
    originalName: string;
    comment: string | null;
  }>;
}

export class SnapshotValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SnapshotValidationError';
  }
}

function normalizeJsonValue(value: unknown): unknown {
  if (value === null || typeof value !== 'object') {
    return value;
  }
  if (Array.isArray(value)) {
    return value.map((item) => normalizeJsonValue(item));
  }
  const obj = value as Record<string, unknown>;
  const sorted: Record<string, unknown> = {};
  for (const key of Object.keys(obj).sort()) {
    const entry = obj[key];
    if (entry !== undefined) {
      sorted[key] = normalizeJsonValue(entry);
    }
  }
  return sorted;
}

/**
 * SHA-256 の再現性を保証するためオブジェクトキーを辞書順ソートして JSON 文字列化する
 */
export function canonicalJsonStringify(value: unknown): string {
  return JSON.stringify(normalizeJsonValue(value));
}

export function computePayloadSha256(payload: DocumentSnapshotPayload): string {
  const canonical = canonicalJsonStringify(payload);
  return crypto.createHash('sha256').update(canonical, 'utf8').digest('hex');
}

/**
 * 帳票スナップショットペイロードを検証し、正規化JSONとSHA-256ダイジェストを生成する
 * - bankAccounts[].accountNoEnc に平文が入ることを拒否（enc:v1: 必須）
 */
export function buildDocumentSnapshot(payload: DocumentSnapshotPayload): {
  payloadJson: DocumentSnapshotPayload;
  canonicalJson: string;
  payloadSha256: string;
} {
  for (const acc of payload.issuer.bankAccounts) {
    if (acc.accountNoEnc !== null && !isEncryptedField(acc.accountNoEnc)) {
      throw new SnapshotValidationError(
        'スナップショット内の口座番号 (accountNoEnc) は enc:v1: 形式で暗号化されている必要があります',
      );
    }
  }

  if (payload.isReissue && (payload.reissueLabel === null || payload.reissueLabel.trim() === '')) {
    throw new SnapshotValidationError('再発行スナップショットには reissueLabel (例: ＜再発行＞) が必須です');
  }

  const canonicalJson = canonicalJsonStringify(payload);
  const payloadSha256 = crypto.createHash('sha256').update(canonicalJson, 'utf8').digest('hex');

  return {
    payloadJson: payload,
    canonicalJson,
    payloadSha256,
  };
}

/**
 * 帳票PDFレンダリング時専用：スナップショット内口座番号を復号する
 */
export function decryptSnapshotBankAccounts(
  payload: DocumentSnapshotPayload,
  keyHex: string,
): DecryptedBankAccount[] {
  return payload.issuer.bankAccounts.map((acc) => ({
    bankName: acc.bankName,
    branchName: acc.branchName,
    accountTypeLabel: acc.accountTypeLabel,
    accountNo: acc.accountNoEnc === null ? null : decryptField(acc.accountNoEnc, keyHex),
    accountHolder: acc.accountHolder,
  }));
}
