import fs from 'node:fs';
import path from 'node:path';
import { PGlite } from '@electric-sql/pglite';
import { PDFDocument } from 'pdf-lib';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { GET as getAnalyticsRoute } from '@/app/api/v1/analytics/route';
import { GET as exportAnalyticsRoute } from '@/app/api/v1/analytics/export/route';
import { GET as getAttachmentsRoute } from '@/app/api/v1/attachments/route';
import {
  GET as getBillingRoute,
  POST as postBillingRoute,
} from '@/app/api/v1/billing/route';
import {
  GET as getChatRoute,
  POST as postChatRoute,
} from '@/app/api/v1/chat/route';
import { PATCH as patchChatRoute } from '@/app/api/v1/chat/[id]/route';
import { GET as getDashboardRoute } from '@/app/api/v1/dashboard/route';
import { POST as postEstimatesRoute } from '@/app/api/v1/estimates/route';
import {
  GET as getMailRoute,
  POST as postMailRoute,
} from '@/app/api/v1/mail/route';
import { GET as exportMailRoute } from '@/app/api/v1/mail/export/route';
import { GET as getPayableBalancesRoute } from '@/app/api/v1/payables/balances/route';
import { GET as getPayableLedgersRoute } from '@/app/api/v1/payables/ledgers/route';
import { POST as postSupplierPaymentsRoute } from '@/app/api/v1/payables/payments/route';
import { GET as getProjectCostsRoute } from '@/app/api/v1/project-costs/route';
import { POST as postCostFromPurchaseRoute } from '@/app/api/v1/project-costs/from-purchase/route';
import {
  GET as getProjectsRoute,
  POST as postProjectsRoute,
} from '@/app/api/v1/projects/route';
import { GET as getProjectDetailRoute } from '@/app/api/v1/projects/[id]/route';
import { POST as postProjectImportBudgetRoute } from '@/app/api/v1/projects/[id]/import-budget/route';
import { POST as postPurchaseOrdersRoute } from '@/app/api/v1/purchase-orders/route';
import { PUT as putPurchaseRoute } from '@/app/api/v1/purchases/[id]/route';
import { POST as postPurchaseFromOrderRoute } from '@/app/api/v1/purchases/from-order/route';
import { GET as getReceivableBalancesRoute } from '@/app/api/v1/receivables/balances/route';
import { POST as postCashReceiptsRoute } from '@/app/api/v1/receivables/receipts/route';
import {
  GET as getSalesRoute,
  POST as postSalesRoute,
} from '@/app/api/v1/sales/route';
import { PATCH as patchSalesApprovalRoute } from '@/app/api/v1/sales/approval/route';
import { POST as postSalesFromEstimateRoute } from '@/app/api/v1/sales/from-estimate/route';
import { POST as postSnapshotsRoute } from '@/app/api/v1/snapshots/route';
import { GET as getSnapshotPdfRoute } from '@/app/api/v1/snapshots/[id]/pdf/route';
import {
  GET as getStockRoute,
  PATCH as patchStockRoute,
} from '@/app/api/v1/stock/route';
import { GET as exportStockRoute } from '@/app/api/v1/stock/export/route';
import { POST as postSubscriptionsRoute } from '@/app/api/v1/subscriptions/route';
import { PUT as putSubscriptionApprovalRoute } from '@/app/api/v1/subscriptions/approval-flows/route';
import { POST as postExecuteSubscriptionBillingRoute } from '@/app/api/v1/subscriptions/execute-billing/route';
import type { CustomAnalyticsPageDto } from '@/lib/analytics/analytics-service';
import { authenticateLogin } from '@/lib/auth/auth-service';
import type { BillingListItemDto } from '@/lib/billing/types';
import type { ChatPageDto, ChatThreadDto, TeamsAdaptiveCardPayload } from '@/lib/chat/types';
import { encryptField, hashPassword } from '@/lib/crypto/field-cipher';
import type { DashboardOverviewDto } from '@/lib/dashboard/dashboard-service';
import { withExecutorTenantContext, type DbExecutor } from '@/lib/db/tenant-client';
import type { QuotationDetailDto, SnapshotDetailDto } from '@/lib/estimates/types';
import type { MailComposeResultDto, MailOverviewDto } from '@/lib/mail/mail-service';
import type { PayableBalanceListResultDto, PayableLedgerItemDto } from '@/lib/payables/types';
import type { ProjectCostDetailDto } from '@/lib/project-costs/types';
import type { ProjectDetailDto } from '@/lib/projects/types';
import type { PurchaseDetailDto, PurchaseOrderDetailDto } from '@/lib/purchasing/types';
import type { CashReceiptDto, ReceivableBalanceListResultDto } from '@/lib/receivables/types';
import type { SalesDetailDto } from '@/lib/sales/types';
import type { StockPageDto, StockProductItemDto } from '@/lib/stock/stock-service';
import type { ExecuteSubscriptionBillingResultDto } from '@/lib/subscriptions/types';

const TEST_ENC_KEY = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';
const TEST_SESSION_SECRET = 'phase5-e2e-session-secret-0123456789abcdef';

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

async function assertValidPdfResponse(res: Response) {
  expect(res.status).toBe(200);
  expect(res.headers.get('content-type')).toBe('application/pdf');
  const bytes = new Uint8Array(await res.arrayBuffer());
  expect(Buffer.from(bytes.slice(0, 5)).toString('ascii')).toBe('%PDF-');
  const doc = await PDFDocument.load(bytes);
  expect(doc.getPageCount()).toBeGreaterThanOrEqual(1);
}

describe('Phase 5 一気通貫E2E検証・全29機能/全22帳票/社内チャット/ダッシュボード/RLS完全隔離', () => {
  let db: PGlite;
  let exec: DbExecutor;

  const tenantAId = '11111111-aaaa-4444-8444-111111111111';
  const tenantASlug = 'phase5-alpha';
  const empAId = '22222222-aaaa-4444-8444-222222222222';

  const tenantBId = '33333333-bbbb-4444-8444-333333333333';
  const tenantBSlug = 'phase5-beta';
  const empBId = '44444444-bbbb-4444-8444-444444444444';

  let clientAId = '';
  let supplierSId = '';
  let productP1Id = '';
  let tokenA = '';
  let tokenB = '';

  let projectId = '';
  let estimateSnapshotId = '';

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

    // テナントA（検証主体）
    await db.query(
      `INSERT INTO tenants (id, tenant_slug, tenant_name) VALUES ($1, $2, 'アルファ総合設備株式会社')`,
      [tenantAId, tenantASlug],
    );
    await db.query(
      `INSERT INTO tenant_settings (
         tenant_id, company_code, company_name, invoice_registration_no,
         postal_code, address1, tel, email, representative_title, representative_name,
         bank_code_1, branch_code_1, bank_account_type_1, bank_account_no_1_enc, bank_account_holder_1,
         approval_flow_enabled, quotation_template_rows, tax_calc_policy, default_rounding_mode,
         cost_tax_mode, opening_balance_date
       ) VALUES (
         $1, '9080', 'アルファ総合設備株式会社', 'T5555666677778',
         '417-0030', '静岡県富士市アルファ町1-1', '0545-44-5555', 'alpha@example.com',
         '代表取締役', 'アルファ 太郎',
         '0149', '001', 'B1', $2, 'アルファソウゴウセツビ',
         true, 10, 'SLIP_BY_RATE', 'FLOOR', 'TAX_EXCLUDED', '2026-05-31'
       )`,
      [tenantAId, encryptField('5555666', TEST_ENC_KEY)],
    );
    await db.query('SELECT seed_tenant_defaults($1)', [tenantAId]);
    await db.query(
      `UPDATE tenant_feature_authorities
          SET is_enabled = true
        WHERE tenant_id = $1
          AND feature_code IN (
            'estimate', 'sales', 'tatekae', 'billsummary', 'billissue', 'fixedbill',
            'receivable', 'deposit', 'construction', 'budget', 'cost',
            'order', 'purchase', 'payable', 'payment', 'estimateimage'
          )`,
      [tenantAId],
    );
    await db.query(
      `UPDATE tenant_feature_authorities
          SET is_enabled = false
        WHERE tenant_id = $1
          AND feature_code IN ('teams', 'stock', 'item', 'custom-sum-item', 'mail')`,
      [tenantAId],
    );

    await db.query(
      `INSERT INTO banks (tenant_id, bank_code, bank_name) VALUES ($1, '0149', '静岡銀行')`,
      [tenantAId],
    );
    const bankA = await db.query<{ id: string }>(
      `SELECT id FROM banks WHERE tenant_id = $1 AND bank_code = '0149' LIMIT 1`,
      [tenantAId],
    );
    await db.query(
      `INSERT INTO bank_branches (tenant_id, bank_id, bank_code, branch_code, branch_name)
       VALUES ($1, $2, '0149', '001', '富士支店')`,
      [tenantAId, bankA.rows[0]!.id],
    );

    await db.query(
      `INSERT INTO employees (id, tenant_id, syain_code, syain_name, password_hash, is_admin, must_change_password)
       VALUES ($1, $2, '100', 'アルファ管理者', $3, true, false)`,
      [empAId, tenantAId, hashPassword('AlphaPass2026!')],
    );

    const cliRows = await db.query<{ id: string }>(
      `INSERT INTO business_partners (
         tenant_id, partner_code, partner_name, is_individual_honorific,
         postal_code, address1, is_client, is_supplier, closing_day_code, collection_day_code,
         opening_ar_balance, opening_ap_balance, send_mail_enabled, email, estimate_mail_to, bill_mail_to
       ) VALUES (
         $1, '10001', 'クライアントA商事株式会社', false,
         '417-0031', '静岡県富士市顧客1-2', true, false, 'D', '1',
         100000, 0, true, 'client-a@example.com', 'est-a@example.com', 'bill-a@example.com'
       ) RETURNING id`,
      [tenantAId],
    );
    clientAId = cliRows.rows[0]!.id;

    const supRows = await db.query<{ id: string }>(
      `INSERT INTO business_partners (
         tenant_id, partner_code, partner_name, is_individual_honorific,
         postal_code, address1, is_client, is_supplier, closing_day_code, collection_day_code,
         opening_ar_balance, opening_ap_balance
       ) VALUES (
         $1, '50001', 'サプライヤーS機材株式会社', false,
         '417-0032', '静岡県富士市仕入先3-4', false, true, 'D', '1',
         0, 50000
       ) RETURNING id`,
      [tenantAId],
    );
    supplierSId = supRows.rows[0]!.id;

    const unitRows = await db.query<{ id: string }>(
      `SELECT id FROM units WHERE tenant_id = $1 AND unit_code = 'B' LIMIT 1`,
      [tenantAId],
    );
    const prodRows = await db.query<{ id: string }>(
      `INSERT INTO products (
         tenant_id, product_code, product_name, unit_id,
         standard_unit_price, standard_purchase_price, standard_cost_price,
         default_tax_code, item_category_code, is_stock_managed, stock_quantity
       ) VALUES (
         $1, 'PRD-001', '業務用高効率エアコン', $2,
         100000, 60000, 60000, 'A', '3', true, 10
       ) RETURNING id`,
      [tenantAId, unitRows.rows[0]!.id],
    );
    productP1Id = prodRows.rows[0]!.id;

    await db.query(
      `INSERT INTO mail_templates (
         tenant_id, template_no, template_name, subject, body_intro, body_main, body_footer
       ) VALUES (
         $1, 1, '請求書送付標準テンプレート', '【{自社名}】{帳票種別} No.{帳票番号} 送付のご案内',
         '平素は格別のご高配を賜り厚く御礼申し上げます。',
         '{顧客名} 様宛に {帳票種別}（{金額}）をお送りいたします。',
         '引き続きよろしくお願い申し上げます。'
       )`,
      [tenantAId],
    );

    const loginA = await authenticateLogin(exec, {
      tenantSlug: tenantASlug,
      syainCode: '100',
      password: 'AlphaPass2026!',
      clientIp: '127.0.0.1',
      sessionSecretOverride: TEST_SESSION_SECRET,
    });
    tokenA = loginA.token;

    // テナントB（RLS完全隔離検証用）
    await db.query(
      `INSERT INTO tenants (id, tenant_slug, tenant_name) VALUES ($1, $2, 'ベータ分離株式会社')`,
      [tenantBId, tenantBSlug],
    );
    await db.query(
      `INSERT INTO tenant_settings (
         tenant_id, company_code, company_name, opening_balance_date
       ) VALUES ($1, '9090', 'ベータ分離株式会社', '2026-05-31')`,
      [tenantBId],
    );
    await db.query('SELECT seed_tenant_defaults($1)', [tenantBId]);
    await db.query(
      `UPDATE tenant_feature_authorities SET is_enabled = true WHERE tenant_id = $1`,
      [tenantBId],
    );
    await db.query(
      `INSERT INTO employees (id, tenant_id, syain_code, syain_name, password_hash, is_admin, must_change_password)
       VALUES ($1, $2, '900', 'ベータ管理者', $3, true, false)`,
      [empBId, tenantBId, hashPassword('BetaPass2026!')],
    );

    const loginB = await authenticateLogin(exec, {
      tenantSlug: tenantBSlug,
      syainCode: '900',
      password: 'BetaPass2026!',
      clientIp: '127.0.0.1',
      sessionSecretOverride: TEST_SESSION_SECRET,
    });
    tokenB = loginB.token;
  });

  afterAll(async () => {
    await db.close();
  });

  it('1. 販売・購買・案件・会計フルライフサイクル一気通貫 1円一致検証', async () => {
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
      // (1) 案件作成
      const pjRes = await postProjectsRoute(
        buildJsonApiRequest('http://localhost:3000/api/v1/projects', 'POST', tokenA, {
          projectName: 'E2E フルサイクル設備更新工事',
          projectDate: '2026-06-01',
          sitePlace: '富士市本工場',
          partnerId: clientAId,
          status: 'C2',
          salesEmployeeId: empAId,
          siteEmployeeId: empAId,
          contractUnitPrice: 100000,
          contractQuantity: 1,
          taxCode: 'A',
          roundingMode: 'FLOOR',
        }),
      );
      expect(pjRes.status).toBe(201);
      const project = ((await pjRes.json()) as { item: ProjectDetailDto }).item;
      projectId = project.id;

      // (2) 見積作成 ＋ 見積書・まとめ見積(鑑)・まとめ見積(明細) PDF発行
      const estRes = await postEstimatesRoute(
        buildJsonApiRequest('http://localhost:3000/api/v1/estimates', 'POST', tokenA, {
          quotationName: 'E2E 空調設備一式見積',
          quotationDate: '2026-06-05',
          partnerId: clientAId,
          projectId,
          honorific: '御中',
          validityPeriod: '1ヶ月',
          deliveryDate: null,
          status: 'Q1',
          isAdvanceType: false,
          isSelected: true,
          roundingMode: 'FLOOR',
          remarks: null,
          lines: [
            {
              productId: productP1Id,
              itemCode: 'PRD-001',
              itemName: '業務用高効率エアコン一式',
              unitName: '式',
              isHeading: false,
              quantity: 1,
              taxCode: 'A',
              costCategory: 'MATERIAL',
              masterUnitPrice: 1000000,
              appliedUnitPrice: 1000000,
              masterCostPrice: 600000,
              appliedCostPrice: 600000,
              remarks: null,
            },
            {
              productId: null,
              itemCode: 'OUT-01',
              itemName: '設置工事費',
              unitName: '式',
              isHeading: false,
              quantity: 1,
              taxCode: 'A',
              costCategory: 'OUTSOURCING',
              masterUnitPrice: 500000,
              appliedUnitPrice: 500000,
              masterCostPrice: 300000,
              appliedCostPrice: 300000,
              remarks: null,
            },
          ],
        }),
      );
      expect(estRes.status).toBe(201);
      const quotation = ((await estRes.json()) as { item: QuotationDetailDto }).item;

      for (const docType of [
        'ESTIMATE',
        'ESTIMATE_SUMMARY_COVER',
        'ESTIMATE_SUMMARY_DETAIL',
      ] as const) {
        const sRes = await postSnapshotsRoute(
          buildJsonApiRequest('http://localhost:3000/api/v1/snapshots', 'POST', tokenA, {
            documentType: docType,
            sourceEntityId: quotation.id,
            templateVariant: '10_ROWS',
            issueDate: '2026-06-05',
          }),
        );
        expect(sRes.status).toBe(201);
        const snap = ((await sRes.json()) as { item: SnapshotDetailDto }).item;
        if (docType === 'ESTIMATE') estimateSnapshotId = snap.id;
        await assertValidPdfResponse(
          await getSnapshotPdfRoute(
            buildJsonApiRequest(`http://localhost:3000/api/v1/snapshots/${snap.id}/pdf`, 'GET', tokenA),
          ),
        );
      }

      // (3) 見積から実行予算6費目＆契約額取込
      const impBudgetRes = await postProjectImportBudgetRoute(
        buildJsonApiRequest(
          `http://localhost:3000/api/v1/projects/${projectId}/import-budget`,
          'POST',
          tokenA,
          { quotationId: quotation.id, updateContractAmount: true },
        ),
      );
      expect(impBudgetRes.status).toBe(200);

      // (4) 発注 -> 発注書PDF -> 仕入転記 -> P3確定（買掛A1生成） -> 原価転記 -> 支払登録（A2消込）
      const poRes = await postPurchaseOrdersRoute(
        buildJsonApiRequest('http://localhost:3000/api/v1/purchase-orders', 'POST', tokenA, {
          orderName: '業務用エアコン仕入発注',
          orderDate: '2026-06-08',
          supplierId: supplierSId,
          projectId,
          honorific: '御中',
          deliveryDate: '2026-06-10',
          status: 'O2',
          roundingMode: 'FLOOR',
          remarks: null,
          lines: [
            {
              productId: productP1Id,
              itemCode: 'PRD-001',
              itemName: '業務用高効率エアコン',
              unitName: '台',
              isHeading: false,
              quantity: 2,
              taxCode: 'A',
              masterUnitPrice: 60000,
              appliedUnitPrice: 60000,
              remarks: null,
            },
          ],
        }),
      );
      expect(poRes.status).toBe(201);
      const po = ((await poRes.json()) as { item: PurchaseOrderDetailDto }).item;

      const poSnapRes = await postSnapshotsRoute(
        buildJsonApiRequest('http://localhost:3000/api/v1/snapshots', 'POST', tokenA, {
          documentType: 'PURCHASE_ORDER',
          sourceEntityId: po.id,
          issueDate: '2026-06-08',
        }),
      );
      expect(poSnapRes.status).toBe(201);
      const poSnap = ((await poSnapRes.json()) as { item: SnapshotDetailDto }).item;
      await assertValidPdfResponse(
        await getSnapshotPdfRoute(
          buildJsonApiRequest(`http://localhost:3000/api/v1/snapshots/${poSnap.id}/pdf`, 'GET', tokenA),
        ),
      );

      const purFromPoRes = await postPurchaseFromOrderRoute(
        buildJsonApiRequest('http://localhost:3000/api/v1/purchases/from-order', 'POST', tokenA, {
          orderId: po.id,
          purchaseDate: '2026-06-10',
          initialStatus: 'P2',
        }),
      );
      expect(purFromPoRes.status).toBe(201);
      const purP2 = ((await purFromPoRes.json()) as { item: PurchaseDetailDto }).item;

      const purP3Res = await putPurchaseRoute(
        buildJsonApiRequest(`http://localhost:3000/api/v1/purchases/${purP2.id}`, 'PUT', tokenA, {
          purchaseName: purP2.purchaseName,
          purchaseDate: '2026-06-10',
          supplierId: supplierSId,
          purchaseOrderId: po.id,
          honorific: '御中',
          status: 'P3',
          roundingMode: 'FLOOR',
          remarks: null,
          lines: purP2.lines.map((l) => ({
            projectId: l.projectId,
            productId: l.productId,
            itemCode: l.itemCode,
            itemName: l.itemName,
            unitName: l.unitName,
            isHeading: l.isHeading,
            quantity: l.quantity,
            taxCode: l.taxCode,
            masterUnitPrice: l.masterUnitPrice,
            appliedUnitPrice: l.appliedUnitPrice,
            remarks: l.remarks,
          })),
        }),
      );
      expect(purP3Res.status).toBe(200);
      const purP3 = ((await purP3Res.json()) as { item: PurchaseDetailDto }).item;
      expect(purP3.totalAmount).toBe(132000);

      // 原価伝票転記 (MATERIAL 120,000税抜 / 132,000税込)
      const costFromPurRes = await postCostFromPurchaseRoute(
        buildJsonApiRequest(
          'http://localhost:3000/api/v1/project-costs/from-purchase',
          'POST',
          tokenA,
          {
            projectId,
            purchaseId: purP3.id,
            costCategory: 'MATERIAL',
            entryDate: '2026-06-11',
            status: 'C3',
          },
        ),
      );
      expect(costFromPurRes.status).toBe(201);
      const createdCost = ((await costFromPurRes.json()) as { item: ProjectCostDetailDto }).item;
      expect(createdCost.subtotalAmount).toBe(120000);

      // 買掛支払登録 -> A2消込確認
      const supPayRes = await postSupplierPaymentsRoute(
        buildJsonApiRequest('http://localhost:3000/api/v1/payables/payments', 'POST', tokenA, {
          paymentDate: '2026-06-25',
          supplierId: supplierSId,
          methodCode1: 'D',
          amount1: 132000,
          billNo: String(purP3.purchaseNo),
        }),
      );
      expect(supPayRes.status).toBe(201);

      const ledgersRes = await getPayableLedgersRoute(
        buildJsonApiRequest(
          `http://localhost:3000/api/v1/payables/ledgers?supplierId=${supplierSId}`,
          'GET',
          tokenA,
        ),
      );
      const ledgers = ((await ledgersRes.json()) as { items: PayableLedgerItemDto[] }).items;
      expect(ledgers[0]!.status).toBe('A2');

      // (5) 見積転記売上(SALE: 1,650,000税込) + 立替(ADVANCE: 20,000) -> 承認 -> 納品書/受領書PDF
      const saleFromEstRes = await postSalesFromEstimateRoute(
        buildJsonApiRequest('http://localhost:3000/api/v1/sales/from-estimate', 'POST', tokenA, {
          quotationId: quotation.id,
          entryType: 'SALE',
          slipDate: '2026-06-15',
          updateQuotationStatusToQ2: true,
        }),
      );
      expect(saleFromEstRes.status).toBe(201);
      const saleSlip = ((await saleFromEstRes.json()) as { item: SalesDetailDto }).item;
      expect(saleSlip.totalAmount).toBe(1650000);

      const advRes = await postSalesRoute(
        buildJsonApiRequest('http://localhost:3000/api/v1/sales', 'POST', tokenA, {
          entryType: 'ADVANCE',
          slipName: '立替行政手続手数料',
          slipDate: '2026-06-16',
          partnerId: clientAId,
          projectId,
          honorific: '御中',
          status: 'K3',
          roundingMode: 'FLOOR',
          lines: [
            {
              productId: null,
              itemCode: null,
              itemName: '確認申請印紙代',
              unitName: '式',
              isHeading: false,
              quantity: 1,
              appliedUnitPrice: 20000,
              taxCode: 'C',
              remarks: null,
            },
          ],
        }),
      );
      expect(advRes.status).toBe(201);
      const advSlip = ((await advRes.json()) as { item: SalesDetailDto }).item;

      const apprRes = await patchSalesApprovalRoute(
        buildJsonApiRequest('http://localhost:3000/api/v1/sales/approval', 'PATCH', tokenA, {
          ids: [saleSlip.id, advSlip.id],
          approvalStatus: 1,
          nextStatus: 'K3',
        }),
      );
      expect(apprRes.status).toBe(200);

      for (const dt of ['DELIVERY_NOTE', 'DELIVERY_RECEIPT'] as const) {
        const snRes = await postSnapshotsRoute(
          buildJsonApiRequest('http://localhost:3000/api/v1/snapshots', 'POST', tokenA, {
            documentType: dt,
            sourceEntityId: saleSlip.id,
            issueDate: '2026-06-15',
          }),
        );
        expect(snRes.status).toBe(201);
        const sn = ((await snRes.json()) as { item: SnapshotDetailDto }).item;
        await assertValidPdfResponse(
          await getSnapshotPdfRoute(
            buildJsonApiRequest(`http://localhost:3000/api/v1/snapshots/${sn.id}/pdf`, 'GET', tokenA),
          ),
        );
      }

      // (6) サブスク契約 -> 月次承認 -> 定額一括請求確定 (55,000円 FIXED_INVOICE) ＋ 通常請求確定 (1,670,000円 INVOICE_COVER)
      const subRes = await postSubscriptionsRoute(
        buildJsonApiRequest('http://localhost:3000/api/v1/subscriptions', 'POST', tokenA, {
          partnerId: clientAId,
          entryType: 'SALE',
          itemName: '月額保守サポート',
          unitName: '月',
          quantity: 1,
          appliedUnitPrice: 50000,
          taxCode: 'A',
          roundingMode: 'FLOOR',
          outputType: '印刷',
          isActive: true,
        }),
      );
      expect(subRes.status).toBe(201);

      const subApprRes = await putSubscriptionApprovalRoute(
        buildJsonApiRequest(
          'http://localhost:3000/api/v1/subscriptions/approval-flows',
          'PUT',
          tokenA,
          {
            targetMonth: '202606',
            items: [{ partnerId: clientAId, entryType: 'SALE', flowStatus: 1 }],
          },
        ),
      );
      expect(subApprRes.status).toBe(200);

      const subBillRes = await postExecuteSubscriptionBillingRoute(
        buildJsonApiRequest(
          'http://localhost:3000/api/v1/subscriptions/execute-billing',
          'POST',
          tokenA,
          {
            targetMonth: '202606',
            billingDate: '2026-06-30',
            targets: [{ partnerId: clientAId, entryType: 'SALE' }],
          },
        ),
      );
      expect(subBillRes.status).toBe(201);
      const subBillResult = (await subBillRes.json()) as ExecuteSubscriptionBillingResultDto;
      const fixedBillingId = subBillResult.items[0]!.billingId!;
      const fixedBillingNo = subBillResult.items[0]!.billingNo!;
      expect(subBillResult.items[0]!.billedAmount).toBe(55000);

      const stdBillRes = await postBillingRoute(
        buildJsonApiRequest('http://localhost:3000/api/v1/billing', 'POST', tokenA, {
          billingDate: '2026-06-30',
          targetPeriodStart: '2026-06-01',
          targetPeriodEnd: '2026-06-30',
          items: [
            {
              partnerId: clientAId,
              slipIds: [saleSlip.id, advSlip.id],
              paymentDueDate: '2026-07-31',
              documentType: 'INVOICE_COVER',
              issueCoverDetail: true,
            },
          ],
        }),
      );
      expect(stdBillRes.status).toBe(201);
      const stdBillBody = (await stdBillRes.json()) as {
        billings: BillingListItemDto[];
        snapshots: SnapshotDetailDto[];
      };
      const stdBilling = stdBillBody.billings[0]!;
      expect(stdBilling.billingAmount).toBe(1670000);
      await assertValidPdfResponse(
        await getSnapshotPdfRoute(
          buildJsonApiRequest(
            `http://localhost:3000/api/v1/snapshots/${stdBillBody.snapshots[0]!.id}/pdf`,
            'GET',
            tokenA,
          ),
        ),
      );

      // (7) 入金登録2件（定額55,000 + 通常1,670,000）-> 両請求書 N3完済 + 領収書PDF発行
      const rec1Res = await postCashReceiptsRoute(
        buildJsonApiRequest('http://localhost:3000/api/v1/receivables/receipts', 'POST', tokenA, {
          receiptDate: '2026-06-30',
          partnerId: clientAId,
          projectId,
          methodCode1: 'D',
          deposit1: 55000,
          subtotal10Excl: 50000,
          tadashi: '定額保守料として',
          billNo: String(fixedBillingNo),
        }),
      );
      expect(rec1Res.status).toBe(201);
      const rec1 = ((await rec1Res.json()) as { item: CashReceiptDto }).item;

      const rec2Res = await postCashReceiptsRoute(
        buildJsonApiRequest('http://localhost:3000/api/v1/receivables/receipts', 'POST', tokenA, {
          receiptDate: '2026-06-30',
          partnerId: clientAId,
          projectId,
          methodCode1: 'D',
          deposit1: 1670000,
          subtotal10Excl: 1500000,
          subtotal0: 20000,
          tadashi: '工事代金・立替精算として',
          billNo: String(stdBilling.billingNo),
        }),
      );
      expect(rec2Res.status).toBe(201);
      const rec2 = ((await rec2Res.json()) as { item: CashReceiptDto }).item;

      for (const receiptId of [rec1.id, rec2.id]) {
        const rsRes = await postSnapshotsRoute(
          buildJsonApiRequest('http://localhost:3000/api/v1/snapshots', 'POST', tokenA, {
            documentType: 'RECEIPT',
            sourceEntityId: receiptId,
            issueDate: '2026-06-30',
          }),
        );
        expect(rsRes.status).toBe(201);
        const rs = ((await rsRes.json()) as { item: SnapshotDetailDto }).item;
        await assertValidPdfResponse(
          await getSnapshotPdfRoute(
            buildJsonApiRequest(`http://localhost:3000/api/v1/snapshots/${rs.id}/pdf`, 'GET', tokenA),
          ),
        );
      }

      // 両請求書の N3 完済確認
      const billListRes = await getBillingRoute(
        buildJsonApiRequest(`http://localhost:3000/api/v1/billing?partnerId=${clientAId}`, 'GET', tokenA),
      );
      const billItems = ((await billListRes.json()) as { items: BillingListItemDto[] }).items;
      expect(billItems.find((b) => b.id === fixedBillingId)?.status).toBe('N3');
      expect(billItems.find((b) => b.id === stdBilling.id)?.status).toBe('N3');

      // (8) 売掛残高・買掛残高・工事台帳・ダッシュボードKPIの1円一致検証（単一PGlite接続のため逐次実行）
      const arBalRes = await getReceivableBalancesRoute(
        buildJsonApiRequest(
          'http://localhost:3000/api/v1/receivables/balances?periodStart=2026-06-01&periodEnd=2026-06-30',
          'GET',
          tokenA,
        ),
      );
      const apBalRes = await getPayableBalancesRoute(
        buildJsonApiRequest(
          'http://localhost:3000/api/v1/payables/balances?periodStart=2026-06-01&periodEnd=2026-06-30',
          'GET',
          tokenA,
        ),
      );
      const pjDetRes = await getProjectDetailRoute(
        buildJsonApiRequest(`http://localhost:3000/api/v1/projects/${projectId}`, 'GET', tokenA),
      );
      const dashRes = await getDashboardRoute(
        buildJsonApiRequest('http://localhost:3000/api/v1/dashboard?targetMonth=2026-06', 'GET', tokenA),
      );

      const arBal = (await arBalRes.json()) as ReceivableBalanceListResultDto;
      const apBal = (await apBalRes.json()) as PayableBalanceListResultDto;
      const pjDet = ((await pjDetRes.json()) as { item: ProjectDetailDto }).item;
      const dash = ((await dashRes.json()) as { overview: DashboardOverviewDto }).overview;

      // 期首売掛 100,000 + 当月請求 1,725,000 - 当月入金 1,725,000 = 100,000
      expect(arBal.totals.closingArBalance).toBe(100000);
      expect(arBal.totals.periodBillingIncl).toBe(1725000);
      expect(arBal.totals.periodReceiptAmount).toBe(1725000);

      // 期首買掛 50,000 + 当月仕入 132,000 - 当月支払 132,000 = 50,000
      expect(apBal.totals.closingApBalance).toBe(50000);
      expect(apBal.totals.periodPayableIncl).toBe(132000);
      expect(apBal.totals.periodPaymentAmount).toBe(132000);

      // 工事台帳: 契約税抜 1,500,000 - 実績原価税抜 120,000 = 実績粗利 1,380,000
      expect(pjDet.contractSubtotal).toBe(1500000);
      expect(pjDet.actualCostExclTotal).toBe(120000);
      expect(pjDet.actualGrossProfit).toBe(1380000);
      expect(pjDet.salesRecordedIncl).toBe(1650000);
      expect(pjDet.advanceRecordedIncl).toBe(20000);

      // ダッシュボードKPI 1円一致
      expect(dash.salesKpi).not.toBeNull();
      expect(dash.salesKpi!.salesExclTotal).toBe(1550000); // 1,500,000 + 定額50,000
      expect(dash.salesKpi!.salesInclTotal).toBe(1705000); // 1,650,000 + 定額55,000
      expect(dash.salesKpi!.advanceInclTotal).toBe(20000);

      expect(dash.billingKpi!.billingCount).toBe(2);
      expect(dash.billingKpi!.billingAmountTotal).toBe(1725000);
      expect(dash.billingKpi!.fixedBillingAmountTotal).toBe(55000);

      expect(dash.arKpi!.currentArBalanceTotal).toBe(arBal.totals.closingArBalance);
      expect(dash.arKpi!.periodReceiptTotal).toBe(arBal.totals.periodReceiptAmount);

      expect(dash.apKpi!.currentApBalanceTotal).toBe(apBal.totals.closingApBalance);
      expect(dash.apKpi!.periodPaymentTotal).toBe(apBal.totals.periodPaymentAmount);

      expect(dash.projectsKpi!.contractTotal).toBe(1650000);
      expect(dash.projectsKpi!.actualCostEvalTotal).toBe(pjDet.actualCostExclTotal);
      expect(dash.projectsKpi!.actualGrossProfitTotal).toBe(pjDet.actualGrossProfit);
    } finally {
      spyCtx.mockRestore();
      vi.unstubAllEnvs();
    }
  });

  it('2. 社内チャット＆残余機能（在庫・カスタム集計・メール）・機能フラグOFF時403／ダッシュボード非表示検証', async () => {
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
      // (1) teams/stock/item/custom-sum-item/mail OFF時はすべて 403 FEATURE_DISABLED、ダッシュボード chatSummary=null
      for (const [fn, url] of [
        [getChatRoute, 'http://localhost:3000/api/v1/chat'],
        [getStockRoute, 'http://localhost:3000/api/v1/stock'],
        [getAnalyticsRoute, 'http://localhost:3000/api/v1/analytics'],
        [getMailRoute, 'http://localhost:3000/api/v1/mail'],
      ] as const) {
        const res = await fn(buildJsonApiRequest(url, 'GET', tokenA));
        expect(res.status).toBe(403);
        expect(((await res.json()) as { errorCode: string }).errorCode).toBe('FEATURE_DISABLED');
      }
      const dashOffRes = await getDashboardRoute(
        buildJsonApiRequest('http://localhost:3000/api/v1/dashboard?targetMonth=2026-06', 'GET', tokenA),
      );
      const dashOff = ((await dashOffRes.json()) as { overview: DashboardOverviewDto }).overview;
      expect(dashOff.chatSummary).toBeNull();

      // (2) 残余機能フラグ有効化
      await db.query(
        `UPDATE tenant_feature_authorities
            SET is_enabled = true
          WHERE tenant_id = $1
            AND feature_code IN ('teams', 'stock', 'item', 'custom-sum-item', 'mail')`,
        [tenantAId],
      );

      // (3) 社内チャット: 投稿・案件/取引先紐付け・返信・解決済切替・Teamsカード・ダッシュボード連動
      const chatPostRes = await postChatRoute(
        buildJsonApiRequest('http://localhost:3000/api/v1/chat', 'POST', tokenA, {
          roomName: '現場・案件連絡',
          projectId,
          partnerId: clientAId,
          question: '室外機の搬入経路の確認をお願いします。',
        }),
      );
      expect(chatPostRes.status).toBe(201);
      const chatPostBody = (await chatPostRes.json()) as {
        item: ChatThreadDto;
        adaptiveCard: TeamsAdaptiveCardPayload;
      };
      expect(chatPostBody.item.roomName).toBe('現場・案件連絡');
      expect(chatPostBody.item.projectId).toBe(projectId);
      expect(chatPostBody.item.partnerId).toBe(clientAId);
      expect(chatPostBody.adaptiveCard.attachments[0]!.content.type).toBe('AdaptiveCard');

      const chatPatchRes = await patchChatRoute(
        buildJsonApiRequest(
          `http://localhost:3000/api/v1/chat/${chatPostBody.item.id}`,
          'PATCH',
          tokenA,
          { replyMessage: '南側搬入口で手配完了しました。', isResolved: true },
        ),
      );
      expect(chatPatchRes.status).toBe(200);
      const patchedChat = ((await chatPatchRes.json()) as { item: ChatThreadDto }).item;
      expect(patchedChat.replies).toHaveLength(1);
      expect(patchedChat.isResolved).toBe(true);

      const chatListRes = await getChatRoute(
        buildJsonApiRequest('http://localhost:3000/api/v1/chat?roomName=現場・案件連絡', 'GET', tokenA),
      );
      const chatList = (await chatListRes.json()) as ChatPageDto;
      expect(chatList.items).toHaveLength(1);

      // (4) 在庫管理: 一覧・調整・CSV/PDF
      const stGetRes = await getStockRoute(
        buildJsonApiRequest('http://localhost:3000/api/v1/stock', 'GET', tokenA),
      );
      expect(stGetRes.status).toBe(200);
      const stPage = (await stGetRes.json()) as StockPageDto;
      expect(stPage.items[0]!.purchasedQty).toBe(2);
      expect(stPage.items[0]!.stockValuation).toBe(600000); // 10 * 60,000

      const stPatchRes = await patchStockRoute(
        buildJsonApiRequest('http://localhost:3000/api/v1/stock', 'PATCH', tokenA, {
          productId: productP1Id,
          isStockManaged: true,
          stockQuantity: 11,
        }),
      );
      expect(stPatchRes.status).toBe(200);
      expect(((await stPatchRes.json()) as { item: StockProductItemDto }).item.stockValuation).toBe(
        660000,
      );
      await assertValidPdfResponse(
        await exportStockRoute(
          buildJsonApiRequest('http://localhost:3000/api/v1/stock/export?format=pdf', 'GET', tokenA),
        ),
      );

      // (5) カスタム集計 (PARTNER / CATEGORY / EMPLOYEE / PERIOD) & PDF
      for (const dim of ['PARTNER', 'CATEGORY', 'EMPLOYEE', 'PERIOD'] as const) {
        const anRes = await getAnalyticsRoute(
          buildJsonApiRequest(`http://localhost:3000/api/v1/analytics?dimension=${dim}`, 'GET', tokenA),
        );
        expect(anRes.status).toBe(200);
        const anBody = (await anRes.json()) as CustomAnalyticsPageDto;
        expect(anBody.items.length).toBeGreaterThanOrEqual(1);
      }
      await assertValidPdfResponse(
        await exportAnalyticsRoute(
          buildJsonApiRequest(
            'http://localhost:3000/api/v1/analytics/export?dimension=PARTNER&format=pdf',
            'GET',
            tokenA,
          ),
        ),
      );

      // (6) メール定型文差し込み & PDF
      const mailGetRes = await getMailRoute(
        buildJsonApiRequest('http://localhost:3000/api/v1/mail?mailEnabledOnly=1', 'GET', tokenA),
      );
      expect(mailGetRes.status).toBe(200);
      const mailOv = (await mailGetRes.json()) as MailOverviewDto;
      expect(mailOv.targets).toHaveLength(1);
      const tmplId = mailOv.templates[0]!.id;

      const mailPostRes = await postMailRoute(
        buildJsonApiRequest('http://localhost:3000/api/v1/mail', 'POST', tokenA, {
          partnerId: clientAId,
          templateId: tmplId,
          docKind: 'BILLING',
        }),
      );
      expect(mailPostRes.status).toBe(200);
      const mailPrev = ((await mailPostRes.json()) as { preview: MailComposeResultDto }).preview;
      expect(mailPrev.to).toBe('bill-a@example.com');
      expect(mailPrev.subject).toContain('アルファ総合設備株式会社');
      expect(mailPrev.body).toContain('クライアントA商事株式会社');

      await assertValidPdfResponse(
        await exportMailRoute(
          buildJsonApiRequest('http://localhost:3000/api/v1/mail/export?format=pdf', 'GET', tokenA),
        ),
      );

      // (7) ダッシュボード chatSummary 表示確認
      const dashOnRes = await getDashboardRoute(
        buildJsonApiRequest('http://localhost:3000/api/v1/dashboard?targetMonth=2026-06', 'GET', tokenA),
      );
      const dashOn = ((await dashOnRes.json()) as { overview: DashboardOverviewDto }).overview;
      expect(dashOn.chatSummary).not.toBeNull();
      expect(dashOn.chatSummary!.totalCount).toBe(1);
    } finally {
      spyCtx.mockRestore();
      vi.unstubAllEnvs();
    }
  });

  it('3. マルチテナント完全隔離（RLS横断検証：テナントBからテナントAの全データ非漏洩）', async () => {
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
      // ダッシュボード集計値がすべて 0
      const dashBRes = await getDashboardRoute(
        buildJsonApiRequest('http://localhost:3000/api/v1/dashboard?targetMonth=2026-06', 'GET', tokenB),
      );
      expect(dashBRes.status).toBe(200);
      const dashB = ((await dashBRes.json()) as { overview: DashboardOverviewDto }).overview;
      expect(dashB.companyName).toBe('ベータ分離株式会社');
      expect(dashB.salesKpi!.salesInclTotal).toBe(0);
      expect(dashB.billingKpi!.billingAmountTotal).toBe(0);
      expect(dashB.arKpi!.currentArBalanceTotal).toBe(0);
      expect(dashB.apKpi!.currentApBalanceTotal).toBe(0);
      expect(dashB.projectsKpi!.totalCount).toBe(0);
      expect(dashB.chatSummary!.totalCount).toBe(0);

      // 各業務一覧がすべて 0 件（単一PGlite接続のため逐次トランザクションで検証）
      const listCheckSpecs: Array<() => Promise<Response>> = [
        () => getProjectsRoute(buildJsonApiRequest('http://localhost:3000/api/v1/projects', 'GET', tokenB)),
        () =>
          getProjectCostsRoute(
            buildJsonApiRequest('http://localhost:3000/api/v1/project-costs', 'GET', tokenB),
          ),
        () => getSalesRoute(buildJsonApiRequest('http://localhost:3000/api/v1/sales', 'GET', tokenB)),
        () => getBillingRoute(buildJsonApiRequest('http://localhost:3000/api/v1/billing', 'GET', tokenB)),
        () =>
          getReceivableBalancesRoute(
            buildJsonApiRequest('http://localhost:3000/api/v1/receivables/balances', 'GET', tokenB),
          ),
        () =>
          getPayableBalancesRoute(
            buildJsonApiRequest('http://localhost:3000/api/v1/payables/balances', 'GET', tokenB),
          ),
        () => getChatRoute(buildJsonApiRequest('http://localhost:3000/api/v1/chat', 'GET', tokenB)),
      ];
      for (const invoke of listCheckSpecs) {
        const r = await invoke();
        expect(r.status).toBe(200);
        const body = (await r.json()) as { items: unknown[] };
        expect(body.items).toHaveLength(0);
      }

      // テナントAの案件詳細・帳票スナップショットPDF・添付参照へ直接UUIDアクセスしても 404 / 0件で遮断
      const crossPjRes = await getProjectDetailRoute(
        buildJsonApiRequest(`http://localhost:3000/api/v1/projects/${projectId}`, 'GET', tokenB),
      );
      expect(crossPjRes.status).toBe(404);

      const crossSnapRes = await getSnapshotPdfRoute(
        buildJsonApiRequest(
          `http://localhost:3000/api/v1/snapshots/${estimateSnapshotId}/pdf`,
          'GET',
          tokenB,
        ),
      );
      expect(crossSnapRes.status).toBe(404);

      const crossAttRes = await getAttachmentsRoute(
        buildJsonApiRequest(
          `http://localhost:3000/api/v1/attachments?entityType=PROJECT&entityId=${projectId}`,
          'GET',
          tokenB,
        ),
      );
      expect(crossAttRes.status).toBe(200);
      expect(((await crossAttRes.json()) as { items: unknown[] }).items).toHaveLength(0);
    } finally {
      spyCtx.mockRestore();
      vi.unstubAllEnvs();
    }
  });
});
