import type { ReceivableStatus } from '@/lib/billing/types';
import type { EstimatePartnerOption, EstimateProjectOption, SnapshotHistoryItemDto } from '@/lib/estimates/types';

export interface ReceivableBalanceFilter {
  periodStart?: string | null;
  periodEnd?: string | null;
  closingDayCode?: string | null;
  partnerId?: string | null;
  keyword?: string | null;
  onlyWithBalance?: boolean;
}

export interface ReceivableBalanceItemDto {
  partnerId: string;
  partnerCode: string;
  partnerName: string;
  closingDayCode: string | null;
  closingDayName: string | null;
  openingArBalance: number;
  prevCarriedBalance: number;
  periodBillingExcl: number;
  periodBillingTax: number;
  periodBillingIncl: number;
  periodReceiptAmount: number;
  periodNetDelta: number;
  closingArBalance: number;
}

export interface ReceivableBalanceListResultDto {
  openingBalanceDate: string;
  periodStart: string;
  periodEnd: string;
  items: ReceivableBalanceItemDto[];
  totals: {
    partnerCount: number;
    prevCarriedBalance: number;
    periodBillingExcl: number;
    periodBillingTax: number;
    periodBillingIncl: number;
    periodReceiptAmount: number;
    periodNetDelta: number;
    closingArBalance: number;
  };
}

export interface CashReceiptInput {
  receiptDate: string;
  partnerId: string;
  projectId: string | null;
  methodCode1: string | null;
  deposit1: number;
  methodCode2: string | null;
  deposit2: number;
  methodCode3: string | null;
  deposit3: number;
  subtotal10Excl: number;
  subtotal8Excl: number;
  subtotal0: number;
  tadashi: string | null;
  billNo: string | null;
  billDueDate: string | null;
  remarks: string | null;
}

export interface CashReceiptDto {
  id: string;
  receiptNo: number;
  receiptDate: string;
  partnerId: string;
  partnerCode: string;
  partnerName: string;
  projectId: string | null;
  projectNo: number | null;
  projectName: string | null;
  methodCode1: string | null;
  methodName1: string | null;
  deposit1: number;
  methodCode2: string | null;
  methodName2: string | null;
  deposit2: number;
  methodCode3: string | null;
  methodName3: string | null;
  deposit3: number;
  totalDeposit: number;
  subtotal10Excl: number;
  subtotal8Excl: number;
  subtotal0: number;
  tadashi: string | null;
  billNo: string | null;
  billDueDate: string | null;
  remarks: string | null;
  sourceKind: 'MANUAL' | 'APLUS';
  snapshotCount: number;
  latestSnapshotId: string | null;
  latestSnapshotVersion: number | null;
  createdAt: string;
  updatedAt: string;
}

export interface CashReceiptDetailDto extends CashReceiptDto {
  snapshots: SnapshotHistoryItemDto[];
}

export interface CashReceiptListFilter {
  keyword?: string | null;
  partnerId?: string | null;
  sourceKind?: 'ALL' | 'MANUAL' | 'APLUS';
  dateFrom?: string | null;
  dateTo?: string | null;
  billNo?: string | null;
  page?: number;
  pageSize?: number;
}

export interface CashReceiptPageDto {
  items: CashReceiptDto[];
  summary: {
    totalCount: number;
    sumDepositTotal: number;
    manualCount: number;
    aplusCount: number;
  };
  page: number;
  pageSize: number;
}

export interface UnpaidBillingItemDto {
  id: string;
  billingNo: number;
  partnerId: string;
  partnerCode: string;
  partnerName: string;
  billingDate: string;
  paymentDueDate: string | null;
  isSubscriptionBill: boolean;
  billingAmount: number;
  settledAmount: number;
  unpaidBalance: number;
  receiptCount: number;
  receivedAt: string | null;
  status: ReceivableStatus;
}

export interface ReceivablesLookupsDto {
  openingBalanceDate: string;
  defaultArListDateMode: number;
  receivableEnabled: boolean;
  depositEnabled: boolean;
  aplusEnabled: boolean;
  partners: EstimatePartnerOption[];
  projects: EstimateProjectOption[];
  paymentMethods: Array<{ methodCode: string; methodName: string }>;
  closingDays: Array<{ code: string; name: string }>;
}
