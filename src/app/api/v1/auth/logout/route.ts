import { NextResponse } from 'next/server';
import { withPublicApiHandler } from '@/lib/api/handler';
import { buildSessionCookieOptions, SESSION_COOKIE_NAME } from '@/lib/auth/session';

export const POST = withPublicApiHandler(async () => {
  const response = NextResponse.json({ ok: true });
  response.cookies.set(SESSION_COOKIE_NAME, '', buildSessionCookieOptions(0));
  return response;
});
