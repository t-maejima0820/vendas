import { NextResponse } from 'next/server';
import { withApiHandler } from '@/lib/api/handler';
import { parseMasterJsonBody } from '@/lib/masters/error-mapper';
import {
  createRepresentative,
  listRepresentatives,
} from '@/lib/masters/representatives-service';
import type { RepresentativeInput } from '@/lib/masters/types';

function toRepresentativeInput(body: Partial<RepresentativeInput>): RepresentativeInput {
  return {
    representativeCode: Number(body.representativeCode),
    representativeName: typeof body.representativeName === 'string' ? body.representativeName : '',
    furigana: typeof body.furigana === 'string' ? body.furigana : null,
    postalCode: typeof body.postalCode === 'string' ? body.postalCode : null,
    address1: typeof body.address1 === 'string' ? body.address1 : null,
    address2: typeof body.address2 === 'string' ? body.address2 : null,
    tel: typeof body.tel === 'string' ? body.tel : null,
    mobile: typeof body.mobile === 'string' ? body.mobile : null,
    birthDate: typeof body.birthDate === 'string' ? body.birthDate : null,
    genderCode: typeof body.genderCode === 'string' ? body.genderCode : null,
  };
}

export const GET = withApiHandler({}, async ({ req, tx }) => {
  const url = new URL(req.url);
  const keyword = url.searchParams.get('q');
  const items = await listRepresentatives(tx, keyword);
  return NextResponse.json({ ok: true, items });
});

export const POST = withApiHandler({}, async ({ req, user, tx }) => {
  const body = await parseMasterJsonBody<Partial<RepresentativeInput>>(req);
  const item = await createRepresentative(tx, user.tenantId, toRepresentativeInput(body));
  return NextResponse.json({ ok: true, item }, { status: 201 });
});
