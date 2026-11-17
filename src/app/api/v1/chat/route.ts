import { NextResponse } from 'next/server';
import { withApiHandler } from '@/lib/api/handler';
import {
  buildTeamsAdaptiveCardPayload,
  createChatThread,
  getChatLookups,
  listChatThreads,
} from '@/lib/chat/chat-service';
import { MasterDataError, parseMasterJsonBody } from '@/lib/masters/error-mapper';

export const GET = withApiHandler({ requiredFeature: 'teams' }, async ({ req, user, tx }) => {
  const url = new URL(req.url);
  if (url.searchParams.get('include') === 'lookups') {
    const lookups = await getChatLookups(tx, user.tenantId);
    return NextResponse.json({ ok: true, lookups });
  }

  const data = await listChatThreads(tx, user.tenantId, {
    roomName: url.searchParams.get('roomName'),
    projectId: url.searchParams.get('projectId'),
    partnerId: url.searchParams.get('partnerId'),
    unresolvedOnly: url.searchParams.get('unresolvedOnly') === '1',
    keyword: url.searchParams.get('keyword'),
    dateFrom: url.searchParams.get('dateFrom'),
    dateTo: url.searchParams.get('dateTo'),
  });
  return NextResponse.json({ ok: true, ...data });
});

export const POST = withApiHandler({ requiredFeature: 'teams' }, async ({ req, user, tx }) => {
  const body = await parseMasterJsonBody<Record<string, unknown>>(req);
  if (typeof body.question !== 'string') {
    throw new MasterDataError(400, 'REQUIRED_FIELD', 'メッセージ本文は必須です。');
  }
  const lookups = await getChatLookups(tx, user.tenantId);
  const item = await createChatThread(tx, user.tenantId, user.employeeId, {
    roomName: typeof body.roomName === 'string' ? body.roomName : null,
    question: body.question,
    projectId: typeof body.projectId === 'string' ? body.projectId : null,
    partnerId: typeof body.partnerId === 'string' ? body.partnerId : null,
  });
  const adaptiveCard = buildTeamsAdaptiveCardPayload(lookups.companyName, item);
  return NextResponse.json({ ok: true, item, adaptiveCard }, { status: 201 });
});
