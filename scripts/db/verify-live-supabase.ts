import assert from 'node:assert/strict';
import { Pool } from 'pg';
import { hashPassword } from '../../src/lib/crypto/field-cipher';
import {
  closePgPool,
  createPgPoolConfig,
  withTenantContext,
} from '../../src/lib/db/tenant-client';
import { requireEnv } from '../../src/lib/env';

async function expectReject(label: string, fn: () => Promise<unknown>, pattern: RegExp): Promise<string> {
  try {
    await fn();
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (!pattern.test(msg)) {
      throw new Error(`[${label}] 期待パターン ${pattern} に一致しません: ${msg}`);
    }
    return msg;
  }
  throw new Error(`[${label}] 例外送出を期待しましたが成功してしまいました`);
}

async function main(): Promise<void> {
  const directUrl = requireEnv('DIRECT_DATABASE_URL');
  const poolerUrl = requireEnv('DATABASE_URL');

  const directPool = new Pool(createPgPoolConfig(directUrl));
  const poolerPool = new Pool(createPgPoolConfig(poolerUrl));

  const tenantAId = '11111111-1111-4111-8111-111111111111';
  const tenantBId = '22222222-2222-4222-8222-222222222222';
  const empAId = 'aaaa1111-1111-4111-8111-111111111111';
  const empBId = 'bbbb2222-2222-4222-8222-222222222222';
  const partnerAId = 'aaaa3333-1111-4111-8111-111111111111';
  const partnerBId = 'bbbb3333-2222-4222-8222-222222222222';

  const summary: Record<string, unknown> = {};

  try {
    // テスト用仮テナントの事前掃除（万一の残骸排除）
    await directPool.query('BEGIN');
    for (const id of [tenantAId, tenantBId]) {
      await directPool.query('SELECT purge_tenant_cascade($1)', [id]);
    }
    await directPool.query('COMMIT');

    // 2テナント作成 (:5432 Direct Pooler Admin)
    await directPool.query(
      `INSERT INTO tenants (id, tenant_slug, tenant_name) VALUES
        ($1, 'live-check-a', '実機検証テナントA'),
        ($2, 'live-check-b', '実機検証テナントB')`,
      [tenantAId, tenantBId],
    );
    await directPool.query(
      `INSERT INTO tenant_settings (tenant_id, company_code, company_name, opening_balance_date) VALUES
        ($1, '9001', '実機検証テナントA', '2026-05-31'),
        ($2, '9002', '実機検証テナントB', '2026-05-31')`,
      [tenantAId, tenantBId],
    );
    await directPool.query('SELECT seed_tenant_defaults($1)', [tenantAId]);
    await directPool.query('SELECT seed_tenant_defaults($1)', [tenantBId]);

    const pwHash = hashPassword('LiveCheck!2026');
    await directPool.query(
      `INSERT INTO employees (id, tenant_id, syain_code, syain_name, password_hash, is_admin) VALUES
        ($1, $2, 'E001', '実機検証A管理者', $3, true),
        ($4, $5, 'E001', '実機検証B管理者', $3, true)`,
      [empAId, tenantAId, pwHash, empBId, tenantBId],
    );
    await directPool.query(
      `INSERT INTO business_partners (id, tenant_id, partner_code, partner_name, is_client, is_supplier) VALUES
        ($1, $2, 'P-A01', 'A社取引先', true, true),
        ($3, $4, 'P-B01', 'B社取引先', true, true)`,
      [partnerAId, tenantAId, partnerBId, tenantBId],
    );

    // 1) Pooler (:6543) で app.current_tenant_id 未設定時の Fail-Closed 検証
    // 2) authenticate_employee_lookup (SECURITY DEFINER) 検証
    const pClient = await poolerPool.connect();
    try {
      await pClient.query('BEGIN');
      await pClient.query('SET LOCAL ROLE vendas_app');
      await pClient.query("SELECT set_config('app.current_tenant_id', '', true)");
      const failClosedTenants = await pClient.query('SELECT id FROM tenants');
      const failClosedEmps = await pClient.query('SELECT id FROM employees');
      const failClosedBps = await pClient.query('SELECT id FROM business_partners');
      assert.equal(failClosedTenants.rows.length, 0);
      assert.equal(failClosedEmps.rows.length, 0);
      assert.equal(failClosedBps.rows.length, 0);

      const authRes = await pClient.query<{
        tenant_id: string;
        employee_id: string;
        syain_name: string;
      }>('SELECT tenant_id, employee_id, syain_name FROM authenticate_employee_lookup($1, $2)', [
        'live-check-a',
        'E001',
      ]);
      assert.equal(authRes.rows.length, 1);
      assert.equal(authRes.rows[0]?.tenant_id, tenantAId);
      assert.equal(authRes.rows[0]?.employee_id, empAId);
      assert.equal(authRes.rows[0]?.syain_name, '実機検証A管理者');
      await pClient.query('COMMIT');
      summary['failClosedAndAuthLookup'] = 'PASSED';
    } finally {
      pClient.release();
    }

    // 3) withTenantContext (:6543) テナント分離 & 越境INSERT拒否検証
    const partnersA = await withTenantContext({ tenantId: tenantAId, employeeId: empAId }, async (tx) =>
      tx.query<{ partner_code: string }>('SELECT partner_code FROM business_partners'),
    );
    assert.deepEqual(
      partnersA.map((r) => r.partner_code),
      ['P-A01'],
    );

    const partnersB = await withTenantContext({ tenantId: tenantBId, employeeId: empBId }, async (tx) =>
      tx.query<{ partner_code: string }>('SELECT partner_code FROM business_partners'),
    );
    assert.deepEqual(
      partnersB.map((r) => r.partner_code),
      ['P-B01'],
    );

    await expectReject(
      'CrossTenantRlsInsert',
      () =>
        withTenantContext({ tenantId: tenantAId, employeeId: empAId }, async (tx) =>
          tx.query(
            `INSERT INTO business_partners (tenant_id, partner_code, partner_name) VALUES ($1, 'EVIL', '越境試行')`,
            [tenantBId],
          ),
        ),
      /row-level security/i,
    );
    summary['rlsTenantIsolation'] = 'PASSED';

    // 4) 複合外部キー (tenant_id, id) 越境ブロック検証（BYPASSRLS 権限下でも物理制約で拒否）
    await expectReject(
      'CompositeFkCrossTenant',
      () =>
        directPool.query(
          `INSERT INTO sales_headers (tenant_id, entry_type, slip_no, slip_name, slip_date, partner_id)
           VALUES ($1, 'SALE', 9991, '越境FK検証', '2026-06-05', $2)`,
          [tenantAId, partnerBId],
        ),
      /foreign key constraint/i,
    );
    summary['compositeFkCrossTenantBlock'] = 'PASSED';

    // 5) document_snapshots 不変トリガー（vendas_app 権限下では purge フラグ偽装時も DELETE/UPDATE 拒否）
    const snapId = await withTenantContext({ tenantId: tenantAId, employeeId: empAId }, async (tx) => {
      const rows = await tx.query<{ id: string }>(
        `INSERT INTO document_snapshots (
           tenant_id, document_type, source_entity_type, source_entity_id,
           document_no, version_no, is_reissue, template_variant,
           issued_by, payload_json, payload_sha256
         ) VALUES (
           $1, 'ESTIMATE', 'QUOTATION', 'dddd1111-1111-4111-8111-111111111111',
           'LIVE-EST-1', 1, false, 'STANDARD',
           $2, '{"schemaVersion":1}'::jsonb, $3
         ) RETURNING id`,
        [tenantAId, empAId, 'a'.repeat(64)],
      );
      return rows[0]!.id;
    });

    await expectReject(
      'SnapshotUpdate',
      () =>
        withTenantContext({ tenantId: tenantAId, employeeId: empAId }, async (tx) =>
          tx.query(`UPDATE document_snapshots SET document_no = 'TAMPERED' WHERE id = $1`, [snapId]),
        ),
      /UPDATE \/ DELETE できません/,
    );

    await expectReject(
      'SnapshotDeleteWithSpoofedFlag',
      () =>
        withTenantContext({ tenantId: tenantAId, employeeId: empAId }, async (tx) => {
          await tx.query("SELECT set_config('app.allow_tenant_purge', 'on', true)");
          return tx.query(`DELETE FROM document_snapshots WHERE id = $1`, [snapId]);
        }),
      /UPDATE \/ DELETE できません/,
    );
    summary['snapshotImmutabilityTrigger'] = 'PASSED';

    // 6) prevent_mutation_on_or_before_cutoff トリガー検証 (:6543)
    await expectReject(
      'CutoffBillingBlock',
      () =>
        withTenantContext({ tenantId: tenantAId, employeeId: empAId }, async (tx) =>
          tx.query(
            `INSERT INTO billing_headers (tenant_id, billing_no, partner_id, billing_date)
             VALUES ($1, 1001, $2, '2026-05-31')`,
            [tenantAId, partnerAId],
          ),
        ),
      /期首残高基準日/,
    );

    const wipPurchaseId = await withTenantContext({ tenantId: tenantAId, employeeId: empAId }, async (tx) => {
      const ins = await tx.query<{ id: string }>(
        `INSERT INTO purchases (tenant_id, purchase_no, purchase_name, purchase_date, supplier_id, status)
         VALUES ($1, 7101, '実機仕掛P1', '2026-05-15', $2, 'P1') RETURNING id`,
        [tenantAId, partnerAId],
      );
      await tx.query(`UPDATE purchases SET status = 'P2' WHERE id = $1`, [ins[0]!.id]);
      return ins[0]!.id;
    });

    await expectReject(
      'CutoffPurchaseP3Block',
      () =>
        withTenantContext({ tenantId: tenantAId, employeeId: empAId }, async (tx) =>
          tx.query(`UPDATE purchases SET status = 'P3' WHERE id = $1`, [wipPurchaseId]),
        ),
      /仕入済\(P3\)/,
    );

    await withTenantContext({ tenantId: tenantAId, employeeId: empAId }, async (tx) =>
      tx.query(`UPDATE purchases SET status = 'P3', purchase_date = '2026-06-02' WHERE id = $1`, [
        wipPurchaseId,
      ]),
    );
    summary['cutoffWipAndP3Trigger'] = 'PASSED';
  } finally {
    // テスト用仮テナント完全パージ & 0件確認
    await directPool.query('BEGIN');
    for (const id of [tenantAId, tenantBId]) {
      await directPool.query('SELECT purge_tenant_cascade($1)', [id]);
    }
    await directPool.query('COMMIT');

    const remRes = await directPool.query<{ cnt: string }>('SELECT COUNT(*)::text AS cnt FROM tenants');
    summary['remainingTenantsAfterCleanup'] = Number(remRes.rows[0]?.cnt);

    await closePgPool();
    await poolerPool.end();
    await directPool.end();
  }

  console.log('[db:verify-live] ALL CHECKS PASSED:', summary);
}

main().catch((err) => {
  console.error('[db:verify-live ERROR]', err);
  process.exit(1);
});
