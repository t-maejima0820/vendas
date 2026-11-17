import { NextResponse } from 'next/server';
import { ApiError, withPublicApiHandler } from '@/lib/api/handler';
import { authenticateLogin } from '@/lib/auth/auth-service';
import { buildSessionCookieOptions, SESSION_COOKIE_NAME } from '@/lib/auth/session';
import { withAnonymousAuthContext } from '@/lib/db/tenant-client';

export const POST = withPublicApiHandler(async ({ req, clientIp }) => {
  let rawBody: unknown;
  try {
    rawBody = await req.json();
  } catch (err) {
    throw new ApiError(
      400,
      'INVALID_JSON',
      err instanceof Error ? 'JSON形式のリクエストが不正です。' : 'JSON形式のリクエストが不正です。',
    );
  }

  if (rawBody === null || typeof rawBody !== 'object') {
    throw new ApiError(400, 'INVALID_PAYLOAD', 'ログイン情報の形式が不正です。');
  }

  const body = rawBody as Record<string, unknown>;
  const tenantSlug = typeof body['tenantSlug'] === 'string' ? body['tenantSlug'] : '';
  const syainCode = typeof body['syainCode'] === 'string' ? body['syainCode'] : '';
  const password = typeof body['password'] === 'string' ? body['password'] : '';

  const authRes = await withAnonymousAuthContext(async (tx) =>
    authenticateLogin(tx, {
      tenantSlug,
      syainCode,
      password,
      clientIp,
    }),
  );

  const response = NextResponse.json({
    ok: true,
    user: {
      tenantId: authRes.session.tenantId,
      tenantSlug: authRes.session.tenantSlug,
      syainCode: authRes.session.syainCode,
      syainName: authRes.syainName,
      isAdmin: authRes.session.isAdmin,
      mustChangePassword: authRes.session.mustChangePassword,
    },
  });

  response.cookies.set(SESSION_COOKIE_NAME, authRes.token, buildSessionCookieOptions());
  return response;
});
