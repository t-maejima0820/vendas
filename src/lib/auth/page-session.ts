import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import { cache } from 'react';
import type { NavFeatureItem } from '@/components/DashboardShell';
import type { LiveSessionUser } from '@/lib/auth/auth-service';
import {
  epochSeconds,
  SESSION_COOKIE_NAME,
  SessionVerificationError,
  type SessionContext,
  verifySessionToken,
} from '@/lib/auth/session';
import { withTenantContext, type DbExecutor } from '@/lib/db/tenant-client';
import { primeFeatureCacheForTx } from '@/lib/feature-flags/gate';

interface SessionFeatureRow {
  feature_code: string;
  feature_name: string;
  display_order: number;
  is_enabled: boolean;
}

interface PageSessionDbRow extends Record<string, unknown> {
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
  company_name: string | null;
  features_json: SessionFeatureRow[] | string;
}

export type LoadedPageSessionContext =
  | {
      ok: true;
      liveUser: LiveSessionUser;
      companyName: string;
      enabledFeatures: NavFeatureItem[];
      featureFlags: Map<string, boolean>;
    }
  | {
      ok: false;
      reason: 'UNAUTHENTICATED' | 'REVOKED';
    };

function parseFeatureRows(raw: SessionFeatureRow[] | string): SessionFeatureRow[] {
  if (Array.isArray(raw)) {
    return raw;
  }
  const parsed = JSON.parse(raw) as unknown;
  if (!Array.isArray(parsed)) {
    throw new Error('テナント機能権限JSONの形式が不正です');
  }
  return parsed as SessionFeatureRow[];
}

type SharedSessionOutcome =
  | { kind: 'OK'; ctx: LoadedPageSessionContext }
  | { kind: 'ERR'; err: unknown };

interface RequestSessionTracker {
  standalonePromise: Promise<SharedSessionOutcome> | null;
  resolved: LoadedPageSessionContext | null;
}

const getRequestSessionTracker = cache((): RequestSessionTracker => ({
  standalonePromise: null,
  resolved: null,
}));

type TokenReadResult =
  | { ok: true; session: SessionContext }
  | { ok: false; ctx: LoadedPageSessionContext };

async function readVerifiedTokenSession(): Promise<TokenReadResult> {
  const cookieStore = await cookies();
  const rawToken = cookieStore.get(SESSION_COOKIE_NAME)?.value;
  if (rawToken === undefined || rawToken === '') {
    return { ok: false, ctx: { ok: false, reason: 'UNAUTHENTICATED' } };
  }

  try {
    return { ok: true, session: verifySessionToken(rawToken, epochSeconds()) };
  } catch (err) {
    if (err instanceof SessionVerificationError || err instanceof SyntaxError) {
      return { ok: false, ctx: { ok: false, reason: 'UNAUTHENTICATED' } };
    }
    throw err;
  }
}

async function querySessionContextWithTx(
  tx: DbExecutor,
  tokenSession: SessionContext,
): Promise<LoadedPageSessionContext> {
  const rows = await tx.query<PageSessionDbRow>(
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
            t.is_active AS tenant_is_active,
            (SELECT ts.company_name
               FROM tenant_settings ts
              WHERE ts.tenant_id = t.id
              LIMIT 1) AS company_name,
            COALESCE(
              (
                SELECT json_agg(
                  json_build_object(
                    'feature_code', tfa.feature_code,
                    'feature_name', tfa.feature_name,
                    'display_order', tfa.display_order,
                    'is_enabled', tfa.is_enabled
                  )
                  ORDER BY tfa.display_order ASC, tfa.feature_code ASC
                )
                  FROM tenant_feature_authorities tfa
                 WHERE tfa.tenant_id = t.id
              ),
              '[]'::json
            ) AS features_json
       FROM employees e
       INNER JOIN tenants t ON t.id = e.tenant_id
      WHERE e.id = $1
        AND e.tenant_id = $2
      LIMIT 1`,
    [tokenSession.employeeId, tokenSession.tenantId],
  );

  const row = rows[0];
  if (
    row === undefined ||
    !row.tenant_is_active ||
    row.is_retired ||
    Number(row.session_version) !== tokenSession.sessionVersion
  ) {
    return { ok: false, reason: 'REVOKED' };
  }

  const featureRows = parseFeatureRows(row.features_json);
  const enabledFeatures: NavFeatureItem[] = [];
  const featureFlags = new Map<string, boolean>();
  for (const f of featureRows) {
    const enabled = f.is_enabled === true;
    featureFlags.set(f.feature_code, enabled);
    if (enabled) {
      enabledFeatures.push({
        featureCode: f.feature_code,
        featureName: f.feature_name,
        displayOrder: Number(f.display_order),
      });
    }
  }

  const liveUser: LiveSessionUser = {
    tenantId: row.tenant_id,
    tenantSlug: row.tenant_slug,
    tenantName: row.tenant_name,
    employeeId: row.employee_id,
    syainCode: row.syain_code,
    syainName: row.syain_name,
    isAdmin: row.is_admin,
    menuType: Number(row.menu_type),
    sessionVersion: Number(row.session_version),
    mustChangePassword: row.must_change_password,
    exp: tokenSession.exp,
  };

  const companyName =
    row.company_name !== null && row.company_name !== '' ? row.company_name : row.tenant_name;

  return {
    ok: true,
    liveUser,
    companyName,
    enabledFeatures,
    featureFlags,
  };
}

/**
 * 同一SSRリクエスト内で Layout と Page が認証・会社名・機能権限を共有するための React.cache() ヘルパ。
 * リクエストを跨ぐグローバルメモリキャッシュは持たず、session_version 失効や機能切替が即時反映される。
 */
export async function loadPageSessionContext(): Promise<LoadedPageSessionContext> {
  const tracker = getRequestSessionTracker();
  if (tracker.resolved !== null) {
    return tracker.resolved;
  }
  if (tracker.standalonePromise === null) {
    tracker.standalonePromise = (async (): Promise<SharedSessionOutcome> => {
      try {
        const tokenRead = await readVerifiedTokenSession();
        if (!tokenRead.ok) {
          tracker.resolved = tokenRead.ctx;
          return { kind: 'OK', ctx: tokenRead.ctx };
        }
        const loaded = await withTenantContext(tokenRead.session, (tx) =>
          querySessionContextWithTx(tx, tokenRead.session),
        );
        tracker.resolved = loaded;
        return { kind: 'OK', ctx: loaded };
      } catch (err) {
        return { kind: 'ERR', err };
      }
    })();
  }
  const outcome = await tracker.standalonePromise;
  if (outcome.kind === 'ERR') {
    throw outcome.err;
  }
  return outcome.ctx;
}

/**
 * 同一リクエスト内の既存検証済みユーザーを取得する（追加DBクエリを発行しない）
 */
export async function requireLivePageUser(): Promise<LiveSessionUser> {
  const ctx = await loadPageSessionContext();
  if (!ctx.ok) {
    redirect('/login');
  }
  if (ctx.liveUser.mustChangePassword) {
    redirect('/change-password');
  }
  return ctx.liveUser;
}

/**
 * SSR ページ向けセッション検証＋RLS トランザクションラッパー。
 * Layout 実行時は React.cache() で認証結果を共有し、
 * Layout が走らない RSC クライアント遷移時は 1 トランザクション内で認証・権限取得とページ業務処理を連続実行する。
 */
export async function runWithPageSession<T>(
  fn: (ctx: { user: LiveSessionUser; tx: DbExecutor }) => Promise<T>,
): Promise<T> {
  const tracker = getRequestSessionTracker();

  if (tracker.resolved !== null || tracker.standalonePromise !== null) {
    const ctx = tracker.resolved ?? (await loadPageSessionContext());
    if (!ctx.ok) {
      redirect('/login');
    }
    if (ctx.liveUser.mustChangePassword) {
      redirect('/change-password');
    }

    return withTenantContext(ctx.liveUser, async (tx) => {
      primeFeatureCacheForTx(tx, ctx.liveUser.tenantId, ctx.featureFlags);
      return fn({ user: ctx.liveUser, tx });
    });
  }

  let resolveShared: (outcome: SharedSessionOutcome) => void = () => undefined;
  tracker.standalonePromise = new Promise<SharedSessionOutcome>((resolve) => {
    resolveShared = resolve;
  });

  let tokenRead: TokenReadResult;
  try {
    tokenRead = await readVerifiedTokenSession();
  } catch (err) {
    resolveShared({ kind: 'ERR', err });
    throw err;
  }

  if (!tokenRead.ok) {
    tracker.resolved = tokenRead.ctx;
    resolveShared({ kind: 'OK', ctx: tokenRead.ctx });
    redirect('/login');
  }

  const tokenSession = tokenRead.session;
  const txOutcome = await withTenantContext(tokenSession, async (tx) => {
    let ctx: LoadedPageSessionContext;
    try {
      ctx = await querySessionContextWithTx(tx, tokenSession);
    } catch (err) {
      resolveShared({ kind: 'ERR', err });
      throw err;
    }

    tracker.resolved = ctx;
    resolveShared({ kind: 'OK', ctx });

    if (!ctx.ok) {
      return { status: 'UNAUTHENTICATED' as const };
    }
    if (ctx.liveUser.mustChangePassword) {
      return { status: 'MUST_CHANGE_PASSWORD' as const };
    }

    primeFeatureCacheForTx(tx, ctx.liveUser.tenantId, ctx.featureFlags);
    const data = await fn({ user: ctx.liveUser, tx });
    return { status: 'OK' as const, data };
  });

  if (txOutcome.status === 'UNAUTHENTICATED') {
    redirect('/login');
  }
  if (txOutcome.status === 'MUST_CHANGE_PASSWORD') {
    redirect('/change-password');
  }
  return txOutcome.data;
}
