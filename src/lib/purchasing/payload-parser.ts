import type { RoundingMode, TaxCode } from '@/lib/domain/calculations';
import { MasterDataError } from '@/lib/masters/error-mapper';
import type {
  OrderStatus,
  PurchaseInput,
  PurchaseLineInput,
  PurchaseOrderInput,
  PurchaseOrderLineInput,
  PurchaseStatus,
} from '@/lib/purchasing/types';

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

function readBoolean(val: unknown, defaultVal: boolean): boolean {
  if (val === undefined || val === null) {
    return defaultVal;
  }
  if (typeof val !== 'boolean') {
    throw new MasterDataError(400, 'INVALID_BOOLEAN', '真偽値項目が不正です。');
  }
  return val;
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

function readOrderStatus(val: unknown): OrderStatus {
  if (val === 'O1' || val === 'O2' || val === 'O3') {
    return val;
  }
  throw new MasterDataError(400, 'INVALID_STATUS', '発注ステータスは O1〜O3 を指定してください。');
}

function readPurchaseStatus(val: unknown): PurchaseStatus {
  if (val === 'P1' || val === 'P2' || val === 'P3') {
    return val;
  }
  throw new MasterDataError(400, 'INVALID_STATUS', '仕入ステータスは P1〜P3 を指定してください。');
}

function readRoundingMode(val: unknown): RoundingMode {
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

export function parsePurchaseOrderPayload(raw: unknown): PurchaseOrderInput {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new MasterDataError(400, 'INVALID_PAYLOAD', '発注データ形式が不正です。');
  }
  const obj = raw as Record<string, unknown>;
  if (!Array.isArray(obj.lines) || obj.lines.length === 0) {
    throw new MasterDataError(400, 'LINES_REQUIRED', '発注明細は最低1行以上入力してください。');
  }

  const lines: PurchaseOrderLineInput[] = obj.lines.map((entry, idx) => {
    const lineNo = idx + 1;
    if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) {
      throw new MasterDataError(400, 'INVALID_LINE', `${lineNo}行目の明細形式が不正です。`);
    }
    const row = entry as Record<string, unknown>;
    const isHeading = readBoolean(row.isHeading, false);
    return {
      productId: readNullableString(row.productId),
      itemCode: readNullableString(row.itemCode),
      itemName: readRequiredString(row.itemName, `${lineNo}行目の品名`),
      unitName: readNullableString(row.unitName),
      isHeading,
      quantity: isHeading ? 0 : readFiniteNumber(row.quantity, `${lineNo}行目の数量`),
      taxCode: isHeading ? 'C' : readTaxCode(row.taxCode, lineNo),
      masterUnitPrice: readNullableNumber(row.masterUnitPrice, `${lineNo}行目の基準単価`),
      appliedUnitPrice: isHeading
        ? 0
        : readFiniteNumber(row.appliedUnitPrice, `${lineNo}行目の発注単価`),
      remarks: readNullableString(row.remarks),
    };
  });

  const rawHonorific = readNullableString(obj.honorific);

  return {
    orderName: readRequiredString(obj.orderName, '発注件名'),
    orderDate: readRequiredString(obj.orderDate, '発注日'),
    supplierId: readRequiredString(obj.supplierId, '仕入先'),
    projectId: readNullableString(obj.projectId),
    honorific: rawHonorific !== null ? rawHonorific : '御中',
    deliveryDate: readNullableString(obj.deliveryDate),
    status: readOrderStatus(obj.status),
    roundingMode: readRoundingMode(obj.roundingMode),
    remarks: readNullableString(obj.remarks),
    lines,
  };
}

export function parsePurchasePayload(raw: unknown): PurchaseInput {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new MasterDataError(400, 'INVALID_PAYLOAD', '仕入データ形式が不正です。');
  }
  const obj = raw as Record<string, unknown>;
  if (!Array.isArray(obj.lines) || obj.lines.length === 0) {
    throw new MasterDataError(400, 'LINES_REQUIRED', '仕入明細は最低1行以上入力してください。');
  }

  const lines: PurchaseLineInput[] = obj.lines.map((entry, idx) => {
    const lineNo = idx + 1;
    if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) {
      throw new MasterDataError(400, 'INVALID_LINE', `${lineNo}行目の明細形式が不正です。`);
    }
    const row = entry as Record<string, unknown>;
    const isHeading = readBoolean(row.isHeading, false);
    return {
      projectId: readNullableString(row.projectId),
      productId: readNullableString(row.productId),
      itemCode: readNullableString(row.itemCode),
      itemName: readRequiredString(row.itemName, `${lineNo}行目の品名`),
      unitName: readNullableString(row.unitName),
      isHeading,
      quantity: isHeading ? 0 : readFiniteNumber(row.quantity, `${lineNo}行目の数量`),
      taxCode: isHeading ? 'C' : readTaxCode(row.taxCode, lineNo),
      masterUnitPrice: readNullableNumber(row.masterUnitPrice, `${lineNo}行目の基準単価`),
      appliedUnitPrice: isHeading
        ? 0
        : readFiniteNumber(row.appliedUnitPrice, `${lineNo}行目の仕入単価`),
      remarks: readNullableString(row.remarks),
    };
  });

  const rawHonorific = readNullableString(obj.honorific);

  return {
    purchaseName: readRequiredString(obj.purchaseName, '仕入件名'),
    purchaseDate: readRequiredString(obj.purchaseDate, '仕入日'),
    supplierId: readRequiredString(obj.supplierId, '仕入先'),
    purchaseOrderId: readNullableString(obj.purchaseOrderId),
    honorific: rawHonorific !== null ? rawHonorific : '御中',
    status: readPurchaseStatus(obj.status),
    roundingMode: readRoundingMode(obj.roundingMode),
    remarks: readNullableString(obj.remarks),
    lines,
  };
}

export function parseCreatePurchaseFromOrderPayload(raw: unknown): {
  orderId: string;
  purchaseDate?: string;
  initialStatus: 'P1' | 'P2';
} {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new MasterDataError(400, 'INVALID_PAYLOAD', '発注転記データ形式が不正です。');
  }
  const obj = raw as Record<string, unknown>;
  const orderId = readRequiredString(obj.orderId, '発注ID');
  const purchaseDateRaw = readNullableString(obj.purchaseDate);
  let initialStatus: 'P1' | 'P2' = 'P2';
  if (obj.initialStatus !== undefined && obj.initialStatus !== null) {
    if (obj.initialStatus === 'P1' || obj.initialStatus === 'P2') {
      initialStatus = obj.initialStatus;
    } else {
      throw new MasterDataError(
        400,
        'INVALID_STATUS',
        '転記時の初期仕入ステータスは P1 または P2 のみ指定できます。',
      );
    }
  }
  return {
    orderId,
    purchaseDate: purchaseDateRaw !== null ? purchaseDateRaw : undefined,
    initialStatus,
  };
}
