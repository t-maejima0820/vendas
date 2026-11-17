import ChatClient from '@/app/(dashboard)/chat/ChatClient';
import { runWithPageSession } from '@/lib/auth/page-session';
import { getChatLookups, listChatThreads } from '@/lib/chat/chat-service';
import { isFeatureEnabled } from '@/lib/feature-flags/gate';

export default async function ChatPage({
  searchParams,
}: {
  searchParams: Promise<{ roomName?: string; projectId?: string; unresolvedOnly?: string }>;
}) {
  const params = await searchParams;
  const initialRoom =
    params.roomName !== undefined && params.roomName.trim() !== ''
      ? params.roomName.trim()
      : '';
  const initialProjectId =
    params.projectId !== undefined && params.projectId.trim() !== ''
      ? params.projectId.trim()
      : '';
  const initialUnresolvedOnly = params.unresolvedOnly === '1';

  const data = await runWithPageSession(async ({ user, tx }) => {
    const teamsEnabled = await isFeatureEnabled(tx, user.tenantId, 'teams');
    if (!teamsEnabled) {
      return { allowed: false as const };
    }

    const [lookups, initialPage] = await Promise.all([
      getChatLookups(tx, user.tenantId),
      listChatThreads(tx, user.tenantId, {
        roomName: initialRoom !== '' ? initialRoom : null,
        projectId: initialProjectId !== '' ? initialProjectId : null,
        unresolvedOnly: initialUnresolvedOnly,
      }),
    ]);

    return {
      allowed: true as const,
      lookups,
      initialPage,
    };
  });

  if (!data.allowed) {
    return (
      <div className="max-w-2xl rounded-xl border border-amber-200 bg-amber-50 p-6 text-sm text-amber-900">
        <h1 className="text-lg font-bold mb-1">アクセス権限がありません</h1>
        <p>このテナントでは「社内チャット / Teams連携」機能（teams）が有効化されていません。</p>
      </div>
    );
  }

  return (
    <ChatClient
      lookups={data.lookups}
      initialPage={data.initialPage}
      initialRoom={initialRoom}
      initialProjectId={initialProjectId}
      initialUnresolvedOnly={initialUnresolvedOnly}
    />
  );
}
