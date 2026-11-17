import TatekaeListClient from '@/app/(dashboard)/tatekae/TatekaeListClient';
import { runWithPageSession } from '@/lib/auth/page-session';
import { getSalesEditorLookups, listSalesSlips } from '@/lib/sales/sales-service';

export default async function TatekaePage() {
  const data = await runWithPageSession(async ({ user, tx }) => {
    const lookups = await getSalesEditorLookups(tx, user.tenantId);

    if (!lookups.tatekaeEnabled) {
      return { allowed: false as const };
    }

    const initialAdvancePage = await listSalesSlips(tx, user.tenantId, {
      entryType: 'ADVANCE',
      page: 1,
      pageSize: 2000,
    });

    const currentJstYear = Number(
      new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Tokyo', year: 'numeric' }).format(
        new Date(),
      ),
    );

    return {
      allowed: true as const,
      lookups,
      initialAdvancePage,
      currentJstYear,
    };
  });

  if (!data.allowed) {
    return (
      <div className="max-w-2xl rounded-xl border border-amber-200 bg-amber-50 p-6 text-sm text-amber-900">
        <h1 className="text-lg font-bold mb-1">アクセス権限がありません</h1>
        <p>このテナントでは「立替金」機能が有効化されていません。</p>
      </div>
    );
  }

  return (
    <TatekaeListClient
      lookups={data.lookups}
      initialAdvancePage={data.initialAdvancePage}
      currentJstYear={data.currentJstYear}
    />
  );
}
