import type {
  CostCategory,
  CostTaxMode,
  RoundingMode,
  TaxCalcPolicy,
  TaxCode,
} from '@/lib/domain/calculations';
import type { ProjectStatus } from '@/lib/projects/types';

export interface ProjectCostLineInput {
  productId: string | null;
  itemCode: string | null;
  itemName: string;
  unitName: string | null;
  isHeading?: boolean;
  quantity: number;
  taxCode: TaxCode;
  masterUnitPrice: number | null;
  appliedUnitPrice: number;
  appliedCostPrice?: number | null;
  sourcePurchaseLineId?: string | null;
  remarks: string | null;
}

export interface ProjectCostLineDto {
  id: string;
  lineNo: number;
  productId: string | null;
  itemCode: string | null;
  itemName: string;
  unitName: string | null;
  quantity: number;
  taxCode: TaxCode;
  masterUnitPrice: number | null;
  appliedUnitPrice: number;
  lineAmount: number;
  lineTax: number;
  lineTotal: number;
  appliedCostPrice: number;
  costAmount: number;
  costTax: number;
  costTotal: number;
  sourcePurchaseLineId: string | null;
  remarks: string | null;
}

export interface ProjectCostInput {
  projectId: string;
  costCategory: CostCategory;
  slipTitle: string;
  entryDate: string;
  status: ProjectStatus;
  roundingMode: RoundingMode;
  lines: ProjectCostLineInput[];
}

export interface ProjectCostListItemDto {
  id: string;
  projectId: string;
  projectNo: number;
  projectName: string;
  partnerName: string;
  costCategory: CostCategory;
  categoryLabel: string;
  slipTitle: string;
  entryDate: string;
  status: ProjectStatus;
  roundingMode: RoundingMode;
  subtotalAmount: number;
  taxTotal: number;
  totalAmount: number;
  costSubtotal: number;
  costTotal: number;
  lineCount: number;
  hasPurchaseLink: boolean;
  updatedAt: string;
}

export interface ProjectCostCategorySummaryDto {
  category: CostCategory;
  categoryLabel: string;
  headerCount: number;
  subtotalAmount: number;
  totalAmount: number;
}

export interface ProjectCostListSummaryDto {
  totalCount: number;
  subtotalAmount: number;
  taxTotal: number;
  totalAmount: number;
  byCategory: ProjectCostCategorySummaryDto[];
}

export interface ProjectCostPageDto {
  items: ProjectCostListItemDto[];
  summary: ProjectCostListSummaryDto;
  costTaxMode: CostTaxMode;
  page: number;
  pageSize: number;
}

export interface ProjectCostDetailDto {
  id: string;
  projectId: string;
  projectNo: number;
  projectName: string;
  partnerName: string;
  costCategory: CostCategory;
  categoryLabel: string;
  slipTitle: string;
  entryDate: string;
  status: ProjectStatus;
  roundingMode: RoundingMode;
  taxCalcPolicy: TaxCalcPolicy;
  subtotalAmount: number;
  taxTotal: number;
  totalAmount: number;
  costSubtotal: number;
  costTaxTotal: number;
  costTotal: number;
  createdAt: string;
  updatedAt: string;
  lines: ProjectCostLineDto[];
}

export interface ImportCostFromPurchaseInput {
  projectId: string;
  purchaseId: string;
  costCategory: CostCategory;
  slipTitle?: string | null;
  entryDate?: string | null;
  status?: ProjectStatus;
}

export interface CandidatePurchaseForCostDto {
  purchaseId: string;
  purchaseNo: number;
  purchaseName: string;
  purchaseDate: string;
  supplierName: string;
  status: string;
  totalAmount: number;
  matchingLineCount: number;
  alreadyImportedLineCount: number;
  isFullyImported: boolean;
  isProjectLinked: boolean;
}
