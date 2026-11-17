import { NextResponse } from 'next/server';
import { withApiHandler } from '@/lib/api/handler';
import { listTaxCodes } from '@/lib/masters/codes-service';

export const GET = withApiHandler({}, async ({ tx }) => {
  const items = await listTaxCodes(tx);
  return NextResponse.json({ ok: true, items });
});
