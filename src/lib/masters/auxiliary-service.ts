import type { DbExecutor } from '@/lib/db/tenant-client';
import { mapPgConstraintError, MasterDataError } from '@/lib/masters/error-mapper';
import type {
  InputIntelligenceDto,
  InputIntelligenceInput,
  InputIntelligencePageDto,
  MailTemplateDto,
  MailTemplateInput,
  TaxOfficeDto,
  TaxOfficeInput,
} from '@/lib/masters/types';

type MailTemplateRow = {
  id: string;
  template_no: number;
  template_name: string;
  subject: string;
  body_intro: string | null;
  body_main: string | null;
  body_footer: string | null;
  created_at: string;
  updated_at: string;
};

type IntelligenceRow = {
  id: string;
  item_name: string;
  unit_name: string | null;
  unit_price: string | number;
  cost_price: string | number;
  tax_code: 'A' | 'B' | 'C' | 'D' | 'E';
  created_at: string;
  updated_at: string;
};

type TaxOfficeRow = {
  id: string;
  tax_office_code: string;
  tax_office_name: string;
  tax_office_no: string | null;
  linked_advisory_count: string | number;
  created_at: string;
  updated_at: string;
};

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const VALID_TAX_CODES = new Set(['A', 'B', 'C', 'D', 'E']);

function optTrimmed(val: string | null | undefined): string | null {
  if (val === null || val === undefined) {
    return null;
  }
  const trimmed = val.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function validateUuid(id: string, label: string): void {
  if (!UUID_REGEX.test(id)) {
    throw new MasterDataError(400, 'INVALID_ID', `${label}IDの形式が不正です。`);
  }
}

// ----------------------------------------------------------------------------
// 1. メール定型文マスタ (mail_templates)
// ----------------------------------------------------------------------------
function validateMailTemplateInput(input: MailTemplateInput): MailTemplateInput {
  if (!Number.isInteger(input.templateNo) || input.templateNo < 1 || input.templateNo > 2147483647) {
    throw new MasterDataError(400, 'INVALID_TEMPLATE_NO', '定型文番号は1以上の整数で入力してください。');
  }
  const templateName = input.templateName.trim();
  if (templateName.length === 0 || templateName.length > 100) {
    throw new MasterDataError(400, 'INVALID_TEMPLATE_NAME', 'テンプレート名は1〜100文字で入力してください。');
  }
  const subject = input.subject.trim();
  if (subject.length === 0 || subject.length > 200) {
    throw new MasterDataError(400, 'INVALID_SUBJECT', '件名は1〜200文字で入力してください。');
  }
  return {
    templateNo: input.templateNo,
    templateName,
    subject,
    bodyIntro: input.bodyIntro !== null && input.bodyIntro.length > 0 ? input.bodyIntro : null,
    bodyMain: input.bodyMain !== null && input.bodyMain.length > 0 ? input.bodyMain : null,
    bodyFooter: input.bodyFooter !== null && input.bodyFooter.length > 0 ? input.bodyFooter : null,
  };
}

function mapMailTemplateRow(row: MailTemplateRow): MailTemplateDto {
  return {
    id: row.id,
    templateNo: Number(row.template_no),
    templateName: row.template_name,
    subject: row.subject,
    bodyIntro: row.body_intro,
    bodyMain: row.body_main,
    bodyFooter: row.body_footer,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export async function listMailTemplates(
  tx: DbExecutor,
  keyword?: string | null,
): Promise<MailTemplateDto[]> {
  const kw = optTrimmed(keyword);
  const rows = await tx.query<MailTemplateRow>(
    `SELECT id, template_no, template_name, subject, body_intro, body_main, body_footer,
            created_at::text AS created_at, updated_at::text AS updated_at
     FROM mail_templates
     WHERE (
       $1::text IS NULL
       OR CAST(template_no AS text) ILIKE '%' || $1 || '%'
       OR template_name ILIKE '%' || $1 || '%'
       OR subject ILIKE '%' || $1 || '%'
     )
     ORDER BY template_no ASC`,
    [kw],
  );
  return rows.map(mapMailTemplateRow);
}

export async function createMailTemplate(
  tx: DbExecutor,
  tenantId: string,
  input: MailTemplateInput,
): Promise<MailTemplateDto> {
  const clean = validateMailTemplateInput(input);
  try {
    const rows = await tx.query<MailTemplateRow>(
      `INSERT INTO mail_templates (
         tenant_id, template_no, template_name, subject, body_intro, body_main, body_footer
       ) VALUES ($1::uuid, $2, $3, $4, $5, $6, $7)
       RETURNING id, template_no, template_name, subject, body_intro, body_main, body_footer,
                 created_at::text AS created_at, updated_at::text AS updated_at`,
      [
        tenantId,
        clean.templateNo,
        clean.templateName,
        clean.subject,
        clean.bodyIntro,
        clean.bodyMain,
        clean.bodyFooter,
      ],
    );
    const row = rows[0];
    if (row === undefined) {
      throw new MasterDataError(500, 'INSERT_FAILED', 'メール定型文の登録結果を取得できませんでした。');
    }
    return mapMailTemplateRow(row);
  } catch (err) {
    throw mapPgConstraintError(err, {
      entityLabel: 'メール定型文',
      defaultUniqueMessage: `定型文番号「${clean.templateNo}」は既に登録されています。別の番号を指定してください。`,
    });
  }
}

export async function updateMailTemplate(
  tx: DbExecutor,
  id: string,
  input: MailTemplateInput,
): Promise<MailTemplateDto> {
  validateUuid(id, 'メール定型文');
  const clean = validateMailTemplateInput(input);
  try {
    const rows = await tx.query<MailTemplateRow>(
      `UPDATE mail_templates
       SET template_no = $2, template_name = $3, subject = $4,
           body_intro = $5, body_main = $6, body_footer = $7
       WHERE id = $1::uuid
       RETURNING id, template_no, template_name, subject, body_intro, body_main, body_footer,
                 created_at::text AS created_at, updated_at::text AS updated_at`,
      [
        id,
        clean.templateNo,
        clean.templateName,
        clean.subject,
        clean.bodyIntro,
        clean.bodyMain,
        clean.bodyFooter,
      ],
    );
    const row = rows[0];
    if (row === undefined) {
      throw new MasterDataError(404, 'MAIL_TEMPLATE_NOT_FOUND', '指定されたメール定型文が見つかりません。');
    }
    return mapMailTemplateRow(row);
  } catch (err) {
    throw mapPgConstraintError(err, {
      entityLabel: 'メール定型文',
      defaultUniqueMessage: `定型文番号「${clean.templateNo}」は既に他のテンプレートに使用されています。`,
    });
  }
}

export async function deleteMailTemplate(tx: DbExecutor, id: string): Promise<void> {
  validateUuid(id, 'メール定型文');
  const delRows = await tx.query<{ id: string }>(
    `DELETE FROM mail_templates WHERE id = $1::uuid RETURNING id`,
    [id],
  );
  if (delRows.length === 0) {
    throw new MasterDataError(404, 'MAIL_TEMPLATE_NOT_FOUND', '指定されたメール定型文が見つかりません。');
  }
}

// ----------------------------------------------------------------------------
// 2. 品名・単価入力候補マスタ (input_intelligences)
// ----------------------------------------------------------------------------
function validateIntelligenceInput(input: InputIntelligenceInput): InputIntelligenceInput {
  const itemName = input.itemName.trim();
  if (itemName.length === 0 || itemName.length > 200) {
    throw new MasterDataError(400, 'INVALID_ITEM_NAME', '品名は1〜200文字で入力してください。');
  }
  if (!Number.isInteger(input.unitPrice) || Math.abs(input.unitPrice) > 999999999999) {
    throw new MasterDataError(400, 'INVALID_UNIT_PRICE', '売価単価は整数で入力してください。');
  }
  if (!Number.isInteger(input.costPrice) || Math.abs(input.costPrice) > 999999999999) {
    throw new MasterDataError(400, 'INVALID_COST_PRICE', '原価単価は整数で入力してください。');
  }
  if (!VALID_TAX_CODES.has(input.taxCode)) {
    throw new MasterDataError(400, 'INVALID_TAX_CODE', '税区分は A〜E のいずれかを指定してください。');
  }
  return {
    itemName,
    unitName: optTrimmed(input.unitName),
    unitPrice: input.unitPrice,
    costPrice: input.costPrice,
    taxCode: input.taxCode,
  };
}

function mapIntelligenceRow(row: IntelligenceRow): InputIntelligenceDto {
  return {
    id: row.id,
    itemName: row.item_name,
    unitName: row.unit_name,
    unitPrice: Number(row.unit_price),
    costPrice: Number(row.cost_price),
    taxCode: row.tax_code,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export async function listInputIntelligences(
  tx: DbExecutor,
  filter: {
    keyword?: string | null;
    taxCode?: string | null;
    page?: number;
    pageSize?: number;
  } = {},
): Promise<InputIntelligencePageDto> {
  const kw = optTrimmed(filter.keyword);
  const rawTax = optTrimmed(filter.taxCode);
  const taxCode = rawTax !== null && VALID_TAX_CODES.has(rawTax) ? rawTax : null;

  const rawPage = filter.page === undefined ? 1 : filter.page;
  const rawSize = filter.pageSize === undefined ? 25 : filter.pageSize;
  const page = Number.isInteger(rawPage) && rawPage >= 1 ? rawPage : 1;
  const pageSize = Number.isInteger(rawSize) && rawSize >= 1 && rawSize <= 200 ? rawSize : 25;
  const offset = (page - 1) * pageSize;

  const countRows = await tx.query<{ total_count: number }>(
    `SELECT COUNT(*)::int AS total_count
     FROM input_intelligences
     WHERE (
       $1::text IS NULL
       OR item_name ILIKE '%' || $1 || '%'
       OR COALESCE(unit_name, '') ILIKE '%' || $1 || '%'
     )
     AND ($2::text IS NULL OR tax_code = $2)`,
    [kw, taxCode],
  );
  const totalCount = Number(countRows[0]?.total_count);

  const rows = await tx.query<IntelligenceRow>(
    `SELECT id, item_name, unit_name, unit_price::text AS unit_price,
            cost_price::text AS cost_price, tax_code,
            created_at::text AS created_at, updated_at::text AS updated_at
     FROM input_intelligences
     WHERE (
       $1::text IS NULL
       OR item_name ILIKE '%' || $1 || '%'
       OR COALESCE(unit_name, '') ILIKE '%' || $1 || '%'
     )
     AND ($2::text IS NULL OR tax_code = $2)
     ORDER BY item_name ASC, created_at ASC
     LIMIT $3 OFFSET $4`,
    [kw, taxCode, pageSize, offset],
  );

  return {
    items: rows.map(mapIntelligenceRow),
    totalCount,
    page,
    pageSize,
  };
}

export async function createInputIntelligence(
  tx: DbExecutor,
  tenantId: string,
  input: InputIntelligenceInput,
): Promise<InputIntelligenceDto> {
  const clean = validateIntelligenceInput(input);
  try {
    const rows = await tx.query<IntelligenceRow>(
      `INSERT INTO input_intelligences (
         tenant_id, item_name, unit_name, unit_price, cost_price, tax_code
       ) VALUES ($1::uuid, $2, $3, $4, $5, $6)
       RETURNING id, item_name, unit_name, unit_price::text AS unit_price,
                 cost_price::text AS cost_price, tax_code,
                 created_at::text AS created_at, updated_at::text AS updated_at`,
      [tenantId, clean.itemName, clean.unitName, clean.unitPrice, clean.costPrice, clean.taxCode],
    );
    const row = rows[0];
    if (row === undefined) {
      throw new MasterDataError(500, 'INSERT_FAILED', '入力候補の登録結果を取得できませんでした。');
    }
    return mapIntelligenceRow(row);
  } catch (err) {
    throw mapPgConstraintError(err, { entityLabel: '入力候補' });
  }
}

export async function updateInputIntelligence(
  tx: DbExecutor,
  id: string,
  input: InputIntelligenceInput,
): Promise<InputIntelligenceDto> {
  validateUuid(id, '入力候補');
  const clean = validateIntelligenceInput(input);
  try {
    const rows = await tx.query<IntelligenceRow>(
      `UPDATE input_intelligences
       SET item_name = $2, unit_name = $3, unit_price = $4, cost_price = $5, tax_code = $6
       WHERE id = $1::uuid
       RETURNING id, item_name, unit_name, unit_price::text AS unit_price,
                 cost_price::text AS cost_price, tax_code,
                 created_at::text AS created_at, updated_at::text AS updated_at`,
      [id, clean.itemName, clean.unitName, clean.unitPrice, clean.costPrice, clean.taxCode],
    );
    const row = rows[0];
    if (row === undefined) {
      throw new MasterDataError(404, 'INTELLIGENCE_NOT_FOUND', '指定された入力候補が見つかりません。');
    }
    return mapIntelligenceRow(row);
  } catch (err) {
    throw mapPgConstraintError(err, { entityLabel: '入力候補' });
  }
}

export async function deleteInputIntelligence(tx: DbExecutor, id: string): Promise<void> {
  validateUuid(id, '入力候補');
  const delRows = await tx.query<{ id: string }>(
    `DELETE FROM input_intelligences WHERE id = $1::uuid RETURNING id`,
    [id],
  );
  if (delRows.length === 0) {
    throw new MasterDataError(404, 'INTELLIGENCE_NOT_FOUND', '指定された入力候補が見つかりません。');
  }
}

// ----------------------------------------------------------------------------
// 3. 税務署マスタ (tax_offices)
// ----------------------------------------------------------------------------
function validateTaxOfficeInput(input: TaxOfficeInput): TaxOfficeInput {
  const taxOfficeCode = input.taxOfficeCode.trim();
  if (taxOfficeCode.length === 0 || taxOfficeCode.length > 20) {
    throw new MasterDataError(400, 'INVALID_TAX_OFFICE_CODE', '税務署コードは1〜20文字で入力してください。');
  }
  const taxOfficeName = input.taxOfficeName.trim();
  if (taxOfficeName.length === 0 || taxOfficeName.length > 100) {
    throw new MasterDataError(400, 'INVALID_TAX_OFFICE_NAME', '税務署名は1〜100文字で入力してください。');
  }
  return {
    taxOfficeCode,
    taxOfficeName,
    taxOfficeNo: optTrimmed(input.taxOfficeNo),
  };
}

function mapTaxOfficeRow(row: TaxOfficeRow): TaxOfficeDto {
  return {
    id: row.id,
    taxOfficeCode: row.tax_office_code,
    taxOfficeName: row.tax_office_name,
    taxOfficeNo: row.tax_office_no,
    linkedAdvisoryCount: Number(row.linked_advisory_count),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export async function listTaxOffices(
  tx: DbExecutor,
  keyword?: string | null,
): Promise<TaxOfficeDto[]> {
  const kw = optTrimmed(keyword);
  const rows = await tx.query<TaxOfficeRow>(
    `SELECT
       t.id,
       t.tax_office_code,
       t.tax_office_name,
       t.tax_office_no,
       COUNT(ap.id)::int AS linked_advisory_count,
       t.created_at::text AS created_at,
       t.updated_at::text AS updated_at
     FROM tax_offices t
     LEFT JOIN partner_advisory_profiles ap
       ON ap.tenant_id = t.tenant_id AND ap.tax_office_id = t.id
     WHERE (
       $1::text IS NULL
       OR t.tax_office_code ILIKE '%' || $1 || '%'
       OR t.tax_office_name ILIKE '%' || $1 || '%'
       OR COALESCE(t.tax_office_no, '') ILIKE '%' || $1 || '%'
     )
     GROUP BY t.id
     ORDER BY t.tax_office_code ASC`,
    [kw],
  );
  return rows.map(mapTaxOfficeRow);
}

export async function createTaxOffice(
  tx: DbExecutor,
  tenantId: string,
  input: TaxOfficeInput,
): Promise<TaxOfficeDto> {
  const clean = validateTaxOfficeInput(input);
  try {
    const rows = await tx.query<TaxOfficeRow>(
      `INSERT INTO tax_offices (tenant_id, tax_office_code, tax_office_name, tax_office_no)
       VALUES ($1::uuid, $2, $3, $4)
       RETURNING id, tax_office_code, tax_office_name, tax_office_no, 0::int AS linked_advisory_count,
                 created_at::text AS created_at, updated_at::text AS updated_at`,
      [tenantId, clean.taxOfficeCode, clean.taxOfficeName, clean.taxOfficeNo],
    );
    const row = rows[0];
    if (row === undefined) {
      throw new MasterDataError(500, 'INSERT_FAILED', '税務署の登録結果を取得できませんでした。');
    }
    return mapTaxOfficeRow(row);
  } catch (err) {
    throw mapPgConstraintError(err, {
      entityLabel: '税務署',
      defaultUniqueMessage: `税務署コード「${clean.taxOfficeCode}」は既に登録されています。`,
    });
  }
}

export async function updateTaxOffice(
  tx: DbExecutor,
  id: string,
  input: TaxOfficeInput,
): Promise<TaxOfficeDto> {
  validateUuid(id, '税務署');
  const clean = validateTaxOfficeInput(input);
  try {
    const rows = await tx.query<TaxOfficeRow>(
      `UPDATE tax_offices
       SET tax_office_code = $2, tax_office_name = $3, tax_office_no = $4
       WHERE id = $1::uuid
       RETURNING id, tax_office_code, tax_office_name, tax_office_no,
                 (SELECT COUNT(*)::int FROM partner_advisory_profiles ap WHERE ap.tax_office_id = tax_offices.id) AS linked_advisory_count,
                 created_at::text AS created_at, updated_at::text AS updated_at`,
      [id, clean.taxOfficeCode, clean.taxOfficeName, clean.taxOfficeNo],
    );
    const row = rows[0];
    if (row === undefined) {
      throw new MasterDataError(404, 'TAX_OFFICE_NOT_FOUND', '指定された税務署が見つかりません。');
    }
    return mapTaxOfficeRow(row);
  } catch (err) {
    throw mapPgConstraintError(err, {
      entityLabel: '税務署',
      defaultUniqueMessage: `税務署コード「${clean.taxOfficeCode}」は既に他の税務署に使用されています。`,
    });
  }
}

export async function deleteTaxOffice(tx: DbExecutor, id: string): Promise<void> {
  validateUuid(id, '税務署');
  const refRows = await tx.query<{ ref_count: number }>(
    `SELECT COUNT(*)::int AS ref_count
     FROM partner_advisory_profiles
     WHERE tax_office_id = $1::uuid`,
    [id],
  );
  const refCount = Number(refRows[0]?.ref_count);
  if (refCount > 0) {
    throw new MasterDataError(
      409,
      'TAX_OFFICE_IN_USE',
      `この税務署は顧問プロファイル（${refCount}件）から参照されているため削除できません。`,
    );
  }

  try {
    const delRows = await tx.query<{ id: string }>(
      `DELETE FROM tax_offices WHERE id = $1::uuid RETURNING id`,
      [id],
    );
    if (delRows.length === 0) {
      throw new MasterDataError(404, 'TAX_OFFICE_NOT_FOUND', '指定された税務署が見つかりません。');
    }
  } catch (err) {
    throw mapPgConstraintError(err, {
      entityLabel: '税務署',
      defaultFkMessage: 'この税務署は他データから参照されているため削除できません。',
    });
  }
}
