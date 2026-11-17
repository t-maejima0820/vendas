import fs from 'node:fs';
import path from 'node:path';
import { PGlite } from '@electric-sql/pglite';
import { PDFDocument } from 'pdf-lib';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  GET as getAplusExportsRoute,
  POST as postAplusExportsRoute,
} from '@/app/api/v1/aplus/exports/route';
import { PATCH as patchAplusExportRoute } from '@/app/api/v1/aplus/exports/[id]/route';
import { GET as downloadAplusExportsRoute } from '@/app/api/v1/aplus/exports/download/route';
import {
  GET as getAplusImportsRoute,
  POST as postAplusImportsRoute,
} from '@/app/api/v1/aplus/imports/route';
import { POST as postBillingRoute } from '@/app/api/v1/billing/route';
import { POST as cancelBillingRoute } from '@/app/api/v1/billing/[id]/cancel/route';
import { GET as getBillingDetailRoute } from '@/app/api/v1/billing/[id]/route';
import {
  GET as getReceivableBalancesRoute,
} from '@/app/api/v1/receivables/balances/route';
import { GET as exportReceivablesRoute } from '@/app/api/v1/receivables/export/route';
import {
  GET as getCashReceiptsRoute,
  POST as postCashReceiptsRoute,
} from '@/app/api/v1/receivables/receipts/route';
import {
  DELETE as deleteCashReceiptRoute,
  PUT as putCashReceiptRoute,
} from '@/app/api/v1/receivables/receipts/[id]/route';
import { PATCH as patchSalesApprovalRoute } from '@/app/api/v1/sales/approval/route';
import { POST as postSalesRoute } from '@/app/api/v1/sales/route';
import { POST as postSnapshotsRoute } from '@/app/api/v1/snapshots/route';
import { GET as getSnapshotDetailRoute } from '@/app/api/v1/snapshots/[id]/route';
import { GET as getSnapshotPdfRoute } from '@/app/api/v1/snapshots/[id]/pdf/route';
import type {
  AplusExportDto,
  AplusImportDto,
  ImportAplusResultsOutput,
} from '@/lib/aplus/types';
import { authenticateLogin } from '@/lib/auth/auth-service';
import type { BillingDetailDto, BillingListItemDto } from '@/lib/billing/types';
import { encryptField, hashPassword } from '@/lib/crypto/field-cipher';
import { withExecutorTenantContext, type DbExecutor } from '@/lib/db/tenant-client';
import type { SnapshotDetailDto } from '@/lib/estimates/types';
import type {
  CashReceiptDetailDto,
  CashReceiptPageDto,
  ReceivableBalanceListResultDto,
} from '@/lib/receivables/types';
import type { SalesDetailDto } from '@/lib/sales/types';

const TEST_ENC_KEY = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';
const TEST_SESSION_SECRET = 'phase3b-test-session-secret-0123456789abcdef';

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

describe('Phase 3-B 売掛一覧・入金管理・領収書スナップショット・アプラス口座振替連携検証', () => {
  let db: PGlite;
  let exec: DbExecutor;

  const tenantId = '88888888-8888-4333-8333-888888888888';
  const tenantSlug = 'phase3b-corp';
  const staffEmpId = 'bbbb8888-8888-4333-8333-888888888888';

  let partnerAId = '';
  let partnerBId = '';
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
      `INSERT INTO tenants (id, tenant_slug, tenant_name) VALUES ($1, $2, '入金回収テスト株式会社')`,
      [tenantId, tenantSlug],
    );
    await db.query(
      `INSERT INTO tenant_settings (
         tenant_id, company_code, company_name, invoice_registration_no,
         postal_code, address1, tel, email, representative_title, representative_name,
         bank_code_1, branch_code_1, bank_account_type_1, bank_account_no_1_enc, bank_account_holder_1,
         approval_flow_enabled, quotation_template_rows, tax_calc_policy, default_rounding_mode, opening_balance_date
       ) VALUES (
         $1, '9050', '入金回収テスト株式会社', 'T1234567890123',
         '417-0001', '静岡県富士市テスト町1-1', '0545-11-2222', 'ar@example.com',
         '代表取締役', '回収 太郎',
         '0149', '001', 'B1', $2, 'ニュウキンカイシュウ',
         true, 10, 'SLIP_BY_RATE', 'FLOOR', '2026-05-31'
       )`,
      [tenantId, encryptField('1234567', TEST_ENC_KEY)],
    );
    await db.query('SELECT seed_tenant_defaults($1)', [tenantId]);
    await db.query(
      `UPDATE tenant_feature_authorities
          SET is_enabled = true
        WHERE tenant_id = $1
          AND feature_code IN ('sales', 'tatekae', 'billsummary', 'billissue', 'fixedbill', 'receivable', 'deposit', 'aplus')`,
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
       VALUES ($1, $2, '100', '経理回収担当', $3, false, false)`,
      [staffEmpId, tenantId, hashPassword('StaffPass2026!')],
    );

    // 取引先A: 期首売掛 50,000円（月末締）
    const pARows = await db.query<{ id: string }>(
      `INSERT INTO business_partners (
         tenant_id, partner_code, partner_name, is_individual_honorific,
         postal_code, address1, is_client, closing_day_code, collection_day_code,
         opening_ar_balance, is_aplus_enabled
       ) VALUES (
         $1, '20001', '株式会社テスト顧客A', false, '417-0002', '静岡県富士市A町1', true,
         'D', '1', 50000, true
       ) RETURNING id`,
      [tenantId],
    );
    partnerAId = pARows.rows[0]!.id;

    // 取引先B: アプラス講座情報あり
    const pBRows = await db.query<{ id: string }>(
      `INSERT INTO business_partners (
         tenant_id, partner_code, partner_name, is_individual_honorific,
         postal_code, address1, is_client, closing_day_code, collection_day_code,
         opening_ar_balance, is_aplus_enabled, bank_code, branch_code, bank_account_type,
         bank_account_no_enc, bank_account_holder
       ) VALUES (
         $1, '20002', '有限会社アプラス顧客B', false, '417-0003', '静岡県富士市B町2', true,
         'D', '1', 0, true, '0149', '001', 'B1',
         $2, 'ﾕ)ｱﾌﾟﾗｽｺｷｬｸB'
       ) RETURNING id`,
      [tenantId, encryptField('3344556', TEST_ENC_KEY)],
    );
    partnerBId = pBRows.rows[0]!.id;

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

  it('1. 入金CRUD（生成列total_deposit算出・基準日以前400拒否）＆ 請求書消込ステータス自動遷移（N1->N2->N3->N4->N1復帰・cancelBilling 409ブロック）検証', async () => {
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
      // 売上 -> 請求確定 (33,000円)
      const sRes = await postSalesRoute(
        buildJsonApiRequest('http://localhost:3000/api/v1/sales', 'POST', staffToken, {
          entryType: 'SALE',
          slipName: '消込テスト工事',
          slipDate: '2026-07-10',
          partnerId: partnerBId,
          projectId: null,
          honorific: '御中',
          status: 'K3',
          salesKubun: null,
          roundingMode: 'FLOOR',
          approvalRemarks: null,
          lines: [
            {
              productId: null,
              itemCode: null,
              itemName: '改修工事',
              unitName: '式',
              targetMonthLabel: null,
              isHeading: false,
              quantity: 1,
              masterUnitPrice: 30000,
              appliedUnitPrice: 30000,
              taxCode: 'A',
              remarks: null,
            },
          ],
        }),
      );
      expect(sRes.status).toBe(201);
      const slip = ((await sRes.json()) as { item: SalesDetailDto }).item;
      await patchSalesApprovalRoute(
        buildJsonApiRequest('http://localhost:3000/api/v1/sales/approval', 'PATCH', staffToken, {
          ids: [slip.id],
          approvalStatus: 1,
          approvalRemarks: 'OK',
        }),
      );

      const confRes = await postBillingRoute(
        buildJsonApiRequest('http://localhost:3000/api/v1/billing', 'POST', staffToken, {
          billingDate: '2026-07-31',
          targetPeriodStart: '2026-07-01',
          targetPeriodEnd: '2026-07-31',
          items: [{ partnerId: partnerBId, slipIds: [slip.id], documentType: 'INVOICE' }],
        }),
      );
      expect(confRes.status).toBe(201);
      const billing = ((await confRes.json()) as { billings: BillingListItemDto[] }).billings[0]!;
      expect(billing.billingAmount).toBe(33000);
      expect(billing.status).toBe('N1');

      // 基準日以前 (<= 2026-05-31) の入金は 400 で拒否
      const cutoffErr = await postCashReceiptsRoute(
        buildJsonApiRequest('http://localhost:3000/api/v1/receivables/receipts', 'POST', staffToken, {
          receiptDate: '2026-05-31',
          partnerId: partnerBId,
          methodCode1: 'D',
          deposit1: 10000,
        }),
      );
      expect(cutoffErr.status).toBe(400);

      // 一部入金 11,000円 (振込10,000 + 手数料1,000 -> total_deposit自動算出11,000) => N2
      const r1Res = await postCashReceiptsRoute(
        buildJsonApiRequest('http://localhost:3000/api/v1/receivables/receipts', 'POST', staffToken, {
          receiptDate: '2026-08-05',
          partnerId: partnerBId,
          methodCode1: 'D',
          deposit1: 10000,
          methodCode2: 'G',
          deposit2: 1000,
          billNo: String(billing.billingNo),
          tadashi: '一部入金',
        }),
      );
      expect(r1Res.status).toBe(201);
      const r1 = ((await r1Res.json()) as { item: CashReceiptDetailDto }).item;
      expect(r1.totalDeposit).toBe(11000);

      let bDet = ((await (await getBillingDetailRoute(
        buildJsonApiRequest(`http://localhost:3000/api/v1/billing/${billing.id}`, 'GET', staffToken),
      )).json()) as { item: BillingDetailDto }).item;
      expect(bDet.status).toBe('N2');

      // 入金消込済みの請求は cancelBilling が 409 でブロックされること
      const cancelBlocked = await cancelBillingRoute(
        buildJsonApiRequest(
          `http://localhost:3000/api/v1/billing/${billing.id}/cancel`,
          'POST',
          staffToken,
          {},
        ),
      );
      expect(cancelBlocked.status).toBe(409);

      // 残額 22,000円 入金 -> 計 33,000円 => N3 (入金済)
      const r2Res = await postCashReceiptsRoute(
        buildJsonApiRequest('http://localhost:3000/api/v1/receivables/receipts', 'POST', staffToken, {
          receiptDate: '2026-08-10',
          partnerId: partnerBId,
          methodCode1: 'D',
          deposit1: 22000,
          billNo: String(billing.billingNo),
          tadashi: '残額入金',
        }),
      );
      expect(r2Res.status).toBe(201);
      const r2 = ((await r2Res.json()) as { item: CashReceiptDetailDto }).item;

      bDet = ((await (await getBillingDetailRoute(
        buildJsonApiRequest(`http://localhost:3000/api/v1/billing/${billing.id}`, 'GET', staffToken),
      )).json()) as { item: BillingDetailDto }).item;
      expect(bDet.status).toBe('N3');

      // r2 を 25,000円 へ変更 -> 計 36,000円 (> 33,000) => N4 (過入金)
      const updRes = await putCashReceiptRoute(
        buildJsonApiRequest(
          `http://localhost:3000/api/v1/receivables/receipts/${r2.id}`,
          'PUT',
          staffToken,
          {
            receiptDate: '2026-08-10',
            partnerId: partnerBId,
            methodCode1: 'D',
            deposit1: 25000,
            billNo: String(billing.billingNo),
            tadashi: '過入金修正',
          },
        ),
      );
      expect(updRes.status).toBe(200);
      bDet = ((await (await getBillingDetailRoute(
        buildJsonApiRequest(`http://localhost:3000/api/v1/billing/${billing.id}`, 'GET', staffToken),
      )).json()) as { item: BillingDetailDto }).item;
      expect(bDet.status).toBe('N4');

      // 入金2件削除 -> N1 (未入金) に自動復帰し、cancelBilling も可能になること
      expect(
        (
          await deleteCashReceiptRoute(
            buildJsonApiRequest(
              `http://localhost:3000/api/v1/receivables/receipts/${r1.id}`,
              'DELETE',
              staffToken,
            ),
          )
        ).status,
      ).toBe(200);
      expect(
        (
          await deleteCashReceiptRoute(
            buildJsonApiRequest(
              `http://localhost:3000/api/v1/receivables/receipts/${r2.id}`,
              'DELETE',
              staffToken,
            ),
          )
        ).status,
      ).toBe(200);

      bDet = ((await (await getBillingDetailRoute(
        buildJsonApiRequest(`http://localhost:3000/api/v1/billing/${billing.id}`, 'GET', staffToken),
      )).json()) as { item: BillingDetailDto }).item;
      expect(bDet.status).toBe('N1');

      const cancelOk = await cancelBillingRoute(
        buildJsonApiRequest(
          `http://localhost:3000/api/v1/billing/${billing.id}/cancel`,
          'POST',
          staffToken,
          {},
        ),
      );
      expect(cancelOk.status).toBe(200);
    } finally {
      spyCtx.mockRestore();
      vi.unstubAllEnvs();
    }
  });

  it('2. 売掛一覧集計（期首売掛＋期間前請求/複数入金＋当期請求/複数入金＝期末残高1円一致・基準日以前400拒否）＆ CSV/PDF出力検証', async () => {
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
      // 基準日以前の開始日は 400 で拒否されること
      const cutoffBalErr = await getReceivableBalancesRoute(
        buildJsonApiRequest(
          'http://localhost:3000/api/v1/receivables/balances?periodStart=2026-05-31&periodEnd=2026-06-30',
          'GET',
          staffToken,
        ),
      );
      expect(cutoffBalErr.status).toBe(400);

      // 取引先A（期首売掛 50,000円）:
      // 6月請求 100,000円 / 6月入金2回 (30,000 + 20,000 = 50,000) -> 7月繰越 = 100,000円
      // 7月請求 220,000円 (税抜200,000 + 税20,000) / 7月入金2回 (40,000 + 10,000 = 50,000)
      // => 7月末残高 = 100,000 + 220,000 - 50,000 = 270,000円
      await db.query(
        `INSERT INTO billing_headers (
           tenant_id, billing_no, partner_id, billing_date,
           target_period_start, target_period_end,
           amount_10_excl, tax_10_amount, tax_total, billing_amount,
           prev_carried_balance, period_receipt_amount, net_carried_balance, closing_ar_balance, status
         ) VALUES
           ($1, 101, $2, '2026-06-30', '2026-06-01', '2026-06-30',
            90910, 9090, 9090, 100000, 50000, 50000, 0, 100000, 'N2'),
           ($1, 102, $2, '2026-07-31', '2026-07-01', '2026-07-31',
            200000, 20000, 20000, 220000, 100000, 50000, 50000, 270000, 'N2')`,
        [tenantId, partnerAId],
      );
      await db.query(
        `INSERT INTO cash_receipts (tenant_id, receipt_no, receipt_date, partner_id, method_code_1, deposit_1)
         VALUES
           ($1, 501, '2026-06-10', $2, 'D', 30000),
           ($1, 502, '2026-06-20', $2, 'D', 20000),
           ($1, 503, '2026-07-05', $2, 'D', 40000),
           ($1, 504, '2026-07-25', $2, 'D', 10000)`,
        [tenantId, partnerAId],
      );

      const balRes = await getReceivableBalancesRoute(
        buildJsonApiRequest(
          `http://localhost:3000/api/v1/receivables/balances?periodStart=2026-07-01&periodEnd=2026-07-31&partnerId=${partnerAId}`,
          'GET',
          staffToken,
        ),
      );
      expect(balRes.status).toBe(200);
      const balBody = (await balRes.json()) as ReceivableBalanceListResultDto;
      expect(balBody.items).toHaveLength(1);
      const rowA = balBody.items[0]!;
      expect(rowA.prevCarriedBalance).toBe(100000);
      expect(rowA.periodBillingExcl).toBe(200000);
      expect(rowA.periodBillingTax).toBe(20000);
      expect(rowA.periodBillingIncl).toBe(220000);
      expect(rowA.periodReceiptAmount).toBe(50000);
      expect(rowA.periodNetDelta).toBe(170000);
      expect(rowA.closingArBalance).toBe(270000);

      // CSV ＆ A4横PDF出力検証
      const csvRes = await exportReceivablesRoute(
        buildJsonApiRequest(
          `http://localhost:3000/api/v1/receivables/export?periodStart=2026-07-01&periodEnd=2026-07-31&partnerId=${partnerAId}&format=csv`,
          'GET',
          staffToken,
        ),
      );
      expect(csvRes.status).toBe(200);
      const csvBuf = Buffer.from(await csvRes.arrayBuffer());
      expect(csvBuf.subarray(0, 3).equals(Buffer.from([0xef, 0xbb, 0xbf]))).toBe(true);
      expect(csvBuf.toString('utf8')).toContain('"270000"');

      const pdfRes = await exportReceivablesRoute(
        buildJsonApiRequest(
          `http://localhost:3000/api/v1/receivables/export?periodStart=2026-07-01&periodEnd=2026-07-31&partnerId=${partnerAId}&format=pdf`,
          'GET',
          staffToken,
        ),
      );
      expect(pdfRes.status).toBe(200);
      const pdfBytes = new Uint8Array(await pdfRes.arrayBuffer());
      expect(Buffer.from(pdfBytes.slice(0, 5)).toString('ascii')).toBe('%PDF-');
      const parsed = await PDFDocument.load(pdfBytes);
      expect(parsed.getPageCount()).toBeGreaterThanOrEqual(1);
    } finally {
      spyCtx.mockRestore();
      vi.unstubAllEnvs();
    }
  });

  it('3. 領収書スナップショット（RECEIPT）発行（v1->v2 ＜再発行＞）・削除409ブロック・マスタ変更後もv1同一PDF再出力検証', async () => {
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
      const rRes = await postCashReceiptsRoute(
        buildJsonApiRequest('http://localhost:3000/api/v1/receivables/receipts', 'POST', staffToken, {
          receiptDate: '2026-08-20',
          partnerId: partnerAId,
          methodCode1: 'D',
          deposit1: 55000,
          methodCode2: 'B',
          deposit2: 5000,
          subtotal10Excl: 54545,
          subtotal8Excl: 0,
          subtotal0: 0,
          tadashi: '8月度工事代金として',
          remarks: '領収書スナップショット検証',
        }),
      );
      expect(rRes.status).toBe(201);
      const receipt = ((await rRes.json()) as { item: CashReceiptDetailDto }).item;
      expect(receipt.totalDeposit).toBe(60000);

      // v1 発行
      const v1Res = await postSnapshotsRoute(
        buildJsonApiRequest('http://localhost:3000/api/v1/snapshots', 'POST', staffToken, {
          documentType: 'RECEIPT',
          sourceEntityId: receipt.id,
          issueDate: '2026-08-20',
        }),
      );
      expect(v1Res.status).toBe(201);
      const v1 = ((await v1Res.json()) as { item: SnapshotDetailDto }).item;
      expect(v1.versionNo).toBe(1);
      expect(v1.isReissue).toBe(false);
      expect(v1.reissueLabel).toBeNull();
      expect(v1.payloadJson.receiptSpecific?.totalDeposit).toBe(60000);
      expect(v1.payloadJson.receiptSpecific?.paymentBreakdowns[0]?.methodName).toBe('振込');

      // 領収書発行済み入金の物理削除は 409 Conflict でブロックされること
      const delBlocked = await deleteCashReceiptRoute(
        buildJsonApiRequest(
          `http://localhost:3000/api/v1/receivables/receipts/${receipt.id}`,
          'DELETE',
          staffToken,
        ),
      );
      expect(delBlocked.status).toBe(409);

      const v1PdfBefore = Buffer.from(
        await (
          await getSnapshotPdfRoute(
            buildJsonApiRequest(
              `http://localhost:3000/api/v1/snapshots/${v1.id}/pdf`,
              'GET',
              staffToken,
            ),
          )
        ).arrayBuffer(),
      );
      expect(v1PdfBefore.subarray(0, 5).toString('ascii')).toBe('%PDF-');

      // マスタ情報・支払方法名称変更
      await db.query(
        `UPDATE tenant_settings SET company_name = '商号変更後株式会社' WHERE tenant_id = $1`,
        [tenantId],
      );
      await db.query(
        `UPDATE payment_methods SET method_name = '銀行振込改' WHERE tenant_id = $1 AND method_code = 'D'`,
        [tenantId],
      );

      // v2 ＜再発行＞
      const v2Res = await postSnapshotsRoute(
        buildJsonApiRequest('http://localhost:3000/api/v1/snapshots', 'POST', staffToken, {
          documentType: 'RECEIPT',
          sourceEntityId: receipt.id,
          issueDate: '2026-08-25',
        }),
      );
      expect(v2Res.status).toBe(201);
      const v2 = ((await v2Res.json()) as { item: SnapshotDetailDto }).item;
      expect(v2.versionNo).toBe(2);
      expect(v2.isReissue).toBe(true);
      expect(v2.reissueLabel).toBe('＜再発行＞');
      expect(v2.payloadJson.issuer.companyName).toBe('商号変更後株式会社');
      expect(v2.payloadJson.receiptSpecific?.paymentBreakdowns[0]?.methodName).toBe('銀行振込改');

      // v1 は 100% 同一内容・同一PDFバイナリで再出力されること
      const v1Detail = ((await (await getSnapshotDetailRoute(
        buildJsonApiRequest(`http://localhost:3000/api/v1/snapshots/${v1.id}`, 'GET', staffToken),
      )).json()) as { item: SnapshotDetailDto }).item;
      expect(v1Detail.payloadJson.issuer.companyName).toBe('入金回収テスト株式会社');
      expect(v1Detail.payloadJson.receiptSpecific?.paymentBreakdowns[0]?.methodName).toBe('振込');

      const v1PdfAfter = Buffer.from(
        await (
          await getSnapshotPdfRoute(
            buildJsonApiRequest(
              `http://localhost:3000/api/v1/snapshots/${v1.id}/pdf`,
              'GET',
              staffToken,
            ),
          )
        ).arrayBuffer(),
      );
      expect(v1PdfAfter.equals(v1PdfBefore)).toBe(true);
    } finally {
      spyCtx.mockRestore();
      vi.unstubAllEnvs();
    }
  });

  it('4. アプラス口座振替（データ作成・全銀120B出力・結果取込自動入金＆請求消込・不能アラート・二重取込409・機能フラグ403）検証', async () => {
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
      // 取引先Bへ 8月売上・請求確定 (55,000円)
      const sRes = await postSalesRoute(
        buildJsonApiRequest('http://localhost:3000/api/v1/sales', 'POST', staffToken, {
          entryType: 'SALE',
          slipName: '8月定例保守',
          slipDate: '2026-08-20',
          partnerId: partnerBId,
          projectId: null,
          honorific: '御中',
          status: 'K3',
          salesKubun: null,
          roundingMode: 'FLOOR',
          approvalRemarks: null,
          lines: [
            {
              productId: null,
              itemCode: null,
              itemName: '定例保守',
              unitName: '月',
              targetMonthLabel: '8月分',
              isHeading: false,
              quantity: 1,
              masterUnitPrice: 50000,
              appliedUnitPrice: 50000,
              taxCode: 'A',
              remarks: null,
            },
          ],
        }),
      );
      const slipB = ((await sRes.json()) as { item: SalesDetailDto }).item;
      await patchSalesApprovalRoute(
        buildJsonApiRequest('http://localhost:3000/api/v1/sales/approval', 'PATCH', staffToken, {
          ids: [slipB.id],
          approvalStatus: 1,
          approvalRemarks: '承認',
        }),
      );
      const confBRes = await postBillingRoute(
        buildJsonApiRequest('http://localhost:3000/api/v1/billing', 'POST', staffToken, {
          billingDate: '2026-08-31',
          targetPeriodStart: '2026-08-01',
          targetPeriodEnd: '2026-08-31',
          items: [{ partnerId: partnerBId, slipIds: [slipB.id], documentType: 'INVOICE' }],
        }),
      );
      expect(confBRes.status).toBe(201);
      const billingB = ((await confBRes.json()) as { billings: BillingListItemDto[] }).billings[0]!;
      expect(billingB.billingAmount).toBe(55000);

      // アプラス依頼データ生成
      const genRes = await postAplusExportsRoute(
        buildJsonApiRequest('http://localhost:3000/api/v1/aplus/exports', 'POST', staffToken, {
          transferDate: '2026-09-28',
          consignorCode: '1234567890',
          periodStart: '2026-08-01',
          periodEnd: '2026-08-31',
        }),
      );
      expect(genRes.status).toBe(201);
      const genItems = ((await genRes.json()) as { items: AplusExportDto[] }).items;
      const expB = genItems.find((x) => x.partnerId === partnerBId)!;
      expect(expB.salesTotal).toBe(55000);

      // 変動調整額 +1,000円 編集
      const patchRes = await patchAplusExportRoute(
        buildJsonApiRequest(
          `http://localhost:3000/api/v1/aplus/exports/${expB.id}`,
          'PATCH',
          staffToken,
          { variableAmount: 1000 },
        ),
      );
      expect(patchRes.status).toBe(200);
      expect(((await patchRes.json()) as { item: AplusExportDto }).item.totalTransferAmount).toBe(
        56000,
      );

      // CSV 出力 + 全銀固定長 (120バイト) 出力＆ is_exported = true 更新
      const dlCsvRes = await downloadAplusExportsRoute(
        buildJsonApiRequest(
          'http://localhost:3000/api/v1/aplus/exports/download?transferDate=2026-09-28&format=csv',
          'GET',
          staffToken,
        ),
      );
      expect(dlCsvRes.status).toBe(200);
      const dlCsvBuf = Buffer.from(await dlCsvRes.arrayBuffer());
      expect(dlCsvBuf.subarray(0, 3).equals(Buffer.from([0xef, 0xbb, 0xbf]))).toBe(true);

      const dlZenginRes = await downloadAplusExportsRoute(
        buildJsonApiRequest(
          'http://localhost:3000/api/v1/aplus/exports/download?transferDate=2026-09-28&format=zengin',
          'GET',
          staffToken,
        ),
      );
      expect(dlZenginRes.status).toBe(200);
      const zenginText = await dlZenginRes.text();
      const zenginLines = zenginText.split('\r\n');
      expect(zenginLines.length).toBeGreaterThanOrEqual(4);
      expect(zenginLines[0]?.startsWith('19101234567890')).toBe(true);
      expect(zenginLines.some((l) => l.startsWith('2') && l.includes('3344556'))).toBe(true);
      expect(zenginLines[zenginLines.length - 2]?.startsWith('8')).toBe(true);
      expect(zenginLines[zenginLines.length - 1]?.startsWith('9')).toBe(true);
      for (const line of zenginLines) {
        expect(line.length).toBe(120);
      }

      const expAfterRes = await getAplusExportsRoute(
        buildJsonApiRequest(
          'http://localhost:3000/api/v1/aplus/exports?transferDate=2026-09-28',
          'GET',
          staffToken,
        ),
      );
      const expList = ((await expAfterRes.json()) as { items: AplusExportDto[] }).items;
      expect(expList.every((e) => e.isExported)).toBe(true);

      // 結果CSV取込（20002: 正常引落55,000円 -> 自動入金 & N3消込 / 20001: 振替不能）
      const resultCsv = [
        '作成日,振替日,顧客番号,契約者名,契約額,請求額,振替済額,未払額,結果コード,理由',
        '2026-09-28,2026-09-28,20002,有限会社アプラス顧客B,55000,55000,55000,0,0,',
        '2026-09-28,2026-09-28,20001,株式会社テスト顧客A,12000,12000,0,12000,1,資金不足',
      ].join('\r\n');

      const impRes = await postAplusImportsRoute(
        buildJsonApiRequest('http://localhost:3000/api/v1/aplus/imports', 'POST', staffToken, {
          rawText: resultCsv,
          autoCreateReceipts: true,
        }),
      );
      expect(impRes.status).toBe(201);
      const impBody = (await impRes.json()) as ImportAplusResultsOutput;
      expect(impBody.importedCount).toBe(2);
      expect(impBody.settledCount).toBe(1);
      expect(impBody.failedCount).toBe(1);
      expect(impBody.autoCreatedReceiptCount).toBe(1);

      // 自動作成された APLUS 入金と billingB の N3 消込を確認
      const recAplusRes = await getCashReceiptsRoute(
        buildJsonApiRequest(
          `http://localhost:3000/api/v1/receivables/receipts?partnerId=${partnerBId}&sourceKind=APLUS`,
          'GET',
          staffToken,
        ),
      );
      const recAplus = (await recAplusRes.json()) as CashReceiptPageDto;
      expect(recAplus.items).toHaveLength(1);
      expect(recAplus.items[0]?.methodCode1).toBe('H');
      expect(recAplus.items[0]?.totalDeposit).toBe(55000);
      expect(recAplus.items[0]?.billNo).toBe(String(billingB.billingNo));

      const billBDetail = ((await (await getBillingDetailRoute(
        buildJsonApiRequest(`http://localhost:3000/api/v1/billing/${billingB.id}`, 'GET', staffToken),
      )).json()) as { item: BillingDetailDto }).item;
      expect(billBDetail.status).toBe('N3');

      // 振替不能アラートフィルタ確認
      const errImpRes = await getAplusImportsRoute(
        buildJsonApiRequest(
          'http://localhost:3000/api/v1/aplus/imports?statusFilter=ERROR',
          'GET',
          staffToken,
        ),
      );
      const errItems = ((await errImpRes.json()) as { items: AplusImportDto[] }).items;
      expect(errItems).toHaveLength(1);
      expect(errItems[0]?.resultReason).toBe('資金不足');

      // 同一 transfer_date + customer_no の二重取込は 409 で防止されること
      const dupImpRes = await postAplusImportsRoute(
        buildJsonApiRequest('http://localhost:3000/api/v1/aplus/imports', 'POST', staffToken, {
          rawText: resultCsv,
        }),
      );
      expect(dupImpRes.status).toBe(409);

      // 機能フラグOFF時の 403 拒否制御
      await db.query(
        `UPDATE tenant_feature_authorities
            SET is_enabled = false
          WHERE tenant_id = $1 AND feature_code IN ('receivable', 'deposit', 'aplus')`,
        [tenantId],
      );
      expect(
        (
          await getReceivableBalancesRoute(
            buildJsonApiRequest('http://localhost:3000/api/v1/receivables/balances', 'GET', staffToken),
          )
        ).status,
      ).toBe(403);
      expect(
        (
          await postCashReceiptsRoute(
            buildJsonApiRequest('http://localhost:3000/api/v1/receivables/receipts', 'POST', staffToken, {
              receiptDate: '2026-08-20',
              partnerId: partnerAId,
              methodCode1: 'D',
              deposit1: 1000,
            }),
          )
        ).status,
      ).toBe(403);
      expect(
        (
          await getAplusExportsRoute(
            buildJsonApiRequest('http://localhost:3000/api/v1/aplus/exports', 'GET', staffToken),
          )
        ).status,
      ).toBe(403);
    } finally {
      spyCtx.mockRestore();
      vi.unstubAllEnvs();
    }
  });
});
