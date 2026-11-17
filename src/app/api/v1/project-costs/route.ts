import { NextResponse } from 'next/server';
import { withApiHandler } from '@/lib/api/handler';
import type { CostCategory } from '@/lib/domain/calculations';
import { parseMasterJsonBody } from '@/lib/masters/error-mapper';
import { parseProjectCostPayload } from '@/lib/project-costs/payload-parser';
import { createProjectCost, listProjectCosts } from '@/lib/project-costs/project-costs-service';
import type { ProjectStatus } from '@/lib/projects/types';

function parseCategory(raw: string | null): CostCategory | null {
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

export const GET = withApiHandler({ requiredFeature: 'cost' }, async ({ req, user, tx }) => {
  const url = new URL(req.url);
  const statusRaw = url.searchParams.get('status');
  const status =
    statusRaw === 'C1' || statusRaw === 'C2' || statusRaw === 'C3'
      ? (statusRaw as ProjectStatus)
      : null;
  const pageRaw = Number(url.searchParams.get('page') ?? '1');
  const sizeRaw = Number(url.searchParams.get('pageSize') ?? '25');

  const pageData = await listProjectCosts(tx, user.tenantId, {
    projectId: url.searchParams.get('projectId'),
    costCategory: parseCategory(url.searchParams.get('costCategory')),
    status,
    dateFrom: url.searchParams.get('dateFrom'),
    dateTo: url.searchParams.get('dateTo'),
    keyword: url.searchParams.get('keyword'),
    page: Number.isInteger(pageRaw) && pageRaw >= 1 ? pageRaw : 1,
    pageSize: Number.isInteger(sizeRaw) && sizeRaw >= 1 ? sizeRaw : 25,
  });
  return NextResponse.json({ ok: true, ...pageData });
});

export const POST = withApiHandler({ requiredFeature: 'cost' }, async ({ req, user, tx }) => {
  const body = await parseMasterJsonBody<unknown>(req);
  const payload = parseProjectCostPayload(body);
  const item = await createProjectCost(tx, user.tenantId, user.employeeId, payload);
  return NextResponse.json({ ok: true, item }, { status: 201 });
});
