import { NextResponse, type NextRequest } from 'next/server';
import { SESSION_COOKIE_NAME, verifySessionTokenEdge } from '@/lib/auth/edge-token';
import { requireEnv } from '@/lib/env';

const isDev = process.env.NODE_ENV !== 'production';
const scriptSrc = isDev ? "'self' 'unsafe-inline' 'unsafe-eval'" : "'self' 'unsafe-inline'";
const CSP_VALUE = [
  "default-src 'self'",
  `script-src ${scriptSrc}`,
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "font-src 'self' data:",
  "connect-src 'self'",
  "frame-ancestors 'none'",
  "base-uri 'self'",
  "form-action 'self'",
].join('; ');

function applySecurityHeaders(res: NextResponse): NextResponse {
  res.headers.set('X-Content-Type-Options', 'nosniff');
  res.headers.set('X-Frame-Options', 'DENY');
  res.headers.set('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.headers.set('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
  res.headers.set('Content-Security-Policy', CSP_VALUE);
  return res;
}

export async function middleware(req: NextRequest): Promise<NextResponse> {
  const { pathname } = req.nextUrl;

  if (pathname.startsWith('/api/')) {
    return applySecurityHeaders(NextResponse.next());
  }

  const secret = requireEnv('SESSION_SECRET');
  const rawToken = req.cookies.get(SESSION_COOKIE_NAME)?.value;
  const nowMs = Date.now();
  const nowSeconds = (nowMs - (nowMs % 1000)) / 1000;

  let validSession = null;
  if (rawToken !== undefined && rawToken !== '') {
    const check = await verifySessionTokenEdge(rawToken, nowSeconds, secret);
    if (check.ok) {
      validSession = check.session;
    }
  }

  if (pathname === '/login') {
    if (validSession !== null) {
      const target = validSession.mustChangePassword ? '/change-password' : '/';
      return applySecurityHeaders(NextResponse.redirect(new URL(target, req.url)));
    }
    return applySecurityHeaders(NextResponse.next());
  }

  if (validSession === null) {
    const res = NextResponse.redirect(new URL('/login', req.url));
    if (rawToken !== undefined && rawToken !== '') {
      res.cookies.delete(SESSION_COOKIE_NAME);
    }
    return applySecurityHeaders(res);
  }

  if (validSession.mustChangePassword && pathname !== '/change-password') {
    return applySecurityHeaders(NextResponse.redirect(new URL('/change-password', req.url)));
  }

  return applySecurityHeaders(NextResponse.next());
}

export const config = {
  matcher: ['/((?!_next/static|_next/image|favicon.ico).*)'],
};
