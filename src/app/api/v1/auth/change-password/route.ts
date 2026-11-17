import { NextResponse } from 'next/server';
import { ApiError, withApiHandler } from '@/lib/api/handler';
import { changeEmployeePassword } from '@/lib/auth/auth-service';
import { buildSessionCookieOptions, SESSION_COOKIE_NAME } from '@/lib/auth/session';

export const POST = withApiHandler({ allowMustChangePassword: true }, async ({ req, user, tx }) => {
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
    throw new ApiError(400, 'INVALID_PAYLOAD', 'リクエスト内容が不正です。');
  }

  const body = rawBody as Record<string, unknown>;
  const currentPassword = typeof body['currentPassword'] === 'string' ? body['currentPassword'] : '';
  const newPassword = typeof body['newPassword'] === 'string' ? body['newPassword'] : '';

  if (currentPassword === '' || newPassword === '') {
    throw new ApiError(400, 'MISSING_PASSWORD', '現在のパスワードと新しいパスワードを入力してください。');
  }

  const updated = await changeEmployeePassword(tx, {
    session: user,
    currentPassword,
    newPassword,
  });

  const response = NextResponse.json({
    ok: true,
    user: {
      tenantSlug: updated.session.tenantSlug,
      syainCode: updated.session.syainCode,
      sessionVersion: updated.session.sessionVersion,
      mustChangePassword: updated.session.mustChangePassword,
    },
  });

  response.cookies.set(SESSION_COOKIE_NAME, updated.token, buildSessionCookieOptions());
  return response;
});
