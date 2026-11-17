import type { RoundingMode, TaxCode } from '@/lib/domain/calculations';
import { MasterDataError } from '@/lib/masters/error-mapper';
import type { SalesEntryType } from '@/lib/sales/types';
import type {
  SubscriptionContractInput,
  SubscriptionOutputType,
} from '@/lib/subscriptions/types';

function asOptStr(val: unknown): string | null {
  return typeof val === 'string' && val.trim() !== '' ? val.trim() : null;
}

function asReqStr(val: unknown): string {
  return typeof val === 'string' ? val : '';
}

function asFiniteNumber(val: unknown, label: string): number {
  if (typeof val === 'number' && Number.isFinite(val)) {
    return val;
  }
  if (typeof val === 'string' && val.trim() !== '') {
    const parsed = Number(val.trim());
    if (Number.isFinite(parsed)) {
      return parsed;
    }
  }
  throw new MasterDataError(400, 'INVALID_NUMBER', `${label}は有効な数値で指定してください。`);
}

function asOptIntNumber(val: unknown, label: string): number | null {
  if (val === null || val === undefined || val === '') {
    return null;
  }
  return asFiniteNumber(val, label);
}

export function parseSubscriptionContractBody(
  raw: Record<string, unknown>,
): SubscriptionContractInput {
  const rawEntry = asReqStr(raw.entryType).trim();
  const entryType = (rawEntry !== '' ? rawEntry : 'SALE') as SalesEntryType;
  const rawTax = asReqStr(raw.taxCode).trim();
  const taxCode = (rawTax !== '' ? rawTax : 'A') as TaxCode;
  const rawRounding = asReqStr(raw.roundingMode).trim();
  const roundingMode = (rawRounding !== '' ? rawRounding : 'FLOOR') as RoundingMode;
  const rawOutput = asReqStr(raw.outputType).trim();
  const outputType = (rawOutput !== '' ? rawOutput : '印刷') as SubscriptionOutputType;

  return {
    partnerId: asReqStr(raw.partnerId),
    entryType,
    subscSeqNo: asOptIntNumber(raw.subscSeqNo, '契約連番'),
    productId: asOptStr(raw.productId),
    itemName: asReqStr(raw.itemName),
    monthLabel: asOptStr(raw.monthLabel),
    unitName: asOptStr(raw.unitName),
    quantity: asFiniteNumber(raw.quantity !== undefined ? raw.quantity : 1, '数量'),
    masterUnitPrice: asOptIntNumber(raw.masterUnitPrice, '基準単価'),
    appliedUnitPrice: asFiniteNumber(raw.appliedUnitPrice, '適用単価'),
    taxCode,
    roundingMode,
    outputType,
    isActive: raw.isActive === undefined ? true : Boolean(raw.isActive),
  };
}
