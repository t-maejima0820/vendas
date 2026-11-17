import { NextResponse } from 'next/server';
import { withApiHandler } from '@/lib/api/handler';
import { parseMasterJsonBody } from '@/lib/masters/error-mapper';
import { parseProjectPayload } from '@/lib/projects/payload-parser';
import {
  createProject,
  getProjectsLookups,
  listProjects,
} from '@/lib/projects/projects-service';
import type { ProjectStatus } from '@/lib/projects/types';

function parseFilter(url: URL) {
  const statusRaw = url.searchParams.get('status');
  const status =
    statusRaw === 'C1' || statusRaw === 'C2' || statusRaw === 'C3'
      ? (statusRaw as ProjectStatus)
      : null;
  const pageRaw = Number(url.searchParams.get('page') ?? '1');
  const sizeRaw = Number(url.searchParams.get('pageSize') ?? '25');
  return {
    keyword: url.searchParams.get('keyword'),
    status,
    orderKindCode: url.searchParams.get('orderKindCode'),
    employeeId: url.searchParams.get('employeeId'),
    dateFrom: url.searchParams.get('dateFrom'),
    dateTo: url.searchParams.get('dateTo'),
    overBudgetOnly: url.searchParams.get('overBudgetOnly') === '1',
    page: Number.isInteger(pageRaw) && pageRaw >= 1 ? pageRaw : 1,
    pageSize: Number.isInteger(sizeRaw) && sizeRaw >= 1 ? sizeRaw : 25,
  };
}

export const GET = withApiHandler({ requiredFeature: 'construction' }, async ({ req, user, tx }) => {
  const url = new URL(req.url);
  if (url.searchParams.get('include') === 'lookups') {
    const lookups = await getProjectsLookups(tx, user.tenantId);
    return NextResponse.json({ ok: true, lookups });
  }
  const pageData = await listProjects(tx, user.tenantId, parseFilter(url));
  return NextResponse.json({ ok: true, ...pageData });
});

export const POST = withApiHandler({ requiredFeature: 'construction' }, async ({ req, user, tx }) => {
  const body = await parseMasterJsonBody<unknown>(req);
  const payload = parseProjectPayload(body);
  const item = await createProject(tx, user.tenantId, user.employeeId, payload);
  return NextResponse.json({ ok: true, item }, { status: 201 });
});
