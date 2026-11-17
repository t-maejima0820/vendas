import type { DbExecutor } from '@/lib/db/tenant-client';
import { mapPgConstraintError, MasterDataError } from '@/lib/masters/error-mapper';
import type { RepresentativeDto, RepresentativeInput } from '@/lib/masters/types';

type RepresentativeRow = {
  id: string;
  representative_code: number;
  representative_name: string;
  furigana: string | null;
  postal_code: string | null;
  address1: string | null;
  address2: string | null;
  tel: string | null;
  mobile: string | null;
  birth_date: string | null;
  gender_code: string | null;
  linked_partner_count: string | number;
  created_at: string;
  updated_at: string;
};

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DATE_REGEX = /^\d{4}-\d{2}-\d{2}$/;

function optTrimmed(val: string | null | undefined): string | null {
  if (val === null || val === undefined) {
    return null;
  }
  const trimmed = val.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function validateUuid(id: string): void {
  if (!UUID_REGEX.test(id)) {
    throw new MasterDataError(400, 'INVALID_ID', '代表者IDの形式が不正です。');
  }
}

function validateRepresentativeInput(input: RepresentativeInput): RepresentativeInput {
  if (!Number.isInteger(input.representativeCode) || input.representativeCode < 1 || input.representativeCode > 2147483647) {
    throw new MasterDataError(400, 'INVALID_REPRESENTATIVE_CODE', '代表者コードは1以上の整数で入力してください。');
  }
  const name = input.representativeName.trim();
  if (name.length === 0 || name.length > 100) {
    throw new MasterDataError(400, 'INVALID_REPRESENTATIVE_NAME', '代表者名は1〜100文字で入力してください。');
  }
  const birthDate = optTrimmed(input.birthDate);
  if (birthDate !== null && !DATE_REGEX.test(birthDate)) {
    throw new MasterDataError(400, 'INVALID_BIRTH_DATE', '生年月日は YYYY-MM-DD 形式で入力してください。');
  }
  const genderCode = optTrimmed(input.genderCode);
  if (genderCode !== null && genderCode !== 'S1' && genderCode !== 'S2') {
    throw new MasterDataError(400, 'INVALID_GENDER_CODE', '性別区分が不正です（S1/S2）。');
  }

  return {
    representativeCode: input.representativeCode,
    representativeName: name,
    furigana: optTrimmed(input.furigana),
    postalCode: optTrimmed(input.postalCode),
    address1: optTrimmed(input.address1),
    address2: optTrimmed(input.address2),
    tel: optTrimmed(input.tel),
    mobile: optTrimmed(input.mobile),
    birthDate,
    genderCode,
  };
}

function toDto(row: RepresentativeRow): RepresentativeDto {
  return {
    id: row.id,
    representativeCode: Number(row.representative_code),
    representativeName: row.representative_name,
    furigana: row.furigana,
    postalCode: row.postal_code,
    address1: row.address1,
    address2: row.address2,
    tel: row.tel,
    mobile: row.mobile,
    birthDate: row.birth_date,
    genderCode: row.gender_code,
    linkedPartnerCount: Number(row.linked_partner_count),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export async function listRepresentatives(
  tx: DbExecutor,
  keyword?: string | null,
): Promise<RepresentativeDto[]> {
  const kw = optTrimmed(keyword);
  const rows = await tx.query<RepresentativeRow>(
    `SELECT
       r.id,
       r.representative_code,
       r.representative_name,
       r.furigana,
       r.postal_code,
       r.address1,
       r.address2,
       r.tel,
       r.mobile,
       r.birth_date::text AS birth_date,
       r.gender_code,
       COUNT(bp.id)::int AS linked_partner_count,
       r.created_at::text AS created_at,
       r.updated_at::text AS updated_at
     FROM representatives r
     LEFT JOIN business_partners bp
       ON bp.tenant_id = r.tenant_id AND bp.representative_id = r.id
     WHERE (
       $1::text IS NULL
       OR CAST(r.representative_code AS text) ILIKE '%' || $1 || '%'
       OR r.representative_name ILIKE '%' || $1 || '%'
       OR COALESCE(r.furigana, '') ILIKE '%' || $1 || '%'
       OR COALESCE(r.tel, '') ILIKE '%' || $1 || '%'
     )
     GROUP BY r.id
     ORDER BY r.representative_code ASC`,
    [kw],
  );
  return rows.map(toDto);
}

export async function createRepresentative(
  tx: DbExecutor,
  tenantId: string,
  input: RepresentativeInput,
): Promise<RepresentativeDto> {
  const clean = validateRepresentativeInput(input);
  try {
    const rows = await tx.query<RepresentativeRow>(
      `INSERT INTO representatives (
         tenant_id, representative_code, representative_name, furigana,
         postal_code, address1, address2, tel, mobile, birth_date, gender_code
       ) VALUES (
         $1::uuid, $2, $3, $4, $5, $6, $7, $8, $9, $10::date, $11
       )
       RETURNING
         id, representative_code, representative_name, furigana,
         postal_code, address1, address2, tel, mobile,
         birth_date::text AS birth_date, gender_code,
         0::int AS linked_partner_count,
         created_at::text AS created_at, updated_at::text AS updated_at`,
      [
        tenantId,
        clean.representativeCode,
        clean.representativeName,
        clean.furigana,
        clean.postalCode,
        clean.address1,
        clean.address2,
        clean.tel,
        clean.mobile,
        clean.birthDate,
        clean.genderCode,
      ],
    );
    const row = rows[0];
    if (row === undefined) {
      throw new MasterDataError(500, 'INSERT_FAILED', '代表者の登録結果を取得できませんでした。');
    }
    return toDto(row);
  } catch (err) {
    throw mapPgConstraintError(err, {
      entityLabel: '代表者',
      defaultUniqueMessage: `代表者コード「${clean.representativeCode}」は既に登録されています。別のコードを指定してください。`,
    });
  }
}

export async function updateRepresentative(
  tx: DbExecutor,
  id: string,
  input: RepresentativeInput,
): Promise<RepresentativeDto> {
  validateUuid(id);
  const clean = validateRepresentativeInput(input);
  try {
    const rows = await tx.query<RepresentativeRow>(
      `UPDATE representatives
       SET
         representative_code = $2,
         representative_name = $3,
         furigana = $4,
         postal_code = $5,
         address1 = $6,
         address2 = $7,
         tel = $8,
         mobile = $9,
         birth_date = $10::date,
         gender_code = $11
       WHERE id = $1::uuid
       RETURNING
         id, representative_code, representative_name, furigana,
         postal_code, address1, address2, tel, mobile,
         birth_date::text AS birth_date, gender_code,
         (SELECT COUNT(*)::int FROM business_partners bp WHERE bp.representative_id = representatives.id) AS linked_partner_count,
         created_at::text AS created_at, updated_at::text AS updated_at`,
      [
        id,
        clean.representativeCode,
        clean.representativeName,
        clean.furigana,
        clean.postalCode,
        clean.address1,
        clean.address2,
        clean.tel,
        clean.mobile,
        clean.birthDate,
        clean.genderCode,
      ],
    );
    if (rows.length === 0) {
      throw new MasterDataError(404, 'REPRESENTATIVE_NOT_FOUND', '指定された代表者が見つかりません。');
    }
    const row = rows[0];
    if (row === undefined) {
      throw new MasterDataError(500, 'INSERT_FAILED', '代表者の登録結果を取得できませんでした。');
    }
    return toDto(row);
  } catch (err) {
    throw mapPgConstraintError(err, {
      entityLabel: '代表者',
      defaultUniqueMessage: `代表者コード「${clean.representativeCode}」は既に他の代表者に登録されています。`,
    });
  }
}

export async function deleteRepresentative(tx: DbExecutor, id: string): Promise<void> {
  validateUuid(id);
  const refRows = await tx.query<{ ref_count: string | number }>(
    `SELECT COUNT(*)::int AS ref_count
     FROM business_partners
     WHERE representative_id = $1::uuid`,
    [id],
  );
  const refCount = Number(refRows[0]?.ref_count);
  if (refCount > 0) {
    throw new MasterDataError(
      409,
      'REPRESENTATIVE_IN_USE',
      `この代表者は取引先マスタ（${refCount}件）から参照されているため削除できません。`,
    );
  }

  try {
    const delRows = await tx.query<{ id: string }>(
      `DELETE FROM representatives
       WHERE id = $1::uuid
       RETURNING id`,
      [id],
    );
    if (delRows.length === 0) {
      throw new MasterDataError(404, 'REPRESENTATIVE_NOT_FOUND', '指定された代表者が見つかりません。');
    }
  } catch (err) {
    throw mapPgConstraintError(err, {
      entityLabel: '代表者',
      defaultFkMessage: 'この代表者は他のマスタ・取引データから参照されているため削除できません。',
    });
  }
}
