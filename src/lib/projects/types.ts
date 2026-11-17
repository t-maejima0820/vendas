import type {
  CostCategory,
  CostTaxMode,
  RoundingMode,
  TaxCalcPolicy,
  TaxCode,
} from '@/lib/domain/calculations';
import type {
  AttachmentDto,
  EstimateIntelligenceOption,
  EstimatePartnerOption,
  EstimateProductOption,
} from '@/lib/estimates/types';

export type ProjectStatus = 'C1' | 'C2' | 'C3';

export const PROJECT_STATUS_LABELS: Readonly<Record<ProjectStatus, string>> = {
  C1: '新規(進行中)',
  C2: '仕掛中',
  C3: '完了済',
};

export const COST_CATEGORY_LIST: readonly CostCategory[] = [
  'EXPENSE',
  'LABOR',
  'MATERIAL',
  'OUTSOURCING',
  'TEMPORARY',
  'INDIRECT',
];

export type ProjectBudgetBreakdown = Record<CostCategory, number>;

export interface ProjectCategoryComparisonItemDto {
  category: CostCategory;
  categoryLabel: string;
  budgetAmount: number;
  actualExclAmount: number;
  actualInclAmount: number;
  actualEvalAmount: number;
  varianceAmount: number;
  consumptionRatePercent: string;
  isOverBudget: boolean;
}

export interface ProjectInput {
  projectNo?: number | null;
  projectName: string;
  projectDate: string;
  sitePlace: string | null;
  partnerId: string;
  orderKindCode: string | null;
  subStatusCode: string | null;
  status: ProjectStatus;
  periodStartDate: string | null;
  periodEndDate: string | null;
  actualStartDate: string | null;
  tempFinishDate: string | null;
  finishDate: string | null;
  salesEmployeeId: string | null;
  siteEmployeeId: string | null;
  unitName: string;
  contractUnitPrice: number;
  contractQuantity: number;
  taxCode: TaxCode;
  roundingMode: RoundingMode;
  budgets: ProjectBudgetBreakdown;
  remarks: string | null;
}

export interface ProjectListItemDto {
  id: string;
  projectNo: number;
  projectName: string;
  projectDate: string;
  sitePlace: string | null;
  partnerId: string;
  partnerCode: string;
  partnerName: string;
  orderKindCode: string | null;
  orderKindName: string | null;
  subStatusCode: string | null;
  subStatusName: string | null;
  status: ProjectStatus;
  salesEmployeeId: string | null;
  salesEmployeeName: string | null;
  siteEmployeeId: string | null;
  siteEmployeeName: string | null;
  periodStartDate: string | null;
  periodEndDate: string | null;
  contractSubtotal: number;
  contractTax: number;
  contractTotal: number;
  budgetTotal: number;
  actualCostExclTotal: number;
  actualCostInclTotal: number;
  actualCostEvalTotal: number;
  salesRecordedExcl: number;
  salesRecordedIncl: number;
  budgetGrossProfit: number;
  actualGrossProfit: number;
  actualGrossMarginPercent: string;
  budgetVarianceTotal: number;
  isOverBudget: boolean;
  costHeaderCount: number;
  updatedAt: string;
}

export interface ProjectListSummaryDto {
  totalCount: number;
  contractSubtotal: number;
  contractTotal: number;
  budgetTotal: number;
  actualCostExclTotal: number;
  actualCostInclTotal: number;
  actualCostEvalTotal: number;
  salesRecordedIncl: number;
  budgetGrossProfit: number;
  actualGrossProfit: number;
  overBudgetCount: number;
}

export interface ProjectPageDto {
  items: ProjectListItemDto[];
  summary: ProjectListSummaryDto;
  costTaxMode: CostTaxMode;
  page: number;
  pageSize: number;
}

export interface ProjectRelatedQuotationDto {
  id: string;
  quotationNo: number;
  quotationName: string;
  quotationDate: string;
  status: string;
  isSelected: boolean;
  subtotalAmount: number;
  totalAmount: number;
  costSubtotal: number;
  costTotal: number;
}

export interface ProjectRelatedSaleDto {
  id: string;
  entryType: 'SALE' | 'ADVANCE';
  slipNo: number;
  slipName: string;
  slipDate: string;
  status: string;
  subtotalAmount: number;
  totalAmount: number;
}

export interface ProjectRelatedOrderDto {
  id: string;
  orderNo: number;
  orderName: string;
  orderDate: string;
  supplierName: string;
  status: string;
  totalAmount: number;
}

export interface ProjectRelatedPurchaseDto {
  id: string;
  purchaseNo: number;
  purchaseName: string;
  purchaseDate: string;
  supplierName: string;
  status: string;
  projectLineSubtotal: number;
  projectLineTotal: number;
}

export interface ProjectCostHeaderRefDto {
  id: string;
  costCategory: CostCategory;
  categoryLabel: string;
  slipTitle: string;
  entryDate: string;
  status: ProjectStatus;
  subtotalAmount: number;
  taxTotal: number;
  totalAmount: number;
  lineCount: number;
}

export interface ProjectCostDetailLineDto {
  costHeaderId: string;
  entryDate: string;
  costCategory: CostCategory;
  categoryLabel: string;
  slipTitle: string;
  lineNo: number;
  itemCode: string | null;
  itemName: string;
  unitName: string | null;
  quantity: number;
  taxCode: TaxCode;
  appliedUnitPrice: number;
  lineAmount: number;
  lineTax: number;
  lineTotal: number;
  remarks: string | null;
}

export interface ProjectDetailDto {
  id: string;
  projectNo: number;
  projectName: string;
  projectDate: string;
  sitePlace: string | null;
  partnerId: string;
  partnerCode: string;
  partnerName: string;
  partnerNameSnap: string;
  orderKindCode: string | null;
  orderKindName: string | null;
  subStatusCode: string | null;
  subStatusName: string | null;
  status: ProjectStatus;
  periodStartDate: string | null;
  periodEndDate: string | null;
  actualStartDate: string | null;
  tempFinishDate: string | null;
  finishDate: string | null;
  salesEmployeeId: string | null;
  salesEmployeeName: string | null;
  siteEmployeeId: string | null;
  siteEmployeeName: string | null;
  unitName: string;
  contractUnitPrice: number;
  contractQuantity: number;
  contractSubtotal: number;
  contractTax: number;
  contractTotal: number;
  taxCode: TaxCode;
  roundingMode: RoundingMode;
  costTaxMode: CostTaxMode;
  budgets: ProjectBudgetBreakdown;
  budgetTotal: number;
  actualCostExclTotal: number;
  actualCostInclTotal: number;
  actualCostEvalTotal: number;
  salesRecordedExcl: number;
  salesRecordedIncl: number;
  advanceRecordedIncl: number;
  budgetVarianceTotal: number;
  budgetConsumptionRatePercent: string;
  isOverBudget: boolean;
  budgetGrossProfit: number;
  actualGrossProfit: number;
  actualGrossMarginPercent: string;
  salesBasedGrossProfit: number;
  salesBasedGrossMarginPercent: string;
  sourceQuotationNo: number | null;
  billNo: number | null;
  billDate: string | null;
  remarks: string | null;
  createdAt: string;
  updatedAt: string;
  categoryComparisons: ProjectCategoryComparisonItemDto[];
  costHeaders: ProjectCostHeaderRefDto[];
  costLines: ProjectCostDetailLineDto[];
  relatedQuotations: ProjectRelatedQuotationDto[];
  relatedSales: ProjectRelatedSaleDto[];
  relatedOrders: ProjectRelatedOrderDto[];
  relatedPurchases: ProjectRelatedPurchaseDto[];
  attachments: AttachmentDto[];
}

export interface ProjectsLookupsDto {
  openingBalanceDate: string;
  costTaxMode: CostTaxMode;
  taxCalcPolicy: TaxCalcPolicy;
  defaultRoundingMode: RoundingMode;
  constructionEnabled: boolean;
  constructionImageEnabled: boolean;
  budgetEnabled: boolean;
  costEnabled: boolean;
  purchaseEnabled: boolean;
  categoryFlags: Record<CostCategory, boolean>;
  partners: EstimatePartnerOption[];
  employees: Array<{ id: string; syainCode: string; syainName: string }>;
  orderKinds: Array<{ code: string; name: string }>;
  subStatuses: Array<{ code: string; name: string }>;
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
