import { NextResponse } from 'next/server';
import { withApiHandler } from '@/lib/api/handler';
import { reissueBillingSnapshot } from '@/lib/billing/billing-service';
import { parseBillingDocumentType } from '@/lib/billing/payload-parser';
import { MasterDataError, parseMasterJsonBody } from '@/lib/masters/error-mapper';

function extractBillingIdFromSubpath(req: Request): string {
  const segments = new URL(req.url).pathname.split('/').filter((s) => s.length > 0);
  const id = segments[segments.length - 2];
  if (id === undefined || id.trim() === '') {
    throw new MasterDataError(400, 'INVALID_ID', '請求IDが指定されていません。');
  }
  return decodeURIComponent(id);
}

export const POST = withApiHandler({}, async ({ req, user, tx }) => {
  const billingId = extractBillingIdFromSubpath(req);
  const body = await parseMasterJsonBody<{
    documentType?: unknown;
    templateVariant?: unknown;
    issueDate?: unknown;
    issueCoverDetail?: unknown;
  }>(req);

  const documentType = parseBillingDocumentType(body.documentType, 'INVOICE');
  let templateVariant: '10_ROWS' | '20_ROWS' | undefined;
  if (body.templateVariant === '10_ROWS' || body.templateVariant === '20_ROWS') {
    templateVariant = body.templateVariant;
  } else if (body.templateVariant !== undefined && body.templateVariant !== null) {
    throw new MasterDataError(400, 'INVALID_TEMPLATE_VARIANT', 'templateVariant が不正です。');
  }
  const issueDate = typeof body.issueDate === 'string' ? body.issueDate : undefined;

  const result = await reissueBillingSnapshot(tx, user.tenantId, user.employeeId, {
    billingId,
    documentType,
    templateVariant,
    issueDate,
    issueCoverDetail: body.issueCoverDetail === true,
  });

  return NextResponse.json({ ok: true, ...result }, { status: 201 });
});
