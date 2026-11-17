import fs from 'node:fs';
import path from 'node:path';
import { PGlite } from '@electric-sql/pglite';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { NextResponse } from 'next/server';
import {
  AccountLockedError,
  authenticateLogin,
  changeEmployeePassword,
  InvalidCredentialsError,
  PasswordPolicyError,
  SessionRevokedError,
  verifyActiveSessionInDb,
} from '@/lib/auth/auth-service';
import { verifySessionTokenEdge } from '@/lib/auth/edge-token';
import { epochSeconds, verifySessionToken } from '@/lib/auth/session';
import { ApiError, verifyCsrfOrigin, withApiHandler } from '@/lib/api/handler';
import { hashPassword, isEncryptedField } from '@/lib/crypto/field-cipher';
import {
  withExecutorAnonymousAuthContext,
  withExecutorTenantContext,
  type DbExecutor,
} from '@/lib/db/tenant-client';
import {
  getTenantSettingsForAdmin,
  SettingsValidationError,
  updateTenantSettingsForAdmin,
} from '@/lib/settings/settings-service';
import { scanSourceText } from '../../../scripts/check-no-fallback.mjs';

const TEST_ENC_KEY = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';
const TEST_SESSION_SECRET = 'phase1a-test-session-secret-0123456789abcdef';

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

describe('Phase 1-A 認証防衛・即時セッション失効・設定画面暗号化・ガードレールG6/G7 テスト', () => {
  let db: PGlite;
  let exec: DbExecutor;

  const tenantId = '33333333-3333-4333-8333-333333333333';
  const adminEmpId = 'aaaa4444-3333-4333-8333-333333333333';
  const staffEmpId = 'bbbb5555-3333-4333-8333-333333333333';

  beforeAll(async () => {
    db = new PGlite();
    exec = createPgliteExecutor(db);

    const rootDir = process.cwd();
    await db.exec(fs.readFileSync(path.join(rootDir, 'supabase', 'migrations', '0001_schema.sql'), 'utf8'));
    await db.exec(fs.readFileSync(path.join(rootDir, 'supabase', 'migrations', '0002_rls_policies.sql'), 'utf8'));
    await db.exec(fs.readFileSync(path.join(rootDir, 'supabase', 'migrations', '0003_auth_security.sql'), 'utf8'));
    await db.exec(fs.readFileSync(path.join(rootDir, 'supabase', 'seed', 'default_codes.sql'), 'utf8'));

    await db.query(
      `INSERT INTO tenants (id, tenant_slug, tenant_name) VALUES ($1, 'sec-tenant', 'セキュリティ検証株式会社')`,
      [tenantId],
    );
    await db.query(
      `INSERT INTO tenant_settings (tenant_id, company_code, company_name, opening_balance_date)
       VALUES ($1, '9001', 'セキュリティ検証株式会社', '2026-05-31')`,
      [tenantId],
    );
    await db.query('SELECT seed_tenant_defaults($1)', [tenantId]);

    await db.query(
      `INSERT INTO employees (id, tenant_id, syain_code, syain_name, password_hash, is_admin, must_change_password)
       VALUES
         ($1, $2, '999', '検証管理者', $3, true, true),
         ($4, $2, '1',   '検証一般',   $5, false, false)`,
      [
        adminEmpId,
        tenantId,
        hashPassword('999'),
        staffEmpId,
        hashPassword('StaffPass2026!'),
      ],
    );
  });

  afterAll(async () => {
    await db.close();
  });

  it('ブルートフォース防御: 5回失敗で15分アカウントロック（存在しない社員コードも同じエラー文言＆ロック）、IP上限でIP単位遮断', async () => {
    const baseNow = new Date('2026-06-01T10:00:00.000Z');

    // 存在しないアカウントの失敗エラーメッセージは実在アカウントと完全同一（列挙攻撃対策）
    let errMissingMsg = '';
    try {
      await withExecutorAnonymousAuthContext(exec, async (tx) =>
        authenticateLogin(tx, {
          tenantSlug: 'sec-tenant',
          syainCode: 'UNKNOWN_999',
          password: 'wrong',
          clientIp: '203.0.113.10',
          now: baseNow,
          sessionSecretOverride: TEST_SESSION_SECRET,
        }),
      );
    } catch (err) {
      expect(err).toBeInstanceOf(InvalidCredentialsError);
      errMissingMsg = (err as InvalidCredentialsError).safeMessage;
    }

    // 社員コード '1' に対して 1〜4回連続失敗 -> 同一メッセージ
    for (let i = 1; i <= 4; i += 1) {
      let errExistingMsg = '';
      try {
        await withExecutorAnonymousAuthContext(exec, async (tx) =>
          authenticateLogin(tx, {
            tenantSlug: 'sec-tenant',
            syainCode: '1',
            password: `wrong-${i}`,
            clientIp: '203.0.113.11',
            now: new Date(baseNow.getTime() + i * 1000),
            sessionSecretOverride: TEST_SESSION_SECRET,
          }),
        );
      } catch (err) {
        expect(err).toBeInstanceOf(InvalidCredentialsError);
        errExistingMsg = (err as InvalidCredentialsError).safeMessage;
      }
      expect(errExistingMsg).toBe(errMissingMsg);
    }

    // 5回目の失敗 -> AccountLockedError (429)
    await expect(
      withExecutorAnonymousAuthContext(exec, async (tx) =>
        authenticateLogin(tx, {
          tenantSlug: 'sec-tenant',
          syainCode: '1',
          password: 'wrong-5',
          clientIp: '203.0.113.11',
          now: new Date(baseNow.getTime() + 5000),
          sessionSecretOverride: TEST_SESSION_SECRET,
        }),
      ),
    ).rejects.toBeInstanceOf(AccountLockedError);

    // 5分後に正しいパスワードを入れてもロック中は拒否される
    await expect(
      withExecutorAnonymousAuthContext(exec, async (tx) =>
        authenticateLogin(tx, {
          tenantSlug: 'sec-tenant',
          syainCode: '1',
          password: 'StaffPass2026!',
          clientIp: '203.0.113.99',
          now: new Date(baseNow.getTime() + 5 * 60 * 1000),
          sessionSecretOverride: TEST_SESSION_SECRET,
        }),
      ),
    ).rejects.toBeInstanceOf(AccountLockedError);

    // 16分後は正しいパスワードでログイン成功し失敗カウンタが0にリセット
    const afterLockRes = await withExecutorAnonymousAuthContext(exec, async (tx) =>
      authenticateLogin(tx, {
        tenantSlug: 'sec-tenant',
        syainCode: '1',
        password: 'StaffPass2026!',
        clientIp: '203.0.113.99',
        now: new Date(baseNow.getTime() + 16 * 60 * 1000),
        sessionSecretOverride: TEST_SESSION_SECRET,
      }),
    );
    expect(afterLockRes.session.syainCode).toBe('1');

    // IP単位のレート制限: 同一IPから異なる存在しないコードへ20回失敗すると20回目でIPロック
    const ipStart = new Date('2026-06-01T11:00:00.000Z');
    for (let i = 1; i <= 19; i += 1) {
      await expect(
        withExecutorAnonymousAuthContext(exec, async (tx) =>
          authenticateLogin(tx, {
            tenantSlug: 'sec-tenant',
            syainCode: `SCAN_${i}`,
            password: 'bad',
            clientIp: '198.51.100.77',
            now: new Date(ipStart.getTime() + i * 100),
            sessionSecretOverride: TEST_SESSION_SECRET,
          }),
        ),
      ).rejects.toBeInstanceOf(InvalidCredentialsError);
    }

    await expect(
      withExecutorAnonymousAuthContext(exec, async (tx) =>
        authenticateLogin(tx, {
          tenantSlug: 'sec-tenant',
          syainCode: 'SCAN_20',
          password: 'bad',
          clientIp: '198.51.100.77',
          now: new Date(ipStart.getTime() + 2500),
          sessionSecretOverride: TEST_SESSION_SECRET,
        }),
      ),
    ).rejects.toBeInstanceOf(AccountLockedError);

    // ロックされたIPからは正規ユーザー '1' でも即座に AccountLockedError
    await expect(
      withExecutorAnonymousAuthContext(exec, async (tx) =>
        authenticateLogin(tx, {
          tenantSlug: 'sec-tenant',
          syainCode: '1',
          password: 'StaffPass2026!',
          clientIp: '198.51.100.77',
          now: new Date(ipStart.getTime() + 3000),
          sessionSecretOverride: TEST_SESSION_SECRET,
        }),
      ),
    ).rejects.toBeInstanceOf(AccountLockedError);
  });

  it('must_change_password 強制・パスワード強度検証・変更時 session_version 更新・退職による即時セッション失効', async () => {
    const now = new Date('2026-06-01T12:00:00.000Z');

    // 初期ユーザー '999' でログイン -> mustChangePassword = true & Edge互換検証もパス
    const loginRes = await withExecutorTenantContext(exec, { tenantId: '', role: 'vendas_app' }, async (tx) =>
      authenticateLogin(tx, {
        tenantSlug: 'sec-tenant',
        syainCode: '999',
        password: '999',
        clientIp: '192.0.2.10',
        now,
        sessionSecretOverride: TEST_SESSION_SECRET,
      }),
    );
    expect(loginRes.session.mustChangePassword).toBe(true);
    expect(loginRes.session.sessionVersion).toBe(1);

    const edgeRes = await verifySessionTokenEdge(
      loginRes.token,
      epochSeconds(now.getTime()),
      TEST_SESSION_SECRET,
    );
    expect(edgeRes.ok).toBe(true);
    const verifiedNode = verifySessionToken(
      loginRes.token,
      epochSeconds(now.getTime()),
      TEST_SESSION_SECRET,
    );
    expect(verifiedNode.mustChangePassword).toBe(true);

    // 弱いパスワードや現在と同一パスワードは拒否
    await expect(
      withExecutorTenantContext(exec, { tenantId, employeeId: adminEmpId, role: 'vendas_app' }, async (tx) =>
        changeEmployeePassword(tx, {
          session: loginRes.session,
          currentPassword: '999',
          newPassword: 'short1',
          now,
          sessionSecretOverride: TEST_SESSION_SECRET,
        }),
      ),
    ).rejects.toBeInstanceOf(PasswordPolicyError);

    // 強いパスワードへ変更 -> must_change_password=false かつ session_version=2 発行
    const changed = await withExecutorTenantContext(
      exec,
      { tenantId, employeeId: adminEmpId, role: 'vendas_app' },
      async (tx) =>
        changeEmployeePassword(tx, {
          session: loginRes.session,
          currentPassword: '999',
          newPassword: 'AdminStrong2026!',
          now,
          sessionSecretOverride: TEST_SESSION_SECRET,
        }),
    );
    expect(changed.session.mustChangePassword).toBe(false);
    expect(changed.session.sessionVersion).toBe(2);

    // 古いセッション(sessionVersion=1)は即座に SessionRevokedError (401)
    await expect(
      withExecutorTenantContext(exec, { tenantId, employeeId: adminEmpId, role: 'vendas_app' }, async (tx) =>
        verifyActiveSessionInDb(tx, loginRes.session),
      ),
    ).rejects.toBeInstanceOf(SessionRevokedError);

    // 新しいセッション(sessionVersion=2)は有効
    const liveActive = await withExecutorTenantContext(
      exec,
      { tenantId, employeeId: adminEmpId, role: 'vendas_app' },
      async (tx) => verifyActiveSessionInDb(tx, changed.session),
    );
    expect(liveActive.syainCode).toBe('999');
    expect(liveActive.mustChangePassword).toBe(false);

    // 退職フラグ(is_retired=true)に変更 -> 有効セッションも即座に SessionRevokedError
    await db.query('UPDATE employees SET is_retired = true WHERE id = $1', [adminEmpId]);
    await expect(
      withExecutorTenantContext(exec, { tenantId, employeeId: adminEmpId, role: 'vendas_app' }, async (tx) =>
        verifyActiveSessionInDb(tx, changed.session),
      ),
    ).rejects.toBeInstanceOf(SessionRevokedError);
    await db.query('UPDATE employees SET is_retired = false WHERE id = $1', [adminEmpId]);
  });

  it('/settings サービス＆API防衛ラッパー: 口座暗号化保存/復号往復・固定機能ガード・非管理者403・CSRF Origin検証', async () => {
    // 管理者として口座番号＆インボイス設定を保存
    const current = await withExecutorTenantContext(
      exec,
      { tenantId, employeeId: adminEmpId, role: 'vendas_app' },
      async (tx) => getTenantSettingsForAdmin(tx, tenantId, TEST_ENC_KEY),
    );

    const updated = await withExecutorTenantContext(
      exec,
      { tenantId, employeeId: adminEmpId, role: 'vendas_app' },
      async (tx) =>
        updateTenantSettingsForAdmin(
          tx,
          tenantId,
          {
            companyName: current.companyName,
            invoiceRegistrationNo: 'T1234567890123',
            corporateNo: '1234567890123',
            postalCode: '417-0001',
            address1: '静岡県富士市テスト町',
            address2: null,
            tel: '0545-11-2222',
            fax: null,
            email: 'admin@example.com',
            representativeTitle: '代表取締役',
            representativeName: 'テスト 太郎',
            fiscalClosingMonth: 3,
            billingMemo: 'お振込手数料はご負担ください。',
            bankCode1: '0149',
            branchCode1: '101',
            bankAccountType1: 'B1',
            bankAccountNo1: '7654321',
            bankAccountHolder1: 'カ)テスト',
            bankCode2: null,
            branchCode2: null,
            bankAccountType2: null,
            bankAccountNo2: null,
            bankAccountHolder2: null,
            approvalFlowEnabled: true,
            allowBillingDateWarningSkip: true,
            defaultApprovalBillingDate: 1,
            defaultArListDateMode: 0,
            quotationTemplateRows: 20,
            showInvoiceCarryover: true,
            costTaxMode: 'TAX_EXCLUDED',
            taxCalcPolicy: 'INVOICE_BY_RATE',
            defaultRoundingMode: 'FLOOR',
            features: current.features.map((f) => ({
              featureCode: f.featureCode,
              isEnabled: f.featureCode === 'aplus' ? true : f.isEnabled,
            })),
          },
          TEST_ENC_KEY,
        ),
    );

    expect(updated.bankAccountNo1).toBe('7654321');
    expect(updated.taxCalcPolicy).toBe('INVOICE_BY_RATE');
    expect(updated.features.find((f) => f.featureCode === 'aplus')?.isEnabled).toBe(true);

    // DB上は必ず AES-256-GCM "enc:v1:..." で保存されていること
    const rawDb = await db.query<{ bank_account_no_1_enc: string }>(
      'SELECT bank_account_no_1_enc FROM tenant_settings WHERE tenant_id = $1',
      [tenantId],
    );
    expect(isEncryptedField(rawDb.rows[0]!.bank_account_no_1_enc)).toBe(true);
    expect(rawDb.rows[0]!.bank_account_no_1_enc).not.toContain('7654321');

    // 必須固定機能 ('sales', is_fixed=true) の無効化は拒否
    await expect(
      withExecutorTenantContext(
        exec,
        { tenantId, employeeId: adminEmpId, role: 'vendas_app' },
        async (tx) =>
          updateTenantSettingsForAdmin(
            tx,
            tenantId,
            {
              ...updated,
              features: updated.features.map((f) => ({
                featureCode: f.featureCode,
                isEnabled: f.featureCode === 'sales' ? false : f.isEnabled,
              })),
            },
            TEST_ENC_KEY,
          ),
      ),
    ).rejects.toBeInstanceOf(SettingsValidationError);

    // CSRF Origin 検証（不一致は 403）
    const badCsrfReq = new Request('https://vendas.example.com/api/v1/settings', {
      method: 'PUT',
      headers: {
        host: 'vendas.example.com',
        origin: 'https://evil-attacker.example.com',
      },
    });
    expect(() => verifyCsrfOrigin(badCsrfReq)).toThrow(ApiError);

    // 非管理者 (syainCode='1', isAdmin=false) および DBエラー秘匿を APIラッパー(withApiHandler) で検証
    vi.stubEnv('SESSION_SECRET', TEST_SESSION_SECRET);
    try {
      const staffLogin = await withExecutorAnonymousAuthContext(exec, async (tx) =>
        authenticateLogin(tx, {
          tenantSlug: 'sec-tenant',
          syainCode: '1',
          password: 'StaffPass2026!',
          clientIp: '192.0.2.50',
          now: new Date(),
          sessionSecretOverride: TEST_SESSION_SECRET,
        }),
      );

      // 非管理者トークンを requireAdmin: true ハンドラへ投入 -> 403 ADMIN_REQUIRED
      const modTenant = await import('@/lib/db/tenant-client');
      const spyCtx = vi.spyOn(modTenant, 'withTenantContext').mockImplementation(async (sess, fn) =>
        withExecutorTenantContext(exec, { tenantId: sess.tenantId, employeeId: sess.employeeId, role: 'vendas_app' }, fn),
      );
      try {
        const adminOnlyHandler = withApiHandler({ requireAdmin: true }, async () =>
          NextResponse.json({ ok: true }),
        );
        const nonAdminRes = await adminOnlyHandler(
          new Request('http://localhost:3000/api/v1/settings', {
            method: 'GET',
            headers: {
              host: 'localhost:3000',
              cookie: `vendas_session=${encodeURIComponent(staffLogin.token)}`,
            },
          }),
        );
        expect(nonAdminRes.status).toBe(403);
        const nonAdminBody = (await nonAdminRes.json()) as { errorCode: string };
        expect(nonAdminBody.errorCode).toBe('ADMIN_REQUIRED');

        // 未処理DB例外が発生してもテーブル名やSQL文を一切返却しないこと
        const leakyErrHandler = withApiHandler({ requireAdmin: false }, async () => {
          throw new Error('relation "employees" violates column "password_hash" SQLSTATE 42P01');
        });
        const leakedRes = await leakyErrHandler(
          new Request('http://localhost:3000/api/v1/test', {
            method: 'GET',
            headers: {
              host: 'localhost:3000',
              cookie: `vendas_session=${encodeURIComponent(staffLogin.token)}`,
            },
          }),
        );
        expect(leakedRes.status).toBe(500);
        const leakedText = await leakedRes.text();
        expect(leakedText).not.toContain('employees');
        expect(leakedText).not.toContain('password_hash');
        expect(leakedText).not.toContain('42P01');
      } finally {
        spyCtx.mockRestore();
      }
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it('静的ガードレール Rule G6 (SQLi遮断) および Rule G7 (API防衛ラッパー・例外秘匿強制) の検知精度', () => {
    // G6: テンプレート補間や + 結合の .query() を必ず検知
    const badSqlCode = `
      export async function run(tx: { query: (s: string, p?: unknown[]) => Promise<unknown[]> }, id: string) {
        await tx.query(\`SELECT * FROM employees WHERE id = \${id}\`);
        return tx.query('SELECT * FROM tenants WHERE tenant_slug = ' + id);
      }
    `;
    const g6Res = scanSourceText(badSqlCode, path.resolve(process.cwd(), 'src/lib/bad-sqli.ts'));
    expect(g6Res.violations.filter((v) => v.rule === 'G6')).toHaveLength(2);

    const goodSqlCode = `
      export async function run(tx: { query: (s: string, p?: unknown[]) => Promise<unknown[]> }, id: string) {
        return tx.query('SELECT id FROM employees WHERE id = $1', [id]);
      }
    `;
    const goodSqlRes = scanSourceText(goodSqlCode, path.resolve(process.cwd(), 'src/lib/good-sql.ts'));
    expect(goodSqlRes.violations).toHaveLength(0);

    // G7: 生の export async function GET ＆ err.message 漏洩を必ず検知
    const badRouteCode = `
      import { NextResponse } from 'next/server';
      export async function GET() {
        try {
          throw new Error('db fail');
        } catch (err) {
          return NextResponse.json({ error: (err as Error).message }, { status: 500 });
        }
      }
      export const POST = async () => NextResponse.json({ ok: true });
    `;
    const g7Res = scanSourceText(badRouteCode, path.resolve(process.cwd(), 'src/app/api/v1/sample/route.ts'));
    const g7Rules = g7Res.violations.filter((v) => v.rule === 'G7');
    expect(g7Rules.length).toBeGreaterThanOrEqual(3);

    // withPublicApiHandler を login/logout 以外で使った場合も G7 違反
    const badPublicRoute = `
      import { NextResponse } from 'next/server';
      export const GET = withPublicApiHandler(async () => NextResponse.json({ ok: true }));
    `;
    const badPubRes = scanSourceText(
      badPublicRoute,
      path.resolve(process.cwd(), 'src/app/api/v1/settings/route.ts'),
    );
    expect(badPubRes.violations.filter((v) => v.rule === 'G7')).toHaveLength(1);
  });
});
