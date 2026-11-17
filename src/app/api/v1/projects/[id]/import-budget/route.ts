import { NextResponse } from 'next/server';
import { withApiHandler } from '@/lib/api/handler';
import { MasterDataError, parseMasterJsonBody } from '@/lib/masters/error-mapper';
import { parseImportBudgetFromQuotationPayload } from '@/lib/projects/payload-parser';
import { importProjectBudgetFromQuotation } from '@/lib/projects/projects-service';

function extractProjectId(req: Request): string {
  const segments = new URL(req.url).pathname.split('/').filter((s) => s.length > 0);
  const id = segments[segments.length - 2];
  if (id === undefined || id.trim() === '') {
    throw new MasterDataError(400, 'INVALID_ID', '案件IDが指定されていません。');
  }
  return decodeURIComponent(id);
}

export const POST = withApiHandler({ requiredFeature: 'construction' }, async ({ req, user, tx }) => {
  const projectId = extractProjectId(req);
  const body = await parseMasterJsonBody<unknown>(req);
  const parsed = parseImportBudgetFromQuotationPayload(body);
  const item = await importProjectBudgetFromQuotation(
    tx,
    user.tenantId,
    user.employeeId,
    projectId,
    parsed,
  );
  return NextResponse.json({ ok: true, item });
});
