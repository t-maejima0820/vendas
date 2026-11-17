import ProjectDetailClient from '@/app/(dashboard)/projects/[id]/ProjectDetailClient';
import { runWithPageSession } from '@/lib/auth/page-session';
import { isFeatureEnabled } from '@/lib/feature-flags/gate';
import { MasterDataError } from '@/lib/masters/error-mapper';
import { listCandidatePurchasesForProjectCost } from '@/lib/project-costs/project-costs-service';
import type { CandidatePurchaseForCostDto } from '@/lib/project-costs/types';
import { getProjectDetail, getProjectsLookups } from '@/lib/projects/projects-service';

export default async function ProjectDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const todayIso = new Date().toISOString().slice(0, 10);

  const data = await runWithPageSession(async ({ user, tx }) => {
    const constructionEnabled = await isFeatureEnabled(tx, user.tenantId, 'construction');
    if (!constructionEnabled) {
      return { status: 'FORBIDDEN' as const };
    }

    const lookups = await getProjectsLookups(tx, user.tenantId);

    try {
      const detail = await getProjectDetail(tx, user.tenantId, id);
      const candidates: CandidatePurchaseForCostDto[] = lookups.costEnabled
        ? await listCandidatePurchasesForProjectCost(tx, user.tenantId, id)
        : [];
      return {
        status: 'OK' as const,
        lookups,
        detail,
        candidates,
      };
    } catch (err) {
      if (err instanceof MasterDataError && (err.statusCode === 404 || err.statusCode === 400)) {
        return { status: 'NOT_FOUND' as const, message: err.message };
      }
      throw err;
    }
  });

  if (data.status === 'FORBIDDEN') {
    return (
      <div className="max-w-2xl rounded-xl border border-amber-200 bg-amber-50 p-6 text-sm text-amber-900">
        <h1 className="text-lg font-bold mb-1">アクセス権限がありません</h1>
        <p>このテナントでは「案件（工事）管理」機能（construction）が有効化されていません。</p>
      </div>
    );
  }

  if (data.status === 'NOT_FOUND') {
    return (
      <div className="max-w-2xl rounded-xl border border-red-200 bg-red-50 p-6 text-sm text-red-900">
        <h1 className="text-lg font-bold mb-1">案件が見つかりません</h1>
        <p>{data.message}</p>
      </div>
    );
  }

  return (
    <ProjectDetailClient
      todayIso={todayIso}
      lookups={data.lookups}
      initialDetail={data.detail}
      initialCandidates={data.candidates}
    />
  );
}
