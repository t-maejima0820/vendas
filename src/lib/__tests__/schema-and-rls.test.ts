import fs from 'node:fs';
import path from 'node:path';
import { PGlite } from '@electric-sql/pglite';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { hashPassword } from '@/lib/crypto/field-cipher';
import {
  withBillingTransition,
  withExecutorTenantContext,
  type DbExecutor,
} from '@/lib/db/tenant-client';

function createPgliteExecutor(db: PGlite): DbExecutor {
  return {
    async query<T extends Record<string, unknown>>(
      sql: string,
      params?: readonly unknown[],
    ): Promise<T[]> {
      const result = await db.query<T>(sql, params === undefined ? undefined : [...params]);
      return result.rows;
    },
  };
}

describe('PostgreSQL スキーマ・RLS・複合FK・トリガー結合テスト (PGlite)', () => {
  let db: PGlite;
  let exec: DbExecutor;

  const tenantAId = '11111111-1111-4111-8111-111111111111';
  const tenantBId = '22222222-2222-4222-8222-222222222222';
  const empAId = 'aaaa1111-1111-4111-8111-111111111111';
  const empBId = 'bbbb2222-2222-4222-8222-222222222222';
  const partnerAId = 'aaaa3333-1111-4111-8111-111111111111';
  const partnerBId = 'bbbb3333-2222-4222-8222-222222222222';
  const projectBId = 'bbbb4444-2222-4222-8222-222222222222';

  beforeAll(async () => {
    db = new PGlite();
    exec = createPgliteExecutor(db);

    const rootDir = process.cwd();
    const schemaSql = fs.readFileSync(
      path.join(rootDir, 'supabase', 'migrations', '0001_schema.sql'),
      'utf8',
    );
    const rlsSql = fs.readFileSync(
      path.join(rootDir, 'supabase', 'migrations', '0002_rls_policies.sql'),
      'utf8',
    );
    const authSecSql = fs.readFileSync(
      path.join(rootDir, 'supabase', 'migrations', '0003_auth_security.sql'),
      'utf8',
    );
    const completeCodeMastersSql = fs.readFileSync(
      path.join(rootDir, 'supabase', 'migrations', '0004_complete_code_masters_seed.sql'),
      'utf8',
    );
    const seedSql = fs.readFileSync(
      path.join(rootDir, 'supabase', 'seed', 'default_codes.sql'),
      'utf8',
    );

    await db.exec(schemaSql);
    await db.exec(rlsSql);
    await db.exec(authSecSql);
    await db.exec(completeCodeMastersSql);
    await db.exec(seedSql);

    await db.query(
      `INSERT INTO tenants (id, tenant_slug, tenant_name) VALUES
        ($1, 'company-a', '株式会社A'),
        ($2, 'company-b', '株式会社B')`,
      [tenantAId, tenantBId],
    );

    await db.query(
      `INSERT INTO tenant_settings (tenant_id, company_code, company_name, opening_balance_date) VALUES
        ($1, '1001', '株式会社A', '2026-05-31'),
        ($2, '2001', '株式会社B', '2026-05-31')`,
      [tenantAId, tenantBId],
    );

    await db.query('SELECT seed_tenant_defaults($1)', [tenantAId]);
    await db.query('SELECT seed_tenant_defaults($1)', [tenantBId]);

    const pwHash = hashPassword('VendasTest!2026');
    await db.query(
      `INSERT INTO employees (id, tenant_id, syain_code, syain_name, password_hash, is_admin) VALUES
        ($1, $2, 'E001', 'A社管理者', $3, true),
        ($4, $5, 'E001', 'B社管理者', $3, true)`,
      [empAId, tenantAId, pwHash, empBId, tenantBId],
    );

    await db.query(
      `INSERT INTO business_partners (id, tenant_id, partner_code, partner_name, is_client, is_supplier) VALUES
        ($1, $2, 'P-A01', 'A社顧客兼仕入先', true, true),
        ($3, $4, 'P-B01', 'B社顧客兼仕入先', true, true)`,
      [partnerAId, tenantAId, partnerBId, tenantBId],
    );

    await db.query(
      `INSERT INTO projects (id, tenant_id, project_no, project_name, project_date, partner_id, partner_name_snap) VALUES
        ($1, $2, 20260001, 'B社専用工事', '2026-06-01', $3, 'B社顧客兼仕入先')`,
      [projectBId, tenantBId, partnerBId],
    );
  }, 30_000);

  afterAll(async () => {
    await db.close();
  });

  it('40業務テーブル + auth_rate_limits(計41表)・vendas_app (NOBYPASSRLS)・seed_tenant_defaults(29機能等) が正常構成されていること', async () => {
    const tables = await exec.query<{ tablename: string }>(
      `SELECT tablename FROM pg_tables WHERE schemaname = 'public' ORDER BY tablename`,
    );
    expect(tables).toHaveLength(41);

    const bizTables = await exec.query<{ tablename: string }>(
      `SELECT tablename FROM count_public_business_rows()`,
    );
    expect(bizTables).toHaveLength(40);

    const roleRows = await exec.query<{ rolname: string; rolbypassrls: boolean; rolsuper: boolean }>(
      `SELECT rolname, rolbypassrls, rolsuper FROM pg_roles WHERE rolname = 'vendas_app'`,
    );
    expect(roleRows).toHaveLength(1);
    expect(roleRows[0]?.rolbypassrls).toBe(false);
    expect(roleRows[0]?.rolsuper).toBe(false);

    const featCount = await exec.query<{ cnt: string }>(
      `SELECT COUNT(*)::text AS cnt FROM tenant_feature_authorities WHERE tenant_id = $1`,
      [tenantAId],
    );
    expect(Number(featCount[0]?.cnt)).toBe(29);

    const taxCount = await exec.query<{ cnt: string }>(
      `SELECT COUNT(*)::text AS cnt FROM tax_codes WHERE tenant_id = $1`,
      [tenantAId],
    );
    expect(Number(taxCount[0]?.cnt)).toBe(5);

    const pmCount = await exec.query<{ cnt: string }>(
      `SELECT COUNT(*)::text AS cnt FROM payment_methods WHERE tenant_id = $1`,
      [tenantAId],
    );
    expect(Number(pmCount[0]?.cnt)).toBe(9);

    const unitCount = await exec.query<{ cnt: string }>(
      `SELECT COUNT(*)::text AS cnt FROM units WHERE tenant_id = $1`,
      [tenantAId],
    );
    expect(Number(unitCount[0]?.cnt)).toBe(25);

    const cmCount = await exec.query<{ cnt: string }>(
      `SELECT COUNT(*)::text AS cnt FROM code_masters WHERE tenant_id = $1`,
      [tenantAId],
    );
    expect(Number(cmCount[0]?.cnt)).toBe(105);
  });

  it('是正1: vendas_app 実行時RLSで他テナントデータが完全遮断され、app.current_tenant_id未設定時はFail-Closed、authenticate_employee_lookupのみ照会可能であること', async () => {
    // 1) app.current_tenant_id 未設定かつ vendas_app では直SELECTが0件 (Fail-Closed)
    await db.query('BEGIN');
    try {
      await db.query('SET LOCAL ROLE vendas_app');
      const directEmployees = await exec.query<{ id: string }>('SELECT id FROM employees');
      expect(directEmployees).toHaveLength(0);

      const authLookup = await exec.query<{
        tenant_id: string;
        employee_id: string;
        syain_name: string;
      }>('SELECT tenant_id, employee_id, syain_name FROM authenticate_employee_lookup($1, $2)', [
        'company-a',
        'E001',
      ]);
      expect(authLookup).toHaveLength(1);
      expect(authLookup[0]?.tenant_id).toBe(tenantAId);
      expect(authLookup[0]?.employee_id).toBe(empAId);
      expect(authLookup[0]?.syain_name).toBe('A社管理者');
    } finally {
      await db.query('ROLLBACK');
    }

    // 2) withExecutorTenantContext で Tenant A に切り替え -> A社データのみ参照可能
    const aPartners = await withExecutorTenantContext(
      exec,
      { tenantId: tenantAId, employeeId: empAId, role: 'vendas_app' },
      async (tx) => tx.query<{ id: string; partner_code: string }>('SELECT id, partner_code FROM business_partners'),
    );
    expect(aPartners.map((r) => r.partner_code)).toEqual(['P-A01']);

    // 3) Tenant B に切り替え -> B社データのみ参照可能
    const bPartners = await withExecutorTenantContext(
      exec,
      { tenantId: tenantBId, employeeId: empBId, role: 'vendas_app' },
      async (tx) => tx.query<{ id: string; partner_code: string }>('SELECT id, partner_code FROM business_partners'),
    );
    expect(bPartners.map((r) => r.partner_code)).toEqual(['P-B01']);

    // 4) Tenant A コンテキストから Tenant B の tenant_id で INSERT すると RLS で拒否
    await expect(
      withExecutorTenantContext(
        exec,
        { tenantId: tenantAId, employeeId: empAId, role: 'vendas_app' },
        async (tx) =>
          tx.query(
            `INSERT INTO business_partners (tenant_id, partner_code, partner_name) VALUES ($1, 'EVIL', '越境試行')`,
            [tenantBId],
          ),
      ),
    ).rejects.toThrow(/row-level security/i);
  });

  it('是正2: 複合外部キー (tenant_id, id) により、テーブルオーナー権限下でも他テナントの親ID参照をDB物理制約で拒否すること', async () => {
    // Tenant A の sales_headers が Tenant B の business_partners.id を参照しようとする
    await expect(
      db.query(
        `INSERT INTO sales_headers (tenant_id, entry_type, slip_no, slip_name, slip_date, partner_id)
         VALUES ($1, 'SALE', 9901, '越境参照テスト', '2026-06-05', $2)`,
        [tenantAId, partnerBId],
      ),
    ).rejects.toThrow(/foreign key constraint/i);

    // Tenant A の purchase が Tenant A の仕入先を使いつつ、purchase_lines で Tenant B の project_id を参照しようとする
    const [poRow] = await exec.query<{ id: string }>(
      `INSERT INTO purchases (tenant_id, purchase_no, purchase_name, purchase_date, supplier_id, status)
       VALUES ($1, 8801, 'FK検証仕入', '2026-06-05', $2, 'P1')
       RETURNING id`,
      [tenantAId, partnerAId],
    );
    expect(poRow?.id).toBeDefined();

    await expect(
      db.query(
        `INSERT INTO purchase_lines (tenant_id, purchase_id, line_no, project_id, item_name)
         VALUES ($1, $2, 1, $3, '越境工事参照')`,
        [tenantAId, poRow!.id, projectBId],
      ),
    ).rejects.toThrow(/foreign key constraint/i);

    await db.query('DELETE FROM purchases WHERE id = $1', [poRow!.id]);
  });

  it('document_snapshots のイミュータブルトリガーにより UPDATE と DELETE が禁止されること', async () => {
    const snapId = await withExecutorTenantContext(
      exec,
      { tenantId: tenantAId, employeeId: empAId, role: 'vendas_app' },
      async (tx) => {
        const rows = await tx.query<{ id: string }>(
          `INSERT INTO document_snapshots (
            tenant_id, document_type, source_entity_type, source_entity_id,
            document_no, version_no, is_reissue, template_variant,
            issued_by, payload_json, payload_sha256
          ) VALUES (
            $1, 'ESTIMATE', 'QUOTATION', $2,
            'EST-0001', 1, false, 'STANDARD',
            $3, '{"schemaVersion":1}'::jsonb, $4
          ) RETURNING id`,
          [tenantAId, 'cccccccc-1111-4111-8111-111111111111', empAId, 'a'.repeat(64)],
        );
        return rows[0]!.id;
      },
    );

    await expect(
      withExecutorTenantContext(
        exec,
        { tenantId: tenantAId, employeeId: empAId, role: 'vendas_app' },
        async (tx) =>
          tx.query(`UPDATE document_snapshots SET document_no = 'TAMPERED' WHERE id = $1`, [snapId]),
      ),
    ).rejects.toThrow(/UPDATE \/ DELETE できません/);

    await expect(
      withExecutorTenantContext(
        exec,
        { tenantId: tenantAId, employeeId: empAId, role: 'vendas_app' },
        async (tx) => tx.query(`DELETE FROM document_snapshots WHERE id = $1`, [snapId]),
      ),
    ).rejects.toThrow(/UPDATE \/ DELETE できません/);
  });

  it('是正4: prevent_mutation_on_or_before_cutoff が基準日以前の請求・入金・買掛・支払・P3仕入を拒否し、P1/P2仕掛仕入の編集および基準日後P3確定を許可すること', async () => {
    // 基準日(2026-05-31)以前の billing_headers 登録は拒否、2026-06-01 は許可
    await expect(
      withExecutorTenantContext(
        exec,
        { tenantId: tenantAId, employeeId: empAId, role: 'vendas_app' },
        async (tx) =>
          tx.query(
            `INSERT INTO billing_headers (tenant_id, billing_no, partner_id, billing_date)
             VALUES ($1, 1001, $2, '2026-05-31')`,
            [tenantAId, partnerAId],
          ),
      ),
    ).rejects.toThrow(/期首残高基準日/);

    await withExecutorTenantContext(
      exec,
      { tenantId: tenantAId, employeeId: empAId, role: 'vendas_app' },
      async (tx) =>
        tx.query(
          `INSERT INTO billing_headers (tenant_id, billing_no, partner_id, billing_date)
           VALUES ($1, 1002, $2, '2026-06-01')`,
          [tenantAId, partnerAId],
        ),
    );

    // 基準日以前の cash_receipts / supplier_payments は拒否
    await expect(
      withExecutorTenantContext(
        exec,
        { tenantId: tenantAId, employeeId: empAId, role: 'vendas_app' },
        async (tx) =>
          tx.query(
            `INSERT INTO cash_receipts (tenant_id, receipt_no, receipt_date, partner_id, deposit_1)
             VALUES ($1, 2001, '2026-05-31', $2, 10000)`,
            [tenantAId, partnerAId],
          ),
      ),
    ).rejects.toThrow(/期首残高基準日/);

    await expect(
      withExecutorTenantContext(
        exec,
        { tenantId: tenantAId, employeeId: empAId, role: 'vendas_app' },
        async (tx) =>
          tx.query(
            `INSERT INTO supplier_payments (tenant_id, payment_no, payment_date, supplier_id, amount_1)
             VALUES ($1, 3001, '2026-05-31', $2, 5000)`,
            [tenantAId, partnerAId],
          ),
      ),
    ).rejects.toThrow(/期首残高基準日/);

    // purchases: 基準日以前の仕掛(P1/P2)は登録・編集ともに許可
    const wipId = await withExecutorTenantContext(
      exec,
      { tenantId: tenantAId, employeeId: empAId, role: 'vendas_app' },
      async (tx) => {
        const inserted = await tx.query<{ id: string }>(
          `INSERT INTO purchases (tenant_id, purchase_no, purchase_name, purchase_date, supplier_id, status)
           VALUES ($1, 7001, '移行仕掛P1', '2026-05-15', $2, 'P1')
           RETURNING id`,
          [tenantAId, partnerAId],
        );
        await tx.query(
          `UPDATE purchases SET status = 'P2', purchase_name = '移行仕掛P2更新' WHERE id = $1`,
          [inserted[0]!.id],
        );
        return inserted[0]!.id;
      },
    );

    // 基準日以前の日付のまま P3 へ確定するのは拒否
    await expect(
      withExecutorTenantContext(
        exec,
        { tenantId: tenantAId, employeeId: empAId, role: 'vendas_app' },
        async (tx) =>
          tx.query(`UPDATE purchases SET status = 'P3' WHERE id = $1`, [wipId]),
      ),
    ).rejects.toThrow(/仕入済\(P3\)の登録・確定はできません/);

    // purchase_date を基準日後(2026-06-02)にして P3 へ確定するのは許可
    await withExecutorTenantContext(
      exec,
      { tenantId: tenantAId, employeeId: empAId, role: 'vendas_app' },
      async (tx) =>
        tx.query(
          `UPDATE purchases SET status = 'P3', purchase_date = '2026-06-02' WHERE id = $1`,
          [wipId],
        ),
    );

    // ETLバイパスで作成された基準日以前の P3 仕入・payable_ledgers は、通常運用では変更・削除禁止
    await db.query('BEGIN');
    await db.query("SELECT set_config('app.etl_bypass_cutoff', 'on', true)");
    const [legacyP3] = await exec.query<{ id: string }>(
      `INSERT INTO purchases (tenant_id, purchase_no, purchase_name, purchase_date, supplier_id, status)
       VALUES ($1, 7002, '基準日前P3', '2026-05-20', $2, 'P3') RETURNING id`,
      [tenantAId, partnerAId],
    );
    await db.query(
      `INSERT INTO payable_ledgers (tenant_id, supplier_id, purchase_id, purchase_date, payable_amount)
       VALUES ($1, $2, $3, '2026-05-20', 50000)`,
      [tenantAId, partnerAId, legacyP3!.id],
    );
    await db.query('COMMIT');

    await expect(
      withExecutorTenantContext(
        exec,
        { tenantId: tenantAId, employeeId: empAId, role: 'vendas_app' },
        async (tx) => tx.query(`DELETE FROM purchases WHERE id = $1`, [legacyP3!.id]),
      ),
    ).rejects.toThrow(/確定済仕入\(P3/);

    await expect(
      withExecutorTenantContext(
        exec,
        { tenantId: tenantAId, employeeId: empAId, role: 'vendas_app' },
        async (tx) =>
          tx.query(`UPDATE payable_ledgers SET payable_amount = 0 WHERE purchase_id = $1`, [
            legacyP3!.id,
          ]),
      ),
    ).rejects.toThrow(/期首残高基準日/);
  });

  it('prevent_billed_sales_mutation が K4/K5 売上・明細をロックし、withBillingTransition 内のみ遷移許可すること', async () => {
    const saleId = await withExecutorTenantContext(
      exec,
      { tenantId: tenantAId, employeeId: empAId, role: 'vendas_app' },
      async (tx) => {
        const [hdr] = await tx.query<{ id: string }>(
          `INSERT INTO sales_headers (tenant_id, entry_type, slip_no, slip_name, slip_date, partner_id, status)
           VALUES ($1, 'SALE', 5001, '請求ロック検証売上', '2026-06-10', $2, 'K1')
           RETURNING id`,
          [tenantAId, partnerAId],
        );
        await tx.query(
          `INSERT INTO sales_lines (tenant_id, sales_header_id, line_no, item_name, quantity, applied_unit_price, tax_code, line_amount, line_tax, row_total)
           VALUES ($1, $2, 1, 'テスト品目', 1, 10000, 'A', 10000, 1000, 11000)`,
          [tenantAId, hdr!.id],
        );
        // K1 -> K3 -> K4
        await tx.query(`UPDATE sales_headers SET status = 'K3' WHERE id = $1`, [hdr!.id]);
        await tx.query(`UPDATE sales_headers SET status = 'K4' WHERE id = $1`, [hdr!.id]);
        return hdr!.id;
      },
    );

    // K4 確定後の通常UPDATE・明細INSERT/UPDATEはトリガーで禁止
    await expect(
      withExecutorTenantContext(
        exec,
        { tenantId: tenantAId, employeeId: empAId, role: 'vendas_app' },
        async (tx) => tx.query(`UPDATE sales_headers SET slip_name = '改ざん' WHERE id = $1`, [saleId]),
      ),
    ).rejects.toThrow(/請求済み\(K4\/K5\)/);

    await expect(
      withExecutorTenantContext(
        exec,
        { tenantId: tenantAId, employeeId: empAId, role: 'vendas_app' },
        async (tx) =>
          tx.query(
            `INSERT INTO sales_lines (tenant_id, sales_header_id, line_no, item_name, quantity, applied_unit_price, tax_code, line_amount, line_tax, row_total)
             VALUES ($1, $2, 2, '勝手追加', 1, 1000, 'A', 1000, 100, 1100)`,
            [tenantAId, saleId],
          ),
      ),
    ).rejects.toThrow(/請求済み\(K4\/K5\)/);

    // withBillingTransition 内では K4 -> K5 遷移が許可される
    await withExecutorTenantContext(
      exec,
      { tenantId: tenantAId, employeeId: empAId, role: 'vendas_app' },
      async (tx) =>
        withBillingTransition(tx, async () => {
          await tx.query(`UPDATE sales_headers SET status = 'K5' WHERE id = $1`, [saleId]);
        }),
    );

    const statusRows = await withExecutorTenantContext(
      exec,
      { tenantId: tenantAId, employeeId: empAId, role: 'vendas_app' },
      async (tx) => tx.query<{ status: string }>(`SELECT status FROM sales_headers WHERE id = $1`, [saleId]),
    );
    expect(statusRows[0]?.status).toBe('K5');
  });
});
