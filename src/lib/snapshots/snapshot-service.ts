import Decimal from 'decimal.js';
import type { DbExecutor } from '@/lib/db/tenant-client';
import {
  calculateLineAmounts,
  calculateQuotationSlip,
  calculateSalesSlip,
  calculateSlipTotals,
  TAX_CODE_DEFINITIONS,
  type CostTaxMode,
  type LineCalcInput,
  type RoundingMode,
  type TaxCalcPolicy,
  type TaxCode,
} from '@/lib/domain/calculations';
import {
  buildDocumentSnapshot,
  type DocumentSnapshotPayload,
  type DocumentType,
  type SnapshotBankAccount,
} from '@/lib/domain/snapshots';
import type {
  QuotationTemplateVariant,
  SnapshotDetailDto,
  SnapshotHistoryItemDto,
} from '@/lib/estimates/types';
import { isFeatureEnabled, requireFeature } from '@/lib/feature-flags/gate';
import { MasterDataError } from '@/lib/masters/error-mapper';

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DATE_REGEX = /^\d{4}-\d{2}-\d{2}$/;

function validateUuid(id: string, label: string): void {
  if (!UUID_REGEX.test(id)) {
    throw new MasterDataError(400, 'INVALID_ID', `${label}IDの形式が不正です。`);
  }
}

function validateIssueDate(raw: string | undefined): string {
  if (raw === undefined || raw.trim() === '') {
    return new Date().toISOString().slice(0, 10);
  }
  const trimmed = raw.trim();
  if (!DATE_REGEX.test(trimmed)) {
    throw new MasterDataError(400, 'INVALID_DATE', '発行日は YYYY-MM-DD 形式で指定してください。');
  }
  return trimmed;
}

interface SnapshotHistoryRow extends Record<string, unknown> {
  id: string;
  document_type: DocumentType;
  source_entity_type: SnapshotHistoryItemDto['sourceEntityType'];
  source_entity_id: string;
  document_no: string;
  version_no: number;
  is_reissue: boolean;
  reissue_label: string | null;
  template_variant: string;
  issued_at: string;
  issued_by: string | null;
  issued_by_name: string | null;
  payload_sha256: string;
}

interface SnapshotDetailRow extends SnapshotHistoryRow {
  payload_json: unknown;
}

function mapSnapshotHistoryRow(row: SnapshotHistoryRow): SnapshotHistoryItemDto {
  return {
    id: row.id,
    documentType: row.document_type,
    sourceEntityType: row.source_entity_type,
    sourceEntityId: row.source_entity_id,
    documentNo: row.document_no,
    versionNo: Number(row.version_no),
    isReissue: row.is_reissue,
    reissueLabel: row.reissue_label,
    templateVariant: row.template_variant,
    issuedAt: row.issued_at,
    issuedBy: row.issued_by,
    issuedByName: row.issued_by_name,
    payloadSha256: row.payload_sha256,
  };
}

function normalizeTaxMarkSymbol(
  raw: string | undefined,
  fallback: '.' | '※' | '非' | '内',
): '.' | '※' | '非' | '内' {
  if (raw === '.' || raw === '※' || raw === '非' || raw === '内') {
    return raw;
  }
  return fallback;
}

function parseSnapshotPayload(raw: unknown): DocumentSnapshotPayload {
  if (typeof raw === 'string') {
    return JSON.parse(raw) as DocumentSnapshotPayload;
  }
  return raw as DocumentSnapshotPayload;
}

interface LoadedMasterSnapshotContext {
  issuer: DocumentSnapshotPayload['issuer'];
  recipient: DocumentSnapshotPayload['recipient'];
  projectNo: number | null;
  projectName: string | null;
  productMap: Map<string, { capacity: string; is_heading: boolean }>;
  taxCodeMap: Map<
    TaxCode,
    { tax_code: TaxCode; tax_rate: string; mark_symbol: string; is_internal: boolean }
  >;
  defaultTemplateVariant: QuotationTemplateVariant;
  tenantTaxCalcPolicy: TaxCalcPolicy;
  costTaxMode: CostTaxMode;
  showInvoiceCarryover: boolean;
}

async function loadSnapshotCommonContext(
  tx: DbExecutor,
  params: {
    tenantId: string;
    partnerId: string;
    projectId: string | null;
    honorific: string;
    productIds: readonly string[];
  },
): Promise<LoadedMasterSnapshotContext> {
  const settingsRows = await tx.query<{
    company_code: string;
    company_name: string;
    invoice_registration_no: string | null;
    corporate_no: string | null;
    postal_code: string | null;
    address1: string | null;
    address2: string | null;
    tel: string | null;
    fax: string | null;
    email: string | null;
    representative_title: string | null;
    representative_name: string | null;
    billing_memo: string | null;
    bank_code_1: string | null;
    branch_code_1: string | null;
    bank_account_type_1: string | null;
    bank_account_no_1_enc: string | null;
    bank_account_holder_1: string | null;
    bank_code_2: string | null;
    branch_code_2: string | null;
    bank_account_type_2: string | null;
    bank_account_no_2_enc: string | null;
    bank_account_holder_2: string | null;
    quotation_template_rows: number;
    tax_calc_policy: TaxCalcPolicy;
    cost_tax_mode: CostTaxMode;
    show_invoice_carryover: boolean;
  }>(
    `SELECT company_code, company_name, invoice_registration_no, corporate_no,
            postal_code, address1, address2, tel, fax, email,
            representative_title, representative_name, billing_memo,
            bank_code_1, branch_code_1, bank_account_type_1, bank_account_no_1_enc, bank_account_holder_1,
            bank_code_2, branch_code_2, bank_account_type_2, bank_account_no_2_enc, bank_account_holder_2,
            quotation_template_rows, tax_calc_policy::text AS tax_calc_policy,
            cost_tax_mode::text AS cost_tax_mode, show_invoice_carryover
       FROM tenant_settings
      WHERE tenant_id = $1::uuid
      LIMIT 1`,
    [params.tenantId],
  );
  const settings = settingsRows[0];
  if (settings === undefined) {
    throw new MasterDataError(404, 'TENANT_SETTINGS_NOT_FOUND', '自社設定が見つかりません。');
  }

  const bankRows = await tx.query<{ bank_code: string; bank_name: string }>(
    'SELECT bank_code, bank_name FROM banks',
    [],
  );
  const bankNameMap = new Map(bankRows.map((b) => [b.bank_code, b.bank_name]));

  const branchRows = await tx.query<{ bank_code: string; branch_code: string; branch_name: string }>(
    'SELECT bank_code, branch_code, branch_name FROM bank_branches',
    [],
  );
  const branchNameMap = new Map(
    branchRows.map((br) => [`${br.bank_code}:${br.branch_code}`, br.branch_name]),
  );

  const otherCodeRows = await tx.query<{ code: string; name: string }>(
    `SELECT code, name FROM code_masters WHERE domain_key = 'OTHER'`,
    [],
  );
  const accountTypeLabelMap = new Map(otherCodeRows.map((c) => [c.code, c.name]));

  const partnerRows = await tx.query<{
    id: string;
    partner_code: string;
    partner_name: string;
    representative_id: string | null;
    is_individual_honorific: boolean;
    postal_code: string | null;
    address1: string | null;
    address2: string | null;
  }>(
    `SELECT id, partner_code, partner_name, representative_id,
            is_individual_honorific, postal_code, address1, address2
       FROM business_partners
      WHERE id = $1::uuid
      LIMIT 1`,
    [params.partnerId],
  );
  const partner = partnerRows[0];
  if (partner === undefined) {
    throw new MasterDataError(404, 'PARTNER_NOT_FOUND', '取引先マスタが見つかりません。');
  }

  let representativeCode: number | null = null;
  let representativeName: string | null = null;
  if (partner.representative_id !== null) {
    const repRows = await tx.query<{ representative_code: number; representative_name: string }>(
      `SELECT representative_code, representative_name
         FROM representatives
        WHERE id = $1::uuid
        LIMIT 1`,
      [partner.representative_id],
    );
    if (repRows[0] !== undefined) {
      representativeCode = Number(repRows[0].representative_code);
      representativeName = repRows[0].representative_name;
    }
  }

  let projectNo: number | null = null;
  let projectName: string | null = null;
  if (params.projectId !== null) {
    const pjRows = await tx.query<{ project_no: string; project_name: string }>(
      `SELECT project_no::text AS project_no, project_name
         FROM projects
        WHERE id = $1::uuid
        LIMIT 1`,
      [params.projectId],
    );
    if (pjRows[0] !== undefined) {
      projectNo = Number(pjRows[0].project_no);
      projectName = pjRows[0].project_name;
    }
  }

  const productMap = new Map<string, { capacity: string; is_heading: boolean }>();
  if (params.productIds.length > 0) {
    const prodRows = await tx.query<{ id: string; capacity: string; is_heading: boolean }>(
      `SELECT id, capacity::text AS capacity, is_heading
         FROM products
        WHERE id = ANY($1::uuid[])`,
      [params.productIds],
    );
    for (const pr of prodRows) {
      productMap.set(pr.id, { capacity: pr.capacity, is_heading: pr.is_heading });
    }
  }

  const taxCodeRows = await tx.query<{
    tax_code: TaxCode;
    tax_rate: string;
    mark_symbol: string;
    is_internal: boolean;
  }>('SELECT tax_code, tax_rate::text AS tax_rate, mark_symbol, is_internal FROM tax_codes', []);
  const taxCodeMap = new Map(taxCodeRows.map((tc) => [tc.tax_code, tc]));

  const bankAccounts: SnapshotBankAccount[] = [];
  const rawBankSlots = [
    {
      bankCode: settings.bank_code_1,
      branchCode: settings.branch_code_1,
      accountType: settings.bank_account_type_1,
      accountNoEnc: settings.bank_account_no_1_enc,
      accountHolder: settings.bank_account_holder_1,
    },
    {
      bankCode: settings.bank_code_2,
      branchCode: settings.branch_code_2,
      accountType: settings.bank_account_type_2,
      accountNoEnc: settings.bank_account_no_2_enc,
      accountHolder: settings.bank_account_holder_2,
    },
  ];
  for (const slot of rawBankSlots) {
    if (
      slot.bankCode === null &&
      slot.branchCode === null &&
      slot.accountNoEnc === null &&
      slot.accountHolder === null
    ) {
      continue;
    }
    const resolvedBankName =
      slot.bankCode !== null ? (bankNameMap.get(slot.bankCode) ?? slot.bankCode) : null;
    const resolvedBranchName =
      slot.bankCode !== null && slot.branchCode !== null
        ? (branchNameMap.get(`${slot.bankCode}:${slot.branchCode}`) ?? slot.branchCode)
        : null;
    const resolvedAccountType =
      slot.accountType !== null
        ? (accountTypeLabelMap.get(slot.accountType) ??
          (slot.accountType === 'B1' ? '普通' : slot.accountType === 'B2' ? '当座' : slot.accountType))
        : null;
    bankAccounts.push({
      bankName: resolvedBankName,
      branchName: resolvedBranchName,
      accountTypeLabel: resolvedAccountType,
      accountNoEnc: slot.accountNoEnc,
      accountHolder: slot.accountHolder,
    });
  }

  const resolvedAddressee =
    partner.is_individual_honorific && representativeName !== null && representativeName.trim() !== ''
      ? `${partner.partner_name} ${representativeName}`
      : partner.partner_name;

  const resolvedAddressParts = [partner.address1, partner.address2].filter(
    (s): s is string => s !== null && s.trim() !== '',
  );
  const resolvedAddress = resolvedAddressParts.length > 0 ? resolvedAddressParts.join(' ') : null;

  return {
    issuer: {
      companyCode: settings.company_code,
      companyName: settings.company_name,
      invoiceRegistrationNo: settings.invoice_registration_no,
      corporateNo: settings.corporate_no,
      postalCode: settings.postal_code,
      address1: settings.address1,
      address2: settings.address2,
      tel: settings.tel,
      fax: settings.fax,
      email: settings.email,
      representativeTitle: settings.representative_title,
      representativeName: settings.representative_name,
      billingMemo: settings.billing_memo,
      bankAccounts,
    },
    recipient: {
      partnerCode: partner.partner_code,
      partnerName: partner.partner_name,
      representativeCode,
      representativeName,
      isIndividualHonorific: partner.is_individual_honorific,
      resolvedAddressee,
      honorific:
        params.honorific.trim() !== ''
          ? params.honorific
          : partner.is_individual_honorific
            ? '様'
            : '御中',
      resolvedPostalCode: partner.postal_code,
      resolvedAddress,
    },
    projectNo,
    projectName,
    productMap,
    taxCodeMap,
    defaultTemplateVariant: settings.quotation_template_rows === 20 ? '20_ROWS' : '10_ROWS',
    tenantTaxCalcPolicy: settings.tax_calc_policy,
    costTaxMode: settings.cost_tax_mode,
    showInvoiceCarryover: settings.show_invoice_carryover,
  };
}

async function resolveNextVersionInfo(
  tx: DbExecutor,
  documentType: DocumentType,
  sourceEntityId: string,
  forceReissue = false,
): Promise<{ versionNo: number; isReissue: boolean; reissueLabel: string | null }> {
  const verRows = await tx.query<{ max_ver: number }>(
    `SELECT COALESCE(MAX(version_no), 0)::int AS max_ver
       FROM document_snapshots
      WHERE document_type = $1::document_type
        AND source_entity_id = $2::uuid`,
    [documentType, sourceEntityId],
  );
  const maxVer = verRows[0] !== undefined ? Number(verRows[0].max_ver) : 0;
  const versionNo = maxVer + 1;
  const isReissue = forceReissue ? true : maxVer >= 1;
  return {
    versionNo,
    isReissue,
    reissueLabel: isReissue ? '＜再発行＞' : null,
  };
}

async function persistSnapshotDocument(
  tx: DbExecutor,
  params: {
    tenantId: string;
    employeeId: string;
    sourceEntityType: SnapshotHistoryItemDto['sourceEntityType'];
    sourceEntityId: string;
    versionNo: number;
    payload: DocumentSnapshotPayload;
  },
): Promise<SnapshotDetailDto> {
  const built = buildDocumentSnapshot(params.payload);

  const inserted = await tx.query<SnapshotDetailRow>(
    `INSERT INTO document_snapshots (
       tenant_id, document_type, source_entity_type, source_entity_id,
       document_no, version_no, is_reissue, reissue_label, template_variant,
       issued_by, payload_json, payload_sha256
     ) VALUES (
       $1::uuid, $2::document_type, $3, $4::uuid,
       $5, $6, $7, $8, $9,
       $10::uuid, $11::jsonb, $12
     )
     RETURNING id, document_type::text AS document_type, source_entity_type,
               source_entity_id, document_no, version_no, is_reissue,
               reissue_label, template_variant, issued_at::text AS issued_at,
               issued_by, NULL::text AS issued_by_name, payload_json, payload_sha256`,
    [
      params.tenantId,
      params.payload.documentType,
      params.sourceEntityType,
      params.sourceEntityId,
      params.payload.documentNo,
      params.versionNo,
      params.payload.isReissue,
      params.payload.reissueLabel,
      params.payload.templateVariant,
      params.employeeId,
      built.canonicalJson,
      built.payloadSha256,
    ],
  );

  const saved = inserted[0];
  if (saved === undefined) {
    throw new MasterDataError(
      500,
      'SNAPSHOT_INSERT_FAILED',
      '帳票スナップショットの保存結果を取得できませんでした。',
    );
  }

  const empRows = await tx.query<{ syain_name: string }>(
    'SELECT syain_name FROM employees WHERE id = $1::uuid LIMIT 1',
    [params.employeeId],
  );
  const issuedByName = empRows[0] !== undefined ? empRows[0].syain_name : null;

  return {
    ...mapSnapshotHistoryRow({ ...saved, issued_by_name: issuedByName }),
    payloadJson: parseSnapshotPayload(saved.payload_json),
  };
}

export async function issueQuotationSnapshot(
  tx: DbExecutor,
  params: {
    tenantId: string;
    employeeId: string;
    quotationId: string;
    documentType?: 'ESTIMATE' | 'ESTIMATE_SUMMARY_COVER' | 'ESTIMATE_SUMMARY_DETAIL';
    templateVariant?: QuotationTemplateVariant;
    issueDate?: string;
  },
): Promise<SnapshotDetailDto> {
  validateUuid(params.quotationId, '見積');
  await requireFeature(tx, params.tenantId, 'estimate');
  const issueDate = validateIssueDate(params.issueDate);
  const docType = params.documentType !== undefined ? params.documentType : 'ESTIMATE';

  const qRows = await tx.query<{
    id: string;
    quotation_no: string;
    quotation_name: string;
    quotation_date: string;
    partner_id: string;
    project_id: string | null;
    honorific: string;
    validity_period: string | null;
    delivery_date: string | null;
    is_advance_type: boolean;
    rounding_mode: RoundingMode;
    tax_calc_policy: TaxCalcPolicy;
    remarks: string | null;
  }>(
    `SELECT id, quotation_no::text AS quotation_no, quotation_name,
            quotation_date::text AS quotation_date, partner_id, project_id,
            honorific, validity_period, delivery_date, is_advance_type,
            rounding_mode::text AS rounding_mode, tax_calc_policy::text AS tax_calc_policy,
            remarks
       FROM quotations
      WHERE id = $1::uuid
      FOR UPDATE`,
    [params.quotationId],
  );
  const quotation = qRows[0];
  if (quotation === undefined) {
    throw new MasterDataError(404, 'QUOTATION_NOT_FOUND', '対象の見積が見つかりません。');
  }

  let targetQuotations = [quotation];
  if (
    (docType === 'ESTIMATE_SUMMARY_COVER' || docType === 'ESTIMATE_SUMMARY_DETAIL') &&
    quotation.project_id !== null
  ) {
    const selectedRows = await tx.query<typeof quotation>(
      `SELECT id, quotation_no::text AS quotation_no, quotation_name,
              quotation_date::text AS quotation_date, partner_id, project_id,
              honorific, validity_period, delivery_date, is_advance_type,
              rounding_mode::text AS rounding_mode, tax_calc_policy::text AS tax_calc_policy,
              remarks
         FROM quotations
        WHERE project_id = $1::uuid
          AND is_selected = true
        ORDER BY quotation_date ASC, quotation_no ASC`,
      [quotation.project_id],
    );
    if (selectedRows.length > 0) {
      targetQuotations = selectedRows;
    }
  }

  const targetQuotationIds = targetQuotations.map((q) => q.id);
  const allLineRows = await tx.query<{
    quotation_id: string;
    line_no: number;
    product_id: string | null;
    item_code: string | null;
    item_name: string;
    unit_name: string | null;
    is_heading: boolean;
    quantity: string;
    tax_code: TaxCode;
    applied_unit_price: string;
    applied_cost_price: string;
    remarks: string | null;
  }>(
    `SELECT quotation_id, line_no, product_id, item_code, item_name, unit_name, is_heading,
            quantity::text AS quantity, tax_code,
            applied_unit_price::text AS applied_unit_price,
            applied_cost_price::text AS applied_cost_price,
            remarks
       FROM quotation_lines
      WHERE quotation_id = ANY($1::uuid[])
      ORDER BY line_no ASC`,
    [targetQuotationIds],
  );

  interface PreparedQuotationLine {
    sourceSlipNo: number;
    sourceSlipDate: string;
    advanceMark: 'T' | null;
    lineNo: number;
    productId: string | null;
    itemCode: string | null;
    itemName: string;
    unitName: string | null;
    isHeading: boolean;
    quantity: string;
    taxCode: TaxCode;
    appliedUnitPrice: string;
    appliedCostPrice: string;
    remarks: string | null;
  }

  const preparedLines: PreparedQuotationLine[] = [];
  if (docType === 'ESTIMATE') {
    const singleLines = allLineRows.filter((l) => l.quotation_id === quotation.id);
    for (const l of singleLines) {
      preparedLines.push({
        sourceSlipNo: Number(quotation.quotation_no),
        sourceSlipDate: quotation.quotation_date.slice(0, 10),
        advanceMark: quotation.is_advance_type ? 'T' : null,
        lineNo: Number(l.line_no),
        productId: l.product_id,
        itemCode: l.item_code,
        itemName: l.item_name,
        unitName: l.unit_name,
        isHeading: l.is_heading,
        quantity: l.quantity,
        taxCode: l.tax_code,
        appliedUnitPrice: l.applied_unit_price,
        appliedCostPrice: l.applied_cost_price,
        remarks: l.remarks,
      });
    }
  } else if (docType === 'ESTIMATE_SUMMARY_DETAIL') {
    let seqNo = 1;
    for (const tq of targetQuotations) {
      const qLines = allLineRows.filter((l) => l.quotation_id === tq.id);
      if (targetQuotations.length > 1) {
        preparedLines.push({
          sourceSlipNo: Number(tq.quotation_no),
          sourceSlipDate: tq.quotation_date.slice(0, 10),
          advanceMark: tq.is_advance_type ? 'T' : null,
          lineNo: seqNo,
          productId: null,
          itemCode: null,
          itemName: `【見積 #${tq.quotation_no}】${tq.quotation_name}`,
          unitName: null,
          isHeading: true,
          quantity: '0',
          taxCode: 'C',
          appliedUnitPrice: '0',
          appliedCostPrice: '0',
          remarks: null,
        });
        seqNo += 1;
      }
      for (const l of qLines) {
        preparedLines.push({
          sourceSlipNo: Number(tq.quotation_no),
          sourceSlipDate: tq.quotation_date.slice(0, 10),
          advanceMark: tq.is_advance_type ? 'T' : null,
          lineNo: seqNo,
          productId: l.product_id,
          itemCode: l.item_code,
          itemName: l.item_name,
          unitName: l.unit_name,
          isHeading: l.is_heading,
          quantity: l.quantity,
          taxCode: l.tax_code,
          appliedUnitPrice: l.applied_unit_price,
          appliedCostPrice: l.applied_cost_price,
          remarks: l.remarks,
        });
        seqNo += 1;
      }
    }
  } else {
    // ESTIMATE_SUMMARY_COVER: 各選定見積（税区分グループ別）を鑑行へ集約
    let seqNo = 1;
    for (const tq of targetQuotations) {
      const qLines = allLineRows.filter((l) => l.quotation_id === tq.id && !l.is_heading);
      const distinctTaxes = Array.from(new Set(qLines.map((l) => l.tax_code)));
      if (distinctTaxes.length === 0) {
        preparedLines.push({
          sourceSlipNo: Number(tq.quotation_no),
          sourceSlipDate: tq.quotation_date.slice(0, 10),
          advanceMark: tq.is_advance_type ? 'T' : null,
          lineNo: seqNo,
          productId: null,
          itemCode: tq.quotation_no,
          itemName: `#${tq.quotation_no} ${tq.quotation_name}`,
          unitName: '式',
          isHeading: false,
          quantity: '1',
          taxCode: 'A',
          appliedUnitPrice: '0',
          appliedCostPrice: '0',
          remarks: null,
        });
        seqNo += 1;
        continue;
      }
      for (const tc of distinctTaxes) {
        const subLines = qLines.filter((l) => l.tax_code === tc);
        const sellCalc = calculateSlipTotals(
          subLines.map((sl, sIdx) => ({
            lineNo: sIdx + 1,
            quantity: sl.quantity,
            unitPrice: BigInt(sl.applied_unit_price),
            taxCode: sl.tax_code,
            roundingMode: tq.rounding_mode,
          })),
          tq.rounding_mode,
          tq.tax_calc_policy,
        );
        const costCalc = calculateSlipTotals(
          subLines.map((sl, sIdx) => ({
            lineNo: sIdx + 1,
            quantity: sl.quantity,
            unitPrice: BigInt(sl.applied_cost_price),
            taxCode: sl.tax_code,
            roundingMode: tq.rounding_mode,
          })),
          tq.rounding_mode,
          tq.tax_calc_policy,
        );
        const isInternal = tc === 'D' || tc === 'E';
        const sellPrice = isInternal ? sellCalc.totalIncl : sellCalc.subtotalExcl;
        const costPrice = isInternal ? costCalc.totalIncl : costCalc.subtotalExcl;
        const suffix = distinctTaxes.length > 1 ? ` [${tc}]` : '';
        preparedLines.push({
          sourceSlipNo: Number(tq.quotation_no),
          sourceSlipDate: tq.quotation_date.slice(0, 10),
          advanceMark: tq.is_advance_type ? 'T' : null,
          lineNo: seqNo,
          productId: null,
          itemCode: tq.quotation_no,
          itemName: `#${tq.quotation_no} ${tq.quotation_name}${suffix}`,
          unitName: '式',
          isHeading: false,
          quantity: '1',
          taxCode: tc,
          appliedUnitPrice: sellPrice.toString(),
          appliedCostPrice: costPrice.toString(),
          remarks: `集計対象 ${subLines.length}行`,
        });
        seqNo += 1;
      }
    }
  }

  const productIds = preparedLines
    .map((l) => l.productId)
    .filter((pid): pid is string => pid !== null);

  const ctx = await loadSnapshotCommonContext(tx, {
    tenantId: params.tenantId,
    partnerId: quotation.partner_id,
    projectId: quotation.project_id,
    honorific: quotation.honorific,
    productIds,
  });

  const attachmentRows =
    docType === 'ESTIMATE'
      ? await tx.query<{
          sort_order: number;
          storage_key: string;
          original_name: string;
          comment: string | null;
        }>(
          `SELECT sort_order, storage_key, original_name, comment
             FROM attachments
            WHERE entity_type = 'QUOTATION'
              AND entity_id = $1::uuid
            ORDER BY sort_order ASC, created_at ASC`,
          [params.quotationId],
        )
      : [];

  const ver = await resolveNextVersionInfo(tx, docType, params.quotationId);
  const templateVariant: QuotationTemplateVariant =
    params.templateVariant !== undefined ? params.templateVariant : ctx.defaultTemplateVariant;

  const calc = calculateQuotationSlip(
    preparedLines.map((l) => ({
      lineNo: l.lineNo,
      isHeading: l.isHeading,
      quantity: l.quantity,
      appliedUnitPrice: BigInt(l.appliedUnitPrice),
      appliedCostPrice: BigInt(l.appliedCostPrice),
      taxCode: l.taxCode,
    })),
    quotation.rounding_mode,
    quotation.tax_calc_policy,
  );

  const resolvedTitle =
    docType === 'ESTIMATE'
      ? quotation.quotation_name
      : ctx.projectName !== null
        ? `${ctx.projectName}（選択見積 ${targetQuotations.length}件まとめ）`
        : quotation.quotation_name;

  const payload: DocumentSnapshotPayload = {
    schemaVersion: 1,
    documentType: docType,
    templateVariant,
    documentNo: quotation.quotation_no,
    issueDate,
    isReissue: ver.isReissue,
    reissueLabel: ver.reissueLabel,
    issuer: ctx.issuer,
    recipient: ctx.recipient,
    header: {
      title: resolvedTitle,
      projectNo: ctx.projectNo,
      projectName: ctx.projectName,
      validityPeriod: quotation.validity_period,
      deliveryDate: quotation.delivery_date,
      paymentDueDate: null,
      roundingMode: quotation.rounding_mode,
      taxCalcPolicy: quotation.tax_calc_policy,
      costTaxMode: ctx.costTaxMode,
      subtotalAmount: Number(calc.subtotalAmount),
      taxTotal: Number(calc.taxTotal),
      taxAdjustmentAmount: 0,
      totalAmount: Number(calc.totalAmount),
      taxBreakdown: {
        rate10Excl: Number(calc.rate10Excl),
        rate10Tax: Number(calc.rate10Tax),
        rate8Excl: Number(calc.rate8Excl),
        rate8Tax: Number(calc.rate8Tax),
        nonTaxAmount: Number(calc.nonTax0),
      },
      showCarryover: false,
      mirrorSummary: null,
      remarks: quotation.remarks,
    },
    lines: preparedLines.map((l, idx) => {
      const lr = calc.lineResults[idx];
      if (lr === undefined) {
        throw new MasterDataError(500, 'CALC_MISMATCH', 'スナップショット明細計算が不整合です。');
      }
      const prodMeta = l.productId !== null ? ctx.productMap.get(l.productId) : undefined;
      const capNum = prodMeta !== undefined ? Number(prodMeta.capacity) : 0;
      const capacityLabel = capNum > 0 ? String(capNum) : null;
      const tcRow = ctx.taxCodeMap.get(l.taxCode);

      return {
        lineNo: l.lineNo,
        sourceSlipNo: l.sourceSlipNo,
        sourceSlipDate: l.sourceSlipDate,
        advanceMark: l.advanceMark,
        itemCode: l.itemCode,
        itemName: l.itemName,
        capacityLabel,
        unitName: l.unitName,
        targetMonthLabel: null,
        isHeading: l.isHeading,
        quantity: l.isHeading ? 0 : Number(l.quantity),
        appliedUnitPrice: l.isHeading ? 0 : Number(l.appliedUnitPrice),
        lineAmount: Number(lr.lineAmount),
        taxCode: l.taxCode,
        taxRate: tcRow !== undefined ? Number(tcRow.tax_rate) : Number(lr.taxRate.toString()),
        taxMarkSymbol: normalizeTaxMarkSymbol(tcRow?.mark_symbol, lr.taxMarkSymbol),
        isInternalTax: tcRow !== undefined ? tcRow.is_internal : lr.isInternalTax,
        lineTax: Number(lr.lineTax),
        rowTotal: Number(lr.lineTotal),
        remarks: l.remarks,
      };
    }),
    attachments: attachmentRows.map((att) => ({
      sortOrder: Number(att.sort_order),
      storageKey: att.storage_key,
      originalName: att.original_name,
      comment: att.comment,
    })),
  };

  return persistSnapshotDocument(tx, {
    tenantId: params.tenantId,
    employeeId: params.employeeId,
    sourceEntityType: 'QUOTATION',
    sourceEntityId: params.quotationId,
    versionNo: ver.versionNo,
    payload,
  });
}

/**
 * 売上・立替伝票（SALES_HEADER）から納品書（DELIVERY_NOTE）または受領書（DELIVERY_RECEIPT）を発行・凍結保存する
 */
export async function issueSalesSnapshot(
  tx: DbExecutor,
  params: {
    tenantId: string;
    employeeId: string;
    salesHeaderId: string;
    documentType: 'DELIVERY_NOTE' | 'DELIVERY_RECEIPT';
    templateVariant?: QuotationTemplateVariant;
    issueDate?: string;
  },
): Promise<SnapshotDetailDto> {
  validateUuid(params.salesHeaderId, '売上・立替伝票');
  const issueDate = validateIssueDate(params.issueDate);

  const sRows = await tx.query<{
    id: string;
    entry_type: 'SALE' | 'ADVANCE';
    slip_no: string;
    slip_name: string;
    slip_date: string;
    partner_id: string;
    project_id: string | null;
    honorific: string;
    rounding_mode: RoundingMode;
    approval_remarks: string | null;
  }>(
    `SELECT id, entry_type::text AS entry_type, slip_no::text AS slip_no,
            slip_name, slip_date::text AS slip_date, partner_id, project_id,
            honorific, rounding_mode::text AS rounding_mode, approval_remarks
       FROM sales_headers
      WHERE id = $1::uuid
      FOR UPDATE`,
    [params.salesHeaderId],
  );
  const sale = sRows[0];
  if (sale === undefined) {
    throw new MasterDataError(404, 'SALES_NOT_FOUND', '対象の売上・立替伝票が見つかりません。');
  }

  await requireFeature(tx, params.tenantId, sale.entry_type === 'ADVANCE' ? 'tatekae' : 'sales');

  const lineRows = await tx.query<{
    line_no: number;
    product_id: string | null;
    item_code: string | null;
    item_name: string;
    unit_name: string | null;
    target_month_label: string | null;
    is_heading: boolean;
    quantity: string;
    applied_unit_price: string;
    tax_code: TaxCode;
    remarks: string | null;
  }>(
    `SELECT line_no, product_id, item_code, item_name, unit_name,
            target_month_label, is_heading, quantity::text AS quantity,
            applied_unit_price::text AS applied_unit_price, tax_code, remarks
       FROM sales_lines
      WHERE sales_header_id = $1::uuid
      ORDER BY line_no ASC`,
    [params.salesHeaderId],
  );

  const productIds = lineRows
    .map((l) => l.product_id)
    .filter((pid): pid is string => pid !== null);

  const ctx = await loadSnapshotCommonContext(tx, {
    tenantId: params.tenantId,
    partnerId: sale.partner_id,
    projectId: sale.project_id,
    honorific: sale.honorific,
    productIds,
  });

  const ver = await resolveNextVersionInfo(tx, params.documentType, params.salesHeaderId);
  const templateVariant: QuotationTemplateVariant =
    params.templateVariant !== undefined ? params.templateVariant : ctx.defaultTemplateVariant;

  const calc = calculateSalesSlip(
    lineRows.map((l) => ({
      lineNo: Number(l.line_no),
      isHeading: l.is_heading,
      quantity: l.quantity,
      appliedUnitPrice: BigInt(l.applied_unit_price),
      taxCode: l.tax_code,
    })),
    sale.rounding_mode,
    ctx.tenantTaxCalcPolicy,
  );

  const slipNoNum = Number(sale.slip_no);
  const slipDateStr = sale.slip_date.slice(0, 10);
  const advanceMark: 'T' | null = sale.entry_type === 'ADVANCE' ? 'T' : null;
  const documentNo =
    sale.entry_type === 'ADVANCE' ? `T-${sale.slip_no}` : sale.slip_no;

  const payload: DocumentSnapshotPayload = {
    schemaVersion: 1,
    documentType: params.documentType,
    templateVariant,
    documentNo,
    issueDate,
    isReissue: ver.isReissue,
    reissueLabel: ver.reissueLabel,
    issuer: ctx.issuer,
    recipient: ctx.recipient,
    header: {
      title: sale.slip_name,
      projectNo: ctx.projectNo,
      projectName: ctx.projectName,
      validityPeriod: null,
      deliveryDate: slipDateStr,
      paymentDueDate: null,
      roundingMode: sale.rounding_mode,
      taxCalcPolicy: ctx.tenantTaxCalcPolicy,
      costTaxMode: ctx.costTaxMode,
      subtotalAmount: Number(calc.subtotalAmount),
      taxTotal: Number(calc.taxTotal),
      taxAdjustmentAmount: 0,
      totalAmount: Number(calc.totalAmount),
      taxBreakdown: {
        rate10Excl: Number(calc.rate10Excl),
        rate10Tax: Number(calc.rate10Tax),
        rate8Excl: Number(calc.rate8Excl),
        rate8Tax: Number(calc.rate8Tax),
        nonTaxAmount: Number(calc.nonTax0),
      },
      showCarryover: false,
      mirrorSummary: null,
      remarks: sale.approval_remarks,
    },
    lines: lineRows.map((l, idx) => {
      const lr = calc.lineResults[idx];
      if (lr === undefined) {
        throw new MasterDataError(500, 'CALC_MISMATCH', 'スナップショット明細計算が不整合です。');
      }
      const prodMeta = l.product_id !== null ? ctx.productMap.get(l.product_id) : undefined;
      const capNum = prodMeta !== undefined ? Number(prodMeta.capacity) : 0;
      const capacityLabel = capNum > 0 ? String(capNum) : null;
      const tcRow = ctx.taxCodeMap.get(l.tax_code);

      return {
        lineNo: Number(l.line_no),
        sourceSlipNo: slipNoNum,
        sourceSlipDate: slipDateStr,
        advanceMark,
        itemCode: l.item_code,
        itemName: l.item_name,
        capacityLabel,
        unitName: l.unit_name,
        targetMonthLabel: l.target_month_label,
        isHeading: l.is_heading,
        quantity: l.is_heading ? 0 : Number(l.quantity),
        appliedUnitPrice: l.is_heading ? 0 : Number(l.applied_unit_price),
        lineAmount: Number(lr.lineAmount),
        taxCode: l.tax_code,
        taxRate: tcRow !== undefined ? Number(tcRow.tax_rate) : Number(lr.taxRate.toString()),
        taxMarkSymbol: normalizeTaxMarkSymbol(tcRow?.mark_symbol, lr.taxMarkSymbol),
        isInternalTax: tcRow !== undefined ? tcRow.is_internal : lr.isInternalTax,
        lineTax: Number(lr.lineTax),
        rowTotal: Number(lr.rowTotal),
        remarks: l.remarks,
      };
    }),
    attachments: [],
  };

  return persistSnapshotDocument(tx, {
    tenantId: params.tenantId,
    employeeId: params.employeeId,
    sourceEntityType: 'SALES_HEADER',
    sourceEntityId: params.salesHeaderId,
    versionNo: ver.versionNo,
    payload,
  });
}

export type BillingSnapshotDocumentType =
  | 'INVOICE'
  | 'INVOICE_STANDALONE'
  | 'INVOICE_COVER'
  | 'INVOICE_COVER_MEMO_SUM'
  | 'INVOICE_COVER_DETAIL'
  | 'FIXED_INVOICE';

export const BILLING_SNAPSHOT_DOCUMENT_TYPES: ReadonlySet<DocumentType> = new Set([
  'INVOICE',
  'INVOICE_STANDALONE',
  'INVOICE_COVER',
  'INVOICE_COVER_MEMO_SUM',
  'INVOICE_COVER_DETAIL',
  'FIXED_INVOICE',
]);

async function assertBillingSnapshotFeature(
  tx: DbExecutor,
  tenantId: string,
  docType: DocumentType,
): Promise<void> {
  if (docType === 'FIXED_INVOICE') {
    const fixedOk = await isFeatureEnabled(tx, tenantId, 'fixedbill');
    if (fixedOk) return;
    await requireFeature(tx, tenantId, 'billissue');
    return;
  }
  await requireFeature(tx, tenantId, 'billissue');
}

/**
 * 請求ヘッダ（BILLING_HEADER）から対外請求書6種のうち指定種別のイミュータブルスナップショットを発行・凍結保存する
 */
export async function issueBillingSnapshot(
  tx: DbExecutor,
  params: {
    tenantId: string;
    employeeId: string;
    billingId: string;
    documentType: BillingSnapshotDocumentType;
    templateVariant?: QuotationTemplateVariant;
    issueDate?: string;
    forceReissue?: boolean;
  },
): Promise<SnapshotDetailDto> {
  validateUuid(params.billingId, '請求ヘッダ');
  await assertBillingSnapshotFeature(tx, params.tenantId, params.documentType);

  const bRows = await tx.query<{
    id: string;
    billing_no: string;
    partner_id: string;
    billing_date: string;
    target_period_start: string | null;
    target_period_end: string | null;
    payment_due_date: string | null;
    is_subscription_bill: boolean;
    tax_calc_policy: TaxCalcPolicy;
    rounding_mode: RoundingMode;
    amount_10_excl: string;
    amount_8_excl: string;
    amount_0_non_tax: string;
    tax_10_amount: string;
    tax_8_amount: string;
    tax_adjustment_amount: string;
    tax_total: string;
    billing_amount: string;
    prev_carried_balance: string;
    period_receipt_amount: string;
    net_carried_balance: string;
    closing_ar_balance: string;
  }>(
    `SELECT id, billing_no::text AS billing_no, partner_id,
            billing_date::text AS billing_date,
            target_period_start::text AS target_period_start,
            target_period_end::text AS target_period_end,
            payment_due_date::text AS payment_due_date,
            is_subscription_bill,
            tax_calc_policy::text AS tax_calc_policy,
            rounding_mode::text AS rounding_mode,
            amount_10_excl::text AS amount_10_excl,
            amount_8_excl::text AS amount_8_excl,
            amount_0_non_tax::text AS amount_0_non_tax,
            tax_10_amount::text AS tax_10_amount,
            tax_8_amount::text AS tax_8_amount,
            tax_adjustment_amount::text AS tax_adjustment_amount,
            tax_total::text AS tax_total,
            billing_amount::text AS billing_amount,
            prev_carried_balance::text AS prev_carried_balance,
            period_receipt_amount::text AS period_receipt_amount,
            net_carried_balance::text AS net_carried_balance,
            closing_ar_balance::text AS closing_ar_balance
       FROM billing_headers
      WHERE id = $1::uuid
      FOR UPDATE`,
    [params.billingId],
  );
  const billing = bRows[0];
  if (billing === undefined) {
    throw new MasterDataError(404, 'BILLING_NOT_FOUND', '対象の請求データが見つかりません。');
  }

  const issueDate =
    params.issueDate !== undefined && params.issueDate.trim() !== ''
      ? validateIssueDate(params.issueDate)
      : billing.billing_date.slice(0, 10);

  const shRows = await tx.query<{
    id: string;
    entry_type: 'SALE' | 'ADVANCE';
    slip_no: string;
    slip_name: string;
    slip_date: string;
    project_id: string | null;
    honorific: string;
    subtotal_amount: string;
    tax_total: string;
    total_amount: string;
  }>(
    `SELECT id, entry_type::text AS entry_type, slip_no::text AS slip_no,
            slip_name, slip_date::text AS slip_date, project_id, honorific,
            subtotal_amount::text AS subtotal_amount,
            tax_total::text AS tax_total,
            total_amount::text AS total_amount
       FROM sales_headers
      WHERE billing_id = $1::uuid
      ORDER BY slip_date ASC, entry_type ASC, slip_no ASC`,
    [params.billingId],
  );

  const slRows = await tx.query<{
    sales_header_id: string;
    entry_type: 'SALE' | 'ADVANCE';
    slip_no: string;
    slip_date: string;
    line_no: number;
    product_id: string | null;
    item_code: string | null;
    item_name: string;
    unit_name: string | null;
    target_month_label: string | null;
    is_heading: boolean;
    quantity: string;
    applied_unit_price: string;
    tax_code: TaxCode;
    line_amount: string;
    line_tax: string;
    row_total: string;
    remarks: string | null;
  }>(
    `SELECT sl.sales_header_id, sh.entry_type::text AS entry_type,
            sh.slip_no::text AS slip_no, sh.slip_date::text AS slip_date,
            sl.line_no, sl.product_id, sl.item_code, sl.item_name,
            sl.unit_name, sl.target_month_label, sl.is_heading,
            sl.quantity::text AS quantity,
            sl.applied_unit_price::text AS applied_unit_price,
            sl.tax_code,
            sl.line_amount::text AS line_amount,
            sl.line_tax::text AS line_tax,
            sl.row_total::text AS row_total,
            sl.remarks
       FROM sales_lines sl
       JOIN sales_headers sh ON sh.tenant_id = sl.tenant_id AND sh.id = sl.sales_header_id
      WHERE sh.billing_id = $1::uuid
      ORDER BY sh.slip_date ASC, sh.entry_type ASC, sh.slip_no ASC, sl.line_no ASC`,
    [params.billingId],
  );

  const productIds = slRows
    .map((l) => l.product_id)
    .filter((pid): pid is string => pid !== null);

  const firstHeader = shRows[0];
  const ctx = await loadSnapshotCommonContext(tx, {
    tenantId: params.tenantId,
    partnerId: billing.partner_id,
    projectId: shRows.length === 1 && firstHeader !== undefined ? firstHeader.project_id : null,
    honorific: firstHeader !== undefined ? firstHeader.honorific : '',
    productIds,
  });

  const ver = await resolveNextVersionInfo(
    tx,
    params.documentType,
    params.billingId,
    params.forceReissue === true,
  );
  const templateVariant: QuotationTemplateVariant =
    params.templateVariant !== undefined ? params.templateVariant : ctx.defaultTemplateVariant;

  const amount10Excl = BigInt(billing.amount_10_excl);
  const amount8Excl = BigInt(billing.amount_8_excl);
  const amount0NonTax = BigInt(billing.amount_0_non_tax);
  const subtotalAmount = amount10Excl + amount8Excl + amount0NonTax;

  let showCarryover = false;
  if (params.documentType === 'INVOICE_COVER' || params.documentType === 'INVOICE_COVER_MEMO_SUM') {
    showCarryover = true;
  } else if (params.documentType === 'INVOICE' || params.documentType === 'FIXED_INVOICE') {
    showCarryover = ctx.showInvoiceCarryover;
  }

  const mirrorSummary = showCarryover
    ? {
        prevCarriedBalance: Number(billing.prev_carried_balance),
        periodReceiptAmount: Number(billing.period_receipt_amount),
        netCarriedBalance: Number(billing.net_carried_balance),
        currentBillingAmount: Number(billing.billing_amount),
        closingArBalance: Number(billing.closing_ar_balance),
      }
    : null;

  const periodMonthText =
    billing.target_period_end !== null
      ? billing.target_period_end.slice(0, 7)
      : billing.billing_date.slice(0, 7);

  let title = `${periodMonthText} ご請求分（${shRows.length}伝票）`;
  if (billing.is_subscription_bill || params.documentType === 'FIXED_INVOICE') {
    title = `${periodMonthText} 定額ご請求分`;
  } else if (shRows.length === 1 && firstHeader !== undefined && firstHeader.slip_name.trim() !== '') {
    title = firstHeader.slip_name.trim();
  }

  const buildDetailedLines = (): DocumentSnapshotPayload['lines'] =>
    slRows.map((l, idx) => {
      const prodMeta = l.product_id !== null ? ctx.productMap.get(l.product_id) : undefined;
      const capNum = prodMeta !== undefined ? Number(prodMeta.capacity) : 0;
      const capacityLabel = capNum > 0 ? String(capNum) : null;
      const tcRow = ctx.taxCodeMap.get(l.tax_code);
      const tcDef = TAX_CODE_DEFINITIONS[l.tax_code];

      return {
        lineNo: idx + 1,
        sourceSlipNo: Number(l.slip_no),
        sourceSlipDate: l.slip_date.slice(0, 10),
        advanceMark: l.entry_type === 'ADVANCE' ? 'T' : null,
        itemCode: l.item_code,
        itemName: l.item_name,
        capacityLabel,
        unitName: l.unit_name,
        targetMonthLabel: l.target_month_label,
        isHeading: l.is_heading,
        quantity: l.is_heading ? 0 : Number(l.quantity),
        appliedUnitPrice: l.is_heading ? 0 : Number(l.applied_unit_price),
        lineAmount: Number(l.line_amount),
        taxCode: l.tax_code,
        taxRate: tcRow !== undefined ? Number(tcRow.tax_rate) : Number(tcDef.rate),
        taxMarkSymbol: normalizeTaxMarkSymbol(tcRow?.mark_symbol, tcDef.symbol),
        isInternalTax: tcRow !== undefined ? tcRow.is_internal : tcDef.isInternal,
        lineTax: Number(l.line_tax),
        rowTotal: Number(l.row_total),
        remarks: l.remarks,
      };
    });

  let snapshotLines: DocumentSnapshotPayload['lines'];
  if (params.documentType === 'INVOICE_COVER') {
    snapshotLines = shRows.map((sh, idx) => {
      const slipLines = slRows.filter((l) => l.sales_header_id === sh.id && !l.is_heading);
      const primaryTax: TaxCode = slipLines[0] !== undefined ? slipLines[0].tax_code : 'A';
      const tcRow = ctx.taxCodeMap.get(primaryTax);
      const tcDef = TAX_CODE_DEFINITIONS[primaryTax];
      return {
        lineNo: idx + 1,
        sourceSlipNo: Number(sh.slip_no),
        sourceSlipDate: sh.slip_date.slice(0, 10),
        advanceMark: sh.entry_type === 'ADVANCE' ? 'T' : null,
        itemCode: null,
        itemName: sh.slip_name.trim() !== '' ? sh.slip_name.trim() : `売上伝票 No.${sh.slip_no}`,
        capacityLabel: null,
        unitName: '伝票',
        targetMonthLabel: null,
        isHeading: false,
        quantity: 1,
        appliedUnitPrice: Number(sh.subtotal_amount),
        lineAmount: Number(sh.subtotal_amount),
        taxCode: primaryTax,
        taxRate: tcRow !== undefined ? Number(tcRow.tax_rate) : Number(tcDef.rate),
        taxMarkSymbol: normalizeTaxMarkSymbol(tcRow?.mark_symbol, tcDef.symbol),
        isInternalTax: tcRow !== undefined ? tcRow.is_internal : tcDef.isInternal,
        lineTax: Number(sh.tax_total),
        rowTotal: Number(sh.total_amount),
        remarks: sh.entry_type === 'ADVANCE' ? '立替金' : '通常売上',
      };
    });
  } else if (params.documentType === 'INVOICE_COVER_MEMO_SUM') {
    interface MemoBucket {
      advanceMark: 'T' | null;
      itemCode: string | null;
      itemName: string;
      unitName: string | null;
      targetMonthLabel: string | null;
      taxCode: TaxCode;
      remarks: string | null;
      firstUnitPrice: bigint;
      hasDifferentPrice: boolean;
      qtySum: Decimal;
      lineAmountSum: bigint;
      lineTaxSum: bigint;
      rowTotalSum: bigint;
    }
    const buckets = new Map<string, MemoBucket>();
    for (const l of slRows) {
      if (l.is_heading) continue;
      const adv: 'T' | null = l.entry_type === 'ADVANCE' ? 'T' : null;
      const rem = l.remarks !== null && l.remarks.trim() !== '' ? l.remarks.trim() : null;
      const key = `${l.item_name}\u0000${rem !== null ? rem : ''}\u0000${l.tax_code}\u0000${adv !== null ? adv : ''}`;
      const price = BigInt(l.applied_unit_price);
      const existing = buckets.get(key);
      if (existing === undefined) {
        buckets.set(key, {
          advanceMark: adv,
          itemCode: l.item_code,
          itemName: l.item_name,
          unitName: l.unit_name,
          targetMonthLabel: l.target_month_label,
          taxCode: l.tax_code,
          remarks: rem,
          firstUnitPrice: price,
          hasDifferentPrice: false,
          qtySum: new Decimal(l.quantity),
          lineAmountSum: BigInt(l.line_amount),
          lineTaxSum: BigInt(l.line_tax),
          rowTotalSum: BigInt(l.row_total),
        });
      } else {
        if (existing.firstUnitPrice !== price || existing.unitName !== l.unit_name) {
          existing.hasDifferentPrice = true;
        }
        existing.qtySum = existing.qtySum.plus(l.quantity);
        existing.lineAmountSum += BigInt(l.line_amount);
        existing.lineTaxSum += BigInt(l.line_tax);
        existing.rowTotalSum += BigInt(l.row_total);
      }
    }
    snapshotLines = Array.from(buckets.values()).map((b, idx) => {
      const tcRow = ctx.taxCodeMap.get(b.taxCode);
      const tcDef = TAX_CODE_DEFINITIONS[b.taxCode];
      return {
        lineNo: idx + 1,
        sourceSlipNo: null,
        sourceSlipDate: null,
        advanceMark: b.advanceMark,
        itemCode: b.itemCode,
        itemName: b.itemName,
        capacityLabel: null,
        unitName: b.hasDifferentPrice ? '式' : b.unitName,
        targetMonthLabel: b.targetMonthLabel,
        isHeading: false,
        quantity: b.hasDifferentPrice ? 1 : Number(b.qtySum.toFixed(4)),
        appliedUnitPrice: b.hasDifferentPrice ? Number(b.lineAmountSum) : Number(b.firstUnitPrice),
        lineAmount: Number(b.lineAmountSum),
        taxCode: b.taxCode,
        taxRate: tcRow !== undefined ? Number(tcRow.tax_rate) : Number(tcDef.rate),
        taxMarkSymbol: normalizeTaxMarkSymbol(tcRow?.mark_symbol, tcDef.symbol),
        isInternalTax: tcRow !== undefined ? tcRow.is_internal : tcDef.isInternal,
        lineTax: Number(b.lineTaxSum),
        rowTotal: Number(b.rowTotalSum),
        remarks: b.remarks,
      };
    });
  } else {
    snapshotLines = buildDetailedLines();
  }

  const payload: DocumentSnapshotPayload = {
    schemaVersion: 1,
    documentType: params.documentType,
    templateVariant,
    documentNo: billing.billing_no,
    issueDate,
    isReissue: ver.isReissue,
    reissueLabel: ver.reissueLabel,
    issuer: ctx.issuer,
    recipient: ctx.recipient,
    header: {
      title,
      projectNo: ctx.projectNo,
      projectName: ctx.projectName,
      validityPeriod: null,
      deliveryDate: billing.billing_date.slice(0, 10),
      paymentDueDate:
        billing.payment_due_date !== null ? billing.payment_due_date.slice(0, 10) : null,
      roundingMode: billing.rounding_mode,
      taxCalcPolicy: billing.tax_calc_policy,
      costTaxMode: ctx.costTaxMode,
      subtotalAmount: Number(subtotalAmount),
      taxTotal: Number(billing.tax_total),
      taxAdjustmentAmount: Number(billing.tax_adjustment_amount),
      totalAmount: Number(billing.billing_amount),
      taxBreakdown: {
        rate10Excl: Number(billing.amount_10_excl),
        rate10Tax: Number(billing.tax_10_amount),
        rate8Excl: Number(billing.amount_8_excl),
        rate8Tax: Number(billing.tax_8_amount),
        nonTaxAmount: Number(billing.amount_0_non_tax),
      },
      showCarryover,
      mirrorSummary,
      remarks: ctx.issuer.billingMemo,
    },
    lines: snapshotLines,
    attachments: [],
  };

  return persistSnapshotDocument(tx, {
    tenantId: params.tenantId,
    employeeId: params.employeeId,
    sourceEntityType: 'BILLING_HEADER',
    sourceEntityId: params.billingId,
    versionNo: ver.versionNo,
    payload,
  });
}

/**
 * 入金データ（CASH_RECEIPT）から領収書（RECEIPT）スナップショットを発行・凍結保存する
 */
export async function issueReceiptSnapshot(
  tx: DbExecutor,
  params: {
    tenantId: string;
    employeeId: string;
    receiptId: string;
    templateVariant?: QuotationTemplateVariant;
    issueDate?: string;
    forceReissue?: boolean;
  },
): Promise<SnapshotDetailDto> {
  validateUuid(params.receiptId, '入金');
  await requireFeature(tx, params.tenantId, 'deposit');

  const crRows = await tx.query<{
    id: string;
    receipt_no: string;
    receipt_date: string;
    partner_id: string;
    project_id: string | null;
    method_code_1: string | null;
    deposit_1: string;
    method_code_2: string | null;
    deposit_2: string;
    method_code_3: string | null;
    deposit_3: string;
    total_deposit: string;
    subtotal_10_excl: string;
    subtotal_8_excl: string;
    subtotal_0: string;
    tadashi: string | null;
    bill_no: string | null;
    bill_due_date: string | null;
    remarks: string | null;
  }>(
    `SELECT id, receipt_no::text AS receipt_no, receipt_date::text AS receipt_date,
            partner_id, project_id,
            method_code_1, deposit_1::text AS deposit_1,
            method_code_2, deposit_2::text AS deposit_2,
            method_code_3, deposit_3::text AS deposit_3,
            total_deposit::text AS total_deposit,
            subtotal_10_excl::text AS subtotal_10_excl,
            subtotal_8_excl::text AS subtotal_8_excl,
            subtotal_0::text AS subtotal_0,
            tadashi, bill_no, bill_due_date::text AS bill_due_date, remarks
       FROM cash_receipts
      WHERE id = $1::uuid
      FOR UPDATE`,
    [params.receiptId],
  );
  const receipt = crRows[0];
  if (receipt === undefined) {
    throw new MasterDataError(404, 'RECEIPT_NOT_FOUND', '対象の入金データが見つかりません。');
  }

  const issueDate =
    params.issueDate !== undefined && params.issueDate.trim() !== ''
      ? validateIssueDate(params.issueDate)
      : receipt.receipt_date.slice(0, 10);

  const methodRows = await tx.query<{ method_code: string; method_name: string }>(
    'SELECT method_code, method_name FROM payment_methods',
    [],
  );
  const methodMap = new Map(methodRows.map((m) => [m.method_code, m.method_name]));

  const ctx = await loadSnapshotCommonContext(tx, {
    tenantId: params.tenantId,
    partnerId: receipt.partner_id,
    projectId: receipt.project_id,
    honorific: '',
    productIds: [],
  });

  const ver = await resolveNextVersionInfo(
    tx,
    'RECEIPT',
    params.receiptId,
    params.forceReissue === true,
  );
  const templateVariant: QuotationTemplateVariant =
    params.templateVariant !== undefined ? params.templateVariant : ctx.defaultTemplateVariant;

  const rawSlots = [
    { code: receipt.method_code_1, amount: BigInt(receipt.deposit_1) },
    { code: receipt.method_code_2, amount: BigInt(receipt.deposit_2) },
    { code: receipt.method_code_3, amount: BigInt(receipt.deposit_3) },
  ];
  const paymentBreakdowns: Array<{ methodCode: string; methodName: string; amount: number }> = [];
  for (const slot of rawSlots) {
    if (slot.amount !== 0n || (slot.code !== null && slot.code.trim() !== '' && slot.amount > 0n)) {
      const code = slot.code !== null && slot.code.trim() !== '' ? slot.code.trim() : 'A';
      const resolvedName = methodMap.get(code);
      paymentBreakdowns.push({
        methodCode: code,
        methodName: resolvedName !== undefined ? resolvedName : code,
        amount: Number(slot.amount),
      });
    }
  }

  const totalDeposit = BigInt(receipt.total_deposit);
  const sub10 = BigInt(receipt.subtotal_10_excl);
  const sub8 = BigInt(receipt.subtotal_8_excl);
  const sub0 = BigInt(receipt.subtotal_0);

  let rate10Excl = 0;
  let rate10Tax = 0;
  let rate8Excl = 0;
  let rate8Tax = 0;
  let nonTaxAmount = 0;
  let subtotalAmount = 0;
  let taxTotal = 0;

  if (sub10 !== 0n || sub8 !== 0n || sub0 !== 0n) {
    const calcInputs: LineCalcInput[] = [];
    if (sub10 !== 0n) {
      calcInputs.push({ lineNo: 1, quantity: 1, unitPrice: sub10, taxCode: 'A', roundingMode: 'FLOOR' });
    }
    if (sub8 !== 0n) {
      calcInputs.push({ lineNo: 2, quantity: 1, unitPrice: sub8, taxCode: 'B', roundingMode: 'FLOOR' });
    }
    if (sub0 !== 0n) {
      calcInputs.push({ lineNo: 3, quantity: 1, unitPrice: sub0, taxCode: 'C', roundingMode: 'FLOOR' });
    }
    const slipCalc = calculateSlipTotals(calcInputs, 'FLOOR', 'SLIP_BY_RATE');
    rate10Excl = Number(slipCalc.rate10Excl);
    rate10Tax = Number(slipCalc.rate10Tax);
    rate8Excl = Number(slipCalc.rate8Excl);
    rate8Tax = Number(slipCalc.rate8Tax);
    nonTaxAmount = Number(slipCalc.nonTax0);
    subtotalAmount = Number(slipCalc.subtotalExcl);
    taxTotal = Number(slipCalc.taxTotal);
  } else {
    const internalCalc = calculateLineAmounts({
      lineNo: 1,
      quantity: 1,
      unitPrice: totalDeposit,
      taxCode: 'D',
      roundingMode: 'FLOOR',
    });
    rate10Excl = Number(internalCalc.exclAmount);
    rate10Tax = Number(internalCalc.lineTax);
    subtotalAmount = Number(internalCalc.exclAmount);
    taxTotal = Number(internalCalc.lineTax);
  }

  const tadashiText =
    receipt.tadashi !== null && receipt.tadashi.trim() !== ''
      ? receipt.tadashi.trim()
      : 'お買上代金';

  const payload: DocumentSnapshotPayload = {
    schemaVersion: 1,
    documentType: 'RECEIPT',
    templateVariant,
    documentNo: receipt.receipt_no,
    issueDate,
    isReissue: ver.isReissue,
    reissueLabel: ver.reissueLabel,
    issuer: ctx.issuer,
    recipient: ctx.recipient,
    header: {
      title: tadashiText,
      projectNo: ctx.projectNo,
      projectName: ctx.projectName,
      validityPeriod: null,
      deliveryDate: receipt.receipt_date.slice(0, 10),
      paymentDueDate: null,
      roundingMode: 'FLOOR',
      taxCalcPolicy: 'SLIP_BY_RATE',
      costTaxMode: ctx.costTaxMode,
      subtotalAmount,
      taxTotal,
      taxAdjustmentAmount: 0,
      totalAmount: Number(totalDeposit),
      taxBreakdown: {
        rate10Excl,
        rate10Tax,
        rate8Excl,
        rate8Tax,
        nonTaxAmount,
      },
      showCarryover: false,
      mirrorSummary: null,
      remarks: receipt.remarks,
    },
    lines: [],
    receiptSpecific: {
      tadashi: receipt.tadashi,
      totalDeposit: Number(totalDeposit),
      paymentBreakdowns,
      billNo: receipt.bill_no,
      billDueDate: receipt.bill_due_date !== null ? receipt.bill_due_date.slice(0, 10) : null,
    },
    attachments: [],
  };

  return persistSnapshotDocument(tx, {
    tenantId: params.tenantId,
    employeeId: params.employeeId,
    sourceEntityType: 'CASH_RECEIPT',
    sourceEntityId: params.receiptId,
    versionNo: ver.versionNo,
    payload,
  });
}

/**
 * 発注伝票（PURCHASE_ORDER）から発注書スナップショットを発行・凍結保存する
 */
export async function issuePurchaseOrderSnapshot(
  tx: DbExecutor,
  params: {
    tenantId: string;
    employeeId: string;
    orderId: string;
    templateVariant?: QuotationTemplateVariant;
    issueDate?: string;
    forceReissue?: boolean;
  },
): Promise<SnapshotDetailDto> {
  validateUuid(params.orderId, '発注');
  await requireFeature(tx, params.tenantId, 'order');

  const poRows = await tx.query<{
    id: string;
    order_no: string;
    order_name: string;
    order_date: string;
    supplier_id: string;
    project_id: string | null;
    honorific: string;
    delivery_date: string | null;
    rounding_mode: RoundingMode;
    remarks: string | null;
  }>(
    `SELECT id, order_no::text AS order_no, order_name,
            order_date::text AS order_date, supplier_id, project_id,
            honorific, delivery_date, rounding_mode::text AS rounding_mode,
            remarks
       FROM purchase_orders
      WHERE id = $1::uuid
      FOR UPDATE`,
    [params.orderId],
  );
  const order = poRows[0];
  if (order === undefined) {
    throw new MasterDataError(404, 'PURCHASE_ORDER_NOT_FOUND', '対象の発注データが見つかりません。');
  }

  const issueDate =
    params.issueDate !== undefined && params.issueDate.trim() !== ''
      ? validateIssueDate(params.issueDate)
      : order.order_date.slice(0, 10);

  const lineRows = await tx.query<{
    line_no: number;
    product_id: string | null;
    item_code: string | null;
    item_name: string;
    unit_name: string | null;
    quantity: string;
    tax_code: TaxCode;
    applied_unit_price: string;
    remarks: string | null;
  }>(
    `SELECT line_no, product_id, item_code, item_name, unit_name,
            quantity::text AS quantity, tax_code,
            applied_unit_price::text AS applied_unit_price,
            remarks
       FROM purchase_order_lines
      WHERE order_id = $1::uuid
      ORDER BY line_no ASC`,
    [params.orderId],
  );

  const productIds = lineRows
    .map((l) => l.product_id)
    .filter((pid): pid is string => pid !== null);

  const ctx = await loadSnapshotCommonContext(tx, {
    tenantId: params.tenantId,
    partnerId: order.supplier_id,
    projectId: order.project_id,
    honorific: order.honorific,
    productIds,
  });

  let deliveryPlace: string | null = null;
  if (order.project_id !== null) {
    const siteRows = await tx.query<{ site_place: string | null }>(
      'SELECT site_place FROM projects WHERE id = $1::uuid LIMIT 1',
      [order.project_id],
    );
    if (siteRows[0] !== undefined && siteRows[0].site_place !== null && siteRows[0].site_place.trim() !== '') {
      deliveryPlace = siteRows[0].site_place.trim();
    }
  }

  const ver = await resolveNextVersionInfo(
    tx,
    'PURCHASE_ORDER',
    params.orderId,
    params.forceReissue === true,
  );
  const templateVariant: QuotationTemplateVariant =
    params.templateVariant !== undefined ? params.templateVariant : ctx.defaultTemplateVariant;

  const isHeadingList = lineRows.map((l) => {
    const prodMeta = l.product_id !== null ? ctx.productMap.get(l.product_id) : undefined;
    return (
      (prodMeta !== undefined && prodMeta.is_heading) ||
      (Number(l.quantity) === 0 &&
        Number(l.applied_unit_price) === 0 &&
        l.unit_name === null &&
        l.tax_code === 'C')
    );
  });

  const calc = calculateSalesSlip(
    lineRows.map((l, idx) => ({
      lineNo: Number(l.line_no),
      isHeading: Boolean(isHeadingList[idx]),
      quantity: l.quantity,
      appliedUnitPrice: BigInt(l.applied_unit_price),
      taxCode: l.tax_code,
    })),
    order.rounding_mode,
    ctx.tenantTaxCalcPolicy,
  );

  const orderNoNum = Number(order.order_no);
  const orderDateStr = order.order_date.slice(0, 10);

  const payload: DocumentSnapshotPayload = {
    schemaVersion: 1,
    documentType: 'PURCHASE_ORDER',
    templateVariant,
    documentNo: order.order_no,
    issueDate,
    isReissue: ver.isReissue,
    reissueLabel: ver.reissueLabel,
    issuer: ctx.issuer,
    recipient: ctx.recipient,
    header: {
      title: order.order_name,
      projectNo: ctx.projectNo,
      projectName: ctx.projectName,
      validityPeriod: null,
      deliveryDate: order.delivery_date,
      deliveryPlace,
      paymentDueDate: null,
      roundingMode: order.rounding_mode,
      taxCalcPolicy: ctx.tenantTaxCalcPolicy,
      costTaxMode: ctx.costTaxMode,
      subtotalAmount: Number(calc.subtotalAmount),
      taxTotal: Number(calc.taxTotal),
      taxAdjustmentAmount: 0,
      totalAmount: Number(calc.totalAmount),
      taxBreakdown: {
        rate10Excl: Number(calc.rate10Excl),
        rate10Tax: Number(calc.rate10Tax),
        rate8Excl: Number(calc.rate8Excl),
        rate8Tax: Number(calc.rate8Tax),
        nonTaxAmount: Number(calc.nonTax0),
      },
      showCarryover: false,
      mirrorSummary: null,
      remarks: order.remarks,
    },
    lines: lineRows.map((l, idx) => {
      const lr = calc.lineResults[idx];
      if (lr === undefined) {
        throw new MasterDataError(500, 'CALC_MISMATCH', 'スナップショット明細計算が不整合です。');
      }
      const isHeading = Boolean(isHeadingList[idx]);
      const prodMeta = l.product_id !== null ? ctx.productMap.get(l.product_id) : undefined;
      const capNum = prodMeta !== undefined ? Number(prodMeta.capacity) : 0;
      const capacityLabel = capNum > 0 ? String(capNum) : null;
      const tcRow = ctx.taxCodeMap.get(l.tax_code);

      return {
        lineNo: Number(l.line_no),
        sourceSlipNo: orderNoNum,
        sourceSlipDate: orderDateStr,
        advanceMark: null,
        itemCode: l.item_code,
        itemName: l.item_name,
        capacityLabel,
        unitName: l.unit_name,
        targetMonthLabel: null,
        isHeading,
        quantity: isHeading ? 0 : Number(l.quantity),
        appliedUnitPrice: isHeading ? 0 : Number(l.applied_unit_price),
        lineAmount: Number(lr.lineAmount),
        taxCode: l.tax_code,
        taxRate: tcRow !== undefined ? Number(tcRow.tax_rate) : Number(lr.taxRate.toString()),
        taxMarkSymbol: normalizeTaxMarkSymbol(tcRow?.mark_symbol, lr.taxMarkSymbol),
        isInternalTax: tcRow !== undefined ? tcRow.is_internal : lr.isInternalTax,
        lineTax: Number(lr.lineTax),
        rowTotal: Number(lr.rowTotal),
        remarks: l.remarks,
      };
    }),
    attachments: [],
  };

  return persistSnapshotDocument(tx, {
    tenantId: params.tenantId,
    employeeId: params.employeeId,
    sourceEntityType: 'PURCHASE_ORDER',
    sourceEntityId: params.orderId,
    versionNo: ver.versionNo,
    payload,
  });
}

export async function listEntitySnapshots(
  tx: DbExecutor,
  params: { documentType: DocumentType; sourceEntityId: string },
): Promise<SnapshotHistoryItemDto[]> {
  validateUuid(params.sourceEntityId, '対象伝票');
  const rows = await tx.query<SnapshotHistoryRow>(
    `SELECT s.id, s.document_type::text AS document_type, s.source_entity_type,
            s.source_entity_id, s.document_no, s.version_no, s.is_reissue,
            s.reissue_label, s.template_variant, s.issued_at::text AS issued_at,
            s.issued_by, e.syain_name AS issued_by_name, s.payload_sha256
       FROM document_snapshots s
       LEFT JOIN employees e ON e.tenant_id = s.tenant_id AND e.id = s.issued_by
      WHERE s.document_type = $1::document_type
        AND s.source_entity_id = $2::uuid
      ORDER BY s.version_no DESC`,
    [params.documentType, params.sourceEntityId],
  );
  return rows.map(mapSnapshotHistoryRow);
}

/**
 * 既存スナップショットの閲覧・PDF再出力時の機能フラグチェック（payload_json のみ使用し現行マスタ非参照）
 */
export async function assertSnapshotReadFeature(
  tx: DbExecutor,
  tenantId: string,
  payload: DocumentSnapshotPayload,
): Promise<void> {
  if (
    payload.documentType === 'ESTIMATE' ||
    payload.documentType === 'ESTIMATE_SUMMARY_COVER' ||
    payload.documentType === 'ESTIMATE_SUMMARY_DETAIL'
  ) {
    await requireFeature(tx, tenantId, 'estimate');
    return;
  }
  if (payload.documentType === 'PURCHASE_ORDER') {
    await requireFeature(tx, tenantId, 'order');
    return;
  }
  if (payload.documentType === 'DELIVERY_NOTE' || payload.documentType === 'DELIVERY_RECEIPT') {
    const isAdvance = payload.lines.some((l) => l.advanceMark === 'T') || payload.documentNo.startsWith('T-');
    await requireFeature(tx, tenantId, isAdvance ? 'tatekae' : 'sales');
    return;
  }
  if (BILLING_SNAPSHOT_DOCUMENT_TYPES.has(payload.documentType)) {
    await assertBillingSnapshotFeature(tx, tenantId, payload.documentType);
    return;
  }
  if (payload.documentType === 'RECEIPT') {
    const depOk = await isFeatureEnabled(tx, tenantId, 'deposit');
    if (depOk) return;
    await requireFeature(tx, tenantId, 'receivable');
  }
}

/**
 * 既存スナップショット詳細取得（現行マスタを一切参照しない）
 */
export async function getSnapshotById(
  tx: DbExecutor,
  snapshotId: string,
): Promise<SnapshotDetailDto> {
  validateUuid(snapshotId, 'スナップショット');
  const rows = await tx.query<SnapshotDetailRow>(
    `SELECT s.id, s.document_type::text AS document_type, s.source_entity_type,
            s.source_entity_id, s.document_no, s.version_no, s.is_reissue,
            s.reissue_label, s.template_variant, s.issued_at::text AS issued_at,
            s.issued_by, NULL::text AS issued_by_name, s.payload_json, s.payload_sha256
       FROM document_snapshots s
      WHERE s.id = $1::uuid
      LIMIT 1`,
    [snapshotId],
  );
  const row = rows[0];
  if (row === undefined) {
    throw new MasterDataError(404, 'SNAPSHOT_NOT_FOUND', '指定された帳票スナップショットが見つかりません。');
  }
  return {
    ...mapSnapshotHistoryRow(row),
    payloadJson: parseSnapshotPayload(row.payload_json),
  };
}

/**
 * 既存スナップショットIDからのPDF再出力用データ取得（現行マスタ非参照・保存済みpayload_jsonのみ使用）
 */
export async function loadSnapshotForPdf(
  tx: DbExecutor,
  tenantId: string,
  snapshotId: string,
): Promise<{
  payload: DocumentSnapshotPayload;
  documentNo: string;
  versionNo: number;
  documentType: DocumentType;
}> {
  validateUuid(snapshotId, 'スナップショット');
  const rows = await tx.query<{
    document_type: DocumentType;
    document_no: string;
    version_no: number;
    payload_json: unknown;
  }>(
    `SELECT document_type::text AS document_type, document_no, version_no, payload_json
       FROM document_snapshots
      WHERE id = $1::uuid
      LIMIT 1`,
    [snapshotId],
  );
  const row = rows[0];
  if (row === undefined) {
    throw new MasterDataError(404, 'SNAPSHOT_NOT_FOUND', '指定された帳票スナップショットが見つかりません。');
  }
  const payload = parseSnapshotPayload(row.payload_json);
  await assertSnapshotReadFeature(tx, tenantId, payload);
  return {
    payload,
    documentNo: row.document_no,
    versionNo: Number(row.version_no),
    documentType: row.document_type,
  };
}
