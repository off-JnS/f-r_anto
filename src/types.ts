export type MessageKind = 'text' | 'system' | 'media';

export type MediaType = 'image' | 'sticker' | 'video' | 'audio' | 'document' | 'unknown';

export interface ChatMessage {
  id: string;
  timestampMs: number;
  timestampLabel: string;
  dayKey: string;
  sender: string;
  text: string;
  kind: MessageKind;
  mediaType?: MediaType;
  mediaKey?: string;
  mediaName?: string;
}

export interface ChatData {
  id: string;
  name: string;
  importedAt: number;
  owner: string;
  participants: string[];
  messages: ChatMessage[];
}

export interface SearchFilters {
  query: string;
  sender: string;
  dateFrom: string;
  dateTo: string;
}

export interface SearchResult {
  indexes: number[];
}

export interface MediaRecord {
  chatId: string;
  key: string;
  name: string;
  mime: string;
  blob: Blob;
}
