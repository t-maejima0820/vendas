import SalesEditorClient from '@/app/(dashboard)/sales/SalesEditorClient';
import { runWithPageSession } from '@/lib/auth/page-session';
import { FeatureDisabledError } from '@/lib/feature-flags/gate';
import { assertSalesFeature, getSalesEditorLookups } from '@/lib/sales/sales-service';
import type { SalesEntryType } from '@/lib/sales/types';

export default async function NewSalesPage({
  searchParams,
}: {
  searchParams: Promise<{ entryType?: string }>;
}) {
  const params = await searchParams;
  const initialEntryType: SalesEntryType =
    params.entryType === 'ADVANCE' ? 'ADVANCE' : 'SALE';

  const result = await runWithPageSession(async ({ user, tx }) => {
    try {
      await assertSalesFeature(tx, user.tenantId, initialEntryType);
      const lookups = await getSalesEditorLookups(tx, user.tenantId);
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

  return (
    <SalesEditorClient
      mode="create"
      initialEntryType={initialEntryType}
      lookups={result.lookups}
      initialDetail={null}
    />
  );
}
