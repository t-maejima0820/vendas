import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import { Suspense, type ReactNode } from 'react';
import DashboardShell, { type NavFeatureItem } from '@/components/DashboardShell';
import { SessionRevokedError, verifyActiveSessionInDb } from '@/lib/auth/auth-service';
import {
  epochSeconds,
  SESSION_COOKIE_NAME,
  SessionVerificationError,
  verifySessionToken,
} from '@/lib/auth/session';
import { withTenantContext } from '@/lib/db/tenant-client';

interface LoadedDashboardContext {
  ok: true;
  tenantName: string;
  tenantSlug: string;
  companyName: string;
  syainCode: string;
  syainName: string;
  isAdmin: boolean;
  mustChangePassword: boolean;
  enabledFeatures: NavFeatureItem[];
}

type LoadResult =
  | LoadedDashboardContext
  | { ok: false; reason: 'UNAUTHENTICATED' | 'REVOKED' };

async function loadDashboardContext(): Promise<LoadResult> {
  const cookieStore = await cookies();
  const rawToken = cookieStore.get(SESSION_COOKIE_NAME)?.value;
  if (rawToken === undefined || rawToken === '') {
    return { ok: false, reason: 'UNAUTHENTICATED' };
  }

  let tokenSession;
  try {
    tokenSession = verifySessionToken(rawToken, epochSeconds());
  } catch (err) {
    if (err instanceof SessionVerificationError || err instanceof SyntaxError) {
      return { ok: false, reason: 'UNAUTHENTICATED' };
    }
    throw err;
  }

  try {
    return await withTenantContext(tokenSession, async (tx) => {
      const liveUser = await verifyActiveSessionInDb(tx, tokenSession);
      const settingsRows = await tx.query<{ company_name: string }>(
        'SELECT company_name FROM tenant_settings WHERE tenant_id = $1 LIMIT 1',
        [liveUser.tenantId],
      );
      const featRows = await tx.query<{
        feature_code: string;
        feature_name: string;
        display_order: number;
      }>(
        `SELECT feature_code, feature_name, display_order
           FROM tenant_feature_authorities
          WHERE tenant_id = $1
            AND is_enabled = true
          ORDER BY display_order ASC, feature_code ASC`,
        [liveUser.tenantId],
      );

      const companyName =
        settingsRows[0] !== undefined ? settingsRows[0].company_name : liveUser.tenantName;

      return {
        ok: true,
        tenantName: liveUser.tenantName,
        tenantSlug: liveUser.tenantSlug,
        companyName,
        syainCode: liveUser.syainCode,
        syainName: liveUser.syainName,
        isAdmin: liveUser.isAdmin,
        mustChangePassword: liveUser.mustChangePassword,
        enabledFeatures: featRows.map((f) => ({
          featureCode: f.feature_code,
          featureName: f.feature_name,
          displayOrder: f.display_order,
        })),
      };
    });
  } catch (err) {
    if (err instanceof SessionRevokedError) {
      return { ok: false, reason: 'REVOKED' };
    }
    throw err;
  }
}

export default async function DashboardLayout({ children }: { children: ReactNode }) {
  const ctx = await loadDashboardContext();
  if (!ctx.ok) {
    redirect('/login');
  }
  if (ctx.mustChangePassword) {
    redirect('/change-password');
  }

  return (
    <Suspense fallback={<div className="p-6 text-sm text-slate-500">読み込み中...</div>}>
      <DashboardShell
        tenantName={ctx.tenantName}
        tenantSlug={ctx.tenantSlug}
        companyName={ctx.companyName}
        syainCode={ctx.syainCode}
        syainName={ctx.syainName}
        isAdmin={ctx.isAdmin}
        enabledFeatures={ctx.enabledFeatures}
      >
        {children}
      </DashboardShell>
    </Suspense>
  );
}
