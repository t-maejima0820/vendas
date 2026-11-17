import { NextResponse } from 'next/server';
import { withApiHandler } from '@/lib/api/handler';
import { exportProjectLedgerPdf } from '@/lib/domain/pdf-exports';
import { MasterDataError } from '@/lib/masters/error-mapper';
import { exportProjectLedgerCsv } from '@/lib/projects/projects-service';

function extractProjectId(req: Request): string {
  const segments = new URL(req.url).pathname.split('/').filter((s) => s.length > 0);
  const id = segments[segments.length - 2];
  if (id === undefined || id.trim() === '') {
    throw new MasterDataError(400, 'INVALID_ID', '案件IDが指定されていません。');
  }
  return decodeURIComponent(id);
}

export const GET = withApiHandler({ requiredFeature: 'construction' }, async ({ req, user, tx }) => {
  const projectId = extractProjectId(req);
  const url = new URL(req.url);
  const format = url.searchParams.get('format') ?? 'pdf';
  const isInline = url.searchParams.get('inline') === '1';

  if (format !== 'csv' && format !== 'pdf') {
    throw new MasterDataError(400, 'INVALID_FORMAT', '出力形式は csv または pdf を指定してください。');
  }

  if (format === 'pdf') {
    const { pdfBytes, projectNo } = await exportProjectLedgerPdf(tx, user.tenantId, projectId);
    const filename = encodeURIComponent(`工事台帳_No${projectNo}.pdf`);
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

  const csv = await exportProjectLedgerCsv(tx, user.tenantId, projectId);
  const today = new Date().toISOString().slice(0, 10);
  const filename = encodeURIComponent(`工事台帳_${today}.csv`);
  return new NextResponse(csv, {
    status: 200,
    headers: {
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': `attachment; filename*=UTF-8''${filename}`,
      'Cache-Control': 'private, no-store',
    },
  });
});
