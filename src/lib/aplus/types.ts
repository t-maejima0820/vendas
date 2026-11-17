export interface AplusExportDto {
  id: string;
  partnerId: string;
  partnerCode: string;
  partnerName: string;
  consignorCode: string;
  customerNo: string;
  breakdownNo: string;
  transferDate: string;
  variableAmount: number;
  fixedSalesTotal: number;
  fixedAdvanceTotal: number;
  salesTotal: number;
  advanceTotal: number;
  uncollectedTotal: number;
  prevBilledAmount: number;
  totalTransferAmount: number;
  isExported: boolean;
  bankCode: string | null;
  branchCode: string | null;
  bankAccountType: string | null;
  hasBankAccountNo: boolean;
  createdAt: string;
}

export interface GenerateAplusExportsInput {
  transferDate: string;
  consignorCode: string;
  breakdownNo?: string;
  periodStart: string;
  periodEnd: string;
  replaceUnexported?: boolean;
}

export interface UpdateAplusExportInput {
  variableAmount?: number;
  uncollectedTotal?: number;
  consignorCode?: string;
  customerNo?: string;
  breakdownNo?: string;
}

export interface AplusImportDto {
  id: string;
  createdDate: string;
  transferDate: string;
  customerNo: string;
  contractorName: string | null;
  contractAmount: number;
  billedAmount: number;
  settledAmount: number;
  unpaidAmount: number;
  resultCode: string;
  resultReason: string | null;
  isSettledOk: boolean;
  createdAt: string;
}

export interface AplusImportRowInput {
  createdDate?: string;
  transferDate: string;
  customerNo: string;
  contractorName?: string | null;
  contractAmount?: number;
  billedAmount: number;
  settledAmount: number;
  unpaidAmount?: number;
  resultCode: string;
  resultReason?: string | null;
}

export interface ImportAplusResultsInput {
  rawText?: string;
  defaultTransferDate?: string;
  rows?: AplusImportRowInput[];
  autoCreateReceipts?: boolean;
}

export interface ImportAplusResultsOutput {
  importedCount: number;
  settledCount: number;
  failedCount: number;
  autoCreatedReceiptCount: number;
  items: AplusImportDto[];
}
