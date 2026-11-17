export class MissingEnvironmentError extends Error {
  constructor(name: string) {
    super(`必須環境変数 '${name}' が設定されていません`);
    this.name = 'MissingEnvironmentError';
  }
}

/**
 * 必須環境変数を取得する（未設定・空文字の場合は即座に例外送出、フォールバック禁止）
 */
export function requireEnv(name: string): string {
  const val = process.env[name];
  if (val === undefined || val.trim() === '') {
    throw new MissingEnvironmentError(name);
  }
  return val;
}
