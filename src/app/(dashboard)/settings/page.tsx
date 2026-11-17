import Link from 'next/link';
import SettingsClient from '@/app/(dashboard)/settings/SettingsClient';
import { runWithPageSession } from '@/lib/auth/page-session';
import { requireEnv } from '@/lib/env';
import { getTenantSettingsForAdmin } from '@/lib/settings/settings-service';

export default async function SettingsPage() {
  const encKey = requireEnv('FIELD_ENCRYPTION_KEY_HEX');

  const result = await runWithPageSession(async ({ user, tx }) => {
    if (!user.isAdmin) {
      return { authorized: false as const };
    }
    const settings = await getTenantSettingsForAdmin(tx, user.tenantId, encKey);
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
