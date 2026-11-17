import type { DbExecutor } from '@/lib/db/tenant-client';
import { mapPgConstraintError, MasterDataError } from '@/lib/masters/error-mapper';
import type {
  BankBranchDto,
  BankBranchInput,
  BankBranchPageDto,
  BankDto,
  BankInput,
} from '@/lib/masters/types';

type BankRow = {
  id: string;
  bank_code: string;
  bank_name: string;
  furigana: string | null;
  branch_count: string | number;
  created_at: string;
  updated_at: string;
};

type BankBranchRow = {
  id: string;
  bank_id: string;
  bank_code: string;
  bank_name: string;
  branch_code: string;
  branch_name: string;
  furigana: string | null;
  created_at: string;
  updated_at: string;
};

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function optTrimmed(val: string | null | undefined): string | null {
  if (val === null || val === undefined) {
    return null;
  }
  const trimmed = val.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function validateUuid(id: string, label: string): void {
  if (!UUID_REGEX.test(id)) {
    throw new MasterDataError(400, 'INVALID_ID', `${label}のID形式が不正です。`);
  }
}

function validateBankInput(input: BankInput): BankInput {
  const bankCode = input.bankCode.trim();
  if (bankCode.length === 0 || bankCode.length > 20) {
    throw new MasterDataError(400, 'INVALID_BANK_CODE', '銀行コードは1〜20文字で入力してください。');
  }
  const bankName = input.bankName.trim();
  if (bankName.length === 0 || bankName.length > 100) {
    throw new MasterDataError(400, 'INVALID_BANK_NAME', '銀行名は1〜100文字で入力してください。');
  }
  return {
    bankCode,
    bankName,
    furigana: optTrimmed(input.furigana),
  };
}

function validateBranchInput(input: BankBranchInput): BankBranchInput {
  validateUuid(input.bankId, '親銀行');
  const branchCode = input.branchCode.trim();
  if (branchCode.length === 0 || branchCode.length > 20) {
    throw new MasterDataError(400, 'INVALID_BRANCH_CODE', '支店コードは1〜20文字で入力してください。');
  }
  const branchName = input.branchName.trim();
  if (branchName.length === 0 || branchName.length > 100) {
    throw new MasterDataError(400, 'INVALID_BRANCH_NAME', '支店名は1〜100文字で入力してください。');
  }
  return {
    bankId: input.bankId,
    branchCode,
    branchName,
    furigana: optTrimmed(input.furigana),
  };
}

function mapBankRow(row: BankRow): BankDto {
  return {
    id: row.id,
    bankCode: row.bank_code,
    bankName: row.bank_name,
    furigana: row.furigana,
    branchCount: Number(row.branch_count),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function mapBranchRow(row: BankBranchRow): BankBranchDto {
  return {
    id: row.id,
    bankId: row.bank_id,
    bankCode: row.bank_code,
    bankName: row.bank_name,
    branchCode: row.branch_code,
    branchName: row.branch_name,
    furigana: row.furigana,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export async function listBanks(tx: DbExecutor, keyword?: string | null): Promise<BankDto[]> {
  const kw = optTrimmed(keyword);
  const rows = await tx.query<BankRow>(
    `SELECT
       b.id,
       b.bank_code,
       b.bank_name,
       b.furigana,
       COUNT(bb.id)::int AS branch_count,
       b.created_at::text AS created_at,
       b.updated_at::text AS updated_at
     FROM banks b
     LEFT JOIN bank_branches bb
       ON bb.tenant_id = b.tenant_id AND bb.bank_id = b.id
     WHERE (
       $1::text IS NULL
       OR b.bank_code ILIKE '%' || $1 || '%'
       OR b.bank_name ILIKE '%' || $1 || '%'
       OR COALESCE(b.furigana, '') ILIKE '%' || $1 || '%'
     )
     GROUP BY b.id
     ORDER BY b.bank_code ASC`,
    [kw],
  );
  return rows.map(mapBankRow);
}

export async function createBank(
  tx: DbExecutor,
  tenantId: string,
  input: BankInput,
): Promise<BankDto> {
  const clean = validateBankInput(input);
  try {
    const rows = await tx.query<BankRow>(
      `INSERT INTO banks (tenant_id, bank_code, bank_name, furigana)
       VALUES ($1::uuid, $2, $3, $4)
       RETURNING id, bank_code, bank_name, furigana, 0::int AS branch_count,
                 created_at::text AS created_at, updated_at::text AS updated_at`,
      [tenantId, clean.bankCode, clean.bankName, clean.furigana],
    );
    const row = rows[0];
    if (row === undefined) {
      throw new MasterDataError(500, 'INSERT_FAILED', '銀行の登録結果を取得できませんでした。');
    }
    return mapBankRow(row);
  } catch (err) {
    throw mapPgConstraintError(err, {
      entityLabel: '銀行',
      defaultUniqueMessage: `銀行コード「${clean.bankCode}」は既に登録されています。別のコードを指定してください。`,
    });
  }
}

export async function updateBank(
  tx: DbExecutor,
  id: string,
  input: BankInput,
): Promise<BankDto> {
  validateUuid(id, '銀行');
  const clean = validateBankInput(input);

  const curRows = await tx.query<{ id: string; bank_code: string }>(
    `SELECT id, bank_code FROM banks WHERE id = $1::uuid FOR UPDATE`,
    [id],
  );
  const cur = curRows[0];
  if (cur === undefined) {
    throw new MasterDataError(404, 'BANK_NOT_FOUND', '指定された銀行が見つかりません。');
  }

  try {
    const rows = await tx.query<BankRow>(
      `UPDATE banks
       SET bank_code = $2, bank_name = $3, furigana = $4
       WHERE id = $1::uuid
       RETURNING id, bank_code, bank_name, furigana,
                 (SELECT COUNT(*)::int FROM bank_branches bb WHERE bb.bank_id = banks.id) AS branch_count,
                 created_at::text AS created_at, updated_at::text AS updated_at`,
      [id, clean.bankCode, clean.bankName, clean.furigana],
    );
    const updated = rows[0];
    if (updated === undefined) {
      throw new MasterDataError(404, 'BANK_NOT_FOUND', '指定された銀行が見つかりません。');
    }
    if (cur.bank_code !== clean.bankCode) {
      await tx.query(
        `UPDATE bank_branches SET bank_code = $2 WHERE bank_id = $1::uuid`,
        [id, clean.bankCode],
      );
    }
    return mapBankRow(updated);
  } catch (err) {
    throw mapPgConstraintError(err, {
      entityLabel: '銀行',
      defaultUniqueMessage: `銀行コード「${clean.bankCode}」は既に他の銀行に登録されているか、配下の支店コードと重複しています。`,
    });
  }
}

export async function deleteBank(tx: DbExecutor, id: string): Promise<void> {
  validateUuid(id, '銀行');

  const refRows = await tx.query<{ ref_count: number }>(
    `SELECT COUNT(*)::int AS ref_count FROM bank_branches WHERE bank_id = $1::uuid`,
    [id],
  );
  const refCount = Number(refRows[0]?.ref_count);
  if (refCount > 0) {
    throw new MasterDataError(
      409,
      'BANK_HAS_BRANCHES',
      `この銀行には支店マスタ（${refCount}件）が紐付いているため削除できません。先に支店を削除してください。`,
    );
  }

  try {
    const delRows = await tx.query<{ id: string }>(
      `DELETE FROM banks WHERE id = $1::uuid RETURNING id`,
      [id],
    );
    if (delRows.length === 0) {
      throw new MasterDataError(404, 'BANK_NOT_FOUND', '指定された銀行が見つかりません。');
    }
  } catch (err) {
    throw mapPgConstraintError(err, {
      entityLabel: '銀行',
      defaultFkMessage: 'この銀行は支店または関連データから参照されているため削除できません。',
    });
  }
}

export async function listBankBranches(
  tx: DbExecutor,
  filter: {
    bankId?: string | null;
    keyword?: string | null;
    page?: number;
    pageSize?: number;
  } = {},
): Promise<BankBranchPageDto> {
  const bankId = optTrimmed(filter.bankId);
  if (bankId !== null) {
    validateUuid(bankId, '銀行');
  }
  const kw = optTrimmed(filter.keyword);

  const rawPage = filter.page === undefined ? 1 : filter.page;
  const rawSize = filter.pageSize === undefined ? 50 : filter.pageSize;
  const page = Number.isInteger(rawPage) && rawPage >= 1 ? rawPage : 1;
  const pageSize = Number.isInteger(rawSize) && rawSize >= 1 && rawSize <= 200 ? rawSize : 50;
  const offset = (page - 1) * pageSize;

  const countRows = await tx.query<{ total_count: number }>(
    `SELECT COUNT(*)::int AS total_count
     FROM bank_branches bb
     INNER JOIN banks b ON b.tenant_id = bb.tenant_id AND b.id = bb.bank_id
     WHERE ($1::uuid IS NULL OR bb.bank_id = $1::uuid)
       AND (
         $2::text IS NULL
         OR bb.bank_code ILIKE '%' || $2 || '%'
         OR b.bank_name ILIKE '%' || $2 || '%'
         OR bb.branch_code ILIKE '%' || $2 || '%'
         OR bb.branch_name ILIKE '%' || $2 || '%'
         OR COALESCE(bb.furigana, '') ILIKE '%' || $2 || '%'
       )`,
    [bankId, kw],
  );
  const totalCount = Number(countRows[0]?.total_count);

  const rows = await tx.query<BankBranchRow>(
    `SELECT
       bb.id,
       bb.bank_id,
       bb.bank_code,
       b.bank_name,
       bb.branch_code,
       bb.branch_name,
       bb.furigana,
       bb.created_at::text AS created_at,
       bb.updated_at::text AS updated_at
     FROM bank_branches bb
     INNER JOIN banks b ON b.tenant_id = bb.tenant_id AND b.id = bb.bank_id
     WHERE ($1::uuid IS NULL OR bb.bank_id = $1::uuid)
       AND (
         $2::text IS NULL
         OR bb.bank_code ILIKE '%' || $2 || '%'
         OR b.bank_name ILIKE '%' || $2 || '%'
         OR bb.branch_code ILIKE '%' || $2 || '%'
         OR bb.branch_name ILIKE '%' || $2 || '%'
         OR COALESCE(bb.furigana, '') ILIKE '%' || $2 || '%'
       )
     ORDER BY bb.bank_code ASC, bb.branch_code ASC
     LIMIT $3 OFFSET $4`,
    [bankId, kw, pageSize, offset],
  );

  return {
    items: rows.map(mapBranchRow),
    totalCount,
    page,
    pageSize,
  };
}

async function getBankBranchById(tx: DbExecutor, id: string): Promise<BankBranchDto> {
  const rows = await tx.query<BankBranchRow>(
    `SELECT
       bb.id,
       bb.bank_id,
       bb.bank_code,
       b.bank_name,
       bb.branch_code,
       bb.branch_name,
       bb.furigana,
       bb.created_at::text AS created_at,
       bb.updated_at::text AS updated_at
     FROM bank_branches bb
     INNER JOIN banks b ON b.tenant_id = bb.tenant_id AND b.id = bb.bank_id
     WHERE bb.id = $1::uuid`,
    [id],
  );
  const row = rows[0];
  if (row === undefined) {
    throw new MasterDataError(404, 'BRANCH_NOT_FOUND', '指定された支店が見つかりません。');
  }
  return mapBranchRow(row);
}

export async function createBankBranch(
  tx: DbExecutor,
  tenantId: string,
  input: BankBranchInput,
): Promise<BankBranchDto> {
  const clean = validateBranchInput(input);
  const bankRows = await tx.query<{ id: string; bank_code: string }>(
    `SELECT id, bank_code FROM banks WHERE id = $1::uuid`,
    [clean.bankId],
  );
  const parentBank = bankRows[0];
  if (parentBank === undefined) {
    throw new MasterDataError(400, 'BANK_NOT_FOUND', '親となる銀行が存在しません。');
  }

  let insertedId: string;
  try {
    const rows = await tx.query<{ id: string }>(
      `INSERT INTO bank_branches (tenant_id, bank_id, bank_code, branch_code, branch_name, furigana)
       VALUES ($1::uuid, $2::uuid, $3, $4, $5, $6)
       RETURNING id`,
      [tenantId, parentBank.id, parentBank.bank_code, clean.branchCode, clean.branchName, clean.furigana],
    );
    const first = rows[0];
    if (first === undefined) {
      throw new MasterDataError(500, 'INSERT_FAILED', '支店の登録結果を取得できませんでした。');
    }
    insertedId = first.id;
  } catch (err) {
    throw mapPgConstraintError(err, {
      entityLabel: '支店',
      defaultUniqueMessage: `銀行コード「${parentBank.bank_code}」の支店コード「${clean.branchCode}」は既に登録されています。`,
    });
  }
  return getBankBranchById(tx, insertedId);
}

export async function updateBankBranch(
  tx: DbExecutor,
  id: string,
  input: BankBranchInput,
): Promise<BankBranchDto> {
  validateUuid(id, '支店');
  const clean = validateBranchInput(input);

  const bankRows = await tx.query<{ id: string; bank_code: string }>(
    `SELECT id, bank_code FROM banks WHERE id = $1::uuid`,
    [clean.bankId],
  );
  const parentBank = bankRows[0];
  if (parentBank === undefined) {
    throw new MasterDataError(400, 'BANK_NOT_FOUND', '親となる銀行が存在しません。');
  }

  try {
    const rows = await tx.query<{ id: string }>(
      `UPDATE bank_branches
       SET bank_id = $2::uuid, bank_code = $3, branch_code = $4, branch_name = $5, furigana = $6
       WHERE id = $1::uuid
       RETURNING id`,
      [id, parentBank.id, parentBank.bank_code, clean.branchCode, clean.branchName, clean.furigana],
    );
    if (rows.length === 0) {
      throw new MasterDataError(404, 'BRANCH_NOT_FOUND', '指定された支店が見つかりません。');
    }
  } catch (err) {
    throw mapPgConstraintError(err, {
      entityLabel: '支店',
      defaultUniqueMessage: `銀行コード「${parentBank.bank_code}」の支店コード「${clean.branchCode}」は既に登録されています。`,
    });
  }
  return getBankBranchById(tx, id);
}

export async function deleteBankBranch(tx: DbExecutor, id: string): Promise<void> {
  validateUuid(id, '支店');
  const delRows = await tx.query<{ id: string }>(
    `DELETE FROM bank_branches WHERE id = $1::uuid RETURNING id`,
    [id],
  );
  if (delRows.length === 0) {
    throw new MasterDataError(404, 'BRANCH_NOT_FOUND', '指定された支店が見つかりません。');
  }
}
