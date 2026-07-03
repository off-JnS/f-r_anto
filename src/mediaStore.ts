import type JSZip from 'jszip';
import { getMedia, putMediaBatch } from './storage';
import type { MediaRecord } from './types';

interface MediaPreview {
  url: string;
  mime: string;
}

// Object URLs pin blobs in memory, so keep a bounded LRU and revoke evicted
// entries; the blob itself stays in IndexedDB and reloads on demand.
const MAX_CACHED_URLS = 80;
const PERSIST_BATCH_SIZE = 16;

const urlCache = new Map<string, MediaPreview>();

function cacheKey(chatId: string, mediaKey: string): string {
  return `${chatId}/${mediaKey}`;
}

function rememberUrl(key: string, preview: MediaPreview): void {
  urlCache.set(key, preview);

  while (urlCache.size > MAX_CACHED_URLS) {
    const oldestKey = urlCache.keys().next().value as string;
    const oldest = urlCache.get(oldestKey);
    urlCache.delete(oldestKey);
    if (oldest) {
      URL.revokeObjectURL(oldest.url);
    }
  }
}

export function getCachedPreview(chatId: string, mediaKey: string): MediaPreview | null {
  const key = cacheKey(chatId, mediaKey);
  const cached = urlCache.get(key);
  if (!cached) {
    return null;
  }

  // Refresh LRU position.
  urlCache.delete(key);
  urlCache.set(key, cached);
  return cached;
}

export async function loadMediaPreview(
  chatId: string,
  mediaKey: string,
): Promise<MediaPreview | null> {
  const cached = getCachedPreview(chatId, mediaKey);
  if (cached) {
    return cached;
  }

  const record = await getMedia(chatId, mediaKey);
  if (!record) {
    return null;
  }

  const preview: MediaPreview = {
    url: URL.createObjectURL(record.blob),
    mime: record.mime,
  };
  rememberUrl(cacheKey(chatId, mediaKey), preview);
  return preview;
}

export function releaseChatPreviews(chatId: string): void {
  const prefix = `${chatId}/`;
  for (const [key, preview] of urlCache) {
    if (key.startsWith(prefix)) {
      urlCache.delete(key);
      URL.revokeObjectURL(preview.url);
    }
  }
}

export async function persistZipMedia(
  chatId: string,
  zip: JSZip,
  entries: Map<string, { entryName: string; mime: string }>,
  onProgress?: (done: number, total: number) => void,
): Promise<void> {
  const total = entries.size;
  let done = 0;
  let batch: MediaRecord[] = [];

  for (const [mediaKey, source] of entries) {
    const zipEntry = zip.file(source.entryName);
    if (!zipEntry) {
      done += 1;
      continue;
    }

    const blob = await zipEntry.async('blob');
    batch.push({
      chatId,
      key: mediaKey,
      name: source.entryName.split('/').pop() ?? mediaKey,
      mime: source.mime,
      blob,
    });

    done += 1;
    onProgress?.(done, total);

    if (batch.length >= PERSIST_BATCH_SIZE) {
      await putMediaBatch(batch);
      batch = [];
    }
  }

  await putMediaBatch(batch);
}
