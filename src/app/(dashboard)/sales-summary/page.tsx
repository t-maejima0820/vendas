import SalesSummaryClient from '@/app/(dashboard)/sales-summary/SalesSummaryClient';
import { runWithPageSession } from '@/lib/auth/page-session';
import { getSalesEditorLookups, getSalesProductSummary } from '@/lib/sales/sales-service';

export default async function SalesSummaryPage() {
  const data = await runWithPageSession(async ({ user, tx }) => {
    const lookups = await getSalesEditorLookups(tx, user.tenantId);

    if (!lookups.salesEnabled && !lookups.tatekaeEnabled) {
      return { allowed: false as const };
    }

    const initialProductSummary = await getSalesProductSummary(tx, user.tenantId, {
      entryTypeFilter: 'ALL',
    });

    return {
      allowed: true as const,
      lookups,
      initialProductSummary,
    };
  });

  if (!data.allowed) {
    return (
      <div className="max-w-2xl rounded-xl border border-amber-200 bg-amber-50 p-6 text-sm text-amber-900">
        <h1 className="text-lg font-bold mb-1">アクセス権限がありません</h1>
        <p>このテナントでは「売上」「立替金」機能のいずれも有効化されていません。</p>
      </div>
    );
  }

  return (
    <SalesSummaryClient
      lookups={data.lookups}
      initialProductSummary={data.initialProductSummary}
    />
  );
}
