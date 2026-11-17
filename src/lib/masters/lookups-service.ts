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

type TenantSettingsDateRow = {
  opening_balance_date: string | Date;
};

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

export async function getMasterLookups(tx: DbExecutor): Promise<MasterLookupsDto> {
  const settingsRows = await tx.query<TenantSettingsDateRow>(
    `SELECT opening_balance_date::text AS opening_balance_date
     FROM tenant_settings
     LIMIT 1`,
    [],
  );
  const unitRows = await tx.query<UnitRow>(
    `SELECT id, unit_code, unit_name, conversion_name, conversion_ratio::text AS conversion_ratio
     FROM units
     WHERE is_deleted = false
     ORDER BY display_order ASC, unit_code ASC`,
    [],
  );
  const taxCodeRows = await tx.query<TaxCodeRow>(
    `SELECT id, tax_code, tax_name, tax_rate::text AS tax_rate, mark_symbol, is_internal
     FROM tax_codes
     ORDER BY tax_code ASC`,
    [],
  );
  const paymentMethodRows = await tx.query<PaymentMethodRow>(
    `SELECT id, method_code, method_name
     FROM payment_methods
     ORDER BY method_code ASC`,
    [],
  );
  const bankRows = await tx.query<BankRow>(
    `SELECT id, bank_code, bank_name, furigana
     FROM banks
     ORDER BY bank_code ASC`,
    [],
  );
  const bankBranchRows = await tx.query<BankBranchRow>(
    `SELECT id, bank_id, bank_code, branch_code, branch_name, furigana
     FROM bank_branches
     ORDER BY bank_code ASC, branch_code ASC`,
    [],
  );
  const taxOfficeRows = await tx.query<TaxOfficeRow>(
    `SELECT id, tax_office_code, tax_office_name, tax_office_no
     FROM tax_offices
     ORDER BY tax_office_code ASC`,
    [],
  );
  const representativeRows = await tx.query<RepresentativeRow>(
    `SELECT id, representative_code, representative_name, furigana
     FROM representatives
     ORDER BY representative_code ASC`,
    [],
  );
  const employeeRows = await tx.query<EmployeeRow>(
    `SELECT id, syain_code, syain_name, is_retired
     FROM employees
     ORDER BY is_retired ASC, syain_code ASC`,
    [],
  );
  const codeMasterRows = await tx.query<CodeMasterRow>(
    `SELECT domain_key, code, name, display_order
     FROM code_masters
     WHERE is_active = true
     ORDER BY domain_key ASC, display_order ASC, code ASC`,
    [],
  );

  const grouped = new Map<string, CodeMasterItem[]>();
  for (const row of codeMasterRows) {
    const existing = grouped.get(row.domain_key);
    const item: CodeMasterItem = {
      code: row.code,
      name: row.name,
      displayOrder: Number(row.display_order),
    };
    if (existing !== undefined) {
      existing.push(item);
    } else {
      grouped.set(row.domain_key, [item]);
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

  const openingBalanceDate =
    settingsRows.length > 0 ? formatDateOnly(settingsRows[0]?.opening_balance_date) : null;

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
