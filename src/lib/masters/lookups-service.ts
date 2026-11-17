import type { DbExecutor } from '@/lib/db/tenant-client';
import type {
  BankBranchLookupItem,
  BankLookupItem,
  CodeMasterItem,
  EmployeeLookupItem,
  MasterLookupsDto,
  PaymentMethodLookupItem,
  RepresentativeLookupItem,
  TaxCodeLookupItem,
  TaxOfficeLookupItem,
  UnitLookupItem,
} from '@/lib/masters/types';

type UnitRow = {
  id: string;
  unit_code: string;
  unit_name: string;
  conversion_name: string | null;
  conversion_ratio: string | number;
};

type TaxCodeRow = {
  id: string;
  tax_code: 'A' | 'B' | 'C' | 'D' | 'E';
  tax_name: string;
  tax_rate: string | number;
  mark_symbol: string;
  is_internal: boolean;
};

type PaymentMethodRow = {
  id: string;
  method_code: string;
  method_name: string;
};

type BankRow = {
  id: string;
  bank_code: string;
  bank_name: string;
  furigana: string | null;
};

type BankBranchRow = {
  id: string;
  bank_id: string;
  bank_code: string;
  branch_code: string;
  branch_name: string;
  furigana: string | null;
};

type TaxOfficeRow = {
  id: string;
  tax_office_code: string;
  tax_office_name: string;
  tax_office_no: string | null;
};

type RepresentativeRow = {
  id: string;
  representative_code: number;
  representative_name: string;
  furigana: string | null;
};

type EmployeeRow = {
  id: string;
  syain_code: string;
  syain_name: string;
  is_retired: boolean;
};

type CodeMasterRow = {
  domain_key: string;
  code: string;
  name: string;
  display_order: number;
};

type CombinedLookupsDbRow = {
  opening_balance_date: string | Date | null;
  units_json: UnitRow[] | string;
  tax_codes_json: TaxCodeRow[] | string;
  payment_methods_json: PaymentMethodRow[] | string;
  banks_json: BankRow[] | string;
  bank_branches_json: BankBranchRow[] | string;
  tax_offices_json: TaxOfficeRow[] | string;
  representatives_json: RepresentativeRow[] | string;
  employees_json: EmployeeRow[] | string;
  code_masters_json: CodeMasterRow[] | string;
};

export interface MasterLookupsOptions {
  includeBankBranches?: boolean;
}

function parseJsonArray<T>(raw: T[] | string): T[] {
  if (Array.isArray(raw)) {
    return raw;
  }
  const parsed = JSON.parse(raw) as unknown;
  if (!Array.isArray(parsed)) {
    throw new Error('マスタルックアップJSONの形式が不正です');
  }
  return parsed as T[];
}

function formatDateOnly(value: string | Date | null | undefined): string | null {
  if (value === null || value === undefined) {
    return null;
  }
  if (value instanceof Date) {
    return value.toISOString().slice(0, 10);
  }
  return String(value).slice(0, 10);
}

function getDomainList(grouped: Map<string, CodeMasterItem[]>, domainKey: string): CodeMasterItem[] {
  const rows = grouped.get(domainKey);
  return rows !== undefined ? rows : [];
}

/**
 * マスタ・参照区分を一括取得する（単一SQL往復、銀行支店は明示指定時のみ取得）。
 */
export async function getMasterLookups(
  tx: DbExecutor,
  options: MasterLookupsOptions = {},
): Promise<MasterLookupsDto> {
  const includeBankBranches = options.includeBankBranches === true;

  const rows = await tx.query<CombinedLookupsDbRow>(
    `SELECT
       (SELECT opening_balance_date::text FROM tenant_settings LIMIT 1) AS opening_balance_date,
       (
         SELECT COALESCE(json_agg(u ORDER BY u.display_order ASC, u.unit_code ASC), '[]'::json)
           FROM (
             SELECT id, unit_code, unit_name, conversion_name,
                    conversion_ratio::text AS conversion_ratio, display_order
               FROM units
              WHERE is_deleted = false
           ) u
       ) AS units_json,
       (
         SELECT COALESCE(json_agg(tc ORDER BY tc.tax_code ASC), '[]'::json)
           FROM (
             SELECT id, tax_code, tax_name, tax_rate::text AS tax_rate, mark_symbol, is_internal
               FROM tax_codes
           ) tc
       ) AS tax_codes_json,
       (
         SELECT COALESCE(json_agg(pm ORDER BY pm.method_code ASC), '[]'::json)
           FROM (
             SELECT id, method_code, method_name
               FROM payment_methods
           ) pm
       ) AS payment_methods_json,
       (
         SELECT COALESCE(json_agg(b ORDER BY b.bank_code ASC), '[]'::json)
           FROM (
             SELECT id, bank_code, bank_name, furigana
               FROM banks
           ) b
       ) AS banks_json,
       CASE
         WHEN $1::boolean THEN (
           SELECT COALESCE(json_agg(bb ORDER BY bb.bank_code ASC, bb.branch_code ASC), '[]'::json)
             FROM (
               SELECT id, bank_id, bank_code, branch_code, branch_name, furigana
                 FROM bank_branches
             ) bb
         )
         ELSE '[]'::json
       END AS bank_branches_json,
       (
         SELECT COALESCE(json_agg(txo ORDER BY txo.tax_office_code ASC), '[]'::json)
           FROM (
             SELECT id, tax_office_code, tax_office_name, tax_office_no
               FROM tax_offices
           ) txo
       ) AS tax_offices_json,
       (
         SELECT COALESCE(json_agg(r ORDER BY r.representative_code ASC), '[]'::json)
           FROM (
             SELECT id, representative_code, representative_name, furigana
               FROM representatives
           ) r
       ) AS representatives_json,
       (
         SELECT COALESCE(json_agg(e ORDER BY e.is_retired ASC, e.syain_code ASC), '[]'::json)
           FROM (
             SELECT id, syain_code, syain_name, is_retired
               FROM employees
           ) e
       ) AS employees_json,
       (
         SELECT COALESCE(json_agg(cm ORDER BY cm.domain_key ASC, cm.display_order ASC, cm.code ASC), '[]'::json)
           FROM (
             SELECT domain_key, code, name, display_order
               FROM code_masters
              WHERE is_active = true
           ) cm
       ) AS code_masters_json`,
    [includeBankBranches],
  );

  const row = rows[0];
  if (row === undefined) {
    throw new Error('マスタルックアップの取得に失敗しました');
  }

  const unitRows = parseJsonArray<UnitRow>(row.units_json);
  const taxCodeRows = parseJsonArray<TaxCodeRow>(row.tax_codes_json);
  const paymentMethodRows = parseJsonArray<PaymentMethodRow>(row.payment_methods_json);
  const bankRows = parseJsonArray<BankRow>(row.banks_json);
  const bankBranchRows = parseJsonArray<BankBranchRow>(row.bank_branches_json);
  const taxOfficeRows = parseJsonArray<TaxOfficeRow>(row.tax_offices_json);
  const representativeRows = parseJsonArray<RepresentativeRow>(row.representatives_json);
  const employeeRows = parseJsonArray<EmployeeRow>(row.employees_json);
  const codeMasterRows = parseJsonArray<CodeMasterRow>(row.code_masters_json);

  const grouped = new Map<string, CodeMasterItem[]>();
  for (const cm of codeMasterRows) {
    const existing = grouped.get(cm.domain_key);
    const item: CodeMasterItem = {
      code: cm.code,
      name: cm.name,
      displayOrder: Number(cm.display_order),
    };
    if (existing !== undefined) {
      existing.push(item);
    } else {
      grouped.set(cm.domain_key, [item]);
    }
  }

  const otherItems = getDomainList(grouped, 'OTHER');
  const bankAccountTypes = otherItems.filter((item) => item.code === 'B1' || item.code === 'B2');
  const genders = otherItems.filter((item) => item.code === 'S1' || item.code === 'S2');

  const units: UnitLookupItem[] = unitRows.map((r) => ({
    id: r.id,
    unitCode: r.unit_code,
    unitName: r.unit_name,
    conversionName: r.conversion_name,
    conversionRatio: Number(r.conversion_ratio),
  }));

  const taxCodes: TaxCodeLookupItem[] = taxCodeRows.map((r) => ({
    id: r.id,
    taxCode: r.tax_code,
    taxName: r.tax_name,
    taxRate: Number(r.tax_rate),
    markSymbol: r.mark_symbol,
    isInternal: r.is_internal,
  }));

  const paymentMethods: PaymentMethodLookupItem[] = paymentMethodRows.map((r) => ({
    id: r.id,
    methodCode: r.method_code,
    methodName: r.method_name,
  }));

  const banks: BankLookupItem[] = bankRows.map((r) => ({
    id: r.id,
    bankCode: r.bank_code,
    bankName: r.bank_name,
    furigana: r.furigana,
  }));

  const bankBranches: BankBranchLookupItem[] = bankBranchRows.map((r) => ({
    id: r.id,
    bankId: r.bank_id,
    bankCode: r.bank_code,
    branchCode: r.branch_code,
    branchName: r.branch_name,
    furigana: r.furigana,
  }));

  const taxOffices: TaxOfficeLookupItem[] = taxOfficeRows.map((r) => ({
    id: r.id,
    taxOfficeCode: r.tax_office_code,
    taxOfficeName: r.tax_office_name,
    taxOfficeNo: r.tax_office_no,
  }));

  const representatives: RepresentativeLookupItem[] = representativeRows.map((r) => ({
    id: r.id,
    representativeCode: Number(r.representative_code),
    representativeName: r.representative_name,
    furigana: r.furigana,
  }));

  const employees: EmployeeLookupItem[] = employeeRows.map((r) => ({
    id: r.id,
    syainCode: r.syain_code,
    syainName: r.syain_name,
    isRetired: r.is_retired,
  }));

  const openingBalanceDate = formatDateOnly(row.opening_balance_date);

  return {
    openingBalanceDate,
    units,
    taxCodes,
    paymentMethods,
    banks,
    bankBranches,
    taxOffices,
    representatives,
    employees,
    categories: getDomainList(grouped, 'CATEGORY'),
    partnerStates: getDomainList(grouped, 'PARTNER_STATE'),
    billClosingDays: getDomainList(grouped, 'BILL_CLOSE'),
    collectionDays: getDomainList(grouped, 'COLLECT_DAY'),
    bankAccountTypes,
    genders,
    itemClasses: getDomainList(grouped, 'ITEM_CLASS'),
    monthFlags: getDomainList(grouped, 'MONTH_FLG'),
    orderKinds: getDomainList(grouped, 'ORDER_KIND'),
    projectSubStatuses: getDomainList(grouped, 'PROJECT_SUB_STATUS'),
    payrollClosingDays: getDomainList(grouped, 'PAYROLL_CLOSE'),
    payrollPayDays: getDomainList(grouped, 'PAYROLL_PAY'),
    laborInsuranceStates: getDomainList(grouped, 'LABOR_INS'),
    socialInsuranceStates: getDomainList(grouped, 'SOCIAL_INS'),
    incomeTaxTypes: getDomainList(grouped, 'INCOME_TAX'),
    consumptionTaxTypes: getDomainList(grouped, 'CONSUMPTION_TAX'),
    residentTaxTypes: getDomainList(grouped, 'RESIDENT_TAX'),
  };
}
