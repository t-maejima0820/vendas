import fs from 'node:fs';
import path from 'node:path';
import { PGlite } from '@electric-sql/pglite';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { GET as getEmployeesRoute, POST as postEmployeesRoute } from '@/app/api/v1/masters/employees/route';
import { PATCH as patchEmployeeRoute, PUT as putEmployeeRoute } from '@/app/api/v1/masters/employees/[id]/route';
import { GET as getLookupsRoute } from '@/app/api/v1/masters/lookups/route';
import { GET as getPartnersRoute, POST as postPartnersRoute } from '@/app/api/v1/masters/partners/route';
import { GET as getPartnerDetailRoute, PUT as putPartnerRoute } from '@/app/api/v1/masters/partners/[id]/route';
import { GET as getProductsRoute, POST as postProductsRoute } from '@/app/api/v1/masters/products/route';
import {
  GET as getRepresentativesRoute,
  POST as postRepRoute,
} from '@/app/api/v1/masters/representatives/route';
import { DELETE as deleteRepByIdRoute, PUT as putRepByIdRoute } from '@/app/api/v1/masters/representatives/[id]/route';
import {
  authenticateLogin,
  SessionRevokedError,
  verifyActiveSessionInDb,
} from '@/lib/auth/auth-service';
import { epochSeconds } from '@/lib/auth/session';
import { hashPassword, isEncryptedField } from '@/lib/crypto/field-cipher';
import { withExecutorTenantContext, type DbExecutor } from '@/lib/db/tenant-client';
import { getMasterLookups } from '@/lib/masters/lookups-service';
import { createBusinessPartner } from '@/lib/masters/partners-service';
import { createProduct, updateProduct } from '@/lib/masters/products-service';
import {
  createRepresentative,
  deleteRepresentative,
  listRepresentatives,
  updateRepresentative,
} from '@/lib/masters/representatives-service';
import {
  listEmployees,
  updateEmployee,
} from '@/lib/masters/employees-service';
import type { BusinessPartnerInput, CreateEmployeeInput, ProductInput } from '@/lib/masters/types';

const TEST_ENC_KEY = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';
const TEST_SESSION_SECRET = 'phase1b-test-session-secret-0123456789abcdef';

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

function buildApiRequest(
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

describe('Phase 1-B 基幹4マスタ CRUD・暗号化・権限・セッション連動テスト', () => {
  let db: PGlite;
  let exec: DbExecutor;

  const tenantId = '44444444-4444-4333-8333-444444444444';
  const tenantSlug = 'phase1b-corp';
  const adminEmpId = 'aaaa1111-4444-4333-8333-444444444444';
  const staffEmpId = 'bbbb2222-4444-4333-8333-444444444444';

  let bankId = '';
  let taxOfficeId = '';
  let adminToken = '';
  let staffToken = '';

  beforeAll(async () => {
    db = new PGlite();
    exec = createPgliteExecutor(db);

    const rootDir = process.cwd();
    await db.exec(fs.readFileSync(path.join(rootDir, 'supabase', 'migrations', '0001_schema.sql'), 'utf8'));
    await db.exec(fs.readFileSync(path.join(rootDir, 'supabase', 'migrations', '0002_rls_policies.sql'), 'utf8'));
    await db.exec(fs.readFileSync(path.join(rootDir, 'supabase', 'migrations', '0003_auth_security.sql'), 'utf8'));
    await db.exec(fs.readFileSync(path.join(rootDir, 'supabase', 'seed', 'default_codes.sql'), 'utf8'));

    await db.query(
      `INSERT INTO tenants (id, tenant_slug, tenant_name) VALUES ($1, $2, 'フェーズ1B商事株式会社')`,
      [tenantId, tenantSlug],
    );
    await db.query(
      `INSERT INTO tenant_settings (tenant_id, company_code, company_name, opening_balance_date)
       VALUES ($1, '9010', 'フェーズ1B商事株式会社', '2026-06-01')`,
      [tenantId],
    );
    await db.query('SELECT seed_tenant_defaults($1)', [tenantId]);

    const bankRows = await db.query<{ id: string }>(
      `INSERT INTO banks (tenant_id, bank_code, bank_name, furigana)
       VALUES ($1, '0001', 'テストみずほ銀行', 'テストミズホ')
       RETURNING id`,
      [tenantId],
    );
    const firstBank = bankRows.rows[0];
    if (firstBank === undefined) throw new Error('bank insert failed');
    bankId = firstBank.id;

    await db.query(
      `INSERT INTO bank_branches (tenant_id, bank_id, bank_code, branch_code, branch_name, furigana)
       VALUES ($1, $2, '0001', '001', '東京営業部', 'トウキョウ')`,
      [tenantId, bankId],
    );

    const taxOffRows = await db.query<{ id: string }>(
      `INSERT INTO tax_offices (tenant_id, tax_office_code, tax_office_name, tax_office_no)
       VALUES ($1, '01101', '麹町税務署', '101')
       RETURNING id`,
      [tenantId],
    );
    const firstTaxOff = taxOffRows.rows[0];
    if (firstTaxOff === undefined) throw new Error('tax_office insert failed');
    taxOfficeId = firstTaxOff.id;

    await db.query(
      `INSERT INTO employees (id, tenant_id, syain_code, syain_name, password_hash, is_admin, must_change_password)
       VALUES
         ($1, $2, '900', '検証管理者', $3, true, false),
         ($4, $2, '100', '検証一般',   $5, false, false)`,
      [
        adminEmpId,
        tenantId,
        hashPassword('AdminPass2026!'),
        staffEmpId,
        hashPassword('StaffPass2026!'),
      ],
    );

    const adminLogin = await authenticateLogin(exec, {
      tenantSlug,
      syainCode: '900',
      password: 'AdminPass2026!',
      clientIp: '127.0.0.1',
      sessionSecretOverride: TEST_SESSION_SECRET,
    });
    adminToken = adminLogin.token;

    const staffLogin = await authenticateLogin(exec, {
      tenantSlug,
      syainCode: '100',
      password: 'StaffPass2026!',
      clientIp: '127.0.0.1',
      sessionSecretOverride: TEST_SESSION_SECRET,
    });
    staffToken = staffLogin.token;
  });

  afterAll(async () => {
    await db.close();
  });

  it('1. Lookup Service/API: 単位25・税区分5・支払方法9・銀行支店・旧ti_*補完区分が取得できること', async () => {
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
      const lookups = await withExecutorTenantContext(
        exec,
        { tenantId, employeeId: staffEmpId, role: 'vendas_app' },
        async (tx) => getMasterLookups(tx),
      );
      expect(lookups.openingBalanceDate).toBe('2026-06-01');
      expect(lookups.units).toHaveLength(25);
      expect(lookups.taxCodes).toHaveLength(5);
      expect(lookups.paymentMethods).toHaveLength(9);
      expect(lookups.banks).toHaveLength(1);
      expect(lookups.bankBranches).toHaveLength(1);
      expect(lookups.taxOffices).toHaveLength(1);
      expect(lookups.categories.length).toBeGreaterThanOrEqual(6);
      expect(lookups.payrollClosingDays.length).toBeGreaterThanOrEqual(7);
      expect(lookups.consumptionTaxTypes.length).toBeGreaterThanOrEqual(11);

      const apiRes = await getLookupsRoute(
        buildApiRequest('http://localhost:3000/api/v1/masters/lookups', 'GET', staffToken),
      );
      expect(apiRes.status).toBe(200);
      const apiBody = (await apiRes.json()) as { ok: boolean; lookups: { units: unknown[] } };
      expect(apiBody.ok).toBe(true);
      expect(apiBody.lookups.units).toHaveLength(25);
    } finally {
      spyCtx.mockRestore();
      vi.unstubAllEnvs();
    }
  });

  it('2. 代表者マスタ: CRUD、コード重複409、取引先参照中の削除409、参照解除後の削除成功', async () => {
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
      // Create via API
      const createRes1 = await postRepRoute(
        buildApiRequest('http://localhost:3000/api/v1/masters/representatives', 'POST', staffToken, {
          representativeCode: 10,
          representativeName: '山田 太郎',
          furigana: 'ヤマダ タロウ',
          genderCode: 'S1',
        }),
      );
      expect(createRes1.status).toBe(201);
      const rep1 = ((await createRes1.json()) as { item: { id: string } }).item;

      // Duplicate code -> 409 sanitized
      const dupRes = await postRepRoute(
        buildApiRequest('http://localhost:3000/api/v1/masters/representatives', 'POST', staffToken, {
          representativeCode: 10,
          representativeName: '重複 太郎',
        }),
      );
      expect(dupRes.status).toBe(409);
      const dupText = await dupRes.text();
      expect(dupText).not.toContain('SQLSTATE');
      expect(dupText).not.toContain('representatives_tenant_id');

      // Update
      const updated = await withExecutorTenantContext(
        exec,
        { tenantId, employeeId: staffEmpId, role: 'vendas_app' },
        async (tx) =>
          updateRepresentative(tx, rep1.id, {
            representativeCode: 10,
            representativeName: '山田 太郎（更新）',
            furigana: 'ヤマダ タロウ',
            postalCode: '100-0001',
            address1: '東京都千代田区',
            address2: null,
            tel: '03-1111-2222',
            mobile: null,
            birthDate: '1980-04-01',
            genderCode: 'S1',
          }),
      );
      expect(updated.representativeName).toBe('山田 太郎（更新）');

      // Reference rep1 from partner
      const partner = await withExecutorTenantContext(
        exec,
        { tenantId, employeeId: adminEmpId, role: 'vendas_app' },
        async (tx) =>
          createBusinessPartner(
            tx,
            tenantId,
            {
              partnerCode: 'BP-REF-01',
              categoryCode: '2',
              stateCode: 'B',
              partnerName: '参照先テスト株式会社',
              furigana: null,
              representativeId: rep1.id,
              isIndividualHonorific: false,
              postalCode: null,
              address1: null,
              address2: null,
              tel: null,
              isClient: true,
              isSupplier: false,
              isAplusEnabled: false,
              sendMailEnabled: false,
              email: null,
              estimateMailTo: null,
              estimateMailCc: null,
              billMailTo: null,
              billMailCc: null,
              invoiceNo: null,
              billingDestinationName: null,
              closingDayCode: 'D',
              collectionDayCode: '1',
              receiptMethodCode: 'D',
              paymentMethodCode: null,
              assignedEmployeeId: staffEmpId,
              openingArBalance: 0,
              openingApBalance: 0,
              bankCode: null,
              branchCode: null,
              bankAccountType: null,
              bankAccountNo: null,
              bankAccountHolder: null,
              isDeleted: false,
              advisoryProfile: null,
            },
            { isAdmin: true, encKeyHex: TEST_ENC_KEY },
          ),
      );
      expect(partner.representativeId).toBe(rep1.id);

      // Delete while referenced -> 409 REPRESENTATIVE_IN_USE
      const delInUseRes = await deleteRepByIdRoute(
        buildApiRequest(
          `http://localhost:3000/api/v1/masters/representatives/${rep1.id}`,
          'DELETE',
          staffToken,
        ),
      );
      expect(delInUseRes.status).toBe(409);
      const delInUseBody = (await delInUseRes.json()) as { errorCode: string };
      expect(delInUseBody.errorCode).toBe('REPRESENTATIVE_IN_USE');

      // Unreferenced rep -> create & delete succeeds
      const rep2 = await withExecutorTenantContext(
        exec,
        { tenantId, employeeId: staffEmpId, role: 'vendas_app' },
        async (tx) =>
          createRepresentative(tx, tenantId, {
            representativeCode: 11,
            representativeName: '削除可能 代表',
            furigana: null,
            postalCode: null,
            address1: null,
            address2: null,
            tel: null,
            mobile: null,
            birthDate: null,
            genderCode: null,
          }),
      );
      await withExecutorTenantContext(
        exec,
        { tenantId, employeeId: staffEmpId, role: 'vendas_app' },
        async (tx) => deleteRepresentative(tx, rep2.id),
      );
      const repsAfter = await withExecutorTenantContext(
        exec,
        { tenantId, employeeId: staffEmpId, role: 'vendas_app' },
        async (tx) => listRepresentatives(tx),
      );
      expect(repsAfter.find((r) => r.id === rep2.id)).toBeUndefined();
    } finally {
      spyCtx.mockRestore();
      vi.unstubAllEnvs();
    }
  });

  it('3. 取引先＋顧問プロファイル: ACID保存・4暗号化列(enc:v1)・非管理者期首残高403ブロック・重複409', async () => {
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
      const basePartnerPayload: BusinessPartnerInput = {
        partnerCode: 'CUST-1001',
        categoryCode: '2',
        stateCode: 'B',
        partnerName: 'シークレット建設株式会社',
        furigana: 'シークレットケンセツ',
        representativeId: null,
        isIndividualHonorific: false,
        postalCode: '102-0083',
        address1: '東京都千代田区麹町1-1',
        address2: null,
        tel: '03-9999-0001',
        isClient: true,
        isSupplier: true,
        isAplusEnabled: true,
        sendMailEnabled: true,
        email: 'billing@example.com',
        estimateMailTo: 'est@example.com',
        estimateMailCc: null,
        billMailTo: 'bill@example.com',
        billMailCc: null,
        invoiceNo: 'T1234567890123',
        billingDestinationName: null,
        closingDayCode: 'D',
        collectionDayCode: '1',
        receiptMethodCode: 'H',
        paymentMethodCode: 'D',
        assignedEmployeeId: staffEmpId,
        openingArBalance: 500000,
        openingApBalance: 120000,
        bankCode: '0001',
        branchCode: '001',
        bankAccountType: 'B1',
        bankAccountNo: '1234567',
        bankAccountHolder: 'シークレットケンセツ(カ',
        isDeleted: false,
        advisoryProfile: {
          corporateNo: '1234567890123',
          establishedAtText: '2010年4月',
          businessDescription: '総合建設業',
          capitalText: '1,000万円',
          fiscalClosingMonth: 3,
          advisoryFee: 55000,
          settlementFee: 220000,
          payrollClosingCode: 'D',
          payrollPayCode: 'E',
          laborInsuranceCode: 'B',
          socialInsuranceCode: 'B',
          laborInsuranceNo: '13-1-123456',
          employmentInsOfficeNo: '1301-123456-7',
          pensionOfficeNo: '13-アアア',
          pensionSerialNo: '001',
          taxOfficeId,
          taxOfficeSerialNo: '87654321',
          incomeTaxCode: 'B',
          consumptionTaxCode: 'B',
          residentTaxCode: 'B',
          taxTransferInfo: 'DIRECT-TAX-9988',
          laborBankAccount: 'LABOR-BANK-7766',
          socialBankAccount: 'SOCIAL-BANK-5544',
        },
      };

      // Non-admin trying to set non-zero opening balance -> 403
      const nonAdminCreateRes = await postPartnersRoute(
        buildApiRequest('http://localhost:3000/api/v1/masters/partners', 'POST', staffToken, basePartnerPayload),
      );
      expect(nonAdminCreateRes.status).toBe(403);
      const nonAdminCreateBody = (await nonAdminCreateRes.json()) as { errorCode: string };
      expect(nonAdminCreateBody.errorCode).toBe('ADMIN_REQUIRED_FOR_OPENING_BALANCE');

      // Admin creates partner + advisory profile atomically
      const adminCreateRes = await postPartnersRoute(
        buildApiRequest('http://localhost:3000/api/v1/masters/partners', 'POST', adminToken, basePartnerPayload),
      );
      expect(adminCreateRes.status).toBe(201);
      const createdBody = (await adminCreateRes.json()) as {
        item: {
          id: string;
          openingArBalance: number;
          openingApBalance: number;
          bankAccountNo: string;
          advisoryProfile: {
            taxTransferInfo: string;
            laborBankAccount: string;
            socialBankAccount: string;
          };
        };
      };
      expect(createdBody.item.openingArBalance).toBe(500000);
      expect(createdBody.item.openingApBalance).toBe(120000);
      expect(createdBody.item.bankAccountNo).toBe('1234567');
      expect(createdBody.item.advisoryProfile.taxTransferInfo).toBe('DIRECT-TAX-9988');
      expect(createdBody.item.advisoryProfile.laborBankAccount).toBe('LABOR-BANK-7766');
      expect(createdBody.item.advisoryProfile.socialBankAccount).toBe('SOCIAL-BANK-5544');

      // Check raw DB columns are AES-256-GCM encrypted
      const rawBp = await db.query<{ bank_account_no_enc: string }>(
        `SELECT bank_account_no_enc FROM business_partners WHERE id = $1`,
        [createdBody.item.id],
      );
      expect(isEncryptedField(rawBp.rows[0]?.bank_account_no_enc ?? '')).toBe(true);

      const rawAdv = await db.query<{
        tax_transfer_info_enc: string;
        labor_bank_account_enc: string;
        social_bank_account_enc: string;
      }>(
        `SELECT tax_transfer_info_enc, labor_bank_account_enc, social_bank_account_enc
         FROM partner_advisory_profiles WHERE partner_id = $1`,
        [createdBody.item.id],
      );
      expect(isEncryptedField(rawAdv.rows[0]?.tax_transfer_info_enc ?? '')).toBe(true);
      expect(isEncryptedField(rawAdv.rows[0]?.labor_bank_account_enc ?? '')).toBe(true);
      expect(isEncryptedField(rawAdv.rows[0]?.social_bank_account_enc ?? '')).toBe(true);

      // Duplicate partner_code -> 409
      const dupRes = await postPartnersRoute(
        buildApiRequest('http://localhost:3000/api/v1/masters/partners', 'POST', adminToken, basePartnerPayload),
      );
      expect(dupRes.status).toBe(409);

      // Non-admin modifying opening_ar_balance -> 403
      const tamperRes = await putPartnerRoute(
        buildApiRequest(
          `http://localhost:3000/api/v1/masters/partners/${createdBody.item.id}`,
          'PUT',
          staffToken,
          { ...basePartnerPayload, openingArBalance: 999999 },
        ),
      );
      expect(tamperRes.status).toBe(403);

      // Non-admin updating normal fields WITHOUT changing opening balances -> 200 and balances preserved!
      const staffNormalUpdateRes = await putPartnerRoute(
        buildApiRequest(
          `http://localhost:3000/api/v1/masters/partners/${createdBody.item.id}`,
          'PUT',
          staffToken,
          {
            ...basePartnerPayload,
            tel: '03-9999-8888',
            openingArBalance: undefined,
            openingApBalance: undefined,
          },
        ),
      );
      expect(staffNormalUpdateRes.status).toBe(200);
      const detail = await getPartnerDetailRoute(
        buildApiRequest(
          `http://localhost:3000/api/v1/masters/partners/${createdBody.item.id}`,
          'GET',
          staffToken,
        ),
      );
      expect(detail.status).toBe(200);
      const detailJson = (await detail.json()) as {
        item: { tel: string; openingArBalance: number; openingApBalance: number };
      };
      expect(detailJson.item.tel).toBe('03-9999-8888');
      expect(detailJson.item.openingArBalance).toBe(500000);
      expect(detailJson.item.openingApBalance).toBe(120000);

      // Verify search filter works
      const listRes = await getPartnersRoute(
        buildApiRequest('http://localhost:3000/api/v1/masters/partners?q=シークレット&role=APLUS', 'GET', staffToken),
      );
      expect(listRes.status).toBe(200);
      const listJson = (await listRes.json()) as { items: Array<{ id: string }> };
      expect(listJson.items.some((p) => p.id === createdBody.item.id)).toBe(true);
    } finally {
      spyCtx.mockRestore();
      vi.unstubAllEnvs();
    }
  });

  it('4. 商品マスタ: 3単価・単位・税区分・見出し/定額フラグのCRUD＆絞り込み＆重複409', async () => {
    vi.stubEnv('SESSION_SECRET', TEST_SESSION_SECRET);
    const modTenant = await import('@/lib/db/tenant-client');
    const spyCtx = vi.spyOn(modTenant, 'withTenantContext').mockImplementation(async (sess, fn) =>
      withExecutorTenantContext(
        exec,
        { tenantId: sess.tenantId, employeeId: sess.employeeId, role: 'vendas_app' },
        fn,
      ),
    );
    try {
      const lookups = await withExecutorTenantContext(
        exec,
        { tenantId, employeeId: staffEmpId, role: 'vendas_app' },
        async (tx) => getMasterLookups(tx),
      );
      const unitB = lookups.units.find((u) => u.unitCode === 'B');
      expect(unitB).toBeDefined();

      const productInput: ProductInput = {
        productCode: 'PRD-001',
        productName: '保守サービス月額',
        productNameSub: 'スタンダードプラン',
        monthFlagCode: 'B',
        capacity: 1,
        unitId: unitB?.id ?? null,
        standardUnitPrice: 30000,
        standardPurchasePrice: 15000,
        standardCostPrice: 12000,
        defaultTaxCode: 'A',
        itemCategoryCode: '5',
        kubun: 'SUB',
        isStockManaged: false,
        stockQuantity: 0,
        isSubscriptionTarget: true,
        isHeading: false,
        isDeleted: false,
      };

      const postRes = await postProductsRoute(
        buildApiRequest('http://localhost:3000/api/v1/masters/products', 'POST', staffToken, productInput),
      );
      expect(postRes.status).toBe(201);
      const created = ((await postRes.json()) as { item: { id: string; unitName: string; standardUnitPrice: number } }).item;
      expect(created.unitName).toBe('式');
      expect(created.standardUnitPrice).toBe(30000);

      // Heading item
      await withExecutorTenantContext(
        exec,
        { tenantId, employeeId: staffEmpId, role: 'vendas_app' },
        async (tx) =>
          createProduct(tx, tenantId, {
            ...productInput,
            productCode: 'HEAD-001',
            productName: '【第一工事項目】',
            standardUnitPrice: 0,
            standardPurchasePrice: 0,
            standardCostPrice: 0,
            isSubscriptionTarget: false,
            isHeading: true,
          }),
      );

      const dupRes = await postProductsRoute(
        buildApiRequest('http://localhost:3000/api/v1/masters/products', 'POST', staffToken, productInput),
      );
      expect(dupRes.status).toBe(409);

      const headingListRes = await getProductsRoute(
        buildApiRequest('http://localhost:3000/api/v1/masters/products?headingOnly=true', 'GET', staffToken),
      );
      expect(headingListRes.status).toBe(200);
      const headings = ((await headingListRes.json()) as { items: Array<{ productCode: string }> }).items;
      expect(headings).toHaveLength(1);
      expect(headings[0]?.productCode).toBe('HEAD-001');

      const updated = await withExecutorTenantContext(
        exec,
        { tenantId, employeeId: staffEmpId, role: 'vendas_app' },
        async (tx) =>
          updateProduct(tx, created.id, {
            ...productInput,
            standardUnitPrice: 35000,
          }),
      );
      expect(updated.standardUnitPrice).toBe(35000);
    } finally {
      spyCtx.mockRestore();
      vi.unstubAllEnvs();
    }
  });

  it('5. 社員マスタ(管理者専用): 非管理者403・自己保護400・権限変更時のsession_version即時失効・PW初期化/ロック解除', async () => {
    vi.stubEnv('SESSION_SECRET', TEST_SESSION_SECRET);
    const modTenant = await import('@/lib/db/tenant-client');
    const spyCtx = vi.spyOn(modTenant, 'withTenantContext').mockImplementation(async (sess, fn) =>
      withExecutorTenantContext(
        exec,
        { tenantId: sess.tenantId, employeeId: sess.employeeId, role: 'vendas_app' },
        fn,
      ),
    );
    try {
      // Non-admin blocked by withApiHandler({ requireAdmin: true }) -> 403 ADMIN_REQUIRED
      const nonAdminListRes = await getEmployeesRoute(
        buildApiRequest('http://localhost:3000/api/v1/masters/employees', 'GET', staffToken),
      );
      expect(nonAdminListRes.status).toBe(403);
      const nonAdminPostRes = await postEmployeesRoute(
        buildApiRequest('http://localhost:3000/api/v1/masters/employees', 'POST', staffToken, {}),
      );
      expect(nonAdminPostRes.status).toBe(403);

      // Admin creates new employee -> must_change_password=true, session_version=1, no passwordHash in DTO
      const createBody: CreateEmployeeInput = {
        syainCode: '205',
        syainName: '新規 一般社員',
        kanaName: 'シンキ イッパン',
        initialPassword: 'InitPass2026!',
        isAdmin: false,
        menuType: 3,
        email: 'new205@example.com',
        joinedAt: '2026-04-01',
        birthDate: '1995-05-10',
        retiredAt: null,
        isRetired: false,
        genderCode: 'S2',
        postalCode: null,
        address1: null,
        address2: null,
        steadyJobNote: null,
        workExperience: null,
      };
      const createRes = await postEmployeesRoute(
        buildApiRequest('http://localhost:3000/api/v1/masters/employees', 'POST', adminToken, createBody),
      );
      expect(createRes.status).toBe(201);
      const createdJson = (await createRes.json()) as {
        item: {
          id: string;
          mustChangePassword: boolean;
          sessionVersion: number;
          passwordHash?: string;
        };
      };
      expect(createdJson.item.mustChangePassword).toBe(true);
      expect(createdJson.item.sessionVersion).toBe(1);
      expect('passwordHash' in createdJson.item).toBe(false);
      expect('password_hash' in createdJson.item).toBe(false);

      // Admin self-demotion and self-retire blocked -> 400
      const selfDemoteRes = await putEmployeeRoute(
        buildApiRequest(
          `http://localhost:3000/api/v1/masters/employees/${adminEmpId}`,
          'PUT',
          adminToken,
          {
            syainCode: '900',
            syainName: '検証管理者',
            isAdmin: false,
            menuType: 1,
            isRetired: false,
          },
        ),
      );
      expect(selfDemoteRes.status).toBe(400);
      expect(((await selfDemoteRes.json()) as { errorCode: string }).errorCode).toBe('CANNOT_DEMOTE_SELF');

      const selfRetireRes = await putEmployeeRoute(
        buildApiRequest(
          `http://localhost:3000/api/v1/masters/employees/${adminEmpId}`,
          'PUT',
          adminToken,
          {
            syainCode: '900',
            syainName: '検証管理者',
            isAdmin: true,
            menuType: 1,
            isRetired: true,
          },
        ),
      );
      expect(selfRetireRes.status).toBe(400);
      expect(((await selfRetireRes.json()) as { errorCode: string }).errorCode).toBe('CANNOT_RETIRE_SELF');

      // Changing staffEmpId's menuType increments session_version -> existing staff session immediately revoked!
      const updatedStaff = await withExecutorTenantContext(
        exec,
        { tenantId, employeeId: adminEmpId, role: 'vendas_app' },
        async (tx) =>
          updateEmployee(
            tx,
            staffEmpId,
            {
              syainCode: '100',
              syainName: '検証一般',
              kanaName: null,
              isAdmin: false,
              menuType: 2,
              email: null,
              joinedAt: null,
              birthDate: null,
              retiredAt: null,
              isRetired: false,
              genderCode: null,
              postalCode: null,
              address1: null,
              address2: null,
              steadyJobNote: null,
              workExperience: null,
            },
            adminEmpId,
          ),
      );
      expect(updatedStaff.sessionVersion).toBe(2);

      // Old staffToken (session_version=1) -> SessionRevokedError
      await expect(
        withExecutorTenantContext(
          exec,
          { tenantId, employeeId: staffEmpId, role: 'vendas_app' },
          async (tx) =>
            verifyActiveSessionInDb(tx, {
              tenantId,
              tenantSlug,
              employeeId: staffEmpId,
              syainCode: '100',
              isAdmin: false,
              menuType: 3,
              sessionVersion: 1,
              mustChangePassword: false,
              exp: epochSeconds() + 3600,
            }),
        ),
      ).rejects.toBeInstanceOf(SessionRevokedError);

      // Simulate 5 failed logins -> account locked, then admin unlocks via PATCH UNLOCK
      const lockNow = new Date('2026-06-10T10:00:00.000Z');
      for (let i = 0; i < 5; i++) {
        await expect(
          authenticateLogin(exec, {
            tenantSlug,
            syainCode: '205',
            password: 'WrongPassword123!',
            clientIp: '198.51.100.77',
            now: new Date(lockNow.getTime() + i * 1000),
            sessionSecretOverride: TEST_SESSION_SECRET,
          }),
        ).rejects.toThrow();
      }

      const listLocked = await withExecutorTenantContext(
        exec,
        { tenantId, employeeId: adminEmpId, role: 'vendas_app' },
        async (tx) => listEmployees(tx, { keyword: '205', includeRetired: true }),
      );
      expect(listLocked[0]?.lockedUntil).not.toBeNull();

      const unlockRes = await patchEmployeeRoute(
        buildApiRequest(
          `http://localhost:3000/api/v1/masters/employees/${createdJson.item.id}`,
          'PATCH',
          adminToken,
          { action: 'UNLOCK' },
        ),
      );
      expect(unlockRes.status).toBe(200);
      const unlockedItem = ((await unlockRes.json()) as { item: { lockedUntil: string | null; failedLoginCount: number } }).item;
      expect(unlockedItem.lockedUntil).toBeNull();
      expect(unlockedItem.failedLoginCount).toBe(0);

      // Admin resets password -> mustChangePassword=true & sessionVersion incremented, can log in with new password
      const resetRes = await patchEmployeeRoute(
        buildApiRequest(
          `http://localhost:3000/api/v1/masters/employees/${createdJson.item.id}`,
          'PATCH',
          adminToken,
          { action: 'RESET_PASSWORD', newPassword: 'ResetTemp2026!' },
        ),
      );
      expect(resetRes.status).toBe(200);
      const resetItem = ((await resetRes.json()) as { item: { mustChangePassword: boolean; sessionVersion: number } }).item;
      expect(resetItem.mustChangePassword).toBe(true);
      expect(resetItem.sessionVersion).toBe(2);

      const relogin = await authenticateLogin(exec, {
        tenantSlug,
        syainCode: '205',
        password: 'ResetTemp2026!',
        clientIp: '198.51.100.78',
        now: new Date(lockNow.getTime() + 60_000),
        sessionSecretOverride: TEST_SESSION_SECRET,
      });
      expect(relogin.session.mustChangePassword).toBe(true);
      expect(relogin.session.sessionVersion).toBe(2);

      // Verify GET /representatives and PUT /representatives/[id] work via API wrapper too
      const getRepsRes = await getRepresentativesRoute(
        buildApiRequest('http://localhost:3000/api/v1/masters/representatives?q=山田', 'GET', adminToken),
      );
      expect(getRepsRes.status).toBe(200);
      const repListJson = (await getRepsRes.json()) as { items: Array<{ id: string; representativeName: string }> };
      expect(repListJson.items.length).toBeGreaterThanOrEqual(1);
      const firstRep = repListJson.items[0];
      if (firstRep !== undefined) {
        const putRepRes = await putRepByIdRoute(
          buildApiRequest(
            `http://localhost:3000/api/v1/masters/representatives/${firstRep.id}`,
            'PUT',
            adminToken,
            { representativeCode: 10, representativeName: '山田 太郎（API更新）' },
          ),
        );
        expect(putRepRes.status).toBe(200);
      }
    } finally {
      spyCtx.mockRestore();
      vi.unstubAllEnvs();
    }
  });
});
