import { NextResponse } from 'next/server';
import { withApiHandler } from '@/lib/api/handler';
import { exportProjectsPdf } from '@/lib/domain/pdf-exports';
import { MasterDataError } from '@/lib/masters/error-mapper';
import { exportProjectsCsv } from '@/lib/projects/projects-service';
import type { ProjectStatus } from '@/lib/projects/types';

export const GET = withApiHandler({ requiredFeature: 'construction' }, async ({ req, user, tx }) => {
  const url = new URL(req.url);
  const format = url.searchParams.get('format') ?? 'csv';
  const isInline = url.searchParams.get('inline') === '1';

  if (format !== 'csv' && format !== 'pdf') {
    throw new MasterDataError(400, 'INVALID_FORMAT', '出力形式は csv または pdf を指定してください。');
  }

  const statusRaw = url.searchParams.get('status');
  const status =
    statusRaw === 'C1' || statusRaw === 'C2' || statusRaw === 'C3'
      ? (statusRaw as ProjectStatus)
      : null;

  const filter = {
    keyword: url.searchParams.get('keyword'),
    status,
    orderKindCode: url.searchParams.get('orderKindCode'),
    employeeId: url.searchParams.get('employeeId'),
    dateFrom: url.searchParams.get('dateFrom'),
    dateTo: url.searchParams.get('dateTo'),
    overBudgetOnly: url.searchParams.get('overBudgetOnly') === '1',
  };

  const today = new Date().toISOString().slice(0, 10);

  if (format === 'pdf') {
    const pdfBytes = await exportProjectsPdf(tx, user.tenantId, filter);
    const filename = encodeURIComponent(`工事一覧_${today}.pdf`);
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

  const csv = await exportProjectsCsv(tx, user.tenantId, filter);
  const filename = encodeURIComponent(`工事一覧_${today}.csv`);
  return new NextResponse(csv, {
    status: 200,
    headers: {
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': `attachment; filename*=UTF-8''${filename}`,
      'Cache-Control': 'private, no-store',
    },
  });
});
