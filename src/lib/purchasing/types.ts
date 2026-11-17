import type {
  CostTaxMode,
  RoundingMode,
  TaxCalcPolicy,
  TaxCode,
} from '@/lib/domain/calculations';
import type {
  EstimateIntelligenceOption,
  EstimatePartnerOption,
  EstimateProductOption,
  EstimateProjectOption,
  QuotationTemplateVariant,
  SnapshotHistoryItemDto,
} from '@/lib/estimates/types';

export type OrderStatus = 'O1' | 'O2' | 'O3';
export type PurchaseStatus = 'P1' | 'P2' | 'P3';
export type PayableStatus = 'A1' | 'A2';

export const ORDER_STATUS_LABELS: Readonly<Record<OrderStatus, string>> = {
  O1: '新規',
  O2: '発注待ち',
  O3: '発注済',
};

export const PURCHASE_STATUS_LABELS: Readonly<Record<PurchaseStatus, string>> = {
  P1: '新規',
  P2: '仕入待ち',
  P3: '仕入済',
};

export const PAYABLE_STATUS_LABELS: Readonly<Record<PayableStatus, string>> = {
  A1: '未払',
  A2: '支払済',
};

export interface PurchasingPartnerOption extends EstimatePartnerOption {
  isSupplier: boolean;
  closingDayCode: string | null;
  collectionDayCode: string | null;
}

export interface PurchasingProjectOption extends EstimateProjectOption {
  sitePlace: string | null;
}

export interface PurchasingProductOption extends EstimateProductOption {
  standardPurchasePrice: number;
}

export interface PurchasingLookupsDto {
  openingBalanceDate: string;
  orderEnabled: boolean;
  purchaseEnabled: boolean;
  payableEnabled: boolean;
  paymentEnabled: boolean;
  taxCalcPolicy: TaxCalcPolicy;
  defaultRoundingMode: RoundingMode;
  costTaxMode: CostTaxMode;
  defaultTemplateVariant: QuotationTemplateVariant;
  partners: PurchasingPartnerOption[];
  projects: PurchasingProjectOption[];
  products: PurchasingProductOption[];
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

export interface PurchaseOrderLineInput {
  productId: string | null;
  itemCode: string | null;
  itemName: string;
  unitName: string | null;
  isHeading: boolean;
  quantity: number;
  taxCode: TaxCode;
  masterUnitPrice: number | null;
  appliedUnitPrice: number;
  remarks: string | null;
}

export interface PurchaseOrderLineDto extends PurchaseOrderLineInput {
  id: string;
  lineNo: number;
  lineAmount: number;
  lineTax: number;
  lineTotal: number;
}

export interface PurchaseOrderInput {
  orderName: string;
  orderDate: string;
  supplierId: string;
  projectId: string | null;
  honorific: string;
  deliveryDate: string | null;
  status: OrderStatus;
  roundingMode: RoundingMode;
  remarks: string | null;
  lines: PurchaseOrderLineInput[];
}

export interface PurchaseOrderListItemDto {
  id: string;
  orderNo: number;
  orderName: string;
  orderDate: string;
  supplierId: string;
  supplierCode: string;
  supplierName: string;
  projectId: string | null;
  projectNo: number | null;
  projectName: string | null;
  deliveryPlace: string | null;
  honorific: string;
  deliveryDate: string | null;
  status: OrderStatus;
  roundingMode: RoundingMode;
  subtotalAmount: number;
  taxTotal: number;
  totalAmount: number;
  lineCount: number;
  snapshotCount: number;
  latestSnapshotVersion: number | null;
  linkedPurchaseCount: number;
  updatedAt: string;
}

export interface PurchaseOrderListSummaryDto {
  totalCount: number;
  subtotalAmount: number;
  taxTotal: number;
  totalAmount: number;
}

export interface PurchaseOrderPageDto {
  items: PurchaseOrderListItemDto[];
  summary: PurchaseOrderListSummaryDto;
  page: number;
  pageSize: number;
}

export interface PurchaseOrderDetailDto {
  id: string;
  orderNo: number;
  orderName: string;
  orderDate: string;
  supplierId: string;
  supplierCode: string;
  supplierName: string;
  projectId: string | null;
  projectNo: number | null;
  projectName: string | null;
  deliveryPlace: string | null;
  honorific: string;
  deliveryDate: string | null;
  status: OrderStatus;
  roundingMode: RoundingMode;
  taxCalcPolicy: TaxCalcPolicy;
  subtotalAmount: number;
  taxTotal: number;
  totalAmount: number;
  remarks: string | null;
  linkedPurchaseCount: number;
  createdAt: string;
  updatedAt: string;
  lines: PurchaseOrderLineDto[];
  snapshots: SnapshotHistoryItemDto[];
}

export interface PurchaseLineInput {
  projectId: string | null;
  productId: string | null;
  itemCode: string | null;
  itemName: string;
  unitName: string | null;
  isHeading: boolean;
  quantity: number;
  taxCode: TaxCode;
  masterUnitPrice: number | null;
  appliedUnitPrice: number;
  remarks: string | null;
}

export interface PurchaseLineDto extends PurchaseLineInput {
  id: string;
  lineNo: number;
  projectNo: number | null;
  projectName: string | null;
  lineAmount: number;
  lineTax: number;
  lineTotal: number;
}

export interface PurchaseInput {
  purchaseName: string;
  purchaseDate: string;
  supplierId: string;
  purchaseOrderId: string | null;
  honorific: string;
  status: PurchaseStatus;
  roundingMode: RoundingMode;
  remarks: string | null;
  lines: PurchaseLineInput[];
}

export interface PurchaseListItemDto {
  id: string;
  purchaseNo: number;
  purchaseName: string;
  purchaseDate: string;
  supplierId: string;
  supplierCode: string;
  supplierName: string;
  purchaseOrderId: string | null;
  orderNo: number | null;
  honorific: string;
  status: PurchaseStatus;
  roundingMode: RoundingMode;
  subtotalAmount: number;
  taxTotal: number;
  totalAmount: number;
  payableLedgerId: string | null;
  payableStatus: PayableStatus | null;
  scheduledPayAt: string | null;
  lineCount: number;
  updatedAt: string;
}

export interface PurchaseListSummaryDto {
  totalCount: number;
  subtotalAmount: number;
  taxTotal: number;
  totalAmount: number;
}

export interface PurchasePageDto {
  items: PurchaseListItemDto[];
  summary: PurchaseListSummaryDto;
  page: number;
  pageSize: number;
}

export interface PurchaseDetailDto {
  id: string;
  purchaseNo: number;
  purchaseName: string;
  purchaseDate: string;
  supplierId: string;
  supplierCode: string;
  supplierName: string;
  purchaseOrderId: string | null;
  orderNo: number | null;
  honorific: string;
  status: PurchaseStatus;
  roundingMode: RoundingMode;
  taxCalcPolicy: TaxCalcPolicy;
  subtotalAmount: number;
  taxTotal: number;
  totalAmount: number;
  remarks: string | null;
  payableLedgerId: string | null;
  payableStatus: PayableStatus | null;
  scheduledPayAt: string | null;
  createdAt: string;
  updatedAt: string;
  lines: PurchaseLineDto[];
}
