import { cookies } from 'next/headers';
import Link from 'next/link';
import { redirect } from 'next/navigation';
import SettingsClient from '@/app/(dashboard)/settings/SettingsClient';
import { verifyActiveSessionInDb } from '@/lib/auth/auth-service';
import { epochSeconds, SESSION_COOKIE_NAME, verifySessionToken } from '@/lib/auth/session';
import { withTenantContext } from '@/lib/db/tenant-client';
import { requireEnv } from '@/lib/env';
import { getTenantSettingsForAdmin } from '@/lib/settings/settings-service';

export default async function SettingsPage() {
  const cookieStore = await cookies();
  const rawToken = cookieStore.get(SESSION_COOKIE_NAME)?.value;
  if (rawToken === undefined || rawToken === '') {
    redirect('/login');
  }

  const tokenSession = verifySessionToken(rawToken, epochSeconds());
  const encKey = requireEnv('FIELD_ENCRYPTION_KEY_HEX');

  const result = await withTenantContext(tokenSession, async (tx) => {
    const live = await verifyActiveSessionInDb(tx, tokenSession);
    if (!live.isAdmin) {
      return { authorized: false as const };
    }
    const settings = await getTenantSettingsForAdmin(tx, live.tenantId, encKey);
    return { authorized: true as const, settings };
  });

  if (!result.authorized) {
    return (
      <div className="max-w-xl rounded-xl bg-white border border-red-200 p-6 shadow-xs">
        <h1 className="text-lg font-bold text-red-700">アクセス権限がありません（403）</h1>
        <p className="text-sm text-slate-600 mt-2">
          自社・システム・機能権限設定画面は管理者権限を持つ社員のみアクセスできます。
        </p>
        <Link
          href="/"
          className="inline-block mt-4 text-sm font-medium text-blue-600 hover:underline"
        >
          ← ダッシュボードトップに戻る
        </Link>
      </div>
    );
  }

  return <SettingsClient initialData={result.settings} />;
}
