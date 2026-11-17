import fs from 'node:fs';
import path from 'node:path';
import { PGlite } from '@electric-sql/pglite';
import { PDFDocument } from 'pdf-lib';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { GET as getPayableBalancesRoute } from '@/app/api/v1/payables/balances/route';
import { GET as exportPayableBalancesRoute } from '@/app/api/v1/payables/export/route';
import {
  GET as getPayableLedgersRoute,
  PATCH as patchPayableLedgerRoute,
} from '@/app/api/v1/payables/ledgers/route';
import {
  GET as getSupplierPaymentsRoute,
  POST as postSupplierPaymentsRoute,
} from '@/app/api/v1/payables/payments/route';
import {
  DELETE as deleteSupplierPaymentRoute,
  PUT as putSupplierPaymentRoute,
} from '@/app/api/v1/payables/payments/[id]/route';
import { GET as exportSupplierPaymentsRoute } from '@/app/api/v1/payables/payments/export/route';
import {
  GET as getPurchaseOrdersRoute,
  POST as postPurchaseOrdersRoute,
} from '@/app/api/v1/purchase-orders/route';
import {
  DELETE as deletePurchaseOrderRoute,
  GET as getPurchaseOrderDetailRoute,
  PUT as putPurchaseOrderRoute,
} from '@/app/api/v1/purchase-orders/[id]/route';
import { GET as exportPurchaseOrdersRoute } from '@/app/api/v1/purchase-orders/export/route';
import {
  GET as getPurchasesRoute,
  POST as postPurchasesRoute,
} from '@/app/api/v1/purchases/route';
import {
  DELETE as deletePurchaseRoute,
  GET as getPurchaseDetailRoute,
  PUT as putPurchaseRoute,
} from '@/app/api/v1/purchases/[id]/route';
import { POST as cancelPurchaseConfirmRoute } from '@/app/api/v1/purchases/[id]/cancel-confirm/route';
import { POST as createPurchaseFromOrderRoute } from '@/app/api/v1/purchases/from-order/route';
import { GET as exportPurchasesRoute } from '@/app/api/v1/purchases/export/route';
import {
  GET as getSnapshotsRoute,
  POST as postSnapshotsRoute,
} from '@/app/api/v1/snapshots/route';
import { GET as getSnapshotPdfRoute } from '@/app/api/v1/snapshots/[id]/pdf/route';
import { authenticateLogin } from '@/lib/auth/auth-service';
import { encryptField, hashPassword } from '@/lib/crypto/field-cipher';
import { withExecutorTenantContext, type DbExecutor } from '@/lib/db/tenant-client';
import type { SnapshotDetailDto } from '@/lib/estimates/types';
import type {
  PayableBalanceListResultDto,
  PayableLedgerItemDto,
  SupplierPaymentDto,
} from '@/lib/payables/types';
import type { PurchaseDetailDto, PurchaseOrderDetailDto } from '@/lib/purchasing/types';

const TEST_ENC_KEY = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';
const TEST_SESSION_SECRET = 'phase4a-test-session-secret-0123456789abcdef';

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

describe('Phase 4-A 発注・仕入（P3買掛自動同期＆基準日制御）・買掛残高一覧・支払管理検証', () => {
  let db: PGlite;
  let exec: DbExecutor;

  const tenantId = '99999999-9999-4444-8444-999999999999';
  const tenantSlug = 'phase4a-corp';
  const staffEmpId = 'cccc9999-9999-4444-8444-999999999999';

  let supplierAId = '';
  let supplierBId = '';
  let projectId = '';
  let staffToken = '';

  beforeAll(async () => {
    db = new PGlite();
    exec = createPgliteExecutor(db);

    const rootDir = process.cwd();
    await db.exec(
      fs.readFileSync(path.join(rootDir, 'supabase', 'migrations', '0001_schema.sql'), 'utf8'),
    );
    await db.exec(
      fs.readFileSync(path.join(rootDir, 'supabase', 'migrations', '0002_rls_policies.sql'), 'utf8'),
    );
    await db.exec(
      fs.readFileSync(
        path.join(rootDir, 'supabase', 'migrations', '0003_auth_security.sql'),
        'utf8',
      ),
    );
    await db.exec(
      fs.readFileSync(path.join(rootDir, 'supabase', 'seed', 'default_codes.sql'), 'utf8'),
    );
    await db.exec(
      fs.readFileSync(
        path.join(rootDir, 'supabase', 'migrations', '0004_complete_code_masters_seed.sql'),
        'utf8',
      ),
    );

    await db.query(
      `INSERT INTO tenants (id, tenant_slug, tenant_name) VALUES ($1, $2, '購買買掛テスト株式会社')`,
      [tenantId, tenantSlug],
    );
    await db.query(
      `INSERT INTO tenant_settings (
         tenant_id, company_code, company_name, invoice_registration_no,
         postal_code, address1, tel, email, representative_title, representative_name,
         bank_code_1, branch_code_1, bank_account_type_1, bank_account_no_1_enc, bank_account_holder_1,
         approval_flow_enabled, quotation_template_rows, tax_calc_policy, default_rounding_mode, opening_balance_date
       ) VALUES (
         $1, '9060', '購買買掛テスト株式会社', 'T9876543210123',
         '417-0010', '静岡県富士市購買町1-1', '0545-22-3333', 'po@example.com',
         '代表取締役', '購買 次郎',
         '0149', '001', 'B1', $2, 'コウバイカイカケ',
         true, 10, 'SLIP_BY_RATE', 'FLOOR', '2026-05-31'
       )`,
      [tenantId, encryptField('9876543', TEST_ENC_KEY)],
    );
    await db.query('SELECT seed_tenant_defaults($1)', [tenantId]);
    await db.query(
      `UPDATE tenant_feature_authorities
          SET is_enabled = true
        WHERE tenant_id = $1
          AND feature_code IN ('order', 'purchase', 'payable', 'payment', 'construction')`,
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
       VALUES ($1, $2, '200', '購買経理担当', $3, false, false)`,
      [staffEmpId, tenantId, hashPassword('Phase4APass2026!')],
    );

    // 仕入先A（発注明細・スナップショット検証用）
    const sARows = await db.query<{ id: string }>(
      `INSERT INTO business_partners (
         tenant_id, partner_code, partner_name, is_individual_honorific,
         postal_code, address1, is_client, is_supplier, closing_day_code, collection_day_code,
         opening_ap_balance
       ) VALUES (
         $1, '50001', '株式会社外注テスト工業', false, '417-0011', '静岡県富士市外注町2-2',
         false, true, 'D', '1', 0
       ) RETURNING id`,
      [tenantId],
    );
    supplierAId = sARows.rows[0]!.id;

    // 仕入先B（期首買掛 100,000円 検証用）
    const sBRows = await db.query<{ id: string }>(
      `INSERT INTO business_partners (
         tenant_id, partner_code, partner_name, is_individual_honorific,
         postal_code, address1, is_client, is_supplier, closing_day_code, collection_day_code,
         opening_ap_balance
       ) VALUES (
         $1, '50002', '有限会社資材サプライB', false, '417-0012', '静岡県富士市資材町3-3',
         false, true, 'D', '1', 100000
       ) RETURNING id`,
      [tenantId],
    );
    supplierBId = sBRows.rows[0]!.id;

    // 案件マスタ参照用レコード
    const pjRows = await db.query<{ id: string }>(
      `INSERT INTO projects (
         tenant_id, project_no, project_name, project_date, site_place,
         partner_id, partner_name_snap, status
       ) VALUES (
         $1, 2026060100001, 'テスト工場屋根改修工事', '2026-06-01', '富士市テスト工場現場',
         $2, '有限会社資材サプライB', 'C2'
       ) RETURNING id`,
      [tenantId, supplierBId],
    );
    projectId = pjRows.rows[0]!.id;

    const loginRes = await authenticateLogin(exec, {
      tenantSlug,
      syainCode: '200',
      password: 'Phase4APass2026!',
      clientIp: '127.0.0.1',
      sessionSecretOverride: TEST_SESSION_SECRET,
    });
    staffToken = loginRes.token;
  });

  afterAll(async () => {
    await db.close();
  });

  it('1. 発注CRUD（外税/軽減/非課税/内税・見出し行厳密計算）・発注書スナップショット（v1->v2 ＜再発行＞・マスタ変更後v1同一PDF・削除409）・仕入転記検証', async () => {
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
      // 1-1. 外税A・軽減B・非課税C・内税D・見出し行混在の発注作成
      const createRes = await postPurchaseOrdersRoute(
        buildJsonApiRequest('http://localhost:3000/api/v1/purchase-orders', 'POST', staffToken, {
          orderName: 'テスト工場 資材・外注発注',
          orderDate: '2026-06-05',
          supplierId: supplierAId,
          projectId,
          honorific: '御中',
          deliveryDate: '2026-06-25',
          status: 'O2',
          roundingMode: 'FLOOR',
          remarks: '納入時事前連絡',
          lines: [
            {
              productId: null,
              itemCode: null,
              itemName: '【外注・資材一式】',
              unitName: null,
              isHeading: true,
              quantity: 0,
              taxCode: 'C',
              masterUnitPrice: null,
              appliedUnitPrice: 0,
              remarks: null,
            },
            {
              productId: null,
              itemCode: 'MAT-10',
              itemName: '折板屋根材',
              unitName: '枚',
              isHeading: false,
              quantity: 2,
              taxCode: 'A',
              masterUnitPrice: 10000,
              appliedUnitPrice: 10000,
              remarks: null,
            },
            {
              productId: null,
              itemCode: 'FOOD-08',
              itemName: '現場飲料（軽減8%）',
              unitName: '箱',
              isHeading: false,
              quantity: 1,
              taxCode: 'B',
              masterUnitPrice: 5000,
              appliedUnitPrice: 5000,
              remarks: null,
            },
            {
              productId: null,
              itemCode: 'FEE-00',
              itemName: '証明書印紙（非課税）',
              unitName: '式',
              isHeading: false,
              quantity: 1,
              taxCode: 'C',
              masterUnitPrice: 3000,
              appliedUnitPrice: 3000,
              remarks: null,
            },
            {
              productId: null,
              itemCode: 'LAB-IN',
              itemName: '搬入諸経費（内税10%）',
              unitName: '式',
              isHeading: false,
              quantity: 1,
              taxCode: 'D',
              masterUnitPrice: 11000,
              appliedUnitPrice: 11000,
              remarks: null,
            },
          ],
        }),
      );
      expect(createRes.status).toBe(201);
      const order = ((await createRes.json()) as { item: PurchaseOrderDetailDto }).item;
      expect(order.orderNo).toBe(1);
      expect(order.deliveryPlace).toBe('富士市テスト工場現場');
      // 税抜 = 20000 + 5000 + 3000 + 10000 = 38000, 税 = 2000 + 400 + 0 + 1000 = 3400, 税込 = 41400
      expect(order.subtotalAmount).toBe(38000);
      expect(order.taxTotal).toBe(3400);
      expect(order.totalAmount).toBe(41400);
      expect(order.lines[0]?.isHeading).toBe(true);
      expect(order.lines[4]?.lineTotal).toBe(11000); // 内税二重加算なし

      // 1-2. 発注書スナップショット v1 発行＆PDF生成
      const snapV1Res = await postSnapshotsRoute(
        buildJsonApiRequest('http://localhost:3000/api/v1/snapshots', 'POST', staffToken, {
          documentType: 'PURCHASE_ORDER',
          sourceEntityId: order.id,
          templateVariant: '10_ROWS',
          issueDate: '2026-06-05',
        }),
      );
      expect(snapV1Res.status).toBe(201);
      const snapV1 = ((await snapV1Res.json()) as { item: SnapshotDetailDto }).item;
      expect(snapV1.versionNo).toBe(1);
      expect(snapV1.isReissue).toBe(false);
      expect(snapV1.reissueLabel).toBeNull();
      expect(snapV1.payloadJson.header.deliveryPlace).toBe('富士市テスト工場現場');

      const v1PdfRes1 = await getSnapshotPdfRoute(
        buildJsonApiRequest(
          `http://localhost:3000/api/v1/snapshots/${snapV1.id}/pdf`,
          'GET',
          staffToken,
        ),
      );
      expect(v1PdfRes1.status).toBe(200);
      const v1PdfBytes1 = Buffer.from(await v1PdfRes1.arrayBuffer());
      const v1Parsed = await PDFDocument.load(v1PdfBytes1);
      expect(v1Parsed.getPageCount()).toBe(1);

      // 1-3. スナップショット発行済み発注の削除 409 拒否
      const blockedDelRes = await deletePurchaseOrderRoute(
        buildJsonApiRequest(
          `http://localhost:3000/api/v1/purchase-orders/${order.id}`,
          'DELETE',
          staffToken,
        ),
      );
      expect(blockedDelRes.status).toBe(409);

      // 1-4. 自社名・仕入先名・伝票金額変更後も v1 PDF が 100% 同一であること
      await db.query(
        `UPDATE tenant_settings SET company_name = '改名後テスト会社' WHERE tenant_id = $1`,
        [tenantId],
      );
      await db.query(
        `UPDATE business_partners SET partner_name = '改名後外注工業' WHERE id = $1`,
        [supplierAId],
      );
      const updRes = await putPurchaseOrderRoute(
        buildJsonApiRequest(
          `http://localhost:3000/api/v1/purchase-orders/${order.id}`,
          'PUT',
          staffToken,
          {
            orderName: '変更後発注名',
            orderDate: '2026-06-06',
            supplierId: supplierAId,
            projectId,
            honorific: '御中',
            deliveryDate: '2026-06-30',
            status: 'O2',
            roundingMode: 'FLOOR',
            remarks: null,
            lines: [
              {
                productId: null,
                itemCode: 'MAT-10',
                itemName: '折板屋根材',
                unitName: '枚',
                isHeading: false,
                quantity: 5,
                taxCode: 'A',
                masterUnitPrice: 10000,
                appliedUnitPrice: 10000,
                remarks: null,
              },
            ],
          },
        ),
      );
      expect(updRes.status).toBe(200);

      const v1PdfRes2 = await getSnapshotPdfRoute(
        buildJsonApiRequest(
          `http://localhost:3000/api/v1/snapshots/${snapV1.id}/pdf`,
          'GET',
          staffToken,
        ),
      );
      expect(v1PdfRes2.status).toBe(200);
      const v1PdfBytes2 = Buffer.from(await v1PdfRes2.arrayBuffer());
      expect(Buffer.compare(v1PdfBytes1, v1PdfBytes2)).toBe(0);

      // 1-5. 再発行 v2 ＜再発行＞
      const snapV2Res = await postSnapshotsRoute(
        buildJsonApiRequest('http://localhost:3000/api/v1/snapshots', 'POST', staffToken, {
          documentType: 'PURCHASE_ORDER',
          sourceEntityId: order.id,
          issueDate: '2026-06-06',
        }),
      );
      expect(snapV2Res.status).toBe(201);
      const snapV2 = ((await snapV2Res.json()) as { item: SnapshotDetailDto }).item;
      expect(snapV2.versionNo).toBe(2);
      expect(snapV2.isReissue).toBe(true);
      expect(snapV2.reissueLabel).toBe('＜再発行＞');
      expect(snapV2.payloadJson.header.totalAmount).toBe(55000);

      const listSnapRes = await getSnapshotsRoute(
        buildJsonApiRequest(
          `http://localhost:3000/api/v1/snapshots?documentType=PURCHASE_ORDER&sourceEntityId=${order.id}`,
          'GET',
          staffToken,
        ),
      );
      expect(listSnapRes.status).toBe(200);

      // マスタ名を復元
      await db.query(
        `UPDATE tenant_settings SET company_name = '購買買掛テスト株式会社' WHERE tenant_id = $1`,
        [tenantId],
      );
      await db.query(
        `UPDATE business_partners SET partner_name = '株式会社外注テスト工業' WHERE id = $1`,
        [supplierAId],
      );

      // 1-6. スナップショット無し発注を作成し、仕入転記 ＆ 転記元削除409検証
      const ord2Res = await postPurchaseOrdersRoute(
        buildJsonApiRequest('http://localhost:3000/api/v1/purchase-orders', 'POST', staffToken, {
          orderName: '転記検証用発注',
          orderDate: '2026-06-07',
          supplierId: supplierAId,
          projectId,
          honorific: '御中',
          deliveryDate: null,
          status: 'O2',
          roundingMode: 'FLOOR',
          remarks: null,
          lines: [
            {
              productId: null,
              itemCode: null,
              itemName: '足場組払し',
              unitName: '式',
              isHeading: false,
              quantity: 1,
              taxCode: 'A',
              masterUnitPrice: 120000,
              appliedUnitPrice: 120000,
              remarks: null,
            },
          ],
        }),
      );
      expect(ord2Res.status).toBe(201);
      const ord2 = ((await ord2Res.json()) as { item: PurchaseOrderDetailDto }).item;

      const xferRes = await createPurchaseFromOrderRoute(
        buildJsonApiRequest(
          'http://localhost:3000/api/v1/purchases/from-order',
          'POST',
          staffToken,
          {
            orderId: ord2.id,
            purchaseDate: '2026-06-08',
            initialStatus: 'P2',
          },
        ),
      );
      expect(xferRes.status).toBe(201);
      const transferredPurchase = ((await xferRes.json()) as { item: PurchaseDetailDto }).item;
      expect(transferredPurchase.purchaseOrderId).toBe(ord2.id);
      expect(transferredPurchase.status).toBe('P2');
      expect(transferredPurchase.totalAmount).toBe(132000);
      expect(transferredPurchase.lines[0]?.projectId).toBe(projectId);

      // 転記元の発注が O3 になっていること & 削除409ブロック
      const ord2AfterRes = await getPurchaseOrderDetailRoute(
        buildJsonApiRequest(
          `http://localhost:3000/api/v1/purchase-orders/${ord2.id}`,
          'GET',
          staffToken,
        ),
      );
      const ord2After = ((await ord2AfterRes.json()) as { item: PurchaseOrderDetailDto }).item;
      expect(ord2After.status).toBe('O3');

      const delLinkedOrdRes = await deletePurchaseOrderRoute(
        buildJsonApiRequest(
          `http://localhost:3000/api/v1/purchase-orders/${ord2.id}`,
          'DELETE',
          staffToken,
        ),
      );
      expect(delLinkedOrdRes.status).toBe(409);
    } finally {
      spyCtx.mockRestore();
      vi.unstubAllEnvs();
    }
  });

  it('2. 仕入基準日制御＆旧Access D3欠陥是正検証（基準日前P1/P2編集可・P3 400拒否・基準日後P3買掛自動計上・P3ロック・確定取消ロールバック）', async () => {
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
      // 2-1. 基準日 (2026-05-31) 以前の P2 仕掛作成・編集は許可
      const preRes = await postPurchasesRoute(
        buildJsonApiRequest('http://localhost:3000/api/v1/purchases', 'POST', staffToken, {
          purchaseName: '移行仕掛P2案件',
          purchaseDate: '2026-05-20',
          supplierId: supplierAId,
          purchaseOrderId: null,
          honorific: '御中',
          status: 'P2',
          roundingMode: 'FLOOR',
          remarks: null,
          lines: [
            {
              projectId,
              productId: null,
              itemCode: null,
              itemName: '鋼材先行仕入',
              unitName: '式',
              isHeading: false,
              quantity: 1,
              taxCode: 'A',
              masterUnitPrice: 200000,
              appliedUnitPrice: 200000,
              remarks: null,
            },
          ],
        }),
      );
      expect(preRes.status).toBe(201);
      const prePur = ((await preRes.json()) as { item: PurchaseDetailDto }).item;
      expect(prePur.status).toBe('P2');
      expect(prePur.payableLedgerId).toBeNull();

      // 基準日以前の P2 編集も許可
      const preUpdRes = await putPurchaseRoute(
        buildJsonApiRequest(
          `http://localhost:3000/api/v1/purchases/${prePur.id}`,
          'PUT',
          staffToken,
          {
            purchaseName: '移行仕掛P2案件(修正後)',
            purchaseDate: '2026-05-25',
            supplierId: supplierAId,
            purchaseOrderId: null,
            honorific: '御中',
            status: 'P2',
            roundingMode: 'FLOOR',
            remarks: null,
            lines: [
              {
                projectId,
                productId: null,
                itemCode: null,
                itemName: '鋼材先行仕入',
                unitName: '式',
                isHeading: false,
                quantity: 1,
                taxCode: 'A',
                masterUnitPrice: 250000,
                appliedUnitPrice: 250000,
                remarks: null,
              },
            ],
          },
        ),
      );
      expect(preUpdRes.status).toBe(200);
      expect(((await preUpdRes.json()) as { item: PurchaseDetailDto }).item.totalAmount).toBe(275000);

      // 2-2. 基準日以前（<= 2026-05-31）での P3 確定は 400 PURCHASE_DATE_BEFORE_CUTOFF 拒否
      const badConfirmRes = await putPurchaseRoute(
        buildJsonApiRequest(
          `http://localhost:3000/api/v1/purchases/${prePur.id}`,
          'PUT',
          staffToken,
          {
            purchaseName: '移行仕掛P2案件(修正後)',
            purchaseDate: '2026-05-31',
            supplierId: supplierAId,
            purchaseOrderId: null,
            honorific: '御中',
            status: 'P3',
            roundingMode: 'FLOOR',
            remarks: null,
            lines: [
              {
                projectId,
                productId: null,
                itemCode: null,
                itemName: '鋼材先行仕入',
                unitName: '式',
                isHeading: false,
                quantity: 1,
                taxCode: 'A',
                masterUnitPrice: 250000,
                appliedUnitPrice: 250000,
                remarks: null,
              },
            ],
          },
        ),
      );
      expect(badConfirmRes.status).toBe(400);
      const badErr = (await badConfirmRes.json()) as { errorCode: string };
      expect(badErr.errorCode).toBe('PURCHASE_DATE_BEFORE_CUTOFF');

      // 2-3. 基準日後 (2026-06-15) で P3 確定 -> payable_ledgers 自動生成（旧D3欠陥根絶）
      const confirmRes = await putPurchaseRoute(
        buildJsonApiRequest(
          `http://localhost:3000/api/v1/purchases/${prePur.id}`,
          'PUT',
          staffToken,
          {
            purchaseName: '移行仕掛P2案件(確定)',
            purchaseDate: '2026-06-15',
            supplierId: supplierAId,
            purchaseOrderId: null,
            honorific: '御中',
            status: 'P3',
            roundingMode: 'FLOOR',
            remarks: null,
            lines: [
              {
                projectId,
                productId: null,
                itemCode: null,
                itemName: '鋼材先行仕入',
                unitName: '式',
                isHeading: false,
                quantity: 1,
                taxCode: 'A',
                masterUnitPrice: 250000,
                appliedUnitPrice: 250000,
                remarks: null,
              },
            ],
          },
        ),
      );
      expect(confirmRes.status).toBe(200);
      const confirmed = ((await confirmRes.json()) as { item: PurchaseDetailDto }).item;
      expect(confirmed.status).toBe('P3');
      expect(confirmed.payableLedgerId).not.toBeNull();
      expect(confirmed.payableStatus).toBe('A1');
      expect(confirmed.scheduledPayAt).toBe('2026-07-31');

      // 2-4. P3 確定済み伝票の直接編集・削除は 409 ロック
      const lockedUpdRes = await putPurchaseRoute(
        buildJsonApiRequest(
          `http://localhost:3000/api/v1/purchases/${prePur.id}`,
          'PUT',
          staffToken,
          {
            purchaseName: '改竄試行',
            purchaseDate: '2026-06-15',
            supplierId: supplierAId,
            purchaseOrderId: null,
            honorific: '御中',
            status: 'P2',
            roundingMode: 'FLOOR',
            remarks: null,
            lines: [
              {
                projectId,
                productId: null,
                itemCode: null,
                itemName: '鋼材先行仕入',
                unitName: '式',
                isHeading: false,
                quantity: 1,
                taxCode: 'A',
                masterUnitPrice: 1000,
                appliedUnitPrice: 1000,
                remarks: null,
              },
            ],
          },
        ),
      );
      expect(lockedUpdRes.status).toBe(409);

      const lockedDelRes = await deletePurchaseRoute(
        buildJsonApiRequest(
          `http://localhost:3000/api/v1/purchases/${prePur.id}`,
          'DELETE',
          staffToken,
        ),
      );
      expect(lockedDelRes.status).toBe(409);

      // 2-5. 未払時の確定取消 (P3 -> P2 & payable_ledgers 削除)
      const cancelRes = await cancelPurchaseConfirmRoute(
        buildJsonApiRequest(
          `http://localhost:3000/api/v1/purchases/${prePur.id}/cancel-confirm`,
          'POST',
          staffToken,
        ),
      );
      expect(cancelRes.status).toBe(200);
      const canceled = ((await cancelRes.json()) as { item: PurchaseDetailDto }).item;
      expect(canceled.status).toBe('P2');
      expect(canceled.payableLedgerId).toBeNull();
      expect(canceled.payableStatus).toBeNull();
    } finally {
      spyCtx.mockRestore();
      vi.unstubAllEnvs();
    }
  });

  it('3. 旧Accessバグ②是正（買掛残高計算＆支払CRUD）検証：opening_ap_balance＋期間前/当期買掛＆複数支払控除一致・支払後P3取消409ブロック', async () => {
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
      // 仕入先B 期首買掛 = 100,000円 (2026-05-31時点)
      // 期間前 (6月): 買掛 55,000円, 複数回支払計 35,000円 -> 7/1時点繰越 = 120,000円
      const junPurRes = await postPurchasesRoute(
        buildJsonApiRequest('http://localhost:3000/api/v1/purchases', 'POST', staffToken, {
          purchaseName: '6月期資材仕入',
          purchaseDate: '2026-06-10',
          supplierId: supplierBId,
          purchaseOrderId: null,
          honorific: '御中',
          status: 'P3',
          roundingMode: 'FLOOR',
          remarks: null,
          lines: [
            {
              projectId,
              productId: null,
              itemCode: null,
              itemName: '6月資材',
              unitName: '式',
              isHeading: false,
              quantity: 1,
              taxCode: 'A',
              masterUnitPrice: 50000,
              appliedUnitPrice: 50000,
              remarks: null,
            },
          ],
        }),
      );
      expect(junPurRes.status).toBe(201);

      const junPay1 = await postSupplierPaymentsRoute(
        buildJsonApiRequest('http://localhost:3000/api/v1/payables/payments', 'POST', staffToken, {
          paymentDate: '2026-06-20',
          supplierId: supplierBId,
          methodCode1: 'B',
          amount1: 20000,
          billNo: null,
          summaryNote: '6月一部支払1',
        }),
      );
      expect(junPay1.status).toBe(201);

      const junPay2 = await postSupplierPaymentsRoute(
        buildJsonApiRequest('http://localhost:3000/api/v1/payables/payments', 'POST', staffToken, {
          paymentDate: '2026-06-28',
          supplierId: supplierBId,
          methodCode1: 'D',
          amount1: 14500,
          deductionCode1: 'G',
          deductionAmt1: 500,
          billNo: null,
          summaryNote: '6月一部支払2(手数料控除)',
        }),
      );
      expect(junPay2.status).toBe(201);

      // 基準日以前の支払 400 拒否
      const badPayRes = await postSupplierPaymentsRoute(
        buildJsonApiRequest('http://localhost:3000/api/v1/payables/payments', 'POST', staffToken, {
          paymentDate: '2026-05-31',
          supplierId: supplierBId,
          methodCode1: 'D',
          amount1: 1000,
        }),
      );
      expect(badPayRes.status).toBe(400);
      expect(((await badPayRes.json()) as { errorCode: string }).errorCode).toBe(
        'PAYMENT_DATE_BEFORE_CUTOFF',
      );

      // 基準日以前の買掛残高集計 400 拒否
      const badBalRes = await getPayableBalancesRoute(
        buildJsonApiRequest(
          'http://localhost:3000/api/v1/payables/balances?periodStart=2026-05-31&periodEnd=2026-06-30',
          'GET',
          staffToken,
        ),
      );
      expect(badBalRes.status).toBe(400);
      expect(((await badBalRes.json()) as { errorCode: string }).errorCode).toBe(
        'PERIOD_BEFORE_CUTOFF',
      );

      // 7月当期: 仕入確定 88,000円 (80,000 + 8,000)
      const julPurRes = await postPurchasesRoute(
        buildJsonApiRequest('http://localhost:3000/api/v1/purchases', 'POST', staffToken, {
          purchaseName: '7月期資材仕入',
          purchaseDate: '2026-07-10',
          supplierId: supplierBId,
          purchaseOrderId: null,
          honorific: '御中',
          status: 'P3',
          roundingMode: 'FLOOR',
          remarks: null,
          lines: [
            {
              projectId,
              productId: null,
              itemCode: null,
              itemName: '7月資材',
              unitName: '式',
              isHeading: false,
              quantity: 1,
              taxCode: 'A',
              masterUnitPrice: 80000,
              appliedUnitPrice: 80000,
              remarks: null,
            },
          ],
        }),
      );
      expect(julPurRes.status).toBe(201);
      const julPur = ((await julPurRes.json()) as { item: PurchaseDetailDto }).item;

      // 7月一部支払 40,000円（billNo 紐付）-> 買掛はまだ A1、確定取消は 409 ブロック
      const julPay1Res = await postSupplierPaymentsRoute(
        buildJsonApiRequest('http://localhost:3000/api/v1/payables/payments', 'POST', staffToken, {
          paymentDate: '2026-07-20',
          supplierId: supplierBId,
          methodCode1: 'D',
          amount1: 40000,
          billNo: String(julPur.purchaseNo),
          summaryNote: '7月分割支払1',
        }),
      );
      expect(julPay1Res.status).toBe(201);

      const ledAfter1Res = await getPayableLedgersRoute(
        buildJsonApiRequest(
          `http://localhost:3000/api/v1/payables/ledgers?supplierId=${supplierBId}`,
          'GET',
          staffToken,
        ),
      );
      const ledgers1 = ((await ledAfter1Res.json()) as { items: PayableLedgerItemDto[] }).items;
      const julLedger1 = ledgers1.find((l) => l.purchaseId === julPur.id);
      expect(julLedger1?.status).toBe('A1');
      expect(julLedger1?.paidAmount).toBe(40000);
      expect(julLedger1?.remainingAmount).toBe(48000);

      // 支払紐付後の P3 取消は 409 PAYABLE_ALREADY_SETTLED
      const blockedCancelRes = await cancelPurchaseConfirmRoute(
        buildJsonApiRequest(
          `http://localhost:3000/api/v1/purchases/${julPur.id}/cancel-confirm`,
          'POST',
          staffToken,
        ),
      );
      expect(blockedCancelRes.status).toBe(409);
      expect(((await blockedCancelRes.json()) as { errorCode: string }).errorCode).toBe(
        'PAYABLE_ALREADY_SETTLED',
      );

      // 7月完済支払 47,340円 + 振込手数料控除(G) 660円 = 48,000円 -> A2 へ自動同期
      const julPay2Res = await postSupplierPaymentsRoute(
        buildJsonApiRequest('http://localhost:3000/api/v1/payables/payments', 'POST', staffToken, {
          paymentDate: '2026-07-28',
          supplierId: supplierBId,
          methodCode1: 'D',
          amount1: 47340,
          deductionCode1: 'G',
          deductionAmt1: 660,
          billNo: String(julPur.purchaseNo),
          summaryNote: '7月完済支払2',
        }),
      );
      expect(julPay2Res.status).toBe(201);
      const julPay2 = ((await julPay2Res.json()) as { item: SupplierPaymentDto }).item;
      expect(julPay2.totalPayment).toBe(48000);

      const ledAfter2Res = await getPayableLedgersRoute(
        buildJsonApiRequest(
          `http://localhost:3000/api/v1/payables/ledgers?supplierId=${supplierBId}`,
          'GET',
          staffToken,
        ),
      );
      const julLedger2 = ((await ledAfter2Res.json()) as { items: PayableLedgerItemDto[] }).items.find(
        (l) => l.purchaseId === julPur.id,
      );
      expect(julLedger2?.status).toBe('A2');
      expect(julLedger2?.paidAmount).toBe(88000);
      expect(julLedger2?.remainingAmount).toBe(0);

      // 買掛残高一覧 [2026-07-01 .. 2026-07-31]:
      // 繰越 = 100,000 + 55,000 - 35,000 = 120,000
      // 当期仕入 = 80,000 (税8,000 / 税込88,000)
      // 当期支払 = 40,000 + 48,000 = 88,000
      // 当期末買掛残高 = 120,000 + 88,000 - 88,000 = 120,000
      const balRes = await getPayableBalancesRoute(
        buildJsonApiRequest(
          `http://localhost:3000/api/v1/payables/balances?periodStart=2026-07-01&periodEnd=2026-07-31&supplierId=${supplierBId}`,
          'GET',
          staffToken,
        ),
      );
      expect(balRes.status).toBe(200);
      const balData = (await balRes.json()) as PayableBalanceListResultDto;
      expect(balData.items.length).toBe(1);
      const row = balData.items[0]!;
      expect(row.prevCarriedBalance).toBe(120000);
      expect(row.periodPayableExcl).toBe(80000);
      expect(row.periodPayableTax).toBe(8000);
      expect(row.periodPayableIncl).toBe(88000);
      expect(row.periodPaymentAmount).toBe(88000);
      expect(row.periodNetDelta).toBe(0);
      expect(row.closingApBalance).toBe(120000);

      // 支払削除で A1 へ自動復帰する確認 & 再登録用編集も確認
      const delPay2Res = await deleteSupplierPaymentRoute(
        buildJsonApiRequest(
          `http://localhost:3000/api/v1/payables/payments/${julPay2.id}`,
          'DELETE',
          staffToken,
        ),
      );
      expect(delPay2Res.status).toBe(200);

      const ledAfterDelRes = await getPayableLedgersRoute(
        buildJsonApiRequest(
          `http://localhost:3000/api/v1/payables/ledgers?supplierId=${supplierBId}`,
          'GET',
          staffToken,
        ),
      );
      const julLedgerAfterDel = (
        (await ledAfterDelRes.json()) as { items: PayableLedgerItemDto[] }
      ).items.find((l) => l.purchaseId === julPur.id);
      expect(julLedgerAfterDel?.status).toBe('A1');
      expect(julLedgerAfterDel?.paidAmount).toBe(40000);

      // 支払1編集テスト（40,000 -> 45,000）
      const julPay1 = ((await julPay1Res.json()) as { item: SupplierPaymentDto }).item;
      const updPay1Res = await putSupplierPaymentRoute(
        buildJsonApiRequest(
          `http://localhost:3000/api/v1/payables/payments/${julPay1.id}`,
          'PUT',
          staffToken,
          {
            paymentDate: '2026-07-20',
            supplierId: supplierBId,
            methodCode1: 'D',
            amount1: 45000,
            billNo: String(julPur.purchaseNo),
            summaryNote: '7月分割支払1(改定)',
          },
        ),
      );
      expect(updPay1Res.status).toBe(200);
      expect(((await updPay1Res.json()) as { item: SupplierPaymentDto }).item.totalPayment).toBe(
        45000,
      );
    } finally {
      spyCtx.mockRestore();
      vi.unstubAllEnvs();
    }
  });

  it('4. 発注・仕入・買掛・支払一覧の CSV/PDF 出力 ＆ 機能フラグ OFF 時（order, purchase, payable, payment）403 制御検証', async () => {
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
      // 4-1. 発注一覧 CSV/PDF
      const poCsvRes = await exportPurchaseOrdersRoute(
        buildJsonApiRequest(
          'http://localhost:3000/api/v1/purchase-orders/export?format=csv',
          'GET',
          staffToken,
        ),
      );
      expect(poCsvRes.status).toBe(200);
      expect(await poCsvRes.text()).toContain('発注No');

      const poPdfRes = await exportPurchaseOrdersRoute(
        buildJsonApiRequest(
          'http://localhost:3000/api/v1/purchase-orders/export?format=pdf',
          'GET',
          staffToken,
        ),
      );
      expect(poPdfRes.status).toBe(200);
      expect((await PDFDocument.load(Buffer.from(await poPdfRes.arrayBuffer()))).getPageCount()).toBeGreaterThan(0);

      // 4-2. 仕入一覧 CSV/PDF
      const purCsvRes = await exportPurchasesRoute(
        buildJsonApiRequest(
          'http://localhost:3000/api/v1/purchases/export?format=csv',
          'GET',
          staffToken,
        ),
      );
      expect(purCsvRes.status).toBe(200);
      expect(await purCsvRes.text()).toContain('仕入No');

      const purPdfRes = await exportPurchasesRoute(
        buildJsonApiRequest(
          'http://localhost:3000/api/v1/purchases/export?format=pdf',
          'GET',
          staffToken,
        ),
      );
      expect(purPdfRes.status).toBe(200);
      expect((await PDFDocument.load(Buffer.from(await purPdfRes.arrayBuffer()))).getPageCount()).toBeGreaterThan(0);

      // 4-3. 買掛一覧 CSV/PDF
      const apCsvRes = await exportPayableBalancesRoute(
        buildJsonApiRequest(
          'http://localhost:3000/api/v1/payables/export?format=csv&periodStart=2026-07-01&periodEnd=2026-07-31',
          'GET',
          staffToken,
        ),
      );
      expect(apCsvRes.status).toBe(200);
      expect(await apCsvRes.text()).toContain('当期末買掛残高');

      const apPdfRes = await exportPayableBalancesRoute(
        buildJsonApiRequest(
          'http://localhost:3000/api/v1/payables/export?format=pdf&periodStart=2026-07-01&periodEnd=2026-07-31',
          'GET',
          staffToken,
        ),
      );
      expect(apPdfRes.status).toBe(200);
      expect((await PDFDocument.load(Buffer.from(await apPdfRes.arrayBuffer()))).getPageCount()).toBeGreaterThan(0);

      // 4-4. 支払一覧 CSV/PDF
      const spCsvRes = await exportSupplierPaymentsRoute(
        buildJsonApiRequest(
          'http://localhost:3000/api/v1/payables/payments/export?format=csv',
          'GET',
          staffToken,
        ),
      );
      expect(spCsvRes.status).toBe(200);
      expect(await spCsvRes.text()).toContain('支払No');

      const spPdfRes = await exportSupplierPaymentsRoute(
        buildJsonApiRequest(
          'http://localhost:3000/api/v1/payables/payments/export?format=pdf',
          'GET',
          staffToken,
        ),
      );
      expect(spPdfRes.status).toBe(200);
      expect((await PDFDocument.load(Buffer.from(await spPdfRes.arrayBuffer()))).getPageCount()).toBeGreaterThan(0);

      // 4-5. 機能フラグ OFF 時 403 検証
      await db.query(
        `UPDATE tenant_feature_authorities
            SET is_enabled = false
          WHERE tenant_id = $1
            AND feature_code IN ('order', 'purchase', 'payable', 'payment')`,
        [tenantId],
      );

      expect(
        (
          await getPurchaseOrdersRoute(
            buildJsonApiRequest('http://localhost:3000/api/v1/purchase-orders', 'GET', staffToken),
          )
        ).status,
      ).toBe(403);
      expect(
        (
          await getPurchasesRoute(
            buildJsonApiRequest('http://localhost:3000/api/v1/purchases', 'GET', staffToken),
          )
        ).status,
      ).toBe(403);
      expect(
        (
          await getPayableBalancesRoute(
            buildJsonApiRequest(
              'http://localhost:3000/api/v1/payables/balances',
              'GET',
              staffToken,
            ),
          )
        ).status,
      ).toBe(403);
      expect(
        (
          await getSupplierPaymentsRoute(
            buildJsonApiRequest(
              'http://localhost:3000/api/v1/payables/payments',
              'GET',
              staffToken,
            ),
          )
        ).status,
      ).toBe(403);
      expect(
        (
          await patchPayableLedgerRoute(
            buildJsonApiRequest('http://localhost:3000/api/v1/payables/ledgers', 'PATCH', staffToken, {
              ledgerId: '00000000-0000-0000-0000-000000000000',
              status: 'A2',
            }),
          )
        ).status,
      ).toBe(403);

      // 明細取得ルート未使用警告を回避するため 1 件参照も確認
      await db.query(
        `UPDATE tenant_feature_authorities
            SET is_enabled = true
          WHERE tenant_id = $1
            AND feature_code IN ('order', 'purchase', 'payable', 'payment')`,
        [tenantId],
      );
      expect(
        (
          await getPurchaseDetailRoute(
            buildJsonApiRequest(
              'http://localhost:3000/api/v1/purchases/00000000-0000-4000-8000-000000000000',
              'GET',
              staffToken,
            ),
          )
        ).status,
      ).toBe(404);
    } finally {
      await db.query(
        `UPDATE tenant_feature_authorities
            SET is_enabled = true
          WHERE tenant_id = $1
            AND feature_code IN ('order', 'purchase', 'payable', 'payment')`,
        [tenantId],
      );
      spyCtx.mockRestore();
      vi.unstubAllEnvs();
    }
  });
});
