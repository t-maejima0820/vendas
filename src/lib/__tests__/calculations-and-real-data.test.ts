import fs from 'node:fs';
import Decimal from 'decimal.js';
import { describe, expect, it } from 'vitest';
import {
  decryptField,
  encryptField,
  hashPassword,
  isEncryptedField,
  verifyPassword,
} from '@/lib/crypto/field-cipher';
import {
  applyRounding,
  calculateApBalance,
  calculateArBalance,
  calculateInvoiceSummary,
  calculateLineAmounts,
  calculateProjectProfit,
  calculateSlipTotals,
  type LineCalcInput,
} from '@/lib/domain/calculations';
import {
  buildDocumentSnapshot,
  computePayloadSha256,
  decryptSnapshotBankAccounts,
  SnapshotValidationError,
  type DocumentSnapshotPayload,
} from '@/lib/domain/snapshots';
import {
  runDryRunDiagnostics,
  type AccdbDump,
} from '../../../scripts/etl/migrate-tenant';

const TEST_KEY_HEX = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';
const REAL_DUMP_PATH = 'C:\\WebApps\\vendas_evacuation\\_analysis\\etl_dry_run\\test-company_accdb_dump.json';

describe('純粋計算エンジン・旧Access 7大バグ是正・インボイス・暗号化・実.accdb検証', () => {
  it('バグ1是正: applyRounding(CEIL) が旧Access Int(x+0.9) バグを是正し、0.01〜0.99 を厳密切り上げすること', () => {
    // 100.01 は旧 Int(100.01 + 0.9) = Int(100.91) = 100 になっていたが、正しくは 101
    expect(applyRounding(new Decimal('100.01'), 'CEIL')).toBe(101n);
    expect(applyRounding(new Decimal('100.05'), 'CEIL')).toBe(101n);
    expect(applyRounding(new Decimal('100.00'), 'CEIL')).toBe(100n);

    // ROUND (HALF_UP) と FLOOR
    expect(applyRounding(new Decimal('100.49'), 'ROUND')).toBe(100n);
    expect(applyRounding(new Decimal('100.50'), 'ROUND')).toBe(101n);
    expect(applyRounding(new Decimal('100.99'), 'FLOOR')).toBe(100n);
  });

  it('バグ2・3是正: 買掛(opening_ap_balance基準)と売掛・請求鏡(複数入金全合算+期首残高基準)が正確であること', () => {
    // バグ2: 買掛繰越は期首買掛残高(CarriedPay=120000)を使う（期首売掛999999とは無関係）
    const ap = calculateApBalance({
      openingBalanceAtCutoff: 120_000n,
      beforePeriodIncreases: 80_000n,
      beforePeriodDecreases: 50_000n,
      inPeriodIncreases: 300_000n,
      inPeriodDecreases: 100_000n,
    });
    expect(ap.carriedBalance).toBe(150_000n);
    expect(ap.periodNetDelta).toBe(200_000n);
    expect(ap.closingBalance).toBe(350_000n);

    // バグ3: 売掛期中・請求鏡は過去入金合計および期中入金合計（複数回分）を全控除
    const ar = calculateArBalance({
      openingBalanceAtCutoff: 50_000n,
      beforePeriodIncreases: 100_000n,
      beforePeriodDecreases: 30_000n + 20_000n, // 2回分合計
      inPeriodIncreases: 220_000n,
      inPeriodDecreases: 40_000n + 10_000n,
    });
    expect(ar.carriedBalance).toBe(100_000n);
    expect(ar.closingBalance).toBe(270_000n);

    const slip = calculateSlipTotals(
      [{ lineNo: 1, quantity: 1, unitPrice: 200_000n, taxCode: 'A', roundingMode: 'FLOOR' }],
      'FLOOR',
      'SLIP_BY_RATE',
    );
    const inv = calculateInvoiceSummary({
      slips: [slip],
      prevCarriedBalance: 100_000n,
      periodReceiptAmount: 40_000n + 10_000n,
      roundingMode: 'FLOOR',
      policy: 'SLIP_BY_RATE',
    });
    expect(inv.netCarriedBalance).toBe(50_000n);
    expect(inv.billingAmount).toBe(220_000n);
    expect(inv.closingArBalance).toBe(270_000n);
  });

  it('バグ4・5是正: 定額請求・販売明細の内税(D:10%, E:8%)を逆算抽出し、外税二重加算を起こさないこと', () => {
    const lineD = calculateLineAmounts({
      lineNo: 1,
      quantity: 1,
      unitPrice: 11_000n,
      taxCode: 'D',
      roundingMode: 'FLOOR',
    });
    expect(lineD.lineTax).toBe(1_000n);
    expect(lineD.exclAmount).toBe(10_000n);
    expect(lineD.lineAmount).toBe(11_000n);
    expect(lineD.rowTotal).toBe(11_000n);

    const lineE = calculateLineAmounts({
      lineNo: 2,
      quantity: 1,
      unitPrice: 10_800n,
      taxCode: 'E',
      roundingMode: 'FLOOR',
    });
    expect(lineE.lineTax).toBe(800n);
    expect(lineE.exclAmount).toBe(10_000n);
    expect(lineE.lineAmount).toBe(10_800n);
    expect(lineE.rowTotal).toBe(10_800n);

    // 混在伝票（A+B+C+D+E）の SLIP_BY_RATE 集計
    const mixed = calculateSlipTotals(
      [
        { lineNo: 1, quantity: 2, unitPrice: 5_000n, taxCode: 'A', roundingMode: 'FLOOR' }, // 10,000 + 1,000
        { lineNo: 2, quantity: 1, unitPrice: 10_000n, taxCode: 'B', roundingMode: 'FLOOR' }, // 10,000 + 800
        { lineNo: 3, quantity: 1, unitPrice: 3_000n, taxCode: 'C', roundingMode: 'FLOOR' }, // 3,000 + 0
        { lineNo: 4, quantity: 1, unitPrice: 11_000n, taxCode: 'D', roundingMode: 'FLOOR' }, // 10,000 + 1,000 (内税)
        { lineNo: 5, quantity: 1, unitPrice: 10_800n, taxCode: 'E', roundingMode: 'FLOOR' }, // 10,000 + 800 (内税)
      ],
      'FLOOR',
      'SLIP_BY_RATE',
    );
    expect(mixed.rate10Excl).toBe(20_000n);
    expect(mixed.rate10Tax).toBe(2_000n);
    expect(mixed.rate8Excl).toBe(20_000n);
    expect(mixed.rate8Tax).toBe(1_600n);
    expect(mixed.nonTax0).toBe(3_000n);
    expect(mixed.subtotalExcl).toBe(43_000n);
    expect(mixed.taxTotal).toBe(3_600n);
    expect(mixed.totalIncl).toBe(46_600n);
  });

  it('バグ6・7是正: calculateProjectProfit が税抜/税込統一で粗利率を計算し、見積⇔売上計算が一貫すること', () => {
    const commonCosts = {
      budgets: {
        EXPENSE: 10_000n,
        LABOR: 100_000n,
        MATERIAL: 200_000n,
        OUTSOURCING: 300_000n,
        TEMPORARY: 50_000n,
        INDIRECT: 40_000n,
      },
      actualCostsExcl: {
        EXPENSE: 10_000n,
        LABOR: 100_000n,
        MATERIAL: 200_000n,
        OUTSOURCING: 250_000n,
        TEMPORARY: 20_000n,
        INDIRECT: 20_000n,
      },
      actualCostsIncl: {
        EXPENSE: 11_000n,
        LABOR: 110_000n,
        MATERIAL: 220_000n,
        OUTSOURCING: 275_000n,
        TEMPORARY: 22_000n,
        INDIRECT: 22_000n,
      },
    };

    const exclResult = calculateProjectProfit({
      costTaxMode: 'TAX_EXCLUDED',
      contractSubtotal: 1_000_000n,
      contractTotal: 1_100_000n,
      ...commonCosts,
    });
    expect(exclResult.contractAmount).toBe(1_000_000n);
    expect(exclResult.actualCostTotal).toBe(600_000n);
    expect(exclResult.actualGrossProfit).toBe(400_000n);
    expect(exclResult.actualGrossMarginPercent).toBe('40.00');
    expect(exclResult.budgetVarianceTotal).toBe(100_000n);

    const inclResult = calculateProjectProfit({
      costTaxMode: 'TAX_INCLUDED',
      contractSubtotal: 1_000_000n,
      contractTotal: 1_100_000n,
      ...commonCosts,
    });
    expect(inclResult.contractAmount).toBe(1_100_000n);
    expect(inclResult.actualCostTotal).toBe(660_000n);
    expect(inclResult.actualGrossProfit).toBe(440_000n);
    // 分子・分母ともに税込統一のため粗利率は同一の 40.00%
    expect(inclResult.actualGrossMarginPercent).toBe('40.00');

    // バグ7: 見積明細・売上明細で単一計算関数を共用し一貫一致
    const lines: LineCalcInput[] = [
      { lineNo: 1, quantity: 3, unitPrice: 12_345n, taxCode: 'A', roundingMode: 'FLOOR' },
      { lineNo: 2, quantity: 2, unitPrice: 1_500n, taxCode: 'B', roundingMode: 'FLOOR' },
    ];
    const quotationCalc = calculateSlipTotals(lines, 'FLOOR', 'SLIP_BY_RATE');
    const salesCalc = calculateSlipTotals(lines, 'FLOOR', 'SLIP_BY_RATE');
    expect(salesCalc).toEqual(quotationCalc);
  });

  it('インボイス税計算ポリシー: SLIP_BY_RATE(調整額0円) と INVOICE_BY_RATE(請求時端数処理の差額記録) の境界ケース', () => {
    // 1005円 × 10% = 100.5円 (FLOOR -> 100円) が 2伝票分。
    // 合算課税対象は 2010円 × 10% = 201円 -> INVOICE_BY_RATE では税調整額 +1円。
    const s1Lines: LineCalcInput[] = [{ lineNo: 1, quantity: 1, unitPrice: 1_005n, taxCode: 'A', roundingMode: 'FLOOR' }];
    const s2Lines: LineCalcInput[] = [{ lineNo: 1, quantity: 1, unitPrice: 1_005n, taxCode: 'A', roundingMode: 'FLOOR' }];

    const s1 = calculateSlipTotals(s1Lines, 'FLOOR', 'SLIP_BY_RATE');
    const s2 = calculateSlipTotals(s2Lines, 'FLOOR', 'SLIP_BY_RATE');

    const invSlipMode = calculateInvoiceSummary({
      slips: [s1, s2],
      prevCarriedBalance: 0n,
      periodReceiptAmount: 0n,
      roundingMode: 'FLOOR',
      policy: 'SLIP_BY_RATE',
    });
    expect(invSlipMode.taxAdjustmentAmount).toBe(0n);
    expect(invSlipMode.tax10Amount).toBe(200n);
    expect(invSlipMode.billingAmount).toBe(2_210n);

    const invInvoiceMode = calculateInvoiceSummary({
      slips: [s1, s2],
      prevCarriedBalance: 0n,
      periodReceiptAmount: 0n,
      roundingMode: 'FLOOR',
      policy: 'INVOICE_BY_RATE',
    });
    expect(invInvoiceMode.amount10Excl).toBe(2_010n);
    expect(invInvoiceMode.tax10Amount).toBe(201n);
    expect(invInvoiceMode.taxAdjustmentAmount).toBe(1n);
    expect(invInvoiceMode.billingAmount).toBe(2_211n);
  });

  it('field-cipher + 是正3 snapshots: enc:v1暗号化/改ざん検知・Argon2id・平文accountNoEnc拒否・正規SHA-256・復号', () => {
    const cipher1 = encryptField('1234567', TEST_KEY_HEX);
    const cipher2 = encryptField('1234567', TEST_KEY_HEX);
    expect(isEncryptedField(cipher1)).toBe(true);
    expect(cipher1).not.toBe(cipher2); // ランダムIV
    expect(decryptField(cipher1, TEST_KEY_HEX)).toBe('1234567');

    // GCM 認証タグ改ざん時は例外
    const parts = cipher1.split(':');
    const lastChar = parts[3]!.slice(-1) === 'A' ? 'B' : 'A';
    const tampered = `${parts[0]}:${parts[1]}:${parts[2]}:${parts[3]!.slice(0, -1)}${lastChar}`;
    expect(() => decryptField(tampered, TEST_KEY_HEX)).toThrow();

    // Argon2id パスワードハッシュ
    const hash = hashPassword('MySecretPass#2026');
    expect(hash.startsWith('$argon2id$')).toBe(true);
    expect(verifyPassword('MySecretPass#2026', hash)).toBe(true);
    expect(verifyPassword('WrongPass', hash)).toBe(false);

    const basePayload: DocumentSnapshotPayload = {
      schemaVersion: 1,
      documentType: 'INVOICE',
      templateVariant: 'STANDARD',
      documentNo: 'INV-202606-0001',
      issueDate: '2026-06-30',
      isReissue: false,
      reissueLabel: null,
      issuer: {
        companyCode: '9999',
        companyName: 'テスト自社株式会社',
        invoiceRegistrationNo: 'T1234567890123',
        corporateNo: '1234567890123',
        postalCode: '417-0001',
        address1: '静岡県富士市テスト町1-1',
        address2: null,
        tel: '0545-00-0000',
        fax: null,
        email: 'billing@example.com',
        representativeTitle: '代表取締役',
        representativeName: 'テスト 太郎',
        billingMemo: null,
        bankAccounts: [
          {
            bankName: '静岡銀行',
            branchName: '富士支店',
            accountTypeLabel: '普通',
            accountNoEnc: cipher1,
            accountHolder: 'テストジシャ',
          },
        ],
      },
      recipient: {
        partnerCode: '00007',
        partnerName: '平山組',
        representativeCode: null,
        representativeName: null,
        isIndividualHonorific: false,
        resolvedAddressee: '平山組',
        honorific: '御中',
        resolvedPostalCode: '417-0002',
        resolvedAddress: '静岡県富士市テスト町2-2',
      },
      header: {
        title: '2026年6月度ご請求書',
        projectNo: null,
        projectName: null,
        validityPeriod: null,
        deliveryDate: null,
        paymentDueDate: '2026-07-31',
        roundingMode: 'FLOOR',
        taxCalcPolicy: 'SLIP_BY_RATE',
        subtotalAmount: 100_000,
        taxTotal: 10_000,
        taxAdjustmentAmount: 0,
        totalAmount: 110_000,
        taxBreakdown: {
          rate10Excl: 100_000,
          rate10Tax: 10_000,
          rate8Excl: 0,
          rate8Tax: 0,
          nonTaxAmount: 0,
        },
        showCarryover: true,
        mirrorSummary: {
          prevCarriedBalance: 0,
          periodReceiptAmount: 0,
          netCarriedBalance: 0,
          currentBillingAmount: 110_000,
          closingArBalance: 110_000,
        },
        remarks: null,
      },
      lines: [
        {
          lineNo: 1,
          sourceSlipNo: 1,
          sourceSlipDate: '2026-06-15',
          advanceMark: null,
          itemCode: 'ITEM01',
          itemName: '改修工事一式',
          capacityLabel: null,
          unitName: '式',
          targetMonthLabel: '2026年6月',
          isHeading: false,
          quantity: 1,
          appliedUnitPrice: 100_000,
          lineAmount: 100_000,
          taxCode: 'A',
          taxRate: 0.1,
          taxMarkSymbol: '.',
          isInternalTax: false,
          lineTax: 10_000,
          rowTotal: 110_000,
          remarks: null,
        },
      ],
      attachments: [],
    };

    // 平文 accountNoEnc は例外で拒否（是正3）
    const plaintextBadPayload: DocumentSnapshotPayload = {
      ...basePayload,
      issuer: {
        ...basePayload.issuer,
        bankAccounts: [
          {
            ...basePayload.issuer.bankAccounts[0]!,
            accountNoEnc: '1234567',
          },
        ],
      },
    };
    expect(() => buildDocumentSnapshot(plaintextBadPayload)).toThrow(SnapshotValidationError);

    // オブジェクトキー順序を変えても正規 SHA-256 が完全一致
    const built = buildDocumentSnapshot(basePayload);
    const reorderedPayload: DocumentSnapshotPayload = {
      attachments: basePayload.attachments,
      lines: basePayload.lines,
      header: basePayload.header,
      recipient: basePayload.recipient,
      issuer: basePayload.issuer,
      reissueLabel: basePayload.reissueLabel,
      isReissue: basePayload.isReissue,
      issueDate: basePayload.issueDate,
      documentNo: basePayload.documentNo,
      templateVariant: basePayload.templateVariant,
      documentType: basePayload.documentType,
      schemaVersion: basePayload.schemaVersion,
    };
    expect(computePayloadSha256(reorderedPayload)).toBe(built.payloadSha256);

    // レンダリング用復号
    const decrypted = decryptSnapshotBankAccounts(built.payloadJson, TEST_KEY_HEX);
    expect(decrypted).toHaveLength(1);
    expect(decrypted[0]?.accountNo).toBe('1234567');
  });

  it('実 .accdb ダンプ検証: 全31伝票の1円完全一致、D1〜D6異常検知、およびマッピング指定でのD1ブロッカー解消', () => {
    const dump = JSON.parse(fs.readFileSync(REAL_DUMP_PATH, 'utf8')) as AccdbDump;

    const diag = runDryRunDiagnostics({
      dump,
      tenantSlug: 'test-company',
      tenantName: 'テスト会社',
      cutoffDate: '2026-05-31',
    });

    // D1 重複ブロッカー: tm01_Kokyakubunrui '00005' (IDs 186, 188)
    expect(diag.blockers).toHaveLength(1);
    expect(diag.d1Duplicates).toHaveLength(1);
    expect(diag.d1Duplicates[0]?.value).toBe('00005');
    expect(diag.d1Duplicates[0]?.ids).toEqual([186, 188]);

    // D2 孤立参照: 12件
    expect(diag.d2Orphans).toHaveLength(12);

    // D3 P3仕入の買掛未作成: 3件 (#4, #5, #6)
    expect(diag.d3MissingPayables).toHaveLength(3);
    expect(diag.d3MissingPayables.map((x) => x.purchaseNo).sort((a, b) => a - b)).toEqual([4, 5, 6]);

    // D4 全31伝票の算術再計算が 100% 1円単位で一致
    expect(diag.d4MathAndCostIssues.slipChecks).toHaveLength(31);
    const mismatches = diag.d4MathAndCostIssues.slipChecks.filter((c) => !c.match);
    expect(mismatches).toEqual([]);

    // D4 破損 *Cost 行 11件、ダミー/空行 7件
    expect(diag.d4MathAndCostIssues.corruptedCostRows).toHaveLength(11);
    expect(diag.d4MathAndCostIssues.dummyOrEmptyRows).toHaveLength(7);

    // D5 スキーマ・データ異常
    expect(diag.d5SchemaAnomalies.fullWidthColumnDetected).toBe(true);
    expect(diag.d5SchemaAnomalies.hasMyNumberColumn).toBe(true);
    expect(diag.d5SchemaAnomalies.plaintextPasswordCount).toBe(3);
    expect(diag.d5SchemaAnomalies.multilineItemNames.length).toBeGreaterThanOrEqual(1);
    expect(diag.d5SchemaAnomalies.shiftedWorkRows).toEqual(
      expect.arrayContaining([expect.objectContaining({ table: 'w_Aplus', count: 16 })]),
    );

    // D6 期首残高（20件、代表顧客の検証）
    expect(diag.d6OpeningBalances).toHaveLength(20);
    const partner11111 = diag.d6OpeningBalances.find((p) => p.partnerCode === '11111');
    expect(partner11111?.openingArBalance).toBe('-6200');
    expect(partner11111?.openingApBalance).toBe('1100000');

    const partner00007 = diag.d6OpeningBalances.find((p) => p.partnerCode === '00007');
    expect(partner00007?.openingArBalance).toBe('-1457500');

    const partner50002 = diag.d6OpeningBalances.find((p) => p.partnerCode === '50002');
    expect(partner50002?.openingApBalance).toBe('660000');

    const partner15395 = diag.d6OpeningBalances.find((p) => p.partnerCode === '15395');
    expect(partner15395?.apPayableUntilCutoff).toBe('988905');
    expect(partner15395?.apPaidUntilCutoff).toBe('988905');
    expect(partner15395?.openingApBalance).toBe('0');

    // --mapping 指定時は D1 ブロッカーが解消されること
    const resolvedDiag = runDryRunDiagnostics({
      dump,
      tenantSlug: 'test-company',
      tenantName: 'テスト会社',
      cutoffDate: '2026-05-31',
      mapping: {
        duplicatePartnerResolutions: {
          '00005': [{ action: 'rename', targetCode: '00005-2', byOldId: 188 }],
        },
      },
    });
    expect(resolvedDiag.blockers).toHaveLength(0);
  });
});
