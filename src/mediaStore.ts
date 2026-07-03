import JSZip from 'jszip';

interface MediaSource {
  entryName: string;
  mime: string;
}

interface RuntimeMediaStore {
  zip: JSZip;
  entries: Map<string, MediaSource>;
  cache: Map<string, string>;
}

const chatMedia = new Map<string, RuntimeMediaStore>();

export function registerChatMedia(
  chatId: string,
  zip: JSZip,
  entries: Map<string, MediaSource>,
): void {
  chatMedia.set(chatId, {
    zip,
    entries,
    cache: new Map(),
  });
}

export async function loadMediaPreview(
  chatId: string,
  mediaKey: string,
): Promise<{ url: string; mime: string } | null> {
  const store = chatMedia.get(chatId);
  if (!store) {
    return null;
  }

  const source = store.entries.get(mediaKey);
  if (!source) {
    return null;
  }

  const cached = store.cache.get(mediaKey);
  if (cached) {
    return { url: cached, mime: source.mime };
  }

  const zipEntry = store.zip.file(source.entryName);
  if (!zipEntry) {
    return null;
  }

  const blob = await zipEntry.async('blob');
  const url = URL.createObjectURL(blob);
  store.cache.set(mediaKey, url);

  return { url, mime: source.mime };
}
