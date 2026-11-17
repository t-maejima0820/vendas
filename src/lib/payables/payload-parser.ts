import { MasterDataError } from '@/lib/masters/error-mapper';
import type { PayableBalanceFilter, SupplierPaymentInput } from '@/lib/payables/types';

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

export function parseSupplierPaymentInputBody(raw: Record<string, unknown>): SupplierPaymentInput {
  const paymentDate = asReqStr(raw.paymentDate);
  if (paymentDate === '') {
    throw new MasterDataError(400, 'PAYMENT_DATE_REQUIRED', '支払日を指定してください。');
  }
  const supplierId = asReqStr(raw.supplierId);
  if (supplierId === '') {
    throw new MasterDataError(400, 'SUPPLIER_REQUIRED', '仕入先を指定してください。');
  }

  return {
    paymentDate,
    supplierId,
    methodCode1: asOptStr(raw.methodCode1),
    amount1: asIntYenDefaultZero(raw.amount1, '支払額1'),
    methodCode2: asOptStr(raw.methodCode2),
    amount2: asIntYenDefaultZero(raw.amount2, '支払額2'),
    methodCode3: asOptStr(raw.methodCode3),
    amount3: asIntYenDefaultZero(raw.amount3, '支払額3'),
    deductionCode1: asOptStr(raw.deductionCode1),
    deductionAmt1: asIntYenDefaultZero(raw.deductionAmt1, '控除額1'),
    deductionCode2: asOptStr(raw.deductionCode2),
    deductionAmt2: asIntYenDefaultZero(raw.deductionAmt2, '控除額2'),
    deductionCode3: asOptStr(raw.deductionCode3),
    deductionAmt3: asIntYenDefaultZero(raw.deductionAmt3, '控除額3'),
    subtotal10Excl: asIntYenDefaultZero(raw.subtotal10Excl, '10%対象税抜額'),
    subtotal8Excl: asIntYenDefaultZero(raw.subtotal8Excl, '8%対象税抜額'),
    subtotal0: asIntYenDefaultZero(raw.subtotal0, '非課税対象額'),
    summaryNote: asOptStr(raw.summaryNote),
    billNo: asOptStr(raw.billNo),
    billDueDate: asOptStr(raw.billDueDate),
    remarks: asOptStr(raw.remarks),
  };
}

export function parsePayableBalanceFilterFromUrl(url: URL): PayableBalanceFilter {
  return {
    periodStart: url.searchParams.get('periodStart'),
    periodEnd: url.searchParams.get('periodEnd'),
    closingDayCode: url.searchParams.get('closingDayCode'),
    supplierId: url.searchParams.get('supplierId'),
    keyword: url.searchParams.get('q'),
    onlyWithBalance: url.searchParams.get('onlyWithBalance') === '1',
  };
}
