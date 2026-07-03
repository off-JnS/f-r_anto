import type { ChatData, ChatMessage, MediaType } from './types';

interface DateParts {
  year: number;
  month: number;
  day: number;
  hours: number;
  minutes: number;
  seconds: number;
}

const DATE = String.raw`(\d{1,2}[\/.\-]\d{1,2}[\/.\-]\d{2,4})`;
const TIME = String.raw`(\d{1,2}:\d{2}(?::\d{2})?\s?(?:AM|PM|am|pm)?)`;

const LINE_PATTERNS = [
  new RegExp(`^${DATE},?\\s${TIME}\\s-\\s([^:]+):\\s([\\s\\S]*)$`),
  new RegExp(`^\\[${DATE},?\\s${TIME}\\]\\s([^:]+):\\s([\\s\\S]*)$`),
] as const;

const SYSTEM_PATTERNS = [
  new RegExp(`^${DATE},?\\s${TIME}\\s-\\s([\\s\\S]*)$`),
  new RegExp(`^\\[${DATE},?\\s${TIME}\\]\\s([\\s\\S]*)$`),
] as const;

interface OmittedMarker {
  pattern: RegExp;
  type: MediaType;
  label: string;
}

const OMITTED_MARKERS: OmittedMarker[] = [
  { pattern: /<?\s*sticker (?:omitted|weggelassen)\s*>?/i, type: 'sticker', label: 'Sticker' },
  { pattern: /<?\s*(?:image|photo|bild) (?:omitted|weggelassen)\s*>?/i, type: 'image', label: 'Foto' },
  { pattern: /<?\s*gif (?:omitted|weggelassen)\s*>?/i, type: 'image', label: 'GIF' },
  { pattern: /<?\s*video (?:omitted|weggelassen)\s*>?/i, type: 'video', label: 'Video' },
  { pattern: /<?\s*audio (?:omitted|weggelassen)\s*>?/i, type: 'audio', label: 'Sprachnachricht' },
  { pattern: /<?\s*(?:document|dokument) (?:omitted|weggelassen)\s*>?/i, type: 'document', label: 'Dokument' },
  { pattern: /<?\s*(?:contact card omitted|kontaktkarte ausgelassen)\s*>?/i, type: 'document', label: 'Kontakt' },
  { pattern: /<\s*(?:media omitted|medien ausgeschlossen|medien weggelassen)\s*>|media omitted/i, type: 'unknown', label: 'Medien' },
];

const FILE_NAME_PATTERN = /([\w\-(). ]+\.(?:jpg|jpeg|png|gif|webp|heic|mp4|mov|webm|3gp|opus|mp3|m4a|aac|ogg|wav|pdf|docx?|xlsx?|pptx?|vcf))/i;
const ATTACHED_PATTERNS = [
  /<(?:attached|anhang):?\s*([^>]+)>/i,
  /([\w\-(). ]+\.\w{2,5})\s\((?:datei angehängt|file attached)\)/i,
] as const;

const EXTENSION_TYPES: Record<string, MediaType> = {
  jpg: 'image', jpeg: 'image', png: 'image', gif: 'image', webp: 'image', heic: 'image',
  mp4: 'video', mov: 'video', webm: 'video', '3gp': 'video',
  opus: 'audio', mp3: 'audio', m4a: 'audio', aac: 'audio', ogg: 'audio', wav: 'audio',
};

export const TYPE_LABELS: Record<MediaType, string> = {
  image: 'Foto',
  sticker: 'Sticker',
  video: 'Video',
  audio: 'Sprachnachricht',
  document: 'Dokument',
  unknown: 'Medien',
};

function toDateParts(datePart: string, timePart: string): DateParts | null {
  const delimiter = datePart.includes('/') ? '/' : datePart.includes('.') ? '.' : '-';
  const raw = datePart.split(delimiter).map((value) => Number(value));
  if (raw.length !== 3 || raw.some((value) => Number.isNaN(value))) {
    return null;
  }

  let [first, second, year] = raw;
  if (year < 100) {
    year += 2000;
  }

  let day: number;
  let month: number;

  if (first > 12 && second <= 12) {
    day = first;
    month = second;
  } else if (second > 12 && first <= 12) {
    day = second;
    month = first;
  } else {
    day = first;
    month = second;
  }

  const cleanedTime = timePart.trim();
  const amPm = cleanedTime.match(/(am|pm)$/i)?.[1]?.toLowerCase();
  const base = cleanedTime.replace(/\s?(am|pm)$/i, '');
  const timeRaw = base.split(':').map((value) => Number(value));

  if (timeRaw.length < 2 || timeRaw.some((value) => Number.isNaN(value))) {
    return null;
  }

  let [hours, minutes, seconds] = [timeRaw[0], timeRaw[1], timeRaw[2] ?? 0];

  if (amPm === 'pm' && hours < 12) {
    hours += 12;
  }
  if (amPm === 'am' && hours === 12) {
    hours = 0;
  }

  return { year, month, day, hours, minutes, seconds };
}

function parseTimestamp(datePart: string, timePart: string): number {
  const parsed = toDateParts(datePart, timePart);
  if (!parsed) {
    return Date.now();
  }

  const localMs = new Date(
    parsed.year,
    parsed.month - 1,
    parsed.day,
    parsed.hours,
    parsed.minutes,
    parsed.seconds,
  ).getTime();

  return Number.isNaN(localMs) ? Date.now() : localMs;
}

function timestampLabel(timestampMs: number): string {
  return new Date(timestampMs).toLocaleTimeString('de-DE', {
    hour: '2-digit',
    minute: '2-digit',
  });
}

function dayKey(timestampMs: number): string {
  return new Date(timestampMs).toLocaleDateString('de-DE');
}

interface MediaInfo {
  isMedia: boolean;
  mediaType: MediaType;
  mediaName?: string;
  caption?: string;
}

function typeForFileName(fileName: string): MediaType {
  if (/^stk-|sticker/i.test(fileName)) {
    return 'sticker';
  }

  const extension = fileName.toLowerCase().match(/\.([a-z0-9]+)$/)?.[1] ?? '';
  return EXTENSION_TYPES[extension] ?? 'document';
}

function detectMedia(body: string): MediaInfo {
  for (const marker of OMITTED_MARKERS) {
    const match = body.match(marker.pattern);
    if (match) {
      const caption = body.replace(marker.pattern, '').trim();
      return { isMedia: true, mediaType: marker.type, caption: caption || undefined };
    }
  }

  for (const pattern of ATTACHED_PATTERNS) {
    const match = body.match(pattern);
    if (match) {
      const mediaName = match[1].trim();
      const caption = body.replace(match[0], '').trim();
      return {
        isMedia: true,
        mediaType: typeForFileName(mediaName),
        mediaName,
        caption: caption || undefined,
      };
    }
  }

  const bareFile = body.trim().match(FILE_NAME_PATTERN);
  if (bareFile && bareFile[1].trim().length >= body.trim().length - 2) {
    const mediaName = bareFile[1].trim();
    return { isMedia: true, mediaType: typeForFileName(mediaName), mediaName };
  }

  return { isMedia: false, mediaType: 'unknown' };
}

function inferOwner(messages: ChatMessage[]): string {
  const firstUserMessage = messages.find((message) => message.kind !== 'system');
  return firstUserMessage?.sender ?? 'Ich';
}

export function parseWhatsappText(text: string, chatName: string): ChatData {
  const lines = text.replace(/\r\n/g, '\n').split('\n');
  const messages: ChatMessage[] = [];

  for (const line of lines) {
    const cleanedLine = line
      .replace(/[\u200E\u200F\u202A-\u202E\uFEFF]/g, '')
      .replace(/[\u202F\u00A0]/g, ' ');

    if (!cleanedLine.trim()) {
      continue;
    }

    let matched = false;

    for (const pattern of LINE_PATTERNS) {
      const result = cleanedLine.match(pattern);
      if (!result) {
        continue;
      }

      const [, datePart, timePart, senderRaw, body] = result;
      const sender = senderRaw.trim();
      const timestampMs = parseTimestamp(datePart, timePart);
      const mediaInfo = detectMedia(body);

      messages.push({
        id: `${messages.length}-${timestampMs}`,
        timestampMs,
        timestampLabel: timestampLabel(timestampMs),
        dayKey: dayKey(timestampMs),
        sender,
        text: mediaInfo.isMedia
          ? mediaInfo.caption ?? TYPE_LABELS[mediaInfo.mediaType]
          : body.trim(),
        kind: mediaInfo.isMedia ? 'media' : 'text',
        mediaType: mediaInfo.isMedia ? mediaInfo.mediaType : undefined,
        mediaKey: mediaInfo.mediaName?.toLowerCase(),
        mediaName: mediaInfo.mediaName,
      });

      matched = true;
      break;
    }

    if (matched) {
      continue;
    }

    for (const pattern of SYSTEM_PATTERNS) {
      const result = cleanedLine.match(pattern);
      if (!result) {
        continue;
      }

      const [, datePart, timePart, body] = result;
      const timestampMs = parseTimestamp(datePart, timePart);

      messages.push({
        id: `${messages.length}-${timestampMs}`,
        timestampMs,
        timestampLabel: timestampLabel(timestampMs),
        dayKey: dayKey(timestampMs),
        sender: 'System',
        text: body.trim(),
        kind: 'system',
      });

      matched = true;
      break;
    }

    if (!matched && messages.length) {
      const previous = messages[messages.length - 1];
      const isBareLabel =
        previous.kind === 'media' && previous.text === TYPE_LABELS[previous.mediaType ?? 'unknown'];
      previous.text = isBareLabel ? cleanedLine : `${previous.text}\n${cleanedLine}`;
    }
  }

  const participants = Array.from(
    new Set(messages.filter((msg) => msg.kind !== 'system').map((msg) => msg.sender)),
  );

  return {
    id: crypto.randomUUID(),
    name: chatName,
    importedAt: Date.now(),
    owner: inferOwner(messages),
    participants,
    messages,
  };
}
