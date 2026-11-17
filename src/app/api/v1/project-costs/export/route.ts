import { NextResponse } from 'next/server';
import { withApiHandler } from '@/lib/api/handler';
import type { CostCategory } from '@/lib/domain/calculations';
import { exportProjectCostsPdf } from '@/lib/domain/pdf-exports';
import { MasterDataError } from '@/lib/masters/error-mapper';
import { exportProjectCostsCsv } from '@/lib/project-costs/project-costs-service';
import type { ProjectStatus } from '@/lib/projects/types';

function parseCategory(raw: string | null): CostCategory | null {
  if (
    raw === 'EXPENSE' ||
    raw === 'LABOR' ||
    raw === 'MATERIAL' ||
    raw === 'OUTSOURCING' ||
    raw === 'TEMPORARY' ||
    raw === 'INDIRECT'
  ) {
    return raw;
  }
  return null;
}

export const GET = withApiHandler({ requiredFeature: 'cost' }, async ({ req, user, tx }) => {
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
    projectId: url.searchParams.get('projectId'),
    costCategory: parseCategory(url.searchParams.get('costCategory')),
    status,
    dateFrom: url.searchParams.get('dateFrom'),
    dateTo: url.searchParams.get('dateTo'),
    keyword: url.searchParams.get('keyword'),
  };

  const today = new Date().toISOString().slice(0, 10);

  if (format === 'pdf') {
    const pdfBytes = await exportProjectCostsPdf(tx, user.tenantId, filter);
    const filename = encodeURIComponent(`原価一覧_${today}.pdf`);
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

  const csv = await exportProjectCostsCsv(tx, user.tenantId, filter);
  const filename = encodeURIComponent(`原価一覧_${today}.csv`);
  return new NextResponse(csv, {
    status: 200,
    headers: {
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': `attachment; filename*=UTF-8''${filename}`,
      'Cache-Control': 'private, no-store',
    },
  });
});
