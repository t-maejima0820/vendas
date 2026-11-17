import { NextResponse } from 'next/server';
import { withApiHandler } from '@/lib/api/handler';
import {
  createEmployee,
  listEmployees,
} from '@/lib/masters/employees-service';
import { parseMasterJsonBody } from '@/lib/masters/error-mapper';
import type { CreateEmployeeInput } from '@/lib/masters/types';

function toCreateEmployeeInput(body: Partial<CreateEmployeeInput>): CreateEmployeeInput {
  let genderCode: 'S1' | 'S2' | null = null;
  if (body.genderCode === 'S1' || body.genderCode === 'S2') {
    genderCode = body.genderCode;
  }

  return {
    syainCode: typeof body.syainCode === 'string' ? body.syainCode : '',
    syainName: typeof body.syainName === 'string' ? body.syainName : '',
    kanaName: typeof body.kanaName === 'string' ? body.kanaName : null,
    initialPassword: typeof body.initialPassword === 'string' ? body.initialPassword : '',
    isAdmin: Boolean(body.isAdmin),
    menuType: body.menuType === undefined ? 3 : Number(body.menuType),
    email: typeof body.email === 'string' ? body.email : null,
    joinedAt: typeof body.joinedAt === 'string' ? body.joinedAt : null,
    birthDate: typeof body.birthDate === 'string' ? body.birthDate : null,
    retiredAt: typeof body.retiredAt === 'string' ? body.retiredAt : null,
    isRetired: Boolean(body.isRetired),
    genderCode,
    postalCode: typeof body.postalCode === 'string' ? body.postalCode : null,
    address1: typeof body.address1 === 'string' ? body.address1 : null,
    address2: typeof body.address2 === 'string' ? body.address2 : null,
    steadyJobNote: typeof body.steadyJobNote === 'string' ? body.steadyJobNote : null,
    workExperience: typeof body.workExperience === 'string' ? body.workExperience : null,
  };
}

export const GET = withApiHandler({ requireAdmin: true }, async ({ req, tx }) => {
  const url = new URL(req.url);
  const items = await listEmployees(tx, {
    keyword: url.searchParams.get('q'),
    includeRetired: url.searchParams.get('includeRetired') === 'true',
  });
  return NextResponse.json({ ok: true, items });
});

export const POST = withApiHandler({ requireAdmin: true }, async ({ req, user, tx }) => {
  const body = await parseMasterJsonBody<Partial<CreateEmployeeInput>>(req);
  const item = await createEmployee(
    tx,
    user.tenantId,
    toCreateEmployeeInput(body),
    user.employeeId,
  );
  return NextResponse.json({ ok: true, item }, { status: 201 });
});
