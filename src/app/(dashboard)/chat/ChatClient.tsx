'use client';

import Link from 'next/link';
import { useMemo, useState } from 'react';
import {
  buildTeamsAdaptiveCardPayload,
  type ChatLookupsDto,
  type ChatPageDto,
  type ChatThreadDto,
} from '@/lib/chat/types';
import { normalizeNullableText, requestMasterApi } from '@/lib/masters/client-api';

interface ChatClientProps {
  lookups: ChatLookupsDto;
  initialPage: ChatPageDto;
  initialRoom: string;
  initialProjectId: string;
  initialUnresolvedOnly: boolean;
}

export default function ChatClient({
  lookups,
  initialPage,
  initialRoom,
  initialProjectId,
  initialUnresolvedOnly,
}: ChatClientProps) {
  const [pageData, setPageData] = useState<ChatPageDto>(initialPage);
  const [roomFilter, setRoomFilter] = useState(initialRoom);
  const [projectFilter, setProjectFilter] = useState(initialProjectId);
  const [partnerFilter, setPartnerFilter] = useState('');
  const [keyword, setKeyword] = useState('');
  const [unresolvedOnly, setUnresolvedOnly] = useState(initialUnresolvedOnly);
  const [dateFrom, setDateFrom] = useState('');
  const [dateTo, setDateTo] = useState('');
  const [loading, setLoading] = useState(false);
  const [message, setMessage] = useState<{ type: 'success' | 'error'; text: string } | null>(null);

  const [selectedId, setSelectedId] = useState<string>(
    initialPage.items.length > 0 ? initialPage.items[0]!.id : '',
  );
  const [replyDraft, setReplyDraft] = useState('');
  const [postingReply, setPostingReply] = useState(false);

  // New Thread Modal
  const [newOpen, setNewOpen] = useState(false);
  const [newRoomName, setNewRoomName] = useState('全社連絡');
  const [customRoomName, setCustomRoomName] = useState('');
  const [newProjectId, setNewProjectId] = useState('');
  const [newPartnerId, setNewPartnerId] = useState('');
  const [newQuestion, setNewQuestion] = useState('');
  const [creating, setCreating] = useState(false);

  // Teams Adaptive Card Preview Modal
  const [cardThread, setCardThread] = useState<ChatThreadDto | null>(null);

  const selectedThread = useMemo(() => {
    const found = pageData.items.find((i) => i.id === selectedId);
    return found !== undefined ? found : pageData.items.length > 0 ? pageData.items[0] : undefined;
  }, [pageData.items, selectedId]);

  const cardJsonText = useMemo(() => {
    if (cardThread === null) return '';
    return JSON.stringify(buildTeamsAdaptiveCardPayload(lookups.companyName, cardThread), null, 2);
  }, [cardThread, lookups.companyName]);

  async function fetchThreads(overrides?: {
    roomName?: string;
    projectId?: string;
    partnerId?: string;
    unresolvedOnly?: boolean;
    keyword?: string;
    dateFrom?: string;
    dateTo?: string;
  }) {
    setLoading(true);
    setMessage(null);
    const r = overrides?.roomName !== undefined ? overrides.roomName : roomFilter;
    const pj = overrides?.projectId !== undefined ? overrides.projectId : projectFilter;
    const bp = overrides?.partnerId !== undefined ? overrides.partnerId : partnerFilter;
    const unres =
      overrides?.unresolvedOnly !== undefined ? overrides.unresolvedOnly : unresolvedOnly;
    const kw = overrides?.keyword !== undefined ? overrides.keyword : keyword;
    const df = overrides?.dateFrom !== undefined ? overrides.dateFrom : dateFrom;
    const dt = overrides?.dateTo !== undefined ? overrides.dateTo : dateTo;

    const qs = new URLSearchParams();
    if (r !== '') qs.set('roomName', r);
    if (pj !== '') qs.set('projectId', pj);
    if (bp !== '') qs.set('partnerId', bp);
    if (unres) qs.set('unresolvedOnly', '1');
    if (kw.trim() !== '') qs.set('keyword', kw.trim());
    if (df !== '') qs.set('dateFrom', df);
    if (dt !== '') qs.set('dateTo', dt);

    const res = await requestMasterApi<ChatPageDto & { ok: true }>(
      `/api/v1/chat?${qs.toString()}`,
    );
    setLoading(false);
    if (!res.ok) {
      setMessage({ type: 'error', text: res.error });
      return;
    }
    setPageData(res.data);
    if (res.data.items.length > 0 && !res.data.items.some((i) => i.id === selectedId)) {
      setSelectedId(res.data.items[0]!.id);
    }
  }

  async function handleSelectRoom(room: string) {
    setRoomFilter(room);
    await fetchThreads({ roomName: room });
  }

  async function handleCreateSubmit(e: React.FormEvent) {
    e.preventDefault();
    setCreating(true);
    setMessage(null);

    const resolvedRoom =
      newRoomName === '__CUSTOM__' ? customRoomName.trim() : newRoomName;

    const res = await requestMasterApi<{ ok: true; item: ChatThreadDto }>('/api/v1/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        roomName: resolvedRoom === '' ? '全社連絡' : resolvedRoom,
        projectId: normalizeNullableText(newProjectId),
        partnerId: normalizeNullableText(newPartnerId),
        question: newQuestion.trim(),
      }),
    });
    setCreating(false);
    if (!res.ok) {
      setMessage({ type: 'error', text: res.error });
      return;
    }

    setNewOpen(false);
    setNewQuestion('');
    setNewProjectId('');
    setNewPartnerId('');
    setSelectedId(res.data.item.id);
    setMessage({ type: 'success', text: '新しい連絡スレッドを投稿しました。' });
    await fetchThreads();
  }

  async function handlePostReply(e: React.FormEvent) {
    e.preventDefault();
    if (selectedThread === undefined || replyDraft.trim() === '') return;
    setPostingReply(true);
    setMessage(null);
    const res = await requestMasterApi<{ ok: true; item: ChatThreadDto }>(
      `/api/v1/chat/${selectedThread.id}`,
      {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ replyMessage: replyDraft.trim() }),
      },
    );
    setPostingReply(false);
    if (!res.ok) {
      setMessage({ type: 'error', text: res.error });
      return;
    }
    setReplyDraft('');
    await fetchThreads();
  }

  async function handleToggleResolved(thread: ChatThreadDto) {
    setMessage(null);
    const res = await requestMasterApi<{ ok: true; item: ChatThreadDto }>(
      `/api/v1/chat/${thread.id}`,
      {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ isResolved: !thread.isResolved }),
      },
    );
    if (!res.ok) {
      setMessage({ type: 'error', text: res.error });
      return;
    }
    setMessage({
      type: 'success',
      text: res.data.item.isResolved ? '解決済みに更新しました。' : '未解決・対応中に戻しました。',
    });
    await fetchThreads();
  }

  async function handleDeleteThread(thread: ChatThreadDto) {
    if (!window.confirm('この連絡スレッドを削除しますか？')) return;
    setMessage(null);
    const res = await requestMasterApi<{ ok: true }>(`/api/v1/chat/${thread.id}`, {
      method: 'DELETE',
    });
    if (!res.ok) {
      setMessage({ type: 'error', text: res.error });
      return;
    }
    setMessage({ type: 'success', text: '連絡スレッドを削除しました。' });
    await fetchThreads();
  }

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold text-slate-900">社内チャット・連絡ボード</h1>
          <p className="text-sm text-slate-600 mt-0.5">
            社内Q&amp;A・案件別連絡・Teams Adaptive Card 連携（未解決: {pageData.unresolvedCount}件 / 全 {pageData.totalCount}件）
          </p>
        </div>

        <button
          type="button"
          onClick={() => setNewOpen(true)}
          className="rounded-lg bg-blue-600 px-4 py-2 text-sm font-semibold text-white hover:bg-blue-700"
        >
          ＋ 新規スレッド投稿
        </button>
      </div>

      {message !== null && (
        <div
          className={`rounded-lg border px-4 py-3 text-sm ${
            message.type === 'error'
              ? 'border-red-200 bg-red-50 text-red-800'
              : 'border-emerald-200 bg-emerald-50 text-emerald-800'
          }`}
        >
          {message.text}
        </div>
      )}

      {/* Search Filters */}
      <form
        onSubmit={(e) => {
          e.preventDefault();
          void fetchThreads();
        }}
        className="rounded-xl border border-slate-200 bg-white p-4 grid grid-cols-1 md:grid-cols-6 gap-3 items-end"
      >
        <div className="md:col-span-2">
          <label className="block text-xs font-medium text-slate-600 mb-1">キーワード</label>
          <input
            type="text"
            value={keyword}
            onChange={(e) => setKeyword(e.target.value)}
            placeholder="投稿本文・返信・投稿者名"
            className="w-full rounded-lg border border-slate-300 px-3 py-1.5 text-sm"
          />
        </div>
        <div>
          <label className="block text-xs font-medium text-slate-600 mb-1">関連案件</label>
          <select
            value={projectFilter}
            onChange={(e) => setProjectFilter(e.target.value)}
            className="w-full rounded-lg border border-slate-300 px-2.5 py-1.5 text-sm"
          >
            <option value="">すべて</option>
            {lookups.projects.map((p) => (
              <option key={p.id} value={p.id}>
                #{p.projectNo} {p.projectName}
              </option>
            ))}
          </select>
        </div>
        <div>
          <label className="block text-xs font-medium text-slate-600 mb-1">関連取引先</label>
          <select
            value={partnerFilter}
            onChange={(e) => setPartnerFilter(e.target.value)}
            className="w-full rounded-lg border border-slate-300 px-2.5 py-1.5 text-sm"
          >
            <option value="">すべて</option>
            {lookups.partners.map((bp) => (
              <option key={bp.id} value={bp.id}>
                {bp.partnerCode} {bp.partnerName}
              </option>
            ))}
          </select>
        </div>
        <div className="grid grid-cols-2 gap-1.5">
          <div>
            <label className="block text-xs font-medium text-slate-600 mb-1">From</label>
            <input
              type="date"
              value={dateFrom}
              onChange={(e) => setDateFrom(e.target.value)}
              className="w-full rounded-lg border border-slate-300 px-2 py-1.5 text-xs"
            />
          </div>
          <div>
            <label className="block text-xs font-medium text-slate-600 mb-1">To</label>
            <input
              type="date"
              value={dateTo}
              onChange={(e) => setDateTo(e.target.value)}
              className="w-full rounded-lg border border-slate-300 px-2 py-1.5 text-xs"
            />
          </div>
        </div>
        <div className="flex items-center justify-between gap-2">
          <label className="inline-flex items-center gap-1.5 text-xs text-slate-700 cursor-pointer">
            <input
              type="checkbox"
              checked={unresolvedOnly}
              onChange={(e) => setUnresolvedOnly(e.target.checked)}
              className="rounded border-slate-300"
            />
            未解決のみ
          </label>
          <button
            type="submit"
            disabled={loading}
            className="rounded-lg bg-slate-900 px-4 py-1.5 text-sm font-medium text-white hover:bg-slate-800"
          >
            検索
          </button>
        </div>
      </form>

      {/* Main 3-Column Chat Workspace */}
      <div className="grid grid-cols-1 lg:grid-cols-12 gap-4">
        {/* Rooms Sidebar */}
        <div className="lg:col-span-3 rounded-xl border border-slate-200 bg-white p-3 space-y-1 self-start">
          <div className="px-2 py-1 text-xs font-semibold uppercase tracking-wider text-slate-400">
            ルーム一覧
          </div>
          <button
            type="button"
            onClick={() => void handleSelectRoom('')}
            className={`w-full flex items-center justify-between rounded-lg px-3 py-2 text-sm ${
              roomFilter === ''
                ? 'bg-blue-50 text-blue-700 font-semibold border border-blue-200'
                : 'text-slate-700 hover:bg-slate-50'
            }`}
          >
            <span>全ルーム</span>
            <span className="text-xs font-mono text-slate-500">
              {pageData.rooms.reduce((acc, r) => acc + r.totalCount, 0)}
            </span>
          </button>
          {pageData.rooms.map((r) => (
            <button
              key={r.roomName}
              type="button"
              onClick={() => void handleSelectRoom(r.roomName)}
              className={`w-full flex items-center justify-between rounded-lg px-3 py-2 text-sm ${
                roomFilter === r.roomName
                  ? 'bg-blue-50 text-blue-700 font-semibold border border-blue-200'
                  : 'text-slate-700 hover:bg-slate-50'
              }`}
            >
              <span className="truncate">{r.roomName}</span>
              <span className="flex items-center gap-1.5 shrink-0">
                {r.unresolvedCount > 0 && (
                  <span className="rounded-full bg-amber-100 px-1.5 py-0.5 text-[10px] font-bold text-amber-800">
                    未 {r.unresolvedCount}
                  </span>
                )}
                <span className="text-xs font-mono text-slate-400">{r.totalCount}</span>
              </span>
            </button>
          ))}
        </div>

        {/* Thread List */}
        <div className="lg:col-span-4 rounded-xl border border-slate-200 bg-white divide-y divide-slate-100 max-h-[680px] overflow-y-auto">
          {pageData.items.length === 0 ? (
            <div className="p-8 text-center text-sm text-slate-500">
              条件に一致する連絡スレッドはありません。
            </div>
          ) : (
            pageData.items.map((thread) => {
              const active = selectedThread?.id === thread.id;
              return (
                <button
                  key={thread.id}
                  type="button"
                  onClick={() => setSelectedId(thread.id)}
                  className={`w-full text-left p-3.5 space-y-1.5 transition-colors ${
                    active ? 'bg-blue-50/70' : 'hover:bg-slate-50'
                  }`}
                >
                  <div className="flex items-center justify-between gap-2 text-xs">
                    <span className="rounded bg-slate-100 px-2 py-0.5 font-medium text-slate-700">
                      {thread.roomName}
                    </span>
                    <span
                      className={`rounded-full px-2 py-0.5 font-semibold ${
                        thread.isResolved
                          ? 'bg-emerald-100 text-emerald-800'
                          : 'bg-amber-100 text-amber-800'
                      }`}
                    >
                      {thread.isResolved ? '解決済' : '対応中'}
                    </span>
                  </div>
                  <div className="text-sm font-medium text-slate-900 line-clamp-2">
                    {thread.question}
                  </div>
                  <div className="flex items-center justify-between text-[11px] text-slate-500">
                    <span>
                      {thread.staffName} ・ 返信 {thread.replies.length}件
                    </span>
                    <span className="font-mono">{thread.occurredAt.slice(0, 16).replace('T', ' ')}</span>
                  </div>
                </button>
              );
            })
          )}
        </div>

        {/* Selected Thread Detail */}
        <div className="lg:col-span-5 rounded-xl border border-slate-200 bg-white flex flex-col min-h-[520px]">
          {selectedThread === undefined ? (
            <div className="flex-1 flex items-center justify-center text-sm text-slate-400 p-8">
              スレッドを選択してください
            </div>
          ) : (
            <>
              <div className="border-b border-slate-200 p-4 space-y-2">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div className="flex items-center gap-2">
                    <span className="rounded bg-blue-100 px-2 py-0.5 text-xs font-semibold text-blue-800">
                      {selectedThread.roomName}
                    </span>
                    <span className="text-xs font-medium text-slate-700">
                      投稿者: {selectedThread.staffName}
                    </span>
                  </div>
                  <div className="flex items-center gap-1.5">
                    <button
                      type="button"
                      onClick={() => setCardThread(selectedThread)}
                      className="rounded border border-indigo-200 bg-indigo-50 px-2.5 py-1 text-xs font-medium text-indigo-700 hover:bg-indigo-100"
                    >
                      Teamsカード
                    </button>
                    <button
                      type="button"
                      onClick={() => void handleToggleResolved(selectedThread)}
                      className={`rounded px-2.5 py-1 text-xs font-semibold ${
                        selectedThread.isResolved
                          ? 'border border-amber-300 bg-amber-50 text-amber-800'
                          : 'bg-emerald-600 text-white hover:bg-emerald-700'
                      }`}
                    >
                      {selectedThread.isResolved ? '未解決に戻す' : '解決済にする'}
                    </button>
                    <button
                      type="button"
                      onClick={() => void handleDeleteThread(selectedThread)}
                      className="rounded border border-red-200 px-2 py-1 text-xs text-red-600 hover:bg-red-50"
                    >
                      削除
                    </button>
                  </div>
                </div>

                {(selectedThread.projectId !== null || selectedThread.partnerId !== null) && (
                  <div className="flex flex-wrap gap-2 text-xs">
                    {selectedThread.projectId !== null && selectedThread.projectName !== null && (
                      <Link
                        href={`/projects/${selectedThread.projectId}`}
                        className="rounded-md bg-slate-100 px-2.5 py-1 text-blue-700 hover:underline"
                      >
                        案件 #{selectedThread.projectNo} {selectedThread.projectName} →
                      </Link>
                    )}
                    {selectedThread.partnerId !== null && selectedThread.partnerName !== null && (
                      <Link
                        href="/masters/partners"
                        className="rounded-md bg-slate-100 px-2.5 py-1 text-slate-700 hover:underline"
                      >
                        取引先: {selectedThread.partnerCode} {selectedThread.partnerName}
                      </Link>
                    )}
                  </div>
                )}
              </div>

              {/* Chronological Messages */}
              <div className="flex-1 overflow-y-auto p-4 space-y-3 bg-slate-50/50">
                <div className="rounded-xl border border-blue-200 bg-white p-3.5 shadow-2xs space-y-1">
                  <div className="flex items-center justify-between text-xs text-slate-500">
                    <span className="font-semibold text-slate-900">{selectedThread.staffName}</span>
                    <span className="font-mono">
                      {selectedThread.askedAt.slice(0, 16).replace('T', ' ')}
                    </span>
                  </div>
                  <p className="text-sm text-slate-900 whitespace-pre-wrap">
                    {selectedThread.question}
                  </p>
                </div>

                {selectedThread.replies.map((rep) => (
                  <div
                    key={rep.id}
                    className="ml-5 rounded-xl border border-slate-200 bg-white p-3 shadow-2xs space-y-1"
                  >
                    <div className="flex items-center justify-between text-xs text-slate-500">
                      <span className="font-semibold text-slate-800">{rep.staffName}</span>
                      <span className="font-mono">
                        {rep.repliedAt !== '' ? rep.repliedAt.slice(0, 16).replace('T', ' ') : ''}
                      </span>
                    </div>
                    <p className="text-sm text-slate-800 whitespace-pre-wrap">{rep.message}</p>
                  </div>
                ))}
              </div>

              {/* Reply Input */}
              <form
                onSubmit={handlePostReply}
                className="border-t border-slate-200 p-3 flex items-center gap-2"
              >
                <input
                  type="text"
                  value={replyDraft}
                  onChange={(e) => setReplyDraft(e.target.value)}
                  placeholder="返信・対応コメントを入力..."
                  className="flex-1 rounded-lg border border-slate-300 px-3 py-2 text-sm"
                />
                <button
                  type="submit"
                  disabled={postingReply || replyDraft.trim() === ''}
                  className="rounded-lg bg-blue-600 px-4 py-2 text-sm font-semibold text-white hover:bg-blue-700 disabled:opacity-50"
                >
                  {postingReply ? '送信中...' : '返信'}
                </button>
              </form>
            </>
          )}
        </div>
      </div>

      {/* New Thread Modal */}
      {newOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/50 p-4">
          <div className="w-full max-w-lg rounded-2xl bg-white shadow-xl border border-slate-200 p-6 space-y-4">
            <div className="flex items-center justify-between border-b border-slate-200 pb-3">
              <h2 className="text-base font-bold text-slate-900">新規チャットスレッド投稿</h2>
              <button
                type="button"
                onClick={() => setNewOpen(false)}
                className="text-sm text-slate-500 hover:text-slate-800"
              >
                ✕
              </button>
            </div>
            <form onSubmit={handleCreateSubmit} className="space-y-3 text-sm">
              <div>
                <label className="block text-xs font-semibold text-slate-700 mb-1">ルーム</label>
                <select
                  value={newRoomName}
                  onChange={(e) => setNewRoomName(e.target.value)}
                  className="w-full rounded-lg border border-slate-300 px-3 py-2"
                >
                  {lookups.defaultRooms.map((r) => (
                    <option key={r} value={r}>
                      {r}
                    </option>
                  ))}
                  <option value="__CUSTOM__">カスタムルーム名を入力...</option>
                </select>
                {newRoomName === '__CUSTOM__' && (
                  <input
                    type="text"
                    required
                    value={customRoomName}
                    onChange={(e) => setCustomRoomName(e.target.value)}
                    placeholder="例: 静岡エリア施工チーム"
                    className="mt-2 w-full rounded-lg border border-slate-300 px-3 py-2"
                  />
                )}
              </div>

              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-xs font-semibold text-slate-700 mb-1">
                    関連案件（任意）
                  </label>
                  <select
                    value={newProjectId}
                    onChange={(e) => setNewProjectId(e.target.value)}
                    className="w-full rounded-lg border border-slate-300 px-2.5 py-2 text-xs"
                  >
                    <option value="">なし</option>
                    {lookups.projects.map((p) => (
                      <option key={p.id} value={p.id}>
                        #{p.projectNo} {p.projectName}
                      </option>
                    ))}
                  </select>
                </div>
                <div>
                  <label className="block text-xs font-semibold text-slate-700 mb-1">
                    関連取引先（任意）
                  </label>
                  <select
                    value={newPartnerId}
                    onChange={(e) => setNewPartnerId(e.target.value)}
                    className="w-full rounded-lg border border-slate-300 px-2.5 py-2 text-xs"
                  >
                    <option value="">なし</option>
                    {lookups.partners.map((bp) => (
                      <option key={bp.id} value={bp.id}>
                        {bp.partnerCode} {bp.partnerName}
                      </option>
                    ))}
                  </select>
                </div>
              </div>

              <div>
                <label className="block text-xs font-semibold text-slate-700 mb-1">
                  連絡・質問内容 *
                </label>
                <textarea
                  rows={4}
                  required
                  value={newQuestion}
                  onChange={(e) => setNewQuestion(e.target.value)}
                  placeholder="現場確認事項や請求確認内容を入力してください..."
                  className="w-full rounded-lg border border-slate-300 px-3 py-2"
                />
              </div>

              <div className="flex justify-end gap-2 pt-2">
                <button
                  type="button"
                  onClick={() => setNewOpen(false)}
                  className="rounded-lg border border-slate-300 px-4 py-1.5 text-slate-700"
                >
                  キャンセル
                </button>
                <button
                  type="submit"
                  disabled={creating}
                  className="rounded-lg bg-blue-600 px-4 py-1.5 font-semibold text-white hover:bg-blue-700 disabled:opacity-50"
                >
                  {creating ? '投稿中...' : '投稿する'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* Teams Adaptive Card Preview Modal */}
      {cardThread !== null && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/50 p-4">
          <div className="w-full max-w-2xl rounded-2xl bg-white shadow-xl border border-slate-200 p-6 space-y-4">
            <div className="flex items-center justify-between border-b border-slate-200 pb-3">
              <h2 className="text-base font-bold text-slate-900">
                Microsoft Teams Adaptive Card Webhook ペイロード
              </h2>
              <button
                type="button"
                onClick={() => setCardThread(null)}
                className="text-sm text-slate-500 hover:text-slate-800"
              >
                ✕
              </button>
            </div>
            <pre className="max-h-96 overflow-auto rounded-xl bg-slate-900 p-4 text-xs text-slate-100 font-mono">
              {cardJsonText}
            </pre>
            <div className="flex justify-end">
              <button
                type="button"
                onClick={() => setCardThread(null)}
                className="rounded-lg bg-slate-900 px-4 py-1.5 text-sm font-medium text-white"
              >
                閉じる
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
