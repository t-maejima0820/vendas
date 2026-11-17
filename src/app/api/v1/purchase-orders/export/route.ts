import { NextResponse } from 'next/server';
import { withApiHandler } from '@/lib/api/handler';
import { MasterDataError } from '@/lib/masters/error-mapper';
import {
  exportPurchaseOrdersCsv,
  exportPurchaseOrdersPdf,
} from '@/lib/purchasing/purchase-orders-service';
import type { OrderStatus } from '@/lib/purchasing/types';

export const GET = withApiHandler({ requiredFeature: 'order' }, async ({ req, user, tx }) => {
  const url = new URL(req.url);
  const format = url.searchParams.get('format') ?? 'csv';
  const isInline = url.searchParams.get('inline') === '1';

  if (format !== 'csv' && format !== 'pdf') {
    throw new MasterDataError(400, 'INVALID_FORMAT', '出力形式は csv または pdf を指定してください。');
  }

  const statusRaw = url.searchParams.get('status');
  const status =
    statusRaw === 'O1' || statusRaw === 'O2' || statusRaw === 'O3'
      ? (statusRaw as OrderStatus)
      : null;

  const filter = {
    keyword: url.searchParams.get('keyword'),
    supplierId: url.searchParams.get('supplierId'),
    projectId: url.searchParams.get('projectId'),
    status,
    dateFrom: url.searchParams.get('dateFrom'),
    dateTo: url.searchParams.get('dateTo'),
  };

  const today = new Date().toISOString().slice(0, 10);

  if (format === 'pdf') {
    const pdfBytes = await exportPurchaseOrdersPdf(tx, user.tenantId, filter);
    const filename = encodeURIComponent(`発注一覧_${today}.pdf`);
    const disposition = isInline ? 'inline' : 'attachment';
    return new NextResponse(Buffer.from(pdfBytes), {
      status: 200,
      headers: {
        'Content-Type': 'application/pdf',
        'Content-Disposition': `${disposition}; filename*=UTF-8''${filename}`,
        'Cache-Control': 'private, no-store',
      },
    });
  }

  const csv = await exportPurchaseOrdersCsv(tx, user.tenantId, filter);
  const filename = encodeURIComponent(`発注一覧_${today}.csv`);
  return new NextResponse(csv, {
    status: 200,
    headers: {
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': `attachment; filename*=UTF-8''${filename}`,
      'Cache-Control': 'private, no-store',
    },
  });
});
