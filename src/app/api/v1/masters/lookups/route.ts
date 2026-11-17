import { NextResponse } from 'next/server';
import { withApiHandler } from '@/lib/api/handler';
import { getMasterLookups } from '@/lib/masters/lookups-service';

export const GET = withApiHandler({}, async ({ req, tx }) => {
  const url = new URL(req.url);
  const includeBankBranches = url.searchParams.get('includeBankBranches') === 'true';
  const lookups = await getMasterLookups(tx, { includeBankBranches });
  return NextResponse.json({ ok: true, lookups });
});
