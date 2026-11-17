import { NextResponse } from 'next/server';
import { withApiHandler } from '@/lib/api/handler';
import { extractEntityIdFromRequest, parseMasterJsonBody } from '@/lib/masters/error-mapper';
import { parseProjectCostPayload } from '@/lib/project-costs/payload-parser';
import {
  deleteProjectCost,
  getProjectCostDetail,
  updateProjectCost,
} from '@/lib/project-costs/project-costs-service';

export const GET = withApiHandler({ requiredFeature: 'cost' }, async ({ req, user, tx }) => {
  const id = extractEntityIdFromRequest(req, '原価伝票');
  const item = await getProjectCostDetail(tx, user.tenantId, id);
  return NextResponse.json({ ok: true, item });
});

export const PUT = withApiHandler({ requiredFeature: 'cost' }, async ({ req, user, tx }) => {
  const id = extractEntityIdFromRequest(req, '原価伝票');
  const body = await parseMasterJsonBody<unknown>(req);
  const payload = parseProjectCostPayload(body);
  const item = await updateProjectCost(tx, user.tenantId, user.employeeId, id, payload);
  return NextResponse.json({ ok: true, item });
});

export const DELETE = withApiHandler({ requiredFeature: 'cost' }, async ({ req, user, tx }) => {
  const id = extractEntityIdFromRequest(req, '原価伝票');
  await deleteProjectCost(tx, user.tenantId, id);
  return NextResponse.json({ ok: true });
});
