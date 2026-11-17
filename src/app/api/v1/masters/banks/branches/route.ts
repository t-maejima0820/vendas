import { NextResponse } from 'next/server';
import { withApiHandler } from '@/lib/api/handler';
import { createBankBranch, listBankBranches } from '@/lib/masters/banks-service';
import { parseMasterJsonBody } from '@/lib/masters/error-mapper';
import type { BankBranchInput } from '@/lib/masters/types';

export const GET = withApiHandler({}, async ({ req, tx }) => {
  const url = new URL(req.url);
  const rawPage = url.searchParams.get('page');
  const rawSize = url.searchParams.get('pageSize');
  const result = await listBankBranches(tx, {
    bankId: url.searchParams.get('bankId'),
    keyword: url.searchParams.get('q'),
    page: rawPage !== null ? Number(rawPage) : 1,
    pageSize: rawSize !== null ? Number(rawSize) : 50,
  });
  return NextResponse.json({ ok: true, ...result });
});

export const POST = withApiHandler({}, async ({ req, user, tx }) => {
  const body = await parseMasterJsonBody<Partial<BankBranchInput>>(req);
  const item = await createBankBranch(tx, user.tenantId, {
    bankId: typeof body.bankId === 'string' ? body.bankId : '',
    branchCode: typeof body.branchCode === 'string' ? body.branchCode : '',
    branchName: typeof body.branchName === 'string' ? body.branchName : '',
    furigana: typeof body.furigana === 'string' ? body.furigana : null,
  });
  return NextResponse.json({ ok: true, item }, { status: 201 });
});
