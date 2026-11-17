import { NextResponse } from 'next/server';
import { withApiHandler } from '@/lib/api/handler';
import { extractEntityIdFromRequest, parseMasterJsonBody } from '@/lib/masters/error-mapper';
import { parseProjectPayload } from '@/lib/projects/payload-parser';
import {
  deleteProject,
  getProjectDetail,
  updateProject,
} from '@/lib/projects/projects-service';

export const GET = withApiHandler({ requiredFeature: 'construction' }, async ({ req, user, tx }) => {
  const id = extractEntityIdFromRequest(req, '案件データ');
  const item = await getProjectDetail(tx, user.tenantId, id);
  return NextResponse.json({ ok: true, item });
});

export const PUT = withApiHandler({ requiredFeature: 'construction' }, async ({ req, user, tx }) => {
  const id = extractEntityIdFromRequest(req, '案件データ');
  const body = await parseMasterJsonBody<unknown>(req);
  const payload = parseProjectPayload(body);
  const item = await updateProject(tx, user.tenantId, user.employeeId, id, payload);
  return NextResponse.json({ ok: true, item });
});

export const DELETE = withApiHandler({ requiredFeature: 'construction' }, async ({ req, user, tx }) => {
  const id = extractEntityIdFromRequest(req, '案件データ');
  await deleteProject(tx, user.tenantId, id);
  return NextResponse.json({ ok: true });
});
