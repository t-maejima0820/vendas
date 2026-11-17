import AnalyticsClient from '@/app/(dashboard)/analytics/AnalyticsClient';
import { getCustomAnalytics } from '@/lib/analytics/analytics-service';
import { runWithPageSession } from '@/lib/auth/page-session';
import { isFeatureEnabled } from '@/lib/feature-flags/gate';

export default async function AnalyticsPage() {
  const data = await runWithPageSession(async ({ user, tx }) => {
    const [itemEnabled, sumEnabled] = await Promise.all([
      isFeatureEnabled(tx, user.tenantId, 'item'),
      isFeatureEnabled(tx, user.tenantId, 'custom-sum-item'),
    ]);
    if (!itemEnabled && !sumEnabled) {
      return { allowed: false as const };
    }

    const initialPage = await getCustomAnalytics(tx, user.tenantId, { dimension: 'PARTNER' });
    return { allowed: true as const, initialPage, sumEnabled };
  });

  if (!data.allowed) {
    return (
      <div className="max-w-2xl rounded-xl border border-amber-200 bg-amber-50 p-6 text-sm text-amber-900">
        <h1 className="text-lg font-bold mb-1">アクセス権限がありません</h1>
        <p>このテナントでは「項目・カスタム集計」機能（item / custom-sum-item）が有効化されていません。</p>
      </div>
    );
  }

  return <AnalyticsClient initialPage={data.initialPage} sumEnabled={data.sumEnabled} />;
}
