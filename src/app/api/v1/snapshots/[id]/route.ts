import { NextResponse } from 'next/server';
import { withApiHandler } from '@/lib/api/handler';
import { extractEntityIdFromRequest } from '@/lib/masters/error-mapper';
import { assertSnapshotReadFeature, getSnapshotById } from '@/lib/snapshots/snapshot-service';

export const GET = withApiHandler({}, async ({ req, user, tx }) => {
  const snapshotId = extractEntityIdFromRequest(req, 'スナップショット');
  const item = await getSnapshotById(tx, snapshotId);
  await assertSnapshotReadFeature(tx, user.tenantId, item.payloadJson);
  return NextResponse.json({ ok: true, item });
});
