import type { CostCategory, RoundingMode, TaxCode } from '@/lib/domain/calculations';
import { MasterDataError } from '@/lib/masters/error-mapper';
import type {
  ImportCostFromPurchaseInput,
  ProjectCostInput,
  ProjectCostLineInput,
} from '@/lib/project-costs/types';
import type { ProjectStatus } from '@/lib/projects/types';

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

function readFiniteNumber(val: unknown, label: string): number {
  if (typeof val !== 'number' || !Number.isFinite(val)) {
    throw new MasterDataError(400, 'INVALID_NUMBER', `${label}は数値で入力してください。`);
  }
  return val;
}

function readNullableNumber(val: unknown, label: string): number | null {
  if (val === undefined || val === null) {
    return null;
  }
  return readFiniteNumber(val, label);
}

function readCostCategory(val: unknown): CostCategory {
  if (
    val === 'EXPENSE' ||
    val === 'LABOR' ||
    val === 'MATERIAL' ||
    val === 'OUTSOURCING' ||
    val === 'TEMPORARY' ||
    val === 'INDIRECT'
  ) {
    return val;
  }
  throw new MasterDataError(
    400,
    'INVALID_COST_CATEGORY',
    '費目区分は EXPENSE / LABOR / MATERIAL / OUTSOURCING / TEMPORARY / INDIRECT のいずれかを指定してください。',
  );
}

function readProjectStatus(val: unknown): ProjectStatus {
  if (val === undefined || val === null || val === '') {
    return 'C2';
  }
  if (val === 'C1' || val === 'C2' || val === 'C3') {
    return val;
  }
  throw new MasterDataError(400, 'INVALID_STATUS', 'ステータスは C1〜C3 を指定してください。');
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

function readTaxCode(val: unknown, lineNo: number): TaxCode {
  if (val === 'A' || val === 'B' || val === 'C' || val === 'D' || val === 'E') {
    return val;
  }
  throw new MasterDataError(400, 'INVALID_TAX_CODE', `${lineNo}行目の税区分は A〜E を指定してください。`);
}

export function parseProjectCostPayload(raw: unknown): ProjectCostInput {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new MasterDataError(400, 'INVALID_PAYLOAD', '原価伝票データ形式が不正です。');
  }
  const obj = raw as Record<string, unknown>;
  if (!Array.isArray(obj.lines) || obj.lines.length === 0) {
    throw new MasterDataError(400, 'LINES_REQUIRED', '原価明細は最低1行以上入力してください。');
  }

  const lines: ProjectCostLineInput[] = obj.lines.map((entry, idx) => {
    const lineNo = idx + 1;
    if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) {
      throw new MasterDataError(400, 'INVALID_LINE', `${lineNo}行目の明細形式が不正です。`);
    }
    const row = entry as Record<string, unknown>;
    const isHeading = row.isHeading === true;
    return {
      productId: readNullableString(row.productId),
      itemCode: readNullableString(row.itemCode),
      itemName: readRequiredString(row.itemName, `${lineNo}行目の品名・作業内容`),
      unitName: readNullableString(row.unitName),
      isHeading,
      quantity: isHeading ? 0 : readFiniteNumber(row.quantity, `${lineNo}行目の数量`),
      taxCode: isHeading ? 'C' : readTaxCode(row.taxCode, lineNo),
      masterUnitPrice: readNullableNumber(row.masterUnitPrice, `${lineNo}行目の基準単価`),
      appliedUnitPrice: isHeading
        ? 0
        : readFiniteNumber(row.appliedUnitPrice, `${lineNo}行目の単価`),
      appliedCostPrice:
        row.appliedCostPrice !== undefined && row.appliedCostPrice !== null
          ? readFiniteNumber(row.appliedCostPrice, `${lineNo}行目の原価単価`)
          : null,
      sourcePurchaseLineId: readNullableString(row.sourcePurchaseLineId),
      remarks: readNullableString(row.remarks),
    };
  });

  return {
    projectId: readRequiredString(obj.projectId, '案件'),
    costCategory: readCostCategory(obj.costCategory),
    slipTitle: readRequiredString(obj.slipTitle, '原価伝票件名'),
    entryDate: readRequiredString(obj.entryDate, '計上日'),
    status: readProjectStatus(obj.status),
    roundingMode: readRoundingMode(obj.roundingMode),
    lines,
  };
}

export function parseImportCostFromPurchasePayload(raw: unknown): ImportCostFromPurchaseInput {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new MasterDataError(400, 'INVALID_PAYLOAD', '仕入取込パラメータ形式が不正です。');
  }
  const obj = raw as Record<string, unknown>;
  return {
    projectId: readRequiredString(obj.projectId, '案件ID'),
    purchaseId: readRequiredString(obj.purchaseId, '仕入ID'),
    costCategory: readCostCategory(obj.costCategory),
    slipTitle: readNullableString(obj.slipTitle),
    entryDate: readNullableString(obj.entryDate),
    status: readProjectStatus(obj.status),
  };
}
