import { validatePasswordStrength } from '@/lib/auth/session';
import { hashPassword } from '@/lib/crypto/field-cipher';
import type { DbExecutor } from '@/lib/db/tenant-client';
import { mapPgConstraintError, MasterDataError } from '@/lib/masters/error-mapper';
import type {
  CreateEmployeeInput,
  EmployeeDto,
  UpdateEmployeeInput,
} from '@/lib/masters/types';

export interface EmployeeListFilter {
  keyword?: string | null;
  includeRetired?: boolean;
}

type EmployeeRow = {
  id: string;
  syain_code: string;
  syain_name: string;
  kana_name: string | null;
  is_admin: boolean;
  menu_type: number;
  email: string | null;
  joined_at: string | null;
  birth_date: string | null;
  retired_at: string | null;
  is_retired: boolean;
  gender_code: 'S1' | 'S2' | null;
  postal_code: string | null;
  address1: string | null;
  address2: string | null;
  steady_job_note: string | null;
  work_experience: string | null;
  must_change_password: boolean;
  failed_login_count: number;
  locked_until: string | null;
  session_version: number;
  created_at: string;
  updated_at: string;
};

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DATE_REGEX = /^\d{4}-\d{2}-\d{2}$/;

function optTrimmed(val: string | null | undefined): string | null {
  if (val === null || val === undefined) {
    return null;
  }
  const trimmed = val.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function validateEmployeeId(id: string): void {
  if (!UUID_REGEX.test(id)) {
    throw new MasterDataError(400, 'INVALID_ID', '社員IDの形式が不正です。');
  }
}

function validateOptionalDate(val: string | null, label: string): string | null {
  const cleaned = optTrimmed(val);
  if (cleaned !== null && !DATE_REGEX.test(cleaned)) {
    throw new MasterDataError(400, 'INVALID_DATE', `${label}は YYYY-MM-DD 形式で入力してください。`);
  }
  return cleaned;
}

function validateCommonEmployeeFields(input: UpdateEmployeeInput): UpdateEmployeeInput {
  const syainCode = input.syainCode.trim();
  if (syainCode.length === 0 || syainCode.length > 40) {
    throw new MasterDataError(400, 'INVALID_SYAIN_CODE', '社員コードは1〜40文字で入力してください。');
  }
  const syainName = input.syainName.trim();
  if (syainName.length === 0 || syainName.length > 100) {
    throw new MasterDataError(400, 'INVALID_SYAIN_NAME', '社員名は1〜100文字で入力してください。');
  }
  if (!Number.isInteger(input.menuType) || input.menuType < 0 || input.menuType > 99) {
    throw new MasterDataError(400, 'INVALID_MENU_TYPE', 'メニュー区分は0〜99の整数で指定してください。');
  }

  const rawGender = optTrimmed(input.genderCode);
  let genderCode: 'S1' | 'S2' | null = null;
  if (rawGender === 'S1' || rawGender === 'S2') {
    genderCode = rawGender;
  } else if (rawGender !== null) {
    throw new MasterDataError(400, 'INVALID_GENDER_CODE', '性別区分が不正です（S1/S2）。');
  }

  return {
    syainCode,
    syainName,
    kanaName: optTrimmed(input.kanaName),
    isAdmin: Boolean(input.isAdmin),
    menuType: input.menuType,
    email: optTrimmed(input.email),
    joinedAt: validateOptionalDate(input.joinedAt, '入社日'),
    birthDate: validateOptionalDate(input.birthDate, '生年月日'),
    retiredAt: validateOptionalDate(input.retiredAt, '退職日'),
    isRetired: Boolean(input.isRetired),
    genderCode,
    postalCode: optTrimmed(input.postalCode),
    address1: optTrimmed(input.address1),
    address2: optTrimmed(input.address2),
    steadyJobNote: optTrimmed(input.steadyJobNote),
    workExperience: optTrimmed(input.workExperience),
  };
}

function mapEmployeeRow(row: EmployeeRow): EmployeeDto {
  return {
    id: row.id,
    syainCode: row.syain_code,
    syainName: row.syain_name,
    kanaName: row.kana_name,
    isAdmin: row.is_admin,
    menuType: Number(row.menu_type),
    email: row.email,
    joinedAt: row.joined_at,
    birthDate: row.birth_date,
    retiredAt: row.retired_at,
    isRetired: row.is_retired,
    genderCode: row.gender_code,
    postalCode: row.postal_code,
    address1: row.address1,
    address2: row.address2,
    steadyJobNote: row.steady_job_note,
    workExperience: row.work_experience,
    mustChangePassword: row.must_change_password,
    failedLoginCount: Number(row.failed_login_count),
    lockedUntil: row.locked_until,
    sessionVersion: Number(row.session_version),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export async function listEmployees(
  tx: DbExecutor,
  filter: EmployeeListFilter = {},
): Promise<EmployeeDto[]> {
  const kw = optTrimmed(filter.keyword);
  const includeRetired = filter.includeRetired === true;

  const rows = await tx.query<EmployeeRow>(
    `SELECT
       id, syain_code, syain_name, kana_name, is_admin, menu_type, email,
       joined_at::text AS joined_at,
       birth_date::text AS birth_date,
       retired_at::text AS retired_at,
       is_retired, gender_code, postal_code, address1, address2,
       steady_job_note, work_experience,
       must_change_password, failed_login_count,
       locked_until::text AS locked_until,
       session_version,
       created_at::text AS created_at,
       updated_at::text AS updated_at
     FROM employees
     WHERE (
       $1::text IS NULL
       OR syain_code ILIKE '%' || $1 || '%'
       OR syain_name ILIKE '%' || $1 || '%'
       OR COALESCE(kana_name, '') ILIKE '%' || $1 || '%'
       OR COALESCE(email, '') ILIKE '%' || $1 || '%'
     )
     AND ($2::boolean = true OR is_retired = false)
     ORDER BY is_retired ASC, syain_code ASC`,
    [kw, includeRetired],
  );
  return rows.map(mapEmployeeRow);
}

async function getEmployeeById(tx: DbExecutor, id: string): Promise<EmployeeDto> {
  const rows = await tx.query<EmployeeRow>(
    `SELECT
       id, syain_code, syain_name, kana_name, is_admin, menu_type, email,
       joined_at::text AS joined_at,
       birth_date::text AS birth_date,
       retired_at::text AS retired_at,
       is_retired, gender_code, postal_code, address1, address2,
       steady_job_note, work_experience,
       must_change_password, failed_login_count,
       locked_until::text AS locked_until,
       session_version,
       created_at::text AS created_at,
       updated_at::text AS updated_at
     FROM employees
     WHERE id = $1::uuid`,
    [id],
  );
  const row = rows[0];
  if (row === undefined) {
    throw new MasterDataError(404, 'EMPLOYEE_NOT_FOUND', '指定された社員が見つかりません。');
  }
  return mapEmployeeRow(row);
}

export async function createEmployee(
  tx: DbExecutor,
  tenantId: string,
  input: CreateEmployeeInput,
  actorEmployeeId: string,
): Promise<EmployeeDto> {
  const clean = validateCommonEmployeeFields(input);
  const pwCheck = validatePasswordStrength(input.initialPassword, clean.syainCode);
  if (!pwCheck.valid) {
    throw new MasterDataError(
      400,
      'PASSWORD_POLICY_VIOLATION',
      pwCheck.reason ?? '初期パスワードがセキュリティ要件を満たしていません。',
    );
  }

  const passwordHash = hashPassword(input.initialPassword);

  try {
    const insertedRows = await tx.query<EmployeeRow>(
      `INSERT INTO employees (
         tenant_id, syain_code, syain_name, kana_name, password_hash,
         is_admin, menu_type, email, joined_at, birth_date, retired_at, is_retired,
         gender_code, postal_code, address1, address2, steady_job_note, work_experience,
         must_change_password, session_version, failed_login_count, locked_until,
         created_by, updated_by
       ) VALUES (
         $1::uuid, $2, $3, $4, $5,
         $6, $7, $8, $9::date, $10::date, $11::date, $12,
         $13, $14, $15, $16, $17, $18,
         true, 1, 0, NULL,
         $19::uuid, $19::uuid
       )
       RETURNING
         id, syain_code, syain_name, kana_name, is_admin, menu_type, email,
         joined_at::text AS joined_at,
         birth_date::text AS birth_date,
         retired_at::text AS retired_at,
         is_retired, gender_code, postal_code, address1, address2,
         steady_job_note, work_experience,
         must_change_password, failed_login_count,
         locked_until::text AS locked_until,
         session_version,
         created_at::text AS created_at,
         updated_at::text AS updated_at`,
      [
        tenantId,
        clean.syainCode,
        clean.syainName,
        clean.kanaName,
        passwordHash,
        clean.isAdmin,
        clean.menuType,
        clean.email,
        clean.joinedAt,
        clean.birthDate,
        clean.retiredAt,
        clean.isRetired,
        clean.genderCode,
        clean.postalCode,
        clean.address1,
        clean.address2,
        clean.steadyJobNote,
        clean.workExperience,
        actorEmployeeId,
      ],
    );
    const inserted = insertedRows[0];
    if (inserted === undefined) {
      throw new MasterDataError(500, 'INSERT_FAILED', '社員の登録結果を取得できませんでした。');
    }
    return mapEmployeeRow(inserted);
  } catch (err) {
    throw mapPgConstraintError(err, {
      entityLabel: '社員',
      defaultUniqueMessage: `社員コード「${clean.syainCode}」は既に登録されています。別のコードを指定してください。`,
    });
  }
}

export async function updateEmployee(
  tx: DbExecutor,
  id: string,
  input: UpdateEmployeeInput,
  actorEmployeeId: string,
): Promise<EmployeeDto> {
  validateEmployeeId(id);
  const clean = validateCommonEmployeeFields(input);

  if (id === actorEmployeeId && !clean.isAdmin) {
    throw new MasterDataError(
      400,
      'CANNOT_DEMOTE_SELF',
      '現在ログイン中の自身の管理者権限を解除することはできません。',
    );
  }
  if (id === actorEmployeeId && clean.isRetired) {
    throw new MasterDataError(
      400,
      'CANNOT_RETIRE_SELF',
      '現在ログイン中の自身を退職・無効化することはできません。',
    );
  }

  const currentRows = await tx.query<{
    is_admin: boolean;
    menu_type: number;
    is_retired: boolean;
    session_version: number;
  }>(
    `SELECT is_admin, menu_type, is_retired, session_version
     FROM employees
     WHERE id = $1::uuid
     FOR UPDATE`,
    [id],
  );
  const cur = currentRows[0];
  if (cur === undefined) {
    throw new MasterDataError(404, 'EMPLOYEE_NOT_FOUND', '指定された社員が見つかりません。');
  }

  const securityChanged =
    cur.is_admin !== clean.isAdmin ||
    Number(cur.menu_type) !== clean.menuType ||
    cur.is_retired !== clean.isRetired;

  const nextSessionVersion = securityChanged
    ? Number(cur.session_version) + 1
    : Number(cur.session_version);

  try {
    const updatedRows = await tx.query<EmployeeRow>(
      `UPDATE employees
       SET
         syain_code = $2,
         syain_name = $3,
         kana_name = $4,
         is_admin = $5,
         menu_type = $6,
         email = $7,
         joined_at = $8::date,
         birth_date = $9::date,
         retired_at = $10::date,
         is_retired = $11,
         gender_code = $12,
         postal_code = $13,
         address1 = $14,
         address2 = $15,
         steady_job_note = $16,
         work_experience = $17,
         session_version = $18,
         updated_by = $19::uuid
       WHERE id = $1::uuid
       RETURNING
         id, syain_code, syain_name, kana_name, is_admin, menu_type, email,
         joined_at::text AS joined_at,
         birth_date::text AS birth_date,
         retired_at::text AS retired_at,
         is_retired, gender_code, postal_code, address1, address2,
         steady_job_note, work_experience,
         must_change_password, failed_login_count,
         locked_until::text AS locked_until,
         session_version,
         created_at::text AS created_at,
         updated_at::text AS updated_at`,
      [
        id,
        clean.syainCode,
        clean.syainName,
        clean.kanaName,
        clean.isAdmin,
        clean.menuType,
        clean.email,
        clean.joinedAt,
        clean.birthDate,
        clean.retiredAt,
        clean.isRetired,
        clean.genderCode,
        clean.postalCode,
        clean.address1,
        clean.address2,
        clean.steadyJobNote,
        clean.workExperience,
        nextSessionVersion,
        actorEmployeeId,
      ],
    );
    const updated = updatedRows[0];
    if (updated === undefined) {
      throw new MasterDataError(404, 'EMPLOYEE_NOT_FOUND', '指定された社員が見つかりません。');
    }
    return mapEmployeeRow(updated);
  } catch (err) {
    throw mapPgConstraintError(err, {
      entityLabel: '社員',
      defaultUniqueMessage: `社員コード「${clean.syainCode}」は既に他の社員に登録されています。`,
    });
  }
}

export async function resetEmployeePasswordByAdmin(
  tx: DbExecutor,
  tenantId: string,
  tenantSlug: string,
  id: string,
  newPassword: string,
  actorEmployeeId: string,
): Promise<EmployeeDto> {
  validateEmployeeId(id);

  const existingRows = await tx.query<{ id: string; syain_code: string }>(
    `SELECT id, syain_code
     FROM employees
     WHERE id = $1::uuid
     FOR UPDATE`,
    [id],
  );
  const target = existingRows[0];
  if (target === undefined) {
    throw new MasterDataError(404, 'EMPLOYEE_NOT_FOUND', '指定された社員が見つかりません。');
  }

  const pwCheck = validatePasswordStrength(newPassword, target.syain_code);
  if (!pwCheck.valid) {
    throw new MasterDataError(
      400,
      'PASSWORD_POLICY_VIOLATION',
      pwCheck.reason ?? '仮パスワードがセキュリティ要件を満たしていません。',
    );
  }

  const passwordHash = hashPassword(newPassword);
  await tx.query(
    `UPDATE employees
     SET
       password_hash = $2,
       must_change_password = true,
       session_version = session_version + 1,
       updated_by = $3::uuid
     WHERE id = $1::uuid`,
    [id, passwordHash, actorEmployeeId],
  );

  const accountKey = `acct:${tenantSlug.trim().toLowerCase()}:${target.syain_code}`;
  await tx.query(
    `SELECT record_login_success('', $1, $2::uuid, $3::uuid)`,
    [accountKey, tenantId, id],
  );

  return getEmployeeById(tx, id);
}

export async function unlockEmployeeAccountByAdmin(
  tx: DbExecutor,
  tenantId: string,
  tenantSlug: string,
  id: string,
  actorEmployeeId: string,
): Promise<EmployeeDto> {
  validateEmployeeId(id);

  const existingRows = await tx.query<{ id: string; syain_code: string }>(
    `SELECT id, syain_code
     FROM employees
     WHERE id = $1::uuid
     FOR UPDATE`,
    [id],
  );
  const target = existingRows[0];
  if (target === undefined) {
    throw new MasterDataError(404, 'EMPLOYEE_NOT_FOUND', '指定された社員が見つかりません。');
  }

  const accountKey = `acct:${tenantSlug.trim().toLowerCase()}:${target.syain_code}`;
  await tx.query(
    `SELECT record_login_success('', $1, $2::uuid, $3::uuid)`,
    [accountKey, tenantId, id],
  );

  await tx.query(
    `UPDATE employees SET updated_by = $2::uuid WHERE id = $1::uuid`,
    [id, actorEmployeeId],
  );

  return getEmployeeById(tx, id);
}
