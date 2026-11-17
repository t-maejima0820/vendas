import type { CostCategory, RoundingMode, TaxCalcPolicy, TaxCode } from '@/lib/domain/calculations';
import type { QuotationInput, QuotationLineInput, QuotationStatus } from '@/lib/estimates/types';
import { MasterDataError } from '@/lib/masters/error-mapper';

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

export function parseQuotationInputBody(raw: Record<string, unknown>): QuotationInput {
  if (!Array.isArray(raw.lines)) {
    throw new MasterDataError(400, 'LINES_REQUIRED', '明細行配列 (lines) を指定してください。');
  }

  const lines: QuotationLineInput[] = raw.lines.map((entry, idx) => {
    if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) {
      throw new MasterDataError(400, 'INVALID_LINE', `${idx + 1}行目の形式が不正です。`);
    }
    const obj = entry as Record<string, unknown>;
    const isHeading = obj.isHeading === true;
    const rawTax = asReqStr(obj.taxCode).trim();
    const taxCode = (rawTax !== '' ? rawTax : 'A') as TaxCode;
    const rawCostCat = asOptStr(obj.costCategory);
    const costCategory = rawCostCat !== null ? (rawCostCat as CostCategory) : null;

    return {
      productId: asOptStr(obj.productId),
      itemCode: asOptStr(obj.itemCode),
      itemName: asReqStr(obj.itemName),
      unitName: asOptStr(obj.unitName),
      isHeading,
      quantity: isHeading ? 1 : asFiniteNumber(obj.quantity, `${idx + 1}行目の数量`),
      taxCode,
      costCategory,
      masterUnitPrice: asOptIntNumber(obj.masterUnitPrice, `${idx + 1}行目の基準売価単価`),
      appliedUnitPrice: isHeading
        ? 0
        : asFiniteNumber(obj.appliedUnitPrice, `${idx + 1}行目の適用売価単価`),
      masterCostPrice: asOptIntNumber(obj.masterCostPrice, `${idx + 1}行目の基準原価単価`),
      appliedCostPrice: isHeading
        ? 0
        : asFiniteNumber(obj.appliedCostPrice, `${idx + 1}行目の適用原価単価`),
      remarks: asOptStr(obj.remarks),
    };
  });

  const rawPolicy = asOptStr(raw.taxCalcPolicy);

  return {
    quotationName: asReqStr(raw.quotationName),
    quotationDate: asReqStr(raw.quotationDate),
    partnerId: asReqStr(raw.partnerId),
    projectId: asOptStr(raw.projectId),
    honorific: asReqStr(raw.honorific),
    validityPeriod: asOptStr(raw.validityPeriod),
    deliveryDate: asOptStr(raw.deliveryDate),
    status: (asReqStr(raw.status).trim() !== '' ? asReqStr(raw.status).trim() : 'Q1') as QuotationStatus,
    isAdvanceType: raw.isAdvanceType === true,
    isSelected: raw.isSelected === true,
    roundingMode: (asReqStr(raw.roundingMode).trim() !== ''
      ? asReqStr(raw.roundingMode).trim()
      : 'FLOOR') as RoundingMode,
    taxCalcPolicy: rawPolicy !== null ? (rawPolicy as TaxCalcPolicy) : undefined,
    remarks: asOptStr(raw.remarks),
    lines,
  };
}
