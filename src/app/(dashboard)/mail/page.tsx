import MailClient from '@/app/(dashboard)/mail/MailClient';
import { runWithPageSession } from '@/lib/auth/page-session';
import { isFeatureEnabled } from '@/lib/feature-flags/gate';
import { getMailOverview } from '@/lib/mail/mail-service';

export default async function MailPage() {
  const data = await runWithPageSession(async ({ user, tx }) => {
    const mailEnabled = await isFeatureEnabled(tx, user.tenantId, 'mail');
    if (!mailEnabled) {
      return { allowed: false as const };
    }
    const initialOverview = await getMailOverview(tx, user.tenantId, {});
    return { allowed: true as const, initialOverview };
  });

  if (!data.allowed) {
    return (
      <div className="max-w-2xl rounded-xl border border-amber-200 bg-amber-50 p-6 text-sm text-amber-900">
        <h1 className="text-lg font-bold mb-1">アクセス権限がありません</h1>
        <p>このテナントでは「メール送信支援」機能（mail）が有効化されていません。</p>
      </div>
    );
  }

  return <MailClient initialOverview={data.initialOverview} />;
}
