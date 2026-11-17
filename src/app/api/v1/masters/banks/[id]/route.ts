import { NextResponse } from 'next/server';
import { withApiHandler } from '@/lib/api/handler';
import { deleteBank, updateBank } from '@/lib/masters/banks-service';
import { extractEntityIdFromRequest, parseMasterJsonBody } from '@/lib/masters/error-mapper';
import type { BankInput } from '@/lib/masters/types';

export const PUT = withApiHandler({}, async ({ req, tx }) => {
  const id = extractEntityIdFromRequest(req, '銀行');
  const body = await parseMasterJsonBody<Partial<BankInput>>(req);
  const item = await updateBank(tx, id, {
    bankCode: typeof body.bankCode === 'string' ? body.bankCode : '',
    bankName: typeof body.bankName === 'string' ? body.bankName : '',
    furigana: typeof body.furigana === 'string' ? body.furigana : null,
  });
  return NextResponse.json({ ok: true, item });
});

export const DELETE = withApiHandler({}, async ({ req, tx }) => {
  const id = extractEntityIdFromRequest(req, '銀行');
  await deleteBank(tx, id);
  return NextResponse.json({ ok: true });
});
