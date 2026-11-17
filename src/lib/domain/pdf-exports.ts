import {
  buildCustomAnalyticsPdfInput,
  type CustomAnalyticsFilter,
} from '@/lib/analytics/analytics-service';
import { buildBillingListPdfInput } from '@/lib/billing/billing-service';
import type { BillingExportTarget, BillingListFilter } from '@/lib/billing/types';
import type { DbExecutor } from '@/lib/db/tenant-client';
import {
  renderBillingDetailListPdf,
  renderBillingListPdf,
  renderBillingSimpleListPdf,
  renderCustomAnalyticsPdf,
  renderDocumentSnapshotPdf,
  renderEstimateListPdf,
  renderMailTargetListPdf,
  renderPayableListPdf,
  renderProjectCostListPdf,
  renderProjectLedgerPdf,
  renderProjectListPdf,
  renderPurchaseListPdf,
  renderPurchaseOrderListPdf,
  renderReceivableListPdf,
  renderSalesListPdf,
  renderSalesProductSummaryPdf,
  renderStockListPdf,
  renderSupplierPaymentListPdf,
} from '@/lib/domain/pdf-renderer';
import type { DocumentType } from '@/lib/domain/snapshots';
import {
  buildQuotationsListPdfInput,
  type QuotationListFilter,
} from '@/lib/estimates/estimates-service';
import { buildMailTargetsPdfInput } from '@/lib/mail/mail-service';
import {
  buildPayableBalancesPdfInput,
  buildSupplierPaymentsPdfInput,
} from '@/lib/payables/payables-service';
import type { PayableBalanceFilter, SupplierPaymentListFilter } from '@/lib/payables/types';
import {
  buildProjectCostsPdfInput,
  type ProjectCostListFilter,
} from '@/lib/project-costs/project-costs-service';
import {
  buildProjectLedgerPdfInput,
  buildProjectsPdfInput,
  type ProjectListFilter,
} from '@/lib/projects/projects-service';
import {
  buildPurchaseOrdersPdfInput,
  type PurchaseOrderListFilter,
} from '@/lib/purchasing/purchase-orders-service';
import {
  buildPurchasesPdfInput,
  type PurchaseListFilter,
} from '@/lib/purchasing/purchases-service';
import { buildReceivableBalancesPdfInput } from '@/lib/receivables/receivables-service';
import type { ReceivableBalanceFilter } from '@/lib/receivables/types';
import {
  buildSalesListPdfInput,
  buildSalesProductSummaryPdfInput,
  type SalesListFilter,
  type SalesProductSummaryFilter,
} from '@/lib/sales/sales-service';
import { loadSnapshotForPdf } from '@/lib/snapshots/snapshot-service';
import { buildStockPdfInput, type StockListFilter } from '@/lib/stock/stock-service';

export async function exportCustomAnalyticsPdf(
  tx: DbExecutor,
  tenantId: string,
  filter: CustomAnalyticsFilter = {},
): Promise<Uint8Array> {
  const input = await buildCustomAnalyticsPdfInput(tx, tenantId, filter);
  return renderCustomAnalyticsPdf(input);
}

export async function exportBillingListPdf(
  tx: DbExecutor,
  tenantId: string,
  target: BillingExportTarget,
  filter: BillingListFilter,
): Promise<Uint8Array> {
  const built = await buildBillingListPdfInput(tx, tenantId, target, filter);
  if (built.target === 'standard') {
    return renderBillingListPdf(built.input);
  }
  if (built.target === 'simple') {
    return renderBillingSimpleListPdf(built.input);
  }
  return renderBillingDetailListPdf(built.input);
}

export async function exportQuotationsListPdf(
  tx: DbExecutor,
  tenantId: string,
  filter: QuotationListFilter = {},
): Promise<Uint8Array> {
  const input = await buildQuotationsListPdfInput(tx, tenantId, filter);
  return renderEstimateListPdf(input);
}

export async function exportMailTargetsPdf(
  tx: DbExecutor,
  tenantId: string,
  filter: { keyword?: string | null; mailEnabledOnly?: boolean } = {},
): Promise<Uint8Array> {
  const input = await buildMailTargetsPdfInput(tx, tenantId, filter);
  return renderMailTargetListPdf(input);
}

export async function exportPayableBalancesPdf(
  tx: DbExecutor,
  tenantId: string,
  filter: PayableBalanceFilter,
): Promise<Uint8Array> {
  const input = await buildPayableBalancesPdfInput(tx, tenantId, filter);
  return renderPayableListPdf(input);
}

export async function exportSupplierPaymentsPdf(
  tx: DbExecutor,
  tenantId: string,
  filter: SupplierPaymentListFilter,
): Promise<Uint8Array> {
  const input = await buildSupplierPaymentsPdfInput(tx, tenantId, filter);
  return renderSupplierPaymentListPdf(input);
}

export async function exportProjectCostsPdf(
  tx: DbExecutor,
  tenantId: string,
  filter: ProjectCostListFilter,
): Promise<Uint8Array> {
  const input = await buildProjectCostsPdfInput(tx, tenantId, filter);
  return renderProjectCostListPdf(input);
}

export async function exportProjectsPdf(
  tx: DbExecutor,
  tenantId: string,
  filter: ProjectListFilter,
): Promise<Uint8Array> {
  const input = await buildProjectsPdfInput(tx, tenantId, filter);
  return renderProjectListPdf(input);
}

export async function exportProjectLedgerPdf(
  tx: DbExecutor,
  tenantId: string,
  projectId: string,
): Promise<{ pdfBytes: Uint8Array; projectNo: number }> {
  const built = await buildProjectLedgerPdfInput(tx, tenantId, projectId);
  const pdfBytes = await renderProjectLedgerPdf(built.input);
  return { pdfBytes, projectNo: built.projectNo };
}

export async function exportPurchaseOrdersPdf(
  tx: DbExecutor,
  tenantId: string,
  filter: PurchaseOrderListFilter,
): Promise<Uint8Array> {
  const input = await buildPurchaseOrdersPdfInput(tx, tenantId, filter);
  return renderPurchaseOrderListPdf(input);
}

export async function exportPurchasesPdf(
  tx: DbExecutor,
  tenantId: string,
  filter: PurchaseListFilter,
): Promise<Uint8Array> {
  const input = await buildPurchasesPdfInput(tx, tenantId, filter);
  return renderPurchaseListPdf(input);
}

export async function exportReceivableBalancesPdf(
  tx: DbExecutor,
  tenantId: string,
  filter: ReceivableBalanceFilter,
): Promise<Uint8Array> {
  const input = await buildReceivableBalancesPdfInput(tx, tenantId, filter);
  return renderReceivableListPdf(input);
}

export async function exportSalesListPdf(
  tx: DbExecutor,
  tenantId: string,
  filter: SalesListFilter,
): Promise<Uint8Array> {
  const input = await buildSalesListPdfInput(tx, tenantId, filter);
  return renderSalesListPdf(input);
}

export async function exportSalesProductSummaryPdf(
  tx: DbExecutor,
  tenantId: string,
  filter: SalesProductSummaryFilter = {},
): Promise<Uint8Array> {
  const input = await buildSalesProductSummaryPdfInput(tx, tenantId, filter);
  return renderSalesProductSummaryPdf(input);
}

export async function renderSnapshotPdfById(
  tx: DbExecutor,
  tenantId: string,
  snapshotId: string,
  encryptionKeyHex: string,
): Promise<{
  pdfBytes: Uint8Array;
  documentNo: string;
  versionNo: number;
  documentType: DocumentType;
}> {
  const loaded = await loadSnapshotForPdf(tx, tenantId, snapshotId);
  const pdfBytes = await renderDocumentSnapshotPdf(loaded.payload, encryptionKeyHex);
  return {
    pdfBytes,
    documentNo: loaded.documentNo,
    versionNo: loaded.versionNo,
    documentType: loaded.documentType,
  };
}

export async function exportStockPdf(
  tx: DbExecutor,
  tenantId: string,
  filter: StockListFilter = {},
): Promise<Uint8Array> {
  const input = await buildStockPdfInput(tx, tenantId, filter);
  return renderStockListPdf(input);
}
