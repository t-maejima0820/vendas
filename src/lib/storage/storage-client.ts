import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { requireEnv } from '@/lib/env';

export class StorageOperationError extends Error {
  constructor(operation: string, causeMessage: string) {
    super(`Storage 操作失敗 [${operation}]: ${causeMessage}`);
    this.name = 'StorageOperationError';
  }
}

const DEFAULT_BUCKET = 'vendas-attachments';

export interface StorageAdapter {
  upload(params: {
    storageKey: string;
    body: Uint8Array | Buffer;
    contentType: string;
    bucket: string;
  }): Promise<{ path: string }>;
  createSignedUrl(params: {
    storageKey: string;
    expiresInSeconds: number;
    bucket: string;
  }): Promise<string>;
  remove(params: { storageKey: string; bucket: string }): Promise<void>;
}

let testStorageAdapter: StorageAdapter | null = null;

export function setStorageAdapterForTest(adapter: StorageAdapter | null): void {
  testStorageAdapter = adapter;
}

function createStorageOnlyClient(): SupabaseClient {
  return createClient(
    requireEnv('SUPABASE_URL'),
    requireEnv('SUPABASE_SERVICE_ROLE_KEY'),
    {
      auth: {
        persistSession: false,
        autoRefreshToken: false,
      },
    },
  );
}

/**
 * 添付ファイルを Supabase Storage へアップロードする（DB操作は一切行わない）
 */
export async function uploadAttachmentObject(params: {
  storageKey: string;
  body: Uint8Array | Buffer;
  contentType: string;
  bucket?: string;
}): Promise<{ path: string }> {
  const bucket = params.bucket === undefined ? DEFAULT_BUCKET : params.bucket;
  if (testStorageAdapter !== null) {
    return testStorageAdapter.upload({
      storageKey: params.storageKey,
      body: params.body,
      contentType: params.contentType,
      bucket,
    });
  }
  const client = createStorageOnlyClient();
  const { data, error } = await client.storage.from(bucket).upload(params.storageKey, params.body, {
    contentType: params.contentType,
    upsert: false,
  });
  if (error !== null) {
    throw new StorageOperationError('upload', error.message);
  }
  if (data === null) {
    throw new StorageOperationError('upload', 'ストレージ応答 data が null です');
  }
  return { path: data.path };
}

/**
 * 添付ファイル用の非公開 Storage バケットが存在しない場合のみ作成する
 */
export async function ensureAttachmentBucket(
  bucketName?: string,
): Promise<{ bucket: string; created: boolean }> {
  const client = createStorageOnlyClient();
  const bucket = bucketName === undefined ? DEFAULT_BUCKET : bucketName;
  const { data: buckets, error: listError } = await client.storage.listBuckets();
  if (listError !== null) {
    throw new StorageOperationError('listBuckets', listError.message);
  }
  const exists = buckets.some((b) => b.id === bucket || b.name === bucket);
  if (exists) {
    return { bucket, created: false };
  }
  const { error: createError } = await client.storage.createBucket(bucket, {
    public: false,
  });
  if (createError !== null) {
    throw new StorageOperationError('createBucket', createError.message);
  }
  return { bucket, created: true };
}

/**
 * 添付ファイルの署名付きダウンロードURLを発行する
 */
export async function createAttachmentSignedUrl(params: {
  storageKey: string;
  expiresInSeconds: number;
  bucket?: string;
}): Promise<string> {
  const bucket = params.bucket === undefined ? DEFAULT_BUCKET : params.bucket;
  if (testStorageAdapter !== null) {
    return testStorageAdapter.createSignedUrl({
      storageKey: params.storageKey,
      expiresInSeconds: params.expiresInSeconds,
      bucket,
    });
  }
  const client = createStorageOnlyClient();
  const { data, error } = await client.storage.from(bucket).createSignedUrl(params.storageKey, params.expiresInSeconds);
  if (error !== null) {
    throw new StorageOperationError('createSignedUrl', error.message);
  }
  if (data === null) {
    throw new StorageOperationError('createSignedUrl', '署名付きURLが取得できませんでした');
  }
  return data.signedUrl;
}

/**
 * 添付ファイルを Supabase Storage から削除する
 */
export async function removeAttachmentObject(params: {
  storageKey: string;
  bucket?: string;
}): Promise<void> {
  const bucket = params.bucket === undefined ? DEFAULT_BUCKET : params.bucket;
  if (testStorageAdapter !== null) {
    await testStorageAdapter.remove({
      storageKey: params.storageKey,
      bucket,
    });
    return;
  }
  const client = createStorageOnlyClient();
  const { data, error } = await client.storage.from(bucket).remove([params.storageKey]);
  if (error !== null) {
    throw new StorageOperationError('remove', error.message);
  }
  if (data === null) {
    throw new StorageOperationError('remove', 'ストレージ削除応答 data が null です');
  }
}
