import fs from 'node:fs';
import path from 'node:path';
import { PGlite } from '@electric-sql/pglite';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { DELETE as deleteBankByIdRoute, PUT as putBankByIdRoute } from '@/app/api/v1/masters/banks/[id]/route';
import { DELETE as deleteBranchByIdRoute } from '@/app/api/v1/masters/banks/branches/[id]/route';
import {
  GET as getBranchesRoute,
  POST as postBranchesRoute,
} from '@/app/api/v1/masters/banks/branches/route';
import { GET as getBanksRoute, POST as postBanksRoute } from '@/app/api/v1/masters/banks/route';
import {
  DELETE as deleteCodeMasterRoute,
  PUT as putCodeMasterRoute,
} from '@/app/api/v1/masters/code-masters/[id]/route';
import {
  GET as getCodeMastersRoute,
  POST as postCodeMastersRoute,
} from '@/app/api/v1/masters/code-masters/route';
import {
  DELETE as deleteIntelRoute,
  PUT as putIntelRoute,
} from '@/app/api/v1/masters/intelligences/[id]/route';
import {
  GET as getIntelsRoute,
  POST as postIntelsRoute,
} from '@/app/api/v1/masters/intelligences/route';
import {
  DELETE as deleteMailTplRoute,
  PUT as putMailTplRoute,
} from '@/app/api/v1/masters/mail-templates/[id]/route';
import {
  GET as getMailTplsRoute,
  POST as postMailTplsRoute,
} from '@/app/api/v1/masters/mail-templates/route';
import {
  DELETE as deletePmRoute,
  PUT as putPmRoute,
} from '@/app/api/v1/masters/payment-methods/[id]/route';
import {
  GET as getPmsRoute,
  POST as postPmsRoute,
} from '@/app/api/v1/masters/payment-methods/route';
import { PUT as putTaxCodeRoute } from '@/app/api/v1/masters/tax-codes/[id]/route';
import { GET as getTaxCodesRoute } from '@/app/api/v1/masters/tax-codes/route';
import {
  DELETE as deleteTaxOfficeRoute,
  PUT as putTaxOfficeRoute,
} from '@/app/api/v1/masters/tax-offices/[id]/route';
import {
  GET as getTaxOfficesRoute,
  POST as postTaxOfficesRoute,
} from '@/app/api/v1/masters/tax-offices/route';
import { PUT as putUnitRoute } from '@/app/api/v1/masters/units/[id]/route';
import { GET as getUnitsRoute, POST as postUnitsRoute } from '@/app/api/v1/masters/units/route';
import { authenticateLogin } from '@/lib/auth/auth-service';
import { hashPassword } from '@/lib/crypto/field-cipher';
import { withExecutorTenantContext, type DbExecutor } from '@/lib/db/tenant-client';
import { getMasterLookups } from '@/lib/masters/lookups-service';
import { createBusinessPartner } from '@/lib/masters/partners-service';
import { CODE_MASTER_DOMAINS } from '@/lib/masters/types';

const TEST_ENC_KEY = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';
const TEST_SESSION_SECRET = 'phase1c-test-session-secret-0123456789abcdef';

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

describe('Phase 1-C 補助・区分マスタ全8領域 CRUD・保護・DB単一正本化テスト', () => {
  let db: PGlite;
  let exec: DbExecutor;

  const tenantId = '55555555-5555-4333-8333-555555555555';
  const tenantSlug = 'phase1c-corp';
  const adminEmpId = 'aaaa5555-5555-4333-8333-555555555555';
  const staffEmpId = 'bbbb6666-5555-4333-8333-555555555555';

  let adminToken = '';
  let staffToken = '';

  beforeAll(async () => {
    db = new PGlite();
    exec = createPgliteExecutor(db);

    const rootDir = process.cwd();
    await db.exec(fs.readFileSync(path.join(rootDir, 'supabase', 'migrations', '0001_schema.sql'), 'utf8'));
    await db.exec(fs.readFileSync(path.join(rootDir, 'supabase', 'migrations', '0002_rls_policies.sql'), 'utf8'));
    await db.exec(fs.readFileSync(path.join(rootDir, 'supabase', 'migrations', '0003_auth_security.sql'), 'utf8'));
    await db.exec(
      fs.readFileSync(path.join(rootDir, 'supabase', 'migrations', '0004_complete_code_masters_seed.sql'), 'utf8'),
    );
    await db.exec(fs.readFileSync(path.join(rootDir, 'supabase', 'seed', 'default_codes.sql'), 'utf8'));

    await db.query(
      `INSERT INTO tenants (id, tenant_slug, tenant_name) VALUES ($1, $2, 'フェーズ1C株式会社')`,
      [tenantId, tenantSlug],
    );
    await db.query(
      `INSERT INTO tenant_settings (tenant_id, company_code, company_name, opening_balance_date)
       VALUES ($1, '9020', 'フェーズ1C株式会社', '2026-06-01')`,
      [tenantId],
    );
    await db.query('SELECT seed_tenant_defaults($1)', [tenantId]);

    await db.query(
      `INSERT INTO employees (id, tenant_id, syain_code, syain_name, password_hash, is_admin, must_change_password)
       VALUES
         ($1, $2, '901', '検証管理者1C', $3, true, false),
         ($4, $2, '101', '検証一般1C',   $5, false, false)`,
      [
        adminEmpId,
        tenantId,
        hashPassword('AdminPass1C2026!'),
        staffEmpId,
        hashPassword('StaffPass1C2026!'),
      ],
    );

    adminToken = (
      await authenticateLogin(exec, {
        tenantSlug,
        syainCode: '901',
        password: 'AdminPass1C2026!',
        clientIp: '127.0.0.1',
        sessionSecretOverride: TEST_SESSION_SECRET,
      })
    ).token;

    staffToken = (
      await authenticateLogin(exec, {
        tenantSlug,
        syainCode: '101',
        password: 'StaffPass1C2026!',
        clientIp: '127.0.0.1',
        sessionSecretOverride: TEST_SESSION_SECRET,
      })
    ).token;
  }, 30_000);

  afterAll(async () => {
    await db.close();
  });

  it('1. 汎用区分全16ドメイン(105行)のDB単一正本化: seed_tenant_defaults生成とlookups-service直結確認', async () => {
    const cmDomainCounts = await withExecutorTenantContext(
      exec,
      { tenantId, employeeId: staffEmpId, role: 'vendas_app' },
      async (tx) =>
        tx.query<{ domain_key: string; cnt: number }>(
          `SELECT domain_key, COUNT(*)::int AS cnt FROM code_masters GROUP BY domain_key ORDER BY domain_key`,
          [],
        ),
    );
    expect(cmDomainCounts).toHaveLength(16);
    const total = cmDomainCounts.reduce((acc, r) => acc + Number(r.cnt), 0);
    expect(total).toBe(105);

    const lookups = await withExecutorTenantContext(
      exec,
      { tenantId, employeeId: staffEmpId, role: 'vendas_app' },
      async (tx) => getMasterLookups(tx),
    );
    expect(lookups.categories).toHaveLength(6);
    expect(lookups.itemClasses).toHaveLength(7); // ITEM_CLASS 9行のうち is_active=true は7行
    expect(lookups.billClosingDays).toHaveLength(4);
    expect(lookups.collectionDays).toHaveLength(2);
    expect(lookups.partnerStates).toHaveLength(8);
    expect(lookups.bankAccountTypes).toHaveLength(2);
    expect(lookups.genders).toHaveLength(2);
    expect(lookups.orderKinds).toHaveLength(4);
    expect(lookups.projectSubStatuses).toHaveLength(2);
    expect(lookups.monthFlags).toHaveLength(16);
    expect(lookups.payrollClosingDays).toHaveLength(7);
    expect(lookups.payrollPayDays).toHaveLength(9);
    expect(lookups.laborInsuranceStates).toHaveLength(8);
    expect(lookups.socialInsuranceStates).toHaveLength(6);
    expect(lookups.incomeTaxTypes).toHaveLength(5);
    expect(lookups.consumptionTaxTypes).toHaveLength(11);
    expect(lookups.residentTaxTypes).toHaveLength(4);
  });

  it('2. 銀行・支店マスタ: ページネーション検索、子支店あり銀行の削除409、銀行コード変更時の支店同期', async () => {
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
      const bRes = await postBanksRoute(
        buildApiRequest('http://localhost:3000/api/v1/masters/banks', 'POST', staffToken, {
          bankCode: '0005',
          bankName: '三菱UFJ銀行',
          furigana: 'ミツビシユーエフジェイ',
        }),
      );
      expect(bRes.status).toBe(201);
      const bank = ((await bRes.json()) as { item: { id: string } }).item;

      // Create 3 branches
      const branchIds: string[] = [];
      for (const [bCode, bName] of [
        ['001', '本店'],
        ['002', '丸の内支店'],
        ['003', '大手町支店'],
      ] as const) {
        const brRes = await postBranchesRoute(
          buildApiRequest('http://localhost:3000/api/v1/masters/banks/branches', 'POST', staffToken, {
            bankId: bank.id,
            branchCode: bCode,
            branchName: bName,
            furigana: null,
          }),
        );
        expect(brRes.status).toBe(201);
        branchIds.push(((await brRes.json()) as { item: { id: string } }).item.id);
      }

      // Pagination page 1 & page 2
      const p1 = await getBranchesRoute(
        buildApiRequest(
          `http://localhost:3000/api/v1/masters/banks/branches?bankId=${bank.id}&page=1&pageSize=2`,
          'GET',
          staffToken,
        ),
      );
      expect(p1.status).toBe(200);
      const p1Json = (await p1.json()) as { items: Array<{ branchCode: string }>; totalCount: number };
      expect(p1Json.totalCount).toBe(3);
      expect(p1Json.items).toHaveLength(2);

      const p2 = await getBranchesRoute(
        buildApiRequest(
          `http://localhost:3000/api/v1/masters/banks/branches?bankId=${bank.id}&page=2&pageSize=2`,
          'GET',
          staffToken,
        ),
      );
      const p2Json = (await p2.json()) as { items: Array<{ branchCode: string }> };
      expect(p2Json.items).toHaveLength(1);
      expect(p2Json.items[0]?.branchCode).toBe('003');

      // Delete bank with child branches -> 409 BANK_HAS_BRANCHES
      const delBankFail = await deleteBankByIdRoute(
        buildApiRequest(`http://localhost:3000/api/v1/masters/banks/${bank.id}`, 'DELETE', staffToken),
      );
      expect(delBankFail.status).toBe(409);
      expect(((await delBankFail.json()) as { errorCode: string }).errorCode).toBe('BANK_HAS_BRANCHES');

      // Update bankCode -> cascades to child bank_branches.bank_code
      const updBank = await putBankByIdRoute(
        buildApiRequest(`http://localhost:3000/api/v1/masters/banks/${bank.id}`, 'PUT', staffToken, {
          bankCode: '0009',
          bankName: '新銀行名',
          furigana: null,
        }),
      );
      expect(updBank.status).toBe(200);
      const listAfterUpd = await getBranchesRoute(
        buildApiRequest(
          `http://localhost:3000/api/v1/masters/banks/branches?bankId=${bank.id}&q=丸の内`,
          'GET',
          staffToken,
        ),
      );
      const updBranchList = (await listAfterUpd.json()) as { items: Array<{ bankCode: string }> };
      expect(updBranchList.items[0]?.bankCode).toBe('0009');

      // Delete all branches -> then delete bank succeeds
      for (const brId of branchIds) {
        const delBrRes = await deleteBranchByIdRoute(
          buildApiRequest(`http://localhost:3000/api/v1/masters/banks/branches/${brId}`, 'DELETE', staffToken),
        );
        expect(delBrRes.status).toBe(200);
      }
      const delBankOk = await deleteBankByIdRoute(
        buildApiRequest(`http://localhost:3000/api/v1/masters/banks/${bank.id}`, 'DELETE', staffToken),
      );
      expect(delBankOk.status).toBe(200);

      const banksCheck = await getBanksRoute(
        buildApiRequest('http://localhost:3000/api/v1/masters/banks?q=0009', 'GET', staffToken),
      );
      expect(((await banksCheck.json()) as { items: unknown[] }).items).toHaveLength(0);
    } finally {
      spyCtx.mockRestore();
      vi.unstubAllEnvs();
    }
  });

  it('3. 単位・支払方法・税区分・汎用区分: 管理者限定税更新、標準/固定コード保護、カスタム区分CRUD', async () => {
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
      // (A) Units
      const uCreate = await postUnitsRoute(
        buildApiRequest('http://localhost:3000/api/v1/masters/units', 'POST', staffToken, {
          unitCode: 'pallet',
          unitName: 'パレット',
          conversionName: '個',
          conversionRatio: 20,
          displayOrder: 50,
          isDeleted: false,
        }),
      );
      expect(uCreate.status).toBe(201);
      const uItem = ((await uCreate.json()) as { item: { id: string } }).item;
      const uUpdate = await putUnitRoute(
        buildApiRequest(`http://localhost:3000/api/v1/masters/units/${uItem.id}`, 'PUT', staffToken, {
          unitCode: 'pallet',
          unitName: 'パレット(変更)',
          conversionName: '個',
          conversionRatio: 24,
          displayOrder: 51,
          isDeleted: true,
        }),
      );
      expect(uUpdate.status).toBe(200);
      const uListActive = await getUnitsRoute(
        buildApiRequest('http://localhost:3000/api/v1/masters/units?includeDeleted=false', 'GET', staffToken),
      );
      const uActiveItems = ((await uListActive.json()) as { items: Array<{ id: string }> }).items;
      expect(uActiveItems.some((u) => u.id === uItem.id)).toBe(false);

      // (B) Payment methods: protected A..I cannot be deleted or code-changed; custom method IN_USE blocked 409
      const pmListRes = await getPmsRoute(
        buildApiRequest('http://localhost:3000/api/v1/masters/payment-methods', 'GET', staffToken),
      );
      const pmItems = ((await pmListRes.json()) as { items: Array<{ id: string; methodCode: string }> }).items;
      const pmH = pmItems.find((p) => p.methodCode === 'H');
      expect(pmH).toBeDefined();
      if (pmH !== undefined) {
        const delH = await deletePmRoute(
          buildApiRequest(`http://localhost:3000/api/v1/masters/payment-methods/${pmH.id}`, 'DELETE', staffToken),
        );
        expect(delH.status).toBe(400);
        expect(((await delH.json()) as { errorCode: string }).errorCode).toBe('SYSTEM_CODE_PROTECTED');

        const renameH = await putPmRoute(
          buildApiRequest(`http://localhost:3000/api/v1/masters/payment-methods/${pmH.id}`, 'PUT', staffToken, {
            methodCode: 'ZZ',
            methodName: '不正改名',
          }),
        );
        expect(renameH.status).toBe(400);
      }

      // Custom payment method referenced by partner -> 409 on delete
      const pmZRes = await postPmsRoute(
        buildApiRequest('http://localhost:3000/api/v1/masters/payment-methods', 'POST', staffToken, {
          methodCode: 'Z',
          methodName: 'PayPay法人',
        }),
      );
      expect(pmZRes.status).toBe(201);
      const pmZ = ((await pmZRes.json()) as { item: { id: string } }).item;
      await withExecutorTenantContext(
        exec,
        { tenantId, employeeId: adminEmpId, role: 'vendas_app' },
        async (tx) =>
          createBusinessPartner(
            tx,
            tenantId,
            {
              partnerCode: 'BP-PM-Z',
              categoryCode: null,
              stateCode: null,
              partnerName: '支払参照テスト',
              furigana: null,
              representativeId: null,
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
              closingDayCode: null,
              collectionDayCode: null,
              receiptMethodCode: 'Z',
              paymentMethodCode: null,
              assignedEmployeeId: null,
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
      const delZFail = await deletePmRoute(
        buildApiRequest(`http://localhost:3000/api/v1/masters/payment-methods/${pmZ.id}`, 'DELETE', staffToken),
      );
      expect(delZFail.status).toBe(409);

      // (C) Tax codes: non-admin 403, admin 200
      const tcRes = await getTaxCodesRoute(
        buildApiRequest('http://localhost:3000/api/v1/masters/tax-codes', 'GET', staffToken),
      );
      const tcItems = ((await tcRes.json()) as { items: Array<{ id: string; taxCode: string }> }).items;
      const taxA = tcItems.find((t) => t.taxCode === 'A');
      expect(taxA).toBeDefined();
      if (taxA !== undefined) {
        const nonAdminPut = await putTaxCodeRoute(
          buildApiRequest(`http://localhost:3000/api/v1/masters/tax-codes/${taxA.id}`, 'PUT', staffToken, {
            taxName: '改ざん税率',
            taxRate: 0.12,
            markSymbol: '!',
            isInternal: false,
          }),
        );
        expect(nonAdminPut.status).toBe(403);

        const adminPut = await putTaxCodeRoute(
          buildApiRequest(`http://localhost:3000/api/v1/masters/tax-codes/${taxA.id}`, 'PUT', adminToken, {
            taxName: '標準税率10%',
            taxRate: 0.1,
            markSymbol: '.',
            isInternal: false,
          }),
        );
        expect(adminPut.status).toBe(200);
        expect(((await adminPut.json()) as { item: { taxName: string } }).item.taxName).toBe('標準税率10%');
      }

      // (D) Code masters: OTHER fixed codes protected; custom code lifecycle updates lookups directly
      const otherList = await getCodeMastersRoute(
        buildApiRequest('http://localhost:3000/api/v1/masters/code-masters?domainKey=OTHER', 'GET', staffToken),
      );
      const otherB1 = ((await otherList.json()) as { items: Array<{ id: string; code: string }> }).items.find(
        (c) => c.code === 'B1',
      );
      expect(otherB1).toBeDefined();
      if (otherB1 !== undefined) {
        const delB1 = await deleteCodeMasterRoute(
          buildApiRequest(`http://localhost:3000/api/v1/masters/code-masters/${otherB1.id}`, 'DELETE', staffToken),
        );
        expect(delB1.status).toBe(400);
        expect(((await delB1.json()) as { errorCode: string }).errorCode).toBe('SYSTEM_CODE_PROTECTED');

        const deactivateB1 = await putCodeMasterRoute(
          buildApiRequest(`http://localhost:3000/api/v1/masters/code-masters/${otherB1.id}`, 'PUT', staffToken, {
            domainKey: 'OTHER',
            code: 'B1',
            name: '普通',
            isActive: false,
            displayOrder: 1,
          }),
        );
        expect(deactivateB1.status).toBe(400);
      }

      const customCmCreate = await postCodeMastersRoute(
        buildApiRequest('http://localhost:3000/api/v1/masters/code-masters', 'POST', staffToken, {
          domainKey: 'CATEGORY',
          code: '99',
          name: '新規カスタム分類',
          isActive: true,
          displayOrder: 99,
        }),
      );
      expect(customCmCreate.status).toBe(201);
      const customCm = ((await customCmCreate.json()) as { item: { id: string } }).item;

      // Deactivate -> excluded from lookups
      await putCodeMasterRoute(
        buildApiRequest(`http://localhost:3000/api/v1/masters/code-masters/${customCm.id}`, 'PUT', staffToken, {
          domainKey: 'CATEGORY',
          code: '99',
          name: '新規カスタム分類(休止)',
          isActive: false,
          displayOrder: 99,
        }),
      );
      const lookupsAfter = await withExecutorTenantContext(
        exec,
        { tenantId, employeeId: staffEmpId, role: 'vendas_app' },
        async (tx) => getMasterLookups(tx),
      );
      expect(lookupsAfter.categories.some((c) => c.code === '99')).toBe(false);

      const delCustom = await deleteCodeMasterRoute(
        buildApiRequest(`http://localhost:3000/api/v1/masters/code-masters/${customCm.id}`, 'DELETE', staffToken),
      );
      expect(delCustom.status).toBe(200);
      expect(CODE_MASTER_DOMAINS).toHaveLength(16);
    } finally {
      spyCtx.mockRestore();
      vi.unstubAllEnvs();
    }
  });

  it('4. 補助業務マスタ(メール定型文・入力候補・税務署): CRUD、ページネーション、顧問参照中の税務署削除409', async () => {
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
      // (A) Mail templates
      const mtCreate = await postMailTplsRoute(
        buildApiRequest('http://localhost:3000/api/v1/masters/mail-templates', 'POST', staffToken, {
          templateNo: 10,
          templateName: '月次請求書送付',
          subject: 'ご請求書送付のご案内',
          bodyIntro: 'いつもお世話になっております。',
          bodyMain: '今月分の請求書を送付いたします。',
          bodyFooter: '株式会社フェーズ1C',
        }),
      );
      expect(mtCreate.status).toBe(201);
      const mt = ((await mtCreate.json()) as { item: { id: string } }).item;

      // Duplicate templateNo -> 409
      const mtDup = await postMailTplsRoute(
        buildApiRequest('http://localhost:3000/api/v1/masters/mail-templates', 'POST', staffToken, {
          templateNo: 10,
          templateName: '重複番号',
          subject: '重複',
        }),
      );
      expect(mtDup.status).toBe(409);

      const mtUpd = await putMailTplRoute(
        buildApiRequest(`http://localhost:3000/api/v1/masters/mail-templates/${mt.id}`, 'PUT', staffToken, {
          templateNo: 10,
          templateName: '月次請求書送付(改定)',
          subject: 'ご請求書送付のご案内(改)',
          bodyIntro: 'お世話になっております。',
          bodyMain: '本文更新',
          bodyFooter: null,
        }),
      );
      expect(mtUpd.status).toBe(200);
      const mtList = await getMailTplsRoute(
        buildApiRequest('http://localhost:3000/api/v1/masters/mail-templates?q=改定', 'GET', staffToken),
      );
      expect(((await mtList.json()) as { items: unknown[] }).items).toHaveLength(1);
      const mtDel = await deleteMailTplRoute(
        buildApiRequest(`http://localhost:3000/api/v1/masters/mail-templates/${mt.id}`, 'DELETE', staffToken),
      );
      expect(mtDel.status).toBe(200);

      // (B) Input intelligences
      const createdIntelIds: string[] = [];
      for (const [name, unit, price, cost, tax] of [
        ['塗装工事', '㎡', 2500, 1200, 'A'],
        ['食品材料X', 'kg', 1800, 900, 'B'],
        ['雑工事', '式', 5000, 2000, 'A'],
        ['印紙代', '枚', 200, 200, 'C'],
      ] as const) {
        const res = await postIntelsRoute(
          buildApiRequest('http://localhost:3000/api/v1/masters/intelligences', 'POST', staffToken, {
            itemName: name,
            unitName: unit,
            unitPrice: price,
            costPrice: cost,
            taxCode: tax,
          }),
        );
        expect(res.status).toBe(201);
        createdIntelIds.push(((await res.json()) as { item: { id: string } }).item.id);
      }
      const intelTaxB = await getIntelsRoute(
        buildApiRequest('http://localhost:3000/api/v1/masters/intelligences?taxCode=B', 'GET', staffToken),
      );
      const intelBJson = (await intelTaxB.json()) as {
        items: Array<{ itemName: string }>;
        totalCount: number;
      };
      expect(intelBJson.totalCount).toBe(1);
      expect(intelBJson.items[0]?.itemName).toBe('食品材料X');

      const firstIntelId = createdIntelIds[0];
      if (firstIntelId !== undefined) {
        const updIntel = await putIntelRoute(
          buildApiRequest(`http://localhost:3000/api/v1/masters/intelligences/${firstIntelId}`, 'PUT', staffToken, {
            itemName: '塗装工事(特)',
            unitName: '㎡',
            unitPrice: 3000,
            costPrice: 1400,
            taxCode: 'A',
          }),
        );
        expect(updIntel.status).toBe(200);
        const delIntel = await deleteIntelRoute(
          buildApiRequest(`http://localhost:3000/api/v1/masters/intelligences/${firstIntelId}`, 'DELETE', staffToken),
        );
        expect(delIntel.status).toBe(200);
      }

      // (C) Tax offices + 409 block when referenced by partner_advisory_profiles
      const to1Res = await postTaxOfficesRoute(
        buildApiRequest('http://localhost:3000/api/v1/masters/tax-offices', 'POST', staffToken, {
          taxOfficeCode: '01201',
          taxOfficeName: '神田税務署',
          taxOfficeNo: '201',
        }),
      );
      expect(to1Res.status).toBe(201);
      const to1 = ((await to1Res.json()) as { item: { id: string } }).item;

      await withExecutorTenantContext(
        exec,
        { tenantId, employeeId: adminEmpId, role: 'vendas_app' },
        async (tx) =>
          createBusinessPartner(
            tx,
            tenantId,
            {
              partnerCode: 'BP-TAX-REF',
              categoryCode: null,
              stateCode: null,
              partnerName: '税務署参照先',
              furigana: null,
              representativeId: null,
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
              closingDayCode: null,
              collectionDayCode: null,
              receiptMethodCode: null,
              paymentMethodCode: null,
              assignedEmployeeId: null,
              openingArBalance: 0,
              openingApBalance: 0,
              bankCode: null,
              branchCode: null,
              bankAccountType: null,
              bankAccountNo: null,
              bankAccountHolder: null,
              isDeleted: false,
              advisoryProfile: {
                corporateNo: null,
                establishedAtText: null,
                businessDescription: null,
                capitalText: null,
                fiscalClosingMonth: 3,
                advisoryFee: 10000,
                settlementFee: 50000,
                payrollClosingCode: null,
                payrollPayCode: null,
                laborInsuranceCode: null,
                socialInsuranceCode: null,
                laborInsuranceNo: null,
                employmentInsOfficeNo: null,
                pensionOfficeNo: null,
                pensionSerialNo: null,
                taxOfficeId: to1.id,
                taxOfficeSerialNo: '111',
                incomeTaxCode: null,
                consumptionTaxCode: null,
                residentTaxCode: null,
                taxTransferInfo: null,
                laborBankAccount: null,
                socialBankAccount: null,
              },
            },
            { isAdmin: true, encKeyHex: TEST_ENC_KEY },
          ),
      );

      const delToFail = await deleteTaxOfficeRoute(
        buildApiRequest(`http://localhost:3000/api/v1/masters/tax-offices/${to1.id}`, 'DELETE', staffToken),
      );
      expect(delToFail.status).toBe(409);
      expect(((await delToFail.json()) as { errorCode: string }).errorCode).toBe('TAX_OFFICE_IN_USE');

      const to2Res = await postTaxOfficesRoute(
        buildApiRequest('http://localhost:3000/api/v1/masters/tax-offices', 'POST', staffToken, {
          taxOfficeCode: '01202',
          taxOfficeName: '削除可能税務署',
          taxOfficeNo: null,
        }),
      );
      const to2 = ((await to2Res.json()) as { item: { id: string } }).item;
      await putTaxOfficeRoute(
        buildApiRequest(`http://localhost:3000/api/v1/masters/tax-offices/${to2.id}`, 'PUT', staffToken, {
          taxOfficeCode: '01202',
          taxOfficeName: '削除可能税務署(改)',
          taxOfficeNo: '202',
        }),
      );
      const toList = await getTaxOfficesRoute(
        buildApiRequest('http://localhost:3000/api/v1/masters/tax-offices?q=削除可能', 'GET', staffToken),
      );
      expect(((await toList.json()) as { items: unknown[] }).items).toHaveLength(1);
      const delToOk = await deleteTaxOfficeRoute(
        buildApiRequest(`http://localhost:3000/api/v1/masters/tax-offices/${to2.id}`, 'DELETE', staffToken),
      );
      expect(delToOk.status).toBe(200);
    } finally {
      spyCtx.mockRestore();
      vi.unstubAllEnvs();
    }
  });
});
