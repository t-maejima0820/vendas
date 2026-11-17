import SubscriptionsClient from '@/app/(dashboard)/subscriptions/SubscriptionsClient';
import { runWithPageSession } from '@/lib/auth/page-session';
import { FeatureDisabledError, requireFeature } from '@/lib/feature-flags/gate';
import {
  getSubscriptionLookups,
  listMonthlyApprovalFlows,
  listSubscriptionBillings,
  listSubscriptionContracts,
} from '@/lib/subscriptions/subscriptions-service';

function currentYearMonth(): string {
  const now = new Date();
  const y = String(now.getFullYear());
  const m = String(now.getMonth() + 1).padStart(2, '0');
  return `${y}${m}`;
}

export default async function SubscriptionsPage() {
  const result = await runWithPageSession(async ({ user, tx }) => {
    try {
      await requireFeature(tx, user.tenantId, 'fixedbill');
      const targetMonth = currentYearMonth();
      const [lookups, initialContracts, initialMonthlyFlows, initialBillingHistory] =
        await Promise.all([
          getSubscriptionLookups(tx, user.tenantId),
          listSubscriptionContracts(tx, user.tenantId, {}),
          listMonthlyApprovalFlows(tx, user.tenantId, targetMonth, {}),
          listSubscriptionBillings(tx, user.tenantId, targetMonth),
        ]);
      return {
        allowed: true as const,
        lookups,
        initialContracts,
        initialMonthlyFlows,
        initialBillingHistory,
      };
    } catch (err) {
      if (err instanceof FeatureDisabledError) {
        return { allowed: false as const, message: err.message };
      }
      throw err;
    }
  });

  if (!result.allowed) {
    return (
      <div className="max-w-2xl rounded-xl border border-amber-200 bg-amber-50 p-6 text-sm text-amber-900">
        <h1 className="text-lg font-bold mb-1">アクセス権限がありません</h1>
        <p>{result.message}</p>
      </div>
    );
  }

  return (
    <SubscriptionsClient
      lookups={result.lookups}
      initialContracts={result.initialContracts}
      initialMonthlyFlows={result.initialMonthlyFlows}
      initialBillingHistory={result.initialBillingHistory}
    />
  );
}
