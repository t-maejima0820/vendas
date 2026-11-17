import { NextResponse } from 'next/server';
import { withApiHandler } from '@/lib/api/handler';
import { exportMailTargetsPdf } from '@/lib/domain/pdf-exports';
import { exportMailTargetsCsv } from '@/lib/mail/mail-service';
import { MasterDataError } from '@/lib/masters/error-mapper';

export const GET = withApiHandler({ requiredFeature: 'mail' }, async ({ req, user, tx }) => {
  const url = new URL(req.url);
  const format = url.searchParams.get('format') ?? 'csv';
  const isInline = url.searchParams.get('inline') === '1';

  if (format !== 'csv' && format !== 'pdf') {
    throw new MasterDataError(400, 'INVALID_FORMAT', '出力形式は csv または pdf を指定してください。');
  }

  const filter = {
    keyword: url.searchParams.get('keyword'),
    mailEnabledOnly: url.searchParams.get('mailEnabledOnly') === '1',
  };
  const today = new Date().toISOString().slice(0, 10);

  if (format === 'pdf') {
    const pdfBytes = await exportMailTargetsPdf(tx, user.tenantId, filter);
    const filename = encodeURIComponent(`メール送付対象一覧_${today}.pdf`);
    return new NextResponse(Buffer.from(pdfBytes), {
      status: 200,
      headers: {
        'Content-Type': 'application/pdf',
        'Content-Disposition': `${isInline ? 'inline' : 'attachment'}; filename*=UTF-8''${filename}`,
        'Cache-Control': 'private, no-store',
      },
    });
  }

  const csv = await exportMailTargetsCsv(tx, user.tenantId, filter);
  const filename = encodeURIComponent(`メール送付対象一覧_${today}.csv`);
  return new NextResponse(csv, {
    status: 200,
    headers: {
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': `attachment; filename*=UTF-8''${filename}`,
      'Cache-Control': 'private, no-store',
    },
  });
});
