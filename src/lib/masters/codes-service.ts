import type { DbExecutor } from '@/lib/db/tenant-client';
import { mapPgConstraintError, MasterDataError } from '@/lib/masters/error-mapper';
import {
  CODE_MASTER_DOMAINS,
  PROTECTED_PAYMENT_METHOD_CODES,
  type CodeMasterDto,
  type CodeMasterInput,
  type PaymentMethodDto,
  type PaymentMethodInput,
  type TaxCodeDto,
  type TaxCodeUpdateInput,
  type UnitDto,
  type UnitInput,
} from '@/lib/masters/types';

type UnitRow = {
  id: string;
  unit_code: string;
  unit_name: string;
  conversion_name: string | null;
  conversion_ratio: string | number;
  display_order: number;
  is_deleted: boolean;
  created_at: string;
  updated_at: string;
};

type PaymentMethodRow = {
  id: string;
  method_code: string;
  method_name: string;
  created_at: string;
  updated_at: string;
};

type TaxCodeRow = {
  id: string;
  tax_code: 'A' | 'B' | 'C' | 'D' | 'E';
  tax_name: string;
  tax_rate: string | number;
  mark_symbol: string;
  is_internal: boolean;
  created_at: string;
  updated_at: string;
};

type CodeMasterRow = {
  id: string;
  domain_key: string;
  code: string;
  name: string;
  is_active: boolean;
  display_order: number;
  created_at: string;
  updated_at: string;
};

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const PROTECTED_METHOD_SET = new Set<string>(PROTECTED_PAYMENT_METHOD_CODES);
const DOMAIN_META_MAP = new Map(CODE_MASTER_DOMAINS.map((d) => [d.domainKey, d]));

function optTrimmed(val: string | null | undefined): string | null {
  if (val === null || val === undefined) {
    return null;
  }
  const trimmed = val.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function validateUuid(id: string, label: string): void {
  if (!UUID_REGEX.test(id)) {
    throw new MasterDataError(400, 'INVALID_ID', `${label}IDの形式が不正です。`);
  }
}

function isProtectedCodeMaster(domainKey: string, code: string): boolean {
  const meta = DOMAIN_META_MAP.get(domainKey);
  return meta !== undefined && meta.protectedCodes.includes(code);
}

// ----------------------------------------------------------------------------
// 1. 単位マスタ (units)
// ----------------------------------------------------------------------------
function validateUnitInput(input: UnitInput): UnitInput {
  const unitCode = input.unitCode.trim();
  if (unitCode.length === 0 || unitCode.length > 20) {
    throw new MasterDataError(400, 'INVALID_UNIT_CODE', '単位コードは1〜20文字で入力してください。');
  }
  const unitName = input.unitName.trim();
  if (unitName.length === 0 || unitName.length > 50) {
    throw new MasterDataError(400, 'INVALID_UNIT_NAME', '単位名は1〜50文字で入力してください。');
  }
  if (!Number.isFinite(input.conversionRatio) || input.conversionRatio < 0) {
    throw new MasterDataError(400, 'INVALID_CONVERSION_RATIO', '換算比率は0以上の数値で入力してください。');
  }
  if (!Number.isInteger(input.displayOrder) || input.displayOrder < 0 || input.displayOrder > 999999) {
    throw new MasterDataError(400, 'INVALID_DISPLAY_ORDER', '表示順は0〜999999の整数で入力してください。');
  }
  return {
    unitCode,
    unitName,
    conversionName: optTrimmed(input.conversionName),
    conversionRatio: input.conversionRatio,
    displayOrder: input.displayOrder,
    isDeleted: Boolean(input.isDeleted),
  };
}

function mapUnitRow(row: UnitRow): UnitDto {
  return {
    id: row.id,
    unitCode: row.unit_code,
    unitName: row.unit_name,
    conversionName: row.conversion_name,
    conversionRatio: Number(row.conversion_ratio),
    displayOrder: Number(row.display_order),
    isDeleted: row.is_deleted,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export async function listUnits(tx: DbExecutor, includeDeleted: boolean = true): Promise<UnitDto[]> {
  const rows = await tx.query<UnitRow>(
    `SELECT id, unit_code, unit_name, conversion_name,
            conversion_ratio::text AS conversion_ratio,
            display_order, is_deleted,
            created_at::text AS created_at, updated_at::text AS updated_at
     FROM units
     WHERE ($1::boolean = true OR is_deleted = false)
     ORDER BY is_deleted ASC, display_order ASC, unit_code ASC`,
    [includeDeleted],
  );
  return rows.map(mapUnitRow);
}

export async function createUnit(
  tx: DbExecutor,
  tenantId: string,
  input: UnitInput,
): Promise<UnitDto> {
  const clean = validateUnitInput(input);
  try {
    const rows = await tx.query<UnitRow>(
      `INSERT INTO units (
         tenant_id, unit_code, unit_name, conversion_name, conversion_ratio, display_order, is_deleted
       ) VALUES ($1::uuid, $2, $3, $4, $5, $6, $7)
       RETURNING id, unit_code, unit_name, conversion_name,
                 conversion_ratio::text AS conversion_ratio,
                 display_order, is_deleted,
                 created_at::text AS created_at, updated_at::text AS updated_at`,
      [
        tenantId,
        clean.unitCode,
        clean.unitName,
        clean.conversionName,
        clean.conversionRatio,
        clean.displayOrder,
        clean.isDeleted,
      ],
    );
    const row = rows[0];
    if (row === undefined) {
      throw new MasterDataError(500, 'INSERT_FAILED', '単位の登録結果を取得できませんでした。');
    }
    return mapUnitRow(row);
  } catch (err) {
    throw mapPgConstraintError(err, {
      entityLabel: '単位',
      defaultUniqueMessage: `単位コード「${clean.unitCode}」は既に登録されています。`,
    });
  }
}

export async function updateUnit(tx: DbExecutor, id: string, input: UnitInput): Promise<UnitDto> {
  validateUuid(id, '単位');
  const clean = validateUnitInput(input);
  try {
    const rows = await tx.query<UnitRow>(
      `UPDATE units
       SET unit_code = $2,
           unit_name = $3,
           conversion_name = $4,
           conversion_ratio = $5,
           display_order = $6,
           is_deleted = $7
       WHERE id = $1::uuid
       RETURNING id, unit_code, unit_name, conversion_name,
                 conversion_ratio::text AS conversion_ratio,
                 display_order, is_deleted,
                 created_at::text AS created_at, updated_at::text AS updated_at`,
      [
        id,
        clean.unitCode,
        clean.unitName,
        clean.conversionName,
        clean.conversionRatio,
        clean.displayOrder,
        clean.isDeleted,
      ],
    );
    const row = rows[0];
    if (row === undefined) {
      throw new MasterDataError(404, 'UNIT_NOT_FOUND', '指定された単位が見つかりません。');
    }
    return mapUnitRow(row);
  } catch (err) {
    throw mapPgConstraintError(err, {
      entityLabel: '単位',
      defaultUniqueMessage: `単位コード「${clean.unitCode}」は既に他の単位に登録されています。`,
    });
  }
}

// ----------------------------------------------------------------------------
// 2. 支払・回収方法マスタ (payment_methods)
// ----------------------------------------------------------------------------
function validatePaymentMethodInput(input: PaymentMethodInput): PaymentMethodInput {
  const methodCode = input.methodCode.trim();
  if (methodCode.length === 0 || methodCode.length > 10) {
    throw new MasterDataError(400, 'INVALID_METHOD_CODE', '支払方法コードは1〜10文字で入力してください。');
  }
  const methodName = input.methodName.trim();
  if (methodName.length === 0 || methodName.length > 50) {
    throw new MasterDataError(400, 'INVALID_METHOD_NAME', '支払方法名は1〜50文字で入力してください。');
  }
  return { methodCode, methodName };
}

function mapPaymentMethodRow(row: PaymentMethodRow): PaymentMethodDto {
  return {
    id: row.id,
    methodCode: row.method_code,
    methodName: row.method_name,
    isProtected: PROTECTED_METHOD_SET.has(row.method_code),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export async function listPaymentMethods(tx: DbExecutor): Promise<PaymentMethodDto[]> {
  const rows = await tx.query<PaymentMethodRow>(
    `SELECT id, method_code, method_name,
            created_at::text AS created_at, updated_at::text AS updated_at
     FROM payment_methods
     ORDER BY method_code ASC`,
    [],
  );
  return rows.map(mapPaymentMethodRow);
}

export async function createPaymentMethod(
  tx: DbExecutor,
  tenantId: string,
  input: PaymentMethodInput,
): Promise<PaymentMethodDto> {
  const clean = validatePaymentMethodInput(input);
  try {
    const rows = await tx.query<PaymentMethodRow>(
      `INSERT INTO payment_methods (tenant_id, method_code, method_name)
       VALUES ($1::uuid, $2, $3)
       RETURNING id, method_code, method_name,
                 created_at::text AS created_at, updated_at::text AS updated_at`,
      [tenantId, clean.methodCode, clean.methodName],
    );
    const row = rows[0];
    if (row === undefined) {
      throw new MasterDataError(500, 'INSERT_FAILED', '支払方法の登録結果を取得できませんでした。');
    }
    return mapPaymentMethodRow(row);
  } catch (err) {
    throw mapPgConstraintError(err, {
      entityLabel: '支払方法',
      defaultUniqueMessage: `支払方法コード「${clean.methodCode}」は既に登録されています。`,
    });
  }
}

export async function updatePaymentMethod(
  tx: DbExecutor,
  id: string,
  input: PaymentMethodInput,
): Promise<PaymentMethodDto> {
  validateUuid(id, '支払方法');
  const clean = validatePaymentMethodInput(input);

  const curRows = await tx.query<{ method_code: string }>(
    `SELECT method_code FROM payment_methods WHERE id = $1::uuid FOR UPDATE`,
    [id],
  );
  const cur = curRows[0];
  if (cur === undefined) {
    throw new MasterDataError(404, 'PAYMENT_METHOD_NOT_FOUND', '指定された支払方法が見つかりません。');
  }
  if (PROTECTED_METHOD_SET.has(cur.method_code) && clean.methodCode !== cur.method_code) {
    throw new MasterDataError(
      400,
      'SYSTEM_CODE_PROTECTED',
      `標準支払方法コード「${cur.method_code}」のコードは変更できません。`,
    );
  }

  try {
    const rows = await tx.query<PaymentMethodRow>(
      `UPDATE payment_methods
       SET method_code = $2, method_name = $3
       WHERE id = $1::uuid
       RETURNING id, method_code, method_name,
                 created_at::text AS created_at, updated_at::text AS updated_at`,
      [id, clean.methodCode, clean.methodName],
    );
    const updated = rows[0];
    if (updated === undefined) {
      throw new MasterDataError(404, 'PAYMENT_METHOD_NOT_FOUND', '指定された支払方法が見つかりません。');
    }
    return mapPaymentMethodRow(updated);
  } catch (err) {
    throw mapPgConstraintError(err, {
      entityLabel: '支払方法',
      defaultUniqueMessage: `支払方法コード「${clean.methodCode}」は既に登録されています。`,
    });
  }
}

export async function deletePaymentMethod(tx: DbExecutor, id: string): Promise<void> {
  validateUuid(id, '支払方法');
  const curRows = await tx.query<{ method_code: string }>(
    `SELECT method_code FROM payment_methods WHERE id = $1::uuid FOR UPDATE`,
    [id],
  );
  const cur = curRows[0];
  if (cur === undefined) {
    throw new MasterDataError(404, 'PAYMENT_METHOD_NOT_FOUND', '指定された支払方法が見つかりません。');
  }
  if (PROTECTED_METHOD_SET.has(cur.method_code)) {
    throw new MasterDataError(
      400,
      'SYSTEM_CODE_PROTECTED',
      `標準支払方法コード「${cur.method_code}」はシステム標準のため削除できません。`,
    );
  }

  const refRows = await tx.query<{ ref_count: number }>(
    `SELECT COUNT(*)::int AS ref_count
     FROM business_partners
     WHERE receipt_method_code = $1 OR payment_method_code = $1`,
    [cur.method_code],
  );
  const refCount = Number(refRows[0]?.ref_count);
  if (refCount > 0) {
    throw new MasterDataError(
      409,
      'PAYMENT_METHOD_IN_USE',
      `支払方法コード「${cur.method_code}」は取引先マスタ（${refCount}件）で使用中のため削除できません。`,
    );
  }

  await tx.query(`DELETE FROM payment_methods WHERE id = $1::uuid`, [id]);
}

// ----------------------------------------------------------------------------
// 3. 税区分マスタ (tax_codes: 管理者専用更新・A〜E固定)
// ----------------------------------------------------------------------------
function mapTaxCodeRow(row: TaxCodeRow): TaxCodeDto {
  return {
    id: row.id,
    taxCode: row.tax_code,
    taxName: row.tax_name,
    taxRate: Number(row.tax_rate),
    markSymbol: row.mark_symbol,
    isInternal: row.is_internal,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export async function listTaxCodes(tx: DbExecutor): Promise<TaxCodeDto[]> {
  const rows = await tx.query<TaxCodeRow>(
    `SELECT id, tax_code, tax_name, tax_rate::text AS tax_rate, mark_symbol, is_internal,
            created_at::text AS created_at, updated_at::text AS updated_at
     FROM tax_codes
     ORDER BY tax_code ASC`,
    [],
  );
  return rows.map(mapTaxCodeRow);
}

export async function updateTaxCode(
  tx: DbExecutor,
  id: string,
  input: TaxCodeUpdateInput,
): Promise<TaxCodeDto> {
  validateUuid(id, '税区分');
  const taxName = input.taxName.trim();
  if (taxName.length === 0 || taxName.length > 50) {
    throw new MasterDataError(400, 'INVALID_TAX_NAME', '税区分名は1〜50文字で入力してください。');
  }
  if (!Number.isFinite(input.taxRate) || input.taxRate < 0 || input.taxRate > 1) {
    throw new MasterDataError(400, 'INVALID_TAX_RATE', '税率は 0.0000〜1.0000 の範囲で指定してください。');
  }
  const markSymbol = input.markSymbol.trim();
  if (markSymbol.length === 0 || markSymbol.length > 10) {
    throw new MasterDataError(400, 'INVALID_MARK_SYMBOL', '印字記号は1〜10文字で入力してください。');
  }

  try {
    const rows = await tx.query<TaxCodeRow>(
      `UPDATE tax_codes
       SET tax_name = $2, tax_rate = $3, mark_symbol = $4, is_internal = $5
       WHERE id = $1::uuid
       RETURNING id, tax_code, tax_name, tax_rate::text AS tax_rate, mark_symbol, is_internal,
                 created_at::text AS created_at, updated_at::text AS updated_at`,
      [id, taxName, input.taxRate, markSymbol, Boolean(input.isInternal)],
    );
    const row = rows[0];
    if (row === undefined) {
      throw new MasterDataError(404, 'TAX_CODE_NOT_FOUND', '指定された税区分が見つかりません。');
    }
    return mapTaxCodeRow(row);
  } catch (err) {
    throw mapPgConstraintError(err, { entityLabel: '税区分' });
  }
}

// ----------------------------------------------------------------------------
// 4. 汎用区分マスタ (code_masters: 全16ドメイン)
// ----------------------------------------------------------------------------
function validateCodeMasterInput(input: CodeMasterInput): CodeMasterInput {
  const domainKey = input.domainKey.trim();
  if (!DOMAIN_META_MAP.has(domainKey)) {
    throw new MasterDataError(400, 'INVALID_DOMAIN_KEY', `不正な区分ドメイン「${domainKey}」です。`);
  }
  const code = input.code.trim();
  if (code.length === 0 || code.length > 20) {
    throw new MasterDataError(400, 'INVALID_CODE', '区分コードは1〜20文字で入力してください。');
  }
  const name = input.name.trim();
  if (name.length === 0 || name.length > 100) {
    throw new MasterDataError(400, 'INVALID_CODE_NAME', '区分名称は1〜100文字で入力してください。');
  }
  if (!Number.isInteger(input.displayOrder) || input.displayOrder < 0 || input.displayOrder > 999999) {
    throw new MasterDataError(400, 'INVALID_DISPLAY_ORDER', '表示順は0〜999999の整数で入力してください。');
  }
  return {
    domainKey,
    code,
    name,
    isActive: Boolean(input.isActive),
    displayOrder: input.displayOrder,
  };
}

function mapCodeMasterRow(row: CodeMasterRow): CodeMasterDto {
  return {
    id: row.id,
    domainKey: row.domain_key,
    code: row.code,
    name: row.name,
    isActive: row.is_active,
    displayOrder: Number(row.display_order),
    isProtected: isProtectedCodeMaster(row.domain_key, row.code),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export async function listCodeMasters(
  tx: DbExecutor,
  domainKey?: string | null,
  includeInactive: boolean = true,
): Promise<CodeMasterDto[]> {
  const cleanDomain = optTrimmed(domainKey);
  if (cleanDomain !== null && !DOMAIN_META_MAP.has(cleanDomain)) {
    throw new MasterDataError(400, 'INVALID_DOMAIN_KEY', `不正な区分ドメイン「${cleanDomain}」です。`);
  }
  const rows = await tx.query<CodeMasterRow>(
    `SELECT id, domain_key, code, name, is_active, display_order,
            created_at::text AS created_at, updated_at::text AS updated_at
     FROM code_masters
     WHERE ($1::text IS NULL OR domain_key = $1)
       AND ($2::boolean = true OR is_active = true)
     ORDER BY domain_key ASC, display_order ASC, code ASC`,
    [cleanDomain, includeInactive],
  );
  return rows.map(mapCodeMasterRow);
}

export async function createCodeMaster(
  tx: DbExecutor,
  tenantId: string,
  input: CodeMasterInput,
): Promise<CodeMasterDto> {
  const clean = validateCodeMasterInput(input);
  try {
    const rows = await tx.query<CodeMasterRow>(
      `INSERT INTO code_masters (tenant_id, domain_key, code, name, is_active, display_order)
       VALUES ($1::uuid, $2, $3, $4, $5, $6)
       RETURNING id, domain_key, code, name, is_active, display_order,
                 created_at::text AS created_at, updated_at::text AS updated_at`,
      [tenantId, clean.domainKey, clean.code, clean.name, clean.isActive, clean.displayOrder],
    );
    const row = rows[0];
    if (row === undefined) {
      throw new MasterDataError(500, 'INSERT_FAILED', '区分コードの登録結果を取得できませんでした。');
    }
    return mapCodeMasterRow(row);
  } catch (err) {
    throw mapPgConstraintError(err, {
      entityLabel: '汎用区分',
      defaultUniqueMessage: `ドメイン「${clean.domainKey}」にコード「${clean.code}」は既に登録されています。`,
    });
  }
}

export async function updateCodeMaster(
  tx: DbExecutor,
  id: string,
  input: CodeMasterInput,
): Promise<CodeMasterDto> {
  validateUuid(id, '汎用区分');
  const clean = validateCodeMasterInput(input);

  const curRows = await tx.query<{ domain_key: string; code: string }>(
    `SELECT domain_key, code FROM code_masters WHERE id = $1::uuid FOR UPDATE`,
    [id],
  );
  const cur = curRows[0];
  if (cur === undefined) {
    throw new MasterDataError(404, 'CODE_MASTER_NOT_FOUND', '指定された区分コードが見つかりません。');
  }

  if (isProtectedCodeMaster(cur.domain_key, cur.code)) {
    if (clean.domainKey !== cur.domain_key || clean.code !== cur.code || !clean.isActive) {
      throw new MasterDataError(
        400,
        'SYSTEM_CODE_PROTECTED',
        `システム固定区分「${cur.domain_key}:${cur.code}」はコード変更・無効化できません。`,
      );
    }
  }

  try {
    const rows = await tx.query<CodeMasterRow>(
      `UPDATE code_masters
       SET domain_key = $2, code = $3, name = $4, is_active = $5, display_order = $6
       WHERE id = $1::uuid
       RETURNING id, domain_key, code, name, is_active, display_order,
                 created_at::text AS created_at, updated_at::text AS updated_at`,
      [id, clean.domainKey, clean.code, clean.name, clean.isActive, clean.displayOrder],
    );
    const updated = rows[0];
    if (updated === undefined) {
      throw new MasterDataError(404, 'CODE_MASTER_NOT_FOUND', '指定された区分コードが見つかりません。');
    }
    return mapCodeMasterRow(updated);
  } catch (err) {
    throw mapPgConstraintError(err, {
      entityLabel: '汎用区分',
      defaultUniqueMessage: `ドメイン「${clean.domainKey}」にコード「${clean.code}」は既に存在します。`,
    });
  }
}

export async function deleteCodeMaster(tx: DbExecutor, id: string): Promise<void> {
  validateUuid(id, '汎用区分');
  const curRows = await tx.query<{ domain_key: string; code: string }>(
    `SELECT domain_key, code FROM code_masters WHERE id = $1::uuid FOR UPDATE`,
    [id],
  );
  const cur = curRows[0];
  if (cur === undefined) {
    throw new MasterDataError(404, 'CODE_MASTER_NOT_FOUND', '指定された区分コードが見つかりません。');
  }
  if (isProtectedCodeMaster(cur.domain_key, cur.code)) {
    throw new MasterDataError(
      400,
      'SYSTEM_CODE_PROTECTED',
      `システム固定区分「${cur.domain_key}:${cur.code}」はDB制約に依存しているため削除できません。`,
    );
  }

  await tx.query(`DELETE FROM code_masters WHERE id = $1::uuid`, [id]);
}
