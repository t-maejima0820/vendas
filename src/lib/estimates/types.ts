import type {
  CostCategory,
  CostTaxMode,
  RoundingMode,
  TaxCalcPolicy,
  TaxCode,
} from '@/lib/domain/calculations';
import type { DocumentSnapshotPayload, DocumentType } from '@/lib/domain/snapshots';

export type QuotationStatus = 'Q1' | 'Q2' | 'Q3';
export type QuotationTemplateVariant = '10_ROWS' | '20_ROWS';

export function computePageCount(totalCount: number, pageSize: number): number {
  if (totalCount <= 0 || pageSize <= 0) {
    return 1;
  }
  const rem = totalCount % pageSize;
  const full = (totalCount - rem) / pageSize;
  return rem > 0 ? full + 1 : full;
}

export const QUOTATION_STATUS_LABELS: Readonly<Record<QuotationStatus, string>> = {
  Q1: '見積済',
  Q2: '注文確定',
  Q3: '－',
};

export const COST_CATEGORY_LABELS: Readonly<Record<CostCategory, string>> = {
  EXPENSE: '経費',
  LABOR: '労務費',
  MATERIAL: '材料費',
  OUTSOURCING: '外注費',
  TEMPORARY: '仮設費',
  INDIRECT: '諸経費',
};

export interface QuotationLineInput {
  productId: string | null;
  itemCode: string | null;
  itemName: string;
  unitName: string | null;
  isHeading: boolean;
  quantity: number;
  taxCode: TaxCode;
  costCategory: CostCategory | null;
  masterUnitPrice: number | null;
  appliedUnitPrice: number;
  masterCostPrice: number | null;
  appliedCostPrice: number;
  remarks: string | null;
}

export interface QuotationLineDto extends QuotationLineInput {
  id: string;
  lineNo: number;
  lineAmount: number;
  lineTax: number;
  lineTotal: number;
  costAmount: number;
  costTax: number;
  costTotal: number;
}

export interface QuotationInput {
  quotationName: string;
  quotationDate: string;
  partnerId: string;
  projectId: string | null;
  honorific: string;
  validityPeriod: string | null;
  deliveryDate: string | null;
  status: QuotationStatus;
  isAdvanceType: boolean;
  isSelected: boolean;
  roundingMode: RoundingMode;
  taxCalcPolicy?: TaxCalcPolicy;
  remarks: string | null;
  lines: QuotationLineInput[];
}

export interface QuotationListItemDto {
  id: string;
  quotationNo: number;
  quotationName: string;
  quotationDate: string;
  partnerId: string;
  partnerCode: string;
  partnerName: string;
  projectId: string | null;
  projectNo: number | null;
  projectName: string | null;
  honorific: string;
  status: QuotationStatus;
  isAdvanceType: boolean;
  isSelected: boolean;
  roundingMode: RoundingMode;
  taxCalcPolicy: TaxCalcPolicy;
  subtotalAmount: number;
  taxTotal: number;
  totalAmount: number;
  costSubtotal: number;
  grossProfitExcl: number;
  lineCount: number;
  snapshotCount: number;
  latestSnapshotVersion: number | null;
  attachmentCount: number;
  updatedAt: string;
}

export interface QuotationListSummaryDto {
  totalCount: number;
  subtotalAmount: number;
  taxTotal: number;
  totalAmount: number;
  costSubtotal: number;
  grossProfitExcl: number;
}

export interface QuotationPageDto {
  items: QuotationListItemDto[];
  summary: QuotationListSummaryDto;
  page: number;
  pageSize: number;
}

export interface SnapshotHistoryItemDto {
  id: string;
  documentType: DocumentType;
  sourceEntityType: 'QUOTATION' | 'PURCHASE_ORDER' | 'SALES_HEADER' | 'BILLING_HEADER' | 'CASH_RECEIPT';
  sourceEntityId: string;
  documentNo: string;
  versionNo: number;
  isReissue: boolean;
  reissueLabel: string | null;
  templateVariant: string;
  issuedAt: string;
  issuedBy: string | null;
  issuedByName: string | null;
  payloadSha256: string;
}

export interface SnapshotDetailDto extends SnapshotHistoryItemDto {
  payloadJson: DocumentSnapshotPayload;
}

export interface AttachmentDto {
  id: string;
  entityType: 'PROJECT' | 'QUOTATION';
  entityId: string;
  sortOrder: number;
  storageKey: string;
  originalName: string;
  mimeType: string;
  fileSize: number;
  comment: string | null;
  uploadedBy: string | null;
  createdAt: string;
  signedUrl: string;
}

export interface QuotationDetailDto {
  id: string;
  quotationNo: number;
  quotationName: string;
  quotationDate: string;
  partnerId: string;
  partnerCode: string;
  partnerName: string;
  projectId: string | null;
  projectNo: number | null;
  projectName: string | null;
  honorific: string;
  validityPeriod: string | null;
  deliveryDate: string | null;
  status: QuotationStatus;
  isAdvanceType: boolean;
  isSelected: boolean;
  roundingMode: RoundingMode;
  taxCalcPolicy: TaxCalcPolicy;
  subtotalAmount: number;
  taxTotal: number;
  totalAmount: number;
  costSubtotal: number;
  costTaxTotal: number;
  costTotal: number;
  grossProfitExcl: number;
  grossMarginExclPercent: string;
  remarks: string | null;
  createdAt: string;
  updatedAt: string;
  lines: QuotationLineDto[];
  snapshots: SnapshotHistoryItemDto[];
  attachments: AttachmentDto[];
}

export interface EstimatePartnerOption {
  id: string;
  partnerCode: string;
  partnerName: string;
  isIndividualHonorific: boolean;
  representativeName: string | null;
  isClient: boolean;
}

export interface EstimateProjectOption {
  id: string;
  projectNo: number;
  projectName: string;
  partnerId: string;
  status: string;
}

export interface EstimateProductOption {
  id: string;
  productCode: string;
  productName: string;
  productNameSub: string | null;
  unitName: string | null;
  standardUnitPrice: number;
  standardCostPrice: number;
  defaultTaxCode: TaxCode;
  isHeading: boolean;
}

export interface EstimateIntelligenceOption {
  id: string;
  itemName: string;
  unitName: string | null;
  unitPrice: number;
  costPrice: number;
  taxCode: TaxCode;
}

export interface EstimateEditorLookupsDto {
  taxCalcPolicy: TaxCalcPolicy;
  defaultRoundingMode: RoundingMode;
  costTaxMode: CostTaxMode;
  quotationTemplateRows: 10 | 20;
  estimateImageEnabled: boolean;
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
