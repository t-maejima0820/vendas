import { NextResponse } from 'next/server';
import { withApiHandler } from '@/lib/api/handler';
import { getMasterLookups } from '@/lib/masters/lookups-service';

export const GET = withApiHandler({}, async ({ tx }) => {
  const lookups = await getMasterLookups(tx);
  return NextResponse.json({ ok: true, lookups });
});
