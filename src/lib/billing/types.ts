import type { RoundingMode, TaxCalcPolicy, TaxCode } from '@/lib/domain/calculations';
import type {
  EstimatePartnerOption,
  QuotationTemplateVariant,
  SnapshotHistoryItemDto,
} from '@/lib/estimates/types';
import type { ApprovalStatus, SalesEntryType, SalesStatus } from '@/lib/sales/types';

export type ReceivableStatus = 'N1' | 'N2' | 'N3' | 'N4';

export const RECEIVABLE_STATUS_LABELS: Readonly<Record<ReceivableStatus, string>> = {
  N1: '未入金',
  N2: '一部入金',
  N3: '入金済',
  N4: '過入金',
};

export type BillingDocumentType =
  | 'INVOICE'
  | 'INVOICE_STANDALONE'
  | 'INVOICE_COVER'
  | 'INVOICE_COVER_MEMO_SUM'
  | 'INVOICE_COVER_DETAIL'
  | 'FIXED_INVOICE';

export const STANDARD_BILLING_DOCUMENT_TYPES: readonly BillingDocumentType[] = [
  'INVOICE',
  'INVOICE_STANDALONE',
  'INVOICE_COVER',
  'INVOICE_COVER_MEMO_SUM',
];

export const ALL_BILLING_DOCUMENT_TYPES: readonly BillingDocumentType[] = [
  'INVOICE',
  'INVOICE_STANDALONE',
  'INVOICE_COVER',
  'INVOICE_COVER_MEMO_SUM',
  'INVOICE_COVER_DETAIL',
  'FIXED_INVOICE',
];

export const BILLING_DOCUMENT_TYPE_LABELS: Readonly<Record<BillingDocumentType, string>> = {
  INVOICE: '標準請求書',
  INVOICE_STANDALONE: '単独請求書（繰越なし）',
  INVOICE_COVER: '請求書（鏡）',
  INVOICE_COVER_MEMO_SUM: '請求書（鏡・備考集約）',
  INVOICE_COVER_DETAIL: '請求書（鏡明細）',
  FIXED_INVOICE: '定額請求書',
};

export type BillingExportTarget = 'standard' | 'simple' | 'detail';

export interface BillingListFilter {
  keyword?: string | null;
  partnerId?: string | null;
  status?: ReceivableStatus | null;
  isSubscription?: 'ALL' | 'STANDARD' | 'SUBSCRIPTION';
  dateFrom?: string | null;
  dateTo?: string | null;
  page?: number;
  pageSize?: number;
}

export interface BillingCandidateSlipDto {
  id: string;
  entryType: SalesEntryType;
  slipNo: number;
  slipName: string;
  slipDate: string;
  status: SalesStatus;
  approvalStatus: ApprovalStatus;
  roundingMode: RoundingMode;
  subtotalAmount: number;
  taxTotal: number;
  totalAmount: number;
  lineCount: number;
}

export interface BillingCandidatePartnerGroupDto {
  partnerId: string;
  partnerCode: string;
  partnerName: string;
  closingDayCode: string | null;
  closingDayName: string | null;
  collectionDayCode: string | null;
  proposedPaymentDueDate: string;
  slipCount: number;
  aggregatedCount: number;
  unapprovedCount: number;
  prevCarriedBalance: number;
  periodReceiptAmount: number;
  netCarriedBalance: number;
  amount10Excl: number;
  amount8Excl: number;
  amount0NonTax: number;
  tax10Amount: number;
  tax8Amount: number;
  taxAdjustmentAmount: number;
  taxTotal: number;
  currentBillingAmount: number;
  closingArBalance: number;
  slips: BillingCandidateSlipDto[];
}

export interface BillingCandidateListResultDto {
  balancePeriodStart: string;
  balancePeriodEnd: string;
  taxCalcPolicy: TaxCalcPolicy;
  approvalFlowEnabled: boolean;
  allowBillingDateWarningSkip: boolean;
  groups: BillingCandidatePartnerGroupDto[];
  totals: {
    partnerCount: number;
    slipCount: number;
    unapprovedSlipCount: number;
    currentBillingAmount: number;
  };
}

export interface ConfirmBillingItemInput {
  partnerId: string;
  slipIds: string[];
  paymentDueDate?: string | null;
  documentType?: BillingDocumentType;
  templateVariant?: QuotationTemplateVariant;
  issueCoverDetail?: boolean;
}

export interface ConfirmBillingRequestInput {
  billingDate: string;
  targetPeriodStart?: string | null;
  targetPeriodEnd?: string | null;
  allowUnapproved?: boolean;
  items: ConfirmBillingItemInput[];
}

export interface BillingListItemDto {
  id: string;
  billingNo: number;
  partnerId: string;
  partnerCode: string;
  partnerName: string;
  billingDate: string;
  targetPeriodStart: string | null;
  targetPeriodEnd: string | null;
  paymentDueDate: string | null;
  isSubscriptionBill: boolean;
  taxCalcPolicy: TaxCalcPolicy;
  roundingMode: RoundingMode;
  amount10Excl: number;
  amount8Excl: number;
  amount0NonTax: number;
  tax10Amount: number;
  tax8Amount: number;
  taxAdjustmentAmount: number;
  taxTotal: number;
  currentExclAmount: number;
  billingAmount: number;
  prevCarriedBalance: number;
  periodReceiptAmount: number;
  netCarriedBalance: number;
  closingArBalance: number;
  status: ReceivableStatus;
  slipCount: number;
  snapshotCount: number;
  latestSnapshotId: string | null;
  latestSnapshotDocType: BillingDocumentType | null;
  latestSnapshotVersion: number | null;
  updatedAt: string;
}

export interface BillingPageDto {
  items: BillingListItemDto[];
  summary: {
    totalCount: number;
    sumBillingAmount: number;
    sumTaxTotal: number;
    sumPrevCarried: number;
    sumPeriodReceipt: number;
    sumClosingAr: number;
  };
  page: number;
  pageSize: number;
}

export interface BillingLinkedSlipLineDto {
  id: string;
  lineNo: number;
  itemCode: string | null;
  itemName: string;
  unitName: string | null;
  targetMonthLabel: string | null;
  isHeading: boolean;
  quantity: number;
  appliedUnitPrice: number;
  taxCode: TaxCode;
  lineAmount: number;
  lineTax: number;
  exclAmount: number;
  rowTotal: number;
  remarks: string | null;
}

export interface BillingLinkedSlipDto {
  id: string;
  entryType: SalesEntryType;
  slipNo: number;
  slipName: string;
  slipDate: string;
  status: SalesStatus;
  salesKubun: string | null;
  subtotalAmount: number;
  taxTotal: number;
  totalAmount: number;
  lines: BillingLinkedSlipLineDto[];
}

export interface BillingDetailDto extends BillingListItemDto {
  createdAt: string;
  slips: BillingLinkedSlipDto[];
  snapshots: SnapshotHistoryItemDto[];
}

export interface BillingLookupsDto {
  openingBalanceDate: string;
  approvalFlowEnabled: boolean;
  allowBillingDateWarningSkip: boolean;
  showInvoiceCarryover: boolean;
  taxCalcPolicy: TaxCalcPolicy;
  defaultRoundingMode: RoundingMode;
  quotationTemplateRows: QuotationTemplateVariant;
  billsummaryEnabled: boolean;
  billissueEnabled: boolean;
  fixedbillEnabled: boolean;
  partners: EstimatePartnerOption[];
  closingDays: Array<{ code: string; name: string }>;
}
