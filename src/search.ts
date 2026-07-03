import type { ChatData, SearchFilters, SearchResult } from './types';

export function runSearch(chat: ChatData | null, filters: SearchFilters): SearchResult {
  if (!chat) {
    return { indexes: [] };
  }

  const query = filters.query.trim().toLowerCase();
  const hasQuery = Boolean(query);
  const senderFilter = filters.sender.trim();
  const from = filters.dateFrom ? new Date(`${filters.dateFrom}T00:00:00`).getTime() : null;
  const to = filters.dateTo ? new Date(`${filters.dateTo}T23:59:59`).getTime() : null;

  const indexes: number[] = [];

  chat.messages.forEach((message, index) => {
    if (senderFilter && senderFilter !== 'all' && message.sender !== senderFilter) {
      return;
    }

    if (from !== null && message.timestampMs < from) {
      return;
    }

    if (to !== null && message.timestampMs > to) {
      return;
    }

    if (hasQuery) {
      const haystack = `${message.sender} ${message.text}`.toLowerCase();
      if (!haystack.includes(query)) {
        return;
      }
    }

    indexes.push(index);
  });

  return { indexes };
}
