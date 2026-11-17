import crypto from 'node:crypto';

const CIPHER_PREFIX = 'enc:v1:';
const IV_BYTES = 12;
const KEY_BYTES = 32;

const ARGON2_PREFIX = '$argon2id$v=19$';
const ARGON2_MEM_KIB = 19456;
const ARGON2_PASSES = 2;
const ARGON2_PARALLELISM = 1;
const ARGON2_TAG_LEN = 32;

interface NodeCryptoWithArgon2 {
  argon2Sync?: (
    algorithm: 'argon2id',
    parameters: {
      message: string | Buffer;
      nonce: Buffer;
      parallelism: number;
      passes: number;
      memory: number;
      tagLength: number;
    },
  ) => Buffer;
}

export class CryptoCipherError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CryptoCipherError';
  }
}

function parseHexKey(keyHex: string): Buffer {
  const trimmed = keyHex.trim();
  if (!/^[0-9a-fA-F]{64}$/.test(trimmed)) {
    throw new CryptoCipherError('暗号化鍵は64文字の16進文字列 (32バイト) である必要があります');
  }
  const key = Buffer.from(trimmed, 'hex');
  if (key.length !== KEY_BYTES) {
    throw new CryptoCipherError('暗号化鍵のサイズが32バイトではありません');
  }
  return key;
}

export function isEncryptedField(value: string): boolean {
  return value.startsWith(CIPHER_PREFIX);
}

/**
 * 機密項目（口座番号等）を AES-256-GCM ("enc:v1:<iv_b64>:<tag_b64>:<cipher_b64>") で暗号化する
 */
export function encryptField(plainText: string, keyHex: string): string {
  const key = parseHexKey(keyHex);
  const iv = crypto.randomBytes(IV_BYTES);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const encrypted = Buffer.concat([cipher.update(plainText, 'utf8'), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return `${CIPHER_PREFIX}${iv.toString('base64')}:${authTag.toString('base64')}:${encrypted.toString('base64')}`;
}

/**
 * AES-256-GCM 暗号化文字列を復号する（改ざん検知付き）
 */
export function decryptField(cipherText: string, keyHex: string): string {
  if (!cipherText.startsWith(CIPHER_PREFIX)) {
    throw new CryptoCipherError('復号対象の形式が不正です (enc:v1: プレフィックス必須)');
  }
  const body = cipherText.slice(CIPHER_PREFIX.length);
  const parts = body.split(':');
  if (parts.length !== 3) {
    throw new CryptoCipherError('暗号化フィールドのセグメント数が不正です');
  }
  const [ivB64, tagB64, dataB64] = parts;
  if (ivB64 === undefined || tagB64 === undefined || dataB64 === undefined) {
    throw new CryptoCipherError('暗号化フィールドの分解に失敗しました');
  }
  const key = parseHexKey(keyHex);
  const iv = Buffer.from(ivB64, 'base64');
  const authTag = Buffer.from(tagB64, 'base64');
  const encrypted = Buffer.from(dataB64, 'base64');

  const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(authTag);
  const decrypted = Buffer.concat([decipher.update(encrypted), decipher.final()]);
  return decrypted.toString('utf8');
}

function deriveArgon2id(password: string, nonce: Buffer, memory: number, passes: number, parallelism: number): Buffer {
  const cryptoExt = crypto as unknown as NodeCryptoWithArgon2;
  if (typeof cryptoExt.argon2Sync !== 'function') {
    throw new CryptoCipherError('Node.js ランタイムが argon2id をサポートしていません (Node 24+ が必要です)');
  }
  return cryptoExt.argon2Sync('argon2id', {
    message: password,
    nonce,
    parallelism,
    passes,
    memory,
    tagLength: ARGON2_TAG_LEN,
  });
}

/**
 * パスワードを Argon2id で不可逆ハッシュ化する
 */
export function hashPassword(password: string): string {
  if (password.length === 0) {
    throw new CryptoCipherError('空パスワードはハッシュ化できません');
  }
  const salt = crypto.randomBytes(16);
  const digest = deriveArgon2id(password, salt, ARGON2_MEM_KIB, ARGON2_PASSES, ARGON2_PARALLELISM);
  return `${ARGON2_PREFIX}m=${ARGON2_MEM_KIB},t=${ARGON2_PASSES},p=${ARGON2_PARALLELISM}$${salt.toString('base64')}$${digest.toString('base64')}`;
}

/**
 * Argon2id ハッシュと平文パスワードを定数時間比較で検証する
 */
export function verifyPassword(password: string, storedHash: string): boolean {
  if (!storedHash.startsWith(ARGON2_PREFIX)) {
    return false;
  }
  const rest = storedHash.slice(ARGON2_PREFIX.length);
  const segments = rest.split('$');
  if (segments.length !== 3) {
    return false;
  }
  const [paramStr, saltB64, hashB64] = segments;
  if (paramStr === undefined || saltB64 === undefined || hashB64 === undefined) {
    return false;
  }
  const match = /^m=(\d+),t=(\d+),p=(\d+)$/.exec(paramStr);
  if (match === null) {
    return false;
  }
  const mem = Number(match[1]);
  const passes = Number(match[2]);
  const parallelism = Number(match[3]);
  const salt = Buffer.from(saltB64, 'base64');
  const expected = Buffer.from(hashB64, 'base64');
  const actual = deriveArgon2id(password, salt, mem, passes, parallelism);
  if (actual.length !== expected.length) {
    return false;
  }
  return crypto.timingSafeEqual(actual, expected);
}
