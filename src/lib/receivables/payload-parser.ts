import { MasterDataError } from '@/lib/masters/error-mapper';
import type { CashReceiptInput, ReceivableBalanceFilter } from '@/lib/receivables/types';

function asOptStr(val: unknown): string | null {
  return typeof val === 'string' && val.trim() !== '' ? val.trim() : null;
}

function asReqStr(val: unknown): string {
  return typeof val === 'string' ? val.trim() : '';
}

function asIntYenDefaultZero(val: unknown, label: string): number {
  if (val === undefined || val === null || val === '') {
    return 0;
  }
  const num = typeof val === 'number' ? val : Number(String(val).trim());
  if (!Number.isFinite(num) || !Number.isInteger(num) || num < 0) {
    throw new MasterDataError(400, 'INVALID_AMOUNT', `${label}は0以上の整数で指定してください。`);
  }
  return num;
}

export function parseCashReceiptInputBody(raw: Record<string, unknown>): CashReceiptInput {
  const receiptDate = asReqStr(raw.receiptDate);
  if (receiptDate === '') {
    throw new MasterDataError(400, 'RECEIPT_DATE_REQUIRED', '入金日を指定してください。');
  }
  const partnerId = asReqStr(raw.partnerId);
  if (partnerId === '') {
    throw new MasterDataError(400, 'PARTNER_REQUIRED', '取引先を指定してください。');
  }

  return {
    receiptDate,
    partnerId,
    projectId: asOptStr(raw.projectId),
    methodCode1: asOptStr(raw.methodCode1),
    deposit1: asIntYenDefaultZero(raw.deposit1, '入金額1'),
    methodCode2: asOptStr(raw.methodCode2),
    deposit2: asIntYenDefaultZero(raw.deposit2, '入金額2'),
    methodCode3: asOptStr(raw.methodCode3),
    deposit3: asIntYenDefaultZero(raw.deposit3, '入金額3'),
    subtotal10Excl: asIntYenDefaultZero(raw.subtotal10Excl, '10%対象税抜額'),
    subtotal8Excl: asIntYenDefaultZero(raw.subtotal8Excl, '8%対象税抜額'),
    subtotal0: asIntYenDefaultZero(raw.subtotal0, '非課税対象額'),
    tadashi: asOptStr(raw.tadashi),
    billNo: asOptStr(raw.billNo),
    billDueDate: asOptStr(raw.billDueDate),
    remarks: asOptStr(raw.remarks),
  };
}

export function parseReceivableBalanceFilterFromUrl(url: URL): ReceivableBalanceFilter {
  return {
    periodStart: url.searchParams.get('periodStart'),
    periodEnd: url.searchParams.get('periodEnd'),
    closingDayCode: url.searchParams.get('closingDayCode'),
    partnerId: url.searchParams.get('partnerId'),
    keyword: url.searchParams.get('q'),
    onlyWithBalance: url.searchParams.get('onlyWithBalance') === '1',
  };
}
