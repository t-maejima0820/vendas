import type { RoundingMode, TaxCode } from '@/lib/domain/calculations';
import { MasterDataError } from '@/lib/masters/error-mapper';
import type {
  ProjectBudgetBreakdown,
  ProjectInput,
  ProjectStatus,
} from '@/lib/projects/types';

function readNullableString(val: unknown): string | null {
  if (val === undefined || val === null) {
    return null;
  }
  if (typeof val !== 'string') {
    throw new MasterDataError(400, 'INVALID_FIELD_TYPE', '文字列項目に不正な値が指定されました。');
  }
  const trimmed = val.trim();
  return trimmed === '' ? null : trimmed;
}

function readRequiredString(val: unknown, label: string): string {
  if (typeof val !== 'string' || val.trim() === '') {
    throw new MasterDataError(400, 'REQUIRED_FIELD', `${label}は必須です。`);
  }
  return val.trim();
}

function readIntYenDefaultZero(val: unknown, label: string): number {
  if (val === undefined || val === null || val === '') {
    return 0;
  }
  const num = typeof val === 'number' ? val : Number(String(val).trim());
  if (!Number.isFinite(num) || !Number.isInteger(num)) {
    throw new MasterDataError(400, 'INVALID_AMOUNT', `${label}は整数円で入力してください。`);
  }
  return num;
}

function readPositiveNumberDefaultOne(val: unknown, label: string): number {
  if (val === undefined || val === null || val === '') {
    return 1;
  }
  const num = typeof val === 'number' ? val : Number(String(val).trim());
  if (!Number.isFinite(num)) {
    throw new MasterDataError(400, 'INVALID_NUMBER', `${label}は数値で入力してください。`);
  }
  return num;
}

function readProjectStatus(val: unknown): ProjectStatus {
  if (val === undefined || val === null || val === '') {
    return 'C1';
  }
  if (val === 'C1' || val === 'C2' || val === 'C3') {
    return val;
  }
  throw new MasterDataError(400, 'INVALID_STATUS', '案件ステータスは C1〜C3 を指定してください。');
}

function readTaxCode(val: unknown): TaxCode {
  if (val === undefined || val === null || val === '') {
    return 'A';
  }
  if (val === 'A' || val === 'B' || val === 'C' || val === 'D' || val === 'E') {
    return val;
  }
  throw new MasterDataError(400, 'INVALID_TAX_CODE', '税区分は A〜E を指定してください。');
}

function readRoundingMode(val: unknown): RoundingMode {
  if (val === undefined || val === null || val === '') {
    return 'FLOOR';
  }
  if (val === 'FLOOR' || val === 'ROUND' || val === 'CEIL') {
    return val;
  }
  throw new MasterDataError(
    400,
    'INVALID_ROUNDING_MODE',
    '端数処理は FLOOR / ROUND / CEIL を指定してください。',
  );
}

export function parseProjectPayload(raw: unknown): ProjectInput {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new MasterDataError(400, 'INVALID_PAYLOAD', '案件データ形式が不正です。');
  }
  const obj = raw as Record<string, unknown>;

  let projectNo: number | null = null;
  if (obj.projectNo !== undefined && obj.projectNo !== null && obj.projectNo !== '') {
    const parsedNo =
      typeof obj.projectNo === 'number' ? obj.projectNo : Number(String(obj.projectNo).trim());
    if (!Number.isInteger(parsedNo) || parsedNo <= 0) {
      throw new MasterDataError(400, 'INVALID_PROJECT_NO', '案件番号は正の整数で指定してください。');
    }
    projectNo = parsedNo;
  }

  const rawBudgets =
    obj.budgets !== undefined && obj.budgets !== null && typeof obj.budgets === 'object'
      ? (obj.budgets as Record<string, unknown>)
      : {};

  const budgets: ProjectBudgetBreakdown = {
    EXPENSE: readIntYenDefaultZero(rawBudgets.EXPENSE ?? obj.budgetExpense, '経費予算'),
    LABOR: readIntYenDefaultZero(rawBudgets.LABOR ?? obj.budgetLabor, '労務費予算'),
    MATERIAL: readIntYenDefaultZero(rawBudgets.MATERIAL ?? obj.budgetMaterial, '材料費予算'),
    OUTSOURCING: readIntYenDefaultZero(rawBudgets.OUTSOURCING ?? obj.budgetOutsourcing, '外注費予算'),
    TEMPORARY: readIntYenDefaultZero(rawBudgets.TEMPORARY ?? obj.budgetTemporary, '仮設費予算'),
    INDIRECT: readIntYenDefaultZero(rawBudgets.INDIRECT ?? obj.budgetIndirect, '間接費予算'),
  };

  const unitRaw = readNullableString(obj.unitName);

  return {
    projectNo,
    projectName: readRequiredString(obj.projectName, '案件名'),
    projectDate: readRequiredString(obj.projectDate, '受注日'),
    sitePlace: readNullableString(obj.sitePlace),
    partnerId: readRequiredString(obj.partnerId, '発注元取引先'),
    orderKindCode: readNullableString(obj.orderKindCode),
    subStatusCode: readNullableString(obj.subStatusCode),
    status: readProjectStatus(obj.status),
    periodStartDate: readNullableString(obj.periodStartDate),
    periodEndDate: readNullableString(obj.periodEndDate),
    actualStartDate: readNullableString(obj.actualStartDate),
    tempFinishDate: readNullableString(obj.tempFinishDate),
    finishDate: readNullableString(obj.finishDate),
    salesEmployeeId: readNullableString(obj.salesEmployeeId),
    siteEmployeeId: readNullableString(obj.siteEmployeeId),
    unitName: unitRaw !== null ? unitRaw : '式',
    contractUnitPrice: readIntYenDefaultZero(obj.contractUnitPrice, '契約単価'),
    contractQuantity: readPositiveNumberDefaultOne(obj.contractQuantity, '契約数量'),
    taxCode: readTaxCode(obj.taxCode),
    roundingMode: readRoundingMode(obj.roundingMode),
    budgets,
    remarks: readNullableString(obj.remarks),
  };
}

export function parseImportBudgetFromQuotationPayload(raw: unknown): {
  quotationId: string | null;
  updateContractAmount: boolean;
} {
  if (raw === undefined || raw === null) {
    return { quotationId: null, updateContractAmount: true };
  }
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    throw new MasterDataError(400, 'INVALID_PAYLOAD', '予算取込パラメータが不正です。');
  }
  const obj = raw as Record<string, unknown>;
  const quotationId = readNullableString(obj.quotationId);
  const updateContractAmount =
    obj.updateContractAmount === undefined ? true : Boolean(obj.updateContractAmount);
  return { quotationId, updateContractAmount };
}
