import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import {
  SessionRevokedError,
  verifyActiveSessionInDb,
  type LiveSessionUser,
} from '@/lib/auth/auth-service';
import {
  epochSeconds,
  SESSION_COOKIE_NAME,
  SessionVerificationError,
  verifySessionToken,
} from '@/lib/auth/session';
import { withTenantContext, type DbExecutor } from '@/lib/db/tenant-client';

type PageLoadResult<T> =
  | { ok: true; data: T }
  | { ok: false; redirectTo: '/login' | '/change-password' };

/**
 * Verifies the active session cookie in SSR pages and executes callback inside RLS tenant context.
 * Redirects outside try/catch so Next.js NEXT_REDIRECT errors are never swallowed.
 */
export async function runWithPageSession<T>(
  fn: (ctx: { user: LiveSessionUser; tx: DbExecutor }) => Promise<T>,
): Promise<T> {
  const cookieStore = await cookies();
  const rawToken = cookieStore.get(SESSION_COOKIE_NAME)?.value;
  if (rawToken === undefined || rawToken === '') {
    redirect('/login');
  }

  let tokenSession;
  try {
    tokenSession = verifySessionToken(rawToken, epochSeconds());
  } catch (err) {
    if (err instanceof SessionVerificationError || err instanceof SyntaxError) {
      redirect('/login');
    }
    throw err;
  }

  let outcome: PageLoadResult<T>;
  try {
    outcome = await withTenantContext(tokenSession, async (tx) => {
      const liveUser = await verifyActiveSessionInDb(tx, tokenSession);
      if (liveUser.mustChangePassword) {
        return { ok: false, redirectTo: '/change-password' };
      }
      const data = await fn({ user: liveUser, tx });
      return { ok: true, data };
    });
  } catch (err) {
    if (err instanceof SessionRevokedError) {
      redirect('/login');
    }
    throw err;
  }

  if (!outcome.ok) {
    redirect(outcome.redirectTo);
  }
  return outcome.data;
}
