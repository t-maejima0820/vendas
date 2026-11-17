import BillingListClient from '@/app/(dashboard)/billing/BillingListClient';
import { runWithPageSession } from '@/lib/auth/page-session';
import {
  getBillingLookups,
  listBillingCandidates,
  listBillingHeaders,
} from '@/lib/billing/billing-service';

export default async function BillingPage({
  searchParams,
}: {
  searchParams: Promise<{ tab?: string }>;
}) {
  const params = await searchParams;
  const requestedTab = params.tab;
  const todayIso = new Date().toISOString().slice(0, 10);

  const data = await runWithPageSession(async ({ user, tx }) => {
    const lookups = await getBillingLookups(tx, user.tenantId);
    if (!lookups.billsummaryEnabled && !lookups.billissueEnabled && !lookups.fixedbillEnabled) {
      return { allowed: false as const, lookups };
    }

    let initialTab: 'CANDIDATES' | 'ISSUED' = 'CANDIDATES';
    if (requestedTab === 'ISSUED') {
      initialTab = 'ISSUED';
    } else if (!lookups.billsummaryEnabled && !lookups.billissueEnabled && lookups.fixedbillEnabled) {
      initialTab = 'ISSUED';
    }

    const canReadCandidates = lookups.billsummaryEnabled || lookups.billissueEnabled;
    const [initialCandidates, initialBillings] = await Promise.all([
      canReadCandidates ? listBillingCandidates(tx, user.tenantId, {}) : Promise.resolve(null),
      listBillingHeaders(tx, user.tenantId, { page: 1, pageSize: 25 }),
    ]);

    return {
      allowed: true as const,
      lookups,
      initialTab,
      initialCandidates,
      initialBillings,
    };
  });

  if (!data.allowed) {
    return (
      <div className="max-w-2xl rounded-xl border border-amber-200 bg-amber-50 p-6 text-sm text-amber-900">
        <h1 className="text-lg font-bold mb-1">アクセス権限がありません</h1>
        <p>このテナントでは請求管理関連の機能フラグ（billsummary / billissue / fixedbill）が有効化されていません。</p>
      </div>
    );
  }

  return (
    <BillingListClient
      initialTab={data.initialTab}
      defaultBillingDate={todayIso}
      lookups={data.lookups}
      initialCandidates={data.initialCandidates}
      initialBillings={data.initialBillings}
    />
  );
}
