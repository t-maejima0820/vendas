export interface ChatReplyDto {
  id: string;
  employeeId: string | null;
  staffCode: string | null;
  staffName: string;
  message: string;
  repliedAt: string;
}

export interface ChatThreadDto {
  id: string;
  roomName: string;
  employeeId: string | null;
  staffCode: string | null;
  staffName: string;
  question: string;
  askedAt: string;
  replies: ChatReplyDto[];
  latestAnswerPreview: string | null;
  answeredAt: string | null;
  isResolved: boolean;
  occurredAt: string;
  projectId: string | null;
  projectNo: number | null;
  projectName: string | null;
  partnerId: string | null;
  partnerCode: string | null;
  partnerName: string | null;
}

export interface ChatRoomSummaryDto {
  roomName: string;
  totalCount: number;
  unresolvedCount: number;
}

export interface ChatPageDto {
  items: ChatThreadDto[];
  totalCount: number;
  unresolvedCount: number;
  resolvedCount: number;
  rooms: ChatRoomSummaryDto[];
  defaultRooms: string[];
}

export interface ChatLookupsDto {
  companyName: string;
  defaultRooms: string[];
  projects: Array<{ id: string; projectNo: number; projectName: string }>;
  partners: Array<{ id: string; partnerCode: string; partnerName: string }>;
}

export interface ChatCreateInput {
  roomName?: string | null;
  question: string;
  projectId?: string | null;
  partnerId?: string | null;
}

export interface ChatUpdateInput {
  replyMessage?: string | null;
  isResolved?: boolean;
  roomName?: string | null;
  question?: string | null;
  projectId?: string | null;
  partnerId?: string | null;
}

export interface TeamsAdaptiveCardPayload {
  type: 'message';
  attachments: Array<{
    contentType: 'application/vnd.microsoft.card.adaptive';
    content: {
      type: 'AdaptiveCard';
      version: '1.4';
      body: Array<Record<string, unknown>>;
    };
  }>;
}

/**
 * 旧 Access mdlTeams 相当の Microsoft Teams Adaptive Card ペイロードを生成する
 */
export function buildTeamsAdaptiveCardPayload(
  companyName: string,
  thread: ChatThreadDto,
): TeamsAdaptiveCardPayload {
  const facts: Array<{ title: string; value: string }> = [
    { title: 'ルーム', value: thread.roomName },
    { title: '投稿者', value: thread.staffName },
    { title: '状態', value: thread.isResolved ? '解決済み' : '未解決・対応中' },
  ];
  if (thread.projectNo !== null && thread.projectName !== null) {
    facts.push({ title: '関連案件', value: `#${thread.projectNo} ${thread.projectName}` });
  }
  if (thread.partnerCode !== null && thread.partnerName !== null) {
    facts.push({ title: '関連取引先', value: `${thread.partnerCode} ${thread.partnerName}` });
  }

  const body: Array<Record<string, unknown>> = [
    {
      type: 'TextBlock',
      size: 'Medium',
      weight: 'Bolder',
      text: `【${companyName !== '' ? companyName : 'Vendas Web'}】社内連絡 (${thread.roomName})`,
    },
    {
      type: 'FactSet',
      facts,
    },
    {
      type: 'TextBlock',
      wrap: true,
      text: thread.question,
    },
  ];

  if (thread.replies.length > 0) {
    const latest = thread.replies[thread.replies.length - 1]!;
    body.push({
      type: 'TextBlock',
      wrap: true,
      isSubtle: true,
      text: `最新返信 (${latest.staffName}): ${latest.message}`,
    });
  }

  return {
    type: 'message',
    attachments: [
      {
        contentType: 'application/vnd.microsoft.card.adaptive',
        content: {
          type: 'AdaptiveCard',
          version: '1.4',
          body,
        },
      },
    ],
  };
}
