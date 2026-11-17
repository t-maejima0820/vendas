export const SESSION_COOKIE_NAME = 'vendas_session';

export interface SessionContext {
  tenantId: string;
  tenantSlug: string;
  employeeId: string;
  syainCode: string;
  isAdmin: boolean;
  menuType: number;
  sessionVersion: number;
  mustChangePassword: boolean;
  exp: number;
}

function base64UrlToUint8Array(b64u: string): Uint8Array | null {
  if (!/^[A-Za-z0-9_-]+$/.test(b64u)) {
    return null;
  }
  const b64 = b64u.replace(/-/g, '+').replace(/_/g, '/');
  const padLen = (4 - (b64.length % 4)) % 4;
  const padded = b64 + '='.repeat(padLen);
  const bin = atob(padded);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i += 1) {
    bytes[i] = bin.charCodeAt(i);
  }
  return bytes;
}

export async function verifySessionTokenEdge(
  token: string,
  nowSeconds: number,
  secret: string,
): Promise<{ ok: true; session: SessionContext } | { ok: false; reason: string }> {
  const parts = token.split('.');
  if (parts.length !== 2) {
    return { ok: false, reason: 'INVALID_FORMAT' };
  }
  const [bodyB64, sigB64] = parts;
  if (bodyB64 === undefined || sigB64 === undefined || bodyB64 === '' || sigB64 === '') {
    return { ok: false, reason: 'EMPTY_PART' };
  }

  const sigBytes = base64UrlToUint8Array(sigB64);
  const bodyBytes = base64UrlToUint8Array(bodyB64);
  if (sigBytes === null || bodyBytes === null) {
    return { ok: false, reason: 'INVALID_ENCODING' };
  }

  const encoder = new TextEncoder();
  const key = await globalThis.crypto.subtle.importKey(
    'raw',
    encoder.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['verify'],
  );

  const sigBuf = Uint8Array.from(sigBytes);
  const msgBuf = Uint8Array.from(encoder.encode(bodyB64));
  const valid = await globalThis.crypto.subtle.verify('HMAC', key, sigBuf, msgBuf);
  if (!valid) {
    return { ok: false, reason: 'INVALID_SIGNATURE' };
  }

  let parsed: Partial<SessionContext>;
  try {
    const jsonText = new TextDecoder('utf-8').decode(bodyBytes);
    parsed = JSON.parse(jsonText) as Partial<SessionContext>;
  } catch (err) {
    return { ok: false, reason: err instanceof Error ? 'INVALID_JSON' : 'INVALID_JSON' };
  }

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
    return { ok: false, reason: 'MISSING_FIELDS' };
  }

  if (parsed.exp <= nowSeconds) {
    return { ok: false, reason: 'EXPIRED' };
  }

  return {
    ok: true,
    session: {
      tenantId: parsed.tenantId,
      tenantSlug: parsed.tenantSlug,
      employeeId: parsed.employeeId,
      syainCode: parsed.syainCode,
      isAdmin: parsed.isAdmin,
      menuType: parsed.menuType,
      sessionVersion: parsed.sessionVersion,
      mustChangePassword: parsed.mustChangePassword,
      exp: parsed.exp,
    },
  };
}
