import fs from 'node:fs';
import path from 'node:path';
import { PGlite } from '@electric-sql/pglite';
import { PDFDocument } from 'pdf-lib';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  GET as getAttachmentsRoute,
  POST as postAttachmentsRoute,
} from '@/app/api/v1/attachments/route';
import {
  DELETE as deleteAttachmentRoute,
  PATCH as patchAttachmentRoute,
} from '@/app/api/v1/attachments/[id]/route';
import { POST as postEstimatesRoute } from '@/app/api/v1/estimates/route';
import {
  GET as getProjectCostsRoute,
  POST as postProjectCostsRoute,
} from '@/app/api/v1/project-costs/route';
import {
  DELETE as deleteProjectCostRoute,
  GET as getProjectCostDetailRoute,
  PUT as putProjectCostRoute,
} from '@/app/api/v1/project-costs/[id]/route';
import { GET as exportProjectCostsRoute } from '@/app/api/v1/project-costs/export/route';
import {
  GET as getCostFromPurchaseCandidatesRoute,
  POST as postCostFromPurchaseRoute,
} from '@/app/api/v1/project-costs/from-purchase/route';
import {
  GET as getProjectsRoute,
  POST as postProjectsRoute,
} from '@/app/api/v1/projects/route';
import {
  DELETE as deleteProjectRoute,
  GET as getProjectDetailRoute,
  PUT as putProjectRoute,
} from '@/app/api/v1/projects/[id]/route';
import { GET as exportProjectsRoute } from '@/app/api/v1/projects/export/route';
import { POST as postProjectImportBudgetRoute } from '@/app/api/v1/projects/[id]/import-budget/route';
import { GET as exportProjectLedgerRoute } from '@/app/api/v1/projects/[id]/ledger-export/route';
import { POST as postPurchasesRoute } from '@/app/api/v1/purchases/route';
import { authenticateLogin } from '@/lib/auth/auth-service';
import { encryptField, hashPassword } from '@/lib/crypto/field-cipher';
import { withExecutorTenantContext, type DbExecutor } from '@/lib/db/tenant-client';
import { calculateProjectProfit } from '@/lib/domain/calculations';
import type { AttachmentDto, QuotationDetailDto } from '@/lib/estimates/types';
import type {
  CandidatePurchaseForCostDto,
  ProjectCostDetailDto,
  ProjectCostPageDto,
} from '@/lib/project-costs/types';
import type { ProjectDetailDto, ProjectPageDto } from '@/lib/projects/types';
import type { PurchaseDetailDto } from '@/lib/purchasing/types';
import { setStorageAdapterForTest } from '@/lib/storage/storage-client';

const TEST_ENC_KEY = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';
const TEST_SESSION_SECRET = 'phase4b-test-session-secret-0123456789abcdef';

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

describe('Phase 4-B 案件（工事）管理・実行予算取込・原価6費目・工事台帳・添付画像検証', () => {
  let db: PGlite;
  let exec: DbExecutor;

  const tenantId = 'a1a1a1a1-b2b2-4444-8444-c3c3c3c3c3c3';
  const tenantSlug = 'phase4b-corp';
  const staffEmpId = 'd4d4d4d4-e5e5-4444-8444-f6f6f6f6f6f6';

  let clientPartnerId = '';
  let supplierPartnerId = '';
  let staffToken = '';
  let mainProjectId = '';

  const storedObjects = new Map<string, { body: Uint8Array; contentType: string }>();

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
      `INSERT INTO tenants (id, tenant_slug, tenant_name) VALUES ($1, $2, '工事原価テスト建設株式会社')`,
      [tenantId, tenantSlug],
    );
    await db.query(
      `INSERT INTO tenant_settings (
         tenant_id, company_code, company_name, invoice_registration_no,
         postal_code, address1, tel, email, representative_title, representative_name,
         bank_code_1, branch_code_1, bank_account_type_1, bank_account_no_1_enc, bank_account_holder_1,
         approval_flow_enabled, quotation_template_rows, tax_calc_policy, default_rounding_mode,
         cost_tax_mode, opening_balance_date
       ) VALUES (
         $1, '9070', '工事原価テスト建設株式会社', 'T1122334455667',
         '417-0020', '静岡県富士市工事町1-2-3', '0545-33-4444', 'const@example.com',
         '代表取締役', '工事 太郎',
         '0149', '001', 'B1', $2, 'コウジゲンカテスト',
         true, 10, 'SLIP_BY_RATE', 'FLOOR', 'TAX_EXCLUDED', '2026-05-31'
       )`,
      [tenantId, encryptField('1122334', TEST_ENC_KEY)],
    );
    await db.query('SELECT seed_tenant_defaults($1)', [tenantId]);
    await db.query(
      `UPDATE tenant_feature_authorities
          SET is_enabled = true
        WHERE tenant_id = $1
          AND feature_code IN (
            'estimate', 'construction', 'budget', 'cost',
            'expense', 'labor', 'material', 'outsourcing', 'purchase'
          )`,
      [tenantId],
    );
    await db.query(
      `UPDATE tenant_feature_authorities
          SET is_enabled = false
        WHERE tenant_id = $1
          AND feature_code IN ('constructionimage', 'temporary', 'indirect')`,
      [tenantId],
    );

    await db.query(
      `INSERT INTO employees (id, tenant_id, syain_code, syain_name, password_hash, is_admin, must_change_password)
       VALUES ($1, $2, '300', '現場監督花子', $3, false, false)`,
      [staffEmpId, tenantId, hashPassword('Phase4BPass2026!')],
    );

    const clientRows = await db.query<{ id: string }>(
      `INSERT INTO business_partners (
         tenant_id, partner_code, partner_name, is_individual_honorific,
         postal_code, address1, is_client, is_supplier, closing_day_code, collection_day_code
       ) VALUES (
         $1, '10001', '富士工業株式会社', false, '417-0021', '静岡県富士市発注町10',
         true, false, 'D', '1'
       ) RETURNING id`,
      [tenantId],
    );
    clientPartnerId = clientRows.rows[0]!.id;

    const supRows = await db.query<{ id: string }>(
      `INSERT INTO business_partners (
         tenant_id, partner_code, partner_name, is_individual_honorific,
         postal_code, address1, is_client, is_supplier, closing_day_code, collection_day_code
       ) VALUES (
         $1, '50001', '富士建材リース株式会社', false, '417-0022', '静岡県富士市資材町20',
         false, true, 'D', '1'
       ) RETURNING id`,
      [tenantId],
    );
    supplierPartnerId = supRows.rows[0]!.id;

    const loginRes = await authenticateLogin(exec, {
      tenantSlug,
      syainCode: '300',
      password: 'Phase4BPass2026!',
      clientIp: '127.0.0.1',
      sessionSecretOverride: TEST_SESSION_SECRET,
    });
    staffToken = loginRes.token;

    setStorageAdapterForTest({
      async upload(params) {
        storedObjects.set(params.storageKey, {
          body: new Uint8Array(params.body),
          contentType: params.contentType,
        });
        return { path: params.storageKey };
      },
      async createSignedUrl(params) {
        return `https://mock-storage.local/${params.bucket}/${encodeURIComponent(params.storageKey)}?exp=${params.expiresInSeconds}`;
      },
      async remove(params) {
        storedObjects.delete(params.storageKey);
      },
    });
  });

  afterAll(async () => {
    setStorageAdapterForTest(null);
    await db.close();
  });

  it('1. 案件CRUD・採番・見積からの実行予算6費目取込・関連データ削除保護(409)検証', async () => {
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
      // 1-1. 新規案件作成（YYYYMMDD00001自動採番 & calculateLineAmounts契約額計算）
      const createRes = await postProjectsRoute(
        buildJsonApiRequest('http://localhost:3000/api/v1/projects', 'POST', staffToken, {
          projectName: '第1工場 空調・電源設備改修工事',
          projectDate: '2026-06-10',
          sitePlace: '静岡県富士市工場地帯A棟',
          partnerId: clientPartnerId,
          orderKindCode: null,
          subStatusCode: null,
          status: 'C1',
          periodStartDate: '2026-06-15',
          periodEndDate: '2026-08-31',
          actualStartDate: null,
          tempFinishDate: null,
          finishDate: null,
          salesEmployeeId: staffEmpId,
          siteEmployeeId: staffEmpId,
          unitName: '式',
          contractUnitPrice: 2000000,
          contractQuantity: 1,
          taxCode: 'A',
          roundingMode: 'FLOOR',
          budgets: {
            EXPENSE: 0,
            LABOR: 0,
            MATERIAL: 0,
            OUTSOURCING: 0,
            TEMPORARY: 0,
            INDIRECT: 0,
          },
          remarks: '安全書類提出要',
        }),
      );
      expect(createRes.status).toBe(201);
      const createBody = (await createRes.json()) as { ok: true; item: ProjectDetailDto };
      const projectA = createBody.item;
      mainProjectId = projectA.id;

      expect(projectA.projectNo).toBe(2026061000001);
      expect(projectA.contractSubtotal).toBe(2000000);
      expect(projectA.contractTax).toBe(200000);
      expect(projectA.contractTotal).toBe(2200000);

      // 1-2. 案件に紐づく見積書を作成（6費目すべてに原価明細設定）
      const estRes = await postEstimatesRoute(
        buildJsonApiRequest('http://localhost:3000/api/v1/estimates', 'POST', staffToken, {
          quotationName: '第1工場 設備改修 本見積',
          quotationDate: '2026-06-08',
          partnerId: clientPartnerId,
          projectId: mainProjectId,
          honorific: '御中',
          validityPeriod: '1ヶ月',
          deliveryDate: null,
          status: 'Q2',
          isAdvanceType: false,
          isSelected: true,
          roundingMode: 'FLOOR',
          remarks: null,
          lines: [
            {
              productId: null,
              itemCode: 'EXP-1',
              itemName: '現場交通・消耗諸経費',
              unitName: '式',
              isHeading: false,
              quantity: 1,
              taxCode: 'A',
              costCategory: 'EXPENSE',
              masterUnitPrice: 100000,
              appliedUnitPrice: 100000,
              masterCostPrice: 50000,
              appliedCostPrice: 50000,
              remarks: null,
            },
            {
              productId: null,
              itemCode: 'LAB-1',
              itemName: '自社電工人工',
              unitName: '人日',
              isHeading: false,
              quantity: 2,
              taxCode: 'A',
              costCategory: 'LABOR',
              masterUnitPrice: 150000,
              appliedUnitPrice: 150000,
              masterCostPrice: 80000,
              appliedCostPrice: 80000,
              remarks: null,
            },
            {
              productId: null,
              itemCode: 'MAT-1',
              itemName: '高効率インバータ空調機一式',
              unitName: '式',
              isHeading: false,
              quantity: 1,
              taxCode: 'A',
              costCategory: 'MATERIAL',
              masterUnitPrice: 500000,
              appliedUnitPrice: 500000,
              masterCostPrice: 300000,
              appliedCostPrice: 300000,
              remarks: null,
            },
            {
              productId: null,
              itemCode: 'OUT-1',
              itemName: '配管ダクト外注施工',
              unitName: '式',
              isHeading: false,
              quantity: 1,
              taxCode: 'A',
              costCategory: 'OUTSOURCING',
              masterUnitPrice: 800000,
              appliedUnitPrice: 800000,
              masterCostPrice: 500000,
              appliedCostPrice: 500000,
              remarks: null,
            },
            {
              productId: null,
              itemCode: 'TMP-1',
              itemName: '高所作業用仮設足場',
              unitName: '式',
              isHeading: false,
              quantity: 1,
              taxCode: 'A',
              costCategory: 'TEMPORARY',
              masterUnitPrice: 200000,
              appliedUnitPrice: 200000,
              masterCostPrice: 100000,
              appliedCostPrice: 100000,
              remarks: null,
            },
            {
              productId: null,
              itemCode: 'IND-1',
              itemName: '現場管理諸経費・産廃処分費',
              unitName: '式',
              isHeading: false,
              quantity: 1,
              taxCode: 'A',
              costCategory: 'INDIRECT',
              masterUnitPrice: 150000,
              appliedUnitPrice: 150000,
              masterCostPrice: 70000,
              appliedCostPrice: 70000,
              remarks: null,
            },
          ],
        }),
      );
      expect(estRes.status).toBe(201);
      const estBody = (await estRes.json()) as { ok: true; item: QuotationDetailDto };
      const quotation = estBody.item;
      expect(quotation.subtotalAmount).toBe(2050000);
      expect(quotation.costSubtotal).toBe(1180000);

      // 1-3. 見積から実行予算6費目＋契約額取込
      const importRes = await postProjectImportBudgetRoute(
        buildJsonApiRequest(
          `http://localhost:3000/api/v1/projects/${mainProjectId}/import-budget`,
          'POST',
          staffToken,
          { quotationId: quotation.id, updateContractAmount: true },
        ),
      );
      expect(importRes.status).toBe(200);
      const importBody = (await importRes.json()) as { ok: true; item: ProjectDetailDto };
      expect(importBody.item.budgets).toEqual({
        EXPENSE: 50000,
        LABOR: 160000,
        MATERIAL: 300000,
        OUTSOURCING: 500000,
        TEMPORARY: 100000,
        INDIRECT: 70000,
      });
      expect(importBody.item.budgetTotal).toBe(1180000);
      expect(importBody.item.contractSubtotal).toBe(2050000);
      expect(importBody.item.contractTax).toBe(205000);
      expect(importBody.item.contractTotal).toBe(2255000);
      expect(importBody.item.sourceQuotationNo).toBe(quotation.quotationNo);

      // 1-4. 基本情報・実行予算の一部更新（PUT）
      const putRes = await putProjectRoute(
        buildJsonApiRequest(
          `http://localhost:3000/api/v1/projects/${mainProjectId}`,
          'PUT',
          staffToken,
          {
            projectNo: projectA.projectNo,
            projectName: importBody.item.projectName,
            projectDate: '2026-06-10',
            sitePlace: importBody.item.sitePlace,
            partnerId: clientPartnerId,
            orderKindCode: null,
            subStatusCode: null,
            status: 'C2',
            periodStartDate: '2026-06-15',
            periodEndDate: '2026-08-31',
            actualStartDate: '2026-06-16',
            tempFinishDate: null,
            finishDate: null,
            salesEmployeeId: staffEmpId,
            siteEmployeeId: staffEmpId,
            unitName: '式',
            contractUnitPrice: importBody.item.contractUnitPrice,
            contractQuantity: importBody.item.contractQuantity,
            taxCode: 'A',
            roundingMode: 'FLOOR',
            budgets: importBody.item.budgets,
            remarks: '着工中',
          },
        ),
      );
      expect(putRes.status).toBe(200);
      const putBody = (await putRes.json()) as { ok: true; item: ProjectDetailDto };
      expect(putBody.item.status).toBe('C2');
      expect(putBody.item.actualStartDate).toBe('2026-06-16');

      // 1-5. 見積に紐づく案件の削除は 409 PROJECT_IN_USE でブロックされる
      const delUsedRes = await deleteProjectRoute(
        buildJsonApiRequest(
          `http://localhost:3000/api/v1/projects/${mainProjectId}`,
          'DELETE',
          staffToken,
        ),
      );
      expect(delUsedRes.status).toBe(409);
      const delUsedBody = (await delUsedRes.json()) as { ok: false; errorCode: string };
      expect(delUsedBody.errorCode).toBe('PROJECT_IN_USE');

      // 1-6. 未紐付け案件を作成して2件目採番(00002)を確認し、そのまま削除成功を検証
      const createBRes = await postProjectsRoute(
        buildJsonApiRequest('http://localhost:3000/api/v1/projects', 'POST', staffToken, {
          projectName: '削除テスト用仮案件',
          projectDate: '2026-06-10',
          partnerId: clientPartnerId,
          status: 'C1',
          contractUnitPrice: 100000,
          contractQuantity: 1,
          taxCode: 'A',
          roundingMode: 'FLOOR',
        }),
      );
      expect(createBRes.status).toBe(201);
      const projectB = ((await createBRes.json()) as { ok: true; item: ProjectDetailDto }).item;
      expect(projectB.projectNo).toBe(2026061000002);

      const delOkRes = await deleteProjectRoute(
        buildJsonApiRequest(
          `http://localhost:3000/api/v1/projects/${projectB.id}`,
          'DELETE',
          staffToken,
        ),
      );
      expect(delOkRes.status).toBe(200);

      const getDeletedRes = await getProjectDetailRoute(
        buildJsonApiRequest(
          `http://localhost:3000/api/v1/projects/${projectB.id}`,
          'GET',
          staffToken,
        ),
      );
      expect(getDeletedRes.status).toBe(404);
    } finally {
      spyCtx.mockRestore();
      vi.unstubAllEnvs();
    }
  });

  it('2. 原価6費目全区分CRUD（税区分混在・見出し行）・基準日C3制御・仕入伝票からの重複防止転記検証', async () => {
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
      // 2-1. 経費(EXPENSE): 外税A・軽減B・非課税C・内税D・見出し行混在作成
      const expCreateRes = await postProjectCostsRoute(
        buildJsonApiRequest('http://localhost:3000/api/v1/project-costs', 'POST', staffToken, {
          projectId: mainProjectId,
          costCategory: 'EXPENSE',
          slipTitle: '現場交通費・飲食物・事務雑費',
          entryDate: '2026-06-18',
          status: 'C3',
          roundingMode: 'FLOOR',
          lines: [
            {
              productId: null,
              itemCode: null,
              itemName: '【諸経費内訳】',
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
              itemCode: 'E-10',
              itemName: '作業車高速道路料金(外10%)',
              unitName: '式',
              isHeading: false,
              quantity: 1,
              taxCode: 'A',
              masterUnitPrice: 10000,
              appliedUnitPrice: 10000,
              remarks: null,
            },
            {
              productId: null,
              itemCode: 'E-08',
              itemName: '現場飲料水(軽8%)',
              unitName: '箱',
              isHeading: false,
              quantity: 2,
              taxCode: 'B',
              masterUnitPrice: 5000,
              appliedUnitPrice: 5000,
              remarks: null,
            },
            {
              productId: null,
              itemCode: 'E-00',
              itemName: '印紙代(非課税)',
              unitName: '枚',
              isHeading: false,
              quantity: 1,
              taxCode: 'C',
              masterUnitPrice: 5000,
              appliedUnitPrice: 5000,
              remarks: null,
            },
            {
              productId: null,
              itemCode: 'E-IN',
              itemName: '駐車場代(内10%)',
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
      expect(expCreateRes.status).toBe(201);
      const expSlip = ((await expCreateRes.json()) as { ok: true; item: ProjectCostDetailDto }).item;
      // 税抜 = 10000 + 10000 + 5000 + 10000 = 35000, 税 = 1000 + 800 + 0 + 1000 = 2800, 税込 = 37800
      expect(expSlip.subtotalAmount).toBe(35000);
      expect(expSlip.taxTotal).toBe(2800);
      expect(expSlip.totalAmount).toBe(37800);

      // 2-2. EXPENSEをPUT更新して詳細取得確認
      const expPutRes = await putProjectCostRoute(
        buildJsonApiRequest(
          `http://localhost:3000/api/v1/project-costs/${expSlip.id}`,
          'PUT',
          staffToken,
          {
            projectId: mainProjectId,
            costCategory: 'EXPENSE',
            slipTitle: '現場交通費・飲食物・事務雑費(更新後)',
            entryDate: '2026-06-18',
            status: 'C3',
            roundingMode: 'FLOOR',
            lines: [
              {
                productId: null,
                itemCode: 'E-10',
                itemName: '作業車高速・駐車場一括',
                unitName: '式',
                isHeading: false,
                quantity: 1,
                taxCode: 'A',
                masterUnitPrice: 40000,
                appliedUnitPrice: 40000,
                remarks: '領収書突合済',
              },
            ],
          },
        ),
      );
      expect(expPutRes.status).toBe(200);
      const expDetailRes = await getProjectCostDetailRoute(
        buildJsonApiRequest(
          `http://localhost:3000/api/v1/project-costs/${expSlip.id}`,
          'GET',
          staffToken,
        ),
      );
      expect(expDetailRes.status).toBe(200);
      const expDetail = ((await expDetailRes.json()) as { ok: true; item: ProjectCostDetailDto }).item;
      expect(expDetail.subtotalAmount).toBe(40000);
      expect(expDetail.totalAmount).toBe(44000);

      // 2-3. 残り5費目（LABOR超過200,000円, MATERIAL 100,000円, OUTSOURCING 250,000円, TEMPORARY 50,000円, INDIRECT 30,000円）を登録
      // TEMPORARY / INDIRECT の個別フラグが false でも 'cost' が有効ならすべて登録可能であることを検証
      const restSpecs: Array<{
        costCategory: 'LABOR' | 'MATERIAL' | 'OUTSOURCING' | 'TEMPORARY' | 'INDIRECT';
        slipTitle: string;
        price: number;
      }> = [
        { costCategory: 'LABOR', slipTitle: '自社電工施工人工(予算超過)', price: 200000 },
        { costCategory: 'MATERIAL', slipTitle: '制御盤・電線資材手配', price: 100000 },
        { costCategory: 'OUTSOURCING', slipTitle: 'ダクト施工外注費', price: 250000 },
        { costCategory: 'TEMPORARY', slipTitle: 'ローリングタワー仮設費', price: 50000 },
        { costCategory: 'INDIRECT', slipTitle: '産廃処分・現場管理費', price: 30000 },
      ];
      for (const spec of restSpecs) {
        const res = await postProjectCostsRoute(
          buildJsonApiRequest('http://localhost:3000/api/v1/project-costs', 'POST', staffToken, {
            projectId: mainProjectId,
            costCategory: spec.costCategory,
            slipTitle: spec.slipTitle,
            entryDate: '2026-06-20',
            status: 'C2',
            roundingMode: 'FLOOR',
            lines: [
              {
                productId: null,
                itemCode: null,
                itemName: spec.slipTitle,
                unitName: '式',
                isHeading: false,
                quantity: 1,
                taxCode: 'A',
                masterUnitPrice: spec.price,
                appliedUnitPrice: spec.price,
                remarks: null,
              },
            ],
          }),
        );
        expect(res.status).toBe(201);
      }

      // 2-4. 基準日(2026-05-31)以前の C3 確定計上・変更を拒否（COST_DATE_BEFORE_CUTOFF）
      const cutoffPostRes = await postProjectCostsRoute(
        buildJsonApiRequest('http://localhost:3000/api/v1/project-costs', 'POST', staffToken, {
          projectId: mainProjectId,
          costCategory: 'EXPENSE',
          slipTitle: '基準日以前C3テスト',
          entryDate: '2026-05-31',
          status: 'C3',
          roundingMode: 'FLOOR',
          lines: [
            {
              productId: null,
              itemCode: null,
              itemName: 'テスト費用',
              unitName: '式',
              isHeading: false,
              quantity: 1,
              taxCode: 'A',
              masterUnitPrice: 1000,
              appliedUnitPrice: 1000,
              remarks: null,
            },
          ],
        }),
      );
      expect(cutoffPostRes.status).toBe(400);
      const cutoffBody = (await cutoffPostRes.json()) as { ok: false; errorCode: string };
      expect(cutoffBody.errorCode).toBe('COST_DATE_BEFORE_CUTOFF');

      // 削除用C2伝票を作成→基準日C3更新拒否→DELETE成功検証
      const tmpRes = await postProjectCostsRoute(
        buildJsonApiRequest('http://localhost:3000/api/v1/project-costs', 'POST', staffToken, {
          projectId: mainProjectId,
          costCategory: 'EXPENSE',
          slipTitle: '一時C2伝票',
          entryDate: '2026-05-31',
          status: 'C2',
          roundingMode: 'FLOOR',
          lines: [
            {
              productId: null,
              itemCode: null,
              itemName: '削除用明細',
              unitName: '式',
              isHeading: false,
              quantity: 1,
              taxCode: 'A',
              masterUnitPrice: 5000,
              appliedUnitPrice: 5000,
              remarks: null,
            },
          ],
        }),
      );
      expect(tmpRes.status).toBe(201);
      const tmpSlip = ((await tmpRes.json()) as { ok: true; item: ProjectCostDetailDto }).item;

      const cutoffPutRes = await putProjectCostRoute(
        buildJsonApiRequest(
          `http://localhost:3000/api/v1/project-costs/${tmpSlip.id}`,
          'PUT',
          staffToken,
          {
            projectId: mainProjectId,
            costCategory: 'EXPENSE',
            slipTitle: '一時C2伝票',
            entryDate: '2026-05-31',
            status: 'C3',
            roundingMode: 'FLOOR',
            lines: [
              {
                productId: null,
                itemCode: null,
                itemName: '削除用明細',
                unitName: '式',
                isHeading: false,
                quantity: 1,
                taxCode: 'A',
                masterUnitPrice: 5000,
                appliedUnitPrice: 5000,
                remarks: null,
              },
            ],
          },
        ),
      );
      expect(cutoffPutRes.status).toBe(400);
      expect(((await cutoffPutRes.json()) as { errorCode: string }).errorCode).toBe(
        'COST_DATE_BEFORE_CUTOFF',
      );

      const delCostRes = await deleteProjectCostRoute(
        buildJsonApiRequest(
          `http://localhost:3000/api/v1/project-costs/${tmpSlip.id}`,
          'DELETE',
          staffToken,
        ),
      );
      expect(delCostRes.status).toBe(200);

      // 2-5. 仕入伝票を作成して原価へ転記取込＆重複取込409ガード検証
      const purRes = await postPurchasesRoute(
        buildJsonApiRequest('http://localhost:3000/api/v1/purchases', 'POST', staffToken, {
          purchaseName: '第1工場用ダクト材仕入',
          purchaseDate: '2026-06-21',
          supplierId: supplierPartnerId,
          purchaseOrderId: null,
          honorific: '御中',
          status: 'P2',
          roundingMode: 'FLOOR',
          remarks: null,
          lines: [
            {
              projectId: mainProjectId,
              productId: null,
              itemCode: 'MAT-20',
              itemName: '亜鉛鉄板ダクト部材',
              unitName: '本',
              isHeading: false,
              quantity: 2,
              taxCode: 'A',
              masterUnitPrice: 25000,
              appliedUnitPrice: 25000,
              remarks: null,
            },
          ],
        }),
      );
      expect(purRes.status).toBe(201);
      const purchase = ((await purRes.json()) as { ok: true; item: PurchaseDetailDto }).item;

      const candBeforeRes = await getCostFromPurchaseCandidatesRoute(
        buildJsonApiRequest(
          `http://localhost:3000/api/v1/project-costs/from-purchase?projectId=${mainProjectId}`,
          'GET',
          staffToken,
        ),
      );
      expect(candBeforeRes.status).toBe(200);
      const candBeforeBody = (await candBeforeRes.json()) as {
        ok: true;
        items: CandidatePurchaseForCostDto[];
      };
      const foundCand = candBeforeBody.items.find((c) => c.purchaseId === purchase.id);
      expect(foundCand).toBeDefined();
      expect(foundCand!.isFullyImported).toBe(false);
      expect(foundCand!.matchingLineCount).toBe(1);

      const importCostRes = await postCostFromPurchaseRoute(
        buildJsonApiRequest(
          'http://localhost:3000/api/v1/project-costs/from-purchase',
          'POST',
          staffToken,
          {
            projectId: mainProjectId,
            purchaseId: purchase.id,
            costCategory: 'MATERIAL',
            slipTitle: '仕入取込: 亜鉛鉄板ダクト部材',
            entryDate: '2026-06-21',
            status: 'C2',
          },
        ),
      );
      expect(importCostRes.status).toBe(201);
      const importedCost = ((await importCostRes.json()) as { ok: true; item: ProjectCostDetailDto })
        .item;
      expect(importedCost.subtotalAmount).toBe(50000);
      expect(importedCost.taxTotal).toBe(5000);
      expect(importedCost.totalAmount).toBe(55000);
      expect(importedCost.lines[0]?.sourcePurchaseLineId).not.toBeNull();

      // 同一仕入の再取込は 409 PURCHASE_ALREADY_IMPORTED_TO_COST
      const dupImportRes = await postCostFromPurchaseRoute(
        buildJsonApiRequest(
          'http://localhost:3000/api/v1/project-costs/from-purchase',
          'POST',
          staffToken,
          {
            projectId: mainProjectId,
            purchaseId: purchase.id,
            costCategory: 'MATERIAL',
          },
        ),
      );
      expect(dupImportRes.status).toBe(409);
      expect(((await dupImportRes.json()) as { errorCode: string }).errorCode).toBe(
        'PURCHASE_ALREADY_IMPORTED_TO_COST',
      );
    } finally {
      spyCtx.mockRestore();
      vi.unstubAllEnvs();
    }
  });

  it('3. 工事台帳・6費目予実対比・CSV/日本語PDF出力3種・案件添付画像（権限403/マジックナンバー検証/並替/削除）検証', async () => {
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
      // 3-1. 工事台帳詳細取得＆予実対比検証
      // 実績(税抜): EXPENSE 40,000, LABOR 200,000(超過!), MATERIAL 150,000, OUTSOURCING 250,000, TEMPORARY 50,000, INDIRECT 30,000 -> 合計 720,000円 (税込 792,000円)
      const detailRes = await getProjectDetailRoute(
        buildJsonApiRequest(
          `http://localhost:3000/api/v1/projects/${mainProjectId}`,
          'GET',
          staffToken,
        ),
      );
      expect(detailRes.status).toBe(200);
      const detail = ((await detailRes.json()) as { ok: true; item: ProjectDetailDto }).item;

      expect(detail.actualCostExclTotal).toBe(720000);
      expect(detail.actualCostInclTotal).toBe(792000);
      expect(detail.actualCostEvalTotal).toBe(720000);
      expect(detail.budgetTotal).toBe(1180000);
      expect(detail.budgetVarianceTotal).toBe(460000);
      expect(detail.isOverBudget).toBe(false); // 総予算 1,180,000 > 総実績 720,000

      const laborComp = detail.categoryComparisons.find((c) => c.category === 'LABOR');
      expect(laborComp).toBeDefined();
      expect(laborComp!.budgetAmount).toBe(160000);
      expect(laborComp!.actualEvalAmount).toBe(200000);
      expect(laborComp!.varianceAmount).toBe(-40000);
      expect(laborComp!.isOverBudget).toBe(true); // 労務費費目は予算超過(125%)
      expect(laborComp!.consumptionRatePercent).toBe('125.0');

      // 原価一覧APIも6カテゴリ集計確認
      const costsListRes = await getProjectCostsRoute(
        buildJsonApiRequest(
          `http://localhost:3000/api/v1/project-costs?projectId=${mainProjectId}`,
          'GET',
          staffToken,
        ),
      );
      expect(costsListRes.status).toBe(200);
      const costsPage = (await costsListRes.json()) as { ok: true } & ProjectCostPageDto;
      expect(costsPage.summary.totalCount).toBe(7); // EXPENSE + 5 + purchase MATERIAL
      expect(costsPage.summary.subtotalAmount).toBe(720000);
      expect(costsPage.summary.totalAmount).toBe(792000);

      // 3-2. CSV & PDF 出力検証（工事一覧・工事台帳・原価一覧）
      const csvUrls = [
        'http://localhost:3000/api/v1/projects/export?format=csv',
        `http://localhost:3000/api/v1/projects/${mainProjectId}/ledger-export?format=csv`,
        `http://localhost:3000/api/v1/project-costs/export?format=csv&projectId=${mainProjectId}`,
      ];
      for (const u of csvUrls) {
        const res =
          u.includes('ledger-export')
            ? await exportProjectLedgerRoute(buildJsonApiRequest(u, 'GET', staffToken))
            : u.includes('project-costs')
              ? await exportProjectCostsRoute(buildJsonApiRequest(u, 'GET', staffToken))
              : await exportProjectsRoute(buildJsonApiRequest(u, 'GET', staffToken));
        expect(res.status).toBe(200);
        const buf = Buffer.from(await res.arrayBuffer());
        expect(buf.subarray(0, 3).equals(Buffer.from([0xef, 0xbb, 0xbf]))).toBe(true);
        const text = buf.toString('utf8');
        expect(text).toContain('第1工場 空調・電源設備改修工事');
      }

      const pdfUrls = [
        'http://localhost:3000/api/v1/projects/export?format=pdf',
        `http://localhost:3000/api/v1/projects/${mainProjectId}/ledger-export?format=pdf`,
        `http://localhost:3000/api/v1/project-costs/export?format=pdf&projectId=${mainProjectId}`,
      ];
      for (const u of pdfUrls) {
        const res =
          u.includes('ledger-export')
            ? await exportProjectLedgerRoute(buildJsonApiRequest(u, 'GET', staffToken))
            : u.includes('project-costs')
              ? await exportProjectCostsRoute(buildJsonApiRequest(u, 'GET', staffToken))
              : await exportProjectsRoute(buildJsonApiRequest(u, 'GET', staffToken));
        expect(res.status).toBe(200);
        expect(res.headers.get('content-type')).toBe('application/pdf');
        const bytes = new Uint8Array(await res.arrayBuffer());
        expect(Buffer.from(bytes.slice(0, 5)).toString('ascii')).toBe('%PDF-');
        const parsedPdf = await PDFDocument.load(bytes);
        expect(parsedPdf.getPageCount()).toBeGreaterThanOrEqual(1);
      }

      // 3-3. PROJECT 添付画像機能フラグ(403) -> 有効化 -> マジックナンバー検証・並替・削除
      const validPng = Uint8Array.from([
        0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d,
      ]);
      const validJpg = Uint8Array.from([
        0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46,
      ]);
      const spoofBytes = Uint8Array.from(Buffer.from('<svg>not-png</svg>', 'utf8'));

      // constructionimage=false の状態では 403 FEATURE_DISABLED
      const blockedRes = await postAttachmentsRoute(
        buildJsonApiRequest('http://localhost:3000/api/v1/attachments', 'POST', staffToken, {
          entityType: 'PROJECT',
          entityId: mainProjectId,
          originalName: 'site1.png',
          contentBase64: Buffer.from(validPng).toString('base64'),
          comment: '施工前',
        }),
      );
      expect(blockedRes.status).toBe(403);
      expect(((await blockedRes.json()) as { errorCode: string }).errorCode).toBe(
        'FEATURE_DISABLED',
      );

      // constructionimage=true を有効化
      await db.query(
        `UPDATE tenant_feature_authorities
            SET is_enabled = true
          WHERE tenant_id = $1 AND feature_code = 'constructionimage'`,
        [tenantId],
      );

      // 偽装ファイルは 400 INVALID_IMAGE_MAGIC_BYTES で拒否
      const spoofRes = await postAttachmentsRoute(
        buildJsonApiRequest('http://localhost:3000/api/v1/attachments', 'POST', staffToken, {
          entityType: 'PROJECT',
          entityId: mainProjectId,
          originalName: 'evil.png',
          contentBase64: Buffer.from(spoofBytes).toString('base64'),
          comment: null,
        }),
      );
      expect(spoofRes.status).toBe(400);
      expect(((await spoofRes.json()) as { errorCode: string }).errorCode).toBe(
        'INVALID_IMAGE_MAGIC_BYTES',
      );

      // PNG 1枚目 & JPEG 2枚目アップロード
      const up1Res = await postAttachmentsRoute(
        buildJsonApiRequest('http://localhost:3000/api/v1/attachments', 'POST', staffToken, {
          entityType: 'PROJECT',
          entityId: mainProjectId,
          originalName: 'site-before.png',
          contentBase64: Buffer.from(validPng).toString('base64'),
          comment: '施工前写真',
        }),
      );
      expect(up1Res.status).toBe(201);
      const att1 = ((await up1Res.json()) as { ok: true; item: AttachmentDto }).item;
      expect(att1.storageKey.startsWith(`${tenantId}/projects/${mainProjectId}/`)).toBe(true);
      expect(att1.mimeType).toBe('image/png');
      expect(att1.sortOrder).toBe(1);

      const up2Res = await postAttachmentsRoute(
        buildJsonApiRequest('http://localhost:3000/api/v1/attachments', 'POST', staffToken, {
          entityType: 'PROJECT',
          entityId: mainProjectId,
          originalName: 'site-after.jpg',
          contentBase64: Buffer.from(validJpg).toString('base64'),
          comment: '施工後',
        }),
      );
      expect(up2Res.status).toBe(201);
      const att2 = ((await up2Res.json()) as { ok: true; item: AttachmentDto }).item;
      expect(att2.mimeType).toBe('image/jpeg');
      expect(att2.sortOrder).toBe(2);

      // PATCH で att2 のコメント更新＋UP並替
      const patchRes = await patchAttachmentRoute(
        buildJsonApiRequest(
          `http://localhost:3000/api/v1/attachments/${att2.id}`,
          'PATCH',
          staffToken,
          { comment: '配管完了', moveDirection: 'UP' },
        ),
      );
      expect(patchRes.status).toBe(200);
      const patchedAtt2 = ((await patchRes.json()) as { ok: true; item: AttachmentDto }).item;
      expect(patchedAtt2.sortOrder).toBe(1);
      expect(patchedAtt2.comment).toBe('配管完了');

      // DELETE で att1 を削除し、一覧取得で 1件残ることを確認
      const delAttRes = await deleteAttachmentRoute(
        buildJsonApiRequest(
          `http://localhost:3000/api/v1/attachments/${att1.id}`,
          'DELETE',
          staffToken,
        ),
      );
      expect(delAttRes.status).toBe(200);

      const listAttRes = await getAttachmentsRoute(
        buildJsonApiRequest(
          `http://localhost:3000/api/v1/attachments?entityType=PROJECT&entityId=${mainProjectId}`,
          'GET',
          staffToken,
        ),
      );
      expect(listAttRes.status).toBe(200);
      const listAttBody = (await listAttRes.json()) as { ok: true; items: AttachmentDto[] };
      expect(listAttBody.items).toHaveLength(1);
      expect(listAttBody.items[0]!.id).toBe(att2.id);
    } finally {
      spyCtx.mockRestore();
      vi.unstubAllEnvs();
    }
  });

  it('4. 税抜/税込原価基準（cost_tax_mode）切替時の工事粗利・予実計算と calculations.ts 完全一致検証', async () => {
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
      // 4-1. TAX_EXCLUDED モード検証
      const exclDetailRes = await getProjectDetailRoute(
        buildJsonApiRequest(
          `http://localhost:3000/api/v1/projects/${mainProjectId}`,
          'GET',
          staffToken,
        ),
      );
      expect(exclDetailRes.status).toBe(200);
      const exclDetail = ((await exclDetailRes.json()) as { ok: true; item: ProjectDetailDto }).item;
      expect(exclDetail.costTaxMode).toBe('TAX_EXCLUDED');

      const expectedExcl = calculateProjectProfit({
        costTaxMode: 'TAX_EXCLUDED',
        contractSubtotal: BigInt(exclDetail.contractSubtotal),
        contractTotal: BigInt(exclDetail.contractTotal),
        budgets: {
          EXPENSE: BigInt(exclDetail.budgets.EXPENSE),
          LABOR: BigInt(exclDetail.budgets.LABOR),
          MATERIAL: BigInt(exclDetail.budgets.MATERIAL),
          OUTSOURCING: BigInt(exclDetail.budgets.OUTSOURCING),
          TEMPORARY: BigInt(exclDetail.budgets.TEMPORARY),
          INDIRECT: BigInt(exclDetail.budgets.INDIRECT),
        },
        actualCostsExcl: {
          EXPENSE: BigInt(exclDetail.categoryComparisons[0]!.actualExclAmount),
          LABOR: BigInt(exclDetail.categoryComparisons[1]!.actualExclAmount),
          MATERIAL: BigInt(exclDetail.categoryComparisons[2]!.actualExclAmount),
          OUTSOURCING: BigInt(exclDetail.categoryComparisons[3]!.actualExclAmount),
          TEMPORARY: BigInt(exclDetail.categoryComparisons[4]!.actualExclAmount),
          INDIRECT: BigInt(exclDetail.categoryComparisons[5]!.actualExclAmount),
        },
        actualCostsIncl: {
          EXPENSE: BigInt(exclDetail.categoryComparisons[0]!.actualInclAmount),
          LABOR: BigInt(exclDetail.categoryComparisons[1]!.actualInclAmount),
          MATERIAL: BigInt(exclDetail.categoryComparisons[2]!.actualInclAmount),
          OUTSOURCING: BigInt(exclDetail.categoryComparisons[3]!.actualInclAmount),
          TEMPORARY: BigInt(exclDetail.categoryComparisons[4]!.actualInclAmount),
          INDIRECT: BigInt(exclDetail.categoryComparisons[5]!.actualInclAmount),
        },
      });
      expect(exclDetail.actualCostEvalTotal).toBe(Number(expectedExcl.actualCostTotal)); // 720,000
      expect(exclDetail.actualGrossProfit).toBe(Number(expectedExcl.actualGrossProfit)); // 2,050,000 - 720,000 = 1,330,000
      expect(exclDetail.budgetGrossProfit).toBe(Number(expectedExcl.budgetGrossProfit)); // 2,050,000 - 1,180,000 = 870,000
      expect(exclDetail.actualGrossMarginPercent).toBe(expectedExcl.actualGrossMarginPercent);

      // 4-2. TAX_INCLUDED モードへ切替検証
      await db.query(
        `UPDATE tenant_settings SET cost_tax_mode = 'TAX_INCLUDED' WHERE tenant_id = $1`,
        [tenantId],
      );

      const inclDetailRes = await getProjectDetailRoute(
        buildJsonApiRequest(
          `http://localhost:3000/api/v1/projects/${mainProjectId}`,
          'GET',
          staffToken,
        ),
      );
      expect(inclDetailRes.status).toBe(200);
      const inclDetail = ((await inclDetailRes.json()) as { ok: true; item: ProjectDetailDto }).item;
      expect(inclDetail.costTaxMode).toBe('TAX_INCLUDED');

      const inclListRes = await getProjectsRoute(
        buildJsonApiRequest('http://localhost:3000/api/v1/projects', 'GET', staffToken),
      );
      expect(inclListRes.status).toBe(200);
      const inclList = (await inclListRes.json()) as { ok: true } & ProjectPageDto;
      expect(inclList.costTaxMode).toBe('TAX_INCLUDED');

      const expectedIncl = calculateProjectProfit({
        costTaxMode: 'TAX_INCLUDED',
        contractSubtotal: BigInt(inclDetail.contractSubtotal),
        contractTotal: BigInt(inclDetail.contractTotal),
        budgets: {
          EXPENSE: BigInt(inclDetail.budgets.EXPENSE),
          LABOR: BigInt(inclDetail.budgets.LABOR),
          MATERIAL: BigInt(inclDetail.budgets.MATERIAL),
          OUTSOURCING: BigInt(inclDetail.budgets.OUTSOURCING),
          TEMPORARY: BigInt(inclDetail.budgets.TEMPORARY),
          INDIRECT: BigInt(inclDetail.budgets.INDIRECT),
        },
        actualCostsExcl: {
          EXPENSE: BigInt(inclDetail.categoryComparisons[0]!.actualExclAmount),
          LABOR: BigInt(inclDetail.categoryComparisons[1]!.actualExclAmount),
          MATERIAL: BigInt(inclDetail.categoryComparisons[2]!.actualExclAmount),
          OUTSOURCING: BigInt(inclDetail.categoryComparisons[3]!.actualExclAmount),
          TEMPORARY: BigInt(inclDetail.categoryComparisons[4]!.actualExclAmount),
          INDIRECT: BigInt(inclDetail.categoryComparisons[5]!.actualExclAmount),
        },
        actualCostsIncl: {
          EXPENSE: BigInt(inclDetail.categoryComparisons[0]!.actualInclAmount),
          LABOR: BigInt(inclDetail.categoryComparisons[1]!.actualInclAmount),
          MATERIAL: BigInt(inclDetail.categoryComparisons[2]!.actualInclAmount),
          OUTSOURCING: BigInt(inclDetail.categoryComparisons[3]!.actualInclAmount),
          TEMPORARY: BigInt(inclDetail.categoryComparisons[4]!.actualInclAmount),
          INDIRECT: BigInt(inclDetail.categoryComparisons[5]!.actualInclAmount),
        },
      });
      // 税込契約 2,255,000 - 税込原価 792,000 = 1,463,000
      expect(inclDetail.actualCostEvalTotal).toBe(Number(expectedIncl.actualCostTotal));
      expect(inclDetail.actualGrossProfit).toBe(Number(expectedIncl.actualGrossProfit));
      expect(inclDetail.budgetGrossProfit).toBe(Number(expectedIncl.budgetGrossProfit));
      expect(inclDetail.actualGrossMarginPercent).toBe(expectedIncl.actualGrossMarginPercent);
      expect(inclList.summary.actualCostEvalTotal).toBe(inclDetail.actualCostEvalTotal);
      expect(inclList.summary.actualGrossProfit).toBe(inclDetail.actualGrossProfit);
    } finally {
      spyCtx.mockRestore();
      vi.unstubAllEnvs();
    }
  });
});
