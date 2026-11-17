import { NextResponse } from 'next/server';
import { withApiHandler } from '@/lib/api/handler';
import {
  buildTeamsAdaptiveCardPayload,
  deleteChatThread,
  getChatLookups,
  updateChatThread,
} from '@/lib/chat/chat-service';
import { extractEntityIdFromRequest, parseMasterJsonBody } from '@/lib/masters/error-mapper';

export const PATCH = withApiHandler({ requiredFeature: 'teams' }, async ({ req, user, tx }) => {
  const id = extractEntityIdFromRequest(req, 'チャットスレッド');
  const body = await parseMasterJsonBody<Record<string, unknown>>(req);
  const lookups = await getChatLookups(tx, user.tenantId);

  const item = await updateChatThread(tx, user.tenantId, user.employeeId, id, {
    replyMessage: typeof body.replyMessage === 'string' ? body.replyMessage : undefined,
    isResolved: typeof body.isResolved === 'boolean' ? body.isResolved : undefined,
    roomName: typeof body.roomName === 'string' ? body.roomName : undefined,
    question: typeof body.question === 'string' ? body.question : undefined,
    projectId:
      body.projectId === null
        ? null
        : typeof body.projectId === 'string'
          ? body.projectId
          : undefined,
    partnerId:
      body.partnerId === null
        ? null
        : typeof body.partnerId === 'string'
          ? body.partnerId
          : undefined,
  });
  const adaptiveCard = buildTeamsAdaptiveCardPayload(lookups.companyName, item);
  return NextResponse.json({ ok: true, item, adaptiveCard });
});

export const DELETE = withApiHandler({ requiredFeature: 'teams' }, async ({ req, user, tx }) => {
  const id = extractEntityIdFromRequest(req, 'チャットスレッド');
  await deleteChatThread(tx, user.tenantId, id);
  return NextResponse.json({ ok: true });
});
