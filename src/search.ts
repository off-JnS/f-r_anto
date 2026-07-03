import type { ChatData, SearchFilters, SearchResult } from './types';

// Lowercasing 100k+ messages on every keystroke is what kills phones, so the
// haystack list is built once per chat object and reused across searches.
const haystackCache = new WeakMap<ChatData, string[]>();

function getHaystacks(chat: ChatData): string[] {
  let haystacks = haystackCache.get(chat);
  if (!haystacks || haystacks.length !== chat.messages.length) {
    haystacks = chat.messages.map((message) => `${message.sender} ${message.text}`.toLowerCase());
    haystackCache.set(chat, haystacks);
  }
  return haystacks;
}

export function runSearch(chat: ChatData | null, filters: SearchFilters): SearchResult {
  if (!chat) {
    return { indexes: [] };
  }

  const query = filters.query.trim().toLowerCase();
  const senderFilter = filters.sender.trim();
  const hasSenderFilter = Boolean(senderFilter) && senderFilter !== 'all';
  const from = filters.dateFrom ? new Date(`${filters.dateFrom}T00:00:00`).getTime() : null;
  const to = filters.dateTo ? new Date(`${filters.dateTo}T23:59:59`).getTime() : null;

  if (!query && !hasSenderFilter && from === null && to === null) {
    return { indexes: [] };
  }

  const haystacks = query ? getHaystacks(chat) : null;
  const indexes: number[] = [];

  for (let index = 0; index < chat.messages.length; index += 1) {
    const message = chat.messages[index];

    if (hasSenderFilter && message.sender !== senderFilter) {
      continue;
    }

    if (from !== null && message.timestampMs < from) {
      continue;
    }

    if (to !== null && message.timestampMs > to) {
      continue;
    }

    if (haystacks && !haystacks[index].includes(query)) {
      continue;
    }

    indexes.push(index);
  }

  return { indexes };
}
