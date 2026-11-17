import fs from 'node:fs';
import path from 'node:path';
import { PGlite } from '@electric-sql/pglite';
import { PDFDocument } from 'pdf-lib';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  GET as getBillingRoute,
  POST as postBillingRoute,
} from '@/app/api/v1/billing/route';
import {
  GET as getBillingCandidatesRoute,
  PATCH as patchBillingCandidatesRoute,
} from '@/app/api/v1/billing/candidates/route';
import { GET as exportBillingRoute } from '@/app/api/v1/billing/export/route';
import { GET as getBillingDetailRoute } from '@/app/api/v1/billing/[id]/route';
import { POST as cancelBillingRoute } from '@/app/api/v1/billing/[id]/cancel/route';
import { POST as reissueBillingRoute } from '@/app/api/v1/billing/[id]/reissue/route';
import { PATCH as patchSalesApprovalRoute } from '@/app/api/v1/sales/approval/route';
import { POST as postSalesRoute } from '@/app/api/v1/sales/route';
import {
  DELETE as deleteSalesRoute,
  PUT as putSalesRoute,
} from '@/app/api/v1/sales/[id]/route';
import { GET as getSnapshotsRoute, POST as postSnapshotsRoute } from '@/app/api/v1/snapshots/route';
import { GET as getSnapshotDetailRoute } from '@/app/api/v1/snapshots/[id]/route';
import { GET as getSnapshotPdfRoute } from '@/app/api/v1/snapshots/[id]/pdf/route';
import { PUT as putMonthlyFlowsRoute } from '@/app/api/v1/subscriptions/approval-flows/route';
import { POST as executeSubscBillingRoute } from '@/app/api/v1/subscriptions/execute-billing/route';
import { POST as postSubscriptionsRoute } from '@/app/api/v1/subscriptions/route';
import { authenticateLogin } from '@/lib/auth/auth-service';
import type {
  BillingCandidateListResultDto,
  BillingDetailDto,
  BillingListItemDto,
} from '@/lib/billing/types';
import { encryptField, hashPassword } from '@/lib/crypto/field-cipher';
import { withExecutorTenantContext, type DbExecutor } from '@/lib/db/tenant-client';
import { decryptSnapshotBankAccounts } from '@/lib/domain/snapshots';
import type { SnapshotDetailDto, SnapshotHistoryItemDto } from '@/lib/estimates/types';
import type { SalesDetailDto } from '@/lib/sales/types';
import type { ExecuteSubscriptionBillingResultDto } from '@/lib/subscriptions/types';

const TEST_ENC_KEY = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';
const TEST_SESSION_SECRET = 'phase3a-test-session-secret-0123456789abcdef';

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

describe('Phase 3-A 売掛繰越計算・通常請求確定/再発行/取消・定額一括請求確定・請求書6種＆一覧3帳票検証', () => {
  let db: PGlite;
  let exec: DbExecutor;

  const tenantId = '77777777-7777-4333-8333-777777777777';
  const tenantSlug = 'phase3a-corp';
  const staffEmpId = 'bbbb7777-7777-4333-8333-777777777777';

  let partnerAId = '';
  let partnerBId = '';
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
      `INSERT INTO tenants (id, tenant_slug, tenant_name) VALUES ($1, $2, '請求検証株式会社')`,
      [tenantId, tenantSlug],
    );
    await db.query(
      `INSERT INTO tenant_settings (
         tenant_id, company_code, company_name, invoice_registration_no,
         postal_code, address1, tel, email, representative_title, representative_name,
         billing_memo,
         bank_code_1, branch_code_1, bank_account_type_1, bank_account_no_1_enc, bank_account_holder_1,
         approval_flow_enabled, allow_billing_date_warning_skip, quotation_template_rows,
         show_invoice_carryover, tax_calc_policy, default_rounding_mode, opening_balance_date
       ) VALUES (
         $1, '9040', '請求検証株式会社', 'T1234567890123',
         '417-0001', '静岡県富士市テスト町1-1', '0545-11-2222', 'billing@example.com',
         '代表取締役', '請求 太郎',
         'お振込手数料は貴社ご負担にてお願い申し上げます。',
         '0149', '001', 'B1', $2, 'セイキュウケンショウ',
         true, false, 10,
         true, 'SLIP_BY_RATE', 'FLOOR', '2026-05-31'
       )`,
      [tenantId, encryptField('7654321', TEST_ENC_KEY)],
    );
    await db.query('SELECT seed_tenant_defaults($1)', [tenantId]);
    await db.query(
      `UPDATE tenant_feature_authorities
          SET is_enabled = true
        WHERE tenant_id = $1
          AND feature_code IN ('sales', 'tatekae', 'billsummary', 'billissue', 'fixedbill', 'receivable', 'deposit')`,
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
       VALUES ($1, $2, '100', '請求担当社員', $3, false, false)`,
      [staffEmpId, tenantId, hashPassword('StaffPass2026!')],
    );

    // 取引先A: 期首売掛 50,000円（月末締・翌月末回収）
    const pARows = await db.query<{ id: string }>(
      `INSERT INTO business_partners (
         tenant_id, partner_code, partner_name, is_individual_honorific,
         postal_code, address1, is_client, closing_day_code, collection_day_code,
         opening_ar_balance
       ) VALUES (
         $1, '10001', '株式会社テスト顧客A', false, '417-0002', '静岡県富士市顧客A-1', true,
         'D', '1', 50000
       ) RETURNING id`,
      [tenantId],
    );
    partnerAId = pARows.rows[0]!.id;

    // 取引先B: 期首売掛 0円（定額・再発行・帳票出力テスト用）
    const pBRows = await db.query<{ id: string }>(
      `INSERT INTO business_partners (
         tenant_id, partner_code, partner_name, is_individual_honorific,
         postal_code, address1, is_client, closing_day_code, collection_day_code,
         opening_ar_balance
       ) VALUES (
         $1, '10002', '有限会社サブスク顧客B', false, '417-0003', '静岡県富士市顧客B-2', true,
         'B', '2', 0
       ) RETURNING id`,
      [tenantId],
    );
    partnerBId = pBRows.rows[0]!.id;

    const prodRows = await db.query<{ id: string }>(
      `INSERT INTO products (
         tenant_id, product_code, product_name, capacity, standard_unit_price, standard_cost_price, default_tax_code
       ) VALUES ($1, 'PRD-3A', '請求テスト商品', 1, 1005, 500, 'A') RETURNING id`,
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

  it('1. 旧Accessバグ3是正（期首売掛＋過去請求＋複数回入金全額控除）＆ SLIP_BY_RATE / INVOICE_BY_RATE 端数調整一致検証', async () => {
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
      // 6月請求 100,000円 + 6月複数回入金 (30,000 + 20,000 = 50,000) + 7月複数回入金 (15,000 + 25,000 = 40,000)
      await db.query(
        `INSERT INTO billing_headers (
           tenant_id, billing_no, partner_id, billing_date,
           target_period_start, target_period_end, payment_due_date,
           billing_amount, prev_carried_balance, period_receipt_amount,
           net_carried_balance, closing_ar_balance, status
         ) VALUES (
           $1, 10, $2, '2026-06-30',
           '2026-06-01', '2026-06-30', '2026-07-31',
           100000, 50000, 50000, 0, 100000, 'N1'
         )`,
        [tenantId, partnerAId],
      );
      await db.query(
        `INSERT INTO cash_receipts (tenant_id, receipt_no, receipt_date, partner_id, method_code_1, deposit_1)
         VALUES
           ($1, 1, '2026-06-10', $2, 'D', 30000),
           ($1, 2, '2026-06-25', $2, 'D', 20000),
           ($1, 3, '2026-07-05', $2, 'D', 15000),
           ($1, 4, '2026-07-20', $2, 'D', 25000)`,
        [tenantId, partnerAId],
      );

      // 7月売上伝票2本（1,005円 × 10% -> 各100円税 = 計200円; INVOICE_BY_RATE合算時は 2,010円 × 10% = 201円 となり +1円調整発生）
      const s1Res = await postSalesRoute(
        buildJsonApiRequest('http://localhost:3000/api/v1/sales', 'POST', staffToken, {
          entryType: 'SALE',
          slipName: '7月分作業A',
          slipDate: '2026-07-10',
          partnerId: partnerAId,
          projectId: null,
          honorific: '御中',
          status: 'K2',
          salesKubun: null,
          roundingMode: 'FLOOR',
          approvalRemarks: null,
          lines: [
            {
              productId,
              itemCode: 'PRD-3A',
              itemName: '請求テスト商品1',
              unitName: '式',
              targetMonthLabel: '7月分',
              isHeading: false,
              quantity: 1,
              masterUnitPrice: 1005,
              appliedUnitPrice: 1005,
              taxCode: 'A',
              remarks: null,
            },
          ],
        }),
      );
      expect(s1Res.status).toBe(201);
      const s1 = ((await s1Res.json()) as { item: SalesDetailDto }).item;

      const s2Res = await postSalesRoute(
        buildJsonApiRequest('http://localhost:3000/api/v1/sales', 'POST', staffToken, {
          entryType: 'SALE',
          slipName: '7月分作業B',
          slipDate: '2026-07-20',
          partnerId: partnerAId,
          projectId: null,
          honorific: '御中',
          status: 'K2',
          salesKubun: null,
          roundingMode: 'FLOOR',
          approvalRemarks: null,
          lines: [
            {
              productId,
              itemCode: 'PRD-3A',
              itemName: '請求テスト商品2',
              unitName: '式',
              targetMonthLabel: '7月分',
              isHeading: false,
              quantity: 1,
              masterUnitPrice: 1005,
              appliedUnitPrice: 1005,
              taxCode: 'A',
              remarks: null,
            },
          ],
        }),
      );
      expect(s2Res.status).toBe(201);
      const s2 = ((await s2Res.json()) as { item: SalesDetailDto }).item;

      // 承認済化（1）
      const appRes = await patchSalesApprovalRoute(
        buildJsonApiRequest('http://localhost:3000/api/v1/sales/approval', 'PATCH', staffToken, {
          ids: [s1.id, s2.id],
          approvalStatus: 1,
          approvalRemarks: '承認',
        }),
      );
      expect(appRes.status).toBe(200);

      // (A) SLIP_BY_RATE での候補プレビュー ＆ 請求確定
      const candSlipRes = await getBillingCandidatesRoute(
        buildJsonApiRequest(
          `http://localhost:3000/api/v1/billing/candidates?dateFrom=2026-07-01&dateTo=2026-07-31&partnerId=${partnerAId}`,
          'GET',
          staffToken,
        ),
      );
      expect(candSlipRes.status).toBe(200);
      const candSlip = (await candSlipRes.json()) as BillingCandidateListResultDto;
      expect(candSlip.groups).toHaveLength(1);
      const gSlip = candSlip.groups[0]!;
      expect(gSlip.proposedPaymentDueDate).toBe('2026-08-31');
      // 前回繰越: 期首50,000 + 6月請求100,000 - 6月2回入金(30,000+20,000) = 100,000
      expect(gSlip.prevCarriedBalance).toBe(100000);
      // 当期入金: 7月2回入金(15,000+25,000) = 40,000
      expect(gSlip.periodReceiptAmount).toBe(40000);
      expect(gSlip.netCarriedBalance).toBe(60000);
      expect(gSlip.taxAdjustmentAmount).toBe(0);
      expect(gSlip.tax10Amount).toBe(200);
      expect(gSlip.currentBillingAmount).toBe(2210);
      expect(gSlip.closingArBalance).toBe(62210);

      const confirmSlipRes = await postBillingRoute(
        buildJsonApiRequest('http://localhost:3000/api/v1/billing', 'POST', staffToken, {
          billingDate: '2026-07-31',
          targetPeriodStart: '2026-07-01',
          targetPeriodEnd: '2026-07-31',
          items: [
            {
              partnerId: partnerAId,
              slipIds: [s1.id, s2.id],
              documentType: 'INVOICE',
              templateVariant: '10_ROWS',
            },
          ],
        }),
      );
      expect(confirmSlipRes.status).toBe(201);
      const confirmSlipBody = (await confirmSlipRes.json()) as {
        billings: BillingListItemDto[];
        snapshots: SnapshotDetailDto[];
      };
      const billSlip = confirmSlipBody.billings[0]!;
      const snapSlip = confirmSlipBody.snapshots[0]!;
      expect(billSlip.taxAdjustmentAmount).toBe(0);
      expect(billSlip.billingAmount).toBe(2210);
      expect(billSlip.prevCarriedBalance).toBe(100000);
      expect(billSlip.periodReceiptAmount).toBe(40000);
      expect(billSlip.netCarriedBalance).toBe(60000);
      expect(billSlip.closingArBalance).toBe(62210);
      expect(snapSlip.payloadJson.header.taxAdjustmentAmount).toBe(0);
      expect(snapSlip.payloadJson.header.totalAmount).toBe(2210);
      expect(snapSlip.payloadJson.header.mirrorSummary?.closingArBalance).toBe(62210);

      // 一旦取消して K2 へ戻し、INVOICE_BY_RATE へ切替
      const cancelRes = await cancelBillingRoute(
        buildJsonApiRequest(
          `http://localhost:3000/api/v1/billing/${billSlip.id}/cancel`,
          'POST',
          staffToken,
          {},
        ),
      );
      expect(cancelRes.status).toBe(200);

      // (B) INVOICE_BY_RATE での再集計 ＆ 請求確定（端数調整額 +1円）
      await db.query(
        `UPDATE tenant_settings SET tax_calc_policy = 'INVOICE_BY_RATE'::tax_calc_policy WHERE tenant_id = $1`,
        [tenantId],
      );

      const candInvRes = await getBillingCandidatesRoute(
        buildJsonApiRequest(
          `http://localhost:3000/api/v1/billing/candidates?dateFrom=2026-07-01&dateTo=2026-07-31&partnerId=${partnerAId}`,
          'GET',
          staffToken,
        ),
      );
      expect(candInvRes.status).toBe(200);
      const candInv = (await candInvRes.json()) as BillingCandidateListResultDto;
      const gInv = candInv.groups[0]!;
      expect(gInv.taxAdjustmentAmount).toBe(1);
      expect(gInv.tax10Amount).toBe(201);
      expect(gInv.currentBillingAmount).toBe(2211);
      expect(gInv.closingArBalance).toBe(62211);

      const confirmInvRes = await postBillingRoute(
        buildJsonApiRequest('http://localhost:3000/api/v1/billing', 'POST', staffToken, {
          billingDate: '2026-07-31',
          targetPeriodStart: '2026-07-01',
          targetPeriodEnd: '2026-07-31',
          items: [
            {
              partnerId: partnerAId,
              slipIds: [s1.id, s2.id],
              documentType: 'INVOICE_COVER',
              templateVariant: '10_ROWS',
              issueCoverDetail: true,
            },
          ],
        }),
      );
      expect(confirmInvRes.status).toBe(201);
      const confirmInvBody = (await confirmInvRes.json()) as {
        billings: BillingListItemDto[];
        snapshots: SnapshotDetailDto[];
      };
      const billInv = confirmInvBody.billings[0]!;
      expect(billInv.taxAdjustmentAmount).toBe(1);
      expect(billInv.tax10Amount).toBe(201);
      expect(billInv.billingAmount).toBe(2211);
      expect(billInv.closingArBalance).toBe(62211);
      expect(confirmInvBody.snapshots.map((s) => s.documentType)).toEqual([
        'INVOICE_COVER',
        'INVOICE_COVER_DETAIL',
      ]);
      expect(confirmInvBody.snapshots[0]!.payloadJson.header.taxAdjustmentAmount).toBe(1);
      expect(confirmInvBody.snapshots[0]!.payloadJson.header.mirrorSummary?.closingArBalance).toBe(62211);
    } finally {
      await db.query(
        `UPDATE tenant_settings SET tax_calc_policy = 'SLIP_BY_RATE'::tax_calc_policy WHERE tenant_id = $1`,
        [tenantId],
      );
      spyCtx.mockRestore();
      vi.unstubAllEnvs();
    }
  });

  it('2. 請求確定(K2->K3->K4)・編集ロック・再発行(v2 ＜再発行＞ & K5・v1不変)・取消(N3拒否/N1復元)・基準日以前拒否検証', async () => {
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
      // 売上作成 (K2)
      const sRes = await postSalesRoute(
        buildJsonApiRequest('http://localhost:3000/api/v1/sales', 'POST', staffToken, {
          entryType: 'SALE',
          slipName: 'ライフサイクル検証売上',
          slipDate: '2026-08-15',
          partnerId: partnerBId,
          projectId: null,
          honorific: '御中',
          status: 'K2',
          salesKubun: null,
          roundingMode: 'FLOOR',
          approvalRemarks: null,
          lines: [
            {
              productId,
              itemCode: 'PRD-3A',
              itemName: '請求ライフサイクル品目',
              unitName: '式',
              targetMonthLabel: null,
              isHeading: false,
              quantity: 2,
              masterUnitPrice: 10000,
              appliedUnitPrice: 15000, // 30,000 + 3,000 = 33,000
              taxCode: 'A',
              remarks: 'テスト備考',
            },
          ],
        }),
      );
      expect(sRes.status).toBe(201);
      const slip = ((await sRes.json()) as { item: SalesDetailDto }).item;

      // 承認フロー有効時、未承認での K3 化・請求確定は 409 で拒否されること
      const k3BlockRes = await patchBillingCandidatesRoute(
        buildJsonApiRequest('http://localhost:3000/api/v1/billing/candidates', 'PATCH', staffToken, {
          slipIds: [slip.id],
          targetStatus: 'K3',
        }),
      );
      expect(k3BlockRes.status).toBe(409);

      // 承認後に K3 へ遷移
      await patchSalesApprovalRoute(
        buildJsonApiRequest('http://localhost:3000/api/v1/sales/approval', 'PATCH', staffToken, {
          ids: [slip.id],
          approvalStatus: 1,
          approvalRemarks: '承認OK',
        }),
      );
      const k3OkRes = await patchBillingCandidatesRoute(
        buildJsonApiRequest('http://localhost:3000/api/v1/billing/candidates', 'PATCH', staffToken, {
          slipIds: [slip.id],
          targetStatus: 'K3',
        }),
      );
      expect(k3OkRes.status).toBe(200);

      // 基準日以前 (<= 2026-05-31) の請求確定は 400 で拒否
      const cutoffErrRes = await postBillingRoute(
        buildJsonApiRequest('http://localhost:3000/api/v1/billing', 'POST', staffToken, {
          billingDate: '2026-05-31',
          items: [{ partnerId: partnerBId, slipIds: [slip.id], documentType: 'INVOICE' }],
        }),
      );
      expect(cutoffErrRes.status).toBe(400);

      // 正規請求確定 (2026-08-31)
      const confRes = await postBillingRoute(
        buildJsonApiRequest('http://localhost:3000/api/v1/billing', 'POST', staffToken, {
          billingDate: '2026-08-31',
          targetPeriodStart: '2026-08-01',
          targetPeriodEnd: '2026-08-31',
          items: [{ partnerId: partnerBId, slipIds: [slip.id], documentType: 'INVOICE' }],
        }),
      );
      expect(confRes.status).toBe(201);
      const confBody = (await confRes.json()) as {
        billings: BillingListItemDto[];
        snapshots: SnapshotDetailDto[];
      };
      const billing = confBody.billings[0]!;
      const v1 = confBody.snapshots[0]!;
      expect(v1.versionNo).toBe(1);
      expect(v1.isReissue).toBe(false);
      expect(v1.reissueLabel).toBeNull();
      // 取引先B: closing='B'(10日), collection='2'(翌々月) -> 2026-10-10
      expect(billing.paymentDueDate).toBe('2026-10-10');

      // K4 遷移済みにより売上編集・削除は 409 Conflict でロックされること
      const putLocked = await putSalesRoute(
        buildJsonApiRequest(`http://localhost:3000/api/v1/sales/${slip.id}`, 'PUT', staffToken, {
          entryType: 'SALE',
          slipName: '改ざん',
          slipDate: '2026-08-15',
          partnerId: partnerBId,
          projectId: null,
          honorific: '御中',
          status: 'K2',
          salesKubun: null,
          roundingMode: 'FLOOR',
          approvalRemarks: null,
          lines: slip.lines,
        }),
      );
      expect(putLocked.status).toBe(409);
      const delLocked = await deleteSalesRoute(
        buildJsonApiRequest(`http://localhost:3000/api/v1/sales/${slip.id}`, 'DELETE', staffToken),
      );
      expect(delLocked.status).toBe(409);

      // v1 PDF バイナリ事前保存
      const v1PdfBeforeRes = await getSnapshotPdfRoute(
        buildJsonApiRequest(
          `http://localhost:3000/api/v1/snapshots/${v1.id}/pdf`,
          'GET',
          staffToken,
        ),
      );
      expect(v1PdfBeforeRes.status).toBe(200);
      const v1PdfBeforeBytes = Buffer.from(await v1PdfBeforeRes.arrayBuffer());

      // マスタ情報改定（自社名・口座・取引先名）
      await db.query(
        `UPDATE tenant_settings
            SET company_name = '改定後株式会社',
                bank_account_no_1_enc = $2
          WHERE tenant_id = $1`,
        [tenantId, encryptField('9999999', TEST_ENC_KEY)],
      );
      await db.query(
        `UPDATE business_partners SET partner_name = '改定後顧客B' WHERE id = $1`,
        [partnerBId],
      );

      // 再発行実行 -> v2 ＜再発行＞ ＆ sales_headers.status = K5
      const reissueRes = await reissueBillingRoute(
        buildJsonApiRequest(
          `http://localhost:3000/api/v1/billing/${billing.id}/reissue`,
          'POST',
          staffToken,
          { documentType: 'INVOICE', templateVariant: '10_ROWS' },
        ),
      );
      expect(reissueRes.status).toBe(201);
      const reissueBody = (await reissueRes.json()) as { snapshots: SnapshotDetailDto[] };
      const v2 = reissueBody.snapshots[0]!;
      expect(v2.versionNo).toBe(2);
      expect(v2.isReissue).toBe(true);
      expect(v2.reissueLabel).toBe('＜再発行＞');
      expect(v2.payloadJson.issuer.companyName).toBe('改定後株式会社');
      expect(decryptSnapshotBankAccounts(v2.payloadJson, TEST_ENC_KEY)[0]?.accountNo).toBe('9999999');

      const detailRes = await getBillingDetailRoute(
        buildJsonApiRequest(`http://localhost:3000/api/v1/billing/${billing.id}`, 'GET', staffToken),
      );
      const detail = ((await detailRes.json()) as { item: BillingDetailDto }).item;
      expect(detail.slips[0]?.status).toBe('K5');

      // マスタ変更後も v1 は 100% 同一内容・同一PDF再出力
      const v1PdfAfterRes = await getSnapshotPdfRoute(
        buildJsonApiRequest(
          `http://localhost:3000/api/v1/snapshots/${v1.id}/pdf`,
          'GET',
          staffToken,
        ),
      );
      const v1PdfAfterBytes = Buffer.from(await v1PdfAfterRes.arrayBuffer());
      expect(v1PdfAfterBytes.equals(v1PdfBeforeBytes)).toBe(true);
      const v1DetailRes = await getSnapshotDetailRoute(
        buildJsonApiRequest(`http://localhost:3000/api/v1/snapshots/${v1.id}`, 'GET', staffToken),
      );
      const v1Payload = ((await v1DetailRes.json()) as { item: SnapshotDetailDto }).item.payloadJson;
      expect(decryptSnapshotBankAccounts(v1Payload, TEST_ENC_KEY)[0]?.accountNo).toBe('7654321');

      // 入金消込済み (N3) の請求取消は 409 Conflict で拒否
      await db.query(
        `UPDATE billing_headers SET status = 'N3'::receivable_status WHERE id = $1`,
        [billing.id],
      );
      const cancelSettledRes = await cancelBillingRoute(
        buildJsonApiRequest(
          `http://localhost:3000/api/v1/billing/${billing.id}/cancel`,
          'POST',
          staffToken,
          {},
        ),
      );
      expect(cancelSettledRes.status).toBe(409);

      // N1 未入金へ戻して取消 -> K2 へロールバック・スナップショットは不変保持
      await db.query(
        `UPDATE billing_headers SET status = 'N1'::receivable_status WHERE id = $1`,
        [billing.id],
      );
      const cancelOkRes = await cancelBillingRoute(
        buildJsonApiRequest(
          `http://localhost:3000/api/v1/billing/${billing.id}/cancel`,
          'POST',
          staffToken,
          {},
        ),
      );
      expect(cancelOkRes.status).toBe(200);

      const slipAfterCancel = await db.query<{ status: string; billing_id: string | null }>(
        `SELECT status::text AS status, billing_id FROM sales_headers WHERE id = $1`,
        [slip.id],
      );
      expect(slipAfterCancel.rows[0]?.status).toBe('K2');
      expect(slipAfterCancel.rows[0]?.billing_id).toBeNull();

      // document_snapshots は v1/v2 とも不変監査証跡として残存
      const snapCountRes = await getSnapshotsRoute(
        buildJsonApiRequest(
          `http://localhost:3000/api/v1/snapshots?documentType=INVOICE&sourceEntityId=${billing.id}`,
          'GET',
          staffToken,
        ),
      );
      const snapItems = ((await snapCountRes.json()) as { items: SnapshotHistoryItemDto[] }).items;
      expect(snapItems).toHaveLength(2);
    } finally {
      spyCtx.mockRestore();
      vi.unstubAllEnvs();
    }
  });

  it('3. 旧Accessバグ4是正（定額一括請求確定）：外税A・軽減B・内税D/E混在 ＆ FIXED_INVOICE発行 ＆ 二重請求409防止 ＆ 取消再実行検証', async () => {
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
      const contracts = [
        { itemName: '定額10%外税', unitPrice: 10000, taxCode: 'A', outputType: 'PDF' },
        { itemName: '定額8%軽減外税', unitPrice: 10000, taxCode: 'B', outputType: '印刷' },
        { itemName: '定額10%内税(11000円)', unitPrice: 11000, taxCode: 'D', outputType: 'メール' },
        { itemName: '定額8%内税(10800円)', unitPrice: 10800, taxCode: 'E', outputType: 'PDF' },
      ];
      for (const c of contracts) {
        const res = await postSubscriptionsRoute(
          buildJsonApiRequest('http://localhost:3000/api/v1/subscriptions', 'POST', staffToken, {
            partnerId: partnerBId,
            entryType: 'SALE',
            productId: null,
            itemName: c.itemName,
            monthLabel: '9月分',
            unitName: '式',
            quantity: 1,
            masterUnitPrice: null,
            appliedUnitPrice: c.unitPrice,
            taxCode: c.taxCode,
            roundingMode: 'FLOOR',
            outputType: c.outputType,
            isActive: true,
          }),
        );
        expect(res.status).toBe(201);
      }

      // 月次未承認状態での定額一括請求は 409 で拒否されること
      const unapprovedExec = await executeSubscBillingRoute(
        buildJsonApiRequest(
          'http://localhost:3000/api/v1/subscriptions/execute-billing',
          'POST',
          staffToken,
          {
            targetMonth: '202609',
            billingDate: '2026-09-30',
          },
        ),
      );
      expect(unapprovedExec.status).toBe(409);

      // 9月度を承認済(1)へ更新
      const flowRes = await putMonthlyFlowsRoute(
        buildJsonApiRequest(
          'http://localhost:3000/api/v1/subscriptions/approval-flows',
          'PUT',
          staffToken,
          {
            targetMonth: '202609',
            items: [
              { partnerId: partnerBId, entryType: 'SALE', flowStatus: 1, remarks: '9月定額承認' },
            ],
          },
        ),
      );
      expect(flowRes.status).toBe(200);

      // 定額一括請求確定実行
      const execRes = await executeSubscBillingRoute(
        buildJsonApiRequest(
          'http://localhost:3000/api/v1/subscriptions/execute-billing',
          'POST',
          staffToken,
          {
            targetMonth: '202609',
            billingDate: '2026-09-30',
          },
        ),
      );
      expect(execRes.status).toBe(201);
      const execBody = (await execRes.json()) as ExecuteSubscriptionBillingResultDto;
      expect(execBody.executedCount).toBe(1);
      const hist = execBody.items[0]!;
      // 税抜 40,000 + 税 3,600 (10%: 2,000, 8%: 1,600) = 43,600（内税D/Eの二重加算なし）
      expect(hist.billedAmount).toBe(43600);
      expect(hist.latestSnapshotId).not.toBeNull();

      const billDetailRes = await getBillingDetailRoute(
        buildJsonApiRequest(
          `http://localhost:3000/api/v1/billing/${hist.billingId}`,
          'GET',
          staffToken,
        ),
      );
      const billDetail = ((await billDetailRes.json()) as { item: BillingDetailDto }).item;
      expect(billDetail.isSubscriptionBill).toBe(true);
      expect(billDetail.amount10Excl).toBe(20000);
      expect(billDetail.tax10Amount).toBe(2000);
      expect(billDetail.amount8Excl).toBe(20000);
      expect(billDetail.tax8Amount).toBe(1600);
      expect(billDetail.billingAmount).toBe(43600);
      expect(billDetail.slips[0]?.status).toBe('K4');
      expect(billDetail.slips[0]?.salesKubun).toBe('定額');
      expect(billDetail.snapshots[0]?.documentType).toBe('FIXED_INVOICE');

      // 同一対象年月の二重実行は 409 Conflict でブロックされること
      const dupExecRes = await executeSubscBillingRoute(
        buildJsonApiRequest(
          'http://localhost:3000/api/v1/subscriptions/execute-billing',
          'POST',
          staffToken,
          {
            targetMonth: '202609',
            billingDate: '2026-09-30',
          },
        ),
      );
      expect(dupExecRes.status).toBe(409);

      // 定額請求取消で自動生成された K4 売上ヘッダ・subscription_billings を安全削除し再実行できること
      const cancelSubRes = await cancelBillingRoute(
        buildJsonApiRequest(
          `http://localhost:3000/api/v1/billing/${hist.billingId}/cancel`,
          'POST',
          staffToken,
          {},
        ),
      );
      expect(cancelSubRes.status).toBe(200);

      const reExecRes = await executeSubscBillingRoute(
        buildJsonApiRequest(
          'http://localhost:3000/api/v1/subscriptions/execute-billing',
          'POST',
          staffToken,
          {
            targetMonth: '202609',
            billingDate: '2026-09-30',
          },
        ),
      );
      expect(reExecRes.status).toBe(201);
    } finally {
      spyCtx.mockRestore();
      vi.unstubAllEnvs();
    }
  });

  it('4. 対外請求書6種PDF・内部請求一覧3種（内税二重加算防止＝バグ5是正）CSV/PDF出力 ＆ 機能フラグ403制御検証', async () => {
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
      // 売上（内税D 11,000円 + 同品名備考の合算確認用2行）＋ 立替金（非課税C 5,000円）
      const sSaleRes = await postSalesRoute(
        buildJsonApiRequest('http://localhost:3000/api/v1/sales', 'POST', staffToken, {
          entryType: 'SALE',
          slipName: '内税検証売上',
          slipDate: '2026-10-10',
          partnerId: partnerAId,
          projectId: null,
          honorific: '御中',
          status: 'K3',
          salesKubun: null,
          roundingMode: 'FLOOR',
          approvalRemarks: null,
          lines: [
            {
              productId: null,
              itemCode: 'INT-D',
              itemName: '定例点検作業',
              unitName: '回',
              targetMonthLabel: '10月分',
              isHeading: false,
              quantity: 1,
              masterUnitPrice: null,
              appliedUnitPrice: 11000, // D: 税抜 10,000, 税 1,000, 行計 11,000
              taxCode: 'D',
              remarks: '定期枠',
            },
            {
              productId: null,
              itemCode: 'INT-D',
              itemName: '定例点検作業',
              unitName: '回',
              targetMonthLabel: '10月分',
              isHeading: false,
              quantity: 2,
              masterUnitPrice: null,
              appliedUnitPrice: 11000, // D: line_amount 22,000, line_tax 2,000, row_total 22,000
              taxCode: 'D',
              remarks: '定期枠',
            },
          ],
        }),
      );
      expect(sSaleRes.status).toBe(201);
      const sSale = ((await sSaleRes.json()) as { item: SalesDetailDto }).item;

      const sAdvRes = await postSalesRoute(
        buildJsonApiRequest('http://localhost:3000/api/v1/sales', 'POST', staffToken, {
          entryType: 'ADVANCE',
          slipName: '立替印紙代',
          slipDate: '2026-10-12',
          partnerId: partnerAId,
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
              itemName: '収入印紙代',
              unitName: '枚',
              targetMonthLabel: null,
              isHeading: false,
              quantity: 1,
              masterUnitPrice: null,
              appliedUnitPrice: 5000,
              taxCode: 'C',
              remarks: '契約書印紙',
            },
          ],
        }),
      );
      expect(sAdvRes.status).toBe(201);
      const sAdv = ((await sAdvRes.json()) as { item: SalesDetailDto }).item;

      await patchSalesApprovalRoute(
        buildJsonApiRequest('http://localhost:3000/api/v1/sales/approval', 'PATCH', staffToken, {
          ids: [sSale.id, sAdv.id],
          approvalStatus: 1,
          approvalRemarks: 'OK',
        }),
      );

      const confRes = await postBillingRoute(
        buildJsonApiRequest('http://localhost:3000/api/v1/billing', 'POST', staffToken, {
          billingDate: '2026-10-31',
          targetPeriodStart: '2026-10-01',
          targetPeriodEnd: '2026-10-31',
          items: [
            {
              partnerId: partnerAId,
              slipIds: [sSale.id, sAdv.id],
              documentType: 'INVOICE',
              templateVariant: '10_ROWS',
            },
          ],
        }),
      );
      expect(confRes.status).toBe(201);
      const confBody = (await confRes.json()) as {
        billings: BillingListItemDto[];
        snapshots: SnapshotDetailDto[];
      };
      const billing = confBody.billings[0]!;
      expect(billing.billingAmount).toBe(38000); // 33,000 + 5,000

      // 残り5種の対外帳票スナップショットも発行・PDF解析検証
      const extraDocTypes = [
        'INVOICE_STANDALONE',
        'INVOICE_COVER',
        'INVOICE_COVER_MEMO_SUM',
        'INVOICE_COVER_DETAIL',
        'FIXED_INVOICE',
      ] as const;

      const allSnaps: SnapshotDetailDto[] = [confBody.snapshots[0]!];
      for (const dt of extraDocTypes) {
        const sRes = await postSnapshotsRoute(
          buildJsonApiRequest('http://localhost:3000/api/v1/snapshots', 'POST', staffToken, {
            documentType: dt,
            sourceEntityId: billing.id,
            templateVariant: '10_ROWS',
            issueDate: '2026-10-31',
          }),
        );
        expect(sRes.status).toBe(201);
        allSnaps.push(((await sRes.json()) as { item: SnapshotDetailDto }).item);
      }

      const standalone = allSnaps.find((s) => s.documentType === 'INVOICE_STANDALONE')!;
      expect(standalone.payloadJson.header.showCarryover).toBe(false);
      expect(standalone.payloadJson.header.mirrorSummary).toBeNull();

      const memoSum = allSnaps.find((s) => s.documentType === 'INVOICE_COVER_MEMO_SUM')!;
      // 「定例点検作業 / 定期枠 / D」2行が 数量 3 へ集約され、立替 C と計2行になること
      expect(memoSum.payloadJson.lines).toHaveLength(2);
      expect(memoSum.payloadJson.lines[0]?.quantity).toBe(3);

      const coverDetail = allSnaps.find((s) => s.documentType === 'INVOICE_COVER_DETAIL')!;
      expect(coverDetail.payloadJson.lines.some((l) => l.advanceMark === 'T')).toBe(true);

      for (const snap of allSnaps) {
        const pdfRes = await getSnapshotPdfRoute(
          buildJsonApiRequest(
            `http://localhost:3000/api/v1/snapshots/${snap.id}/pdf`,
            'GET',
            staffToken,
          ),
        );
        expect(pdfRes.status).toBe(200);
        const bytes = new Uint8Array(await pdfRes.arrayBuffer());
        expect(Buffer.from(bytes.slice(0, 5)).toString('ascii')).toBe('%PDF-');
        const parsed = await PDFDocument.load(bytes);
        expect(parsed.getPageCount()).toBeGreaterThanOrEqual(1);
      }

      // 内部管理一覧3種（standard / simple / detail）PDF＆CSV出力確認 + バグ5内税二重加算なし検証
      for (const target of ['standard', 'simple', 'detail'] as const) {
        const pdfRes = await exportBillingRoute(
          buildJsonApiRequest(
            `http://localhost:3000/api/v1/billing/export?target=${target}&format=pdf&dateFrom=2026-10-01&dateTo=2026-10-31`,
            'GET',
            staffToken,
          ),
        );
        expect(pdfRes.status).toBe(200);
        const pdfBytes = new Uint8Array(await pdfRes.arrayBuffer());
        expect(Buffer.from(pdfBytes.slice(0, 5)).toString('ascii')).toBe('%PDF-');
        const loaded = await PDFDocument.load(pdfBytes);
        expect(loaded.getPageCount()).toBeGreaterThanOrEqual(1);

        const csvRes = await exportBillingRoute(
          buildJsonApiRequest(
            `http://localhost:3000/api/v1/billing/export?target=${target}&format=csv&dateFrom=2026-10-01&dateTo=2026-10-31`,
            'GET',
            staffToken,
          ),
        );
        expect(csvRes.status).toBe(200);
        const csvBuf = Buffer.from(await csvRes.arrayBuffer());
        expect(csvBuf.subarray(0, 3).equals(Buffer.from([0xef, 0xbb, 0xbf]))).toBe(true);
        const csvText = csvBuf.toString('utf8');
        if (target === 'detail') {
          // 11,000円内税(D)行が 税抜10,000・税1,000・税込行計11,000（12,000にならない）で出力されること
          expect(csvText).toContain('"10000","1000","11000"');
        }
      }

      // 請求機能フラグOFF時の 403 拒否検証
      await db.query(
        `UPDATE tenant_feature_authorities
            SET is_enabled = false
          WHERE tenant_id = $1 AND feature_code IN ('billsummary', 'billissue', 'fixedbill')`,
        [tenantId],
      );
      const listForbidden = await getBillingRoute(
        buildJsonApiRequest('http://localhost:3000/api/v1/billing', 'GET', staffToken),
      );
      expect(listForbidden.status).toBe(403);
      const candForbidden = await getBillingCandidatesRoute(
        buildJsonApiRequest('http://localhost:3000/api/v1/billing/candidates', 'GET', staffToken),
      );
      expect(candForbidden.status).toBe(403);
    } finally {
      spyCtx.mockRestore();
      vi.unstubAllEnvs();
    }
  });
});
