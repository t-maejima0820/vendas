import fs from 'node:fs';
import path from 'node:path';
import { PGlite } from '@electric-sql/pglite';
import { PDFDocument } from 'pdf-lib';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { POST as postEstimatesRoute } from '@/app/api/v1/estimates/route';
import { GET as getEstimateDetailRoute } from '@/app/api/v1/estimates/[id]/route';
import { GET as getSalesRoute, POST as postSalesRoute } from '@/app/api/v1/sales/route';
import { PATCH as patchSalesApprovalRoute } from '@/app/api/v1/sales/approval/route';
import { GET as exportSalesRoute } from '@/app/api/v1/sales/export/route';
import { POST as postSalesFromEstimateRoute } from '@/app/api/v1/sales/from-estimate/route';
import { GET as getSalesProductSummaryRoute } from '@/app/api/v1/sales/product-summary/route';
import {
  DELETE as deleteSalesRoute,
  GET as getSalesDetailRoute,
  PUT as putSalesRoute,
} from '@/app/api/v1/sales/[id]/route';
import { GET as getSnapshotsRoute, POST as postSnapshotsRoute } from '@/app/api/v1/snapshots/route';
import { GET as getSnapshotDetailRoute } from '@/app/api/v1/snapshots/[id]/route';
import { GET as getSnapshotPdfRoute } from '@/app/api/v1/snapshots/[id]/pdf/route';
import {
  GET as getSubscriptionsRoute,
  POST as postSubscriptionsRoute,
} from '@/app/api/v1/subscriptions/route';
import {
  GET as getMonthlyFlowsRoute,
  PUT as putMonthlyFlowsRoute,
} from '@/app/api/v1/subscriptions/approval-flows/route';
import {
  DELETE as deleteSubscriptionRoute,
  PUT as putSubscriptionRoute,
} from '@/app/api/v1/subscriptions/[id]/route';
import { authenticateLogin } from '@/lib/auth/auth-service';
import { encryptField, hashPassword } from '@/lib/crypto/field-cipher';
import { withExecutorTenantContext, type DbExecutor } from '@/lib/db/tenant-client';
import {
  decryptSnapshotBankAccounts,
} from '@/lib/domain/snapshots';
import type { QuotationDetailDto, SnapshotDetailDto, SnapshotHistoryItemDto } from '@/lib/estimates/types';
import type {
  SalesDetailDto,
  SalesPageDto,
  SalesProductSummaryResultDto,
} from '@/lib/sales/types';
import type {
  SubscriptionContractDto,
  SubscriptionListResultDto,
  SubscriptionMonthlyApprovalResultDto,
} from '@/lib/subscriptions/types';

const TEST_ENC_KEY = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';
const TEST_SESSION_SECRET = 'phase2b-test-session-secret-0123456789abcdef';

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

function buildJsonApiRequest(
  url: string,
  method: string,
  sessionToken: string,
  body?: unknown,
): Request {
  const headers: Record<string, string> = {
    host: 'localhost:3000',
    cookie: `vendas_session=${encodeURIComponent(sessionToken)}`,
  };
  if (method !== 'GET') {
    headers.origin = 'http://localhost:3000';
    headers['content-type'] = 'application/json';
  }
  return new Request(url, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

describe('Phase 2-B 売上・立替金管理（見積転記・承認・K4/K5ロック・納品書/受領書・集計）＆ 定額サブスク管理検証', () => {
  let db: PGlite;
  let exec: DbExecutor;

  const tenantId = '66666666-6666-4333-8333-666666666666';
  const tenantSlug = 'phase2b-corp';
  const staffEmpId = 'bbbb6666-6666-4333-8333-666666666666';

  let partnerId = '';
  let projectId = '';
  let productId = '';
  let staffToken = '';

  beforeAll(async () => {
    db = new PGlite();
    exec = createPgliteExecutor(db);

    const rootDir = process.cwd();
    await db.exec(fs.readFileSync(path.join(rootDir, 'supabase', 'migrations', '0001_schema.sql'), 'utf8'));
    await db.exec(fs.readFileSync(path.join(rootDir, 'supabase', 'migrations', '0002_rls_policies.sql'), 'utf8'));
    await db.exec(fs.readFileSync(path.join(rootDir, 'supabase', 'migrations', '0003_auth_security.sql'), 'utf8'));
    await db.exec(fs.readFileSync(path.join(rootDir, 'supabase', 'seed', 'default_codes.sql'), 'utf8'));
    await db.exec(
      fs.readFileSync(
        path.join(rootDir, 'supabase', 'migrations', '0004_complete_code_masters_seed.sql'),
        'utf8',
      ),
    );

    await db.query(
      `INSERT INTO tenants (id, tenant_slug, tenant_name) VALUES ($1, $2, '初期自社株式会社')`,
      [tenantId, tenantSlug],
    );
    await db.query(
      `INSERT INTO tenant_settings (
         tenant_id, company_code, company_name, invoice_registration_no,
         postal_code, address1, tel, email, representative_title, representative_name,
         bank_code_1, branch_code_1, bank_account_type_1, bank_account_no_1_enc, bank_account_holder_1,
         approval_flow_enabled, quotation_template_rows, tax_calc_policy, default_rounding_mode, opening_balance_date
       ) VALUES (
         $1, '9030', '初期自社株式会社', 'T1234567890123',
         '417-0001', '静岡県富士市テスト町1-1', '0545-11-2222', 'sales@example.com',
         '代表取締役', '初期 太郎',
         '0149', '001', 'B1', $2, 'ショキジシャ',
         true, 10, 'SLIP_BY_RATE', 'FLOOR', '2026-06-01'
       )`,
      [tenantId, encryptField('1234567', TEST_ENC_KEY)],
    );
    await db.query('SELECT seed_tenant_defaults($1)', [tenantId]);
    await db.query(
      `UPDATE tenant_feature_authorities
          SET is_enabled = true
        WHERE tenant_id = $1
          AND feature_code IN ('estimate', 'sales', 'tatekae', 'fixedbill', 'custom-sum-item')`,
      [tenantId],
    );

    const bankRows = await db.query<{ id: string }>(
      `INSERT INTO banks (tenant_id, bank_code, bank_name) VALUES ($1, '0149', '静岡銀行') RETURNING id`,
      [tenantId],
    );
    await db.query(
      `INSERT INTO bank_branches (tenant_id, bank_id, bank_code, branch_code, branch_name)
       VALUES ($1, $2, '0149', '001', '富士支店')`,
      [tenantId, bankRows.rows[0]!.id],
    );

    await db.query(
      `INSERT INTO employees (id, tenant_id, syain_code, syain_name, password_hash, is_admin, must_change_password)
       VALUES ($1, $2, '100', '検証営業担当', $3, false, false)`,
      [staffEmpId, tenantId, hashPassword('StaffPass2026!')],
    );

    const pRows = await db.query<{ id: string }>(
      `INSERT INTO business_partners (
         tenant_id, partner_code, partner_name, is_individual_honorific,
         postal_code, address1, is_client
       ) VALUES (
         $1, '00001', '初期取引先株式会社', false, '417-0002', '静岡県富士市顧客町2-2', true
       ) RETURNING id`,
      [tenantId],
    );
    partnerId = pRows.rows[0]!.id;

    const pjRows = await db.query<{ id: string }>(
      `INSERT INTO projects (
         tenant_id, project_no, project_name, project_date, partner_id, partner_name_snap
       ) VALUES ($1, 201, 'Phase2Bテスト案件', '2026-06-05', $2, '初期取引先株式会社') RETURNING id`,
      [tenantId, partnerId],
    );
    projectId = pjRows.rows[0]!.id;

    const prodRows = await db.query<{ id: string }>(
      `INSERT INTO products (
         tenant_id, product_code, product_name, capacity, standard_unit_price, standard_cost_price, default_tax_code
       ) VALUES ($1, 'PRD-S01', '保守点検パッケージ', 1, 10000, 5000, 'A') RETURNING id`,
      [tenantId],
    );
    productId = prodRows.rows[0]!.id;

    const loginRes = await authenticateLogin(exec, {
      tenantSlug,
      syainCode: '100',
      password: 'StaffPass2026!',
      clientIp: '127.0.0.1',
      sessionSecretOverride: TEST_SESSION_SECRET,
    });
    staffToken = loginRes.token;
  });

  afterAll(async () => {
    await db.close();
  });

  it('1. 売上/立替CRUD・内税二重加算なし厳密計算・見積転記(Q2更新)・承認フロー(0->1->2)検証', async () => {
    vi.stubEnv('SESSION_SECRET', TEST_SESSION_SECRET);
    vi.stubEnv('FIELD_ENCRYPTION_KEY_HEX', TEST_ENC_KEY);
    const modTenant = await import('@/lib/db/tenant-client');
    const spyCtx = vi.spyOn(modTenant, 'withTenantContext').mockImplementation(async (sess, fn) =>
      withExecutorTenantContext(
        exec,
        { tenantId: sess.tenantId, employeeId: sess.employeeId, role: 'vendas_app' },
        fn,
      ),
    );

    try {
      // (a) 複合税区分見積の作成（見出し行 + A + B + C + D内税10% + E内税8%）
      const estRes = await postEstimatesRoute(
        buildJsonApiRequest('http://localhost:3000/api/v1/estimates', 'POST', staffToken, {
          quotationName: '見積転記元案件',
          quotationDate: '2026-06-10',
          partnerId,
          projectId,
          honorific: '御中',
          status: 'Q1',
          isAdvanceType: false,
          isSelected: true,
          roundingMode: 'FLOOR',
          lines: [
            {
              productId: null,
              itemCode: null,
              itemName: '第1章 機器設置',
              unitName: null,
              isHeading: true,
              quantity: 0,
              taxCode: 'A',
              costCategory: null,
              masterUnitPrice: null,
              appliedUnitPrice: 0,
              masterCostPrice: null,
              appliedCostPrice: 0,
              remarks: '見出し',
            },
            {
              productId,
              itemCode: 'PRD-S01',
              itemName: '保守点検パッケージ（適用変更）',
              unitName: '式',
              isHeading: false,
              quantity: 2.5,
              taxCode: 'A',
              costCategory: 'MATERIAL',
              masterUnitPrice: 10000,
              appliedUnitPrice: 12000, // 30,000 + 3,000
              masterCostPrice: 5000,
              appliedCostPrice: 6000,
              remarks: null,
            },
            {
              productId: null,
              itemCode: null,
              itemName: '軽減8%品目',
              unitName: '式',
              isHeading: false,
              quantity: 1,
              taxCode: 'B',
              costCategory: 'EXPENSE',
              masterUnitPrice: null,
              appliedUnitPrice: 10000, // 10,000 + 800
              masterCostPrice: null,
              appliedCostPrice: 0,
              remarks: null,
            },
            {
              productId: null,
              itemCode: null,
              itemName: '非課税手数料',
              unitName: '件',
              isHeading: false,
              quantity: 1,
              taxCode: 'C',
              costCategory: 'EXPENSE',
              masterUnitPrice: null,
              appliedUnitPrice: 5000, // 5,000 + 0
              masterCostPrice: null,
              appliedCostPrice: 0,
              remarks: null,
            },
            {
              productId: null,
              itemCode: null,
              itemName: '内税10%作業',
              unitName: '式',
              isHeading: false,
              quantity: 1,
              taxCode: 'D',
              costCategory: 'LABOR',
              masterUnitPrice: null,
              appliedUnitPrice: 11000, // 税抜10,000, 税1,000, 行計11,000(二重加算なし)
              masterCostPrice: null,
              appliedCostPrice: 0,
              remarks: null,
            },
            {
              productId: null,
              itemCode: null,
              itemName: '内税8%資料',
              unitName: '式',
              isHeading: false,
              quantity: 1,
              taxCode: 'E',
              costCategory: 'EXPENSE',
              masterUnitPrice: null,
              appliedUnitPrice: 10800, // 税抜10,000, 税800, 行計10,800(二重加算なし)
              masterCostPrice: null,
              appliedCostPrice: 0,
              remarks: null,
            },
          ],
        }),
      );
      expect(estRes.status).toBe(201);
      const est = ((await estRes.json()) as { item: QuotationDetailDto }).item;

      // (b) 見積から売上伝票へ転記（見積が Q2 へ自動更新されること）
      const transferRes = await postSalesFromEstimateRoute(
        buildJsonApiRequest('http://localhost:3000/api/v1/sales/from-estimate', 'POST', staffToken, {
          quotationId: est.id,
          slipDate: '2026-06-15',
          updateQuotationStatusToQ2: true,
        }),
      );
      expect(transferRes.status).toBe(201);
      const sale1 = ((await transferRes.json()) as { item: SalesDetailDto }).item;

      expect(sale1.entryType).toBe('SALE');
      expect(sale1.slipNo).toBe(1);
      expect(sale1.status).toBe('K1');
      expect(sale1.approvalStatus).toBe(0);
      expect(sale1.subtotalAmount).toBe(65000);
      expect(sale1.taxTotal).toBe(5600);
      expect(sale1.totalAmount).toBe(70600);

      // 内税(D/E)行の rowTotal が lineAmount 同値で二重加算されていないこと
      expect(sale1.lines[0]?.isHeading).toBe(true);
      expect(sale1.lines[0]?.rowTotal).toBe(0);
      expect(sale1.lines[1]?.masterUnitPrice).toBe(10000);
      expect(sale1.lines[1]?.appliedUnitPrice).toBe(12000);
      expect(sale1.lines[4]?.taxCode).toBe('D');
      expect(sale1.lines[4]?.lineAmount).toBe(11000);
      expect(sale1.lines[4]?.lineTax).toBe(1000);
      expect(sale1.lines[4]?.rowTotal).toBe(11000);
      expect(sale1.lines[5]?.taxCode).toBe('E');
      expect(sale1.lines[5]?.lineAmount).toBe(10800);
      expect(sale1.lines[5]?.lineTax).toBe(800);
      expect(sale1.lines[5]?.rowTotal).toBe(10800);

      const estAfterRes = await getEstimateDetailRoute(
        buildJsonApiRequest(`http://localhost:3000/api/v1/estimates/${est.id}`, 'GET', staffToken),
      );
      const estAfter = ((await estAfterRes.json()) as { item: QuotationDetailDto }).item;
      expect(estAfter.status).toBe('Q2');

      // (c) 立替金(ADVANCE)見積からの転記（slipNo は ADVANCE 独立で 1 から採番）
      const estAdvRes = await postEstimatesRoute(
        buildJsonApiRequest('http://localhost:3000/api/v1/estimates', 'POST', staffToken, {
          quotationName: '立替交通費見積',
          quotationDate: '2026-06-15',
          partnerId,
          projectId: null,
          honorific: '御中',
          status: 'Q1',
          isAdvanceType: true,
          isSelected: false,
          roundingMode: 'FLOOR',
          lines: [
            {
              productId: null,
              itemCode: 'ADV-01',
              itemName: '立替交通費',
              unitName: '日',
              isHeading: false,
              quantity: 1,
              taxCode: 'D',
              costCategory: 'EXPENSE',
              masterUnitPrice: null,
              appliedUnitPrice: 8800,
              masterCostPrice: null,
              appliedCostPrice: 8800,
              remarks: null,
            },
          ],
        }),
      );
      const estAdv = ((await estAdvRes.json()) as { item: QuotationDetailDto }).item;
      const advTransferRes = await postSalesFromEstimateRoute(
        buildJsonApiRequest('http://localhost:3000/api/v1/sales/from-estimate', 'POST', staffToken, {
          quotationId: estAdv.id,
          slipDate: '2026-06-16',
        }),
      );
      expect(advTransferRes.status).toBe(201);
      const adv1 = ((await advTransferRes.json()) as { item: SalesDetailDto }).item;
      expect(adv1.entryType).toBe('ADVANCE');
      expect(adv1.slipNo).toBe(1);
      expect(adv1.subtotalAmount).toBe(8000);
      expect(adv1.taxTotal).toBe(800);
      expect(adv1.totalAmount).toBe(8800);

      // (d) 改ざん値無視 & CEIL更新 & 一括承認フロー (0 -> 1 -> 2)
      const manualSaleRes = await postSalesRoute(
        buildJsonApiRequest('http://localhost:3000/api/v1/sales', 'POST', staffToken, {
          entryType: 'SALE',
          slipName: '手動売上（改ざん無視検証）',
          slipDate: '2026-06-18',
          partnerId,
          projectId,
          honorific: '御中',
          status: 'K1',
          roundingMode: 'FLOOR',
          subtotalAmount: 9999999,
          totalAmount: 9999999,
          lines: [
            {
              productId: null,
              itemCode: 'MAN-01',
              itemName: '月額保守料',
              unitName: '月',
              targetMonthLabel: '2026年6月分',
              isHeading: false,
              quantity: 1,
              masterUnitPrice: null,
              appliedUnitPrice: 1005,
              taxCode: 'A',
              remarks: null,
            },
          ],
        }),
      );
      expect(manualSaleRes.status).toBe(201);
      const sale2 = ((await manualSaleRes.json()) as { item: SalesDetailDto }).item;
      expect(sale2.slipNo).toBe(2);
      expect(sale2.totalAmount).toBe(1105); // FLOOR: 1005 + 100

      const updRes = await putSalesRoute(
        buildJsonApiRequest(`http://localhost:3000/api/v1/sales/${sale2.id}`, 'PUT', staffToken, {
          entryType: 'SALE',
          slipName: '手動売上（CEIL更新）',
          slipDate: '2026-06-18',
          partnerId,
          projectId,
          honorific: '御中',
          status: 'K2',
          roundingMode: 'CEIL',
          approvalRemarks: null,
          lines: [
            {
              productId: null,
              itemCode: 'MAN-01',
              itemName: '月額保守料',
              unitName: '月',
              targetMonthLabel: '2026年6月分',
              isHeading: false,
              quantity: 1,
              masterUnitPrice: null,
              appliedUnitPrice: 1005,
              taxCode: 'A',
              remarks: null,
            },
          ],
        }),
      );
      expect(updRes.status).toBe(200);
      const sale2Upd = ((await updRes.json()) as { item: SalesDetailDto }).item;
      expect(sale2Upd.taxTotal).toBe(101); // CEIL: 100.5 -> 101
      expect(sale2Upd.totalAmount).toBe(1106);

      const appRes1 = await patchSalesApprovalRoute(
        buildJsonApiRequest('http://localhost:3000/api/v1/sales/approval', 'PATCH', staffToken, {
          ids: [sale1.id, sale2.id],
          approvalStatus: 1,
          approvalRemarks: '上長確認OK',
          nextStatus: 'K2',
        }),
      );
      expect(appRes1.status).toBe(200);
      expect(((await appRes1.json()) as { updatedCount: number }).updatedCount).toBe(2);

      const detailCheck = await getSalesDetailRoute(
        buildJsonApiRequest(`http://localhost:3000/api/v1/sales/${sale2.id}`, 'GET', staffToken),
      );
      const sale2AfterApp = ((await detailCheck.json()) as { item: SalesDetailDto }).item;
      expect(sale2AfterApp.approvalStatus).toBe(1);
      expect(sale2AfterApp.approvalRemarks).toBe('上長確認OK');
      expect(sale2AfterApp.status).toBe('K2');

      const appRes2 = await patchSalesApprovalRoute(
        buildJsonApiRequest('http://localhost:3000/api/v1/sales/approval', 'PATCH', staffToken, {
          ids: [sale2.id],
          approvalStatus: 2,
          approvalRemarks: '単価再確認のため差戻し',
        }),
      );
      expect(appRes2.status).toBe(200);
    } finally {
      spyCtx.mockRestore();
      vi.unstubAllEnvs();
    }
  });

  it('2. K4/K5 請求済伝票の編集・削除・承認更新が API 409 および DBトリガーで完全拒否されること', async () => {
    vi.stubEnv('SESSION_SECRET', TEST_SESSION_SECRET);
    vi.stubEnv('FIELD_ENCRYPTION_KEY_HEX', TEST_ENC_KEY);
    const modTenant = await import('@/lib/db/tenant-client');
    const spyCtx = vi.spyOn(modTenant, 'withTenantContext').mockImplementation(async (sess, fn) =>
      withExecutorTenantContext(
        exec,
        { tenantId: sess.tenantId, employeeId: sess.employeeId, role: 'vendas_app' },
        fn,
      ),
    );

    try {
      // K1伝票を作成してから、請求確定遷移トグルで K4 へ遷移
      const createRes = await postSalesRoute(
        buildJsonApiRequest('http://localhost:3000/api/v1/sales', 'POST', staffToken, {
          entryType: 'SALE',
          slipName: '請求済ロック検証伝票',
          slipDate: '2026-06-19',
          partnerId,
          projectId: null,
          honorific: '御中',
          status: 'K1',
          roundingMode: 'FLOOR',
          lines: [
            {
              productId: null,
              itemCode: 'LOCK-01',
              itemName: '請求済対象作業',
              unitName: '式',
              targetMonthLabel: null,
              isHeading: false,
              quantity: 1,
              masterUnitPrice: null,
              appliedUnitPrice: 50000,
              taxCode: 'A',
              remarks: null,
            },
          ],
        }),
      );
      expect(createRes.status).toBe(201);
      const lockedSlip = ((await createRes.json()) as { item: SalesDetailDto }).item;

      // K4遷移（将来のPhase 3請求確定を模擬）
      await db.query("SELECT set_config('app.allow_billing_transition', 'on', false)");
      await db.query(`UPDATE sales_headers SET status = 'K4'::sales_status WHERE id = $1`, [
        lockedSlip.id,
      ]);
      await db.query("SELECT set_config('app.allow_billing_transition', 'off', false)");

      // API PUT -> 409 BILLED_SALES_LOCKED
      const putLocked = await putSalesRoute(
        buildJsonApiRequest(`http://localhost:3000/api/v1/sales/${lockedSlip.id}`, 'PUT', staffToken, {
          entryType: 'SALE',
          slipName: '不正改ざん',
          slipDate: '2026-06-19',
          partnerId,
          projectId: null,
          honorific: '御中',
          status: 'K2',
          roundingMode: 'FLOOR',
          lines: [
            {
              productId: null,
              itemCode: 'LOCK-01',
              itemName: '改ざん品目',
              unitName: '式',
              targetMonthLabel: null,
              isHeading: false,
              quantity: 1,
              masterUnitPrice: null,
              appliedUnitPrice: 1,
              taxCode: 'A',
              remarks: null,
            },
          ],
        }),
      );
      expect(putLocked.status).toBe(409);
      expect(((await putLocked.json()) as { errorCode: string }).errorCode).toBe('BILLED_SALES_LOCKED');

      // API DELETE -> 409
      const delLocked = await deleteSalesRoute(
        buildJsonApiRequest(`http://localhost:3000/api/v1/sales/${lockedSlip.id}`, 'DELETE', staffToken),
      );
      expect(delLocked.status).toBe(409);

      // API Approval -> 409
      const appLocked = await patchSalesApprovalRoute(
        buildJsonApiRequest('http://localhost:3000/api/v1/sales/approval', 'PATCH', staffToken, {
          ids: [lockedSlip.id],
          approvalStatus: 1,
        }),
      );
      expect(appLocked.status).toBe(409);

      // DB直接 UPDATE も prevent_billed_sales_mutation トリガーで拒否されること
      await expect(
        withExecutorTenantContext(
          exec,
          { tenantId, employeeId: staffEmpId, role: 'vendas_app' },
          async (tx) =>
            tx.query(`UPDATE sales_headers SET slip_name = 'DB_TAMPER' WHERE id = $1::uuid`, [
              lockedSlip.id,
            ]),
        ),
      ).rejects.toThrow(/請求済み\(K4\/K5\)/);
    } finally {
      spyCtx.mockRestore();
      vi.unstubAllEnvs();
    }
  });

  it('3. 納品書/受領書スナップショット版管理(v1->v2)・マスタ変更後v1同一PDF再出力・売上一覧/立替一覧/商品別集計出力検証', async () => {
    vi.stubEnv('SESSION_SECRET', TEST_SESSION_SECRET);
    vi.stubEnv('FIELD_ENCRYPTION_KEY_HEX', TEST_ENC_KEY);
    const modTenant = await import('@/lib/db/tenant-client');
    const spyCtx = vi.spyOn(modTenant, 'withTenantContext').mockImplementation(async (sess, fn) =>
      withExecutorTenantContext(
        exec,
        { tenantId: sess.tenantId, employeeId: sess.employeeId, role: 'vendas_app' },
        fn,
      ),
    );

    try {
      // 売上 #1 を取得
      const listRes = await getSalesRoute(
        buildJsonApiRequest('http://localhost:3000/api/v1/sales?entryType=SALE&q=見積転記元案件', 'GET', staffToken),
      );
      const sale1Id = ((await listRes.json()) as SalesPageDto).items[0]!.id;

      // 納品書 v1 発行
      const dnV1Res = await postSnapshotsRoute(
        buildJsonApiRequest('http://localhost:3000/api/v1/snapshots', 'POST', staffToken, {
          documentType: 'DELIVERY_NOTE',
          sourceEntityId: sale1Id,
          templateVariant: '10_ROWS',
          issueDate: '2026-06-15',
        }),
      );
      expect(dnV1Res.status).toBe(201);
      const dnV1 = ((await dnV1Res.json()) as { item: SnapshotDetailDto }).item;
      expect(dnV1.versionNo).toBe(1);
      expect(dnV1.isReissue).toBe(false);
      expect(dnV1.reissueLabel).toBeNull();
      expect(dnV1.sourceEntityType).toBe('SALES_HEADER');
      expect(dnV1.payloadJson.issuer.companyName).toBe('初期自社株式会社');
      expect(dnV1.payloadJson.header.totalAmount).toBe(70600);

      // 受領書 v1 発行（納品書とは独立の version_no = 1）
      const drV1Res = await postSnapshotsRoute(
        buildJsonApiRequest('http://localhost:3000/api/v1/snapshots', 'POST', staffToken, {
          documentType: 'DELIVERY_RECEIPT',
          sourceEntityId: sale1Id,
          templateVariant: '10_ROWS',
          issueDate: '2026-06-15',
        }),
      );
      expect(drV1Res.status).toBe(201);
      const drV1 = ((await drV1Res.json()) as { item: SnapshotDetailDto }).item;
      expect(drV1.versionNo).toBe(1);
      expect(drV1.isReissue).toBe(false);

      const dnV1PdfResBefore = await getSnapshotPdfRoute(
        buildJsonApiRequest(`http://localhost:3000/api/v1/snapshots/${dnV1.id}/pdf`, 'GET', staffToken),
      );
      expect(dnV1PdfResBefore.status).toBe(200);
      const dnV1PdfBefore = new Uint8Array(await dnV1PdfResBefore.arrayBuffer());
      expect(Buffer.from(dnV1PdfBefore.slice(0, 5)).toString('ascii')).toBe('%PDF-');

      const drV1PdfResBefore = await getSnapshotPdfRoute(
        buildJsonApiRequest(`http://localhost:3000/api/v1/snapshots/${drV1.id}/pdf`, 'GET', staffToken),
      );
      const drV1PdfBefore = new Uint8Array(await drV1PdfResBefore.arrayBuffer());
      expect(Buffer.from(drV1PdfBefore.slice(0, 5)).toString('ascii')).toBe('%PDF-');

      // マスタと売上伝票を改変する
      await db.query(
        `UPDATE tenant_settings
            SET company_name = '改変後販売株式会社',
                bank_account_no_1_enc = $2
          WHERE tenant_id = $1`,
        [tenantId, encryptField('9999999', TEST_ENC_KEY)],
      );
      await db.query(
        `UPDATE business_partners SET partner_name = '改変後得意先' WHERE id = $1`,
        [partnerId],
      );
      await putSalesRoute(
        buildJsonApiRequest(`http://localhost:3000/api/v1/sales/${sale1Id}`, 'PUT', staffToken, {
          entryType: 'SALE',
          slipName: '改変後売上件名',
          slipDate: '2026-06-16',
          partnerId,
          projectId,
          honorific: '御中',
          status: 'K2',
          roundingMode: 'FLOOR',
          lines: [
            {
              productId,
              itemCode: 'PRD-S01',
              itemName: '改変後品名',
              unitName: '式',
              targetMonthLabel: '2026年6月分',
              isHeading: false,
              quantity: 1,
              masterUnitPrice: 10000,
              appliedUnitPrice: 200000,
              taxCode: 'A',
              remarks: null,
            },
          ],
        }),
      );

      // 納品書 v2 再発行
      const dnV2Res = await postSnapshotsRoute(
        buildJsonApiRequest('http://localhost:3000/api/v1/snapshots', 'POST', staffToken, {
          documentType: 'DELIVERY_NOTE',
          sourceEntityId: sale1Id,
          templateVariant: '20_ROWS',
          issueDate: '2026-06-20',
        }),
      );
      expect(dnV2Res.status).toBe(201);
      const dnV2 = ((await dnV2Res.json()) as { item: SnapshotDetailDto }).item;
      expect(dnV2.versionNo).toBe(2);
      expect(dnV2.isReissue).toBe(true);
      expect(dnV2.reissueLabel).toBe('＜再発行＞');
      expect(dnV2.payloadJson.issuer.companyName).toBe('改変後販売株式会社');
      expect(dnV2.payloadJson.header.totalAmount).toBe(220000);

      // 納品書 v1 再出力 -> マスタ改変前と100%一致
      const dnV1AfterDetailRes = await getSnapshotDetailRoute(
        buildJsonApiRequest(`http://localhost:3000/api/v1/snapshots/${dnV1.id}`, 'GET', staffToken),
      );
      const dnV1AfterDetail = ((await dnV1AfterDetailRes.json()) as { item: SnapshotDetailDto }).item;
      expect(dnV1AfterDetail.payloadSha256).toBe(dnV1.payloadSha256);
      expect(dnV1AfterDetail.payloadJson.issuer.companyName).toBe('初期自社株式会社');
      expect(dnV1AfterDetail.payloadJson.recipient.partnerName).toBe('初期取引先株式会社');
      expect(decryptSnapshotBankAccounts(dnV1AfterDetail.payloadJson, TEST_ENC_KEY)[0]?.accountNo).toBe('1234567');

      const dnV1PdfResAfter = await getSnapshotPdfRoute(
        buildJsonApiRequest(`http://localhost:3000/api/v1/snapshots/${dnV1.id}/pdf`, 'GET', staffToken),
      );
      const dnV1PdfAfter = new Uint8Array(await dnV1PdfResAfter.arrayBuffer());
      expect(Buffer.from(dnV1PdfAfter).equals(Buffer.from(dnV1PdfBefore))).toBe(true);

      // スナップショット発行済み伝票の削除は 409
      const delSnapRes = await deleteSalesRoute(
        buildJsonApiRequest(`http://localhost:3000/api/v1/sales/${sale1Id}`, 'DELETE', staffToken),
      );
      expect(delSnapRes.status).toBe(409);

      // 一覧履歴API
      const histRes = await getSnapshotsRoute(
        buildJsonApiRequest(
          `http://localhost:3000/api/v1/snapshots?documentType=DELIVERY_NOTE&sourceEntityId=${sale1Id}`,
          'GET',
          staffToken,
        ),
      );
      expect(histRes.status).toBe(200);
      expect(((await histRes.json()) as { items: SnapshotHistoryItemDto[] }).items.map((x) => x.versionNo)).toEqual([2, 1]);

      // 売上一覧・立替金一覧・商品別集計の CSV ＆ PDF 出力検証
      for (const kind of ['SALE', 'ADVANCE', 'PRODUCT_SUMMARY'] as const) {
        const csvRes = await exportSalesRoute(
          buildJsonApiRequest(
            `http://localhost:3000/api/v1/sales/export?kind=${kind}&format=csv`,
            'GET',
            staffToken,
          ),
        );
        expect(csvRes.status).toBe(200);
        const csvText = await csvRes.text();
        expect(csvText.length).toBeGreaterThan(20);

        const pdfRes = await exportSalesRoute(
          buildJsonApiRequest(
            `http://localhost:3000/api/v1/sales/export?kind=${kind}&format=pdf`,
            'GET',
            staffToken,
          ),
        );
        expect(pdfRes.status).toBe(200);
        const pdfBytes = new Uint8Array(await pdfRes.arrayBuffer());
        expect(Buffer.from(pdfBytes.slice(0, 5)).toString('ascii')).toBe('%PDF-');
        const loaded = await PDFDocument.load(pdfBytes);
        expect(loaded.getPageCount()).toBeGreaterThanOrEqual(1);
      }

      // 商品別集計APIが立替(D内税8800円)を二重加算せず 税抜8000 / 税800 / 税込8800 として集計すること
      const sumApiRes = await getSalesProductSummaryRoute(
        buildJsonApiRequest(
          'http://localhost:3000/api/v1/sales/product-summary?entryTypeFilter=ADVANCE',
          'GET',
          staffToken,
        ),
      );
      expect(sumApiRes.status).toBe(200);
      const sumBody = (await sumApiRes.json()) as SalesProductSummaryResultDto;
      expect(sumBody.totals.exclAmount).toBe(8000);
      expect(sumBody.totals.taxAmount).toBe(800);
      expect(sumBody.totals.inclAmount).toBe(8800);
    } finally {
      spyCtx.mockRestore();
      vi.unstubAllEnvs();
    }
  });

  it('4. 定額サブスク契約CRUD(内税/外税)・月次承認フロー更新・機能フラグOFF時403制御検証', async () => {
    vi.stubEnv('SESSION_SECRET', TEST_SESSION_SECRET);
    vi.stubEnv('FIELD_ENCRYPTION_KEY_HEX', TEST_ENC_KEY);
    const modTenant = await import('@/lib/db/tenant-client');
    const spyCtx = vi.spyOn(modTenant, 'withTenantContext').mockImplementation(async (sess, fn) =>
      withExecutorTenantContext(
        exec,
        { tenantId: sess.tenantId, employeeId: sess.employeeId, role: 'vendas_app' },
        fn,
      ),
    );

    try {
      // 1) 定額契約登録（通常売上 外税10% + 通常売上 内税10% + 立替 外税10%）
      const c1Res = await postSubscriptionsRoute(
        buildJsonApiRequest('http://localhost:3000/api/v1/subscriptions', 'POST', staffToken, {
          partnerId,
          entryType: 'SALE',
          productId,
          itemName: '月次クラウド保守料',
          monthLabel: '当月分',
          unitName: '式',
          quantity: 1,
          masterUnitPrice: 10000,
          appliedUnitPrice: 20000, // 20,000 + 2,000 = 22,000
          taxCode: 'A',
          roundingMode: 'FLOOR',
          outputType: 'PDF',
          isActive: true,
        }),
      );
      expect(c1Res.status).toBe(201);
      const c1 = ((await c1Res.json()) as { item: SubscriptionContractDto }).item;
      expect(c1.subscSeqNo).toBe(1);
      expect(c1.lineAmount).toBe(20000);
      expect(c1.lineTax).toBe(2000);
      expect(c1.rowTotal).toBe(22000);

      const c2Res = await postSubscriptionsRoute(
        buildJsonApiRequest('http://localhost:3000/api/v1/subscriptions', 'POST', staffToken, {
          partnerId,
          entryType: 'SALE',
          productId: null,
          itemName: '定額サポート（内税）',
          monthLabel: '当月分',
          unitName: '式',
          quantity: 1,
          masterUnitPrice: null,
          appliedUnitPrice: 11000, // 内税: 税抜10,000 + 税1,000 = 税込11,000
          taxCode: 'D',
          roundingMode: 'FLOOR',
          outputType: 'メール',
          isActive: true,
        }),
      );
      expect(c2Res.status).toBe(201);
      const c2 = ((await c2Res.json()) as { item: SubscriptionContractDto }).item;
      expect(c2.subscSeqNo).toBe(2);
      expect(c2.lineAmount).toBe(11000);
      expect(c2.lineTax).toBe(1000);
      expect(c2.exclAmount).toBe(10000);
      expect(c2.rowTotal).toBe(11000);

      const c3Res = await postSubscriptionsRoute(
        buildJsonApiRequest('http://localhost:3000/api/v1/subscriptions', 'POST', staffToken, {
          partnerId,
          entryType: 'ADVANCE',
          productId: null,
          itemName: '定額立替利用料',
          monthLabel: '当月分',
          unitName: '式',
          quantity: 1,
          masterUnitPrice: null,
          appliedUnitPrice: 5000, // 5,000 + 500 = 5,500
          taxCode: 'A',
          roundingMode: 'FLOOR',
          outputType: '印刷',
          isActive: true,
        }),
      );
      expect(c3Res.status).toBe(201);
      const c3 = ((await c3Res.json()) as { item: SubscriptionContractDto }).item;
      expect(c3.subscSeqNo).toBe(1);

      // 契約一覧・サマリ確認
      const listRes = await getSubscriptionsRoute(
        buildJsonApiRequest('http://localhost:3000/api/v1/subscriptions', 'GET', staffToken),
      );
      expect(listRes.status).toBe(200);
      const listBody = (await listRes.json()) as SubscriptionListResultDto;
      expect(listBody.totals.activeContracts).toBe(3);
      expect(listBody.totals.activeSalesInclTotal).toBe(33000);
      expect(listBody.totals.activeAdvanceInclTotal).toBe(5500);
      expect(listBody.totals.activeCombinedInclTotal).toBe(38500);

      // 契約更新
      const updRes = await putSubscriptionRoute(
        buildJsonApiRequest(
          `http://localhost:3000/api/v1/subscriptions/${c3.id}`,
          'PUT',
          staffToken,
          {
            partnerId,
            entryType: 'ADVANCE',
            subscSeqNo: 1,
            productId: null,
            itemName: '定額立替利用料（改定）',
            monthLabel: '当月分',
            unitName: '式',
            quantity: 2,
            masterUnitPrice: null,
            appliedUnitPrice: 5000, // 10,000 + 1,000 = 11,000
            taxCode: 'A',
            roundingMode: 'FLOOR',
            outputType: '印刷',
            isActive: true,
          },
        ),
      );
      expect(updRes.status).toBe(200);
      expect(((await updRes.json()) as { item: SubscriptionContractDto }).item.rowTotal).toBe(11000);

      // 2) 月次承認フロー取得 & 一括承認更新
      const flowBeforeRes = await getMonthlyFlowsRoute(
        buildJsonApiRequest(
          'http://localhost:3000/api/v1/subscriptions/approval-flows?targetMonth=202606',
          'GET',
          staffToken,
        ),
      );
      expect(flowBeforeRes.status).toBe(200);
      const flowBefore = (await flowBeforeRes.json()) as SubscriptionMonthlyApprovalResultDto;
      expect(flowBefore.totals.targetCount).toBe(2); // (partnerId, SALE) & (partnerId, ADVANCE)
      expect(flowBefore.totals.pendingCount).toBe(2);
      expect(flowBefore.totals.totalInclAmount).toBe(44000); // 33,000 + 11,000

      const flowUpdRes = await putMonthlyFlowsRoute(
        buildJsonApiRequest(
          'http://localhost:3000/api/v1/subscriptions/approval-flows',
          'PUT',
          staffToken,
          {
            targetMonth: '202606',
            items: [
              { partnerId, entryType: 'SALE', flowStatus: 1, remarks: '6月度承認済' },
              { partnerId, entryType: 'ADVANCE', flowStatus: 2, remarks: '立替確認待ち' },
            ],
          },
        ),
      );
      expect(flowUpdRes.status).toBe(200);

      const flowAfterRes = await getMonthlyFlowsRoute(
        buildJsonApiRequest(
          'http://localhost:3000/api/v1/subscriptions/approval-flows?targetMonth=202606',
          'GET',
          staffToken,
        ),
      );
      const flowAfter = (await flowAfterRes.json()) as SubscriptionMonthlyApprovalResultDto;
      expect(flowAfter.totals.approvedCount).toBe(1);
      expect(flowAfter.totals.rejectedCount).toBe(1);
      const saleFlow = flowAfter.items.find((i) => i.entryType === 'SALE');
      expect(saleFlow?.remarks).toBe('6月度承認済');
      expect(saleFlow?.updatedByName).toBe('検証営業担当');

      // 契約削除
      const delSubRes = await deleteSubscriptionRoute(
        buildJsonApiRequest(`http://localhost:3000/api/v1/subscriptions/${c2.id}`, 'DELETE', staffToken),
      );
      expect(delSubRes.status).toBe(200);

      // 3) 機能フラグOFF時の 403 Forbidden 制御
      await db.query(
        `UPDATE tenant_feature_authorities
            SET is_enabled = false
          WHERE tenant_id = $1 AND feature_code IN ('tatekae', 'fixedbill')`,
        [tenantId],
      );

      const advForbidden = await getSalesRoute(
        buildJsonApiRequest('http://localhost:3000/api/v1/sales?entryType=ADVANCE', 'GET', staffToken),
      );
      expect(advForbidden.status).toBe(403);

      const saleAllowed = await getSalesRoute(
        buildJsonApiRequest('http://localhost:3000/api/v1/sales?entryType=SALE', 'GET', staffToken),
      );
      expect(saleAllowed.status).toBe(200);

      const subForbidden = await getSubscriptionsRoute(
        buildJsonApiRequest('http://localhost:3000/api/v1/subscriptions', 'GET', staffToken),
      );
      expect(subForbidden.status).toBe(403);

      const flowForbidden = await getMonthlyFlowsRoute(
        buildJsonApiRequest(
          'http://localhost:3000/api/v1/subscriptions/approval-flows?targetMonth=202606',
          'GET',
          staffToken,
        ),
      );
      expect(flowForbidden.status).toBe(403);
    } finally {
      spyCtx.mockRestore();
      vi.unstubAllEnvs();
    }
  });
});
