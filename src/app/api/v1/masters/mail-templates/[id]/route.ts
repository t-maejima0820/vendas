import { NextResponse } from 'next/server';
import { withApiHandler } from '@/lib/api/handler';
import { deleteMailTemplate, updateMailTemplate } from '@/lib/masters/auxiliary-service';
import { extractEntityIdFromRequest, parseMasterJsonBody } from '@/lib/masters/error-mapper';
import type { MailTemplateInput } from '@/lib/masters/types';

export const PUT = withApiHandler({}, async ({ req, tx }) => {
  const id = extractEntityIdFromRequest(req, 'メール定型文');
  const body = await parseMasterJsonBody<Partial<MailTemplateInput>>(req);
  const item = await updateMailTemplate(tx, id, {
    templateNo: Number(body.templateNo),
    templateName: typeof body.templateName === 'string' ? body.templateName : '',
    subject: typeof body.subject === 'string' ? body.subject : '',
    bodyIntro: typeof body.bodyIntro === 'string' ? body.bodyIntro : null,
    bodyMain: typeof body.bodyMain === 'string' ? body.bodyMain : null,
    bodyFooter: typeof body.bodyFooter === 'string' ? body.bodyFooter : null,
  });
  return NextResponse.json({ ok: true, item });
});

export const DELETE = withApiHandler({}, async ({ req, tx }) => {
  const id = extractEntityIdFromRequest(req, 'メール定型文');
  await deleteMailTemplate(tx, id);
  return NextResponse.json({ ok: true });
});
