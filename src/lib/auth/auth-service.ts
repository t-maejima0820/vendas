import { hashPassword, verifyPassword } from '@/lib/crypto/field-cipher';
import type { DbExecutor } from '@/lib/db/tenant-client';
import {
  epochSeconds,
  SESSION_TTL_SECONDS,
  signSessionToken,
  validatePasswordStrength,
  type SessionContext,
} from '@/lib/auth/session';

export const MAX_ACCOUNT_FAILED_ATTEMPTS = 5;
export const MAX_IP_FAILED_ATTEMPTS = 20;
export const LOCK_DURATION_MINUTES = 15;

export class AuthServiceError extends Error {
  constructor(
    readonly statusCode: number,
    readonly errorCode: string,
    readonly safeMessage: string,
  ) {
    super(safeMessage);
    this.name = 'AuthServiceError';
  }
}

export class AccountLockedError extends AuthServiceError {
  constructor(readonly lockedUntilIso: string | null) {
    super(
      429,
      'ACCOUNT_LOCKED',
      'ログイン試行回数の上限に達しました。15分ほど時間をおいて再度お試しください。',
    );
    this.name = 'AccountLockedError';
  }
}

export class InvalidCredentialsError extends AuthServiceError {
  constructor() {
    super(401, 'INVALID_CREDENTIALS', '企業ID、社員コード、またはパスワードが正しくありません。');
    this.name = 'InvalidCredentialsError';
  }
}

export class SessionRevokedError extends AuthServiceError {
  constructor() {
    super(401, 'SESSION_REVOKED', 'セッションが無効になりました。再度ログインしてください。');
    this.name = 'SessionRevokedError';
  }
}

export class PasswordPolicyError extends AuthServiceError {
  constructor(reason: string) {
    super(400, 'PASSWORD_POLICY_VIOLATION', reason);
    this.name = 'PasswordPolicyError';
  }
}

let cachedDummyHash: string | null = null;
function getDummyArgonHash(): string {
  if (cachedDummyHash === null) {
    cachedDummyHash = hashPassword('vendas-timing-equalizer-sentinel');
  }
  return cachedDummyHash;
}

export interface LiveSessionUser extends SessionContext {
  syainName: string;
  tenantName: string;
}

interface LookupEmployeeRow extends Record<string, unknown> {
  tenant_id: string;
  tenant_slug: string;
  tenant_is_active: boolean;
  employee_id: string;
  syain_code: string;
  syain_name: string;
  password_hash: string;
  is_admin: boolean;
  menu_type: number;
  is_retired: boolean;
  retired_at: string | null;
  session_version: number;
  must_change_password: boolean;
  failed_login_count: number;
  locked_until: string | Date | null;
}

export async function authenticateLogin(
  executor: DbExecutor,
  params: {
    tenantSlug: string;
    syainCode: string;
    password: string;
    clientIp: string;
    now?: Date;
    sessionSecretOverride?: string;
  },
): Promise<{
  session: SessionContext;
  token: string;
  syainName: string;
}> {
  const tenantSlug = params.tenantSlug.trim().toLowerCase();
  const syainCode = params.syainCode.trim();
  const clientIp = params.clientIp.trim() === '' ? 'unknown' : params.clientIp.trim();
  const nowDate = params.now === undefined ? new Date() : params.now;
  const nowIso = nowDate.toISOString();

  if (tenantSlug === '' || syainCode === '' || params.password === '') {
    throw new InvalidCredentialsError();
  }

  const ipKey = `ip:${clientIp}`;
  const acctKey = `acct:${tenantSlug}:${syainCode}`;

  const rlRows = await executor.query<{
    is_blocked: boolean;
    blocked_until: string | Date | null;
  }>('SELECT is_blocked, blocked_until FROM check_login_rate_limit($1, $2, $3::timestamptz)', [
    ipKey,
    acctKey,
    nowIso,
  ]);
  const rl = rlRows[0];
  if (rl !== undefined && rl.is_blocked) {
    const until = rl.blocked_until === null ? null : new Date(rl.blocked_until).toISOString();
    throw new AccountLockedError(until);
  }

  const empRows = await executor.query<LookupEmployeeRow>(
    `SELECT tenant_id, tenant_slug, tenant_is_active, employee_id, syain_code, syain_name,
            password_hash, is_admin, menu_type, is_retired, retired_at,
            session_version, must_change_password, failed_login_count, locked_until
       FROM authenticate_employee_lookup($1, $2)`,
    [tenantSlug, syainCode],
  );
  const emp = empRows[0];

  if (emp !== undefined && emp.locked_until !== null) {
    const lockedMs = new Date(emp.locked_until).getTime();
    if (lockedMs > nowDate.getTime()) {
      throw new AccountLockedError(new Date(lockedMs).toISOString());
    }
  }

  let passwordMatched = false;
  if (emp === undefined || !emp.tenant_is_active || emp.is_retired) {
    // ユーザー列挙防止のための定数時間風ダミー検証
    verifyPassword(params.password, getDummyArgonHash());
    passwordMatched = false;
  } else {
    passwordMatched = verifyPassword(params.password, emp.password_hash);
  }

  if (!passwordMatched || emp === undefined) {
    const failRows = await executor.query<{
      account_locked_until: string | Date | null;
      ip_locked_until: string | Date | null;
      new_failed_count: number;
    }>(
      `SELECT account_locked_until, ip_locked_until, new_failed_count
         FROM record_login_failure($1, $2, $3::uuid, $4::uuid, $5::timestamptz, $6, $7, $8)`,
      [
        ipKey,
        acctKey,
        emp === undefined ? null : emp.tenant_id,
        emp === undefined ? null : emp.employee_id,
        nowIso,
        MAX_ACCOUNT_FAILED_ATTEMPTS,
        MAX_IP_FAILED_ATTEMPTS,
        LOCK_DURATION_MINUTES,
      ],
    );
    const failRes = failRows[0];
    if (failRes !== undefined && (failRes.account_locked_until !== null || failRes.ip_locked_until !== null)) {
      const lockRaw =
        failRes.account_locked_until !== null ? failRes.account_locked_until : failRes.ip_locked_until;
      throw new AccountLockedError(lockRaw === null ? null : new Date(lockRaw).toISOString());
    }
    throw new InvalidCredentialsError();
  }

  await executor.query('SELECT record_login_success($1, $2, $3::uuid, $4::uuid)', [
    ipKey,
    acctKey,
    emp.tenant_id,
    emp.employee_id,
  ]);

  const nowSec = epochSeconds(nowDate.getTime());
  const session: SessionContext = {
    tenantId: emp.tenant_id,
    tenantSlug: emp.tenant_slug,
    employeeId: emp.employee_id,
    syainCode: emp.syain_code,
    isAdmin: emp.is_admin,
    menuType: emp.menu_type,
    sessionVersion: emp.session_version,
    mustChangePassword: emp.must_change_password,
    exp: nowSec + SESSION_TTL_SECONDS,
  };

  const token = signSessionToken(session, params.sessionSecretOverride);
  return {
    session,
    token,
    syainName: emp.syain_name,
  };
}

export async function verifyActiveSessionInDb(
  tx: DbExecutor,
  session: SessionContext,
): Promise<LiveSessionUser> {
  const rows = await tx.query<{
    employee_id: string;
    syain_code: string;
    syain_name: string;
    is_admin: boolean;
    menu_type: number;
    is_retired: boolean;
    session_version: number;
    must_change_password: boolean;
    tenant_id: string;
    tenant_slug: string;
    tenant_name: string;
    tenant_is_active: boolean;
  }>(
    `SELECT e.id AS employee_id,
            e.syain_code,
            e.syain_name,
            e.is_admin,
            e.menu_type,
            e.is_retired,
            e.session_version,
            e.must_change_password,
            t.id AS tenant_id,
            t.tenant_slug,
            t.tenant_name,
            t.is_active AS tenant_is_active
       FROM employees e
       INNER JOIN tenants t ON t.id = e.tenant_id
      WHERE e.id = $1
        AND e.tenant_id = $2
      LIMIT 1`,
    [session.employeeId, session.tenantId],
  );

  const row = rows[0];
  if (
    row === undefined ||
    !row.tenant_is_active ||
    row.is_retired ||
    row.session_version !== session.sessionVersion
  ) {
    throw new SessionRevokedError();
  }

  return {
    tenantId: row.tenant_id,
    tenantSlug: row.tenant_slug,
    tenantName: row.tenant_name,
    employeeId: row.employee_id,
    syainCode: row.syain_code,
    syainName: row.syain_name,
    isAdmin: row.is_admin,
    menuType: row.menu_type,
    sessionVersion: row.session_version,
    mustChangePassword: row.must_change_password,
    exp: session.exp,
  };
}

export async function changeEmployeePassword(
  tx: DbExecutor,
  params: {
    session: SessionContext;
    currentPassword: string;
    newPassword: string;
    now?: Date;
    sessionSecretOverride?: string;
  },
): Promise<{ session: SessionContext; token: string }> {
  const rows = await tx.query<{
    password_hash: string;
    syain_code: string;
    is_retired: boolean;
    is_admin: boolean;
    menu_type: number;
    session_version: number;
  }>(
    `SELECT password_hash, syain_code, is_retired, is_admin, menu_type, session_version
       FROM employees
      WHERE id = $1 AND tenant_id = $2
      LIMIT 1`,
    [params.session.employeeId, params.session.tenantId],
  );
  const emp = rows[0];
  if (emp === undefined || emp.is_retired || emp.session_version !== params.session.sessionVersion) {
    throw new SessionRevokedError();
  }

  if (!verifyPassword(params.currentPassword, emp.password_hash)) {
    throw new PasswordPolicyError('現在のパスワードが正しくありません');
  }

  if (params.newPassword === params.currentPassword) {
    throw new PasswordPolicyError('現在のパスワードとは異なる新しいパスワードを設定してください');
  }

  const strength = validatePasswordStrength(params.newPassword, emp.syain_code);
  if (!strength.valid) {
    throw new PasswordPolicyError(
      strength.reason === undefined ? '新しいパスワードがセキュリティ要件を満たしていません' : strength.reason,
    );
  }

  const newHash = hashPassword(params.newPassword);
  const updRows = await tx.query<{ session_version: number }>(
    `UPDATE employees
        SET password_hash = $1,
            must_change_password = false,
            session_version = session_version + 1,
            failed_login_count = 0,
            locked_until = NULL
      WHERE id = $2
        AND tenant_id = $3
      RETURNING session_version`,
    [newHash, params.session.employeeId, params.session.tenantId],
  );
  const newVer = updRows[0]?.session_version;
  if (newVer === undefined) {
    throw new SessionRevokedError();
  }

  const nowSec = epochSeconds((params.now === undefined ? new Date() : params.now).getTime());
  const newSession: SessionContext = {
    tenantId: params.session.tenantId,
    tenantSlug: params.session.tenantSlug,
    employeeId: params.session.employeeId,
    syainCode: emp.syain_code,
    isAdmin: emp.is_admin,
    menuType: emp.menu_type,
    sessionVersion: newVer,
    mustChangePassword: false,
    exp: nowSec + SESSION_TTL_SECONDS,
  };
  const token = signSessionToken(newSession, params.sessionSecretOverride);
  return { session: newSession, token };
}
