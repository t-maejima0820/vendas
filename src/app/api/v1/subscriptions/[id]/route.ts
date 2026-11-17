import { NextResponse } from 'next/server';
import { withApiHandler } from '@/lib/api/handler';
import {
  extractEntityIdFromRequest,
  parseMasterJsonBody,
} from '@/lib/masters/error-mapper';
import { parseSubscriptionContractBody } from '@/lib/subscriptions/payload-parser';
import {
  deleteSubscriptionContract,
  updateSubscriptionContract,
} from '@/lib/subscriptions/subscriptions-service';

export const PUT = withApiHandler({ requiredFeature: 'fixedbill' }, async ({ req, user, tx }) => {
  const id = extractEntityIdFromRequest(req, '定額契約');
  const body = await parseMasterJsonBody<Record<string, unknown>>(req);
  const item = await updateSubscriptionContract(
    tx,
    user.tenantId,
    id,
    parseSubscriptionContractBody(body),
  );
  return NextResponse.json({ ok: true, item });
});

export const DELETE = withApiHandler({ requiredFeature: 'fixedbill' }, async ({ req, user, tx }) => {
  const id = extractEntityIdFromRequest(req, '定額契約');
  await deleteSubscriptionContract(tx, user.tenantId, id);
  return NextResponse.json({ ok: true });
});
