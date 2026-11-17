import Link from 'next/link';
import EstimateEditorClient from '@/app/(dashboard)/estimates/EstimateEditorClient';
import { runWithPageSession } from '@/lib/auth/page-session';
import {
  getEstimateEditorLookups,
  getQuotationDetail,
} from '@/lib/estimates/estimates-service';
import { FeatureDisabledError, requireFeature } from '@/lib/feature-flags/gate';
import { MasterDataError } from '@/lib/masters/error-mapper';

export default async function EstimateDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;

  const result = await runWithPageSession(async ({ user, tx }) => {
    try {
      await requireFeature(tx, user.tenantId, 'estimate');
      const [lookups, detail] = await Promise.all([
        getEstimateEditorLookups(tx, user.tenantId),
        getQuotationDetail(tx, user.tenantId, id),
      ]);
      return { status: 'ok' as const, lookups, detail };
    } catch (err) {
      if (err instanceof FeatureDisabledError) {
        return { status: 'forbidden' as const, message: err.message };
      }
      if (err instanceof MasterDataError && (err.statusCode === 404 || err.statusCode === 400)) {
        return { status: 'not_found' as const, message: err.safeMessage };
      }
      throw err;
    }
  });

  if (result.status === 'forbidden') {
    return (
      <div className="max-w-2xl rounded-xl border border-amber-200 bg-amber-50 p-6 text-sm text-amber-900">
        <h1 className="text-lg font-bold mb-1">アクセス権限がありません</h1>
        <p>{result.message}</p>
      </div>
    );
  }

  if (result.status === 'not_found') {
    return (
      <div className="max-w-2xl rounded-xl border border-slate-200 bg-white p-6 space-y-3">
        <h1 className="text-lg font-bold text-slate-900">見積データが見つかりません</h1>
        <p className="text-sm text-slate-600">{result.message}</p>
        <Link
          href="/estimates"
          className="inline-block rounded-lg bg-slate-800 px-4 py-2 text-xs font-semibold text-white"
        >
          見積一覧へ戻る
        </Link>
      </div>
    );
  }

  return (
    <EstimateEditorClient
      mode="edit"
      lookups={result.lookups}
      initialDetail={result.detail}
    />
  );
}
