import { NextResponse } from 'next/server';
import { withApiHandler } from '@/lib/api/handler';
import { createMailTemplate, listMailTemplates } from '@/lib/masters/auxiliary-service';
import { parseMasterJsonBody } from '@/lib/masters/error-mapper';
import type { MailTemplateInput } from '@/lib/masters/types';

export const GET = withApiHandler({}, async ({ req, tx }) => {
  const url = new URL(req.url);
  const items = await listMailTemplates(tx, url.searchParams.get('q'));
  return NextResponse.json({ ok: true, items });
});

export const POST = withApiHandler({}, async ({ req, user, tx }) => {
  const body = await parseMasterJsonBody<Partial<MailTemplateInput>>(req);
  const item = await createMailTemplate(tx, user.tenantId, {
    templateNo: Number(body.templateNo),
    templateName: typeof body.templateName === 'string' ? body.templateName : '',
    subject: typeof body.subject === 'string' ? body.subject : '',
    bodyIntro: typeof body.bodyIntro === 'string' ? body.bodyIntro : null,
    bodyMain: typeof body.bodyMain === 'string' ? body.bodyMain : null,
    bodyFooter: typeof body.bodyFooter === 'string' ? body.bodyFooter : null,
  });
  return NextResponse.json({ ok: true, item }, { status: 201 });
});
