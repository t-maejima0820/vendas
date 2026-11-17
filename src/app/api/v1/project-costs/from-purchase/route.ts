import { NextResponse } from 'next/server';
import { withApiHandler } from '@/lib/api/handler';
import { parseMasterJsonBody } from '@/lib/masters/error-mapper';
import { parseImportCostFromPurchasePayload } from '@/lib/project-costs/payload-parser';
import {
  createProjectCostFromPurchase,
  listCandidatePurchasesForProjectCost,
} from '@/lib/project-costs/project-costs-service';

export const GET = withApiHandler({ requiredFeature: 'cost' }, async ({ req, user, tx }) => {
  const url = new URL(req.url);
  const projectId = url.searchParams.get('projectId') ?? '';
  const items = await listCandidatePurchasesForProjectCost(tx, user.tenantId, projectId);
  return NextResponse.json({ ok: true, items });
});

export const POST = withApiHandler({ requiredFeature: 'cost' }, async ({ req, user, tx }) => {
  const body = await parseMasterJsonBody<unknown>(req);
  const parsed = parseImportCostFromPurchasePayload(body);
  const item = await createProjectCostFromPurchase(tx, user.tenantId, user.employeeId, parsed);
  return NextResponse.json({ ok: true, item }, { status: 201 });
});
