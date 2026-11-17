import { NextResponse } from 'next/server';
import { withApiHandler } from '@/lib/api/handler';
import { MasterDataError } from '@/lib/masters/error-mapper';
import {
  exportSupplierPaymentsCsv,
  exportSupplierPaymentsPdf,
} from '@/lib/payables/payables-service';

export const GET = withApiHandler({ requiredFeature: 'payment' }, async ({ req, user, tx }) => {
  const url = new URL(req.url);
  const format = url.searchParams.get('format') ?? 'csv';
  const isInline = url.searchParams.get('inline') === '1';

  if (format !== 'csv' && format !== 'pdf') {
    throw new MasterDataError(400, 'INVALID_FORMAT', '出力形式は csv または pdf を指定してください。');
  }

  const filter = {
    keyword: url.searchParams.get('q'),
    supplierId: url.searchParams.get('supplierId'),
    dateFrom: url.searchParams.get('dateFrom'),
    dateTo: url.searchParams.get('dateTo'),
    billNo: url.searchParams.get('billNo'),
  };

  const today = new Date().toISOString().slice(0, 10);

  if (format === 'pdf') {
    const pdfBytes = await exportSupplierPaymentsPdf(tx, user.tenantId, filter);
    const filename = encodeURIComponent(`支払一覧_${today}.pdf`);
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

  const csv = await exportSupplierPaymentsCsv(tx, user.tenantId, filter);
  const filename = encodeURIComponent(`支払一覧_${today}.csv`);
  return new NextResponse(csv, {
    status: 200,
    headers: {
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': `attachment; filename*=UTF-8''${filename}`,
      'Cache-Control': 'private, no-store',
    },
  });
});
