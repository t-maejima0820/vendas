import { NextResponse } from 'next/server';
import { withApiHandler } from '@/lib/api/handler';
import { renderSnapshotPdfById } from '@/lib/domain/pdf-exports';
import type { DocumentType } from '@/lib/domain/snapshots';
import { requireEnv } from '@/lib/env';
import { MasterDataError } from '@/lib/masters/error-mapper';

function extractSnapshotIdFromPdfPath(req: Request): string {
  const segments = new URL(req.url).pathname.split('/').filter((s) => s.length > 0);
  const id = segments[segments.length - 2];
  if (id === undefined || id.trim() === '') {
    throw new MasterDataError(400, 'INVALID_ID', 'スナップショットIDが指定されていません。');
  }
  return decodeURIComponent(id);
}

function getDocumentFilenamePrefix(docType: DocumentType): string {
  switch (docType) {
    case 'PURCHASE_ORDER':
      return '発注書';
    case 'DELIVERY_NOTE':
      return '納品書';
    case 'DELIVERY_RECEIPT':
      return '受領書';
    case 'INVOICE':
      return '請求書';
    case 'INVOICE_STANDALONE':
      return '単独請求書';
    case 'INVOICE_COVER':
      return '請求書鏡';
    case 'INVOICE_COVER_MEMO_SUM':
      return '請求書鏡_備考集約';
    case 'INVOICE_COVER_DETAIL':
      return '請求明細書';
    case 'FIXED_INVOICE':
      return '定額請求書';
    case 'RECEIPT':
      return '領収書';
    case 'ESTIMATE_SUMMARY_COVER':
      return 'まとめ見積書鑑';
    case 'ESTIMATE_SUMMARY_DETAIL':
      return 'まとめ見積明細書';
    case 'ESTIMATE':
    default:
      return '見積書';
  }
}

export const GET = withApiHandler({}, async ({ req, user, tx }) => {
  const snapshotId = extractSnapshotIdFromPdfPath(req);
  const url = new URL(req.url);
  const isDownload = url.searchParams.get('download') === '1';

  const encKeyHex = requireEnv('FIELD_ENCRYPTION_KEY_HEX');
  const result = await renderSnapshotPdfById(tx, user.tenantId, snapshotId, encKeyHex);

  const prefix = getDocumentFilenamePrefix(result.documentType);
  const filename = encodeURIComponent(`${prefix}_No${result.documentNo}_v${result.versionNo}.pdf`);
  const disposition = isDownload ? 'attachment' : 'inline';

  return new NextResponse(Buffer.from(result.pdfBytes), {
    status: 200,
    headers: {
      'Content-Type': 'application/pdf',
      'Content-Disposition': `${disposition}; filename*=UTF-8''${filename}`,
      'Cache-Control': 'private, no-store',
    },
  });
});
