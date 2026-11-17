export default function DashboardLoading() {
  return (
    <div className="space-y-4 animate-pulse" aria-busy="true" aria-label="画面を読み込んでいます">
      <div className="flex items-center justify-between">
        <div className="space-y-2">
          <div className="h-6 w-56 rounded bg-slate-200" />
          <div className="h-3.5 w-80 rounded bg-slate-200/80" />
        </div>
        <div className="h-9 w-32 rounded-lg bg-slate-200" />
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
        <div className="h-28 rounded-xl border border-slate-200 bg-white p-4 space-y-3">
          <div className="h-3.5 w-24 rounded bg-slate-200" />
          <div className="h-7 w-32 rounded bg-slate-200" />
        </div>
        <div className="h-28 rounded-xl border border-slate-200 bg-white p-4 space-y-3">
          <div className="h-3.5 w-24 rounded bg-slate-200" />
          <div className="h-7 w-32 rounded bg-slate-200" />
        </div>
        <div className="h-28 rounded-xl border border-slate-200 bg-white p-4 space-y-3">
          <div className="h-3.5 w-24 rounded bg-slate-200" />
          <div className="h-7 w-32 rounded bg-slate-200" />
        </div>
        <div className="h-28 rounded-xl border border-slate-200 bg-white p-4 space-y-3">
          <div className="h-3.5 w-24 rounded bg-slate-200" />
          <div className="h-7 w-32 rounded bg-slate-200" />
        </div>
      </div>

      <div className="rounded-xl border border-slate-200 bg-white p-5 space-y-3">
        <div className="h-4 w-44 rounded bg-slate-200" />
        <div className="h-10 w-full rounded bg-slate-100" />
        <div className="h-10 w-full rounded bg-slate-100" />
        <div className="h-10 w-full rounded bg-slate-100" />
        <div className="h-10 w-full rounded bg-slate-100" />
      </div>
    </div>
  );
}
