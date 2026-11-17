import { NextResponse } from 'next/server';
import { withApiHandler } from '@/lib/api/handler';
import { MasterDataError } from '@/lib/masters/error-mapper';
import { parsePayableBalanceFilterFromUrl } from '@/lib/payables/payload-parser';
import {
  exportPayableBalancesCsv,
  exportPayableBalancesPdf,
} from '@/lib/payables/payables-service';

export const GET = withApiHandler({ requiredFeature: 'payable' }, async ({ req, user, tx }) => {
  const url = new URL(req.url);
  const format = url.searchParams.get('format') ?? 'csv';
  const isInline = url.searchParams.get('inline') === '1';

  if (format !== 'csv' && format !== 'pdf') {
    throw new MasterDataError(400, 'INVALID_FORMAT', '出力形式は csv または pdf を指定してください。');
  }

  const filter = parsePayableBalanceFilterFromUrl(url);
  const today = new Date().toISOString().slice(0, 10);

  if (format === 'pdf') {
    const pdfBytes = await exportPayableBalancesPdf(tx, user.tenantId, filter);
    const filename = encodeURIComponent(`買掛一覧_${today}.pdf`);
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

  const csv = await exportPayableBalancesCsv(tx, user.tenantId, filter);
  const filename = encodeURIComponent(`買掛一覧_${today}.csv`);
  return new NextResponse(csv, {
    status: 200,
    headers: {
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': `attachment; filename*=UTF-8''${filename}`,
      'Cache-Control': 'private, no-store',
    },
  });
});
