import EstimateEditorClient from '@/app/(dashboard)/estimates/EstimateEditorClient';
import { runWithPageSession } from '@/lib/auth/page-session';
import { getEstimateEditorLookups } from '@/lib/estimates/estimates-service';
import { FeatureDisabledError, requireFeature } from '@/lib/feature-flags/gate';

export default async function NewEstimatePage() {
  const result = await runWithPageSession(async ({ user, tx }) => {
    try {
      await requireFeature(tx, user.tenantId, 'estimate');
      const lookups = await getEstimateEditorLookups(tx, user.tenantId);
      return { allowed: true as const, lookups };
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

  return <EstimateEditorClient mode="create" lookups={result.lookups} initialDetail={null} />;
}
