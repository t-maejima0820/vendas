import Link from 'next/link';
import EmployeesClient from '@/app/(dashboard)/masters/employees/EmployeesClient';
import { runWithPageSession } from '@/lib/auth/page-session';
import { listEmployees } from '@/lib/masters/employees-service';
import { getMasterLookups } from '@/lib/masters/lookups-service';

export default async function EmployeesPage() {
  const data = await runWithPageSession(async ({ user, tx }) => {
    if (!user.isAdmin) {
      return { authorized: false as const };
    }
    const [items, lookups] = await Promise.all([
      listEmployees(tx, { includeRetired: true }),
      getMasterLookups(tx),
    ]);
    return {
      authorized: true as const,
      items,
      genders: lookups.genders,
      currentEmployeeId: user.employeeId,
    };
  });

  if (!data.authorized) {
    return (
      <div className="max-w-xl rounded-xl bg-white border border-red-200 p-6 shadow-xs">
        <h1 className="text-lg font-bold text-red-700">アクセス権限がありません（403）</h1>
        <p className="text-sm text-slate-600 mt-2">
          社員マスタの閲覧およびアカウント管理は管理者権限を持つ社員のみアクセスできます。
        </p>
        <Link
          href="/masters"
          className="inline-block mt-4 text-sm font-medium text-blue-600 hover:underline"
        >
          ← マスタ管理ハブに戻る
        </Link>
      </div>
    );
  }

  return (
    <EmployeesClient
      initialItems={data.items}
      genders={data.genders}
      currentEmployeeId={data.currentEmployeeId}
    />
  );
}
