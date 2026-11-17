import Decimal from 'decimal.js';

export type RoundingMode = 'FLOOR' | 'ROUND' | 'CEIL';
export type TaxCode = 'A' | 'B' | 'C' | 'D' | 'E';
export type TaxCalcPolicy = 'SLIP_BY_RATE' | 'INVOICE_BY_RATE' | 'LEGACY_LINE_SUM';
export type CostTaxMode = 'TAX_EXCLUDED' | 'TAX_INCLUDED';
export type CostCategory =
  | 'EXPENSE'
  | 'LABOR'
  | 'MATERIAL'
  | 'OUTSOURCING'
  | 'TEMPORARY'
  | 'INDIRECT';

export interface TaxCodeMeta {
  code: TaxCode;
  rate: string;
  symbol: '.' | '※' | '非' | '内';
  isInternal: boolean;
}

export const TAX_CODE_DEFINITIONS: Readonly<Record<TaxCode, TaxCodeMeta>> = {
  A: { code: 'A', rate: '0.1', symbol: '.', isInternal: false },
  B: { code: 'B', rate: '0.08', symbol: '※', isInternal: false },
  C: { code: 'C', rate: '0', symbol: '非', isInternal: false },
  D: { code: 'D', rate: '0.1', symbol: '内', isInternal: true },
  E: { code: 'E', rate: '0.08', symbol: '内', isInternal: true },
};

export interface LineCalcInput {
  lineNo: number;
  quantity: string | number;
  unitPrice: bigint;
  taxCode: TaxCode;
  roundingMode: RoundingMode;
}

export interface LineCalcResult {
  lineNo: number;
  taxCode: TaxCode;
  taxRate: Decimal;
  taxMarkSymbol: '.' | '※' | '非' | '内';
  isInternalTax: boolean;
  lineAmount: bigint;
  lineTax: bigint;
  rowTotal: bigint;
  exclAmount: bigint;
}

export interface SlipTotalsResult {
  policy: TaxCalcPolicy;
  subtotalExcl: bigint;
  taxTotal: bigint;
  totalIncl: bigint;
  rate10Excl: bigint;
  rate10Tax: bigint;
  rate8Excl: bigint;
  rate8Tax: bigint;
  nonTax0: bigint;
  extBase10: bigint;
  intGross10: bigint;
  extBase8: bigint;
  intGross8: bigint;
  lineResults: LineCalcResult[];
}

export interface InvoiceSummaryResult {
  amount10Excl: bigint;
  amount8Excl: bigint;
  amount0NonTax: bigint;
  tax10Amount: bigint;
  tax8Amount: bigint;
  taxAdjustmentAmount: bigint;
  taxTotal: bigint;
  billingAmount: bigint;
  prevCarriedBalance: bigint;
  periodReceiptAmount: bigint;
  netCarriedBalance: bigint;
  closingArBalance: bigint;
}

export interface BalancePeriodInput {
  openingBalanceAtCutoff: bigint;
  beforePeriodIncreases: bigint;
  beforePeriodDecreases: bigint;
  inPeriodIncreases: bigint;
  inPeriodDecreases: bigint;
}

export interface BalancePeriodResult {
  carriedBalance: bigint;
  periodIncrease: bigint;
  periodDecrease: bigint;
  periodNetDelta: bigint;
  closingBalance: bigint;
}

export interface ProjectProfitInput {
  costTaxMode: CostTaxMode;
  contractSubtotal: bigint;
  contractTotal: bigint;
  budgets: Readonly<Record<CostCategory, bigint>>;
  actualCostsExcl: Readonly<Record<CostCategory, bigint>>;
  actualCostsIncl: Readonly<Record<CostCategory, bigint>>;
}

export interface ProjectProfitResult {
  contractAmount: bigint;
  budgetTotal: bigint;
  actualCostTotal: bigint;
  budgetGrossProfit: bigint;
  actualGrossProfit: bigint;
  actualGrossMarginPercent: string;
  budgetVarianceTotal: bigint;
}

const RATE_10 = new Decimal('0.1');
const RATE_8 = new Decimal('0.08');
const ONE = new Decimal('1');

/**
 * 厳密な端数処理（旧 Access Int(x + 0.9) 切り上げバグを完全是正）
 * - FLOOR: 0方向切り捨て（Decimal.ROUND_DOWN）
 * - ROUND: 四捨五入（Decimal.ROUND_HALF_UP）
 * - CEIL : 厳密切り上げ（Decimal.ROUND_UP: 例 100.01 -> 101）
 */
export function applyRounding(value: Decimal, mode: RoundingMode): bigint {
  let rounded: Decimal;
  switch (mode) {
    case 'FLOOR':
      rounded = value.toDecimalPlaces(0, Decimal.ROUND_DOWN);
      break;
    case 'ROUND':
      rounded = value.toDecimalPlaces(0, Decimal.ROUND_HALF_UP);
      break;
    case 'CEIL':
      rounded = value.toDecimalPlaces(0, Decimal.ROUND_UP);
      break;
  }
  return BigInt(rounded.toFixed(0));
}

function calcExternalTax(base: bigint, rate: Decimal, mode: RoundingMode): bigint {
  if (rate.isZero()) return 0n;
  return applyRounding(new Decimal(base.toString()).times(rate), mode);
}

function calcInternalTax(gross: bigint, rate: Decimal, mode: RoundingMode): bigint {
  if (rate.isZero()) return 0n;
  const g = new Decimal(gross.toString());
  return applyRounding(g.times(rate).div(ONE.plus(rate)), mode);
}

/**
 * 明細1行の金額・消費税・行合計を計算する
 */
export function calculateLineAmounts(input: LineCalcInput): LineCalcResult {
  const meta = TAX_CODE_DEFINITIONS[input.taxCode];
  const taxRate = new Decimal(meta.rate);
  const rawAmount = new Decimal(input.quantity).times(input.unitPrice.toString());
  const lineAmount = applyRounding(rawAmount, input.roundingMode);

  if (meta.isInternal) {
    const lineTax = calcInternalTax(lineAmount, taxRate, input.roundingMode);
    const rowTotal = lineAmount;
    const exclAmount = rowTotal - lineTax;
    return {
      lineNo: input.lineNo,
      taxCode: input.taxCode,
      taxRate,
      taxMarkSymbol: meta.symbol,
      isInternalTax: true,
      lineAmount,
      lineTax,
      rowTotal,
      exclAmount,
    };
  }

  const lineTax = calcExternalTax(lineAmount, taxRate, input.roundingMode);
  const rowTotal = lineAmount + lineTax;
  return {
    lineNo: input.lineNo,
    taxCode: input.taxCode,
    taxRate,
    taxMarkSymbol: meta.symbol,
    isInternalTax: false,
    lineAmount,
    lineTax,
    rowTotal,
    exclAmount: lineAmount,
  };
}

/**
 * 伝票全体の合計・税率別内訳を計算する
 * - SLIP_BY_RATE / INVOICE_BY_RATE: 税区分プール別（10%外/内, 8%外/内, 非課税）に1回端数処理
 * - LEGACY_LINE_SUM: 旧Access互換の行別消費税積み上げ集計（ETL突合検証用）
 */
export function calculateSlipTotals(
  inputs: readonly LineCalcInput[],
  roundingMode: RoundingMode,
  policy: TaxCalcPolicy,
): SlipTotalsResult {
  const lineResults = inputs.map((item) =>
    calculateLineAmounts({ ...item, roundingMode }),
  );

  let extBase10 = 0n;
  let intGross10 = 0n;
  let extBase8 = 0n;
  let intGross8 = 0n;
  let nonTax0 = 0n;

  let legacyTax10 = 0n;
  let legacyExcl10 = 0n;
  let legacyTax8 = 0n;
  let legacyExcl8 = 0n;

  for (const row of lineResults) {
    switch (row.taxCode) {
      case 'A':
        extBase10 += row.lineAmount;
        legacyExcl10 += row.exclAmount;
        legacyTax10 += row.lineTax;
        break;
      case 'D':
        intGross10 += row.lineAmount;
        legacyExcl10 += row.exclAmount;
        legacyTax10 += row.lineTax;
        break;
      case 'B':
        extBase8 += row.lineAmount;
        legacyExcl8 += row.exclAmount;
        legacyTax8 += row.lineTax;
        break;
      case 'E':
        intGross8 += row.lineAmount;
        legacyExcl8 += row.exclAmount;
        legacyTax8 += row.lineTax;
        break;
      case 'C':
        nonTax0 += row.lineAmount;
        break;
    }
  }

  if (policy === 'LEGACY_LINE_SUM') {
    const taxTotal = legacyTax10 + legacyTax8;
    const subtotalExcl = legacyExcl10 + legacyExcl8 + nonTax0;
    return {
      policy,
      subtotalExcl,
      taxTotal,
      totalIncl: subtotalExcl + taxTotal,
      rate10Excl: legacyExcl10,
      rate10Tax: legacyTax10,
      rate8Excl: legacyExcl8,
      rate8Tax: legacyTax8,
      nonTax0,
      extBase10,
      intGross10,
      extBase8,
      intGross8,
      lineResults,
    };
  }

  // SLIP_BY_RATE / INVOICE_BY_RATE 共通の伝票単位・税率プール別1回丸め
  const extTax10 = calcExternalTax(extBase10, RATE_10, roundingMode);
  const intTax10 = calcInternalTax(intGross10, RATE_10, roundingMode);
  const rate10Tax = extTax10 + intTax10;
  const rate10Excl = extBase10 + (intGross10 - intTax10);

  const extTax8 = calcExternalTax(extBase8, RATE_8, roundingMode);
  const intTax8 = calcInternalTax(intGross8, RATE_8, roundingMode);
  const rate8Tax = extTax8 + intTax8;
  const rate8Excl = extBase8 + (intGross8 - intTax8);

  const taxTotal = rate10Tax + rate8Tax;
  const subtotalExcl = rate10Excl + rate8Excl + nonTax0;

  return {
    policy,
    subtotalExcl,
    taxTotal,
    totalIncl: subtotalExcl + taxTotal,
    rate10Excl,
    rate10Tax,
    rate8Excl,
    rate8Tax,
    nonTax0,
    extBase10,
    intGross10,
    extBase8,
    intGross8,
    lineResults,
  };
}

/**
 * 月次請求書・請求鏡の集計計算
 * - SLIP_BY_RATE: 伝票確定税額をそのまま合算（taxAdjustmentAmount = 0n、伝票⇔請求ズレ0円）
 * - INVOICE_BY_RATE: 月次請求書の税率別合計に対し1回端数処理を行い、差額を taxAdjustmentAmount に記録
 *   （※内税伝票を含む場合は伝票で確定した税込対価を保持し、外税側・全体税額差を調整額として表現）
 */
export function calculateInvoiceSummary(params: {
  slips: readonly SlipTotalsResult[];
  prevCarriedBalance: bigint;
  periodReceiptAmount: bigint;
  roundingMode: RoundingMode;
  policy: TaxCalcPolicy;
}): InvoiceSummaryResult {
  let sumExcl10 = 0n;
  let sumExcl8 = 0n;
  let sumNonTax0 = 0n;
  let sumSlipTax10 = 0n;
  let sumSlipTax8 = 0n;

  let totalExtBase10 = 0n;
  let totalIntGross10 = 0n;
  let totalExtBase8 = 0n;
  let totalIntGross8 = 0n;

  for (const s of params.slips) {
    sumExcl10 += s.rate10Excl;
    sumExcl8 += s.rate8Excl;
    sumNonTax0 += s.nonTax0;
    sumSlipTax10 += s.rate10Tax;
    sumSlipTax8 += s.rate8Tax;
    totalExtBase10 += s.extBase10;
    totalIntGross10 += s.intGross10;
    totalExtBase8 += s.extBase8;
    totalIntGross8 += s.intGross8;
  }

  let amount10Excl = sumExcl10;
  let amount8Excl = sumExcl8;
  let tax10Amount = sumSlipTax10;
  let tax8Amount = sumSlipTax8;
  let taxAdjustmentAmount = 0n;

  if (params.policy === 'INVOICE_BY_RATE') {
    const invExtTax10 = calcExternalTax(totalExtBase10, RATE_10, params.roundingMode);
    const invIntTax10 = calcInternalTax(totalIntGross10, RATE_10, params.roundingMode);
    const invTax10 = invExtTax10 + invIntTax10;

    const invExtTax8 = calcExternalTax(totalExtBase8, RATE_8, params.roundingMode);
    const invIntTax8 = calcInternalTax(totalIntGross8, RATE_8, params.roundingMode);
    const invTax8 = invExtTax8 + invIntTax8;

    tax10Amount = invTax10;
    tax8Amount = invTax8;
    amount10Excl = totalExtBase10 + (totalIntGross10 - invIntTax10);
    amount8Excl = totalExtBase8 + (totalIntGross8 - invIntTax8);

    const slipTotalTax = sumSlipTax10 + sumSlipTax8;
    const invTotalTax = invTax10 + invTax8;
    taxAdjustmentAmount = invTotalTax - slipTotalTax;
  }

  const taxTotal = tax10Amount + tax8Amount;
  const billingAmount = amount10Excl + amount8Excl + sumNonTax0 + taxTotal;
  const netCarriedBalance = params.prevCarriedBalance - params.periodReceiptAmount;
  const closingArBalance = netCarriedBalance + billingAmount;

  return {
    amount10Excl,
    amount8Excl,
    amount0NonTax: sumNonTax0,
    tax10Amount,
    tax8Amount,
    taxAdjustmentAmount,
    taxTotal,
    billingAmount,
    prevCarriedBalance: params.prevCarriedBalance,
    periodReceiptAmount: params.periodReceiptAmount,
    netCarriedBalance,
    closingArBalance,
  };
}

/**
 * 売掛金残高算出（期首残高基準日以降の全請求・全入金を合算。旧 BillUpdateDetailPrice 単一行入金＆期首漏れバグを是正）
 */
export function calculateArBalance(input: BalancePeriodInput): BalancePeriodResult {
  const carriedBalance =
    input.openingBalanceAtCutoff + input.beforePeriodIncreases - input.beforePeriodDecreases;
  const periodNetDelta = input.inPeriodIncreases - input.inPeriodDecreases;
  const closingBalance = carriedBalance + periodNetDelta;

  return {
    carriedBalance,
    periodIncrease: input.inPeriodIncreases,
    periodDecrease: input.inPeriodDecreases,
    periodNetDelta,
    closingBalance,
  };
}

/**
 * 買掛金残高算出（opening_ap_balance = 旧 tm01_CarriedPay 基準。旧 Q_買掛_指定日以前買掛残高の CarriedMoney 誤参照バグを是正）
 */
export function calculateApBalance(input: BalancePeriodInput): BalancePeriodResult {
  const carriedBalance =
    input.openingBalanceAtCutoff + input.beforePeriodIncreases - input.beforePeriodDecreases;
  const periodNetDelta = input.inPeriodIncreases - input.inPeriodDecreases;
  const closingBalance = carriedBalance + periodNetDelta;

  return {
    carriedBalance,
    periodIncrease: input.inPeriodIncreases,
    periodDecrease: input.inPeriodDecreases,
    periodNetDelta,
    closingBalance,
  };
}

const COST_CATEGORIES: readonly CostCategory[] = [
  'EXPENSE',
  'LABOR',
  'MATERIAL',
  'OUTSOURCING',
  'TEMPORARY',
  'INDIRECT',
];

export function computeMarginPercent(profit: bigint, revenue: bigint): string {
  if (revenue === 0n) {
    return '0.00';
  }
  const pct = new Decimal(profit.toString())
    .div(revenue.toString())
    .times('100')
    .toDecimalPlaces(2, Decimal.ROUND_HALF_UP);
  return pct.toFixed(2);
}

/**
 * 案件実行予算・実績原価・粗利計算（分子・分母の税抜/税込基準を costTaxMode で統一し、旧 Q_原価一覧 の混在バグを是正）
 */
export function calculateProjectProfit(input: ProjectProfitInput): ProjectProfitResult {
  let budgetTotal = 0n;
  let actualCostTotal = 0n;

  for (const cat of COST_CATEGORIES) {
    budgetTotal += input.budgets[cat];
    actualCostTotal +=
      input.costTaxMode === 'TAX_EXCLUDED'
        ? input.actualCostsExcl[cat]
        : input.actualCostsIncl[cat];
  }

  const contractAmount =
    input.costTaxMode === 'TAX_EXCLUDED' ? input.contractSubtotal : input.contractTotal;
  const budgetGrossProfit = contractAmount - budgetTotal;
  const actualGrossProfit = contractAmount - actualCostTotal;
  const budgetVarianceTotal = budgetTotal - actualCostTotal;
  const actualGrossMarginPercent = computeMarginPercent(actualGrossProfit, contractAmount);

  return {
    contractAmount,
    budgetTotal,
    actualCostTotal,
    budgetGrossProfit,
    actualGrossProfit,
    actualGrossMarginPercent,
    budgetVarianceTotal,
  };
}

export interface QuotationLineCalcInput {
  lineNo: number;
  isHeading: boolean;
  quantity: string | number;
  appliedUnitPrice: bigint;
  appliedCostPrice: bigint;
  taxCode: TaxCode;
}

export interface QuotationLineCalcResult {
  lineNo: number;
  isHeading: boolean;
  taxCode: TaxCode;
  taxRate: Decimal;
  taxMarkSymbol: '.' | '※' | '非' | '内';
  isInternalTax: boolean;
  lineAmount: bigint;
  lineTax: bigint;
  lineTotal: bigint;
  exclAmount: bigint;
  costAmount: bigint;
  costTax: bigint;
  costTotal: bigint;
  costExclAmount: bigint;
}

export interface QuotationSlipCalcResult {
  policy: TaxCalcPolicy;
  roundingMode: RoundingMode;
  subtotalAmount: bigint;
  taxTotal: bigint;
  totalAmount: bigint;
  rate10Excl: bigint;
  rate10Tax: bigint;
  rate8Excl: bigint;
  rate8Tax: bigint;
  nonTax0: bigint;
  costSubtotal: bigint;
  costTaxTotal: bigint;
  costTotal: bigint;
  grossProfitExcl: bigint;
  grossMarginExclPercent: string;
  grossProfitIncl: bigint;
  grossMarginInclPercent: string;
  lineResults: QuotationLineCalcResult[];
}

/**
 * 見積伝票の売価・原価・消費税・税率別内訳・予定粗利を一括算出する純粋関数
 * - 見出し行（isHeading = true）は売価・原価とも 0n として集計から除外する
 */
export function calculateQuotationSlip(
  lines: readonly QuotationLineCalcInput[],
  roundingMode: RoundingMode,
  policy: TaxCalcPolicy,
): QuotationSlipCalcResult {
  const salesInputs: LineCalcInput[] = lines.map((line) => ({
    lineNo: line.lineNo,
    quantity: line.isHeading ? '0' : line.quantity,
    unitPrice: line.isHeading ? 0n : line.appliedUnitPrice,
    taxCode: line.taxCode,
    roundingMode,
  }));

  const costInputs: LineCalcInput[] = lines.map((line) => ({
    lineNo: line.lineNo,
    quantity: line.isHeading ? '0' : line.quantity,
    unitPrice: line.isHeading ? 0n : line.appliedCostPrice,
    taxCode: line.taxCode,
    roundingMode,
  }));

  const salesTotals = calculateSlipTotals(salesInputs, roundingMode, policy);
  const costTotals = calculateSlipTotals(costInputs, roundingMode, policy);

  const lineResults: QuotationLineCalcResult[] = lines.map((line, index) => {
    const sLine = salesTotals.lineResults[index];
    const cLine = costTotals.lineResults[index];
    if (sLine === undefined || cLine === undefined) {
      throw new Error(`見積明細計算結果の整合エラー (lineNo=${line.lineNo})`);
    }
    return {
      lineNo: line.lineNo,
      isHeading: line.isHeading,
      taxCode: sLine.taxCode,
      taxRate: sLine.taxRate,
      taxMarkSymbol: sLine.taxMarkSymbol,
      isInternalTax: sLine.isInternalTax,
      lineAmount: sLine.lineAmount,
      lineTax: sLine.lineTax,
      lineTotal: sLine.rowTotal,
      exclAmount: sLine.exclAmount,
      costAmount: cLine.lineAmount,
      costTax: cLine.lineTax,
      costTotal: cLine.rowTotal,
      costExclAmount: cLine.exclAmount,
    };
  });

  const grossProfitExcl = salesTotals.subtotalExcl - costTotals.subtotalExcl;
  const grossProfitIncl = salesTotals.totalIncl - costTotals.totalIncl;

  return {
    policy,
    roundingMode,
    subtotalAmount: salesTotals.subtotalExcl,
    taxTotal: salesTotals.taxTotal,
    totalAmount: salesTotals.totalIncl,
    rate10Excl: salesTotals.rate10Excl,
    rate10Tax: salesTotals.rate10Tax,
    rate8Excl: salesTotals.rate8Excl,
    rate8Tax: salesTotals.rate8Tax,
    nonTax0: salesTotals.nonTax0,
    costSubtotal: costTotals.subtotalExcl,
    costTaxTotal: costTotals.taxTotal,
    costTotal: costTotals.totalIncl,
    grossProfitExcl,
    grossMarginExclPercent: computeMarginPercent(grossProfitExcl, salesTotals.subtotalExcl),
    grossProfitIncl,
    grossMarginInclPercent: computeMarginPercent(grossProfitIncl, salesTotals.totalIncl),
    lineResults,
  };
}

export interface SalesLineCalcInput {
  lineNo: number;
  isHeading: boolean;
  quantity: string | number;
  appliedUnitPrice: bigint;
  taxCode: TaxCode;
}

export interface SalesLineCalcResult {
  lineNo: number;
  isHeading: boolean;
  taxCode: TaxCode;
  taxRate: Decimal;
  taxMarkSymbol: '.' | '※' | '非' | '内';
  isInternalTax: boolean;
  lineAmount: bigint;
  lineTax: bigint;
  rowTotal: bigint;
  exclAmount: bigint;
}

export interface SalesSlipCalcResult {
  policy: TaxCalcPolicy;
  roundingMode: RoundingMode;
  subtotalAmount: bigint;
  taxTotal: bigint;
  totalAmount: bigint;
  rate10Excl: bigint;
  rate10Tax: bigint;
  rate8Excl: bigint;
  rate8Tax: bigint;
  nonTax0: bigint;
  lineResults: SalesLineCalcResult[];
}

/**
 * 売上・立替伝票の明細行・合計・税率別内訳を一括算出する純粋関数
 * - 見出し行（isHeading = true）は 0n として集計から除外する
 * - 内税(D/E)は rowTotal = lineAmount として二重加算を防止する
 */
export function calculateSalesSlip(
  lines: readonly SalesLineCalcInput[],
  roundingMode: RoundingMode,
  policy: TaxCalcPolicy,
): SalesSlipCalcResult {
  const slipInputs: LineCalcInput[] = lines.map((line) => ({
    lineNo: line.lineNo,
    quantity: line.isHeading ? '0' : line.quantity,
    unitPrice: line.isHeading ? 0n : line.appliedUnitPrice,
    taxCode: line.taxCode,
    roundingMode,
  }));

  const totals = calculateSlipTotals(slipInputs, roundingMode, policy);

  const lineResults: SalesLineCalcResult[] = lines.map((line, index) => {
    const row = totals.lineResults[index];
    if (row === undefined) {
      throw new Error(`売上明細計算結果の整合エラー (lineNo=${line.lineNo})`);
    }
    return {
      lineNo: line.lineNo,
      isHeading: line.isHeading,
      taxCode: row.taxCode,
      taxRate: row.taxRate,
      taxMarkSymbol: row.taxMarkSymbol,
      isInternalTax: row.isInternalTax,
      lineAmount: row.lineAmount,
      lineTax: row.lineTax,
      rowTotal: row.rowTotal,
      exclAmount: row.exclAmount,
    };
  });

  return {
    policy,
    roundingMode,
    subtotalAmount: totals.subtotalExcl,
    taxTotal: totals.taxTotal,
    totalAmount: totals.totalIncl,
    rate10Excl: totals.rate10Excl,
    rate10Tax: totals.rate10Tax,
    rate8Excl: totals.rate8Excl,
    rate8Tax: totals.rate8Tax,
    nonTax0: totals.nonTax0,
    lineResults,
  };
}

/**
 * 定額サブスク契約明細1行の金額・消費税・税込金額を計算する純粋関数
 */
export function calculateSubscriptionContractLine(input: {
  quantity: string | number;
  appliedUnitPrice: bigint;
  taxCode: TaxCode;
  roundingMode: RoundingMode;
}): LineCalcResult {
  return calculateLineAmounts({
    lineNo: 1,
    quantity: input.quantity,
    unitPrice: input.appliedUnitPrice,
    taxCode: input.taxCode,
    roundingMode: input.roundingMode,
  });
}
