import ProjectsClient from '@/app/(dashboard)/projects/ProjectsClient';
import { runWithPageSession } from '@/lib/auth/page-session';
import { isFeatureEnabled } from '@/lib/feature-flags/gate';
import { getProjectsLookups, listProjects } from '@/lib/projects/projects-service';

export default async function ProjectsPage() {
  const todayIso = new Date().toISOString().slice(0, 10);

  const data = await runWithPageSession(async ({ user, tx }) => {
    const constructionEnabled = await isFeatureEnabled(tx, user.tenantId, 'construction');
    if (!constructionEnabled) {
      return { allowed: false as const };
    }

    const [lookups, initialPage] = await Promise.all([
      getProjectsLookups(tx, user.tenantId),
      listProjects(tx, user.tenantId, { page: 1, pageSize: 25 }),
    ]);

    return {
      allowed: true as const,
      lookups,
      initialPage,
    };
  });

  if (!data.allowed) {
    return (
      <div className="max-w-2xl rounded-xl border border-amber-200 bg-amber-50 p-6 text-sm text-amber-900">
        <h1 className="text-lg font-bold mb-1">アクセス権限がありません</h1>
        <p>このテナントでは「案件（工事）管理」機能（construction）が有効化されていません。</p>
      </div>
    );
  }

  return (
    <ProjectsClient
      todayIso={todayIso}
      lookups={data.lookups}
      initialPage={data.initialPage}
    />
  );
}
