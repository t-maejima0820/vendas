import { NextResponse } from 'next/server';
import { withApiHandler } from '@/lib/api/handler';
import { createBank, listBanks } from '@/lib/masters/banks-service';
import { parseMasterJsonBody } from '@/lib/masters/error-mapper';
import type { BankInput } from '@/lib/masters/types';

function toBankInput(body: Partial<BankInput>): BankInput {
  return {
    bankCode: typeof body.bankCode === 'string' ? body.bankCode : '',
    bankName: typeof body.bankName === 'string' ? body.bankName : '',
    furigana: typeof body.furigana === 'string' ? body.furigana : null,
  };
}

export const GET = withApiHandler({}, async ({ req, tx }) => {
  const url = new URL(req.url);
  const items = await listBanks(tx, url.searchParams.get('q'));
  return NextResponse.json({ ok: true, items });
});

export const POST = withApiHandler({}, async ({ req, user, tx }) => {
  const body = await parseMasterJsonBody<Partial<BankInput>>(req);
  const item = await createBank(tx, user.tenantId, toBankInput(body));
  return NextResponse.json({ ok: true, item }, { status: 201 });
});
