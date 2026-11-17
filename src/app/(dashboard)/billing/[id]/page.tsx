import BillingDetailClient from '@/app/(dashboard)/billing/BillingDetailClient';
import { runWithPageSession } from '@/lib/auth/page-session';
import { getBillingDetail, getBillingLookups } from '@/lib/billing/billing-service';
import { FeatureDisabledError } from '@/lib/feature-flags/gate';
import { MasterDataError } from '@/lib/masters/error-mapper';

export default async function BillingDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;

  const data = await runWithPageSession(async ({ user, tx }) => {
    try {
      const [lookups, detail] = await Promise.all([
        getBillingLookups(tx, user.tenantId),
        getBillingDetail(tx, user.tenantId, id),
      ]);
      return { ok: true as const, lookups, detail };
    } catch (err) {
      if (err instanceof FeatureDisabledError || err instanceof MasterDataError) {
        return { ok: false as const, message: err.message };
      }
      throw err;
    }
  });

  if (!data.ok) {
    return (
      <div className="max-w-2xl rounded-xl border border-amber-200 bg-amber-50 p-6 text-sm text-amber-900">
        <h1 className="text-lg font-bold mb-1">請求データを表示できません</h1>
        <p>{data.message}</p>
      </div>
    );
  }

  return <BillingDetailClient lookups={data.lookups} initialDetail={data.detail} />;
}
