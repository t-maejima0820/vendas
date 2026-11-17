import { NextResponse } from 'next/server';
import { withApiHandler } from '@/lib/api/handler';
import { exportBillingListCsv } from '@/lib/billing/billing-service';
import { parseBillingListFilterFromUrl } from '@/lib/billing/payload-parser';
import type { BillingExportTarget } from '@/lib/billing/types';
import { exportBillingListPdf } from '@/lib/domain/pdf-exports';
import { MasterDataError } from '@/lib/masters/error-mapper';

function getExportLabel(target: BillingExportTarget): string {
  switch (target) {
    case 'simple':
      return '請求一覧_簡易';
    case 'detail':
      return '請求一覧_詳細';
    case 'standard':
    default:
      return '請求一覧';
  }
}

export const GET = withApiHandler({}, async ({ req, user, tx }) => {
  const url = new URL(req.url);
  const rawTarget = url.searchParams.get('target');
  const target: BillingExportTarget =
    rawTarget === 'simple' || rawTarget === 'detail' ? rawTarget : 'standard';
  const format = url.searchParams.get('format') ?? 'csv';
  const isInline = url.searchParams.get('inline') === '1';

  if (format !== 'csv' && format !== 'pdf') {
    throw new MasterDataError(400, 'INVALID_FORMAT', '出力形式は csv または pdf を指定してください。');
  }

  const filter = parseBillingListFilterFromUrl(url);
  const today = new Date().toISOString().slice(0, 10);
  const label = getExportLabel(target);

  if (format === 'pdf') {
    const pdfBytes = await exportBillingListPdf(tx, user.tenantId, target, filter);
    const filename = encodeURIComponent(`${label}_${today}.pdf`);
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

  const csv = await exportBillingListCsv(tx, user.tenantId, target, filter);
  const filename = encodeURIComponent(`${label}_${today}.csv`);
  return new NextResponse(csv, {
    status: 200,
    headers: {
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': `attachment; filename*=UTF-8''${filename}`,
      'Cache-Control': 'private, no-store',
    },
  });
});
