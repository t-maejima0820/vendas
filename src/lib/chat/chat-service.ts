import crypto from 'node:crypto';
import {
  buildTeamsAdaptiveCardPayload,
  type ChatCreateInput,
  type ChatLookupsDto,
  type ChatPageDto,
  type ChatReplyDto,
  type ChatRoomSummaryDto,
  type ChatThreadDto,
  type ChatUpdateInput,
  type TeamsAdaptiveCardPayload,
} from '@/lib/chat/types';
import type { DbExecutor } from '@/lib/db/tenant-client';
import { requireFeature } from '@/lib/feature-flags/gate';
import { MasterDataError } from '@/lib/masters/error-mapper';

const DEFAULT_ROOMS = ['全社連絡', '現場・案件連絡', '請求・経理確認', '購買・発注相談'];
const META_PREFIX = '[[VENDAS_META:';
const META_SUFFIX = ']]\n';
const REPLIES_PREFIX = '[[VENDAS_REPLIES:';
const REPLIES_SUFFIX = ']]';
const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DATE_REGEX = /^\d{4}-\d{2}-\d{2}$/;

interface EncodedQuestionMeta {
  roomName?: string;
  projectId?: string | null;
  partnerId?: string | null;
}

interface InternalChatRow extends Record<string, unknown> {
  id: string;
  employee_id: string | null;
  staff_code: string | null;
  staff_name: string;
  question: string;
  asked_at: string;
  answer: string | null;
  answered_at: string | null;
  is_resolved: boolean;
  occurred_at: string;
  created_at: string;
}

function validateUuid(id: string, label: string): void {
  if (!UUID_REGEX.test(id)) {
    throw new MasterDataError(400, 'INVALID_ID', `${label}IDの形式が不正です。`);
  }
}

function validateOptionalDate(raw: string | null | undefined, label: string): string | null {
  if (raw === undefined || raw === null || raw.trim() === '') {
    return null;
  }
  const trimmed = raw.trim();
  if (!DATE_REGEX.test(trimmed)) {
    throw new MasterDataError(400, 'INVALID_DATE', `${label}は YYYY-MM-DD 形式で指定してください。`);
  }
  return trimmed;
}

function normalizeRoomName(raw: string | null | undefined): string {
  if (raw === undefined || raw === null || raw.trim() === '') {
    return '全社連絡';
  }
  return raw.trim().slice(0, 40);
}

function encodeQuestionWithMeta(
  questionBody: string,
  meta: { roomName: string; projectId: string | null; partnerId: string | null },
): string {
  const payload = Buffer.from(
    JSON.stringify({
      roomName: meta.roomName,
      projectId: meta.projectId,
      partnerId: meta.partnerId,
    }),
    'utf8',
  ).toString('base64url');
  return `${META_PREFIX}${payload}${META_SUFFIX}${questionBody}`;
}

function decodeQuestionWithMeta(rawQuestion: string): {
  roomName: string;
  projectId: string | null;
  partnerId: string | null;
  question: string;
} {
  if (rawQuestion.startsWith(META_PREFIX)) {
    const endIdx = rawQuestion.indexOf(META_SUFFIX, META_PREFIX.length);
    if (endIdx > META_PREFIX.length) {
      const b64 = rawQuestion.slice(META_PREFIX.length, endIdx);
      const cleanBody = rawQuestion.slice(endIdx + META_SUFFIX.length);
      const parsed = JSON.parse(Buffer.from(b64, 'base64url').toString('utf8')) as EncodedQuestionMeta;
      return {
        roomName: normalizeRoomName(parsed.roomName),
        projectId:
          typeof parsed.projectId === 'string' && UUID_REGEX.test(parsed.projectId)
            ? parsed.projectId
            : null,
        partnerId:
          typeof parsed.partnerId === 'string' && UUID_REGEX.test(parsed.partnerId)
            ? parsed.partnerId
            : null,
        question: cleanBody,
      };
    }
  }
  return {
    roomName: '全社連絡',
    projectId: null,
    partnerId: null,
    question: rawQuestion,
  };
}

function encodeReplies(replies: readonly ChatReplyDto[]): string | null {
  if (replies.length === 0) {
    return null;
  }
  const b64 = Buffer.from(JSON.stringify(replies), 'utf8').toString('base64url');
  return `${REPLIES_PREFIX}${b64}${REPLIES_SUFFIX}`;
}

function decodeReplies(rawAnswer: string | null, answeredAt: string | null): ChatReplyDto[] {
  if (rawAnswer === null || rawAnswer.trim() === '') {
    return [];
  }
  if (rawAnswer.startsWith(REPLIES_PREFIX) && rawAnswer.endsWith(REPLIES_SUFFIX)) {
    const b64 = rawAnswer.slice(REPLIES_PREFIX.length, rawAnswer.length - REPLIES_SUFFIX.length);
    const parsed = JSON.parse(Buffer.from(b64, 'base64url').toString('utf8'));
    if (Array.isArray(parsed)) {
      return parsed.filter(
        (item): item is ChatReplyDto =>
          item !== null &&
          typeof item === 'object' &&
          typeof item.message === 'string' &&
          typeof item.staffName === 'string',
      );
    }
    throw new MasterDataError(500, 'CORRUPTED_CHAT_REPLIES', 'チャット返信データの解析に失敗しました。');
  }
  return [
    {
      id: 'legacy-reply',
      employeeId: null,
      staffCode: null,
      staffName: '回答',
      message: rawAnswer,
      repliedAt: answeredAt !== null ? answeredAt : '',
    },
  ];
}

async function resolveEntityMaps(
  tx: DbExecutor,
  tenantId: string,
): Promise<{
  projectMap: Map<string, { projectNo: number; projectName: string }>;
  partnerMap: Map<string, { partnerCode: string; partnerName: string }>;
}> {
  const [pjRows, bpRows] = await Promise.all([
    tx.query<{ id: string; project_no: string; project_name: string }>(
      `SELECT id, project_no::text AS project_no, project_name
         FROM projects
        WHERE tenant_id = $1::uuid
        ORDER BY project_date DESC, project_no DESC`,
      [tenantId],
    ),
    tx.query<{ id: string; partner_code: string; partner_name: string }>(
      `SELECT id, partner_code, partner_name
         FROM business_partners
        WHERE tenant_id = $1::uuid AND is_deleted = false
        ORDER BY partner_code ASC`,
      [tenantId],
    ),
  ]);

  return {
    projectMap: new Map(
      pjRows.map((p) => [
        p.id,
        { projectNo: Number(p.project_no), projectName: p.project_name },
      ]),
    ),
    partnerMap: new Map(
      bpRows.map((b) => [
        b.id,
        { partnerCode: b.partner_code, partnerName: b.partner_name },
      ]),
    ),
  };
}

function mapChatRow(
  row: InternalChatRow,
  maps: {
    projectMap: Map<string, { projectNo: number; projectName: string }>;
    partnerMap: Map<string, { partnerCode: string; partnerName: string }>;
  },
): ChatThreadDto {
  const meta = decodeQuestionWithMeta(row.question);
  const replies = decodeReplies(row.answer, row.answered_at);
  const project = meta.projectId !== null ? maps.projectMap.get(meta.projectId) : undefined;
  const partner = meta.partnerId !== null ? maps.partnerMap.get(meta.partnerId) : undefined;
  const latestReply = replies.length > 0 ? replies[replies.length - 1] : undefined;

  return {
    id: row.id,
    roomName: meta.roomName,
    employeeId: row.employee_id,
    staffCode: row.staff_code,
    staffName: row.staff_name,
    question: meta.question,
    askedAt: row.asked_at,
    replies,
    latestAnswerPreview: latestReply !== undefined ? latestReply.message : null,
    answeredAt: row.answered_at,
    isResolved: row.is_resolved,
    occurredAt: row.occurred_at,
    projectId: meta.projectId,
    projectNo: project !== undefined ? project.projectNo : null,
    projectName: project !== undefined ? project.projectName : null,
    partnerId: meta.partnerId,
    partnerCode: partner !== undefined ? partner.partnerCode : null,
    partnerName: partner !== undefined ? partner.partnerName : null,
  };
}

export async function getChatLookups(
  tx: DbExecutor,
  tenantId: string,
): Promise<ChatLookupsDto> {
  await requireFeature(tx, tenantId, 'teams');

  const [tsRows, maps] = await Promise.all([
    tx.query<{ company_name: string }>(
      'SELECT company_name FROM tenant_settings WHERE tenant_id = $1::uuid LIMIT 1',
      [tenantId],
    ),
    resolveEntityMaps(tx, tenantId),
  ]);

  return {
    companyName: tsRows[0] !== undefined ? tsRows[0].company_name : '',
    defaultRooms: [...DEFAULT_ROOMS],
    projects: Array.from(maps.projectMap.entries()).map(([id, v]) => ({
      id,
      projectNo: v.projectNo,
      projectName: v.projectName,
    })),
    partners: Array.from(maps.partnerMap.entries()).map(([id, v]) => ({
      id,
      partnerCode: v.partnerCode,
      partnerName: v.partnerName,
    })),
  };
}

export interface ChatListFilter {
  roomName?: string | null;
  projectId?: string | null;
  partnerId?: string | null;
  unresolvedOnly?: boolean;
  keyword?: string | null;
  dateFrom?: string | null;
  dateTo?: string | null;
}

export async function listChatThreads(
  tx: DbExecutor,
  tenantId: string,
  filter: ChatListFilter = {},
): Promise<ChatPageDto> {
  await requireFeature(tx, tenantId, 'teams');

  const dateFrom = validateOptionalDate(filter.dateFrom, '開始日');
  const dateTo = validateOptionalDate(filter.dateTo, '終了日');
  const unresolvedOnly = filter.unresolvedOnly === true;

  if (filter.projectId !== undefined && filter.projectId !== null && filter.projectId !== '') {
    validateUuid(filter.projectId, '案件');
  }
  if (filter.partnerId !== undefined && filter.partnerId !== null && filter.partnerId !== '') {
    validateUuid(filter.partnerId, '取引先');
  }

  const [rows, maps] = await Promise.all([
    tx.query<InternalChatRow>(
      `SELECT id, employee_id, staff_code, staff_name,
              question, asked_at::text AS asked_at,
              answer, answered_at::text AS answered_at,
              is_resolved, occurred_at::text AS occurred_at,
              created_at::text AS created_at
         FROM internal_chats
        WHERE tenant_id = $1::uuid
          AND ($2::text IS NULL OR occurred_at::date >= $2::date)
          AND ($3::text IS NULL OR occurred_at::date <= $3::date)
          AND ($4::boolean = false OR is_resolved = false)
        ORDER BY is_resolved ASC, occurred_at DESC, created_at DESC`,
      [tenantId, dateFrom, dateTo, unresolvedOnly],
    ),
    resolveEntityMaps(tx, tenantId),
  ]);

  const allMapped = rows.map((r) => mapChatRow(r, maps));

  // ルーム別集計（ルーム絞り込み前の全体内訳を返す）
  const roomAcc = new Map<string, { totalCount: number; unresolvedCount: number }>();
  for (const rName of DEFAULT_ROOMS) {
    roomAcc.set(rName, { totalCount: 0, unresolvedCount: 0 });
  }
  for (const item of allMapped) {
    const cur = roomAcc.get(item.roomName) ?? { totalCount: 0, unresolvedCount: 0 };
    cur.totalCount += 1;
    if (!item.isResolved) {
      cur.unresolvedCount += 1;
    }
    roomAcc.set(item.roomName, cur);
  }
  const rooms: ChatRoomSummaryDto[] = Array.from(roomAcc.entries()).map(([roomName, cnt]) => ({
    roomName,
    totalCount: cnt.totalCount,
    unresolvedCount: cnt.unresolvedCount,
  }));

  const targetRoom =
    filter.roomName !== undefined && filter.roomName !== null && filter.roomName.trim() !== ''
      ? filter.roomName.trim()
      : null;
  const targetProjectId =
    filter.projectId !== undefined && filter.projectId !== null && filter.projectId !== ''
      ? filter.projectId
      : null;
  const targetPartnerId =
    filter.partnerId !== undefined && filter.partnerId !== null && filter.partnerId !== ''
      ? filter.partnerId
      : null;
  const kw =
    filter.keyword !== undefined && filter.keyword !== null && filter.keyword.trim() !== ''
      ? filter.keyword.trim().toLowerCase()
      : null;

  const filtered = allMapped.filter((item) => {
    if (targetRoom !== null && item.roomName !== targetRoom) return false;
    if (targetProjectId !== null && item.projectId !== targetProjectId) return false;
    if (targetPartnerId !== null && item.partnerId !== targetPartnerId) return false;
    if (kw !== null) {
      const haystacks = [
        item.roomName,
        item.staffName,
        item.question,
        item.projectName !== null ? item.projectName : '',
        item.partnerName !== null ? item.partnerName : '',
        ...item.replies.map((rp) => `${rp.staffName} ${rp.message}`),
      ]
        .join(' ')
        .toLowerCase();
      if (!haystacks.includes(kw)) return false;
    }
    return true;
  });

  const unresolvedCount = filtered.filter((i) => !i.isResolved).length;

  return {
    items: filtered,
    totalCount: filtered.length,
    unresolvedCount,
    resolvedCount: filtered.length - unresolvedCount,
    rooms,
    defaultRooms: [...DEFAULT_ROOMS],
  };
}

async function assertReferencesValid(
  tx: DbExecutor,
  tenantId: string,
  projectId: string | null,
  partnerId: string | null,
): Promise<void> {
  if (projectId !== null) {
    validateUuid(projectId, '案件');
    const pj = await tx.query<{ id: string }>(
      'SELECT id FROM projects WHERE tenant_id = $1::uuid AND id = $2::uuid LIMIT 1',
      [tenantId, projectId],
    );
    if (pj.length === 0) {
      throw new MasterDataError(400, 'PROJECT_NOT_FOUND', '指定された案件が見つかりません。');
    }
  }
  if (partnerId !== null) {
    validateUuid(partnerId, '取引先');
    const bp = await tx.query<{ id: string }>(
      'SELECT id FROM business_partners WHERE tenant_id = $1::uuid AND id = $2::uuid AND is_deleted = false LIMIT 1',
      [tenantId, partnerId],
    );
    if (bp.length === 0) {
      throw new MasterDataError(400, 'PARTNER_NOT_FOUND', '指定された取引先が見つかりません。');
    }
  }
}

export async function createChatThread(
  tx: DbExecutor,
  tenantId: string,
  employeeId: string,
  input: ChatCreateInput,
): Promise<ChatThreadDto> {
  await requireFeature(tx, tenantId, 'teams');

  const questionBody = input.question.trim();
  if (questionBody.length === 0 || questionBody.length > 2000) {
    throw new MasterDataError(400, 'INVALID_MESSAGE', 'メッセージ本文は1〜2000文字で入力してください。');
  }

  const roomName = normalizeRoomName(input.roomName);
  const projectId =
    input.projectId !== undefined && input.projectId !== null && input.projectId.trim() !== ''
      ? input.projectId.trim()
      : null;
  const partnerId =
    input.partnerId !== undefined && input.partnerId !== null && input.partnerId.trim() !== ''
      ? input.partnerId.trim()
      : null;

  await assertReferencesValid(tx, tenantId, projectId, partnerId);

  const empRows = await tx.query<{ syain_code: string; syain_name: string }>(
    'SELECT syain_code, syain_name FROM employees WHERE tenant_id = $1::uuid AND id = $2::uuid LIMIT 1',
    [tenantId, employeeId],
  );
  const emp = empRows[0];
  if (emp === undefined) {
    throw new MasterDataError(404, 'EMPLOYEE_NOT_FOUND', '投稿社員が見つかりません。');
  }

  const encodedQuestion = encodeQuestionWithMeta(questionBody, {
    roomName,
    projectId,
    partnerId,
  });

  const inserted = await tx.query<InternalChatRow>(
    `INSERT INTO internal_chats (
       tenant_id, employee_id, staff_code, staff_name,
       question, asked_at, is_resolved, occurred_at
     ) VALUES (
       $1::uuid, $2::uuid, $3, $4,
       $5, now(), false, now()
     )
     RETURNING id, employee_id, staff_code, staff_name,
               question, asked_at::text AS asked_at,
               answer, answered_at::text AS answered_at,
               is_resolved, occurred_at::text AS occurred_at,
               created_at::text AS created_at`,
    [tenantId, employeeId, emp.syain_code, emp.syain_name, encodedQuestion],
  );
  const row = inserted[0];
  if (row === undefined) {
    throw new MasterDataError(500, 'CHAT_INSERT_FAILED', 'チャット投稿結果を取得できませんでした。');
  }

  const maps = await resolveEntityMaps(tx, tenantId);
  return mapChatRow(row, maps);
}

export async function updateChatThread(
  tx: DbExecutor,
  tenantId: string,
  employeeId: string,
  chatId: string,
  input: ChatUpdateInput,
): Promise<ChatThreadDto> {
  validateUuid(chatId, 'チャット');
  await requireFeature(tx, tenantId, 'teams');

  const existingRows = await tx.query<InternalChatRow>(
    `SELECT id, employee_id, staff_code, staff_name,
            question, asked_at::text AS asked_at,
            answer, answered_at::text AS answered_at,
            is_resolved, occurred_at::text AS occurred_at,
            created_at::text AS created_at
       FROM internal_chats
      WHERE tenant_id = $1::uuid AND id = $2::uuid
      FOR UPDATE`,
    [tenantId, chatId],
  );
  const existing = existingRows[0];
  if (existing === undefined) {
    throw new MasterDataError(404, 'CHAT_NOT_FOUND', '対象のチャットスレッドが見つかりません。');
  }

  const currentMeta = decodeQuestionWithMeta(existing.question);
  const nextRoom =
    input.roomName !== undefined ? normalizeRoomName(input.roomName) : currentMeta.roomName;
  const nextProjectId =
    input.projectId !== undefined
      ? input.projectId !== null && input.projectId.trim() !== ''
        ? input.projectId.trim()
        : null
      : currentMeta.projectId;
  const nextPartnerId =
    input.partnerId !== undefined
      ? input.partnerId !== null && input.partnerId.trim() !== ''
        ? input.partnerId.trim()
        : null
      : currentMeta.partnerId;

  await assertReferencesValid(tx, tenantId, nextProjectId, nextPartnerId);

  const nextBody =
    input.question !== undefined && input.question !== null
      ? input.question.trim()
      : currentMeta.question;
  if (nextBody.length === 0 || nextBody.length > 2000) {
    throw new MasterDataError(400, 'INVALID_MESSAGE', 'メッセージ本文は1〜2000文字で入力してください。');
  }

  const encodedQuestion = encodeQuestionWithMeta(nextBody, {
    roomName: nextRoom,
    projectId: nextProjectId,
    partnerId: nextPartnerId,
  });

  const replies = decodeReplies(existing.answer, existing.answered_at);
  let hasNewReply = false;
  if (input.replyMessage !== undefined && input.replyMessage !== null && input.replyMessage.trim() !== '') {
    const msg = input.replyMessage.trim();
    if (msg.length > 2000) {
      throw new MasterDataError(400, 'INVALID_MESSAGE', '返信メッセージは2000文字以内で入力してください。');
    }
    const empRows = await tx.query<{ syain_code: string; syain_name: string }>(
      'SELECT syain_code, syain_name FROM employees WHERE tenant_id = $1::uuid AND id = $2::uuid LIMIT 1',
      [tenantId, employeeId],
    );
    const emp = empRows[0];
    replies.push({
      id: crypto.randomUUID(),
      employeeId,
      staffCode: emp !== undefined ? emp.syain_code : null,
      staffName: emp !== undefined ? emp.syain_name : '担当',
      message: msg,
      repliedAt: new Date().toISOString(),
    });
    hasNewReply = true;
  }

  const nextAnswer = encodeReplies(replies);
  const nextResolved = input.isResolved !== undefined ? input.isResolved : existing.is_resolved;

  const updated = await tx.query<InternalChatRow>(
    `UPDATE internal_chats
        SET question = $3,
            answer = $4,
            answered_at = CASE WHEN $5::boolean THEN now() ELSE answered_at END,
            occurred_at = CASE WHEN $5::boolean THEN now() ELSE occurred_at END,
            is_resolved = $6
      WHERE tenant_id = $1::uuid AND id = $2::uuid
      RETURNING id, employee_id, staff_code, staff_name,
                question, asked_at::text AS asked_at,
                answer, answered_at::text AS answered_at,
                is_resolved, occurred_at::text AS occurred_at,
                created_at::text AS created_at`,
    [tenantId, chatId, encodedQuestion, nextAnswer, hasNewReply, nextResolved],
  );
  const updatedRow = updated[0];
  if (updatedRow === undefined) {
    throw new MasterDataError(404, 'CHAT_NOT_FOUND', '対象のチャットスレッドが見つかりません。');
  }

  const maps = await resolveEntityMaps(tx, tenantId);
  return mapChatRow(updatedRow, maps);
}

export async function deleteChatThread(
  tx: DbExecutor,
  tenantId: string,
  chatId: string,
): Promise<{ id: string }> {
  validateUuid(chatId, 'チャット');
  await requireFeature(tx, tenantId, 'teams');

  const deleted = await tx.query<{ id: string }>(
    'DELETE FROM internal_chats WHERE tenant_id = $1::uuid AND id = $2::uuid RETURNING id',
    [tenantId, chatId],
  );
  if (deleted.length === 0) {
    throw new MasterDataError(404, 'CHAT_NOT_FOUND', '対象のチャットスレッドが見つかりません。');
  }
  return { id: chatId };
}

export { buildTeamsAdaptiveCardPayload };
export type { TeamsAdaptiveCardPayload };
