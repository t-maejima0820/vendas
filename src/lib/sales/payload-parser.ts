import type { RoundingMode, TaxCode } from '@/lib/domain/calculations';
import { MasterDataError } from '@/lib/masters/error-mapper';
import type {
  SalesEntryType,
  SalesInput,
  SalesLineInput,
  SalesStatus,
} from '@/lib/sales/types';

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

export function parseSalesInputBody(raw: Record<string, unknown>): SalesInput {
  if (!Array.isArray(raw.lines)) {
    throw new MasterDataError(400, 'LINES_REQUIRED', '明細行配列 (lines) を指定してください。');
  }

  const lines: SalesLineInput[] = raw.lines.map((entry, idx) => {
    if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) {
      throw new MasterDataError(400, 'INVALID_LINE', `${idx + 1}行目の形式が不正です。`);
    }
    const obj = entry as Record<string, unknown>;
    const isHeading = obj.isHeading === true;
    const rawTax = asReqStr(obj.taxCode).trim();
    const taxCode = (rawTax !== '' ? rawTax : 'A') as TaxCode;

    return {
      productId: asOptStr(obj.productId),
      itemCode: asOptStr(obj.itemCode),
      itemName: asReqStr(obj.itemName),
      unitName: asOptStr(obj.unitName),
      targetMonthLabel: asOptStr(obj.targetMonthLabel),
      isHeading,
      quantity: isHeading ? 0 : asFiniteNumber(obj.quantity, `${idx + 1}行目の数量`),
      masterUnitPrice: asOptIntNumber(obj.masterUnitPrice, `${idx + 1}行目の基準単価`),
      appliedUnitPrice: isHeading
        ? 0
        : asFiniteNumber(obj.appliedUnitPrice, `${idx + 1}行目の適用単価`),
      taxCode,
      remarks: asOptStr(obj.remarks),
    };
  });

  const rawEntry = asReqStr(raw.entryType).trim();
  const entryType = (rawEntry !== '' ? rawEntry : 'SALE') as SalesEntryType;
  const rawStatus = asReqStr(raw.status).trim();
  const status = (rawStatus !== '' ? rawStatus : 'K1') as SalesStatus;
  const rawRounding = asReqStr(raw.roundingMode).trim();
  const roundingMode = (rawRounding !== '' ? rawRounding : 'FLOOR') as RoundingMode;

  return {
    entryType,
    slipName: asReqStr(raw.slipName),
    slipDate: asReqStr(raw.slipDate),
    partnerId: asReqStr(raw.partnerId),
    projectId: asOptStr(raw.projectId),
    honorific: asReqStr(raw.honorific),
    status,
    salesKubun: asOptStr(raw.salesKubun),
    roundingMode,
    approvalRemarks: asOptStr(raw.approvalRemarks),
    lines,
  };
}
