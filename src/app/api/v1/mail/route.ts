import { NextResponse } from 'next/server';
import { withApiHandler } from '@/lib/api/handler';
import { composeMailPreview, getMailOverview } from '@/lib/mail/mail-service';
import { MasterDataError, parseMasterJsonBody } from '@/lib/masters/error-mapper';

export const GET = withApiHandler({ requiredFeature: 'mail' }, async ({ req, user, tx }) => {
  const url = new URL(req.url);
  const data = await getMailOverview(tx, user.tenantId, {
    keyword: url.searchParams.get('keyword'),
    mailEnabledOnly: url.searchParams.get('mailEnabledOnly') === '1',
  });
  return NextResponse.json({ ok: true, ...data });
});

export const POST = withApiHandler({ requiredFeature: 'mail' }, async ({ req, user, tx }) => {
  const body = await parseMasterJsonBody<Record<string, unknown>>(req);
  if (typeof body.partnerId !== 'string' || typeof body.templateId !== 'string') {
    throw new MasterDataError(400, 'REQUIRED_FIELD', 'partnerId と templateId は必須です。');
  }
  const docKind =
    body.docKind === 'ESTIMATE' || body.docKind === 'BILLING' || body.docKind === 'PURCHASE_ORDER'
      ? body.docKind
      : undefined;

  const preview = await composeMailPreview(tx, user.tenantId, {
    partnerId: body.partnerId,
    templateId: body.templateId,
    docKind,
    customTo: typeof body.customTo === 'string' ? body.customTo : null,
    customCc: typeof body.customCc === 'string' ? body.customCc : null,
  });
  return NextResponse.json({ ok: true, preview });
});
