export interface UnitLookupItem {
  id: string;
  unitCode: string;
  unitName: string;
  conversionName: string | null;
  conversionRatio: number;
}

export interface TaxCodeLookupItem {
  id: string;
  taxCode: 'A' | 'B' | 'C' | 'D' | 'E';
  taxName: string;
  taxRate: number;
  markSymbol: string;
  isInternal: boolean;
}

export interface PaymentMethodLookupItem {
  id: string;
  methodCode: string;
  methodName: string;
}

export interface BankLookupItem {
  id: string;
  bankCode: string;
  bankName: string;
  furigana: string | null;
}

export interface BankBranchLookupItem {
  id: string;
  bankId: string;
  bankCode: string;
  branchCode: string;
  branchName: string;
  furigana: string | null;
}

export interface TaxOfficeLookupItem {
  id: string;
  taxOfficeCode: string;
  taxOfficeName: string;
  taxOfficeNo: string | null;
}

export interface RepresentativeLookupItem {
  id: string;
  representativeCode: number;
  representativeName: string;
  furigana: string | null;
}

export interface EmployeeLookupItem {
  id: string;
  syainCode: string;
  syainName: string;
  isRetired: boolean;
}

export interface CodeMasterItem {
  code: string;
  name: string;
  displayOrder: number;
}

export interface MasterLookupsDto {
  openingBalanceDate: string | null;
  units: UnitLookupItem[];
  taxCodes: TaxCodeLookupItem[];
  paymentMethods: PaymentMethodLookupItem[];
  banks: BankLookupItem[];
  bankBranches: BankBranchLookupItem[];
  taxOffices: TaxOfficeLookupItem[];
  representatives: RepresentativeLookupItem[];
  employees: EmployeeLookupItem[];
  categories: CodeMasterItem[];
  partnerStates: CodeMasterItem[];
  billClosingDays: CodeMasterItem[];
  collectionDays: CodeMasterItem[];
  bankAccountTypes: CodeMasterItem[];
  genders: CodeMasterItem[];
  itemClasses: CodeMasterItem[];
  monthFlags: CodeMasterItem[];
  orderKinds: CodeMasterItem[];
  projectSubStatuses: CodeMasterItem[];
  payrollClosingDays: CodeMasterItem[];
  payrollPayDays: CodeMasterItem[];
  laborInsuranceStates: CodeMasterItem[];
  socialInsuranceStates: CodeMasterItem[];
  incomeTaxTypes: CodeMasterItem[];
  consumptionTaxTypes: CodeMasterItem[];
  residentTaxTypes: CodeMasterItem[];
}

export interface RepresentativeDto {
  id: string;
  representativeCode: number;
  representativeName: string;
  furigana: string | null;
  postalCode: string | null;
  address1: string | null;
  address2: string | null;
  tel: string | null;
  mobile: string | null;
  birthDate: string | null;
  genderCode: string | null;
  linkedPartnerCount: number;
  createdAt: string;
  updatedAt: string;
}

export interface RepresentativeInput {
  representativeCode: number;
  representativeName: string;
  furigana: string | null;
  postalCode: string | null;
  address1: string | null;
  address2: string | null;
  tel: string | null;
  mobile: string | null;
  birthDate: string | null;
  genderCode: string | null;
}

export interface PartnerAdvisoryProfileDto {
  id: string;
  corporateNo: string | null;
  establishedAtText: string | null;
  businessDescription: string | null;
  capitalText: string | null;
  fiscalClosingMonth: number | null;
  advisoryFee: number;
  settlementFee: number;
  payrollClosingCode: string | null;
  payrollPayCode: string | null;
  laborInsuranceCode: string | null;
  socialInsuranceCode: string | null;
  laborInsuranceNo: string | null;
  employmentInsOfficeNo: string | null;
  pensionOfficeNo: string | null;
  pensionSerialNo: string | null;
  taxOfficeId: string | null;
  taxOfficeName: string | null;
  taxOfficeSerialNo: string | null;
  incomeTaxCode: string | null;
  consumptionTaxCode: string | null;
  residentTaxCode: string | null;
  taxTransferInfo: string | null;
  laborBankAccount: string | null;
  socialBankAccount: string | null;
}

export interface PartnerAdvisoryProfileInput {
  corporateNo: string | null;
  establishedAtText: string | null;
  businessDescription: string | null;
  capitalText: string | null;
  fiscalClosingMonth: number | null;
  advisoryFee: number;
  settlementFee: number;
  payrollClosingCode: string | null;
  payrollPayCode: string | null;
  laborInsuranceCode: string | null;
  socialInsuranceCode: string | null;
  laborInsuranceNo: string | null;
  employmentInsOfficeNo: string | null;
  pensionOfficeNo: string | null;
  pensionSerialNo: string | null;
  taxOfficeId: string | null;
  taxOfficeSerialNo: string | null;
  incomeTaxCode: string | null;
  consumptionTaxCode: string | null;
  residentTaxCode: string | null;
  taxTransferInfo: string | null;
  laborBankAccount: string | null;
  socialBankAccount: string | null;
}

export interface BusinessPartnerListItemDto {
  id: string;
  partnerCode: string;
  partnerName: string;
  furigana: string | null;
  categoryCode: string | null;
  stateCode: string | null;
  isClient: boolean;
  isSupplier: boolean;
  isAplusEnabled: boolean;
  tel: string | null;
  representativeId: string | null;
  representativeName: string | null;
  assignedEmployeeId: string | null;
  assignedEmployeeName: string | null;
  openingArBalance: number;
  openingApBalance: number;
  isDeleted: boolean;
  updatedAt: string;
}

export interface BusinessPartnerDetailDto extends BusinessPartnerListItemDto {
  isIndividualHonorific: boolean;
  postalCode: string | null;
  address1: string | null;
  address2: string | null;
  sendMailEnabled: boolean;
  email: string | null;
  estimateMailTo: string | null;
  estimateMailCc: string | null;
  billMailTo: string | null;
  billMailCc: string | null;
  invoiceNo: string | null;
  billingDestinationName: string | null;
  closingDayCode: string | null;
  collectionDayCode: string | null;
  receiptMethodCode: string | null;
  paymentMethodCode: string | null;
  bankCode: string | null;
  branchCode: string | null;
  bankAccountType: 'B1' | 'B2' | null;
  bankAccountNo: string | null;
  bankAccountHolder: string | null;
  openingBalanceDate: string | null;
  advisoryProfile: PartnerAdvisoryProfileDto | null;
}

export interface BusinessPartnerInput {
  partnerCode: string;
  categoryCode: string | null;
  stateCode: string | null;
  partnerName: string;
  furigana: string | null;
  representativeId: string | null;
  isIndividualHonorific: boolean;
  postalCode: string | null;
  address1: string | null;
  address2: string | null;
  tel: string | null;
  isClient: boolean;
  isSupplier: boolean;
  isAplusEnabled: boolean;
  sendMailEnabled: boolean;
  email: string | null;
  estimateMailTo: string | null;
  estimateMailCc: string | null;
  billMailTo: string | null;
  billMailCc: string | null;
  invoiceNo: string | null;
  billingDestinationName: string | null;
  closingDayCode: string | null;
  collectionDayCode: string | null;
  receiptMethodCode: string | null;
  paymentMethodCode: string | null;
  assignedEmployeeId: string | null;
  openingArBalance?: number;
  openingApBalance?: number;
  bankCode: string | null;
  branchCode: string | null;
  bankAccountType: 'B1' | 'B2' | null;
  bankAccountNo: string | null;
  bankAccountHolder: string | null;
  isDeleted: boolean;
  advisoryProfile: PartnerAdvisoryProfileInput | null;
}

export interface ProductDto {
  id: string;
  productCode: string;
  productName: string;
  productNameSub: string | null;
  monthFlagCode: string | null;
  capacity: number;
  unitId: string | null;
  unitName: string | null;
  standardUnitPrice: number;
  standardPurchasePrice: number;
  standardCostPrice: number;
  defaultTaxCode: 'A' | 'B' | 'C' | 'D' | 'E';
  itemCategoryCode: string | null;
  kubun: string | null;
  isStockManaged: boolean;
  stockQuantity: number;
  isSubscriptionTarget: boolean;
  isHeading: boolean;
  isDeleted: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface ProductInput {
  productCode: string;
  productName: string;
  productNameSub: string | null;
  monthFlagCode: string | null;
  capacity: number;
  unitId: string | null;
  standardUnitPrice: number;
  standardPurchasePrice: number;
  standardCostPrice: number;
  defaultTaxCode: 'A' | 'B' | 'C' | 'D' | 'E';
  itemCategoryCode: string | null;
  kubun: string | null;
  isStockManaged: boolean;
  stockQuantity: number;
  isSubscriptionTarget: boolean;
  isHeading: boolean;
  isDeleted: boolean;
}

export interface EmployeeDto {
  id: string;
  syainCode: string;
  syainName: string;
  kanaName: string | null;
  isAdmin: boolean;
  menuType: number;
  email: string | null;
  joinedAt: string | null;
  birthDate: string | null;
  retiredAt: string | null;
  isRetired: boolean;
  genderCode: 'S1' | 'S2' | null;
  postalCode: string | null;
  address1: string | null;
  address2: string | null;
  steadyJobNote: string | null;
  workExperience: string | null;
  mustChangePassword: boolean;
  failedLoginCount: number;
  lockedUntil: string | null;
  sessionVersion: number;
  createdAt: string;
  updatedAt: string;
}

export interface CreateEmployeeInput {
  syainCode: string;
  syainName: string;
  kanaName: string | null;
  initialPassword: string;
  isAdmin: boolean;
  menuType: number;
  email: string | null;
  joinedAt: string | null;
  birthDate: string | null;
  retiredAt: string | null;
  isRetired: boolean;
  genderCode: 'S1' | 'S2' | null;
  postalCode: string | null;
  address1: string | null;
  address2: string | null;
  steadyJobNote: string | null;
  workExperience: string | null;
}

export interface UpdateEmployeeInput {
  syainCode: string;
  syainName: string;
  kanaName: string | null;
  isAdmin: boolean;
  menuType: number;
  email: string | null;
  joinedAt: string | null;
  birthDate: string | null;
  retiredAt: string | null;
  isRetired: boolean;
  genderCode: 'S1' | 'S2' | null;
  postalCode: string | null;
  address1: string | null;
  address2: string | null;
  steadyJobNote: string | null;
  workExperience: string | null;
}

// ============================================================================
// Phase 1-C: 補助・区分マスタ 8領域（9テーブル）型・定数定義
// ============================================================================

export function computeTotalPages(totalCount: number, pageSize: number): number {
  if (totalCount <= 0 || pageSize <= 0) {
    return 1;
  }
  const rem = totalCount % pageSize;
  const full = (totalCount - rem) / pageSize;
  return rem > 0 ? full + 1 : full;
}

export interface BankDto {
  id: string;
  bankCode: string;
  bankName: string;
  furigana: string | null;
  branchCount: number;
  createdAt: string;
  updatedAt: string;
}

export interface BankInput {
  bankCode: string;
  bankName: string;
  furigana: string | null;
}

export interface BankBranchDto {
  id: string;
  bankId: string;
  bankCode: string;
  bankName: string;
  branchCode: string;
  branchName: string;
  furigana: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface BankBranchInput {
  bankId: string;
  branchCode: string;
  branchName: string;
  furigana: string | null;
}

export interface BankBranchPageDto {
  items: BankBranchDto[];
  totalCount: number;
  page: number;
  pageSize: number;
}

export interface UnitDto {
  id: string;
  unitCode: string;
  unitName: string;
  conversionName: string | null;
  conversionRatio: number;
  displayOrder: number;
  isDeleted: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface UnitInput {
  unitCode: string;
  unitName: string;
  conversionName: string | null;
  conversionRatio: number;
  displayOrder: number;
  isDeleted: boolean;
}

export const PROTECTED_PAYMENT_METHOD_CODES = ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H', 'I'] as const;

export interface PaymentMethodDto {
  id: string;
  methodCode: string;
  methodName: string;
  isProtected: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface PaymentMethodInput {
  methodCode: string;
  methodName: string;
}

export interface TaxCodeDto {
  id: string;
  taxCode: 'A' | 'B' | 'C' | 'D' | 'E';
  taxName: string;
  taxRate: number;
  markSymbol: string;
  isInternal: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface TaxCodeUpdateInput {
  taxName: string;
  taxRate: number;
  markSymbol: string;
  isInternal: boolean;
}

export interface CodeMasterDomainMeta {
  domainKey: string;
  label: string;
  description: string;
  protectedCodes: readonly string[];
}

export const CODE_MASTER_DOMAINS: readonly CodeMasterDomainMeta[] = [
  { domainKey: 'CATEGORY', label: '取引先分類', description: '旧 ti_Category（個人宅・社屋・公共機関など）', protectedCodes: [] },
  { domainKey: 'ITEM_CLASS', label: '商品・原価分類', description: '旧 ti_Item（経費・労務費・材料費・請求など）', protectedCodes: [] },
  { domainKey: 'BILL_CLOSE', label: '請求締日', description: '旧 ti_Seikyusime（10日・20日・月末など）', protectedCodes: [] },
  { domainKey: 'COLLECT_DAY', label: '回収日', description: '旧 ti_Kaisyubi（請求回収サイト区分）', protectedCodes: [] },
  { domainKey: 'PARTNER_STATE', label: '取引先状態', description: '旧 ti_Zyoutai（継続・解約・廃業など）', protectedCodes: [] },
  { domainKey: 'MONTH_FLG', label: '対象月ラベル', description: '旧 ti_TsukiFlg（今月・来月・1月〜12月）', protectedCodes: [] },
  { domainKey: 'ORDER_KIND', label: '工事種別', description: '旧 ti_Order（戸建て・社屋・リフォームなど）', protectedCodes: [] },
  { domainKey: 'PROJECT_SUB_STATUS', label: '案件サブ状態', description: '旧 ti_Status（完成・仕掛中）', protectedCodes: [] },
  { domainKey: 'OTHER', label: '口座・性別区分（固定）', description: '旧 ti_Other（CHECK制約依存のため固定）', protectedCodes: ['B1', 'B2', 'S1', 'S2'] },
  { domainKey: 'PAYROLL_CLOSE', label: '給与締日', description: '旧 ti_Kyuyoshime（顧客労務プロファイル用）', protectedCodes: [] },
  { domainKey: 'PAYROLL_PAY', label: '給与支給日', description: '旧 ti_Kyuyosikyu（顧客労務プロファイル用）', protectedCodes: [] },
  { domainKey: 'LABOR_INS', label: '労働保険', description: '旧 ti_Roudou（顧客労務プロファイル用）', protectedCodes: [] },
  { domainKey: 'SOCIAL_INS', label: '社会保険', description: '旧 ti_Syakai（顧客労務プロファイル用）', protectedCodes: [] },
  { domainKey: 'INCOME_TAX', label: '所得税', description: '旧 ti_Syotokuzei（顧客税務プロファイル用）', protectedCodes: [] },
  { domainKey: 'CONSUMPTION_TAX', label: '消費税区分', description: '旧 ti_Syouhizei（顧客税務プロファイル用）', protectedCodes: [] },
  { domainKey: 'RESIDENT_TAX', label: '住民税', description: '旧 ti_Zyuminzei（顧客税務プロファイル用）', protectedCodes: [] },
] as const;

export interface CodeMasterDto {
  id: string;
  domainKey: string;
  code: string;
  name: string;
  isActive: boolean;
  displayOrder: number;
  isProtected: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface CodeMasterInput {
  domainKey: string;
  code: string;
  name: string;
  isActive: boolean;
  displayOrder: number;
}

export interface MailTemplateDto {
  id: string;
  templateNo: number;
  templateName: string;
  subject: string;
  bodyIntro: string | null;
  bodyMain: string | null;
  bodyFooter: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface MailTemplateInput {
  templateNo: number;
  templateName: string;
  subject: string;
  bodyIntro: string | null;
  bodyMain: string | null;
  bodyFooter: string | null;
}

export interface InputIntelligenceDto {
  id: string;
  itemName: string;
  unitName: string | null;
  unitPrice: number;
  costPrice: number;
  taxCode: 'A' | 'B' | 'C' | 'D' | 'E';
  createdAt: string;
  updatedAt: string;
}

export interface InputIntelligenceInput {
  itemName: string;
  unitName: string | null;
  unitPrice: number;
  costPrice: number;
  taxCode: 'A' | 'B' | 'C' | 'D' | 'E';
}

export interface InputIntelligencePageDto {
  items: InputIntelligenceDto[];
  totalCount: number;
  page: number;
  pageSize: number;
}

export interface TaxOfficeDto {
  id: string;
  taxOfficeCode: string;
  taxOfficeName: string;
  taxOfficeNo: string | null;
  linkedAdvisoryCount: number;
  createdAt: string;
  updatedAt: string;
}

export interface TaxOfficeInput {
  taxOfficeCode: string;
  taxOfficeName: string;
  taxOfficeNo: string | null;
}

