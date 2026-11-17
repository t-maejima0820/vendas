export type MasterApiResult<T> =
  | { ok: true; data: T }
  | { ok: false; error: string; statusCode: number };

export async function requestMasterApi<T>(
  url: string,
  init?: RequestInit,
): Promise<MasterApiResult<T>> {
  try {
    const res = await fetch(url, {
      ...init,
      headers: {
        'Content-Type': 'application/json',
        ...(init?.headers ?? {}),
      },
    });
    const payload = (await res.json()) as { ok?: boolean; error?: string } & T;
    if (!res.ok || payload.ok !== true) {
      const msg =
        typeof payload.error === 'string' && payload.error.length > 0
          ? payload.error
          : `リクエストに失敗しました（ステータス: ${res.status}）`;
      return { ok: false, error: msg, statusCode: res.status };
    }
    return { ok: true, data: payload };
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? `通信エラー: ${err.message}` : '通信エラーが発生しました。',
      statusCode: 0,
    };
  }
}

export function normalizeNullableText(value: string): string | null {
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

export function maskSecretValue(value: string | null): string {
  if (value === null || value.length === 0) {
    return '（未設定）';
  }
  if (value.length <= 4) {
    return '****';
  }
  return `****${value.slice(-4)}`;
}
