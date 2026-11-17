import { NextResponse } from 'next/server';
import { withApiHandler } from '@/lib/api/handler';
import { withBillingTransition } from '@/lib/db/tenant-client';
import type { DocumentType } from '@/lib/domain/snapshots';
import type { QuotationTemplateVariant } from '@/lib/estimates/types';
import { isFeatureEnabled, requireFeature } from '@/lib/feature-flags/gate';
import { MasterDataError, parseMasterJsonBody } from '@/lib/masters/error-mapper';
import {
  BILLING_SNAPSHOT_DOCUMENT_TYPES,
  type BillingSnapshotDocumentType,
  issueBillingSnapshot,
  issuePurchaseOrderSnapshot,
  issueQuotationSnapshot,
  issueReceiptSnapshot,
  issueSalesSnapshot,
  listEntitySnapshots,
} from '@/lib/snapshots/snapshot-service';

const SUPPORTED_TYPES = new Set<DocumentType>([
  'ESTIMATE',
  'ESTIMATE_SUMMARY_COVER',
  'ESTIMATE_SUMMARY_DETAIL',
  'PURCHASE_ORDER',
  'DELIVERY_NOTE',
  'DELIVERY_RECEIPT',
  'INVOICE',
  'INVOICE_STANDALONE',
  'INVOICE_COVER',
  'INVOICE_COVER_MEMO_SUM',
  'INVOICE_COVER_DETAIL',
  'FIXED_INVOICE',
  'RECEIPT',
]);

export const GET = withApiHandler({}, async ({ req, user, tx }) => {
  const url = new URL(req.url);
  const rawType = (url.searchParams.get('documentType') ?? 'ESTIMATE') as DocumentType;
  const sourceEntityId = url.searchParams.get('sourceEntityId') ?? '';

  if (!SUPPORTED_TYPES.has(rawType)) {
    throw new MasterDataError(
      400,
      'UNSUPPORTED_DOCUMENT_TYPE',
      '指定された帳票種別には対応していません。',
    );
  }

  if (
    rawType === 'ESTIMATE' ||
    rawType === 'ESTIMATE_SUMMARY_COVER' ||
    rawType === 'ESTIMATE_SUMMARY_DETAIL'
  ) {
    await requireFeature(tx, user.tenantId, 'estimate');
  } else if (rawType === 'PURCHASE_ORDER') {
    await requireFeature(tx, user.tenantId, 'order');
  } else if (rawType === 'DELIVERY_NOTE' || rawType === 'DELIVERY_RECEIPT') {
    const shRows = await tx.query<{ entry_type: 'SALE' | 'ADVANCE' }>(
      'SELECT entry_type::text AS entry_type FROM sales_headers WHERE id = $1::uuid LIMIT 1',
      [sourceEntityId],
    );
    const entryType = shRows[0]?.entry_type;
    await requireFeature(tx, user.tenantId, entryType === 'ADVANCE' ? 'tatekae' : 'sales');
  } else if (rawType === 'RECEIPT') {
    const depOk = await isFeatureEnabled(tx, user.tenantId, 'deposit');
    if (!depOk) {
      await requireFeature(tx, user.tenantId, 'receivable');
    }
  } else if (rawType === 'FIXED_INVOICE') {
    const fixedOk = await isFeatureEnabled(tx, user.tenantId, 'fixedbill');
    if (!fixedOk) {
      await requireFeature(tx, user.tenantId, 'billissue');
    }
  } else {
    await requireFeature(tx, user.tenantId, 'billissue');
  }

  const items = await listEntitySnapshots(tx, {
    documentType: rawType,
    sourceEntityId,
  });
  return NextResponse.json({ ok: true, items });
});

export const POST = withApiHandler({}, async ({ req, user, tx }) => {
  const body = await parseMasterJsonBody<{
    documentType?: unknown;
    sourceEntityId?: unknown;
    templateVariant?: unknown;
    issueDate?: unknown;
  }>(req);

  const rawType = (typeof body.documentType === 'string' ? body.documentType : 'ESTIMATE') as DocumentType;
  if (!SUPPORTED_TYPES.has(rawType)) {
    throw new MasterDataError(
      400,
      'UNSUPPORTED_DOCUMENT_TYPE',
      '指定された帳票種別には対応していません。',
    );
  }

  const sourceEntityId = typeof body.sourceEntityId === 'string' ? body.sourceEntityId : '';
  let templateVariant: QuotationTemplateVariant | undefined;
  if (body.templateVariant === '10_ROWS' || body.templateVariant === '20_ROWS') {
    templateVariant = body.templateVariant;
  } else if (body.templateVariant !== undefined && body.templateVariant !== null) {
    throw new MasterDataError(
      400,
      'INVALID_TEMPLATE_VARIANT',
      'templateVariant は 10_ROWS または 20_ROWS を指定してください。',
    );
  }

  const issueDate = typeof body.issueDate === 'string' ? body.issueDate : undefined;

  if (
    rawType === 'ESTIMATE' ||
    rawType === 'ESTIMATE_SUMMARY_COVER' ||
    rawType === 'ESTIMATE_SUMMARY_DETAIL'
  ) {
    const item = await issueQuotationSnapshot(tx, {
      tenantId: user.tenantId,
      employeeId: user.employeeId,
      quotationId: sourceEntityId,
      documentType: rawType,
      templateVariant,
      issueDate,
    });
    return NextResponse.json({ ok: true, item }, { status: 201 });
  }

  if (rawType === 'PURCHASE_ORDER') {
    const item = await issuePurchaseOrderSnapshot(tx, {
      tenantId: user.tenantId,
      employeeId: user.employeeId,
      orderId: sourceEntityId,
      templateVariant,
      issueDate,
    });
    return NextResponse.json({ ok: true, item }, { status: 201 });
  }

  if (BILLING_SNAPSHOT_DOCUMENT_TYPES.has(rawType)) {
    const item = await issueBillingSnapshot(tx, {
      tenantId: user.tenantId,
      employeeId: user.employeeId,
      billingId: sourceEntityId,
      documentType: rawType as BillingSnapshotDocumentType,
      templateVariant,
      issueDate,
    });
    if (item.isReissue) {
      await withBillingTransition(tx, async () => {
        await tx.query(
          `UPDATE sales_headers
              SET status = 'K5'::sales_status,
                  updated_by = $2::uuid
            WHERE billing_id = $1::uuid`,
          [sourceEntityId, user.employeeId],
        );
      });
    }
    return NextResponse.json({ ok: true, item }, { status: 201 });
  }

  if (rawType === 'RECEIPT') {
    const item = await issueReceiptSnapshot(tx, {
      tenantId: user.tenantId,
      employeeId: user.employeeId,
      receiptId: sourceEntityId,
      templateVariant,
      issueDate,
    });
    return NextResponse.json({ ok: true, item }, { status: 201 });
  }

  const item = await issueSalesSnapshot(tx, {
    tenantId: user.tenantId,
    employeeId: user.employeeId,
    salesHeaderId: sourceEntityId,
    documentType: rawType as 'DELIVERY_NOTE' | 'DELIVERY_RECEIPT',
    templateVariant,
    issueDate,
  });
  return NextResponse.json({ ok: true, item }, { status: 201 });
});
