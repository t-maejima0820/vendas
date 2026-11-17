import type { RoundingMode, TaxCalcPolicy, TaxCode } from '@/lib/domain/calculations';
import type {
  EstimateIntelligenceOption,
  EstimatePartnerOption,
  EstimateProductOption,
  EstimateProjectOption,
  SnapshotHistoryItemDto,
} from '@/lib/estimates/types';

export type SalesEntryType = 'SALE' | 'ADVANCE';
export type SalesStatus = 'K1' | 'K2' | 'K3' | 'K4' | 'K5' | 'K6';
export type ApprovalStatus = 0 | 1 | 2;

export const SALES_STATUS_LABELS: Readonly<Record<SalesStatus, string>> = {
  K1: '新規',
  K2: '請求待ち',
  K3: '集計済み',
  K4: '請求済み',
  K5: '再発行',
  K6: '売上修正',
};

export const APPROVAL_STATUS_LABELS: Readonly<Record<ApprovalStatus, string>> = {
  0: '未承認',
  1: '承認済',
  2: '差戻し',
};

export const ENTRY_TYPE_LABELS: Readonly<Record<SalesEntryType, string>> = {
  SALE: '売上',
  ADVANCE: '立替',
};

export interface SalesLineInput {
  productId: string | null;
  itemCode: string | null;
  itemName: string;
  unitName: string | null;
  targetMonthLabel: string | null;
  isHeading: boolean;
  quantity: number;
  masterUnitPrice: number | null;
  appliedUnitPrice: number;
  taxCode: TaxCode;
  remarks: string | null;
}

export interface SalesLineDto extends SalesLineInput {
  id: string;
  lineNo: number;
  lineAmount: number;
  lineTax: number;
  rowTotal: number;
}

export interface SalesInput {
  entryType: SalesEntryType;
  slipName: string;
  slipDate: string;
  partnerId: string;
  projectId: string | null;
  honorific: string;
  status: SalesStatus;
  salesKubun: string | null;
  roundingMode: RoundingMode;
  approvalRemarks: string | null;
  lines: SalesLineInput[];
}

export interface SalesListItemDto {
  id: string;
  entryType: SalesEntryType;
  slipNo: number;
  slipName: string;
  slipDate: string;
  partnerId: string;
  partnerCode: string;
  partnerName: string;
  projectId: string | null;
  projectNo: number | null;
  projectName: string | null;
  honorific: string;
  status: SalesStatus;
  approvalStatus: ApprovalStatus;
  approvalRemarks: string | null;
  salesKubun: string | null;
  roundingMode: RoundingMode;
  subtotalAmount: number;
  taxTotal: number;
  totalAmount: number;
  lineCount: number;
  deliveryNoteCount: number;
  latestDeliveryNoteVersion: number | null;
  deliveryReceiptCount: number;
  latestDeliveryReceiptVersion: number | null;
  updatedAt: string;
}

export interface SalesListSummaryDto {
  totalCount: number;
  subtotalAmount: number;
  taxTotal: number;
  totalAmount: number;
  approvedCount: number;
  pendingCount: number;
}

export interface SalesPageDto {
  items: SalesListItemDto[];
  summary: SalesListSummaryDto;
  page: number;
  pageSize: number;
}

export interface SalesDetailDto {
  id: string;
  entryType: SalesEntryType;
  slipNo: number;
  slipName: string;
  slipDate: string;
  partnerId: string;
  partnerCode: string;
  partnerName: string;
  projectId: string | null;
  projectNo: number | null;
  projectName: string | null;
  honorific: string;
  status: SalesStatus;
  approvalStatus: ApprovalStatus;
  approvalRemarks: string | null;
  salesKubun: string | null;
  billingId: string | null;
  billingDate: string | null;
  roundingMode: RoundingMode;
  taxCalcPolicy: TaxCalcPolicy;
  subtotalAmount: number;
  taxTotal: number;
  totalAmount: number;
  createdAt: string;
  updatedAt: string;
  lines: SalesLineDto[];
  deliveryNotes: SnapshotHistoryItemDto[];
  deliveryReceipts: SnapshotHistoryItemDto[];
}

export interface SalesProductSummaryItemDto {
  entryType: SalesEntryType;
  itemCode: string | null;
  itemName: string;
  unitName: string | null;
  taxCode: TaxCode;
  slipCount: number;
  totalQuantity: number;
  exclAmount: number;
  taxAmount: number;
  inclAmount: number;
}

export interface SalesProductSummaryResultDto {
  items: SalesProductSummaryItemDto[];
  totals: {
    rowCount: number;
    exclAmount: number;
    taxAmount: number;
    inclAmount: number;
  };
}

export interface SalesEditorLookupsDto {
  approvalFlowEnabled: boolean;
  taxCalcPolicy: TaxCalcPolicy;
  defaultRoundingMode: RoundingMode;
  quotationTemplateRows: 10 | 20;
  salesEnabled: boolean;
  tatekaeEnabled: boolean;
  customSumItemEnabled: boolean;
  estimateEnabled: boolean;
  partners: EstimatePartnerOption[];
  projects: EstimateProjectOption[];
  products: EstimateProductOption[];
  intelligences: EstimateIntelligenceOption[];
  units: Array<{ id: string; unitCode: string; unitName: string }>;
  taxCodes: Array<{
    taxCode: TaxCode;
    taxName: string;
    taxRate: number;
    markSymbol: string;
    isInternal: boolean;
  }>;
}
