import { NextResponse } from 'next/server';
import { withApiHandler } from '@/lib/api/handler';
import {
  extractEntityIdFromRequest,
  parseMasterJsonBody,
} from '@/lib/masters/error-mapper';
import {
  deleteRepresentative,
  updateRepresentative,
} from '@/lib/masters/representatives-service';
import type { RepresentativeInput } from '@/lib/masters/types';

export const PUT = withApiHandler({}, async ({ req, tx }) => {
  const id = extractEntityIdFromRequest(req, '代表者');
  const body = await parseMasterJsonBody<Partial<RepresentativeInput>>(req);

  const input: RepresentativeInput = {
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

  const item = await updateRepresentative(tx, id, input);
  return NextResponse.json({ ok: true, item });
});

export const DELETE = withApiHandler({}, async ({ req, tx }) => {
  const id = extractEntityIdFromRequest(req, '代表者');
  await deleteRepresentative(tx, id);
  return NextResponse.json({ ok: true });
});
