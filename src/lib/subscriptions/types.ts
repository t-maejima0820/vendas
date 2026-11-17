import type { RoundingMode, TaxCalcPolicy, TaxCode } from '@/lib/domain/calculations';
import type { EstimatePartnerOption, EstimateProductOption } from '@/lib/estimates/types';
import type { ApprovalStatus, SalesEntryType } from '@/lib/sales/types';

export type SubscriptionOutputType = '印刷' | 'メール' | 'PDF';

export const SUBSCRIPTION_OUTPUT_TYPES: readonly SubscriptionOutputType[] = [
  '印刷',
  'メール',
  'PDF',
];

export interface SubscriptionContractInput {
  partnerId: string;
  entryType: SalesEntryType;
  subscSeqNo?: number | null;
  productId: string | null;
  itemName: string;
  monthLabel: string | null;
  unitName: string | null;
  quantity: number;
  masterUnitPrice: number | null;
  appliedUnitPrice: number;
  taxCode: TaxCode;
  roundingMode: RoundingMode;
  outputType: SubscriptionOutputType;
  isActive: boolean;
}

export interface SubscriptionContractDto {
  id: string;
  partnerId: string;
  partnerCode: string;
  partnerName: string;
  entryType: SalesEntryType;
  subscSeqNo: number;
  productId: string | null;
  productCode: string | null;
  itemName: string;
  monthLabel: string | null;
  unitName: string | null;
  quantity: number;
  masterUnitPrice: number | null;
  appliedUnitPrice: number;
  taxCode: TaxCode;
  roundingMode: RoundingMode;
  lineAmount: number;
  lineTax: number;
  exclAmount: number;
  rowTotal: number;
  outputType: SubscriptionOutputType;
  isActive: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface SubscriptionPartnerMonthlySummary {
  partnerId: string;
  partnerCode: string;
  partnerName: string;
  activeCount: number;
  salesInclTotal: number;
  advanceInclTotal: number;
  combinedInclTotal: number;
}

export interface SubscriptionListResultDto {
  items: SubscriptionContractDto[];
  partnerSummaries: SubscriptionPartnerMonthlySummary[];
  totals: {
    totalContracts: number;
    activeContracts: number;
    activeSalesInclTotal: number;
    activeAdvanceInclTotal: number;
    activeCombinedInclTotal: number;
  };
}

export interface SubscriptionMonthlyApprovalItemDto {
  partnerId: string;
  partnerCode: string;
  partnerName: string;
  entryType: SalesEntryType;
  targetMonth: string;
  activeContractCount: number;
  subtotalExcl: number;
  taxTotal: number;
  totalIncl: number;
  flowStatus: ApprovalStatus;
  remarks: string | null;
  updatedByName: string | null;
  updatedAt: string | null;
  isAlreadyBilled: boolean;
}

export interface SubscriptionMonthlyApprovalResultDto {
  targetMonth: string;
  items: SubscriptionMonthlyApprovalItemDto[];
  totals: {
    targetCount: number;
    approvedCount: number;
    pendingCount: number;
    rejectedCount: number;
    totalInclAmount: number;
  };
}

export interface SubscriptionLookupsDto {
  approvalFlowEnabled: boolean;
  openingBalanceDate: string;
  defaultRoundingMode: RoundingMode;
  taxCalcPolicy: TaxCalcPolicy;
  quotationTemplateRows: '10_ROWS' | '20_ROWS';
  partners: EstimatePartnerOption[];
  products: EstimateProductOption[];
  units: Array<{ id: string; unitCode: string; unitName: string }>;
  taxCodes: Array<{
    taxCode: TaxCode;
    taxName: string;
    taxRate: number;
    markSymbol: string;
    isInternal: boolean;
  }>;
}

export interface SubscriptionBillingHistoryItemDto {
  id: string;
  partnerId: string;
  partnerCode: string;
  partnerName: string;
  entryType: SalesEntryType;
  targetMonth: string;
  billingId: string | null;
  billingNo: number | null;
  billingDate: string;
  billedAmount: number;
  outputType: string;
  resultMessage: string;
  latestSnapshotId: string | null;
  createdAt: string;
}

export interface ExecuteSubscriptionBillingInput {
  targetMonth: string;
  billingDate: string;
  paymentDueDate?: string | null;
  templateVariant?: '10_ROWS' | '20_ROWS';
  targets?: Array<{ partnerId: string; entryType: SalesEntryType }>;
}

export interface ExecuteSubscriptionBillingResultDto {
  targetMonth: string;
  executedCount: number;
  items: SubscriptionBillingHistoryItemDto[];
}
