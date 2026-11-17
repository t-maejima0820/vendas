import { NextResponse } from 'next/server';
import { withApiHandler } from '@/lib/api/handler';
import { parseMasterJsonBody } from '@/lib/masters/error-mapper';
import type { SalesEntryType } from '@/lib/sales/types';
import { parseSubscriptionContractBody } from '@/lib/subscriptions/payload-parser';
import {
  createSubscriptionContract,
  listSubscriptionContracts,
} from '@/lib/subscriptions/subscriptions-service';

export const GET = withApiHandler({ requiredFeature: 'fixedbill' }, async ({ req, user, tx }) => {
  const url = new URL(req.url);
  const rawEntry = url.searchParams.get('entryType');
  const entryType: 'ALL' | SalesEntryType =
    rawEntry === 'SALE' || rawEntry === 'ADVANCE' ? rawEntry : 'ALL';
  const rawActive = url.searchParams.get('active');
  const activeFilter: 'ALL' | 'ACTIVE' | 'INACTIVE' =
    rawActive === 'ACTIVE' || rawActive === 'INACTIVE' ? rawActive : 'ALL';

  const result = await listSubscriptionContracts(tx, user.tenantId, {
    keyword: url.searchParams.get('q'),
    partnerId: url.searchParams.get('partnerId'),
    entryType,
    activeFilter,
  });
  return NextResponse.json({ ok: true, ...result });
});

export const POST = withApiHandler({ requiredFeature: 'fixedbill' }, async ({ req, user, tx }) => {
  const body = await parseMasterJsonBody<Record<string, unknown>>(req);
  const item = await createSubscriptionContract(
    tx,
    user.tenantId,
    parseSubscriptionContractBody(body),
  );
  return NextResponse.json({ ok: true, item }, { status: 201 });
});
