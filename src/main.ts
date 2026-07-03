import './style.css';
import { importChat } from './importer';
import { getCachedPreview, loadMediaPreview, releaseChatPreviews } from './mediaStore';
import { TYPE_LABELS } from './parser';
import { runSearch } from './search';
import { clearAllData, deleteChat, loadChats, saveChat } from './storage';
import type { ChatData, ChatMessage, SearchFilters } from './types';

const MESSAGE_WINDOW_SIZE = 250;
const SEARCH_CONTEXT_RADIUS = 2;
// In search mode only the matches around the active one get DOM nodes;
// rendering every match freezes phones on short queries in big chats.
const SEARCH_MATCH_SPAN = 30;
const SEARCH_DEBOUNCE_MS = 200;
const SCROLL_LOAD_THRESHOLD_PX = 400;

const SENDER_COLORS = [
  '#00a884', '#53bdeb', '#e542a3', '#fa6533',
  '#ffbc38', '#8b7bf5', '#26c4dc', '#f0716c',
];

const ICONS = {
  back: '<svg viewBox="0 0 24 24" width="22" height="22" fill="currentColor"><path d="M15.4 4.6 8 12l7.4 7.4 1.4-1.4-6-6 6-6z"/></svg>',
  search: '<svg viewBox="0 0 24 24" width="18" height="18" fill="currentColor"><path d="M15.5 14h-.8l-.3-.3a6.5 6.5 0 1 0-.7.7l.3.3v.8l5 5 1.5-1.5zm-6 0a4.5 4.5 0 1 1 0-9 4.5 4.5 0 0 1 0 9z"/></svg>',
  up: '<svg viewBox="0 0 24 24" width="20" height="20" fill="currentColor"><path d="M12 8.6 5.6 15l1.4 1.4 5-5 5 5L18.4 15z"/></svg>',
  down: '<svg viewBox="0 0 24 24" width="20" height="20" fill="currentColor"><path d="m12 15.4 6.4-6.4L17 7.6l-5 5-5-5L5.6 9z"/></svg>',
  trash: '<svg viewBox="0 0 24 24" width="17" height="17" fill="currentColor"><path d="M6 19a2 2 0 0 0 2 2h8a2 2 0 0 0 2-2V7H6zM19 4h-3.5l-1-1h-5l-1 1H5v2h14z"/></svg>',
  plus: '<svg viewBox="0 0 24 24" width="24" height="24" fill="currentColor"><path d="M19 13h-6v6h-2v-6H5v-2h6V5h2v6h6z"/></svg>',
  ticks: '<svg class="ticks" viewBox="0 0 18 11" width="17" height="11" fill="currentColor"><path d="M12.03.93 5.7 7.26 3.42 4.98 2.1 6.3l3.6 3.6L13.35 2.25zM16.58.93l-6.33 6.33-.66-.66-1.32 1.32 1.98 1.98L17.9 2.25z"/></svg>',
  play: '<svg viewBox="0 0 24 24" width="30" height="30" fill="currentColor"><path d="M8 5v14l11-7z"/></svg>',
  mic: '<svg viewBox="0 0 24 24" width="22" height="22" fill="currentColor"><path d="M12 14a3 3 0 0 0 3-3V5a3 3 0 0 0-6 0v6a3 3 0 0 0 3 3zm5-3a5 5 0 0 1-10 0H5a7 7 0 0 0 6 6.92V21h2v-3.08A7 7 0 0 0 19 11z"/></svg>',
  doc: '<svg viewBox="0 0 24 24" width="24" height="24" fill="currentColor"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8zm-1 7V3.5L18.5 9z"/></svg>',
  image: '<svg viewBox="0 0 24 24" width="26" height="26" fill="currentColor"><path d="M21 19V5a2 2 0 0 0-2-2H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2zM8.5 13.5l2.5 3 3.5-4.5 4.5 6H5z"/></svg>',
} as const;

const app = document.querySelector<HTMLDivElement>('#app');

if (!app) {
  throw new Error('Missing #app root element.');
}

app.innerHTML = `
  <div class="shell">
    <section id="home-screen" class="home-screen">
      <header class="home-header">
        <h1>Chats</h1>
      </header>
      <div class="home-body">
        <div class="import-card">
          <p class="import-hint">WhatsApp-Export als .txt oder .zip importieren. Alles bleibt auf diesem Gerät.</p>
          <label class="upload-btn" for="chat-upload">Datei auswählen</label>
          <input id="chat-upload" class="hidden-input" type="file" accept=".txt,.zip" multiple />
          <div id="pending-upload" class="pending-upload">Keine Datei ausgewählt.</div>
          <button id="start-import" class="primary-action" type="button" disabled>Importieren</button>
        </div>
        <div id="home-chat-list" class="home-chat-list"></div>
        <button id="clear-data" class="danger-link" type="button">Alle lokalen Chats löschen</button>
      </div>
      <label class="fab" for="chat-upload" aria-label="Neuen Chat importieren">${ICONS.plus}</label>
    </section>

    <section id="chat-screen" class="chat-screen hidden">
      <header class="chat-header">
        <button id="back-home" class="icon-btn" type="button" aria-label="Zurück zu den Chats">${ICONS.back}</button>
        <div id="chat-avatar" class="avatar" aria-hidden="true"></div>
        <div class="chat-heading">
          <h2 id="chat-title">Chat</h2>
          <p id="chat-meta"></p>
        </div>
        <select id="owner-select" aria-label="Wer bin ich?"><option value="">Ich bin…</option></select>
      </header>
      <div class="search-row">
        <span class="search-icon" aria-hidden="true">${ICONS.search}</span>
        <input id="sticky-query" type="search" placeholder="Suchen…" enterkeyhint="search" autocomplete="off" />
        <span id="match-count" class="match-count"></span>
        <button id="sticky-prev" class="icon-btn" type="button" aria-label="Älterer Treffer">${ICONS.up}</button>
        <button id="sticky-next" class="icon-btn" type="button" aria-label="Neuerer Treffer">${ICONS.down}</button>
      </div>
      <section id="messages" class="messages"></section>
    </section>
  </div>

  <div id="lightbox" class="lightbox hidden" role="dialog" aria-label="Bildansicht">
    <img id="lightbox-img" alt="Vergrößerte Ansicht" />
  </div>
`;

function must<T extends Element>(selector: string): T {
  const node = document.querySelector<T>(selector);
  if (!node) {
    throw new Error(`Missing required UI element: ${selector}`);
  }
  return node;
}

const elements = {
  stickyQuery: must<HTMLInputElement>('#sticky-query'),
  stickyPrev: must<HTMLButtonElement>('#sticky-prev'),
  stickyNext: must<HTMLButtonElement>('#sticky-next'),
  matchCount: must<HTMLSpanElement>('#match-count'),
  upload: must<HTMLInputElement>('#chat-upload'),
  startImport: must<HTMLButtonElement>('#start-import'),
  pendingUpload: must<HTMLDivElement>('#pending-upload'),
  clearData: must<HTMLButtonElement>('#clear-data'),
  homeScreen: must<HTMLElement>('#home-screen'),
  chatScreen: must<HTMLElement>('#chat-screen'),
  homeChatList: must<HTMLDivElement>('#home-chat-list'),
  backHome: must<HTMLButtonElement>('#back-home'),
  chatAvatar: must<HTMLDivElement>('#chat-avatar'),
  chatTitle: must<HTMLHeadingElement>('#chat-title'),
  chatMeta: must<HTMLParagraphElement>('#chat-meta'),
  owner: must<HTMLSelectElement>('#owner-select'),
  messages: must<HTMLElement>('#messages'),
  lightbox: must<HTMLDivElement>('#lightbox'),
  lightboxImg: must<HTMLImageElement>('#lightbox-img'),
};

const state: {
  chats: ChatData[];
  selectedChatId: string | null;
  filters: SearchFilters;
  matchedIndexes: number[];
  activeMatch: number;
  visibleStartIndex: number;
  pendingFiles: File[];
  importing: boolean;
  loadingOlder: boolean;
} = {
  chats: [],
  selectedChatId: null,
  filters: { query: '', sender: 'all', dateFrom: '', dateTo: '' },
  matchedIndexes: [],
  activeMatch: -1,
  visibleStartIndex: 0,
  pendingFiles: [],
  importing: false,
  loadingOlder: false,
};

const loadingPreviewKeys = new Set<string>();
let searchDebounceTimer: number | undefined;

function escapeHtml(text: string): string {
  return text
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function highlighted(text: string, query: string): string {
  const trimmedQuery = query.trim();
  if (!trimmedQuery) {
    return escapeHtml(text).replaceAll('\n', '<br/>');
  }

  const lower = text.toLowerCase();
  const token = trimmedQuery.toLowerCase();
  if (!lower.includes(token)) {
    return escapeHtml(text).replaceAll('\n', '<br/>');
  }

  let out = '';
  let cursor = 0;

  while (cursor < text.length) {
    const next = lower.indexOf(token, cursor);
    if (next === -1) {
      out += escapeHtml(text.slice(cursor));
      break;
    }

    out += escapeHtml(text.slice(cursor, next));
    out += `<mark>${escapeHtml(text.slice(next, next + token.length))}</mark>`;
    cursor = next + token.length;
  }

  return out.replaceAll('\n', '<br/>');
}

function senderColor(name: string): string {
  let hash = 0;
  for (let i = 0; i < name.length; i += 1) {
    hash = (hash * 31 + name.charCodeAt(i)) | 0;
  }
  return SENDER_COLORS[Math.abs(hash) % SENDER_COLORS.length];
}

function initials(name: string): string {
  const parts = name.trim().split(/\s+/);
  const first = parts[0]?.[0] ?? '?';
  const second = parts.length > 1 ? parts[parts.length - 1][0] : '';
  return (first + second).toUpperCase();
}

function selectedChat(): ChatData | null {
  return state.chats.find((chat) => chat.id === state.selectedChatId) ?? null;
}

function hasSearchQuery(): boolean {
  return Boolean(state.filters.query.trim());
}

function isSameDay(a: Date, b: Date): boolean {
  return (
    a.getFullYear() === b.getFullYear() &&
    a.getMonth() === b.getMonth() &&
    a.getDate() === b.getDate()
  );
}

function dayLabel(timestampMs: number): string {
  const date = new Date(timestampMs);
  const now = new Date();
  const yesterday = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1);

  if (isSameDay(date, now)) {
    return 'Heute';
  }
  if (isSameDay(date, yesterday)) {
    return 'Gestern';
  }

  const ageDays = (now.getTime() - date.getTime()) / 86_400_000;
  if (ageDays > 0 && ageDays < 7) {
    return date.toLocaleDateString('de-DE', { weekday: 'long' });
  }

  return date.toLocaleDateString('de-DE');
}

function listTimeLabel(timestampMs: number): string {
  const date = new Date(timestampMs);
  const now = new Date();
  if (isSameDay(date, now)) {
    return date.toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit' });
  }
  const yesterday = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1);
  if (isSameDay(date, yesterday)) {
    return 'Gestern';
  }
  return date.toLocaleDateString('de-DE', { day: '2-digit', month: '2-digit', year: '2-digit' });
}

function messagePreviewText(message: ChatMessage | undefined): string {
  if (!message) {
    return 'Keine Nachrichten';
  }
  const text = message.text.replaceAll('\n', ' ');
  return text.length > 60 ? `${text.slice(0, 60)}…` : text;
}

function resetVisibleWindow(chat: ChatData | null): void {
  state.visibleStartIndex = chat ? Math.max(0, chat.messages.length - MESSAGE_WINDOW_SIZE) : 0;
}

function getRenderedIndexes(chat: ChatData): { indexes: number[]; hiddenOlderCount: number; matchSet: Set<number> } {
  if (hasSearchQuery()) {
    const matches = state.matchedIndexes;
    if (!matches.length) {
      return { indexes: [], hiddenOlderCount: 0, matchSet: new Set() };
    }

    const center = state.activeMatch >= 0 ? state.activeMatch : matches.length - 1;
    const fromMatch = Math.max(0, center - SEARCH_MATCH_SPAN);
    const toMatch = Math.min(matches.length - 1, center + SEARCH_MATCH_SPAN);

    const bucket = new Set<number>();
    const matchSet = new Set<number>();

    for (let m = fromMatch; m <= toMatch; m += 1) {
      const matchIndex = matches[m];
      matchSet.add(matchIndex);
      const start = Math.max(0, matchIndex - SEARCH_CONTEXT_RADIUS);
      const end = Math.min(chat.messages.length - 1, matchIndex + SEARCH_CONTEXT_RADIUS);
      for (let index = start; index <= end; index += 1) {
        bucket.add(index);
      }
    }

    const indexes = [...bucket].sort((a, b) => a - b);
    return { indexes, hiddenOlderCount: indexes[0] ?? 0, matchSet };
  }

  const start = Math.max(0, state.visibleStartIndex);
  const indexes: number[] = [];
  for (let index = start; index < chat.messages.length; index += 1) {
    indexes.push(index);
  }

  return { indexes, hiddenOlderCount: start, matchSet: new Set() };
}

function loadOlderMessages(): void {
  if (state.loadingOlder || state.visibleStartIndex <= 0 || hasSearchQuery()) {
    return;
  }

  state.loadingOlder = true;
  const previousHeight = elements.messages.scrollHeight;
  const previousTop = elements.messages.scrollTop;
  state.visibleStartIndex = Math.max(0, state.visibleStartIndex - MESSAGE_WINDOW_SIZE);
  renderChat();

  requestAnimationFrame(() => {
    elements.messages.scrollTop = elements.messages.scrollHeight - previousHeight + previousTop;
    state.loadingOlder = false;
  });
}

function mediaSlotHtml(message: ChatMessage, preview: { url: string; mime: string } | null): string {
  const type = message.mediaType ?? 'unknown';

  if (type === 'audio') {
    if (preview) {
      return `<div class="voice-note">${ICONS.mic}<audio controls preload="metadata" src="${preview.url}"></audio></div>`;
    }
    return `<div class="voice-note missing">${ICONS.mic}<span>${escapeHtml(message.text)}</span></div>`;
  }

  if (type === 'video') {
    if (preview) {
      return `<div class="media-chip video"><video controls playsinline preload="metadata" src="${preview.url}"></video></div>`;
    }
    return `<div class="media-chip placeholder">${ICONS.play}<span>Video</span></div>`;
  }

  if (type === 'document') {
    const name = message.mediaName ?? message.text;
    const inner = `<span class="doc-icon">${ICONS.doc}</span><span class="doc-name">${escapeHtml(name)}</span>`;
    if (preview) {
      return `<a class="doc-chip" href="${preview.url}" download="${escapeHtml(name)}">${inner}</a>`;
    }
    return `<div class="doc-chip missing">${inner}</div>`;
  }

  const stickerClass = type === 'sticker' ? ' sticker' : '';
  if (preview) {
    return `<div class="media-chip${stickerClass}"><img src="${preview.url}" alt="${type === 'sticker' ? 'Sticker' : 'Foto'}" loading="lazy" /></div>`;
  }
  return `<div class="media-chip placeholder${stickerClass}">${ICONS.image}<span>${escapeHtml(message.text)}</span></div>`;
}

function bubbleInnerHtml(chat: ChatData, message: ChatMessage, index: number, showSender: boolean): string {
  const mine = message.sender === chat.owner;
  const senderHtml = showSender
    ? `<div class="sender" style="color:${senderColor(message.sender)}">${escapeHtml(message.sender)}</div>`
    : '';
  const metaHtml = `<span class="meta">${message.timestampLabel}${mine ? ICONS.ticks : ''}</span>`;

  if (message.kind === 'media') {
    const preview = message.mediaKey ? getCachedPreview(chat.id, message.mediaKey) : null;
    const hasCaption =
      Boolean(message.text) &&
      message.text !== TYPE_LABELS[message.mediaType ?? 'unknown'] &&
      message.text !== message.mediaName;
    const caption = hasCaption
      ? `<div class="text-row"><div class="text">${highlighted(message.text, state.filters.query)}</div>${metaHtml}</div>`
      : `<div class="media-meta-row">${metaHtml}</div>`;
    return `${senderHtml}<div class="media-slot" data-index="${index}">${mediaSlotHtml(message, preview)}</div>${caption}`;
  }

  return `${senderHtml}<div class="text-row"><div class="text">${highlighted(message.text, state.filters.query)}</div>${metaHtml}</div>`;
}

function loadVisibleMediaPreviews(chat: ChatData, indexes: number[]): void {
  for (const index of indexes) {
    const message = chat.messages[index];
    if (message.kind !== 'media' || !message.mediaKey) {
      continue;
    }
    if (getCachedPreview(chat.id, message.mediaKey)) {
      continue;
    }

    const loadingKey = `${chat.id}:${message.mediaKey}`;
    if (loadingPreviewKeys.has(loadingKey)) {
      continue;
    }
    loadingPreviewKeys.add(loadingKey);

    void loadMediaPreview(chat.id, message.mediaKey)
      .then((preview) => {
        if (!preview || state.selectedChatId !== chat.id) {
          return;
        }
        // Patch only this bubble instead of re-rendering the whole list.
        const slot = elements.messages.querySelector(`#msg-${index} .media-slot`);
        if (slot) {
          slot.innerHTML = mediaSlotHtml(message, preview);
        }
      })
      .finally(() => {
        loadingPreviewKeys.delete(loadingKey);
      });
  }
}

function renderMessages(chat: ChatData): void {
  const activeIndex = state.activeMatch >= 0 ? state.matchedIndexes[state.activeMatch] : -1;
  const rendered = getRenderedIndexes(chat);
  const fragment = document.createDocumentFragment();
  const isGroupChat = chat.participants.length > 2;

  if (hasSearchQuery() && !state.matchedIndexes.length) {
    elements.messages.innerHTML = '<div class="empty-state">Keine Treffer gefunden.</div>';
    return;
  }

  if (rendered.hiddenOlderCount > 0 && !hasSearchQuery()) {
    const older = document.createElement('button');
    older.type = 'button';
    older.className = 'older-button';
    older.textContent = `${rendered.hiddenOlderCount.toLocaleString('de-DE')} ältere Nachrichten`;
    older.addEventListener('click', loadOlderMessages);
    fragment.appendChild(older);
  }

  let lastDay = '';
  let lastSender = '';
  let lastIndex = -2;

  for (const index of rendered.indexes) {
    const message = chat.messages[index];

    if (message.dayKey !== lastDay) {
      const day = document.createElement('div');
      day.className = 'day-divider';
      day.textContent = dayLabel(message.timestampMs);
      fragment.appendChild(day);
      lastDay = message.dayKey;
      lastSender = '';
    }

    if (index !== lastIndex + 1) {
      lastSender = '';
    }
    lastIndex = index;

    if (message.kind === 'system') {
      const system = document.createElement('div');
      system.className = 'system-msg';
      system.textContent = message.text;
      fragment.appendChild(system);
      lastSender = '';
      continue;
    }

    const mine = message.sender === chat.owner;
    const grouped = message.sender === lastSender;
    lastSender = message.sender;

    const bubble = document.createElement('article');
    const classes = ['bubble', mine ? 'mine' : 'theirs'];
    if (!grouped) {
      classes.push('tail');
    } else {
      classes.push('grouped');
    }
    if (message.mediaType === 'sticker') {
      classes.push('sticker-bubble');
    }
    if (rendered.matchSet.has(index)) {
      classes.push('search-match');
    }
    if (index === activeIndex) {
      classes.push('active-match');
    }

    bubble.className = classes.join(' ');
    bubble.id = `msg-${index}`;
    bubble.innerHTML = bubbleInnerHtml(chat, message, index, isGroupChat && !mine && !grouped);
    fragment.appendChild(bubble);
  }

  elements.messages.replaceChildren(fragment);
  loadVisibleMediaPreviews(chat, rendered.indexes);
}

function renderHomeChatList(): void {
  elements.homeChatList.innerHTML = '';

  if (!state.chats.length) {
    elements.homeChatList.innerHTML =
      '<p class="placeholder">Noch keine gespeicherten Chats. Importiere oben einen Export.</p>';
    return;
  }

  const fragment = document.createDocumentFragment();
  const sorted = [...state.chats].sort((a, b) => b.importedAt - a.importedAt);

  for (const chat of sorted) {
    const lastMessage = chat.messages[chat.messages.length - 1];
    const item = document.createElement('div');
    item.className = 'chat-item';
    item.innerHTML = `
      <div class="avatar" style="background:${senderColor(chat.name)}">${escapeHtml(initials(chat.name))}</div>
      <div class="chat-item-body">
        <div class="chat-item-top">
          <strong>${escapeHtml(chat.name)}</strong>
          <span class="chat-item-time">${lastMessage ? listTimeLabel(lastMessage.timestampMs) : ''}</span>
        </div>
        <div class="chat-item-bottom">
          <span class="chat-item-preview">${escapeHtml(messagePreviewText(lastMessage))}</span>
          <button class="icon-btn delete-chat" type="button" aria-label="Chat löschen">${ICONS.trash}</button>
        </div>
      </div>
    `;

    item.addEventListener('click', () => void openChat(chat.id));
    item.querySelector('.delete-chat')?.addEventListener('click', (event) => {
      event.stopPropagation();
      void removeChat(chat);
    });
    fragment.appendChild(item);
  }

  elements.homeChatList.replaceChildren(fragment);
}

function buildOwnerOptions(chat: ChatData | null): void {
  elements.owner.innerHTML = '<option value="">Ich bin…</option>';
  if (!chat) {
    return;
  }

  for (const sender of chat.participants) {
    const option = document.createElement('option');
    option.value = sender;
    option.textContent = sender;
    elements.owner.appendChild(option);
  }

  if (chat.owner && chat.participants.includes(chat.owner)) {
    elements.owner.value = chat.owner;
  }
}

function updateChatHeader(chat: ChatData): void {
  elements.chatTitle.textContent = chat.name;
  elements.chatAvatar.textContent = initials(chat.name);
  elements.chatAvatar.style.background = senderColor(chat.name);

  const others = chat.participants.filter((participant) => participant !== chat.owner);
  elements.chatMeta.textContent = others.length
    ? others.join(', ')
    : `${chat.messages.length.toLocaleString('de-DE')} Nachrichten`;
}

function updateMatchCount(): void {
  if (!hasSearchQuery()) {
    elements.matchCount.textContent = '';
    return;
  }

  if (!state.matchedIndexes.length) {
    elements.matchCount.textContent = '0';
    return;
  }

  elements.matchCount.textContent = `${state.activeMatch + 1}/${state.matchedIndexes.length}`;
}

function setView(view: 'home' | 'chat'): void {
  const isChat = view === 'chat';
  elements.homeScreen.classList.toggle('hidden', isChat);
  elements.chatScreen.classList.toggle('hidden', !isChat);
}

function updatePendingUpload(): void {
  if (state.importing) {
    return;
  }

  if (!state.pendingFiles.length) {
    elements.pendingUpload.textContent = 'Keine Datei ausgewählt.';
    elements.startImport.disabled = true;
    return;
  }

  elements.pendingUpload.textContent = state.pendingFiles.map((file) => file.name).join(', ');
  elements.startImport.disabled = false;
}

function updateSearch(): void {
  const chat = selectedChat();
  const result = runSearch(chat, state.filters);
  state.matchedIndexes = result.indexes;
  state.activeMatch = state.matchedIndexes.length ? state.matchedIndexes.length - 1 : -1;
}

function renderChat(): void {
  const chat = selectedChat();
  if (!chat) {
    return;
  }

  updateChatHeader(chat);
  updateMatchCount();
  renderMessages(chat);
}

function scrollMessagesToBottom(): void {
  requestAnimationFrame(() => {
    elements.messages.scrollTop = elements.messages.scrollHeight;
  });
}

function jumpToActiveMatch(): void {
  if (state.activeMatch < 0 || !state.matchedIndexes.length) {
    return;
  }

  const index = state.matchedIndexes[state.activeMatch];
  requestAnimationFrame(() => {
    document.getElementById(`msg-${index}`)?.scrollIntoView({ block: 'center' });
  });
}

function cycleMatch(direction: 1 | -1): void {
  if (!state.matchedIndexes.length) {
    return;
  }

  const total = state.matchedIndexes.length;
  state.activeMatch = state.activeMatch < 0
    ? total - 1
    : (state.activeMatch + direction + total) % total;

  renderChat();
  jumpToActiveMatch();
}

async function openChat(chatId: string): Promise<void> {
  state.selectedChatId = chatId;
  state.activeMatch = -1;
  state.filters.query = '';
  elements.stickyQuery.value = '';
  state.matchedIndexes = [];

  const chat = selectedChat();
  resetVisibleWindow(chat);
  buildOwnerOptions(chat);
  setView('chat');
  renderChat();
  scrollMessagesToBottom();
}

async function removeChat(chat: ChatData): Promise<void> {
  const ok = window.confirm(`Chat "${chat.name}" und zugehörige Medien löschen?`);
  if (!ok) {
    return;
  }

  releaseChatPreviews(chat.id);
  await deleteChat(chat.id);
  state.chats = state.chats.filter((entry) => entry.id !== chat.id);
  if (state.selectedChatId === chat.id) {
    state.selectedChatId = null;
  }
  renderHomeChatList();
}

function importProgressText(fileName: string, progress: { stage: string; done?: number; total?: number }): string {
  if (progress.stage === 'reading') {
    return `${fileName}: Datei wird gelesen…`;
  }
  if (progress.stage === 'parsing') {
    return `${fileName}: Nachrichten werden analysiert…`;
  }
  return `${fileName}: Medien werden gespeichert (${progress.done}/${progress.total})…`;
}

async function handleUpload(files: File[]): Promise<void> {
  state.importing = true;
  elements.startImport.disabled = true;
  elements.startImport.textContent = 'Importiere…';

  const imported: ChatData[] = [];
  const failures: string[] = [];

  for (const file of files) {
    try {
      const chat = await importChat(file, (progress) => {
        elements.pendingUpload.textContent = importProgressText(file.name, progress);
      });
      await saveChat(chat);
      imported.push(chat);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Import fehlgeschlagen';
      failures.push(`${file.name}: ${message}`);
    }
  }

  state.importing = false;
  elements.startImport.textContent = 'Importieren';

  if (imported.length) {
    state.chats = [...imported, ...state.chats];
    state.pendingFiles = [];
    elements.upload.value = '';
    renderHomeChatList();
    await openChat(imported[0].id);
  }

  updatePendingUpload();

  if (failures.length) {
    window.alert(`Einige Dateien konnten nicht importiert werden:\n${failures.join('\n')}`);
  }
}

function onSearchInput(): void {
  window.clearTimeout(searchDebounceTimer);
  searchDebounceTimer = window.setTimeout(() => {
    const previousQuery = state.filters.query;
    state.filters.query = elements.stickyQuery.value;

    if (previousQuery.trim() === state.filters.query.trim()) {
      return;
    }

    updateSearch();

    if (hasSearchQuery()) {
      renderChat();
      jumpToActiveMatch();
    } else {
      resetVisibleWindow(selectedChat());
      renderChat();
      scrollMessagesToBottom();
    }
  }, SEARCH_DEBOUNCE_MS);
}

function wireEvents(): void {
  elements.upload.addEventListener('change', () => {
    state.pendingFiles = Array.from(elements.upload.files ?? []);
    updatePendingUpload();
  });

  elements.startImport.addEventListener('click', () => {
    if (!state.pendingFiles.length || state.importing) {
      return;
    }
    void handleUpload(state.pendingFiles);
  });

  elements.stickyQuery.addEventListener('input', onSearchInput);
  elements.stickyQuery.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') {
      event.preventDefault();
      cycleMatch(event.shiftKey ? 1 : -1);
    }
  });

  elements.stickyPrev.addEventListener('click', () => cycleMatch(-1));
  elements.stickyNext.addEventListener('click', () => cycleMatch(1));

  elements.owner.addEventListener('change', () => {
    const chat = selectedChat();
    if (!chat || !elements.owner.value) {
      return;
    }

    chat.owner = elements.owner.value;
    renderChat();
    void saveChat(chat);
  });

  elements.backHome.addEventListener('click', () => {
    const chatId = state.selectedChatId;
    state.selectedChatId = null;
    state.filters.query = '';
    elements.stickyQuery.value = '';
    state.matchedIndexes = [];
    state.activeMatch = -1;
    if (chatId) {
      releaseChatPreviews(chatId);
    }
    renderHomeChatList();
    setView('home');
  });

  elements.clearData.addEventListener('click', () => {
    const ok = window.confirm('Alle lokal gespeicherten Chats und Medien in diesem Browser löschen?');
    if (!ok) {
      return;
    }

    for (const chat of state.chats) {
      releaseChatPreviews(chat.id);
    }
    state.chats = [];
    state.selectedChatId = null;
    state.pendingFiles = [];
    elements.upload.value = '';
    void clearAllData();
    renderHomeChatList();
    updatePendingUpload();
    setView('home');
  });

  elements.messages.addEventListener('scroll', () => {
    if (elements.messages.scrollTop < SCROLL_LOAD_THRESHOLD_PX) {
      loadOlderMessages();
    }
  }, { passive: true });

  elements.messages.addEventListener('click', (event) => {
    const target = event.target as HTMLElement;
    if (target.tagName === 'IMG' && target.closest('.media-chip')) {
      elements.lightboxImg.src = (target as HTMLImageElement).src;
      elements.lightbox.classList.remove('hidden');
    }
  });

  // img error events don't bubble; capture them to swap broken previews
  // (e.g. HEIC in Chrome) for a placeholder.
  elements.messages.addEventListener('error', (event) => {
    const target = event.target as HTMLElement;
    if (target.tagName === 'IMG') {
      const chip = target.closest('.media-chip');
      if (chip) {
        chip.classList.add('placeholder');
        chip.innerHTML = `${ICONS.image}<span>Vorschau nicht möglich</span>`;
      }
    }
  }, true);

  elements.lightbox.addEventListener('click', () => {
    elements.lightbox.classList.add('hidden');
    elements.lightboxImg.src = '';
  });

  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && !elements.lightbox.classList.contains('hidden')) {
      elements.lightbox.classList.add('hidden');
      elements.lightboxImg.src = '';
    }
  });
}

async function bootstrap(): Promise<void> {
  wireEvents();

  try {
    state.chats = await loadChats();
  } catch {
    state.chats = [];
  }

  renderHomeChatList();
  updatePendingUpload();
  setView('home');
}

void bootstrap();
