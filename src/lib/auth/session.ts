import crypto from 'node:crypto';
import { SESSION_COOKIE_NAME, type SessionContext } from '@/lib/auth/edge-token';
import { requireEnv } from '@/lib/env';

export { SESSION_COOKIE_NAME, type SessionContext };

export class SessionVerificationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SessionVerificationError';
  }
}

export const SESSION_TTL_SECONDS = 60 * 60 * 12;

export function epochSeconds(ms: number = Date.now()): number {
  return (ms - (ms % 1000)) / 1000;
}

export function buildSessionCookieOptions(maxAgeSeconds: number = SESSION_TTL_SECONDS): {
  httpOnly: boolean;
  sameSite: 'lax';
  path: string;
  secure: boolean;
  maxAge: number;
} {
  return {
    httpOnly: true,
    sameSite: 'lax',
    path: '/',
    secure: process.env.NODE_ENV === 'production',
    maxAge: maxAgeSeconds,
  };
}

export function validatePasswordStrength(
  newPassword: string,
  syainCode?: string,
): { valid: boolean; reason?: string } {
  if (newPassword.length < 10) {
    return { valid: false, reason: 'パスワードは10文字以上で入力してください' };
  }
  if (!/[A-Za-z]/.test(newPassword) || !/[0-9]/.test(newPassword)) {
    return { valid: false, reason: 'パスワードは英字と数字の両方を混在させてください' };
  }
  if (/\s/.test(newPassword)) {
    return { valid: false, reason: 'パスワードに空白文字は使用できません' };
  }
  if (syainCode !== undefined && newPassword === syainCode) {
    return { valid: false, reason: '社員コードと同一のパスワードは設定できません' };
  }
  return { valid: true };
}

export function signSessionToken(payload: SessionContext, secretOverride?: string): string {
  const secret = secretOverride === undefined ? requireEnv('SESSION_SECRET') : secretOverride;
  const bodyB64 = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
  const sig = crypto.createHmac('sha256', secret).update(bodyB64).digest('base64url');
  return `${bodyB64}.${sig}`;
}

export function verifySessionToken(
  token: string,
  nowSeconds: number,
  secretOverride?: string,
): SessionContext {
  const secret = secretOverride === undefined ? requireEnv('SESSION_SECRET') : secretOverride;
  const parts = token.split('.');
  if (parts.length !== 2) {
    throw new SessionVerificationError('セッショントークン形式が不正です');
  }
  const [bodyB64, sigB64] = parts;
  if (bodyB64 === undefined || sigB64 === undefined || bodyB64 === '' || sigB64 === '') {
    throw new SessionVerificationError('セッショントークンが欠損しています');
  }
  const expectedSig = crypto.createHmac('sha256', secret).update(bodyB64).digest();
  const actualSig = Buffer.from(sigB64, 'base64url');
  if (expectedSig.length !== actualSig.length || !crypto.timingSafeEqual(expectedSig, actualSig)) {
    throw new SessionVerificationError('セッショントークン署名が一致しません');
  }
  const parsed = JSON.parse(Buffer.from(bodyB64, 'base64url').toString('utf8')) as Partial<SessionContext>;
  if (
    typeof parsed.tenantId !== 'string' ||
    typeof parsed.tenantSlug !== 'string' ||
    typeof parsed.employeeId !== 'string' ||
    typeof parsed.syainCode !== 'string' ||
    typeof parsed.isAdmin !== 'boolean' ||
    typeof parsed.menuType !== 'number' ||
    typeof parsed.sessionVersion !== 'number' ||
    typeof parsed.mustChangePassword !== 'boolean' ||
    typeof parsed.exp !== 'number'
  ) {
    throw new SessionVerificationError('セッショントークンの必須項目が不足しています');
  }
  if (parsed.exp <= nowSeconds) {
    throw new SessionVerificationError('セッションの有効期限が切れています');
  }
  return {
    tenantId: parsed.tenantId,
    tenantSlug: parsed.tenantSlug,
    employeeId: parsed.employeeId,
    syainCode: parsed.syainCode,
    isAdmin: parsed.isAdmin,
    menuType: parsed.menuType,
    sessionVersion: parsed.sessionVersion,
    mustChangePassword: parsed.mustChangePassword,
    exp: parsed.exp,
  };
}
