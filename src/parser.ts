import type { ChatData, ChatMessage } from './types';

interface DateParts {
  year: number;
  month: number;
  day: number;
  hours: number;
  minutes: number;
  seconds: number;
}

const LINE_PATTERNS = [
  /^(\d{1,2}[\/.\-]\d{1,2}[\/.\-]\d{2,4}),\s(\d{1,2}:\d{2}(?::\d{2})?\s?(?:AM|PM|am|pm)?)\s-\s([^:]+):\s([\s\S]*)$/,
  /^\[(\d{1,2}[\/.\-]\d{1,2}[\/.\-]\d{2,4}),\s(\d{1,2}:\d{2}(?::\d{2})?\s?(?:AM|PM|am|pm)?)\]\s([^:]+):\s([\s\S]*)$/,
  /^(\d{1,2}[\/.\-]\d{1,2}[\/.\-]\d{2,4}),\s(\d{1,2}:\d{2}(?::\d{2})?)\s-\s([^:]+):\s([\s\S]*)$/,
] as const;

const SYSTEM_PATTERNS = [
  /^(\d{1,2}[\/.\-]\d{1,2}[\/.\-]\d{2,4}),\s(\d{1,2}:\d{2}(?::\d{2})?\s?(?:AM|PM|am|pm)?)\s-\s([\s\S]*)$/,
  /^\[(\d{1,2}[\/.\-]\d{1,2}[\/.\-]\d{2,4}),\s(\d{1,2}:\d{2}(?::\d{2})?\s?(?:AM|PM|am|pm)?)\]\s([\s\S]*)$/,
] as const;

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

  const utcMs = Date.UTC(
    parsed.year,
    parsed.month - 1,
    parsed.day,
    parsed.hours,
    parsed.minutes,
    parsed.seconds,
  );
  const localMs = new Date(
    parsed.year,
    parsed.month - 1,
    parsed.day,
    parsed.hours,
    parsed.minutes,
    parsed.seconds,
  ).getTime();

  return Number.isNaN(localMs) ? utcMs : localMs;
}

function timestampLabel(timestampMs: number): string {
  return new Date(timestampMs).toLocaleTimeString([], {
    hour: '2-digit',
    minute: '2-digit',
  });
}

function dayKey(timestampMs: number): string {
  return new Date(timestampMs).toLocaleDateString();
}

function detectMedia(text: string): { mediaName?: string; isMedia: boolean } {
  const filenameMatch = text.match(/([\w\-(). ]+\.(?:jpg|jpeg|png|gif|webp|heic|mp4|mov|opus|mp3|m4a|pdf|docx?|xlsx?|pptx?))/i);
  const omitted = /<media omitted>|omitted/i.test(text);

  return {
    mediaName: filenameMatch?.[1]?.trim(),
    isMedia: omitted || Boolean(filenameMatch),
  };
}

function inferOwner(messages: ChatMessage[]): string {
  const counts = new Map<string, number>();
  for (const message of messages) {
    if (message.kind === 'system') {
      continue;
    }
    counts.set(message.sender, (counts.get(message.sender) ?? 0) + 1);
  }

  const sorted = [...counts.entries()].sort((a, b) => b[1] - a[1]);
  return sorted[0]?.[0] ?? 'You';
}

export function parseWhatsappText(
  text: string,
  chatName: string,
  mediaLookup: Map<string, { url: string; mime: string }>,
): ChatData {
  const lines = text.replace(/\r\n/g, '\n').split('\n');
  const messages: ChatMessage[] = [];

  for (const line of lines) {
    if (!line.trim()) {
      continue;
    }

    let matched = false;

    for (const pattern of LINE_PATTERNS) {
      const result = line.match(pattern);
      if (!result) {
        continue;
      }

      const [, datePart, timePart, senderRaw, body] = result;
      const sender = senderRaw.trim();
      const timestampMs = parseTimestamp(datePart, timePart);
      const mediaInfo = detectMedia(body);
      const mediaRef = mediaInfo.mediaName
        ? mediaLookup.get(mediaInfo.mediaName.toLowerCase())
        : undefined;

      messages.push({
        id: `${messages.length}-${timestampMs}`,
        timestampMs,
        timestampLabel: timestampLabel(timestampMs),
        dayKey: dayKey(timestampMs),
        sender,
        text: body.trim(),
        kind: mediaInfo.isMedia ? 'media' : 'text',
        mediaName: mediaInfo.mediaName,
        mediaUrl: mediaRef?.url,
        mediaMime: mediaRef?.mime,
      });

      matched = true;
      break;
    }

    if (matched) {
      continue;
    }

    for (const pattern of SYSTEM_PATTERNS) {
      const result = line.match(pattern);
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
      previous.text = `${previous.text}\n${line}`;
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
