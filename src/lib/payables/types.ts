import type { EstimatePartnerOption, EstimateProjectOption } from '@/lib/estimates/types';
import type { PayableStatus } from '@/lib/purchasing/types';

export interface PayableBalanceFilter {
  periodStart?: string | null;
  periodEnd?: string | null;
  closingDayCode?: string | null;
  supplierId?: string | null;
  keyword?: string | null;
  onlyWithBalance?: boolean;
}

export interface PayableBalanceItemDto {
  supplierId: string;
  partnerCode: string;
  partnerName: string;
  closingDayCode: string | null;
  closingDayName: string | null;
  openingApBalance: number;
  prevCarriedBalance: number;
  periodPayableExcl: number;
  periodPayableTax: number;
  periodPayableIncl: number;
  periodPaymentAmount: number;
  periodNetDelta: number;
  closingApBalance: number;
}

export interface PayableBalanceListResultDto {
  openingBalanceDate: string;
  periodStart: string;
  periodEnd: string;
  items: PayableBalanceItemDto[];
  totals: {
    supplierCount: number;
    prevCarriedBalance: number;
    periodPayableExcl: number;
    periodPayableTax: number;
    periodPayableIncl: number;
    periodPaymentAmount: number;
    periodNetDelta: number;
    closingApBalance: number;
  };
}

export interface PayableLedgerItemDto {
  id: string;
  supplierId: string;
  supplierCode: string;
  supplierName: string;
  purchaseId: string;
  purchaseNo: number;
  purchaseName: string;
  purchaseDate: string;
  payableAmount: number;
  amount10Excl: number;
  amount8Excl: number;
  amount0NonTax: number;
  taxTotal: number;
  paidAmount: number;
  remainingAmount: number;
  status: PayableStatus;
  scheduledPayAt: string | null;
  orderedAt: string | null;
  projectIds: string[];
  projectSummary: string | null;
}

export interface SupplierPaymentInput {
  paymentDate: string;
  supplierId: string;
  methodCode1: string | null;
  amount1: number;
  methodCode2: string | null;
  amount2: number;
  methodCode3: string | null;
  amount3: number;
  deductionCode1: string | null;
  deductionAmt1: number;
  deductionCode2: string | null;
  deductionAmt2: number;
  deductionCode3: string | null;
  deductionAmt3: number;
  subtotal10Excl: number;
  subtotal8Excl: number;
  subtotal0: number;
  summaryNote: string | null;
  billNo: string | null;
  billDueDate: string | null;
  remarks: string | null;
}

export interface SupplierPaymentDto {
  id: string;
  paymentNo: number;
  paymentDate: string;
  supplierId: string;
  supplierCode: string;
  supplierName: string;
  methodCode1: string | null;
  methodName1: string | null;
  amount1: number;
  methodCode2: string | null;
  methodName2: string | null;
  amount2: number;
  methodCode3: string | null;
  methodName3: string | null;
  amount3: number;
  deductionCode1: string | null;
  deductionName1: string | null;
  deductionAmt1: number;
  deductionCode2: string | null;
  deductionName2: string | null;
  deductionAmt2: number;
  deductionCode3: string | null;
  deductionName3: string | null;
  deductionAmt3: number;
  paymentSubtotal: number;
  deductionTotal: number;
  totalPayment: number;
  subtotal10Excl: number;
  subtotal8Excl: number;
  subtotal0: number;
  summaryNote: string | null;
  billNo: string | null;
  billDueDate: string | null;
  remarks: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface SupplierPaymentListFilter {
  keyword?: string | null;
  supplierId?: string | null;
  dateFrom?: string | null;
  dateTo?: string | null;
  billNo?: string | null;
  page?: number;
  pageSize?: number;
}

export interface SupplierPaymentPageDto {
  items: SupplierPaymentDto[];
  summary: {
    totalCount: number;
    sumPaymentSubtotal: number;
    sumDeductionTotal: number;
    sumTotalPayment: number;
  };
  page: number;
  pageSize: number;
}

export interface PayablesLookupsDto {
  openingBalanceDate: string;
  defaultArListDateMode: number;
  payableEnabled: boolean;
  paymentEnabled: boolean;
  purchaseEnabled: boolean;
  partners: Array<EstimatePartnerOption & { isSupplier: boolean }>;
  projects: EstimateProjectOption[];
  paymentMethods: Array<{ methodCode: string; methodName: string }>;
  closingDays: Array<{ code: string; name: string }>;
}
