export class MasterDataError extends Error {
  readonly statusCode: number;
  readonly errorCode: string;
  readonly safeMessage: string;

  constructor(statusCode: number, errorCode: string, safeMessage: string) {
    super(safeMessage);
    this.name = 'MasterDataError';
    this.statusCode = statusCode;
    this.errorCode = errorCode;
    this.safeMessage = safeMessage;
  }
}

interface PgConstraintErrorShape {
  code?: unknown;
  constraint?: unknown;
}

export interface MapPgErrorOptions {
  entityLabel: string;
  uniqueMessages?: Record<string, string>;
  fkMessages?: Record<string, string>;
  defaultUniqueMessage?: string;
  defaultFkMessage?: string;
}

function getStringProp(val: unknown): string | null {
  return typeof val === 'string' && val.length > 0 ? val : null;
}

/**
 * Maps raw PostgreSQL constraint errors into sanitized MasterDataError instances.
 * Callers must explicitly `throw mapPgConstraintError(err, ...)` inside catch blocks.
 */
export function extractEntityIdFromRequest(req: Request, entityLabel: string): string {
  const segments = new URL(req.url).pathname.split('/').filter((s) => s.length > 0);
  const last = segments[segments.length - 1];
  if (last === undefined || last.trim() === '') {
    throw new MasterDataError(400, 'INVALID_ID', `${entityLabel}IDが指定されていません。`);
  }
  return decodeURIComponent(last);
}

export async function parseMasterJsonBody<T>(req: Request): Promise<T> {
  try {
    const parsed = (await req.json()) as unknown;
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      throw new MasterDataError(400, 'INVALID_JSON', 'リクエスト本文はJSONオブジェクトで送信してください。');
    }
    return parsed as T;
  } catch (err) {
    if (err instanceof MasterDataError) {
      throw err;
    }
    throw new MasterDataError(
      400,
      'INVALID_JSON',
      err instanceof Error ? 'JSON形式が不正です。' : 'JSON形式が不正です。',
    );
  }
}

export function mapPgConstraintError(err: unknown, options: MapPgErrorOptions): unknown {
  if (err instanceof MasterDataError) {
    return err;
  }

  if (typeof err === 'object' && err !== null) {
    const pgErr = err as PgConstraintErrorShape;
    const code = getStringProp(pgErr.code);
    const constraint = getStringProp(pgErr.constraint);

    if (code === '23505') {
      if (constraint !== null && options.uniqueMessages !== undefined) {
        const mapped = options.uniqueMessages[constraint];
        if (mapped !== undefined) {
          return new MasterDataError(409, 'DUPLICATE_RECORD', mapped);
        }
      }
      const msg =
        options.defaultUniqueMessage !== undefined
          ? options.defaultUniqueMessage
          : `${options.entityLabel}のコードまたは一意キーが既に登録されています。別の値を指定してください。`;
      return new MasterDataError(409, 'DUPLICATE_RECORD', msg);
    }

    if (code === '23503') {
      if (constraint !== null && options.fkMessages !== undefined) {
        const mapped = options.fkMessages[constraint];
        if (mapped !== undefined) {
          return new MasterDataError(400, 'FOREIGN_KEY_VIOLATION', mapped);
        }
      }
      const msg =
        options.defaultFkMessage !== undefined
          ? options.defaultFkMessage
          : `${options.entityLabel}の関連データ参照が無効、または他データから参照中のため操作できません。`;
      return new MasterDataError(400, 'FOREIGN_KEY_VIOLATION', msg);
    }

    if (code === '23514') {
      return new MasterDataError(
        400,
        'CHECK_CONSTRAINT_VIOLATION',
        `${options.entityLabel}の入力値が規定の範囲・形式を満たしていません。`,
      );
    }

    if (code === '22P02') {
      return new MasterDataError(400, 'INVALID_VALUE_FORMAT', 'IDまたは数値の形式が不正です。');
    }
  }

  return err;
}
