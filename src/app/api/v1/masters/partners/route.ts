import { NextResponse } from 'next/server';
import { withApiHandler } from '@/lib/api/handler';
import { requireEnv } from '@/lib/env';
import { parseMasterJsonBody } from '@/lib/masters/error-mapper';
import { parsePartnerInputBody } from '@/lib/masters/partner-payload';
import {
  createBusinessPartner,
  listBusinessPartners,
  type PartnerListFilter,
} from '@/lib/masters/partners-service';
import type { BusinessPartnerInput } from '@/lib/masters/types';

export const GET = withApiHandler({}, async ({ req, tx }) => {
  const url = new URL(req.url);
  const rawRole = url.searchParams.get('role');
  let role: PartnerListFilter['role'] = 'ALL';
  if (rawRole === 'CLIENT' || rawRole === 'SUPPLIER' || rawRole === 'APLUS') {
    role = rawRole;
  }

  const items = await listBusinessPartners(tx, {
    keyword: url.searchParams.get('q'),
    role,
    categoryCode: url.searchParams.get('categoryCode'),
    stateCode: url.searchParams.get('stateCode'),
    includeDeleted: url.searchParams.get('includeDeleted') === 'true',
  });
  return NextResponse.json({ ok: true, items });
});

export const POST = withApiHandler({}, async ({ req, user, tx }) => {
  const body = await parseMasterJsonBody<Partial<BusinessPartnerInput>>(req);
  const encKeyHex = requireEnv('FIELD_ENCRYPTION_KEY_HEX');
  const item = await createBusinessPartner(tx, user.tenantId, parsePartnerInputBody(body), {
    isAdmin: user.isAdmin,
    encKeyHex,
  });
  return NextResponse.json({ ok: true, item }, { status: 201 });
});
