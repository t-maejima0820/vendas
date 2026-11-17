import SalesListClient from '@/app/(dashboard)/sales/SalesListClient';
import { runWithPageSession } from '@/lib/auth/page-session';
import {
  getSalesEditorLookups,
  getSalesProductSummary,
  listSalesSlips,
} from '@/lib/sales/sales-service';

export default async function SalesPage({
  searchParams,
}: {
  searchParams: Promise<{ tab?: string }>;
}) {
  const params = await searchParams;
  const requestedTab = params.tab;

  const data = await runWithPageSession(async ({ user, tx }) => {
    const lookups = await getSalesEditorLookups(tx, user.tenantId);

    if (!lookups.salesEnabled && !lookups.tatekaeEnabled) {
      return { allowed: false as const, lookups };
    }

    let initialTab: 'SALE' | 'ADVANCE' | 'SUMMARY' = 'SALE';
    if (requestedTab === 'ADVANCE' && lookups.tatekaeEnabled) {
      initialTab = 'ADVANCE';
    } else if (requestedTab === 'SUMMARY') {
      initialTab = 'SUMMARY';
    } else if (!lookups.salesEnabled && lookups.tatekaeEnabled) {
      initialTab = 'ADVANCE';
    }

    const initialSalesPage =
      initialTab === 'SALE' && lookups.salesEnabled
        ? await listSalesSlips(tx, user.tenantId, { entryType: 'SALE', page: 1, pageSize: 2000 })
        : null;
    const initialAdvancePage =
      initialTab === 'ADVANCE' && lookups.tatekaeEnabled
        ? await listSalesSlips(tx, user.tenantId, { entryType: 'ADVANCE', page: 1, pageSize: 2000 })
        : null;
    const initialProductSummary =
      initialTab === 'SUMMARY'
        ? await getSalesProductSummary(tx, user.tenantId, { entryTypeFilter: 'ALL' })
        : null;

    const currentJstYear = Number(
      new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Tokyo', year: 'numeric' }).format(
        new Date(),
      ),
    );

    return {
      allowed: true as const,
      lookups,
      initialTab,
      initialSalesPage,
      initialAdvancePage,
      initialProductSummary,
      currentJstYear,
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
    <SalesListClient
      initialTab={data.initialTab}
      lookups={data.lookups}
      initialSalesPage={data.initialSalesPage}
      initialAdvancePage={data.initialAdvancePage}
      initialProductSummary={data.initialProductSummary}
      currentJstYear={data.currentJstYear}
    />
  );
}
