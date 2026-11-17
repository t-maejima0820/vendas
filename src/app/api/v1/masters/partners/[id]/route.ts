import { NextResponse } from 'next/server';
import { withApiHandler } from '@/lib/api/handler';
import { requireEnv } from '@/lib/env';
import {
  extractEntityIdFromRequest,
  parseMasterJsonBody,
} from '@/lib/masters/error-mapper';
import { parsePartnerInputBody } from '@/lib/masters/partner-payload';
import {
  getBusinessPartnerDetail,
  updateBusinessPartner,
} from '@/lib/masters/partners-service';
import type { BusinessPartnerInput } from '@/lib/masters/types';

export const GET = withApiHandler({}, async ({ req, tx }) => {
  const id = extractEntityIdFromRequest(req, '取引先');
  const encKeyHex = requireEnv('FIELD_ENCRYPTION_KEY_HEX');
  const item = await getBusinessPartnerDetail(tx, id, encKeyHex);
  return NextResponse.json({ ok: true, item });
});

export const PUT = withApiHandler({}, async ({ req, user, tx }) => {
  const id = extractEntityIdFromRequest(req, '取引先');
  const body = await parseMasterJsonBody<Partial<BusinessPartnerInput>>(req);
  const encKeyHex = requireEnv('FIELD_ENCRYPTION_KEY_HEX');
  const item = await updateBusinessPartner(tx, user.tenantId, id, parsePartnerInputBody(body), {
    isAdmin: user.isAdmin,
    encKeyHex,
  });
  return NextResponse.json({ ok: true, item });
});
