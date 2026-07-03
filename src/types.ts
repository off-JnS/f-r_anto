export type MessageKind = 'text' | 'system' | 'media';

export interface ChatMessage {
  id: string;
  timestampMs: number;
  timestampLabel: string;
  dayKey: string;
  sender: string;
  text: string;
  kind: MessageKind;
  mediaKey?: string;
  mediaName?: string;
  mediaUrl?: string;
  mediaMime?: string;
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
