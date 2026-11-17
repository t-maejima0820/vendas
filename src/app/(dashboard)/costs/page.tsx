import CostsClient, { type CostProjectOption } from '@/app/(dashboard)/costs/CostsClient';
import { runWithPageSession } from '@/lib/auth/page-session';
import type { CostCategory } from '@/lib/domain/calculations';
import { isFeatureEnabled } from '@/lib/feature-flags/gate';
import { listProjectCosts } from '@/lib/project-costs/project-costs-service';
import { getProjectsLookups } from '@/lib/projects/projects-service';
import type { ProjectStatus } from '@/lib/projects/types';

function parseCategoryParam(raw: string | undefined): CostCategory | null {
  if (
    raw === 'EXPENSE' ||
    raw === 'LABOR' ||
    raw === 'MATERIAL' ||
    raw === 'OUTSOURCING' ||
    raw === 'TEMPORARY' ||
    raw === 'INDIRECT'
  ) {
    return raw;
  }
  return null;
}

export default async function CostsPage({
  searchParams,
}: {
  searchParams: Promise<{ projectId?: string; category?: string }>;
}) {
  const params = await searchParams;
  const initialCategory = parseCategoryParam(params.category);
  const initialProjectId =
    params.projectId !== undefined && params.projectId.trim() !== ''
      ? params.projectId.trim()
      : null;
  const todayIso = new Date().toISOString().slice(0, 10);

  const data = await runWithPageSession(async ({ user, tx }) => {
    const costEnabled = await isFeatureEnabled(tx, user.tenantId, 'cost');
    if (!costEnabled) {
      return { allowed: false as const };
    }

    const [lookups, initialPage, projectRows] = await Promise.all([
      getProjectsLookups(tx, user.tenantId),
      listProjectCosts(tx, user.tenantId, {
        projectId: initialProjectId,
        costCategory: initialCategory,
        page: 1,
        pageSize: 25,
      }),
      tx.query<{
        id: string;
        project_no: string;
        project_name: string;
        status: ProjectStatus;
        partner_name: string;
      }>(
        `SELECT p.id, p.project_no::text AS project_no, p.project_name, p.status::text AS status,
                COALESCE(bp.partner_name, '') AS partner_name
           FROM projects p
          LEFT JOIN business_partners bp
            ON bp.tenant_id = p.tenant_id AND bp.id = p.partner_id
         WHERE p.tenant_id = $1::uuid
         ORDER BY p.project_date DESC, p.project_no DESC
          LIMIT 200`,
        [user.tenantId],
      ),
    ]);

    const projectOptions: CostProjectOption[] = projectRows.map((r) => ({
      id: r.id,
      projectNo: Number(r.project_no),
      projectName: r.project_name,
      status: r.status,
      partnerName: r.partner_name,
    }));

    return {
      allowed: true as const,
      lookups,
      initialPage,
      projectOptions,
    };
  });

  if (!data.allowed) {
    return (
      <div className="max-w-2xl rounded-xl border border-amber-200 bg-amber-50 p-6 text-sm text-amber-900">
        <h1 className="text-lg font-bold mb-1">アクセス権限がありません</h1>
        <p>このテナントでは「原価管理」機能（cost）が有効化されていません。</p>
      </div>
    );
  }

  return (
    <CostsClient
      todayIso={todayIso}
      lookups={data.lookups}
      projectOptions={data.projectOptions}
      initialCategory={initialCategory}
      initialProjectId={initialProjectId !== null ? initialProjectId : ''}
      initialPage={data.initialPage}
    />
  );
}
