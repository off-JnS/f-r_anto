import JSZip from 'jszip';
import { persistZipMedia } from './mediaStore';
import { parseWhatsappText } from './parser';
import type { ChatData } from './types';

const MEDIA_MIMES: Record<string, string> = {
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  png: 'image/png',
  gif: 'image/gif',
  webp: 'image/webp',
  heic: 'image/heic',
  mp4: 'video/mp4',
  mov: 'video/quicktime',
  webm: 'video/webm',
  '3gp': 'video/3gpp',
  opus: 'audio/ogg',
  ogg: 'audio/ogg',
  mp3: 'audio/mpeg',
  m4a: 'audio/mp4',
  aac: 'audio/aac',
  wav: 'audio/wav',
  pdf: 'application/pdf',
};

export type ImportProgress =
  | { stage: 'reading' }
  | { stage: 'parsing' }
  | { stage: 'media'; done: number; total: number };

function guessNameFromFile(fileName: string): string {
  const clean = fileName
    .replace(/\.[^/.]+$/, '')
    .replace(/^WhatsApp Chat (?:mit|with) /i, '');
  return clean || 'Importierter Chat';
}

function normalizeName(name: string): string {
  return name
    .trim()
    .replace(/^_+/, '')
    .replace(/_+$/, '')
    .replace(/\s+/g, ' ');
}

function isGenericChatName(name: string): boolean {
  const normalized = normalizeName(name).toLowerCase();
  return normalized === 'chat' || normalized === 'importierter chat';
}

function participantBasedName(participants: string[]): string {
  const unique = Array.from(
    new Set(participants.map((name) => name.trim()).filter((name) => Boolean(name))),
  );

  if (!unique.length) {
    return 'Importierter Chat';
  }

  if (unique.length === 1) {
    return unique[0];
  }

  return unique.join('-');
}

function resolveChatName(chat: ChatData, preferredName: string): string {
  return isGenericChatName(preferredName)
    ? participantBasedName(chat.participants)
    : preferredName;
}

function scoreWhatsappText(text: string): number {
  const sample = text.split(/\r?\n/).slice(0, 200);
  const starter = /^\[?(\d{1,2}[\/.\-]\d{1,2}[\/.\-]\d{2,4}),?\s\d{1,2}:\d{2}/;
  return sample.reduce((acc, line) => (starter.test(line.replace(/^[\u200E\u200F\uFEFF]+/, '')) ? acc + 1 : acc), 0);
}

function getExtension(fileName: string): string {
  const match = fileName.toLowerCase().match(/\.([a-z0-9]+)$/);
  return match?.[1] ?? '';
}

function buildMediaMap(zip: JSZip): Map<string, { entryName: string; mime: string }> {
  const mediaMap = new Map<string, { entryName: string; mime: string }>();

  for (const entry of Object.values(zip.files)) {
    if (entry.dir) {
      continue;
    }

    const mime = MEDIA_MIMES[getExtension(entry.name)];
    if (!mime) {
      continue;
    }

    const fileName = entry.name.split('/').pop()?.toLowerCase();
    if (fileName) {
      mediaMap.set(fileName, { entryName: entry.name, mime });
    }
  }

  return mediaMap;
}

function chooseTranscript(files: Array<{ name: string; content: string }>): { name: string; content: string } {
  if (files.length === 1) {
    return files[0];
  }

  return files.reduce((best, current) =>
    scoreWhatsappText(current.content) > scoreWhatsappText(best.content) ? current : best,
  );
}

export async function importChat(
  file: File,
  onProgress?: (progress: ImportProgress) => void,
): Promise<ChatData> {
  onProgress?.({ stage: 'reading' });

  if (file.name.toLowerCase().endsWith('.txt')) {
    const content = await file.text();
    onProgress?.({ stage: 'parsing' });
    const preferredName = guessNameFromFile(file.name);
    const chat = parseWhatsappText(content, preferredName);
    chat.name = resolveChatName(chat, preferredName);
    if (!chat.messages.length) {
      throw new Error('Keine Nachrichten erkannt. Ist das ein WhatsApp-Export?');
    }
    return chat;
  }

  if (!file.name.toLowerCase().endsWith('.zip')) {
    throw new Error('Dateityp nicht unterstützt. Bitte .txt oder .zip verwenden.');
  }

  const zip = await JSZip.loadAsync(file);
  const textEntries = Object.values(zip.files).filter(
    (entry) => !entry.dir && entry.name.toLowerCase().endsWith('.txt'),
  );

  if (!textEntries.length) {
    throw new Error('Keine .txt-Chatdatei in der .zip-Datei gefunden.');
  }

  const transcripts: Array<{ name: string; content: string }> = [];
  for (const entry of textEntries) {
    transcripts.push({
      name: entry.name,
      content: await entry.async('text'),
    });
  }

  onProgress?.({ stage: 'parsing' });
  const transcript = chooseTranscript(transcripts);
  const preferredName = guessNameFromFile(transcript.name.split('/').pop() ?? file.name);
  const chat = parseWhatsappText(transcript.content, preferredName);
  chat.name = resolveChatName(chat, preferredName);

  if (!chat.messages.length) {
    throw new Error('Keine Nachrichten erkannt. Ist das ein WhatsApp-Export?');
  }

  const mediaMap = buildMediaMap(zip);
  if (mediaMap.size) {
    onProgress?.({ stage: 'media', done: 0, total: mediaMap.size });
    await persistZipMedia(chat.id, zip, mediaMap, (done, total) => {
      onProgress?.({ stage: 'media', done, total });
    });
  }

  return chat;
}
