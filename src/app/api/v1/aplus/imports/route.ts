import { NextResponse } from 'next/server';
import { withApiHandler } from '@/lib/api/handler';
import { importAplusResults, listAplusImports } from '@/lib/aplus/aplus-service';
import type { AplusImportRowInput } from '@/lib/aplus/types';
import { parseMasterJsonBody } from '@/lib/masters/error-mapper';

export const GET = withApiHandler({ requiredFeature: 'aplus' }, async ({ req, user, tx }) => {
  const url = new URL(req.url);
  const transferDate = url.searchParams.get('transferDate');
  const rawStatus = url.searchParams.get('statusFilter');
  const statusFilter = rawStatus === 'OK' || rawStatus === 'ERROR' ? rawStatus : 'ALL';
  const items = await listAplusImports(tx, user.tenantId, { transferDate, statusFilter });
  return NextResponse.json({ ok: true, items });
});

export const POST = withApiHandler({ requiredFeature: 'aplus' }, async ({ req, user, tx }) => {
  const body = await parseMasterJsonBody<{
    rawText?: unknown;
    defaultTransferDate?: unknown;
    rows?: unknown;
    autoCreateReceipts?: unknown;
  }>(req);

  const result = await importAplusResults(tx, user.tenantId, user.employeeId, {
    rawText: typeof body.rawText === 'string' ? body.rawText : undefined,
    defaultTransferDate:
      typeof body.defaultTransferDate === 'string' ? body.defaultTransferDate : undefined,
    rows: Array.isArray(body.rows) ? (body.rows as AplusImportRowInput[]) : undefined,
    autoCreateReceipts: body.autoCreateReceipts !== false,
  });

  return NextResponse.json({ ok: true, ...result }, { status: 201 });
});
