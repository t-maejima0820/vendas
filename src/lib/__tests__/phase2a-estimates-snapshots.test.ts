import fs from 'node:fs';
import path from 'node:path';
import { PGlite } from '@electric-sql/pglite';
import { PDFDocument } from 'pdf-lib';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { GET as getAttachmentsRoute, POST as postAttachmentRoute } from '@/app/api/v1/attachments/route';
import {
  DELETE as deleteAttachmentRoute,
  PATCH as patchAttachmentRoute,
} from '@/app/api/v1/attachments/[id]/route';
import { GET as getEstimatesRoute, POST as postEstimatesRoute } from '@/app/api/v1/estimates/route';
import { GET as exportEstimatesRoute } from '@/app/api/v1/estimates/export/route';
import {
  DELETE as deleteEstimateRoute,
  GET as getEstimateDetailRoute,
  PUT as putEstimateRoute,
} from '@/app/api/v1/estimates/[id]/route';
import { POST as duplicateEstimateRoute } from '@/app/api/v1/estimates/[id]/duplicate/route';
import { GET as getSnapshotsRoute, POST as postSnapshotsRoute } from '@/app/api/v1/snapshots/route';
import { GET as getSnapshotDetailRoute } from '@/app/api/v1/snapshots/[id]/route';
import { GET as getSnapshotPdfRoute } from '@/app/api/v1/snapshots/[id]/pdf/route';
import { authenticateLogin } from '@/lib/auth/auth-service';
import { encryptField, hashPassword } from '@/lib/crypto/field-cipher';
import { withExecutorTenantContext, type DbExecutor } from '@/lib/db/tenant-client';
import { renderDocumentSnapshotPdf, renderEstimateListPdf } from '@/lib/domain/pdf-renderer';
import {
  decryptSnapshotBankAccounts,
  type DocumentSnapshotPayload,
} from '@/lib/domain/snapshots';
import type { AttachmentDto, QuotationDetailDto, SnapshotDetailDto, SnapshotHistoryItemDto } from '@/lib/estimates/types';
import { setStorageAdapterForTest } from '@/lib/storage/storage-client';

const TEST_ENC_KEY = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';
const TEST_SESSION_SECRET = 'phase2a-test-session-secret-0123456789abcdef';

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

function makeFakePngBytes(size: number = 64): Uint8Array {
  const buf = new Uint8Array(size);
  buf.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0);
  return buf;
}

function makeFakeJpegBytes(): Uint8Array {
  return new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46]);
}

function makeFakeWebpBytes(): Uint8Array {
  const buf = new Uint8Array(24);
  buf.set([0x52, 0x49, 0x46, 0x46], 0); // RIFF
  buf.set([0x57, 0x45, 0x42, 0x50], 8); // WEBP
  return buf;
}

describe('Phase 2-A 見積管理・帳票スナップショット版管理・日本語PDF・添付画像Storage検証', () => {
  let db: PGlite;
  let exec: DbExecutor;

  const tenantId = '55555555-5555-4333-8333-555555555555';
  const tenantSlug = 'phase2a-corp';
  const adminEmpId = 'aaaa5555-5555-4333-8333-555555555555';
  const staffEmpId = 'bbbb5555-5555-4333-8333-555555555555';

  let partnerCorpId = '';
  let partnerIndivId = '';
  let projectId = '';
  let productId = '';
  let staffToken = '';

  const inMemoryStorage = new Map<string, { body: Uint8Array; contentType: string }>();

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
         quotation_template_rows, tax_calc_policy, default_rounding_mode, opening_balance_date
       ) VALUES (
         $1, '9020', '初期自社株式会社', 'T1234567890123',
         '417-0001', '静岡県富士市テスト町1-1', '0545-11-2222', 'est@example.com',
         '代表取締役', '初期 太郎',
         '0149', '001', 'B1', $2, 'ショキジシャ',
         10, 'SLIP_BY_RATE', 'FLOOR', '2026-06-01'
       )`,
      [tenantId, encryptField('1234567', TEST_ENC_KEY)],
    );
    await db.query('SELECT seed_tenant_defaults($1)', [tenantId]);
    await db.query(
      `UPDATE tenant_feature_authorities
          SET is_enabled = true
        WHERE tenant_id = $1
          AND feature_code IN ('estimate', 'estimateimage')`,
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
       VALUES
         ($1, $2, '900', '検証管理者', $3, true, false),
         ($4, $2, '100', '検証見積担当', $5, false, false)`,
      [
        adminEmpId,
        tenantId,
        hashPassword('AdminPass2026!'),
        staffEmpId,
        hashPassword('StaffPass2026!'),
      ],
    );

    const repRows = await db.query<{ id: string }>(
      `INSERT INTO representatives (tenant_id, representative_code, representative_name)
       VALUES ($1, 1, '平山 次郎') RETURNING id`,
      [tenantId],
    );
    const repId = repRows.rows[0]!.id;

    const p1Rows = await db.query<{ id: string }>(
      `INSERT INTO business_partners (
         tenant_id, partner_code, partner_name, representative_id, is_individual_honorific,
         postal_code, address1, is_client
       ) VALUES (
         $1, '00001', '初期取引先株式会社', $2, false, '417-0002', '静岡県富士市顧客町2-2', true
       ) RETURNING id`,
      [tenantId, repId],
    );
    partnerCorpId = p1Rows.rows[0]!.id;

    const p2Rows = await db.query<{ id: string }>(
      `INSERT INTO business_partners (
         tenant_id, partner_code, partner_name, representative_id, is_individual_honorific,
         postal_code, address1, is_client
       ) VALUES (
         $1, '00002', '佐藤商店', $2, true, '417-0003', '静岡県富士市個人町3-3', true
       ) RETURNING id`,
      [tenantId, repId],
    );
    partnerIndivId = p2Rows.rows[0]!.id;

    const pjRows = await db.query<{ id: string }>(
      `INSERT INTO projects (
         tenant_id, project_no, project_name, project_date, partner_id, partner_name_snap
       ) VALUES ($1, 101, '初期テスト案件', '2026-06-05', $2, '初期取引先株式会社') RETURNING id`,
      [tenantId, partnerCorpId],
    );
    projectId = pjRows.rows[0]!.id;

    const prodRows = await db.query<{ id: string }>(
      `INSERT INTO products (
         tenant_id, product_code, product_name, capacity, standard_unit_price, standard_cost_price, default_tax_code
       ) VALUES ($1, 'PRD-001', '高効率空調機', 2.5, 10000, 6000, 'A') RETURNING id`,
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

    setStorageAdapterForTest({
      async upload(params) {
        inMemoryStorage.set(params.storageKey, {
          body: new Uint8Array(params.body),
          contentType: params.contentType,
        });
        return { path: params.storageKey };
      },
      async createSignedUrl(params) {
        return `https://signed.example.local/${encodeURIComponent(params.storageKey)}?ttl=${params.expiresInSeconds}`;
      },
      async remove(params) {
        inMemoryStorage.delete(params.storageKey);
      },
    });
  });

  afterAll(async () => {
    setStorageAdapterForTest(null);
    await db.close();
  });

  it('1. 見積CRUD・採番・複写・削除と calculations.ts 厳密計算（外税/内税/非課税/見出し行/基準単価と適用単価分離）', async () => {
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
      // クライアント改ざん価格や見出し行への不正金額を含めてPOSTしても、サーバー側 calculations.ts で厳密算出されること
      const createRes = await postEstimatesRoute(
        buildJsonApiRequest('http://localhost:3000/api/v1/estimates', 'POST', staffToken, {
          quotationName: 'Phase2A 複合税区分テスト見積',
          quotationDate: '2026-06-10',
          partnerId: partnerCorpId,
          projectId,
          honorific: '御中',
          validityPeriod: '1ヶ月',
          deliveryDate: '2026-07-01',
          status: 'Q1',
          isAdvanceType: false,
          isSelected: true,
          roundingMode: 'FLOOR',
          remarks: '㎡単価・※軽減税率テスト',
          subtotalAmount: 9999999,
          totalAmount: 9999999,
          lines: [
            {
              productId: null,
              itemCode: null,
              itemName: '第1章 設備改修工事',
              unitName: '式',
              isHeading: true,
              quantity: 99,
              taxCode: 'A',
              costCategory: 'MATERIAL',
              masterUnitPrice: null,
              appliedUnitPrice: 99999,
              masterCostPrice: null,
              appliedCostPrice: 99999,
              remarks: '見出し行',
            },
            {
              productId,
              itemCode: 'PRD-001',
              itemName: '高効率空調機（適用単価変更）',
              unitName: '台',
              isHeading: false,
              quantity: 2.5,
              taxCode: 'A',
              costCategory: 'MATERIAL',
              masterUnitPrice: 10000,
              appliedUnitPrice: 12000, // 2.5 * 12000 = 30,000 (+10% 3,000)
              masterCostPrice: 6000,
              appliedCostPrice: 7000, // 2.5 * 7000 = 17,500
              remarks: null,
            },
            {
              productId: null,
              itemCode: null,
              itemName: '飲食料品（軽減8%外税）',
              unitName: '式',
              isHeading: false,
              quantity: 1,
              taxCode: 'B',
              costCategory: 'EXPENSE',
              masterUnitPrice: null,
              appliedUnitPrice: 10000, // 10,000 (+8% 800)
              masterCostPrice: null,
              appliedCostPrice: 5000,
              remarks: null,
            },
            {
              productId: null,
              itemCode: null,
              itemName: '行政手数料（非課税）',
              unitName: '件',
              isHeading: false,
              quantity: 1,
              taxCode: 'C',
              costCategory: 'OUTSOURCING',
              masterUnitPrice: null,
              appliedUnitPrice: 5000, // 5,000 (+0)
              masterCostPrice: null,
              appliedCostPrice: 2000,
              remarks: null,
            },
            {
              productId: null,
              itemCode: null,
              itemName: '内税10%作業費',
              unitName: '式',
              isHeading: false,
              quantity: 1,
              taxCode: 'D',
              costCategory: 'LABOR',
              masterUnitPrice: null,
              appliedUnitPrice: 11000, // 税抜10,000 + 税1,000
              masterCostPrice: null,
              appliedCostPrice: 5500, // 税抜5,000 + 税500
              remarks: null,
            },
            {
              productId: null,
              itemCode: null,
              itemName: '内税8%資材',
              unitName: '式',
              isHeading: false,
              quantity: 1,
              taxCode: 'E',
              costCategory: 'INDIRECT',
              masterUnitPrice: null,
              appliedUnitPrice: 10800, // 税抜10,000 + 税800
              masterCostPrice: null,
              appliedCostPrice: 5400, // 税抜5,000 + 税400
              remarks: null,
            },
          ],
        }),
      );
      expect(createRes.status).toBe(201);
      const created = ((await createRes.json()) as { item: QuotationDetailDto }).item;

      expect(created.quotationNo).toBe(1);
      expect(created.subtotalAmount).toBe(65000);
      expect(created.taxTotal).toBe(5600);
      expect(created.totalAmount).toBe(70600);
      expect(created.costSubtotal).toBe(34500);
      expect(created.grossProfitExcl).toBe(30500);

      // 見出し行の金額が強制0円であること
      expect(created.lines[0]?.isHeading).toBe(true);
      expect(created.lines[0]?.lineAmount).toBe(0);
      expect(created.lines[0]?.costAmount).toBe(0);

      // 基準単価と適用単価が分離保持されていること
      expect(created.lines[1]?.masterUnitPrice).toBe(10000);
      expect(created.lines[1]?.appliedUnitPrice).toBe(12000);
      expect(created.lines[1]?.masterCostPrice).toBe(6000);
      expect(created.lines[1]?.appliedCostPrice).toBe(7000);

      // 複写作成 -> quotationNo = 2, status = 'Q1', isSelected = false
      const dupRes = await duplicateEstimateRoute(
        buildJsonApiRequest(
          `http://localhost:3000/api/v1/estimates/${created.id}/duplicate`,
          'POST',
          staffToken,
        ),
      );
      expect(dupRes.status).toBe(201);
      const duplicated = ((await dupRes.json()) as { item: QuotationDetailDto }).item;
      expect(duplicated.quotationNo).toBe(2);
      expect(duplicated.quotationName).toContain('（コピー）');
      expect(duplicated.status).toBe('Q1');
      expect(duplicated.isSelected).toBe(false);
      expect(duplicated.totalAmount).toBe(70600);

      // 更新（Q2・金額変更）
      const updRes = await putEstimateRoute(
        buildJsonApiRequest(
          `http://localhost:3000/api/v1/estimates/${duplicated.id}`,
          'PUT',
          staffToken,
          {
            quotationName: '更新後コピー見積',
            quotationDate: '2026-06-12',
            partnerId: partnerIndivId,
            projectId: null,
            honorific: '様',
            validityPeriod: '2週間',
            deliveryDate: null,
            status: 'Q2',
            isAdvanceType: true,
            isSelected: false,
            roundingMode: 'CEIL',
            remarks: null,
            lines: [
              {
                productId: null,
                itemCode: null,
                itemName: '切り上げテスト',
                unitName: '式',
                isHeading: false,
                quantity: 1,
                taxCode: 'A',
                costCategory: 'EXPENSE',
                masterUnitPrice: null,
                appliedUnitPrice: 1001, // 1001 * 0.1 = 100.1 -> CEIL 101
                masterCostPrice: null,
                appliedCostPrice: 500,
                remarks: null,
              },
            ],
          },
        ),
      );
      expect(updRes.status).toBe(200);
      const updated = ((await updRes.json()) as { item: QuotationDetailDto }).item;
      expect(updated.taxTotal).toBe(101);
      expect(updated.totalAmount).toBe(1102);

      // 一覧・CSV・見積一覧PDF出力
      const listRes = await getEstimatesRoute(
        buildJsonApiRequest('http://localhost:3000/api/v1/estimates?status=Q2', 'GET', staffToken),
      );
      expect(listRes.status).toBe(200);
      const listBody = (await listRes.json()) as { items: Array<{ id: string }>; summary: { totalCount: number } };
      expect(listBody.summary.totalCount).toBe(1);
      expect(listBody.items[0]?.id).toBe(duplicated.id);

      const csvRes = await exportEstimatesRoute(
        buildJsonApiRequest('http://localhost:3000/api/v1/estimates/export?format=csv', 'GET', staffToken),
      );
      expect(csvRes.status).toBe(200);
      const csvText = await csvRes.text();
      expect(csvText).toContain('Phase2A 複合税区分テスト見積');

      const listPdfRes = await exportEstimatesRoute(
        buildJsonApiRequest('http://localhost:3000/api/v1/estimates/export?format=pdf', 'GET', staffToken),
      );
      expect(listPdfRes.status).toBe(200);
      const listPdfBytes = new Uint8Array(await listPdfRes.arrayBuffer());
      expect(Buffer.from(listPdfBytes.slice(0, 5)).toString('ascii')).toBe('%PDF-');

      // 未発行コピー見積の削除
      const delRes = await deleteEstimateRoute(
        buildJsonApiRequest(
          `http://localhost:3000/api/v1/estimates/${duplicated.id}`,
          'DELETE',
          staffToken,
        ),
      );
      expect(delRes.status).toBe(200);

      const notFoundRes = await getEstimateDetailRoute(
        buildJsonApiRequest(
          `http://localhost:3000/api/v1/estimates/${duplicated.id}`,
          'GET',
          staffToken,
        ),
      );
      expect(notFoundRes.status).toBe(404);
    } finally {
      spyCtx.mockRestore();
      vi.unstubAllEnvs();
    }
  });

  it('2. スナップショット版管理(v1 -> v2 ＜再発行＞)後、自社名・口座・取引先・商品・伝票を変更しても第1版が100%同一再出力されること', async () => {
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
      // 対象見積取得 (#1)
      const listRes = await getEstimatesRoute(
        buildJsonApiRequest('http://localhost:3000/api/v1/estimates?q=Phase2A', 'GET', staffToken),
      );
      const listBody = (await listRes.json()) as { items: Array<{ id: string }> };
      const qId = listBody.items[0]!.id;

      // 第1版発行
      const v1Res = await postSnapshotsRoute(
        buildJsonApiRequest('http://localhost:3000/api/v1/snapshots', 'POST', staffToken, {
          documentType: 'ESTIMATE',
          sourceEntityId: qId,
          templateVariant: '10_ROWS',
          issueDate: '2026-06-15',
        }),
      );
      expect(v1Res.status).toBe(201);
      const v1 = ((await v1Res.json()) as { item: SnapshotDetailDto }).item;
      expect(v1.versionNo).toBe(1);
      expect(v1.isReissue).toBe(false);
      expect(v1.reissueLabel).toBeNull();
      expect(v1.payloadJson.issuer.companyName).toBe('初期自社株式会社');
      expect(v1.payloadJson.issuer.bankAccounts[0]?.accountNoEnc?.startsWith('enc:v1:')).toBe(true);
      expect(v1.payloadJson.recipient.partnerName).toBe('初期取引先株式会社');
      expect(v1.payloadJson.header.totalAmount).toBe(70600);

      // 第1版 PDF バイナリ取得
      const v1PdfResBefore = await getSnapshotPdfRoute(
        buildJsonApiRequest(`http://localhost:3000/api/v1/snapshots/${v1.id}/pdf`, 'GET', staffToken),
      );
      expect(v1PdfResBefore.status).toBe(200);
      const v1PdfBefore = new Uint8Array(await v1PdfResBefore.arrayBuffer());
      expect(Buffer.from(v1PdfBefore.slice(0, 5)).toString('ascii')).toBe('%PDF-');

      // 現行マスタと見積本体をすべて改変する
      await db.query(
        `UPDATE tenant_settings
            SET company_name = '改変後自社ホールディングス株式会社',
                invoice_registration_no = 'T9999999999999',
                bank_account_no_1_enc = $2
          WHERE tenant_id = $1`,
        [tenantId, encryptField('9999999', TEST_ENC_KEY)],
      );
      await db.query(
        `UPDATE business_partners
            SET partner_name = '改変後取引先株式会社',
                address1 = '東京都新宿区改変1-2-3'
          WHERE id = $1`,
        [partnerCorpId],
      );
      await db.query(
        `UPDATE products
            SET product_name = '改変後高効率空調機',
                standard_unit_price = 999999
          WHERE id = $1`,
        [productId],
      );
      await putEstimateRoute(
        buildJsonApiRequest(`http://localhost:3000/api/v1/estimates/${qId}`, 'PUT', staffToken, {
          quotationName: '改変後見積タイトル',
          quotationDate: '2026-06-20',
          partnerId: partnerCorpId,
          projectId,
          honorific: '御中',
          validityPeriod: '1週間',
          deliveryDate: null,
          status: 'Q2',
          isAdvanceType: false,
          isSelected: true,
          roundingMode: 'FLOOR',
          remarks: '改変後備考',
          lines: [
            {
              productId,
              itemCode: 'PRD-001',
              itemName: '改変後高効率空調機',
              unitName: '台',
              isHeading: false,
              quantity: 1,
              taxCode: 'A',
              costCategory: 'MATERIAL',
              masterUnitPrice: 999999,
              appliedUnitPrice: 500000,
              masterCostPrice: 6000,
              appliedCostPrice: 300000,
              remarks: null,
            },
          ],
        }),
      );

      // 第2版（再発行）発行 -> 改変後の値が凍結され、is_reissue=true / ＜再発行＞
      const v2Res = await postSnapshotsRoute(
        buildJsonApiRequest('http://localhost:3000/api/v1/snapshots', 'POST', staffToken, {
          documentType: 'ESTIMATE',
          sourceEntityId: qId,
          templateVariant: '20_ROWS',
          issueDate: '2026-06-20',
        }),
      );
      expect(v2Res.status).toBe(201);
      const v2 = ((await v2Res.json()) as { item: SnapshotDetailDto }).item;
      expect(v2.versionNo).toBe(2);
      expect(v2.isReissue).toBe(true);
      expect(v2.reissueLabel).toBe('＜再発行＞');
      expect(v2.payloadJson.issuer.companyName).toBe('改変後自社ホールディングス株式会社');
      expect(v2.payloadJson.recipient.partnerName).toBe('改変後取引先株式会社');
      expect(v2.payloadJson.header.totalAmount).toBe(550000);
      expect(decryptSnapshotBankAccounts(v2.payloadJson, TEST_ENC_KEY)[0]?.accountNo).toBe('9999999');

      // 第1版を再取得・PDF再レンダリング -> 改変の影響を一切受けず100%同一であること
      const v1DetailAfterRes = await getSnapshotDetailRoute(
        buildJsonApiRequest(`http://localhost:3000/api/v1/snapshots/${v1.id}`, 'GET', staffToken),
      );
      expect(v1DetailAfterRes.status).toBe(200);
      const v1DetailAfter = ((await v1DetailAfterRes.json()) as { item: SnapshotDetailDto }).item;
      expect(v1DetailAfter.payloadSha256).toBe(v1.payloadSha256);
      expect(v1DetailAfter.payloadJson.issuer.companyName).toBe('初期自社株式会社');
      expect(v1DetailAfter.payloadJson.recipient.partnerName).toBe('初期取引先株式会社');
      expect(v1DetailAfter.payloadJson.header.totalAmount).toBe(70600);
      expect(decryptSnapshotBankAccounts(v1DetailAfter.payloadJson, TEST_ENC_KEY)[0]?.accountNo).toBe(
        '1234567',
      );

      const v1PdfResAfter = await getSnapshotPdfRoute(
        buildJsonApiRequest(`http://localhost:3000/api/v1/snapshots/${v1.id}/pdf`, 'GET', staffToken),
      );
      expect(v1PdfResAfter.status).toBe(200);
      const v1PdfAfter = new Uint8Array(await v1PdfResAfter.arrayBuffer());
      expect(Buffer.from(v1PdfAfter).equals(Buffer.from(v1PdfBefore))).toBe(true);

      // 履歴一覧は降順 (v2, v1)
      const histRes = await getSnapshotsRoute(
        buildJsonApiRequest(
          `http://localhost:3000/api/v1/snapshots?documentType=ESTIMATE&sourceEntityId=${qId}`,
          'GET',
          staffToken,
        ),
      );
      expect(histRes.status).toBe(200);
      const histItems = ((await histRes.json()) as { items: SnapshotHistoryItemDto[] }).items;
      expect(histItems.map((h) => h.versionNo)).toEqual([2, 1]);

      // 発行済みスナップショットが存在する見積は削除禁止 (409)
      const delLockedRes = await deleteEstimateRoute(
        buildJsonApiRequest(`http://localhost:3000/api/v1/estimates/${qId}`, 'DELETE', staffToken),
      );
      expect(delLockedRes.status).toBe(409);
    } finally {
      spyCtx.mockRestore();
      vi.unstubAllEnvs();
    }
  });

  it('3. 日本語PDFレンダラ検証: 特殊記号(※,非,内,㎡,㈱,＜再発行＞)・20行超自動改ページ・添付画像コメント・見積一覧PDF', async () => {
    const manyLines: DocumentSnapshotPayload['lines'] = [];
    for (let i = 1; i <= 25; i += 1) {
      manyLines.push({
        lineNo: i,
        sourceSlipNo: 77,
        sourceSlipDate: '2026-06-25',
        advanceMark: null,
        itemCode: `CD-${i}`,
        itemName:
          i === 1
            ? '【見出し】外構舗装工事 100㎡（㈱ヴェンダス施工）'
            : `施工明細#${i} ※軽減・非課税・内税テスト`,
        capacityLabel: i === 2 ? '100㎡' : null,
        unitName: i === 1 ? null : '㎡',
        targetMonthLabel: null,
        isHeading: i === 1,
        quantity: i === 1 ? 0 : 10.5,
        appliedUnitPrice: i === 1 ? 0 : 1000,
        lineAmount: i === 1 ? 0 : 10500,
        taxCode: i % 3 === 0 ? 'B' : 'A',
        taxRate: i % 3 === 0 ? 0.08 : 0.1,
        taxMarkSymbol: i % 3 === 0 ? '※' : '.',
        isInternalTax: false,
        lineTax: i === 1 ? 0 : i % 3 === 0 ? 840 : 1050,
        rowTotal: i === 1 ? 0 : i % 3 === 0 ? 11340 : 11550,
        remarks: i === 2 ? '※ 非 内 ㎡ ㈱' : null,
      });
    }

    const payload: DocumentSnapshotPayload = {
      schemaVersion: 1,
      documentType: 'ESTIMATE',
      templateVariant: '20_ROWS',
      documentNo: '77',
      issueDate: '2026-06-25',
      isReissue: true,
      reissueLabel: '＜再発行＞',
      issuer: {
        companyCode: '9999',
        companyName: '㈱テスト建設エンジニアリング',
        invoiceRegistrationNo: 'T1234567890123',
        corporateNo: '1234567890123',
        postalCode: '417-0001',
        address1: '静岡県富士市テスト町1-1',
        address2: 'ヴェンダスビル3F',
        tel: '0545-00-0000',
        fax: '0545-00-0001',
        email: 'pdf@example.com',
        representativeTitle: '代表取締役',
        representativeName: '山田 太郎',
        billingMemo: 'お振込手数料はご負担願います。',
        bankAccounts: [
          {
            bankName: '静岡銀行',
            branchName: '富士支店',
            accountTypeLabel: '普通',
            accountNoEnc: encryptField('7654321', TEST_ENC_KEY),
            accountHolder: 'ｶ)ﾃｽﾄｹﾝｾﾂ',
          },
        ],
      },
      recipient: {
        partnerCode: '00099',
        partnerName: '㈱クライアント商事',
        representativeCode: null,
        representativeName: null,
        isIndividualHonorific: false,
        resolvedAddressee: '㈱クライアント商事',
        honorific: '御中',
        resolvedPostalCode: '100-0001',
        resolvedAddress: '東京都千代田区千代田1-1',
      },
      header: {
        title: '防水・外構100㎡改修工事',
        projectNo: 55,
        projectName: '駅前ビル改修案件',
        validityPeriod: '発行後30日',
        deliveryDate: '2026-08-31',
        paymentDueDate: null,
        roundingMode: 'FLOOR',
        taxCalcPolicy: 'SLIP_BY_RATE',
        subtotalAmount: 252000,
        taxTotal: 23520,
        taxAdjustmentAmount: 0,
        totalAmount: 275520,
        taxBreakdown: {
          rate10Excl: 168000,
          rate10Tax: 16800,
          rate8Excl: 84000,
          rate8Tax: 6720,
          nonTaxAmount: 0,
        },
        showCarryover: false,
        mirrorSummary: null,
        remarks: '※印は軽減税率(8%)対象、内は内税、非は非課税を表します。',
      },
      lines: manyLines,
      attachments: [
        { sortOrder: 1, storageKey: 't/q/1.png', originalName: '現地1.png', comment: '北側外壁100㎡' },
        { sortOrder: 2, storageKey: 't/q/2.png', originalName: '現地2.png', comment: '屋上防水※' },
        { sortOrder: 3, storageKey: 't/q/3.png', originalName: '現地3.png', comment: '駐車場ライン' },
      ],
    };

    const pdfBytes = await renderDocumentSnapshotPdf(payload, TEST_ENC_KEY);
    expect(pdfBytes.byteLength).toBeGreaterThan(2000);
    expect(Buffer.from(pdfBytes.slice(0, 5)).toString('ascii')).toBe('%PDF-');

    const loaded = await PDFDocument.load(pdfBytes);
    // 25行 / 20_ROWS = 2明細ページ + 添付画像3件(>2件)継続ページ = 3ページ
    expect(loaded.getPageCount()).toBe(3);

    // 決定論的生成：同一ペイロードで再出力するとバイト列完全一致
    const pdfBytes2 = await renderDocumentSnapshotPdf(payload, TEST_ENC_KEY);
    expect(Buffer.from(pdfBytes).equals(Buffer.from(pdfBytes2))).toBe(true);

    // 見積一覧PDF
    const listPdf = await renderEstimateListPdf({
      companyName: '㈱テスト建設エンジニアリング',
      generatedDate: '2026-06-25',
      filterSummary: '全件',
      items: [
        {
          quotationNo: 1,
          quotationDate: '2026-06-25',
          status: 'Q1',
          isSelected: true,
          isAdvanceType: false,
          partnerName: '㈱クライアント商事',
          quotationName: '防水・外構100㎡改修工事',
          projectName: '駅前ビル改修案件',
          subtotalAmount: 252000,
          taxTotal: 23520,
          totalAmount: 275520,
          costSubtotal: 150000,
          grossProfitExcl: 102000,
        },
      ],
      totals: {
        count: 1,
        subtotalAmount: 252000,
        taxTotal: 23520,
        totalAmount: 275520,
        costSubtotal: 150000,
        grossProfitExcl: 102000,
      },
    });
    expect(listPdf.byteLength).toBeGreaterThan(1500);
    expect(Buffer.from(listPdf.slice(0, 5)).toString('ascii')).toBe('%PDF-');
    const loadedList = await PDFDocument.load(listPdf);
    expect(loadedList.getPageCount()).toBe(1);
  });

  it('4. 添付画像マジックナンバー検証（PNG/JPEG/WebP許可・偽装HTML/SVG/5MB超過400拒否）＆機能フラグOFF時403制御', async () => {
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
      const listRes = await getEstimatesRoute(
        buildJsonApiRequest('http://localhost:3000/api/v1/estimates', 'GET', staffToken),
      );
      const qId = ((await listRes.json()) as { items: Array<{ id: string }> }).items[0]!.id;

      // 1) PNG, JPEG, WebP のアップロード通過 + テナント分離キー検証
      const pngUp = await postAttachmentRoute(
        buildJsonApiRequest('http://localhost:3000/api/v1/attachments', 'POST', staffToken, {
          entityType: 'QUOTATION',
          entityId: qId,
          originalName: 'site_photo.png',
          contentBase64: Buffer.from(makeFakePngBytes()).toString('base64'),
          comment: '現場写真1',
        }),
      );
      expect(pngUp.status).toBe(201);
      const pngAtt = ((await pngUp.json()) as { item: AttachmentDto }).item;
      expect(pngAtt.mimeType).toBe('image/png');
      expect(pngAtt.storageKey.startsWith(`${tenantId}/quotations/${qId}/`)).toBe(true);
      expect(pngAtt.storageKey.endsWith('.png')).toBe(true);
      expect(pngAtt.signedUrl).toContain('https://signed.example.local/');

      const jpgUp = await postAttachmentRoute(
        buildJsonApiRequest('http://localhost:3000/api/v1/attachments', 'POST', staffToken, {
          entityType: 'QUOTATION',
          entityId: qId,
          originalName: 'site_photo.jpg',
          contentBase64: Buffer.from(makeFakeJpegBytes()).toString('base64'),
          comment: '現場写真2',
        }),
      );
      expect(jpgUp.status).toBe(201);
      const jpgAtt = ((await jpgUp.json()) as { item: AttachmentDto }).item;
      expect(jpgAtt.mimeType).toBe('image/jpeg');
      expect(jpgAtt.sortOrder).toBe(2);

      const webpUp = await postAttachmentRoute(
        buildJsonApiRequest('http://localhost:3000/api/v1/attachments', 'POST', staffToken, {
          entityType: 'QUOTATION',
          entityId: qId,
          originalName: 'diagram.webp',
          contentBase64: Buffer.from(makeFakeWebpBytes()).toString('base64'),
          comment: null,
        }),
      );
      expect(webpUp.status).toBe(201);
      const webpAtt = ((await webpUp.json()) as { item: AttachmentDto }).item;
      expect(webpAtt.mimeType).toBe('image/webp');
      expect(webpAtt.sortOrder).toBe(3);

      // 2) コメント編集 & 並び替え (webp を上へ)
      const patchRes = await patchAttachmentRoute(
        buildJsonApiRequest(
          `http://localhost:3000/api/v1/attachments/${webpAtt.id}`,
          'PATCH',
          staffToken,
          { comment: '図面WebPコメント更新', moveDirection: 'UP' },
        ),
      );
      expect(patchRes.status).toBe(200);
      const patched = ((await patchRes.json()) as { item: AttachmentDto }).item;
      expect(patched.comment).toBe('図面WebPコメント更新');
      expect(patched.sortOrder).toBe(2);

      // 3) 偽装 HTML (.png拡張子 + image/png申告でもマジックナンバーで400拒否)
      const formDataHtml = new FormData();
      formDataHtml.append('entityType', 'QUOTATION');
      formDataHtml.append('entityId', qId);
      formDataHtml.append(
        'file',
        new File([Buffer.from('<html><script>alert(1)</script></html>')], 'evil.png', {
          type: 'image/png',
        }),
      );
      const htmlRejectRes = await postAttachmentRoute(
        new Request('http://localhost:3000/api/v1/attachments', {
          method: 'POST',
          headers: {
            host: 'localhost:3000',
            origin: 'http://localhost:3000',
            cookie: `vendas_session=${encodeURIComponent(staffToken)}`,
          },
          body: formDataHtml,
        }),
      );
      expect(htmlRejectRes.status).toBe(400);
      const htmlRejectBody = (await htmlRejectRes.json()) as { errorCode: string };
      expect(htmlRejectBody.errorCode).toBe('INVALID_IMAGE_MAGIC_BYTES');

      // 4) 偽装 SVG -> 400 拒否
      const svgRejectRes = await postAttachmentRoute(
        buildJsonApiRequest('http://localhost:3000/api/v1/attachments', 'POST', staffToken, {
          entityType: 'QUOTATION',
          entityId: qId,
          originalName: 'xss.svg.png',
          contentBase64: Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"></svg>').toString('base64'),
        }),
      );
      expect(svgRejectRes.status).toBe(400);

      // 5) 5MB 超過 -> 400 拒否
      const over5Mb = makeFakePngBytes(5 * 1024 * 1024 + 10);
      const sizeRejectRes = await postAttachmentRoute(
        buildJsonApiRequest('http://localhost:3000/api/v1/attachments', 'POST', staffToken, {
          entityType: 'QUOTATION',
          entityId: qId,
          originalName: 'huge.png',
          contentBase64: Buffer.from(over5Mb).toString('base64'),
        }),
      );
      expect(sizeRejectRes.status).toBe(400);
      expect(((await sizeRejectRes.json()) as { errorCode: string }).errorCode).toBe('FILE_TOO_LARGE');

      // 6) 削除 -> DB & Storage 双方から消去され、sort_order が 1, 2 に詰め直されること
      const delAttRes = await deleteAttachmentRoute(
        buildJsonApiRequest(
          `http://localhost:3000/api/v1/attachments/${pngAtt.id}`,
          'DELETE',
          staffToken,
        ),
      );
      expect(delAttRes.status).toBe(200);
      expect(inMemoryStorage.has(pngAtt.storageKey)).toBe(false);

      const listAttRes = await getAttachmentsRoute(
        buildJsonApiRequest(
          `http://localhost:3000/api/v1/attachments?entityType=QUOTATION&entityId=${qId}`,
          'GET',
          staffToken,
        ),
      );
      expect(listAttRes.status).toBe(200);
      const remainingAtts = ((await listAttRes.json()) as { items: AttachmentDto[] }).items;
      expect(remainingAtts.map((a) => a.sortOrder)).toEqual([1, 2]);

      // 7) estimateimage フラグ OFF 時 -> 添付APIのみ 403 Forbidden、見積APIは通過
      await db.query(
        `UPDATE tenant_feature_authorities
            SET is_enabled = false
          WHERE tenant_id = $1 AND feature_code = 'estimateimage'`,
        [tenantId],
      );
      const attDisabledRes = await getAttachmentsRoute(
        buildJsonApiRequest(
          `http://localhost:3000/api/v1/attachments?entityType=QUOTATION&entityId=${qId}`,
          'GET',
          staffToken,
        ),
      );
      expect(attDisabledRes.status).toBe(403);
      expect(((await attDisabledRes.json()) as { errorCode: string }).errorCode).toBe('FEATURE_DISABLED');

      const estStillAllowedRes = await getEstimatesRoute(
        buildJsonApiRequest('http://localhost:3000/api/v1/estimates', 'GET', staffToken),
      );
      expect(estStillAllowedRes.status).toBe(200);

      // 8) estimate フラグ OFF 時 -> 見積API・スナップショットAPIともに 403 Forbidden
      await db.query(
        `UPDATE tenant_feature_authorities
            SET is_enabled = false
          WHERE tenant_id = $1 AND feature_code = 'estimate'`,
        [tenantId],
      );
      const estDisabledRes = await getEstimatesRoute(
        buildJsonApiRequest('http://localhost:3000/api/v1/estimates', 'GET', staffToken),
      );
      expect(estDisabledRes.status).toBe(403);

      const snapDisabledRes = await postSnapshotsRoute(
        buildJsonApiRequest('http://localhost:3000/api/v1/snapshots', 'POST', staffToken, {
          documentType: 'ESTIMATE',
          sourceEntityId: qId,
        }),
      );
      expect(snapDisabledRes.status).toBe(403);
    } finally {
      spyCtx.mockRestore();
      vi.unstubAllEnvs();
    }
  });
});
