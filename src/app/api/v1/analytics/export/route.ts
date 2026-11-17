import { NextResponse } from 'next/server';
import {
  type AnalyticsDimension,
  exportCustomAnalyticsCsv,
  exportCustomAnalyticsPdf,
} from '@/lib/analytics/analytics-service';
import { withApiHandler } from '@/lib/api/handler';
import { MasterDataError } from '@/lib/masters/error-mapper';

function parseDimension(raw: string | null): AnalyticsDimension {
  if (raw === 'PARTNER' || raw === 'CATEGORY' || raw === 'EMPLOYEE' || raw === 'PERIOD') {
    return raw;
  }
  return 'PARTNER';
}

export const GET = withApiHandler({}, async ({ req, user, tx }) => {
  const url = new URL(req.url);
  const format = url.searchParams.get('format') ?? 'csv';
  const isInline = url.searchParams.get('inline') === '1';

  if (format !== 'csv' && format !== 'pdf') {
    throw new MasterDataError(400, 'INVALID_FORMAT', '出力形式は csv または pdf を指定してください。');
  }

  const dimension = parseDimension(url.searchParams.get('dimension'));
  const filter = {
    dimension,
    dateFrom: url.searchParams.get('dateFrom'),
    dateTo: url.searchParams.get('dateTo'),
    keyword: url.searchParams.get('keyword'),
  };
  const today = new Date().toISOString().slice(0, 10);

  if (format === 'pdf') {
    const pdfBytes = await exportCustomAnalyticsPdf(tx, user.tenantId, filter);
    const filename = encodeURIComponent(`カスタム集計_${dimension}_${today}.pdf`);
    return new NextResponse(Buffer.from(pdfBytes), {
      status: 200,
      headers: {
        'Content-Type': 'application/pdf',
        'Content-Disposition': `${isInline ? 'inline' : 'attachment'}; filename*=UTF-8''${filename}`,
        'Cache-Control': 'private, no-store',
      },
    });
  }

  const csv = await exportCustomAnalyticsCsv(tx, user.tenantId, filter);
  const filename = encodeURIComponent(`カスタム集計_${dimension}_${today}.csv`);
  return new NextResponse(csv, {
    status: 200,
    headers: {
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': `attachment; filename*=UTF-8''${filename}`,
      'Cache-Control': 'private, no-store',
    },
  });
});
