import { NextResponse } from 'next/server';
import { withApiHandler } from '@/lib/api/handler';
import {
  resetEmployeePasswordByAdmin,
  unlockEmployeeAccountByAdmin,
  updateEmployee,
} from '@/lib/masters/employees-service';
import {
  extractEntityIdFromRequest,
  MasterDataError,
  parseMasterJsonBody,
} from '@/lib/masters/error-mapper';
import type { UpdateEmployeeInput } from '@/lib/masters/types';

function toUpdateEmployeeInput(body: Partial<UpdateEmployeeInput>): UpdateEmployeeInput {
  let genderCode: 'S1' | 'S2' | null = null;
  if (body.genderCode === 'S1' || body.genderCode === 'S2') {
    genderCode = body.genderCode;
  }

  return {
    syainCode: typeof body.syainCode === 'string' ? body.syainCode : '',
    syainName: typeof body.syainName === 'string' ? body.syainName : '',
    kanaName: typeof body.kanaName === 'string' ? body.kanaName : null,
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

interface EmployeePatchActionBody {
  action?: unknown;
  newPassword?: unknown;
}

export const PUT = withApiHandler({ requireAdmin: true }, async ({ req, user, tx }) => {
  const id = extractEntityIdFromRequest(req, '社員');
  const body = await parseMasterJsonBody<Partial<UpdateEmployeeInput>>(req);
  const item = await updateEmployee(tx, id, toUpdateEmployeeInput(body), user.employeeId);
  return NextResponse.json({ ok: true, item });
});

export const PATCH = withApiHandler({ requireAdmin: true }, async ({ req, user, tx }) => {
  const id = extractEntityIdFromRequest(req, '社員');
  const body = await parseMasterJsonBody<EmployeePatchActionBody>(req);

  if (body.action === 'RESET_PASSWORD') {
    const newPassword = typeof body.newPassword === 'string' ? body.newPassword : '';
    const item = await resetEmployeePasswordByAdmin(
      tx,
      user.tenantId,
      user.tenantSlug,
      id,
      newPassword,
      user.employeeId,
    );
    return NextResponse.json({ ok: true, item });
  }

  if (body.action === 'UNLOCK') {
    const item = await unlockEmployeeAccountByAdmin(
      tx,
      user.tenantId,
      user.tenantSlug,
      id,
      user.employeeId,
    );
    return NextResponse.json({ ok: true, item });
  }

  throw new MasterDataError(400, 'INVALID_ACTION', '不正なアクション指定です。');
});
