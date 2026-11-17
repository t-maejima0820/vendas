import { NextResponse } from 'next/server';
import {
  AuthServiceError,
  SessionRevokedError,
  verifyActiveSessionInDb,
  type LiveSessionUser,
} from '@/lib/auth/auth-service';
import {
  buildSessionCookieOptions,
  epochSeconds,
  SESSION_COOKIE_NAME,
  SessionVerificationError,
  verifySessionToken,
} from '@/lib/auth/session';
import { withTenantContext, type DbExecutor } from '@/lib/db/tenant-client';
import {
  FeatureDisabledError,
  requireFeature,
  type VendasFeatureCode,
} from '@/lib/feature-flags/gate';
import { MasterDataError } from '@/lib/masters/error-mapper';
import { SnapshotValidationError } from '@/lib/domain/snapshots';
import { SettingsValidationError } from '@/lib/settings/settings-service';
import { StorageOperationError } from '@/lib/storage/storage-client';

export class ApiError extends Error {
  constructor(
    readonly statusCode: number,
    readonly errorCode: string,
    readonly safeMessage: string,
  ) {
    super(safeMessage);
    this.name = 'ApiError';
  }
}

const MUTATING_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

export function verifyCsrfOrigin(req: Request): void {
  if (!MUTATING_METHODS.has(req.method.toUpperCase())) {
    return;
  }
  const originHeader = req.headers.get('origin');
  const forwardedHost = req.headers.get('x-forwarded-host');
  const rawHost = forwardedHost !== null && forwardedHost.trim() !== '' ? forwardedHost : req.headers.get('host');

  if (originHeader === null || originHeader.trim() === '' || rawHost === null || rawHost.trim() === '') {
    throw new ApiError(403, 'CSRF_ORIGIN_REQUIRED', 'リクエスト元(Origin/Host)検証に失敗しました');
  }

  let parsedOrigin: URL;
  try {
    parsedOrigin = new URL(originHeader);
  } catch (err) {
    throw new ApiError(
      403,
      'CSRF_ORIGIN_INVALID',
      err instanceof Error ? 'Origin ヘッダ形式が不正です' : 'Origin ヘッダ形式が不正です',
    );
  }

  const expectedHost = rawHost.split(',')[0]?.trim().toLowerCase();
  if (parsedOrigin.host.toLowerCase() !== expectedHost) {
    throw new ApiError(403, 'CSRF_ORIGIN_MISMATCH', 'Origin と Host が一致しません');
  }
}

export function extractClientIp(req: Request): string {
  const xff = req.headers.get('x-forwarded-for');
  if (xff !== null && xff.trim() !== '') {
    const first = xff.split(',')[0]?.trim();
    if (first !== undefined && first !== '') {
      return first;
    }
  }
  const realIp = req.headers.get('x-real-ip');
  if (realIp !== null && realIp.trim() !== '') {
    return realIp.trim();
  }
  return '127.0.0.1';
}

export function extractCookieValue(cookieHeader: string | null, cookieName: string): string | null {
  if (cookieHeader === null || cookieHeader.trim() === '') {
    return null;
  }
  const parts = cookieHeader.split(';');
  for (const part of parts) {
    const eqIdx = part.indexOf('=');
    if (eqIdx < 0) continue;
    const key = part.slice(0, eqIdx).trim();
    if (key === cookieName) {
      return decodeURIComponent(part.slice(eqIdx + 1).trim());
    }
  }
  return null;
}

function handleSanitizedError(req: Request, err: unknown): NextResponse {
  if (err instanceof ApiError) {
    return NextResponse.json(
      { ok: false, errorCode: err.errorCode, error: err.safeMessage },
      { status: err.statusCode },
    );
  }
  if (err instanceof AuthServiceError) {
    const res = NextResponse.json(
      { ok: false, errorCode: err.errorCode, error: err.safeMessage },
      { status: err.statusCode },
    );
    if (err instanceof SessionRevokedError) {
      res.cookies.set(SESSION_COOKIE_NAME, '', buildSessionCookieOptions(0));
    }
    return res;
  }
  if (err instanceof SettingsValidationError) {
    return NextResponse.json(
      { ok: false, errorCode: 'SETTINGS_VALIDATION_ERROR', error: err.safeMessage },
      { status: err.statusCode },
    );
  }
  if (err instanceof MasterDataError) {
    return NextResponse.json(
      { ok: false, errorCode: err.errorCode, error: err.safeMessage },
      { status: err.statusCode },
    );
  }
  if (err instanceof SnapshotValidationError) {
    return NextResponse.json(
      { ok: false, errorCode: 'SNAPSHOT_VALIDATION_ERROR', error: err.message },
      { status: 400 },
    );
  }
  if (err instanceof StorageOperationError) {
    console.error('[STORAGE_OPERATION_ERROR]', {
      method: req.method,
      url: req.url,
      message: err.message,
    });
    return NextResponse.json(
      {
        ok: false,
        errorCode: 'STORAGE_OPERATION_ERROR',
        error: '添付ファイルストレージの操作中にエラーが発生しました。',
      },
      { status: 502 },
    );
  }
  if (err instanceof FeatureDisabledError) {
    return NextResponse.json(
      { ok: false, errorCode: 'FEATURE_DISABLED', error: err.message },
      { status: 403 },
    );
  }
  if (err instanceof SessionVerificationError) {
    const res = NextResponse.json(
      { ok: false, errorCode: 'INVALID_SESSION', error: '認証セッションが無効です。再度ログインしてください。' },
      { status: 401 },
    );
    res.cookies.set(SESSION_COOKIE_NAME, '', buildSessionCookieOptions(0));
    return res;
  }

  console.error('[API_UNHANDLED_ERROR]', {
    method: req.method,
    url: req.url,
    errorName: err instanceof Error ? err.name : 'UnknownError',
    message: err instanceof Error ? err.message : String(err),
  });
  return NextResponse.json(
    { ok: false, errorCode: 'INTERNAL_ERROR', error: 'サーバー処理中にエラーが発生しました。' },
    { status: 500 },
  );
}

export function withPublicApiHandler(
  fn: (ctx: { req: Request; clientIp: string }) => Promise<NextResponse>,
): (req: Request) => Promise<NextResponse> {
  return async (req: Request): Promise<NextResponse> => {
    try {
      verifyCsrfOrigin(req);
      const clientIp = extractClientIp(req);
      return await fn({ req, clientIp });
    } catch (err) {
      return handleSanitizedError(req, err);
    }
  };
}

export interface ApiHandlerOptions {
  requireAdmin?: boolean;
  requiredFeature?: VendasFeatureCode;
  allowMustChangePassword?: boolean;
}

export function withApiHandler(
  options: ApiHandlerOptions,
  fn: (ctx: { req: Request; user: LiveSessionUser; tx: DbExecutor }) => Promise<NextResponse>,
): (req: Request) => Promise<NextResponse> {
  return async (req: Request): Promise<NextResponse> => {
    try {
      verifyCsrfOrigin(req);

      const rawToken = extractCookieValue(req.headers.get('cookie'), SESSION_COOKIE_NAME);
      if (rawToken === null || rawToken === '') {
        throw new ApiError(401, 'UNAUTHORIZED', 'ログインが必要です。');
      }

      const nowSeconds = epochSeconds();
      const tokenSession = verifySessionToken(rawToken, nowSeconds);

      return await withTenantContext(tokenSession, async (tx) => {
        const liveUser = await verifyActiveSessionInDb(tx, tokenSession);

        if (liveUser.mustChangePassword && options.allowMustChangePassword !== true) {
          throw new ApiError(
            403,
            'PASSWORD_CHANGE_REQUIRED',
            '初回パスワードの変更が必要です。',
          );
        }

        if (options.requireAdmin === true && !liveUser.isAdmin) {
          throw new ApiError(403, 'ADMIN_REQUIRED', 'この操作には管理者権限が必要です。');
        }

        if (options.requiredFeature !== undefined) {
          await requireFeature(tx, liveUser.tenantId, options.requiredFeature);
        }

        return fn({ req, user: liveUser, tx });
      });
    } catch (err) {
      return handleSanitizedError(req, err);
    }
  };
}
