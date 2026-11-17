import { NextResponse } from 'next/server';
import { withApiHandler } from '@/lib/api/handler';
import { deleteBankBranch, updateBankBranch } from '@/lib/masters/banks-service';
import { extractEntityIdFromRequest, parseMasterJsonBody } from '@/lib/masters/error-mapper';
import type { BankBranchInput } from '@/lib/masters/types';

export const PUT = withApiHandler({}, async ({ req, tx }) => {
  const id = extractEntityIdFromRequest(req, '支店');
  const body = await parseMasterJsonBody<Partial<BankBranchInput>>(req);
  const item = await updateBankBranch(tx, id, {
    bankId: typeof body.bankId === 'string' ? body.bankId : '',
    branchCode: typeof body.branchCode === 'string' ? body.branchCode : '',
    branchName: typeof body.branchName === 'string' ? body.branchName : '',
    furigana: typeof body.furigana === 'string' ? body.furigana : null,
  });
  return NextResponse.json({ ok: true, item });
});

export const DELETE = withApiHandler({}, async ({ req, tx }) => {
  const id = extractEntityIdFromRequest(req, '支店');
  await deleteBankBranch(tx, id);
  return NextResponse.json({ ok: true });
});
