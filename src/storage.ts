import type { ChatData, MediaRecord } from './types';

const DB_NAME = 'wa-mirror-db';
const CHATS_STORE = 'chats';
const MEDIA_STORE = 'media';
const LEGACY_STORE = 'state';
const LEGACY_KEY = 'app-state';
const VERSION = 2;

let dbPromise: Promise<IDBDatabase> | null = null;

function mediaRecordKey(chatId: string, mediaKey: string): string {
  return `${chatId}/${mediaKey}`;
}

function openDb(): Promise<IDBDatabase> {
  if (dbPromise) {
    return dbPromise;
  }

  dbPromise = new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, VERSION);

    request.onupgradeneeded = () => {
      const db = request.result;
      const tx = request.transaction;

      if (!db.objectStoreNames.contains(CHATS_STORE)) {
        db.createObjectStore(CHATS_STORE);
      }

      if (!db.objectStoreNames.contains(MEDIA_STORE)) {
        const media = db.createObjectStore(MEDIA_STORE);
        media.createIndex('byChat', 'chatId');
      }

      if (db.objectStoreNames.contains(LEGACY_STORE) && tx) {
        const legacyRead = tx.objectStore(LEGACY_STORE).get(LEGACY_KEY);
        legacyRead.onsuccess = () => {
          const legacy = legacyRead.result as { chats?: ChatData[] } | undefined;
          const chatsStore = tx.objectStore(CHATS_STORE);
          for (const chat of legacy?.chats ?? []) {
            chatsStore.put(chat, chat.id);
          }
          db.deleteObjectStore(LEGACY_STORE);
        };
      }
    };

    request.onsuccess = () => resolve(request.result);
    request.onerror = () => {
      dbPromise = null;
      reject(request.error ?? new Error('Failed to open IndexedDB.'));
    };
  });

  return dbPromise;
}

function awaitTx(tx: IDBTransaction, failure: string): Promise<void> {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error ?? new Error(failure));
    tx.onabort = () => reject(tx.error ?? new Error(failure));
  });
}

export async function loadChats(): Promise<ChatData[]> {
  const db = await openDb();
  const tx = db.transaction(CHATS_STORE, 'readonly');
  const request = tx.objectStore(CHATS_STORE).getAll();

  const chats = await new Promise<ChatData[]>((resolve, reject) => {
    request.onsuccess = () => resolve((request.result as ChatData[]) ?? []);
    request.onerror = () => reject(request.error ?? new Error('Failed to read chats.'));
  });

  return chats.sort((a, b) => b.importedAt - a.importedAt);
}

export async function saveChat(chat: ChatData): Promise<void> {
  const db = await openDb();
  const tx = db.transaction(CHATS_STORE, 'readwrite');
  tx.objectStore(CHATS_STORE).put(chat, chat.id);
  await awaitTx(tx, 'Failed to save chat.');
}

export async function deleteChat(chatId: string): Promise<void> {
  const db = await openDb();
  const tx = db.transaction([CHATS_STORE, MEDIA_STORE], 'readwrite');
  tx.objectStore(CHATS_STORE).delete(chatId);

  const index = tx.objectStore(MEDIA_STORE).index('byChat');
  const cursorRequest = index.openCursor(IDBKeyRange.only(chatId));
  cursorRequest.onsuccess = () => {
    const cursor = cursorRequest.result;
    if (cursor) {
      cursor.delete();
      cursor.continue();
    }
  };

  await awaitTx(tx, 'Failed to delete chat.');
}

export async function clearAllData(): Promise<void> {
  const db = await openDb();
  const tx = db.transaction([CHATS_STORE, MEDIA_STORE], 'readwrite');
  tx.objectStore(CHATS_STORE).clear();
  tx.objectStore(MEDIA_STORE).clear();
  await awaitTx(tx, 'Failed to clear data.');
}

export async function putMediaBatch(records: MediaRecord[]): Promise<void> {
  if (!records.length) {
    return;
  }

  const db = await openDb();
  const tx = db.transaction(MEDIA_STORE, 'readwrite');
  const store = tx.objectStore(MEDIA_STORE);
  for (const record of records) {
    store.put(record, mediaRecordKey(record.chatId, record.key));
  }
  await awaitTx(tx, 'Failed to save media.');
}

export async function getMedia(chatId: string, mediaKey: string): Promise<MediaRecord | null> {
  const db = await openDb();
  const tx = db.transaction(MEDIA_STORE, 'readonly');
  const request = tx.objectStore(MEDIA_STORE).get(mediaRecordKey(chatId, mediaKey));

  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve((request.result as MediaRecord | undefined) ?? null);
    request.onerror = () => reject(request.error ?? new Error('Failed to read media.'));
  });
}
