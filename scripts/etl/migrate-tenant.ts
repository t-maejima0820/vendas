import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { Pool } from 'pg';
import {
  calculateApBalance,
  calculateArBalance,
  calculateSlipTotals,
  type CostCategory,
  type LineCalcInput,
  type RoundingMode,
  type TaxCode,
} from '../../src/lib/domain/calculations';
import { decryptField, encryptField, hashPassword } from '../../src/lib/crypto/field-cipher';
import { createPgPoolConfig } from '../../src/lib/db/tenant-client';
import { requireEnv } from '../../src/lib/env';

type EtlMode = 'dry-run' | 'execute' | 'verify' | 'purge-tenant';
type RawRow = Record<string, string | number | boolean | null | undefined>;

export interface AccdbDump {
  exportedAt: string;
  accdbPath: string;
  tableCount: number;
  tables: Record<string, RawRow[]>;
}

export interface EtlMappingConfig {
  duplicatePartnerResolutions?: Record<
    string,
    { action: 'rename' | 'skip'; targetCode?: string; byOldId?: number }[]
  >;
  quarantineOrphanConstructionNos?: boolean;
  skipDummyRows?: boolean;
  skipEmptyQuotations?: boolean;
}

export interface DiagnosticReport {
  tenantSlug: string;
  tenantName: string;
  cutoffDate: string;
  accdbPath: string;
  generatedAt: string;
  blockers: Array<{ code: string; message: string; details: unknown }>;
  warnings: Array<{ code: string; message: string; details: unknown }>;
  d1Duplicates: Array<{ table: string; column: string; value: string; count: number; ids: unknown[] }>;
  d2Orphans: Array<{ table: string; column: string; targetTable: string; missingValue: string; rowId: unknown }>;
  d3MissingPayables: Array<{ purchaseNo: number; purchaseDate: string; partnerCode: string; totalAmount: string }>;
  d4MathAndCostIssues: {
    slipChecks: Array<{ kind: string; slipNo: string; hdrTotal: string; calcTotal: string; match: boolean }>;
    corruptedCostRows: Array<{
      table: string;
      id: unknown;
      constructionNo: string;
      headerTotal: string;
      detailSum: string;
    }>;
    dummyOrEmptyRows: Array<{ table: string; id: unknown; reason: string }>;
  };
  d5SchemaAnomalies: {
    fullWidthColumnDetected: boolean;
    hasMyNumberColumn: boolean;
    plaintextPasswordCount: number;
    multilineItemNames: Array<{ table: string; id: unknown; itemName: string }>;
    shiftedWorkRows: Array<{ table: string; count: number; sample: RawRow | null }>;
  };
  d6OpeningBalances: Array<{
    oldId: number;
    partnerCode: string;
    resolvedPartnerCode: string;
    partnerName: string;
    carriedMoney: string;
    arBilledUntilCutoff: string;
    arReceivedUntilCutoff: string;
    openingArBalance: string;
    carriedPay: string;
    apPayableUntilCutoff: string;
    apPaidUntilCutoff: string;
    openingApBalance: string;
    unpostedP3PurchaseDelta: string;
  }>;
}

const VALID_TAX_CODES = new Set<string>(['A', 'B', 'C', 'D', 'E']);

const COST_TABLE_SPECS: ReadonlyArray<{
  table: string;
  costTable: string;
  category: CostCategory;
  prefix: string;
}> = [
  { table: 'tm26_Expense', costTable: 'tm26_ExpenseCost', category: 'EXPENSE', prefix: 'tm26' },
  { table: 'tm27_Labor', costTable: 'tm27_LaborCost', category: 'LABOR', prefix: 'tm27' },
  { table: 'tm28_Material', costTable: 'tm28_MaterialCost', category: 'MATERIAL', prefix: 'tm28' },
  { table: 'tm29_Outsourcing', costTable: 'tm29_OutsourcingCost', category: 'OUTSOURCING', prefix: 'tm29' },
  { table: 'tm30_Temporary', costTable: 'tm30_TemporaryCost', category: 'TEMPORARY', prefix: 'tm30' },
  { table: 'tm31_Indirect', costTable: 'tm31_IndirectCost', category: 'INDIRECT', prefix: 'tm31' },
];

const COST_NAME_TO_CATEGORY: Readonly<Record<string, CostCategory>> = {
  経費: 'EXPENSE',
  労務費: 'LABOR',
  材料費: 'MATERIAL',
  外注費: 'OUTSOURCING',
  共通仮設費: 'TEMPORARY',
  間接費: 'INDIRECT',
};

function getRows(dump: AccdbDump, tableName: string): RawRow[] {
  const tbl = dump.tables[tableName];
  if (tbl === undefined) {
    throw new Error(`Access エクスポートに必須テーブル '${tableName}' が存在しません`);
  }
  return tbl;
}

function asStr(val: unknown): string {
  if (val === null || val === undefined) return '';
  return String(val).trim();
}

function asNullableStr(val: unknown): string | null {
  if (val === null || val === undefined) return null;
  const s = String(val).trim();
  if (s === '' || s === '--') return null;
  return s;
}

function toBigIntYen(val: unknown, contextLabel: string): bigint {
  if (val === null || val === undefined || val === '') return 0n;
  const cleaned = String(val).replace(/,/g, '').trim();
  if (!/^-?\d+(\.\d+)?$/.test(cleaned)) {
    throw new Error(`金額の数値変換に失敗しました [${contextLabel}]: '${String(val)}'`);
  }
  const intPart = cleaned.split('.')[0];
  if (intPart === undefined || intPart === '') {
    throw new Error(`整数部の抽出に失敗しました [${contextLabel}]`);
  }
  return BigInt(intPart);
}

function toDateOnly(val: unknown): string | null {
  if (val === null || val === undefined || val === '') return null;
  const s = String(val).trim();
  if (s.length >= 10 && /^\d{4}-\d{2}-\d{2}/.test(s)) {
    return s.slice(0, 10);
  }
  return null;
}

function toRoundingMode(val: unknown): RoundingMode {
  const s = asStr(val);
  if (s === '四捨五入') return 'ROUND';
  if (s === '切上') return 'CEIL';
  return 'FLOOR';
}

function toTaxCode(val: unknown): TaxCode {
  const s = asStr(val);
  if (VALID_TAX_CODES.has(s)) {
    return s as TaxCode;
  }
  return 'A';
}

function toQtyStr(val: unknown): string {
  if (val === null || val === undefined || val === '') return '0';
  return String(val).trim();
}

function toCostCategory(val: unknown): CostCategory | null {
  const s = asStr(val);
  const matched = COST_NAME_TO_CATEGORY[s];
  return matched === undefined ? null : matched;
}

function resolveEmployeeSyainCode(employees: RawRow[], nameOrCode: unknown): string | null {
  const raw = asNullableStr(nameOrCode);
  if (raw === null) return null;
  const found = employees.find(
    (e) => asStr(e['tm09_SyainCode']) === raw || asStr(e['tm09_Syainmei']) === raw,
  );
  if (found === undefined) return null;
  return asStr(found['tm09_SyainCode']);
}

function resolvePartnerCodeByMapping(
  rawCode: string,
  oldId: number,
  mapping?: EtlMappingConfig,
): { skip: boolean; resolvedCode: string } {
  const dupRules =
    mapping !== undefined && mapping.duplicatePartnerResolutions !== undefined
      ? mapping.duplicatePartnerResolutions
      : undefined;
  if (dupRules === undefined) {
    return { skip: false, resolvedCode: rawCode };
  }
  const ruleList = dupRules[rawCode];
  if (ruleList === undefined) {
    return { skip: false, resolvedCode: rawCode };
  }
  const rule = ruleList.find((x) => x.byOldId === oldId);
  if (rule === undefined) {
    return { skip: false, resolvedCode: rawCode };
  }
  if (rule.action === 'skip') {
    return { skip: true, resolvedCode: rawCode };
  }
  if (rule.action === 'rename' && rule.targetCode !== undefined) {
    return { skip: false, resolvedCode: rule.targetCode };
  }
  return { skip: false, resolvedCode: rawCode };
}

function toFiniteNumber(val: unknown): number {
  if (val === null || val === undefined || val === '') return 0;
  const n = Number(val);
  return Number.isFinite(n) ? n : 0;
}

export function extractAccdbWith32BitPowerShell(accdbPath: string, outJsonPath: string): AccdbDump {
  const ps32 = path.join(
    process.env.SystemRoot === undefined ? 'C:\\Windows' : process.env.SystemRoot,
    'SysWOW64',
    'WindowsPowerShell',
    'v1.0',
    'powershell.exe',
  );
  const psScript = path.resolve(process.cwd(), 'scripts', 'etl', 'export-accdb.ps1');
  execFileSync(
    ps32,
    [
      '-NoProfile',
      '-ExecutionPolicy',
      'Bypass',
      '-File',
      psScript,
      '-AccdbPath',
      accdbPath,
      '-OutputJsonPath',
      outJsonPath,
    ],
    { stdio: 'pipe', encoding: 'utf8' },
  );
  const raw = fs.readFileSync(outJsonPath, 'utf8');
  return JSON.parse(raw) as AccdbDump;
}

/**
 * Phase 1: Dry-Run 事前汚れ診断 (D1〜D6)
 */
export function runDryRunDiagnostics(params: {
  dump: AccdbDump;
  tenantSlug: string;
  tenantName: string;
  cutoffDate: string;
  mapping?: EtlMappingConfig;
}): DiagnosticReport {
  const { dump, tenantSlug, tenantName, cutoffDate, mapping } = params;
  const blockers: DiagnosticReport['blockers'] = [];
  const warnings: DiagnosticReport['warnings'] = [];

  // D1: 重複自然キー検査
  const d1Duplicates: DiagnosticReport['d1Duplicates'] = [];
  const dupChecks: Array<{ table: string; col: string }> = [
    { table: 'tm01_Kokyakubunrui', col: 'tm01_KokyakuCode' },
    { table: 'tm03_Shohin', col: 'tm03_ShohinCode' },
    { table: 'tm09_Syain', col: 'tm09_SyainCode' },
    { table: 'tm25_Construction', col: 'tm25_No' },
    { table: 'trx_Quotation', col: 'trx_QuotationNo' },
    { table: 'trx_Order', col: 'trx_OrderNo' },
    { table: 'trx_Purchase', col: 'trx_PurchaseNo' },
  ];

  for (const chk of dupChecks) {
    const map = new Map<string, unknown[]>();
    for (const r of getRows(dump, chk.table)) {
      const k = asStr(r[chk.col]);
      if (k === '') continue;
      const list = map.get(k);
      if (list === undefined) {
        map.set(k, [r['ID']]);
      } else {
        list.push(r['ID']);
      }
    }
    for (const [val, ids] of map.entries()) {
      if (ids.length > 1) {
        d1Duplicates.push({ table: chk.table, column: chk.col, value: val, count: ids.length, ids });
        const hasMapping =
          chk.table === 'tm01_Kokyakubunrui' &&
          mapping !== undefined &&
          mapping.duplicatePartnerResolutions !== undefined &&
          mapping.duplicatePartnerResolutions[val] !== undefined;
        if (!hasMapping) {
          blockers.push({
            code: 'D1_DUPLICATE_NATURAL_KEY',
            message: `${chk.table}.${chk.col}='${val}' が ${ids.length} 件重複しています (--mapping で解決が必要)`,
            details: { table: chk.table, value: val, ids },
          });
        }
      }
    }
  }

  // D2: 孤立参照検査
  const d2Orphans: DiagnosticReport['d2Orphans'] = [];
  const validConst = new Set(
    getRows(dump, 'tm25_Construction')
      .map((r) => asStr(r['tm25_No']))
      .filter((s) => s !== '' && s !== '0'),
  );
  const validPartner = new Set(
    getRows(dump, 'tm01_Kokyakubunrui')
      .map((r) => asStr(r['tm01_KokyakuCode']))
      .filter((s) => s !== ''),
  );
  const validPurchase = new Set(
    getRows(dump, 'trx_Purchase')
      .map((r) => asStr(r['trx_PurchaseNo']))
      .filter((s) => s !== ''),
  );

  const orphanSpecs: Array<{
    table: string;
    col: string;
    valid: Set<string>;
    target: string;
    idCol: string;
  }> = [
    { table: 'tm05_Uriage', col: 'tm05_ConstructionNo', valid: validConst, target: 'tm25_Construction', idCol: 'ID' },
    { table: 'tm26_Expense', col: 'tm26_ConstructionNo', valid: validConst, target: 'tm25_Construction', idCol: 'ID' },
    {
      table: 'tm26_ExpenseCost',
      col: 'tm26_ConstructionNo',
      valid: validConst,
      target: 'tm25_Construction',
      idCol: 'ID',
    },
    { table: 'tm27_Labor', col: 'tm27_ConstructionNo', valid: validConst, target: 'tm25_Construction', idCol: 'ID' },
    {
      table: 'tm27_LaborCost',
      col: 'tm27_ConstructionNo',
      valid: validConst,
      target: 'tm25_Construction',
      idCol: 'ID',
    },
    { table: 'tm28_Material', col: 'tm28_ConstructionNo', valid: validConst, target: 'tm25_Construction', idCol: 'ID' },
    {
      table: 'tm28_MaterialCost',
      col: 'tm28_ConstructionNo',
      valid: validConst,
      target: 'tm25_Construction',
      idCol: 'ID',
    },
    {
      table: 'tm29_Outsourcing',
      col: 'tm29_ConstructionNo',
      valid: validConst,
      target: 'tm25_Construction',
      idCol: 'ID',
    },
    {
      table: 'tm29_OutsourcingCost',
      col: 'tm29_ConstructionNo',
      valid: validConst,
      target: 'tm25_Construction',
      idCol: 'ID',
    },
    {
      table: 'tm30_Temporary',
      col: 'tm30_ConstructionNo',
      valid: validConst,
      target: 'tm25_Construction',
      idCol: 'ID',
    },
    {
      table: 'tm30_TemporaryCost',
      col: 'tm30_ConstructionNo',
      valid: validConst,
      target: 'tm25_Construction',
      idCol: 'ID',
    },
    { table: 'tm31_Indirect', col: 'tm31_ConstructionNo', valid: validConst, target: 'tm25_Construction', idCol: 'ID' },
    {
      table: 'tm31_IndirectCost',
      col: 'tm31_ConstructionNo',
      valid: validConst,
      target: 'tm25_Construction',
      idCol: 'ID',
    },
    { table: 'tm05_Uriage', col: 'tm05_KokyakuCode', valid: validPartner, target: 'tm01_Kokyakubunrui', idCol: 'ID' },
    { table: 'tm23_Kaikakekin', col: 'tm23_ShiireNo', valid: validPurchase, target: 'trx_Purchase', idCol: 'ID' },
  ];

  for (const sp of orphanSpecs) {
    for (const r of getRows(dump, sp.table)) {
      const val = asStr(r[sp.col]);
      if (val === '' || val === '0') continue;
      if (!sp.valid.has(val)) {
        d2Orphans.push({
          table: sp.table,
          column: sp.col,
          targetTable: sp.target,
          missingValue: val,
          rowId: r[sp.idCol],
        });
      }
    }
  }

  if (d2Orphans.length > 0) {
    warnings.push({
      code: 'D2_ORPHAN_REFERENCES',
      message: `${d2Orphans.length} 件の親レコード不在（孤立参照）を検出しました`,
      details: d2Orphans,
    });
  }

  // D3: P3 (仕入済) かつ tm23_Kaikakekin 欠損検査
  const kaikePurchaseNos = new Set(getRows(dump, 'tm23_Kaikakekin').map((r) => asStr(r['tm23_ShiireNo'])));
  const d3MissingPayables: DiagnosticReport['d3MissingPayables'] = [];
  for (const p of getRows(dump, 'trx_Purchase')) {
    const pNoStr = asStr(p['trx_PurchaseNo']);
    const pDate = toDateOnly(p['trx_PurchaseDay']);
    if (asStr(p['trx_KanriFlg']) === 'P3' && !kaikePurchaseNos.has(pNoStr)) {
      d3MissingPayables.push({
        purchaseNo: Number(pNoStr),
        purchaseDate: pDate === null ? '' : pDate,
        partnerCode: asStr(p['trx_KokyakuCode']),
        totalAmount: toBigIntYen(p['trx_Goukei'], `Purchase#${pNoStr}`).toString(),
      });
    }
  }
  if (d3MissingPayables.length > 0) {
    warnings.push({
      code: 'D3_P3_MISSING_PAYABLE',
      message: `仕入済(P3)にもかかわらず買掛(tm23_Kaikakekin)未生成が ${d3MissingPayables.length} 件あります`,
      details: d3MissingPayables,
    });
  }

  // D4: ヘッダ vs 明細検算 (calculations.ts LEGACY_LINE_SUM) & *Cost破損 & ダミー行検査
  const slipChecks: DiagnosticReport['d4MathAndCostIssues']['slipChecks'] = [];
  const checkHeaderDetail = (
    kind: string,
    headers: RawRow[],
    lines: RawRow[],
    noCol: string,
    hdrTotCol: string,
    zeikeisanCol: string,
    qtyCol: string,
    tankaCol: string,
    zeiCol: string,
  ) => {
    for (const h of headers) {
      const no = asStr(h[noCol]);
      const matching = lines.filter((l) => asStr(l[noCol]) === no);
      const calcInputs: LineCalcInput[] = matching.map((l, idx) => ({
        lineNo: idx + 1,
        quantity: toQtyStr(l[qtyCol]),
        unitPrice: toBigIntYen(l[tankaCol], `${kind}#${no}`),
        taxCode: toTaxCode(l[zeiCol]),
        roundingMode: toRoundingMode(h[zeikeisanCol]),
      }));
      const res = calculateSlipTotals(calcInputs, toRoundingMode(h[zeikeisanCol]), 'LEGACY_LINE_SUM');
      const hdrTot = toBigIntYen(h[hdrTotCol], `${kind}#${no}`);
      slipChecks.push({
        kind,
        slipNo: no,
        hdrTotal: hdrTot.toString(),
        calcTotal: res.totalIncl.toString(),
        match: hdrTot === res.totalIncl,
      });
    }
  };

  checkHeaderDetail(
    'Quotation',
    getRows(dump, 'trx_Quotation'),
    getRows(dump, 'trx_QuotationList'),
    'trx_QuotationNo',
    'trx_Goukei',
    'trx_ZeiKeisan',
    'trx_qty',
    'trx_Tanka',
    'trx_ZeiCode',
  );
  checkHeaderDetail(
    'Order',
    getRows(dump, 'trx_Order'),
    getRows(dump, 'trx_OrderList'),
    'trx_OrderNo',
    'trx_Goukei',
    'trx_ZeiKeisan',
    'trx_qty',
    'trx_Tanka',
    'trx_ZeiCode',
  );
  checkHeaderDetail(
    'Purchase',
    getRows(dump, 'trx_Purchase'),
    getRows(dump, 'trx_PurchaseList'),
    'trx_PurchaseNo',
    'trx_Goukei',
    'trx_ZeiKeisan',
    'trx_qty',
    'trx_Tanka',
    'trx_ZeiCode',
  );

  // tm05_Uriage / tm21_AdvancesPaid (ヘッダ・明細同居型を伝票Noでグルーピング検算)
  const checkDenormSlips = (
    kind: string,
    rows: RawRow[],
    noCol: string,
    totCol: string,
    zeikeisanCol: string,
    qtyCol: string,
    tankaCol: string,
    zeiCol: string,
  ) => {
    const byNo = new Map<string, RawRow[]>();
    for (const r of rows) {
      const no = asStr(r[noCol]);
      const arr = byNo.get(no);
      if (arr === undefined) byNo.set(no, [r]);
      else arr.push(r);
    }
    for (const [no, group] of byNo.entries()) {
      const first = group[0];
      if (first === undefined) continue;
      const mode = toRoundingMode(first[zeikeisanCol]);
      const calcInputs: LineCalcInput[] = group.map((l, idx) => ({
        lineNo: idx + 1,
        quantity: toQtyStr(l[qtyCol]),
        unitPrice: toBigIntYen(l[tankaCol], `${kind}#${no}`),
        taxCode: toTaxCode(l[zeiCol]),
        roundingMode: mode,
      }));
      const res = calculateSlipTotals(calcInputs, mode, 'LEGACY_LINE_SUM');
      const hdrTot = toBigIntYen(first[totCol], `${kind}#${no}`);
      slipChecks.push({
        kind,
        slipNo: no,
        hdrTotal: hdrTot.toString(),
        calcTotal: res.totalIncl.toString(),
        match: hdrTot === res.totalIncl,
      });
    }
  };

  checkDenormSlips(
    'Sales',
    getRows(dump, 'tm05_Uriage'),
    'tm05_UriageNo',
    'tm05_Total',
    'tm05_ZeiKeisan',
    'tm05_qty',
    'tm05_Tanka',
    'tm05_ZeiCode',
  );
  checkDenormSlips(
    'AdvancesPaid',
    getRows(dump, 'tm21_AdvancesPaid'),
    'tm21_APNo',
    'tm21_Total',
    'tm21_ZeiKeisan',
    'tm21_qty',
    'tm21_Tanka',
    'tm21_ZeiCode',
  );

  // *Cost テーブル破損検査（明細金額0かつヘッダTotal>0）＆ ダミー行検査
  const corruptedCostRows: DiagnosticReport['d4MathAndCostIssues']['corruptedCostRows'] = [];
  const dummyOrEmptyRows: DiagnosticReport['d4MathAndCostIssues']['dummyOrEmptyRows'] = [];
  const costTables = [
    'tm26_Expense',
    'tm26_ExpenseCost',
    'tm27_Labor',
    'tm27_LaborCost',
    'tm28_Material',
    'tm28_MaterialCost',
    'tm29_Outsourcing',
    'tm29_OutsourcingCost',
    'tm30_Temporary',
    'tm30_TemporaryCost',
    'tm31_Indirect',
    'tm31_IndirectCost',
  ];

  for (const tbl of costTables) {
    const pref = tbl.slice(0, 4);
    for (const r of getRows(dump, tbl)) {
      const mNo = Number(r[`${pref}_MeisaiNo`]);
      const qty = Number(r[`${pref}_qty`]);
      if (mNo === 0 && qty === 0) {
        dummyOrEmptyRows.push({ table: tbl, id: r['ID'], reason: 'MeisaiNo=0 かつ qty=0 の仮ダミー行' });
        continue;
      }
      const detKak = toBigIntYen(r[`${pref}_Kakaku`], tbl);
      const detRowTot = toBigIntYen(r[`${pref}_RowTotal`], tbl);
      const hdrTot = toBigIntYen(r[`${pref}_Total`], tbl);
      if (detKak === 0n && detRowTot === 0n && hdrTot > 0n) {
        corruptedCostRows.push({
          table: tbl,
          id: r['ID'],
          constructionNo: asStr(r[`${pref}_ConstructionNo`]),
          headerTotal: hdrTot.toString(),
          detailSum: '0',
        });
      }
    }
  }

  for (const q of getRows(dump, 'trx_Quotation')) {
    if (asNullableStr(q['trx_QuotationName']) === null && toBigIntYen(q['trx_Goukei'], 'trx_Quotation') === 0n) {
      dummyOrEmptyRows.push({ table: 'trx_Quotation', id: q['trx_QuotationNo'], reason: '件名NULL・金額0の空見積' });
    }
  }

  if (corruptedCostRows.length > 0) {
    warnings.push({
      code: 'D4_COST_HEADER_CORRUPTION',
      message: `*Cost テーブル等に明細0円・ヘッダ金額残存の破損行を ${corruptedCostRows.length} 件検出しました`,
      details: corruptedCostRows,
    });
  }

  // D5: スキーマ・型・全角誤字・機密・改行検査
  const syainRows = getRows(dump, 'tm09_Syain');
  const fullWidthColumnDetected = syainRows.some((r) =>
    Object.prototype.hasOwnProperty.call(r, 't\uff4d09_Retirement'),
  );
  const daihyouRows = getRows(dump, 'tm02_Daihyou');
  const hasMyNumberColumn = daihyouRows.some((r) => Object.prototype.hasOwnProperty.call(r, 'tm02_MyNumber'));
  const plaintextPasswordCount = syainRows.filter((r) => asNullableStr(r['tm09_Password']) !== null).length;

  const multilineItemNames: DiagnosticReport['d5SchemaAnomalies']['multilineItemNames'] = [];
  for (const u of getRows(dump, 'tm05_Uriage')) {
    const nm = asStr(u['tm05_Shohinmei']);
    if (nm.includes('\n') || nm.includes('\r')) {
      multilineItemNames.push({ table: 'tm05_Uriage', id: u['ID'], itemName: nm });
    }
  }

  const shiftedWorkRows: DiagnosticReport['d5SchemaAnomalies']['shiftedWorkRows'] = [];
  const wAplus = getRows(dump, 'w_Aplus');
  if (wAplus.length > 0) {
    shiftedWorkRows.push({ table: 'w_Aplus', count: wAplus.length, sample: wAplus[0] === undefined ? null : wAplus[0] });
  }

  // D6: 期首売掛・買掛残高プレビュー (cutoffDate まで)
  const d6OpeningBalances: DiagnosticReport['d6OpeningBalances'] = [];
  const urikakeRows = getRows(dump, 'tm19_Urikakekin');
  const cashRows = getRows(dump, 'tm18_CashRecipts');
  const kaikeRows = getRows(dump, 'tm23_Kaikakekin');
  const payRows = getRows(dump, 'tm24_PaymentList');
  const purchaseRows = getRows(dump, 'trx_Purchase');

  for (const partner of getRows(dump, 'tm01_Kokyakubunrui')) {
    const oldId = Number(partner['ID']);
    const pCode = asStr(partner['tm01_KokyakuCode']);
    const resolved = resolvePartnerCodeByMapping(pCode, oldId, mapping);
    if (resolved.skip) continue;
    const pName = asStr(partner['tm01_Syamei']);
    const carriedMoney = toBigIntYen(partner['tm01_CarriedMoney'], `partner#${pCode}`);
    const carriedPay = toBigIntYen(partner['tm01_CarriedPay'], `partner#${pCode}`);

    let arBilled = 0n;
    for (const r of urikakeRows) {
      const dt = toDateOnly(r['tm19_SeikyuD']);
      if (asStr(r['tm19_KokyakuCode']) === pCode && dt !== null && dt <= cutoffDate) {
        arBilled += toBigIntYen(r['tm19_SeikyuKingaku'], 'tm19');
      }
    }
    let arReceived = 0n;
    for (const r of cashRows) {
      const dt = toDateOnly(r['tm18_CashReciptsDay']);
      if (asStr(r['tm18_KokyakuCode']) === pCode && dt !== null && dt <= cutoffDate) {
        arReceived +=
          toBigIntYen(r['tm18_Deposit1'], 'tm18') +
          toBigIntYen(r['tm18_Deposit2'], 'tm18') +
          toBigIntYen(r['tm18_Deposit3'], 'tm18');
      }
    }
    const arRes = calculateArBalance({
      openingBalanceAtCutoff: carriedMoney,
      beforePeriodIncreases: arBilled,
      beforePeriodDecreases: arReceived,
      inPeriodIncreases: 0n,
      inPeriodDecreases: 0n,
    });

    let apPayable = 0n;
    for (const r of kaikeRows) {
      const dt = toDateOnly(r['tm23_ShiireD']);
      if (asStr(r['tm23_KokyakuCode']) === pCode && dt !== null && dt <= cutoffDate) {
        apPayable += toBigIntYen(r['tm23_ShiireKingaku'], 'tm23');
      }
    }
    let apPaid = 0n;
    for (const r of payRows) {
      const dt = toDateOnly(r['tm24_PaymentDay']);
      if (asStr(r['tm24_KokyakuCode']) === pCode && dt !== null && dt <= cutoffDate) {
        apPaid +=
          toBigIntYen(r['tm24_Deposit1'], 'tm24') +
          toBigIntYen(r['tm24_Deposit2'], 'tm24') +
          toBigIntYen(r['tm24_Deposit3'], 'tm24') +
          toBigIntYen(r['tm24_DeductionDeposit1'], 'tm24') +
          toBigIntYen(r['tm24_DeductionDeposit2'], 'tm24') +
          toBigIntYen(r['tm24_DeductionDeposit3'], 'tm24');
      }
    }
    const apRes = calculateApBalance({
      openingBalanceAtCutoff: carriedPay,
      beforePeriodIncreases: apPayable,
      beforePeriodDecreases: apPaid,
      inPeriodIncreases: 0n,
      inPeriodDecreases: 0n,
    });

    let unpostedP3Delta = 0n;
    for (const pur of purchaseRows) {
      const pNoStr = asStr(pur['trx_PurchaseNo']);
      const dt = toDateOnly(pur['trx_PurchaseDay']);
      if (
        asStr(pur['trx_KokyakuCode']) === pCode &&
        asStr(pur['trx_KanriFlg']) === 'P3' &&
        !kaikePurchaseNos.has(pNoStr) &&
        dt !== null &&
        dt <= cutoffDate
      ) {
        unpostedP3Delta += toBigIntYen(pur['trx_Goukei'], 'P3_delta');
      }
    }

    d6OpeningBalances.push({
      oldId,
      partnerCode: pCode,
      resolvedPartnerCode: resolved.resolvedCode,
      partnerName: pName,
      carriedMoney: carriedMoney.toString(),
      arBilledUntilCutoff: arBilled.toString(),
      arReceivedUntilCutoff: arReceived.toString(),
      openingArBalance: arRes.closingBalance.toString(),
      carriedPay: carriedPay.toString(),
      apPayableUntilCutoff: apPayable.toString(),
      apPaidUntilCutoff: apPaid.toString(),
      openingApBalance: apRes.closingBalance.toString(),
      unpostedP3PurchaseDelta: unpostedP3Delta.toString(),
    });
  }

  return {
    tenantSlug,
    tenantName,
    cutoffDate,
    accdbPath: dump.accdbPath,
    generatedAt: new Date().toISOString(),
    blockers,
    warnings,
    d1Duplicates,
    d2Orphans,
    d3MissingPayables,
    d4MathAndCostIssues: {
      slipChecks,
      corruptedCostRows,
      dummyOrEmptyRows,
    },
    d5SchemaAnomalies: {
      fullWidthColumnDetected,
      hasMyNumberColumn,
      plaintextPasswordCount,
      multilineItemNames,
      shiftedWorkRows,
    },
    d6OpeningBalances,
  };
}

/**
 * 移行対象となる仕掛原価グループ (カテゴリ × 工事番号) を抽出
 */
interface MigratedCostGroup {
  category: CostCategory;
  prefix: string;
  constructionNo: string;
  slipTitle: string;
  entryDate: string;
  status: string;
  roundingMode: RoundingMode;
  subtotalAmount: bigint;
  taxTotal: bigint;
  totalAmount: bigint;
  costSubtotal: bigint;
  costTaxTotal: bigint;
  costTotal: bigint;
  lines: Array<{
    lineNo: number;
    itemCode: string | null;
    itemName: string;
    unitName: string | null;
    quantity: number;
    taxCode: TaxCode;
    appliedUnitPrice: bigint;
    lineAmount: bigint;
    lineTax: bigint;
    lineTotal: bigint;
    appliedCostPrice: bigint;
    costAmount: bigint;
    costTax: bigint;
    costTotal: bigint;
    remarks: string | null;
  }>;
}

function collectMigratedCostGroups(params: {
  dump: AccdbDump;
  wipConstructionNos: Set<string>;
  projectDateByNo: Map<string, string>;
  mapping?: EtlMappingConfig;
}): MigratedCostGroup[] {
  const skipDummy =
    params.mapping !== undefined && params.mapping.skipDummyRows !== undefined
      ? params.mapping.skipDummyRows
      : true;
  const quarantineOrphans =
    params.mapping !== undefined && params.mapping.quarantineOrphanConstructionNos !== undefined
      ? params.mapping.quarantineOrphanConstructionNos
      : true;

  const groups: MigratedCostGroup[] = [];

  for (const spec of COST_TABLE_SPECS) {
    const pref = spec.prefix;
    const rows = getRows(params.dump, spec.table);
    const costRows = getRows(params.dump, spec.costTable);

    const byConst = new Map<string, RawRow[]>();
    for (const r of rows) {
      const mNo = Number(r[`${pref}_MeisaiNo`]);
      const qty = Number(r[`${pref}_qty`]);
      if (skipDummy && mNo === 0 && qty === 0) continue;
      const cNo = asStr(r[`${pref}_ConstructionNo`]);
      if (cNo === '' || cNo === '0') continue;
      if (!params.wipConstructionNos.has(cNo)) {
        if (quarantineOrphans) continue;
        throw new Error(`原価テーブル ${spec.table} に存在しない案件番号 '${cNo}' が含まれています`);
      }
      const list = byConst.get(cNo);
      if (list === undefined) byConst.set(cNo, [r]);
      else list.push(r);
    }

    for (const [cNo, rawLines] of byConst.entries()) {
      const first = rawLines[0];
      if (first === undefined) continue;
      const explicitDate = toDateOnly(first[`${pref}_Date`]);
      const regDate = toDateOnly(first[`${pref}_regD`]);
      const projDate = params.projectDateByNo.get(cNo);
      let entryDate: string | null = null;
      if (explicitDate !== null) entryDate = explicitDate;
      else if (regDate !== null) entryDate = regDate;
      else if (projDate !== undefined) entryDate = projDate;
      if (entryDate === null) {
        throw new Error(`原価グループ (${spec.category}, 案件#${cNo}) の entry_date が特定できません`);
      }

      const sortedLines = [...rawLines].sort(
        (a, b) => Number(a[`${pref}_MeisaiNo`]) - Number(b[`${pref}_MeisaiNo`]),
      );

      // 対応する *Cost テーブルの非破損明細を突き合わせる
      const costRowByMeisai = new Map<number, RawRow>();
      for (const cr of costRows) {
        if (asStr(cr[`${pref}_ConstructionNo`]) !== cNo) continue;
        const mNo = Number(cr[`${pref}_MeisaiNo`]);
        const cQty = Number(cr[`${pref}_qty`]);
        if (skipDummy && mNo === 0 && cQty === 0) continue;
        const cKak = toBigIntYen(cr[`${pref}_Kakaku`], spec.costTable);
        const cRowTot = toBigIntYen(cr[`${pref}_RowTotal`], spec.costTable);
        if (cKak === 0n && cRowTot === 0n) continue;
        costRowByMeisai.set(mNo, cr);
      }

      let sumCostSub = 0n;
      let sumCostTax = 0n;
      let sumCostTot = 0n;

      const builtLines = sortedLines.map((l, idx) => {
        const mNo = Number(l[`${pref}_MeisaiNo`]);
        const taxCode = toTaxCode(l[`${pref}_ZeiCode`]);
        const kak = toBigIntYen(l[`${pref}_Kakaku`], `${spec.table}#${cNo}`);
        const syo = toBigIntYen(l[`${pref}_Syouhizei`], `${spec.table}#${cNo}`);
        const rowTot = taxCode === 'D' || taxCode === 'E' ? kak : kak + syo;

        const cr = costRowByMeisai.get(mNo);
        let appliedCost = 0n;
        let cAmount = 0n;
        let cTax = 0n;
        let cTotal = 0n;
        if (cr !== undefined) {
          const crTaxCode = toTaxCode(cr[`${pref}_ZeiCode`]);
          appliedCost = toBigIntYen(cr[`${pref}_Tanka`], `${spec.costTable}#${cNo}`);
          cAmount = toBigIntYen(cr[`${pref}_Kakaku`], `${spec.costTable}#${cNo}`);
          cTax = toBigIntYen(cr[`${pref}_Syouhizei`], `${spec.costTable}#${cNo}`);
          cTotal = crTaxCode === 'D' || crTaxCode === 'E' ? cAmount : cAmount + cTax;
          const crExcl = crTaxCode === 'D' || crTaxCode === 'E' ? cTotal - cTax : cAmount;
          sumCostSub += crExcl;
          sumCostTax += cTax;
          sumCostTot += cTotal;
        }

        return {
          lineNo: idx + 1,
          itemCode: asNullableStr(l[`${pref}_ShohinCode`]),
          itemName: asStr(l[`${pref}_Shohinmei`]),
          unitName: asNullableStr(l[`${pref}_Tani`]),
          quantity: toFiniteNumber(l[`${pref}_qty`]),
          taxCode,
          appliedUnitPrice: toBigIntYen(l[`${pref}_Tanka`], `${spec.table}#${cNo}`),
          lineAmount: kak,
          lineTax: syo,
          lineTotal: rowTot,
          appliedCostPrice: appliedCost,
          costAmount: cAmount,
          costTax: cTax,
          costTotal: cTotal,
          remarks: asNullableStr(l[`${pref}_Bikou`]),
        };
      });

      const statusRaw = asStr(first[`${pref}_KanriCode`]);
      const status = statusRaw === 'C1' || statusRaw === 'C2' || statusRaw === 'C3' ? statusRaw : 'C2';

      groups.push({
        category: spec.category,
        prefix: pref,
        constructionNo: cNo,
        slipTitle: asStr(first[`${pref}_Name`]),
        entryDate,
        status,
        roundingMode: toRoundingMode(first[`${pref}_ZeiKeisan`]),
        subtotalAmount: toBigIntYen(first[`${pref}_SubTotal`], `${spec.table}#${cNo}`),
        taxTotal: toBigIntYen(first[`${pref}_TaxTotal`], `${spec.table}#${cNo}`),
        totalAmount: toBigIntYen(first[`${pref}_Total`], `${spec.table}#${cNo}`),
        costSubtotal: sumCostSub,
        costTaxTotal: sumCostTax,
        costTotal: sumCostTot,
        lines: builtLines,
      });
    }
  }

  return groups;
}

/**
 * Phase 2: Execute (DIRECT_DATABASE_URL Session Pooler 経由・単一ACID トランザクション投入)
 */
async function executeMigration(params: {
  dump: AccdbDump;
  diag: DiagnosticReport;
  tenantSlug: string;
  tenantName: string;
  cutoffDate: string;
  mapping?: EtlMappingConfig;
}): Promise<{ tenantId: string; insertedCounts: Record<string, number> }> {
  if (params.diag.blockers.length > 0) {
    throw new Error(
      `Dry-Run で ${params.diag.blockers.length} 件の未解決ブロッカーが検出されたため execute を中止しました`,
    );
  }

  const directUrl = requireEnv('DIRECT_DATABASE_URL');
  const encKey = requireEnv('FIELD_ENCRYPTION_KEY_HEX');
  const pool = new Pool(createPgPoolConfig(directUrl));
  const client = await pool.connect();

  try {
    await client.query('BEGIN');
    await client.query("SELECT set_config('app.etl_bypass_cutoff', 'on', true)");

    const tRes = await client.query<{ id: string }>(
      'INSERT INTO tenants (tenant_slug, tenant_name) VALUES ($1, $2) RETURNING id',
      [params.tenantSlug, params.tenantName],
    );
    const tenantRow = tRes.rows[0];
    if (tenantRow === undefined) {
      throw new Error('tenants 作成に失敗しました');
    }
    const tenantId = tenantRow.id;
    await client.query("SELECT set_config('app.current_tenant_id', $1, true)", [tenantId]);
    await client.query('SELECT seed_tenant_defaults($1)', [tenantId]);

    // 1. tenant_settings (tm10_Zisya + ReleaseInfo + T_Maintenance)
    const rel = getRows(params.dump, 'ReleaseInfo')[0];
    const zisya = getRows(params.dump, 'tm10_Zisya')[0];
    const maint = getRows(params.dump, 'T_Maintenance')[0];
    if (rel === undefined || zisya === undefined || maint === undefined) {
      throw new Error('ReleaseInfo / tm10_Zisya / T_Maintenance が不足しています');
    }

    const bankNo1 = asNullableStr(zisya['tm10_BankNo']);
    const bankNo2 = asNullableStr(zisya['tm10_BankNo2']);

    await client.query(
      `INSERT INTO tenant_settings (
        tenant_id, company_code, company_name, invoice_registration_no, corporate_no,
        postal_code, address1, address2, tel, fax, email, representative_title, representative_name,
        fiscal_closing_month, billing_memo,
        bank_code_1, branch_code_1, bank_account_type_1, bank_account_no_1_enc, bank_account_holder_1,
        bank_code_2, branch_code_2, bank_account_type_2, bank_account_no_2_enc, bank_account_holder_2,
        approval_flow_enabled, allow_billing_date_warning_skip, default_approval_billing_date,
        default_ar_list_date_mode, quotation_template_rows, show_invoice_carryover, cost_tax_mode,
        opening_balance_date, release_version, release_notice, show_release_notice, maintenance_mode, maintenance_memo
      ) VALUES (
        $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,
        $21,$22,$23,$24,$25,$26,$27,$28,$29,$30,$31,$32,$33,$34,$35,$36,$37,$38
      )`,
      [
        tenantId,
        asStr(zisya['tm10_ZisyaCode']),
        asStr(zisya['tm10_Zisyamei']),
        asNullableStr(zisya['tm10_ZTourokuNo']),
        asNullableStr(zisya['tm10_ZHouzinNo']),
        asNullableStr(zisya['tm10_ZisyaYubin']),
        asNullableStr(zisya['tm10_ZisyaAddress']),
        asNullableStr(zisya['tm10_ZisyaAddress2']),
        asNullableStr(zisya['tm10_ZisyaTEL']),
        asNullableStr(zisya['tm10_ZisyaFAX']),
        asNullableStr(zisya['tm10_Mail']),
        asNullableStr(zisya['tm10_Yakusyoku']),
        asNullableStr(zisya['tm10_Daihyou']),
        Number(zisya['tm10_Kessantuki']),
        asNullableStr(zisya['tm10_billing_memo']),
        asNullableStr(zisya['tm10_BankCode']),
        asNullableStr(zisya['tm10_ShitenCode']),
        asNullableStr(zisya['tm10_BankType']),
        bankNo1 === null ? null : encryptField(bankNo1, encKey),
        asNullableStr(zisya['tm10_Bankaccount']),
        asNullableStr(zisya['tm10_BankCode2']),
        asNullableStr(zisya['tm10_ShitenCode2']),
        asNullableStr(zisya['tm10_BankType2']),
        bankNo2 === null ? null : encryptField(bankNo2, encKey),
        asNullableStr(zisya['tm10_Bankaccount2']),
        Number(rel['承認フローモード']) === 1,
        Boolean(rel['承認請求日警告スルーフラグ']),
        Number(rel['承認デフォルト請求日']),
        Number(rel['売掛一覧デフォルト日付']),
        Number(rel['見積書タイプ']) === 1 ? 20 : 10,
        Boolean(rel['請求書繰越表示フラグ']),
        Number(rel['原価管理税']) === 1 ? 'TAX_INCLUDED' : 'TAX_EXCLUDED',
        params.cutoffDate,
        asStr(rel['バージョン情報']),
        asNullableStr(rel['リリース内容']),
        Boolean(rel['表示フラグ']),
        Boolean(maint['MaintenanceMode']),
        asNullableStr(maint['MaintenanceMemo']),
      ],
    );

    // 2. M_FunctionAuthority 上書き同期 (29機能)
    for (const auth of getRows(params.dump, 'M_FunctionAuthority')) {
      await client.query(
        `INSERT INTO tenant_feature_authorities (tenant_id, feature_code, feature_name, is_enabled, display_order, is_fixed)
         VALUES ($1, $2, $3, $4, $5, $6)
         ON CONFLICT (tenant_id, feature_code) DO UPDATE
         SET is_enabled = EXCLUDED.is_enabled, display_order = EXCLUDED.display_order, is_fixed = EXCLUDED.is_fixed`,
        [
          tenantId,
          asStr(auth['機能コード']),
          asStr(auth['機能名']),
          Boolean(auth['利用']),
          Number(auth['表示順']),
          Boolean(auth['固定']),
        ],
      );
    }

    // 3. banks (tm06_Bank) & bank_branches (tm07_Shiten)
    const bankIdByCode = new Map<string, string>();
    for (const bk of getRows(params.dump, 'tm06_Bank')) {
      const code = asStr(bk['tm06_BankCode']);
      const bkRes = await client.query<{ id: string }>(
        `INSERT INTO banks (tenant_id, bank_code, bank_name, furigana)
         VALUES ($1, $2, $3, $4) RETURNING id`,
        [tenantId, code, asStr(bk['tm06_BankName']), asNullableStr(bk['tm06_Furigana'])],
      );
      if (bkRes.rows[0] !== undefined) {
        bankIdByCode.set(code, bkRes.rows[0].id);
      }
    }

    const branchRows = getRows(params.dump, 'tm07_Shiten');
    let bankBranchCount = 0;
    const bankIdsArr: string[] = [];
    const bankCodesArr: string[] = [];
    const branchCodesArr: string[] = [];
    const branchNamesArr: string[] = [];
    const branchFuriganasArr: Array<string | null> = [];
    for (const br of branchRows) {
      const bCode = asStr(br['tm07_BankCode']);
      const bId = bankIdByCode.get(bCode);
      if (bId === undefined) {
        throw new Error(`tm07_Shiten の親銀行コード '${bCode}' が tm06_Bank に見つかりません`);
      }
      bankIdsArr.push(bId);
      bankCodesArr.push(bCode);
      branchCodesArr.push(asStr(br['tm07_ShitenCode']));
      branchNamesArr.push(asStr(br['tm07_ShitenName']));
      branchFuriganasArr.push(asNullableStr(br['tm07_Furigana']));
      bankBranchCount += 1;
    }
    if (bankIdsArr.length > 0) {
      await client.query(
        `INSERT INTO bank_branches (tenant_id, bank_id, bank_code, branch_code, branch_name, furigana)
         SELECT $1, u.bank_id, u.bank_code, u.branch_code, u.branch_name, u.furigana
           FROM UNNEST($2::uuid[], $3::text[], $4::text[], $5::text[], $6::text[])
             AS u(bank_id, bank_code, branch_code, branch_name, furigana)`,
        [tenantId, bankIdsArr, bankCodesArr, branchCodesArr, branchNamesArr, branchFuriganasArr],
      );
    }

    // 4. tax_offices (tm08_Zeimusyo) & mail_templates (tm20_MailRepetitive)
    let taxOfficeCount = 0;
    for (const txo of getRows(params.dump, 'tm08_Zeimusyo')) {
      await client.query(
        `INSERT INTO tax_offices (tenant_id, tax_office_code, tax_office_name, tax_office_no)
         VALUES ($1, $2, $3, $4)`,
        [
          tenantId,
          asStr(txo['tm08_ZeimuCode']),
          asStr(txo['tm08_ZeimusyoName']),
          asNullableStr(txo['tm08_ZeimusyoNo']),
        ],
      );
      taxOfficeCount += 1;
    }

    let mailTemplateCount = 0;
    for (const mt of getRows(params.dump, 'tm20_MailRepetitive')) {
      await client.query(
        `INSERT INTO mail_templates (tenant_id, template_no, template_name, subject, body_intro, body_main, body_footer)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [
          tenantId,
          Number(mt['tm20_MailRepetitiveNo']),
          asStr(mt['tm20_MailRepetitiveName']),
          asStr(mt['tm20_Title']),
          asNullableStr(mt['tm20_Text']),
          asNullableStr(mt['tm20_Text2']),
          asNullableStr(mt['tm20_Text3']),
        ],
      );
      mailTemplateCount += 1;
    }

    let inputIntelligenceCount = 0;
    for (const intel of getRows(params.dump, 'T_Intelligence')) {
      const itemName = asStr(intel['item_name']);
      if (itemName === '') continue;
      await client.query(
        `INSERT INTO input_intelligences (tenant_id, item_name, unit_name, unit_price, cost_price, tax_code)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [
          tenantId,
          itemName,
          asNullableStr(intel['unit_name']),
          toBigIntYen(intel['unit_price'], `T_Intelligence#${itemName}`).toString(),
          toBigIntYen(intel['cost_price'], `T_Intelligence#${itemName}`).toString(),
          toTaxCode(intel['tax_type']),
        ],
      );
      inputIntelligenceCount += 1;
    }

    // 5. employees (Argon2id ハッシュ化 + tｍ09_Retirement 正規化)
    const syainRows = getRows(params.dump, 'tm09_Syain');
    const empIdByCode = new Map<string, string>();
    for (const emp of syainRows) {
      const sCode = asStr(emp['tm09_SyainCode']);
      const rawPw = asStr(emp['tm09_Password']);
      const pwHash = hashPassword(rawPw === '' ? sCode : rawPw);
      const retRaw = asNullableStr(emp['t\uff4d09_Retirement']);
      const retiredAt = toDateOnly(emp['tm09_Taisyokubi']);
      const isRetired = retRaw === '1' || retRaw === 'true' || retiredAt !== null;
      const eRes = await client.query<{ id: string }>(
        `INSERT INTO employees (
          tenant_id, syain_code, syain_name, kana_name, password_hash, is_admin, menu_type,
          email, joined_at, birth_date, retired_at, is_retired, must_change_password
        ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) RETURNING id`,
        [
          tenantId,
          sCode,
          asStr(emp['tm09_Syainmei']),
          asNullableStr(emp['tm09_KanaSyain']),
          pwHash,
          Boolean(emp['tm09_Authority']),
          Number(emp['tm09_MenuType']),
          asNullableStr(emp['tm09_MailAddress']),
          toDateOnly(emp['tm09_Nyusyabi']),
          toDateOnly(emp['tm09_SBirthday']),
          retiredAt,
          isRetired,
          true,
        ],
      );
      if (eRes.rows[0] !== undefined) {
        empIdByCode.set(sCode, eRes.rows[0].id);
      }
    }

    // 6. representatives (tm02_MyNumber は完全破棄)
    const repIdByCode = new Map<number, string>();
    for (const rep of getRows(params.dump, 'tm02_Daihyou')) {
      const code = Number(rep['tm02_DaihyouCode']);
      const rRes = await client.query<{ id: string }>(
        `INSERT INTO representatives (
          tenant_id, representative_code, representative_name, furigana, postal_code, address1, address2, tel, mobile, birth_date, gender_code
        ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING id`,
        [
          tenantId,
          code,
          asStr(rep['tm02_DaihyouName']),
          asNullableStr(rep['tm02_Furigana']),
          asNullableStr(rep['tm02_Yubin']),
          asNullableStr(rep['tm02_Address1']),
          asNullableStr(rep['tm02_Address2']),
          asNullableStr(rep['tm02_Tel']),
          asNullableStr(rep['tm02_Mobile']),
          toDateOnly(rep['tm02_Birthday']),
          asNullableStr(rep['tm02_Seibetsu']),
        ],
      );
      if (rRes.rows[0] !== undefined) {
        repIdByCode.set(code, rRes.rows[0].id);
      }
    }

    // 7. business_partners (+ opening_ar_balance / opening_ap_balance / AES-256-GCM)
    const partnerIdByCode = new Map<string, string>();
    const balanceByOldId = new Map(params.diag.d6OpeningBalances.map((b) => [b.oldId, b]));

    for (const bp of getRows(params.dump, 'tm01_Kokyakubunrui')) {
      const oldId = Number(bp['ID']);
      const rawCode = asStr(bp['tm01_KokyakuCode']);
      const resolved = resolvePartnerCodeByMapping(rawCode, oldId, params.mapping);
      if (resolved.skip) continue;
      const code = resolved.resolvedCode;

      const daiCode = Number(bp['tm01_DaihyouCode']);
      const isIndiv = daiCode === 9999;
      const repId = isIndiv || daiCode === 0 ? null : repIdByCode.get(daiCode);
      const bal = balanceByOldId.get(oldId);
      const bpBankNo = asNullableStr(bp['tm01_BankNo']);
      const empCode = resolveEmployeeSyainCode(syainRows, bp['tm01_MyUser']);
      const assignedEmpId = empCode === null ? null : empIdByCode.get(empCode);

      const bpRes = await client.query<{ id: string }>(
        `INSERT INTO business_partners (
          tenant_id, partner_code, category_code, state_code, partner_name, furigana,
          representative_id, is_individual_honorific, postal_code, address1, address2, tel,
          is_client, is_supplier, is_aplus_enabled, send_mail_enabled, email,
          assigned_employee_id, opening_ar_balance, opening_ap_balance,
          bank_code, branch_code, bank_account_type, bank_account_no_enc, bank_account_holder, is_deleted
        ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25,$26) RETURNING id`,
        [
          tenantId,
          code,
          asNullableStr(bp['tm01_category']),
          asNullableStr(bp['tm01_Zyoutai']),
          asStr(bp['tm01_Syamei']),
          asNullableStr(bp['tm01_sFurigana']),
          repId === undefined ? null : repId,
          isIndiv,
          asNullableStr(bp['tm01_sYubin']),
          asNullableStr(bp['tm01_sAddress1']),
          asNullableStr(bp['tm01_sAddress2']),
          asNullableStr(bp['tm01_sTel']),
          Boolean(bp['tm01_ClientFlag']),
          Boolean(bp['tm01_SupplierFlag']),
          Boolean(bp['tm01_AplusFlag']),
          Boolean(bp['tm01_SendMail']),
          asNullableStr(bp['tm01_MailAddress']),
          assignedEmpId === undefined ? null : assignedEmpId,
          bal === undefined ? '0' : bal.openingArBalance,
          bal === undefined ? '0' : bal.openingApBalance,
          asNullableStr(bp['tm01_BankCode']),
          asNullableStr(bp['tm01_ShitenCode']),
          asNullableStr(bp['tm01_BankType']),
          bpBankNo === null ? null : encryptField(bpBankNo, encKey),
          asNullableStr(bp['tm01_Bankaccount']),
          Boolean(bp['tm01_DeleteFlag']),
        ],
      );
      if (bpRes.rows[0] !== undefined) {
        partnerIdByCode.set(code, bpRes.rows[0].id);
      }
    }

    // 8. units lookup & products
    const unitRows = await client.query<{ id: string; unit_code: string }>(
      'SELECT id, unit_code FROM units WHERE tenant_id = $1',
      [tenantId],
    );
    const unitIdByCode = new Map(unitRows.rows.map((u) => [u.unit_code, u.id]));

    const productIdByCode = new Map<string, string>();
    for (const pr of getRows(params.dump, 'tm03_Shohin')) {
      const pCode = asStr(pr['tm03_ShohinCode']);
      const uId = unitIdByCode.get(asStr(pr['tm03_TaniCode']));
      const prRes = await client.query<{ id: string }>(
        `INSERT INTO products (
          tenant_id, product_code, product_name, product_name_sub, month_flag_code,
          capacity, unit_id, standard_unit_price, standard_purchase_price, standard_cost_price,
          default_tax_code, is_stock_managed, stock_quantity, is_subscription_target, is_heading, is_deleted
        ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16) RETURNING id`,
        [
          tenantId,
          pCode,
          asStr(pr['tm03_Shohinmei']),
          asNullableStr(pr['tm03_Shohinmei2']),
          asNullableStr(pr['tm03_TsukiFlg']),
          toFiniteNumber(pr['tm03_Capacity']),
          uId === undefined ? null : uId,
          toBigIntYen(pr['tm03_Tanka'], 'tm03').toString(),
          toBigIntYen(pr['tm03_ShiireTanka'], 'tm03').toString(),
          toBigIntYen(pr['tm03_CostTanka'], 'tm03').toString(),
          toTaxCode(pr['tm03_ZeiCode']),
          Boolean(pr['tm03_StockFlg']),
          toFiniteNumber(pr['tm03_Stock']),
          Boolean(pr['tm03_SubscFlg']),
          Boolean(pr['tm03_HeadingFlag']),
          Boolean(pr['tm03_DeleteFlag']),
        ],
      );
      if (prRes.rows[0] !== undefined) {
        productIdByCode.set(pCode, prRes.rows[0].id);
      }
    }

    // 9. WIP Projects (C1 / C2)
    let projectCount = 0;
    const projectIdByNo = new Map<string, string>();
    const projectDateByNo = new Map<string, string>();
    const wipConstructionNos = new Set<string>();

    for (const pj of getRows(params.dump, 'tm25_Construction')) {
      const st = asStr(pj['tm25_KanriCode']);
      if (st !== 'C1' && st !== 'C2') continue;
      const pNo = asStr(pj['tm25_No']);
      const partnerId = partnerIdByCode.get(asStr(pj['tm25_ClientCode']));
      if (partnerId === undefined) {
        throw new Error(`案件#${pNo} の取引先 ${asStr(pj['tm25_ClientCode'])} が見つかりません`);
      }
      const pDate = toDateOnly(pj['tm25_Date']);
      if (pDate === null) {
        throw new Error(`案件#${pNo} の project_date が NULL です`);
      }
      const pjRes = await client.query<{ id: string }>(
        `INSERT INTO projects (
          tenant_id, project_no, project_name, project_date, site_place, partner_id, partner_name_snap,
          status, period_start_date, period_end_date, actual_start_date, temp_finish_date, finish_date,
          unit_name, contract_unit_price, contract_quantity, contract_subtotal, contract_tax, contract_total,
          tax_code, rounding_mode, budget_expense, budget_labor, budget_material, budget_outsourcing, budget_temporary, budget_indirect,
          source_quotation_no, remarks
        ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25,$26,$27,$28,$29) RETURNING id`,
        [
          tenantId,
          pNo,
          asStr(pj['tm25_Name']),
          pDate,
          asNullableStr(pj['tm25_Place']),
          partnerId,
          asStr(pj['tm25_ClientName']),
          st,
          toDateOnly(pj['tm25_PeriodStartDate']),
          toDateOnly(pj['tm25_PeriodEndDate']),
          toDateOnly(pj['tm25_StartDate']),
          toDateOnly(pj['tm25_TempFinishDate']),
          toDateOnly(pj['tm25_FinishDate']),
          asStr(pj['tm25_Tani']),
          toBigIntYen(pj['tm25_Tanka'], 'tm25').toString(),
          toFiniteNumber(pj['tm25_qty']),
          toBigIntYen(pj['tm25_Kakaku'], 'tm25').toString(),
          toBigIntYen(pj['tm25_Syouhizei'], 'tm25').toString(),
          toBigIntYen(pj['tm25_RowTotal'], 'tm25').toString(),
          toTaxCode(pj['tm25_ZeiCode']),
          toRoundingMode(pj['tm25_ZeiKeisan']),
          toBigIntYen(pj['tm25_BudgetExpense'], 'tm25').toString(),
          toBigIntYen(pj['tm25_BudgetLabor'], 'tm25').toString(),
          toBigIntYen(pj['tm25_BudgetMaterial'], 'tm25').toString(),
          toBigIntYen(pj['tm25_BudgetOutsourcing'], 'tm25').toString(),
          toBigIntYen(pj['tm25_BudgetTemporary'], 'tm25').toString(),
          toBigIntYen(pj['tm25_BudgetIndirect'], 'tm25').toString(),
          toFiniteNumber(pj['tm25_QuotationNo']) > 0 ? Number(pj['tm25_QuotationNo']) : null,
          asNullableStr(pj['tm25_Bikou']),
        ],
      );
      if (pjRes.rows[0] !== undefined) {
        projectIdByNo.set(pNo, pjRes.rows[0].id);
        projectDateByNo.set(pNo, pDate);
        wipConstructionNos.add(pNo);
        projectCount += 1;
      }
    }

    // 10. WIP Project Costs (tm26..tm31 + *Cost -> project_cost_headers / project_cost_lines)
    const costGroups = collectMigratedCostGroups({
      dump: params.dump,
      wipConstructionNos,
      projectDateByNo,
      mapping: params.mapping,
    });
    let costHeaderCount = 0;
    let costLineCount = 0;

    for (const grp of costGroups) {
      const pjId = projectIdByNo.get(grp.constructionNo);
      if (pjId === undefined) continue;
      const chRes = await client.query<{ id: string }>(
        `INSERT INTO project_cost_headers (
          tenant_id, project_id, cost_category, slip_title, entry_date, status, rounding_mode,
          subtotal_amount, tax_total, total_amount, cost_subtotal, cost_tax_total, cost_total
        ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) RETURNING id`,
        [
          tenantId,
          pjId,
          grp.category,
          grp.slipTitle,
          grp.entryDate,
          grp.status,
          grp.roundingMode,
          grp.subtotalAmount.toString(),
          grp.taxTotal.toString(),
          grp.totalAmount.toString(),
          grp.costSubtotal.toString(),
          grp.costTaxTotal.toString(),
          grp.costTotal.toString(),
        ],
      );
      const chId = chRes.rows[0]?.id;
      if (chId === undefined) continue;
      costHeaderCount += 1;

      for (const ln of grp.lines) {
        const prodId = ln.itemCode === null ? undefined : productIdByCode.get(ln.itemCode);
        await client.query(
          `INSERT INTO project_cost_lines (
            tenant_id, cost_header_id, line_no, product_id, item_code, item_name, unit_name,
            quantity, tax_code, applied_unit_price, line_amount, line_tax, line_total,
            applied_cost_price, cost_amount, cost_tax, cost_total, remarks
          ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18)`,
          [
            tenantId,
            chId,
            ln.lineNo,
            prodId === undefined ? null : prodId,
            ln.itemCode,
            ln.itemName,
            ln.unitName,
            ln.quantity,
            ln.taxCode,
            ln.appliedUnitPrice.toString(),
            ln.lineAmount.toString(),
            ln.lineTax.toString(),
            ln.lineTotal.toString(),
            ln.appliedCostPrice.toString(),
            ln.costAmount.toString(),
            ln.costTax.toString(),
            ln.costTotal.toString(),
            ln.remarks,
          ],
        );
        costLineCount += 1;
      }
    }

    // 11. WIP Quotations (trx_Quotation: status='Q1', 件名NULLかつ金額0の空見積はスキップ)
    const skipEmptyQuotations =
      params.mapping !== undefined && params.mapping.skipEmptyQuotations !== undefined
        ? params.mapping.skipEmptyQuotations
        : true;
    const allQList = getRows(params.dump, 'trx_QuotationList');
    const allQCostList = getRows(params.dump, 'trx_QuotationCostList');
    let quotationCount = 0;
    let quotationLineCount = 0;

    for (const q of getRows(params.dump, 'trx_Quotation')) {
      if (asStr(q['trx_KanriFlg']) !== 'Q1') continue;
      const qNo = asStr(q['trx_QuotationNo']);
      const qName = asNullableStr(q['trx_QuotationName']);
      const qTotal = toBigIntYen(q['trx_Goukei'], `Quotation#${qNo}`);
      if (skipEmptyQuotations && qName === null && qTotal === 0n) continue;

      const partnerCode = asStr(q['trx_KokyakuCode']);
      const pId = partnerIdByCode.get(partnerCode);
      if (pId === undefined) {
        throw new Error(`見積#${qNo} の取引先 ${partnerCode} が見つかりません`);
      }
      const qDate = toDateOnly(q['trx_QuotationDay']);
      if (qDate === null) {
        throw new Error(`見積#${qNo} の quotation_date が NULL です`);
      }
      const cNo = asStr(q['trx_ConstructionNo']);
      const pjId = cNo === '' || cNo === '0' ? null : projectIdByNo.get(cNo);
      const honorificRaw = asNullableStr(q['trx_Ontyu']);

      const qRes = await client.query<{ id: string }>(
        `INSERT INTO quotations (
          tenant_id, quotation_no, quotation_name, quotation_date, partner_id, project_id,
          honorific, validity_period, delivery_date, status, is_advance_type, is_selected,
          rounding_mode, tax_calc_policy, subtotal_amount, tax_total, total_amount, remarks
        ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18) RETURNING id`,
        [
          tenantId,
          qNo,
          qName === null ? '' : qName,
          qDate,
          pId,
          pjId === undefined ? null : pjId,
          honorificRaw === null ? '御中' : honorificRaw,
          asNullableStr(q['trx_PeriodOfValidity']),
          asNullableStr(q['trx_DeliveryDate']),
          'Q1',
          Boolean(q['trx_APFlg']),
          Boolean(q['trx_SelectFlag']),
          toRoundingMode(q['trx_ZeiKeisan']),
          'SLIP_BY_RATE',
          toBigIntYen(q['trx_QuotationKingaku'], `Quotation#${qNo}`).toString(),
          toBigIntYen(q['trx_TaxGoukei'], `Quotation#${qNo}`).toString(),
          qTotal.toString(),
          asNullableStr(q['trx_QuotationBikou']),
        ],
      );
      const qId = qRes.rows[0]?.id;
      if (qId === undefined) continue;
      quotationCount += 1;

      const qLines = allQList
        .filter((l) => asStr(l['trx_QuotationNo']) === qNo)
        .sort((a, b) => Number(a['trx_MeisaiNo']) - Number(b['trx_MeisaiNo']));
      const qCostByMeisai = new Map<number, RawRow>();
      for (const cl of allQCostList) {
        if (asStr(cl['trx_QuotationNo']) === qNo) {
          qCostByMeisai.set(Number(cl['trx_MeisaiNo']), cl);
        }
      }

      for (let idx = 0; idx < qLines.length; idx += 1) {
        const l = qLines[idx];
        if (l === undefined) continue;
        const mNo = Number(l['trx_MeisaiNo']);
        const cl = qCostByMeisai.get(mNo);
        const taxCode = toTaxCode(l['trx_ZeiCode']);
        const kak = toBigIntYen(l['trx_Kakaku'], `QLine#${qNo}`);
        const syo = toBigIntYen(l['trx_Shouhizei'], `QLine#${qNo}`);
        const lineTot = taxCode === 'D' || taxCode === 'E' ? kak : kak + syo;

        let costCategory: CostCategory | null = null;
        let appliedCost = 0n;
        let costAmt = 0n;
        let costTax = 0n;
        let costTot = 0n;
        if (cl !== undefined) {
          costCategory = toCostCategory(cl['trx_CostName']);
          const cTaxCode = toTaxCode(cl['trx_ZeiCode']);
          appliedCost = toBigIntYen(cl['trx_Tanka'], `QCost#${qNo}`);
          costAmt = toBigIntYen(cl['trx_Kakaku'], `QCost#${qNo}`);
          costTax = toBigIntYen(cl['trx_Shouhizei'], `QCost#${qNo}`);
          costTot = cTaxCode === 'D' || cTaxCode === 'E' ? costAmt : costAmt + costTax;
        }

        const itemCode = asNullableStr(l['trx_ShohinCode']);
        const prodId = itemCode === null ? undefined : productIdByCode.get(itemCode);

        await client.query(
          `INSERT INTO quotation_lines (
            tenant_id, quotation_id, line_no, product_id, item_code, item_name, unit_name,
            quantity, tax_code, cost_category, applied_unit_price, line_amount, line_tax, line_total,
            applied_cost_price, cost_amount, cost_tax, cost_total, remarks
          ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19)`,
          [
            tenantId,
            qId,
            idx + 1,
            prodId === undefined ? null : prodId,
            itemCode,
            asStr(l['trx_Shohinmei']),
            asNullableStr(l['trx_Tani']),
            toFiniteNumber(l['trx_qty']),
            taxCode,
            costCategory,
            toBigIntYen(l['trx_Tanka'], `QLine#${qNo}`).toString(),
            kak.toString(),
            syo.toString(),
            lineTot.toString(),
            appliedCost.toString(),
            costAmt.toString(),
            costTax.toString(),
            costTot.toString(),
            asNullableStr(l['trx_Bikou']),
          ],
        );
        quotationLineCount += 1;
      }
    }

    // 12. WIP Purchase Orders (trx_Order: O1 / O2)
    const allOList = getRows(params.dump, 'trx_OrderList');
    const allOCostList = getRows(params.dump, 'trx_OrderCostList');
    let orderCount = 0;
    let orderLineCount = 0;
    const orderIdByNo = new Map<string, string>();

    for (const o of getRows(params.dump, 'trx_Order')) {
      const st = asStr(o['trx_KanriFlg']);
      if (st !== 'O1' && st !== 'O2') continue;
      const oNo = asStr(o['trx_OrderNo']);
      const supplierCode = asStr(o['trx_KokyakuCode']);
      const supplierId = partnerIdByCode.get(supplierCode);
      if (supplierId === undefined) {
        throw new Error(`発注#${oNo} の仕入先 ${supplierCode} が見つかりません`);
      }
      const oDate = toDateOnly(o['trx_OrderDay']);
      if (oDate === null) {
        throw new Error(`発注#${oNo} の order_date が NULL です`);
      }
      const honorificRaw = asNullableStr(o['trx_Ontyu']);

      const oRes = await client.query<{ id: string }>(
        `INSERT INTO purchase_orders (
          tenant_id, order_no, order_name, order_date, supplier_id,
          honorific, delivery_date, status, rounding_mode, subtotal_amount, tax_total, total_amount, remarks
        ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) RETURNING id`,
        [
          tenantId,
          oNo,
          asStr(o['trx_OrderName']),
          oDate,
          supplierId,
          honorificRaw === null ? '御中' : honorificRaw,
          asNullableStr(o['trx_DeliveryDate']),
          st,
          toRoundingMode(o['trx_ZeiKeisan']),
          toBigIntYen(o['trx_OrderKingaku'], `Order#${oNo}`).toString(),
          toBigIntYen(o['trx_TaxGoukei'], `Order#${oNo}`).toString(),
          toBigIntYen(o['trx_Goukei'], `Order#${oNo}`).toString(),
          asNullableStr(o['trx_OrderBikou']),
        ],
      );
      const oId = oRes.rows[0]?.id;
      if (oId === undefined) continue;
      orderIdByNo.set(oNo, oId);
      orderCount += 1;

      const oLines = allOList
        .filter((l) => asStr(l['trx_OrderNo']) === oNo)
        .sort((a, b) => Number(a['trx_MeisaiNo']) - Number(b['trx_MeisaiNo']));
      const oCostByMeisai = new Map<number, RawRow>();
      for (const cl of allOCostList) {
        if (asStr(cl['trx_OrderNo']) === oNo) {
          oCostByMeisai.set(Number(cl['trx_MeisaiNo']), cl);
        }
      }

      for (let idx = 0; idx < oLines.length; idx += 1) {
        const l = oLines[idx];
        if (l === undefined) continue;
        const cl = oCostByMeisai.get(Number(l['trx_MeisaiNo']));
        const taxCode = toTaxCode(l['trx_ZeiCode']);
        const kak = toBigIntYen(l['trx_Kakaku'], `OLine#${oNo}`);
        const syo = toBigIntYen(l['trx_Shouhizei'], `OLine#${oNo}`);
        const lineTot = taxCode === 'D' || taxCode === 'E' ? kak : kak + syo;

        let appliedCost = 0n;
        let costAmt = 0n;
        let costTax = 0n;
        let costTot = 0n;
        if (cl !== undefined) {
          const cTaxCode = toTaxCode(cl['trx_ZeiCode']);
          appliedCost = toBigIntYen(cl['trx_Tanka'], `OCost#${oNo}`);
          costAmt = toBigIntYen(cl['trx_Kakaku'], `OCost#${oNo}`);
          costTax = toBigIntYen(cl['trx_Shouhizei'], `OCost#${oNo}`);
          costTot = cTaxCode === 'D' || cTaxCode === 'E' ? costAmt : costAmt + costTax;
        }

        const itemCode = asNullableStr(l['trx_ShohinCode']);
        const prodId = itemCode === null ? undefined : productIdByCode.get(itemCode);

        await client.query(
          `INSERT INTO purchase_order_lines (
            tenant_id, order_id, line_no, product_id, item_code, item_name, unit_name,
            quantity, tax_code, applied_unit_price, line_amount, line_tax, line_total,
            applied_cost_price, cost_amount, cost_tax, cost_total, remarks
          ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18)`,
          [
            tenantId,
            oId,
            idx + 1,
            prodId === undefined ? null : prodId,
            itemCode,
            asStr(l['trx_Shohinmei']),
            asNullableStr(l['trx_Tani']),
            toFiniteNumber(l['trx_qty']),
            taxCode,
            toBigIntYen(l['trx_Tanka'], `OLine#${oNo}`).toString(),
            kak.toString(),
            syo.toString(),
            lineTot.toString(),
            appliedCost.toString(),
            costAmt.toString(),
            costTax.toString(),
            costTot.toString(),
            asNullableStr(l['trx_Bikou']),
          ],
        );
        orderLineCount += 1;
      }
    }

    // 13. WIP Purchases (trx_Purchase: P1 / P2)
    const allPList = getRows(params.dump, 'trx_PurchaseList');
    const allPCostList = getRows(params.dump, 'trx_PurchaseCostList');
    let purchaseCount = 0;
    let purchaseLineCount = 0;

    for (const p of getRows(params.dump, 'trx_Purchase')) {
      const st = asStr(p['trx_KanriFlg']);
      if (st !== 'P1' && st !== 'P2') continue;
      const pNo = asStr(p['trx_PurchaseNo']);
      const supplierCode = asStr(p['trx_KokyakuCode']);
      const supplierId = partnerIdByCode.get(supplierCode);
      if (supplierId === undefined) {
        throw new Error(`仕入#${pNo} の仕入先 ${supplierCode} が見つかりません`);
      }
      const pDate = toDateOnly(p['trx_PurchaseDay']);
      if (pDate === null) {
        throw new Error(`仕入#${pNo} の purchase_date が NULL です`);
      }
      const honorificRaw = asNullableStr(p['trx_Ontyu']);

      const pRes = await client.query<{ id: string }>(
        `INSERT INTO purchases (
          tenant_id, purchase_no, purchase_name, purchase_date, supplier_id,
          honorific, status, rounding_mode, subtotal_amount, tax_total, total_amount, remarks
        ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING id`,
        [
          tenantId,
          pNo,
          asStr(p['trx_PurchaseName']),
          pDate,
          supplierId,
          honorificRaw === null ? '御中' : honorificRaw,
          st,
          toRoundingMode(p['trx_ZeiKeisan']),
          toBigIntYen(p['trx_PurchaseKingaku'], `Purchase#${pNo}`).toString(),
          toBigIntYen(p['trx_TaxGoukei'], `Purchase#${pNo}`).toString(),
          toBigIntYen(p['trx_Goukei'], `Purchase#${pNo}`).toString(),
          asNullableStr(p['trx_PurchaseBikou']),
        ],
      );
      const purId = pRes.rows[0]?.id;
      if (purId === undefined) continue;
      purchaseCount += 1;

      const pLines = allPList
        .filter((l) => asStr(l['trx_PurchaseNo']) === pNo)
        .sort((a, b) => Number(a['trx_MeisaiNo']) - Number(b['trx_MeisaiNo']));
      const pCostByMeisai = new Map<number, RawRow>();
      for (const cl of allPCostList) {
        if (asStr(cl['trx_PurchaseNo']) === pNo) {
          pCostByMeisai.set(Number(cl['trx_MeisaiNo']), cl);
        }
      }

      for (let idx = 0; idx < pLines.length; idx += 1) {
        const l = pLines[idx];
        if (l === undefined) continue;
        const cl = pCostByMeisai.get(Number(l['trx_MeisaiNo']));
        const taxCode = toTaxCode(l['trx_ZeiCode']);
        const kak = toBigIntYen(l['trx_Kakaku'], `PLine#${pNo}`);
        const syo = toBigIntYen(l['trx_Shouhizei'], `PLine#${pNo}`);
        const lineTot = taxCode === 'D' || taxCode === 'E' ? kak : kak + syo;

        const cNo = asStr(l['trx_ConstructionNo']);
        const linePjId = cNo === '' || cNo === '0' ? null : projectIdByNo.get(cNo);

        let appliedCost = 0n;
        let costAmt = 0n;
        let costTax = 0n;
        let costTot = 0n;
        if (cl !== undefined) {
          const cTaxCode = toTaxCode(cl['trx_ZeiCode']);
          appliedCost = toBigIntYen(cl['trx_Tanka'], `PCost#${pNo}`);
          costAmt = toBigIntYen(cl['trx_Kakaku'], `PCost#${pNo}`);
          costTax = toBigIntYen(cl['trx_Shouhizei'], `PCost#${pNo}`);
          costTot = cTaxCode === 'D' || cTaxCode === 'E' ? costAmt : costAmt + costTax;
        }

        const itemCode = asNullableStr(l['trx_ShohinCode']);
        const prodId = itemCode === null ? undefined : productIdByCode.get(itemCode);

        await client.query(
          `INSERT INTO purchase_lines (
            tenant_id, purchase_id, line_no, project_id, product_id, item_code, item_name, unit_name,
            quantity, tax_code, applied_unit_price, line_amount, line_tax, line_total,
            applied_cost_price, cost_amount, cost_tax, cost_total, remarks
          ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19)`,
          [
            tenantId,
            purId,
            idx + 1,
            linePjId === undefined ? null : linePjId,
            prodId === undefined ? null : prodId,
            itemCode,
            asStr(l['trx_Shohinmei']),
            asNullableStr(l['trx_Tani']),
            toFiniteNumber(l['trx_qty']),
            taxCode,
            toBigIntYen(l['trx_Tanka'], `PLine#${pNo}`).toString(),
            kak.toString(),
            syo.toString(),
            lineTot.toString(),
            appliedCost.toString(),
            costAmt.toString(),
            costTax.toString(),
            costTot.toString(),
            asNullableStr(l['trx_Bikou']),
          ],
        );
        purchaseLineCount += 1;
      }
    }

    // 14. WIP Sales & Advances (K1 / K2 / K3)
    let salesHeaderCount = 0;
    let salesLineCount = 0;
    const insertWipSales = async (
      rows: RawRow[],
      entryType: 'SALE' | 'ADVANCE',
      noCol: string,
      nameCol: string,
      dateCol: string,
      kubunCol: string,
      prefix: string,
    ) => {
      const grouped = new Map<string, RawRow[]>();
      for (const r of rows) {
        const st = asStr(r[`${prefix}_KanriCode`]);
        if (st !== 'K1' && st !== 'K2' && st !== 'K3') continue;
        const no = asStr(r[noCol]);
        const list = grouped.get(no);
        if (list === undefined) grouped.set(no, [r]);
        else list.push(r);
      }

      for (const [slipNo, group] of grouped.entries()) {
        const h = group[0];
        if (h === undefined) continue;
        const pId = partnerIdByCode.get(asStr(h[`${prefix}_KokyakuCode`]));
        if (pId === undefined) continue;
        const cNo = asStr(h[`${prefix}_ConstructionNo`]);
        const pjId = cNo === '' || cNo === '0' ? null : projectIdByNo.get(cNo);
        const honorificRaw = asNullableStr(h[`${prefix}_Ontyu`]);
        const approvalRaw = h[`${prefix}_Approval`];
        const approvalStatus =
          approvalRaw === null || approvalRaw === undefined || approvalRaw === ''
            ? 0
            : Number(approvalRaw);

        const hRes = await client.query<{ id: string }>(
          `INSERT INTO sales_headers (
            tenant_id, entry_type, slip_no, slip_name, slip_date, partner_id, project_id,
            honorific, status, approval_status, approval_remarks, sales_kubun,
            rounding_mode, subtotal_amount, tax_total, total_amount
          ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16) RETURNING id`,
          [
            tenantId,
            entryType,
            slipNo,
            asStr(h[nameCol]),
            toDateOnly(h[dateCol]),
            pId,
            pjId === undefined ? null : pjId,
            honorificRaw === null ? '御中' : honorificRaw,
            asStr(h[`${prefix}_KanriCode`]),
            approvalStatus === 1 || approvalStatus === 2 ? approvalStatus : 0,
            asNullableStr(h[`${prefix}_Approval_remarks`]),
            asNullableStr(h[kubunCol]),
            toRoundingMode(h[`${prefix}_ZeiKeisan`]),
            toBigIntYen(h[`${prefix}_SubTotal`], slipNo).toString(),
            toBigIntYen(h[`${prefix}_TaxTotal`], slipNo).toString(),
            toBigIntYen(h[`${prefix}_Total`], slipNo).toString(),
          ],
        );
        const shId = hRes.rows[0]?.id;
        if (shId === undefined) continue;
        salesHeaderCount += 1;

        for (let i = 0; i < group.length; i += 1) {
          const line = group[i];
          if (line === undefined) continue;
          const taxCode = toTaxCode(line[`${prefix}_ZeiCode`]);
          const kak = toBigIntYen(line[`${prefix}_Kakaku`], slipNo);
          const zei = toBigIntYen(line[`${prefix}_Syouhizei`], slipNo);
          const rowTot = taxCode === 'D' || taxCode === 'E' ? kak : kak + zei;
          const prodId = productIdByCode.get(asStr(line[`${prefix}_ShohinCode`]));
          await client.query(
            `INSERT INTO sales_lines (
              tenant_id, sales_header_id, line_no, product_id, item_code, item_name, unit_name,
              target_month_label, quantity, applied_unit_price, tax_code, line_amount, line_tax, row_total, remarks
            ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)`,
            [
              tenantId,
              shId,
              i + 1,
              prodId === undefined ? null : prodId,
              asNullableStr(line[`${prefix}_ShohinCode`]),
              asStr(line[`${prefix}_Shohinmei`]),
              asNullableStr(line[`${prefix}_Tani`]),
              asNullableStr(line[`${prefix}_Tsuki`]),
              toFiniteNumber(line[`${prefix}_qty`]),
              toBigIntYen(line[`${prefix}_Tanka`], slipNo).toString(),
              taxCode,
              kak.toString(),
              zei.toString(),
              rowTot.toString(),
              asNullableStr(line[`${prefix}_Bikou`]),
            ],
          );
          salesLineCount += 1;
        }
      }
    };

    await insertWipSales(
      getRows(params.dump, 'tm05_Uriage'),
      'SALE',
      'tm05_UriageNo',
      'tm05_UriageName',
      'tm05_UriD',
      'tm05_UriKubun',
      'tm05',
    );
    await insertWipSales(
      getRows(params.dump, 'tm21_AdvancesPaid'),
      'ADVANCE',
      'tm21_APNo',
      'tm21_APName',
      'tm21_APD',
      'tm21_APKubun',
      'tm21',
    );

    await client.query('COMMIT');
    return {
      tenantId,
      insertedCounts: {
        banks: bankIdByCode.size,
        bankBranches: bankBranchCount,
        taxOffices: taxOfficeCount,
        mailTemplates: mailTemplateCount,
        inputIntelligences: inputIntelligenceCount,
        employees: empIdByCode.size,
        representatives: repIdByCode.size,
        partners: partnerIdByCode.size,
        products: productIdByCode.size,
        projects: projectCount,
        projectCostHeaders: costHeaderCount,
        projectCostLines: costLineCount,
        quotations: quotationCount,
        quotationLines: quotationLineCount,
        purchaseOrders: orderCount,
        purchaseOrderLines: orderLineCount,
        purchases: purchaseCount,
        purchaseLines: purchaseLineCount,
        salesHeaders: salesHeaderCount,
        salesLines: salesLineCount,
      },
    };
  } catch (err) {
    try {
      await client.query('ROLLBACK');
    } catch (rbErr) {
      throw new AggregateError([err, rbErr], 'ETL トランザクションのロールバックに失敗しました');
    }
    throw err;
  } finally {
    client.release();
    await pool.end();
  }
}

export interface VerifyReport {
  tenantSlug: string;
  verifiedAt: string;
  verified: boolean;
  v1Masters: Record<string, { expected: number; actual: number; match: boolean }> & {
    encryptedBankAccountsChecked: number;
  };
  v2WipSlips: {
    quotations: { count: number; expectedTotalYen: string; actualTotalYen: string; diffYen: string };
    purchaseOrders: { count: number; expectedTotalYen: string; actualTotalYen: string; diffYen: string };
    purchases: { count: number; expectedTotalYen: string; actualTotalYen: string; diffYen: string };
    salesAndAdvances: { count: number; expectedTotalYen: string; actualTotalYen: string; diffYen: string };
  };
  v3WipProjectsAndCosts: {
    projectsCount: number;
    expectedContractTotalYen: string;
    actualContractTotalYen: string;
    contractDiffYen: string;
    expectedBudgetTotalYen: string;
    actualBudgetTotalYen: string;
    budgetDiffYen: string;
    costHeadersCount: number;
    expectedCostTotalYen: string;
    actualCostTotalYen: string;
    costDiffYen: string;
  };
  v4OpeningBalances: {
    checkedPartners: number;
    expectedArSumYen: string;
    actualArSumYen: string;
    arDiffYen: string;
    expectedApSumYen: string;
    actualApSumYen: string;
    apDiffYen: string;
  };
}

/**
 * Phase 3: Verify (DATABASE_URL :6543 + vendas_app RLS 下での V1〜V4 1円単位自動突合アサーション)
 */
async function verifyMigration(params: {
  dump: AccdbDump;
  diag: DiagnosticReport;
  tenantSlug: string;
  mapping?: EtlMappingConfig;
}): Promise<VerifyReport> {
  const databaseUrl = requireEnv('DATABASE_URL');
  const encKey = requireEnv('FIELD_ENCRYPTION_KEY_HEX');
  const pool = new Pool(createPgPoolConfig(databaseUrl));
  const client = await pool.connect();

  try {
    // 認証前のテナントID特定のみ SECURITY DEFINER ではなくテナントslug lookup あるいは管理者で確認後 RLS 実行
    const adminPool = new Pool(createPgPoolConfig(requireEnv('DIRECT_DATABASE_URL')));
    let tenantId: string | undefined;
    try {
      const tRes = await adminPool.query<{ id: string }>(
        'SELECT id FROM tenants WHERE tenant_slug = $1',
        [params.tenantSlug],
      );
      tenantId = tRes.rows[0]?.id;
    } finally {
      await adminPool.end();
    }

    if (tenantId === undefined) {
      throw new Error(`verify 失敗: テナント '${params.tenantSlug}' が DB に存在しません`);
    }

    await client.query('BEGIN');
    await client.query('SET LOCAL ROLE vendas_app');
    await client.query("SELECT set_config('app.current_tenant_id', $1, true)", [tenantId]);

    // V1: マスタ件数 + 暗号化口座番号の復号往復一致
    const masterCntRes = await client.query<{ tbl: string; cnt: string }>(
      `SELECT 'employees' AS tbl, COUNT(*)::text AS cnt FROM employees
       UNION ALL SELECT 'representatives', COUNT(*)::text FROM representatives
       UNION ALL SELECT 'business_partners', COUNT(*)::text FROM business_partners
       UNION ALL SELECT 'products', COUNT(*)::text FROM products
       UNION ALL SELECT 'banks', COUNT(*)::text FROM banks
       UNION ALL SELECT 'bank_branches', COUNT(*)::text FROM bank_branches
       UNION ALL SELECT 'tax_offices', COUNT(*)::text FROM tax_offices
       UNION ALL SELECT 'mail_templates', COUNT(*)::text FROM mail_templates
       UNION ALL SELECT 'input_intelligences', COUNT(*)::text FROM input_intelligences
       UNION ALL SELECT 'tenant_feature_authorities', COUNT(*)::text FROM tenant_feature_authorities
       UNION ALL SELECT 'units', COUNT(*)::text FROM units
       UNION ALL SELECT 'tax_codes', COUNT(*)::text FROM tax_codes
       UNION ALL SELECT 'payment_methods', COUNT(*)::text FROM payment_methods
       UNION ALL SELECT 'code_masters', COUNT(*)::text FROM code_masters`,
    );
    const actualMasterCounts = new Map(masterCntRes.rows.map((r) => [r.tbl, Number(r.cnt)]));
    const countTable = (tbl: string): number => {
      const cnt = actualMasterCounts.get(tbl);
      if (cnt === undefined) {
        throw new Error(`V1 集計対象外のテーブルです: ${tbl}`);
      }
      return cnt;
    };

    const skipEmptyQuotations =
      params.mapping !== undefined && params.mapping.skipEmptyQuotations !== undefined
        ? params.mapping.skipEmptyQuotations
        : true;

    const expectedMasters: Record<string, number> = {
      employees: getRows(params.dump, 'tm09_Syain').length,
      representatives: getRows(params.dump, 'tm02_Daihyou').length,
      business_partners: params.diag.d6OpeningBalances.length,
      products: getRows(params.dump, 'tm03_Shohin').length,
      banks: getRows(params.dump, 'tm06_Bank').length,
      bank_branches: getRows(params.dump, 'tm07_Shiten').length,
      tax_offices: getRows(params.dump, 'tm08_Zeimusyo').length,
      mail_templates: getRows(params.dump, 'tm20_MailRepetitive').length,
      input_intelligences: getRows(params.dump, 'T_Intelligence').filter((r) => asStr(r['item_name']) !== '').length,
      tenant_feature_authorities: 29,
      units: 25,
      tax_codes: 5,
      payment_methods: 9,
      code_masters: 105,
    };

    const v1MastersRaw: Record<string, { expected: number; actual: number; match: boolean }> = {};
    for (const [tbl, expCnt] of Object.entries(expectedMasters)) {
      const actCnt = countTable(tbl);
      if (actCnt !== expCnt) {
        throw new Error(`V1 マスタ件数不一致 (${tbl}): expected=${expCnt}, actual=${actCnt}`);
      }
      v1MastersRaw[tbl] = { expected: expCnt, actual: actCnt, match: true };
    }

    // 口座暗号化復号一致検査 (tenant_settings + business_partners)
    let encryptedBankAccountsChecked = 0;
    const zisya = getRows(params.dump, 'tm10_Zisya')[0];
    if (zisya === undefined) {
      throw new Error('V1検証失敗: tm10_Zisya が存在しません');
    }
    const tsRows = await client.query<{
      bank_account_no_1_enc: string | null;
      bank_account_no_2_enc: string | null;
    }>('SELECT bank_account_no_1_enc, bank_account_no_2_enc FROM tenant_settings');
    const ts = tsRows.rows[0];
    if (ts === undefined) {
      throw new Error('V1検証失敗: tenant_settings が見つかりません');
    }
    const expectedZ1 = asNullableStr(zisya['tm10_BankNo']);
    if (expectedZ1 !== null) {
      if (ts.bank_account_no_1_enc === null || decryptField(ts.bank_account_no_1_enc, encKey) !== expectedZ1) {
        throw new Error('V1 自社口座1の暗号化復号が一致しません');
      }
      encryptedBankAccountsChecked += 1;
    }
    const expectedZ2 = asNullableStr(zisya['tm10_BankNo2']);
    if (expectedZ2 !== null) {
      if (ts.bank_account_no_2_enc === null || decryptField(ts.bank_account_no_2_enc, encKey) !== expectedZ2) {
        throw new Error('V1 自社口座2の暗号化復号が一致しません');
      }
      encryptedBankAccountsChecked += 1;
    }

    // V2: 仕掛伝票 1円突合
    // (a) 見積 (Q1)
    const expQRows = getRows(params.dump, 'trx_Quotation').filter((q) => {
      if (asStr(q['trx_KanriFlg']) !== 'Q1') return false;
      if (
        skipEmptyQuotations &&
        asNullableStr(q['trx_QuotationName']) === null &&
        toBigIntYen(q['trx_Goukei'], 'Q') === 0n
      ) {
        return false;
      }
      return true;
    });
    const dbQRows = await client.query<{ quotation_no: string; total_amount: string }>(
      'SELECT quotation_no::text, total_amount::text FROM quotations',
    );
    const dbQMap = new Map(dbQRows.rows.map((r) => [r.quotation_no, BigInt(r.total_amount)]));
    let expQSum = 0n;
    let actQSum = 0n;
    for (const q of expQRows) {
      const no = asStr(q['trx_QuotationNo']);
      const expTot = toBigIntYen(q['trx_Goukei'], `V2_Q#${no}`);
      const actTot = dbQMap.get(no);
      if (actTot === undefined || actTot !== expTot) {
        throw new Error(`V2 見積#${no} 金額不一致: expected=${expTot}, actual=${String(actTot)}`);
      }
      expQSum += expTot;
      actQSum += actTot;
    }

    // (b) 発注 (O1/O2)
    const expORows = getRows(params.dump, 'trx_Order').filter((o) => {
      const flg = asStr(o['trx_KanriFlg']);
      return flg === 'O1' || flg === 'O2';
    });
    const dbORows = await client.query<{ order_no: string; total_amount: string }>(
      'SELECT order_no::text, total_amount::text FROM purchase_orders',
    );
    const dbOMap = new Map(dbORows.rows.map((r) => [r.order_no, BigInt(r.total_amount)]));
    let expOSum = 0n;
    let actOSum = 0n;
    for (const o of expORows) {
      const no = asStr(o['trx_OrderNo']);
      const expTot = toBigIntYen(o['trx_Goukei'], `V2_O#${no}`);
      const actTot = dbOMap.get(no);
      if (actTot === undefined || actTot !== expTot) {
        throw new Error(`V2 発注#${no} 金額不一致: expected=${expTot}, actual=${String(actTot)}`);
      }
      expOSum += expTot;
      actOSum += actTot;
    }

    // (c) 仕入 (P1/P2)
    const expPRows = getRows(params.dump, 'trx_Purchase').filter((p) => {
      const flg = asStr(p['trx_KanriFlg']);
      return flg === 'P1' || flg === 'P2';
    });
    const dbPRows = await client.query<{ purchase_no: string; total_amount: string }>(
      'SELECT purchase_no::text, total_amount::text FROM purchases',
    );
    const dbPMap = new Map(dbPRows.rows.map((r) => [r.purchase_no, BigInt(r.total_amount)]));
    let expPSum = 0n;
    let actPSum = 0n;
    for (const p of expPRows) {
      const no = asStr(p['trx_PurchaseNo']);
      const expTot = toBigIntYen(p['trx_Goukei'], `V2_P#${no}`);
      const actTot = dbPMap.get(no);
      if (actTot === undefined || actTot !== expTot) {
        throw new Error(`V2 仕入#${no} 金額不一致: expected=${expTot}, actual=${String(actTot)}`);
      }
      expPSum += expTot;
      actPSum += actTot;
    }

    // (d) 売上・立替金 (K1/K2/K3)
    const expectedSalesMap = new Map<string, bigint>();
    const addExpSales = (rows: RawRow[], entryType: 'SALE' | 'ADVANCE', noCol: string, prefix: string) => {
      for (const r of rows) {
        const st = asStr(r[`${prefix}_KanriCode`]);
        if (st !== 'K1' && st !== 'K2' && st !== 'K3') continue;
        const key = `${entryType}:${asStr(r[noCol])}`;
        expectedSalesMap.set(key, toBigIntYen(r[`${prefix}_Total`], key));
      }
    };
    addExpSales(getRows(params.dump, 'tm05_Uriage'), 'SALE', 'tm05_UriageNo', 'tm05');
    addExpSales(getRows(params.dump, 'tm21_AdvancesPaid'), 'ADVANCE', 'tm21_APNo', 'tm21');

    const dbSRows = await client.query<{ entry_type: string; slip_no: string; total_amount: string }>(
      'SELECT entry_type::text, slip_no::text, total_amount::text FROM sales_headers',
    );
    const dbSMap = new Map(dbSRows.rows.map((r) => [`${r.entry_type}:${r.slip_no}`, BigInt(r.total_amount)]));
    let expSalesSum = 0n;
    let actSalesSum = 0n;
    for (const [key, expTot] of expectedSalesMap.entries()) {
      const actTot = dbSMap.get(key);
      if (actTot === undefined || actTot !== expTot) {
        throw new Error(`V2 売上/立替 ${key} 金額不一致: expected=${expTot}, actual=${String(actTot)}`);
      }
      expSalesSum += expTot;
      actSalesSum += actTot;
    }

    // V3: 仕掛案件予算 & 実績原価突合
    const expWipProjects = getRows(params.dump, 'tm25_Construction').filter((pj) => {
      const st = asStr(pj['tm25_KanriCode']);
      return st === 'C1' || st === 'C2';
    });
    const dbPjRows = await client.query<{
      project_no: string;
      contract_total: string;
      budget_expense: string;
      budget_labor: string;
      budget_material: string;
      budget_outsourcing: string;
      budget_temporary: string;
      budget_indirect: string;
    }>(
      `SELECT project_no::text, contract_total::text,
              budget_expense::text, budget_labor::text, budget_material::text,
              budget_outsourcing::text, budget_temporary::text, budget_indirect::text
         FROM projects`,
    );
    const dbPjMap = new Map(dbPjRows.rows.map((r) => [r.project_no, r]));
    const wipConstNos = new Set<string>();
    const pjDateByNo = new Map<string, string>();
    let expContractSum = 0n;
    let actContractSum = 0n;
    let expBudgetSum = 0n;
    let actBudgetSum = 0n;

    for (const pj of expWipProjects) {
      const no = asStr(pj['tm25_No']);
      wipConstNos.add(no);
      const dt = toDateOnly(pj['tm25_Date']);
      if (dt !== null) pjDateByNo.set(no, dt);

      const act = dbPjMap.get(no);
      if (act === undefined) {
        throw new Error(`V3 案件#${no} が DB に見つかりません`);
      }
      const expCt = toBigIntYen(pj['tm25_RowTotal'], `V3_C#${no}`);
      const actCt = BigInt(act.contract_total);
      const expBd =
        toBigIntYen(pj['tm25_BudgetExpense'], 'bd') +
        toBigIntYen(pj['tm25_BudgetLabor'], 'bd') +
        toBigIntYen(pj['tm25_BudgetMaterial'], 'bd') +
        toBigIntYen(pj['tm25_BudgetOutsourcing'], 'bd') +
        toBigIntYen(pj['tm25_BudgetTemporary'], 'bd') +
        toBigIntYen(pj['tm25_BudgetIndirect'], 'bd');
      const actBd =
        BigInt(act.budget_expense) +
        BigInt(act.budget_labor) +
        BigInt(act.budget_material) +
        BigInt(act.budget_outsourcing) +
        BigInt(act.budget_temporary) +
        BigInt(act.budget_indirect);

      if (expCt !== actCt || expBd !== actBd) {
        throw new Error(
          `V3 案件#${no} 不一致: contract(${expCt} vs ${actCt}), budget(${expBd} vs ${actBd})`,
        );
      }
      expContractSum += expCt;
      actContractSum += actCt;
      expBudgetSum += expBd;
      actBudgetSum += actBd;
    }

    const expectedCostGroups = collectMigratedCostGroups({
      dump: params.dump,
      wipConstructionNos: wipConstNos,
      projectDateByNo: pjDateByNo,
      mapping: params.mapping,
    });
    const dbCostRows = await client.query<{
      project_no: string;
      cost_category: string;
      total_amount: string;
    }>(
      `SELECT p.project_no::text, h.cost_category::text, h.total_amount::text
         FROM project_cost_headers h
         JOIN projects p ON p.tenant_id = h.tenant_id AND p.id = h.project_id`,
    );
    const dbCostMap = new Map(dbCostRows.rows.map((r) => [`${r.cost_category}:${r.project_no}`, BigInt(r.total_amount)]));
    let expCostSum = 0n;
    let actCostSum = 0n;
    for (const grp of expectedCostGroups) {
      const key = `${grp.category}:${grp.constructionNo}`;
      const actTot = dbCostMap.get(key);
      if (actTot === undefined || actTot !== grp.totalAmount) {
        throw new Error(`V3 原価 ${key} 金額不一致: expected=${grp.totalAmount}, actual=${String(actTot)}`);
      }
      expCostSum += grp.totalAmount;
      actCostSum += actTot;
    }

    // V4: 期首売掛・買掛残高（全パートナー 0円誤差）+ 顧客口座復号検証
    const bpRes = await client.query<{
      partner_code: string;
      opening_ar_balance: string;
      opening_ap_balance: string;
      bank_account_no_enc: string | null;
    }>(
      'SELECT partner_code, opening_ar_balance::text, opening_ap_balance::text, bank_account_no_enc FROM business_partners',
    );
    const dbBalMap = new Map(bpRes.rows.map((r) => [r.partner_code, r]));
    const rawBpByOldId = new Map(
      getRows(params.dump, 'tm01_Kokyakubunrui').map((r) => [Number(r['ID']), r]),
    );

    let expArSum = 0n;
    let actArSum = 0n;
    let expApSum = 0n;
    let actApSum = 0n;

    for (const expected of params.diag.d6OpeningBalances) {
      const actual = dbBalMap.get(expected.resolvedPartnerCode);
      if (actual === undefined) {
        throw new Error(
          `V4 突合エラー: 取引先 ${expected.resolvedPartnerCode} (元ID:${expected.oldId}) が移行後DBに見つかりません`,
        );
      }
      if (actual.opening_ar_balance !== expected.openingArBalance) {
        throw new Error(
          `V4 期首AR不一致 (${expected.resolvedPartnerCode}): expected=${expected.openingArBalance}, actual=${actual.opening_ar_balance}`,
        );
      }
      if (actual.opening_ap_balance !== expected.openingApBalance) {
        throw new Error(
          `V4 期首AP不一致 (${expected.resolvedPartnerCode}): expected=${expected.openingApBalance}, actual=${actual.opening_ap_balance}`,
        );
      }
      expArSum += BigInt(expected.openingArBalance);
      actArSum += BigInt(actual.opening_ar_balance);
      expApSum += BigInt(expected.openingApBalance);
      actApSum += BigInt(actual.opening_ap_balance);

      const srcRow = rawBpByOldId.get(expected.oldId);
      const srcBankNo = srcRow === undefined ? null : asNullableStr(srcRow['tm01_BankNo']);
      if (srcBankNo !== null) {
        if (actual.bank_account_no_enc === null || decryptField(actual.bank_account_no_enc, encKey) !== srcBankNo) {
          throw new Error(`V1 取引先 ${expected.resolvedPartnerCode} の銀行口座復号が一致しません`);
        }
        encryptedBankAccountsChecked += 1;
      }
    }

    await client.query('COMMIT');

    return {
      tenantSlug: params.tenantSlug,
      verifiedAt: new Date().toISOString(),
      verified: true,
      v1Masters: Object.assign(v1MastersRaw, { encryptedBankAccountsChecked }) as VerifyReport['v1Masters'],
      v2WipSlips: {
        quotations: {
          count: expQRows.length,
          expectedTotalYen: expQSum.toString(),
          actualTotalYen: actQSum.toString(),
          diffYen: (actQSum - expQSum).toString(),
        },
        purchaseOrders: {
          count: expORows.length,
          expectedTotalYen: expOSum.toString(),
          actualTotalYen: actOSum.toString(),
          diffYen: (actOSum - expOSum).toString(),
        },
        purchases: {
          count: expPRows.length,
          expectedTotalYen: expPSum.toString(),
          actualTotalYen: actPSum.toString(),
          diffYen: (actPSum - expPSum).toString(),
        },
        salesAndAdvances: {
          count: expectedSalesMap.size,
          expectedTotalYen: expSalesSum.toString(),
          actualTotalYen: actSalesSum.toString(),
          diffYen: (actSalesSum - expSalesSum).toString(),
        },
      },
      v3WipProjectsAndCosts: {
        projectsCount: expWipProjects.length,
        expectedContractTotalYen: expContractSum.toString(),
        actualContractTotalYen: actContractSum.toString(),
        contractDiffYen: (actContractSum - expContractSum).toString(),
        expectedBudgetTotalYen: expBudgetSum.toString(),
        actualBudgetTotalYen: actBudgetSum.toString(),
        budgetDiffYen: (actBudgetSum - expBudgetSum).toString(),
        costHeadersCount: expectedCostGroups.length,
        expectedCostTotalYen: expCostSum.toString(),
        actualCostTotalYen: actCostSum.toString(),
        costDiffYen: (actCostSum - expCostSum).toString(),
      },
      v4OpeningBalances: {
        checkedPartners: params.diag.d6OpeningBalances.length,
        expectedArSumYen: expArSum.toString(),
        actualArSumYen: actArSum.toString(),
        arDiffYen: (actArSum - expArSum).toString(),
        expectedApSumYen: expApSum.toString(),
        actualApSumYen: actApSum.toString(),
        apDiffYen: (actApSum - expApSum).toString(),
      },
    };
  } catch (err) {
    try {
      await client.query('ROLLBACK');
    } catch (rbErr) {
      throw new AggregateError([err, rbErr], 'Verify トランザクションのロールバックに失敗しました');
    }
    throw err;
  } finally {
    client.release();
    await pool.end();
  }
}

/**
 * Phase 4: Purge-Tenant (検証リハーサルテナントの完全削除と全40テーブル 0件確認)
 */
async function purgeTenant(tenantSlug: string): Promise<{
  tenantSlug: string;
  deletedTenantId: string | null;
  deletedRowCounts: Record<string, number>;
  remainingGlobalRowsAcross40Tables: Record<string, number>;
  totalRemainingRows: number;
}> {
  const directUrl = requireEnv('DIRECT_DATABASE_URL');
  const pool = new Pool(createPgPoolConfig(directUrl));
  const client = await pool.connect();

  let deletedTenantId: string | null = null;
  let deletedRowCounts: Record<string, number> = {};

  try {
    await client.query('BEGIN');

    const tRes = await client.query<{ id: string }>(
      'SELECT id FROM tenants WHERE tenant_slug = $1',
      [tenantSlug],
    );
    const tenantId = tRes.rows[0]?.id;

    if (tenantId !== undefined) {
      deletedTenantId = tenantId;
      const purgeRes = await client.query<{ deleted_counts: Record<string, number> }>(
        'SELECT purge_tenant_cascade($1) AS deleted_counts',
        [tenantId],
      );
      if (purgeRes.rows[0] !== undefined) {
        deletedRowCounts = purgeRes.rows[0].deleted_counts;
      }
    }

    await client.query('COMMIT');
  } catch (err) {
    try {
      await client.query('ROLLBACK');
    } catch (rbErr) {
      throw new AggregateError([err, rbErr], 'purge-tenant 中のロールバックに失敗しました');
    }
    throw err;
  } finally {
    client.release();
  }

  const remainingGlobalRowsAcross40Tables: Record<string, number> = {};
  let totalRemainingRows = 0;

  try {
    const cntRes = await pool.query<{ tablename: string; row_count: string }>(
      'SELECT tablename, row_count::text FROM count_public_business_rows() ORDER BY tablename',
    );
    for (const row of cntRes.rows) {
      const cnt = Number(row.row_count);
      remainingGlobalRowsAcross40Tables[row.tablename] = cnt;
      totalRemainingRows += cnt;
    }
  } finally {
    await pool.end();
  }

  return {
    tenantSlug,
    deletedTenantId,
    deletedRowCounts,
    remainingGlobalRowsAcross40Tables,
    totalRemainingRows,
  };
}

function parseCliArgs(argv: readonly string[]): {
  accdb: string | null;
  tenant: string;
  name: string;
  cutoff: string | null;
  mode: EtlMode;
  mappingPath: string | null;
  outDir: string;
  dumpJson: string | null;
} {
  const args = new Map<string, string>();
  for (let i = 0; i < argv.length; i += 1) {
    const key = argv[i];
    if (key !== undefined && key.startsWith('--')) {
      const val = argv[i + 1];
      if (val === undefined || val.startsWith('--')) {
        throw new Error(`CLI引数 '${key}' に値が指定されていません`);
      }
      args.set(key.slice(2), val);
      i += 1;
    }
  }

  const accdb = args.get('accdb');
  const tenant = args.get('tenant');
  const cutoff = args.get('cutoff');
  const modeStr = args.get('mode');
  const dumpJson = args.get('dump-json');

  if (tenant === undefined || modeStr === undefined) {
    throw new Error(
      '必須引数: --tenant <slug> --mode <dry-run|execute|verify|purge-tenant> (purge-tenant以外は --cutoff と --accdb または --dump-json が必須)',
    );
  }
  if (modeStr !== 'dry-run' && modeStr !== 'execute' && modeStr !== 'verify' && modeStr !== 'purge-tenant') {
    throw new Error(`不正な --mode '${modeStr}'`);
  }
  if (modeStr !== 'purge-tenant' && (cutoff === undefined || (accdb === undefined && dumpJson === undefined))) {
    throw new Error(
      `--mode ${modeStr} には --cutoff <YYYY-MM-DD> と (--accdb または --dump-json) が必須です`,
    );
  }

  const name = args.get('name');
  const mappingPath = args.get('mapping');
  const outDir = args.get('out-dir');

  return {
    accdb: accdb === undefined ? null : accdb,
    tenant,
    name: name === undefined ? tenant : name,
    cutoff: cutoff === undefined ? null : cutoff,
    mode: modeStr,
    mappingPath: mappingPath === undefined ? null : mappingPath,
    outDir: outDir === undefined ? path.resolve(process.cwd(), 'etl_output') : outDir,
    dumpJson: dumpJson === undefined ? null : dumpJson,
  };
}

async function main(): Promise<void> {
  const opts = parseCliArgs(process.argv.slice(2));
  fs.mkdirSync(opts.outDir, { recursive: true });

  if (opts.mode === 'purge-tenant') {
    const purgeRes = await purgeTenant(opts.tenant);
    const purgePath = path.join(opts.outDir, `etl_purge_${opts.tenant}.json`);
    fs.writeFileSync(purgePath, JSON.stringify(purgeRes, null, 2), 'utf8');
    console.log(`[ETL:purge-tenant] Purge Report => ${purgePath}`);
    console.log({
      tenantSlug: purgeRes.tenantSlug,
      deletedTenantId: purgeRes.deletedTenantId,
      tableCountChecked: Object.keys(purgeRes.remainingGlobalRowsAcross40Tables).length,
      totalRemainingRows: purgeRes.totalRemainingRows,
      deletedRowCounts: purgeRes.deletedRowCounts,
    });
    if (purgeRes.totalRemainingRows !== 0) {
      throw new Error(`purge-tenant 後も ${purgeRes.totalRemainingRows} 行が残存しています`);
    }
    return;
  }

  if (opts.cutoff === null) {
    throw new Error('--cutoff が指定されていません');
  }

  const dumpPath =
    opts.dumpJson !== null
      ? opts.dumpJson
      : path.join(opts.outDir, `${opts.tenant}_accdb_dump.json`);

  let dump: AccdbDump;
  if (opts.dumpJson !== null) {
    dump = JSON.parse(fs.readFileSync(opts.dumpJson, 'utf8')) as AccdbDump;
  } else if (opts.accdb !== null) {
    dump = extractAccdbWith32BitPowerShell(opts.accdb, dumpPath);
  } else {
    throw new Error('--accdb または --dump-json が必要です');
  }

  const mapping =
    opts.mappingPath !== null
      ? (JSON.parse(fs.readFileSync(opts.mappingPath, 'utf8')) as EtlMappingConfig)
      : undefined;

  const diag = runDryRunDiagnostics({
    dump,
    tenantSlug: opts.tenant,
    tenantName: opts.name,
    cutoffDate: opts.cutoff,
    mapping,
  });

  const diagPath = path.join(opts.outDir, `etl_diagnostic_${opts.tenant}.json`);
  fs.writeFileSync(diagPath, JSON.stringify(diag, null, 2), 'utf8');

  console.log(`[ETL:${opts.mode}] Diagnostic Report => ${diagPath}`);
  console.log(
    `  Blockers=${diag.blockers.length}, Warnings=${diag.warnings.length}, Duplicates=${diag.d1Duplicates.length}, Orphans=${diag.d2Orphans.length}, MissingP3=${diag.d3MissingPayables.length}, CorruptedCost=${diag.d4MathAndCostIssues.corruptedCostRows.length}, SlipsChecked=${diag.d4MathAndCostIssues.slipChecks.length}, Partners=${diag.d6OpeningBalances.length}`,
  );

  if (opts.mode === 'dry-run') {
    return;
  }
  if (opts.mode === 'execute') {
    const execRes = await executeMigration({
      dump,
      diag,
      tenantSlug: opts.tenant,
      tenantName: opts.name,
      cutoffDate: opts.cutoff,
      mapping,
    });
    console.log('[ETL:execute] Committed:', execRes);
    return;
  }
  if (opts.mode === 'verify') {
    const verRes = await verifyMigration({
      dump,
      diag,
      tenantSlug: opts.tenant,
      mapping,
    });
    const verifyPath = path.join(opts.outDir, `etl_verify_${opts.tenant}.json`);
    fs.writeFileSync(verifyPath, JSON.stringify(verRes, null, 2), 'utf8');
    console.log(`[ETL:verify] Verify Report => ${verifyPath}`);
    console.log('[ETL:verify] Passed:', verRes);
  }
}

const invokedAsScript =
  process.argv[1] !== undefined && path.resolve(process.argv[1]).endsWith('migrate-tenant.ts');

if (invokedAsScript) {
  main().catch((err) => {
    console.error('[ETL ERROR]', err);
    process.exit(1);
  });
}
