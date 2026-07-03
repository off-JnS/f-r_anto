import './style.css';
import { importChat } from './importer';
import { loadMediaPreview } from './mediaStore';
import { runSearch } from './search';
import { clearState, loadState, saveState } from './storage';
import type { ChatData, SearchFilters } from './types';

const MESSAGE_WINDOW_SIZE = 250;
const SEARCH_CONTEXT_RADIUS = 2;
const loadingPreviewKeys = new Set<string>();

const app = document.querySelector<HTMLDivElement>('#app');

if (!app) {
  throw new Error('Missing #app root element.');
}

app.innerHTML = `
  <nav class="always-search" aria-label="Schnellsuche">
    <div class="always-search-inner">
      <input id="sticky-query" type="search" placeholder="Suche jederzeit..." />
      <button id="sticky-prev" class="ghost" type="button">Zurueck</button>
      <button id="sticky-next" class="ghost" type="button">Weiter</button>
    </div>
  </nav>

  <div class="shell">
    <aside class="sidebar">
      <div class="sidebar-head">
        <h1>chat mirror für anto</h1>
        <p>WhatsApp-Exporte hochladen und alte Nachrichten wie in WhatsApp lesen.</p>
      </div>
      <label class="upload-btn" for="chat-upload">.txt oder .zip hochladen</label>
      <input id="chat-upload" class="hidden-input" type="file" accept=".txt,.zip" multiple />
      <button id="clear-data" class="ghost" type="button">Lokale Daten loeschen</button>
      <div id="chat-list" class="chat-list"></div>
      <p class="privacy-note">Alles bleibt lokal im Browser. Es werden keine Chatdaten hochgeladen.</p>
    </aside>

    <main class="main">
      <div class="top-tools">
        <header class="main-head">
          <div>
            <h2 id="chat-title">Kein Chat ausgewaehlt</h2>
            <p id="chat-meta">Lade einen WhatsApp-Export hoch, um zu starten.</p>
          </div>
          <div class="search-nav">
            <label for="owner-select">Ich bin</label>
            <select id="owner-select" class="ghost"><option value="">Waehlen...</option></select>
            <button id="prev-result" class="ghost" type="button">Zurueck</button>
            <button id="next-result" class="ghost" type="button">Weiter</button>
          </div>
        </header>

        <section class="search-bar">
          <input id="search-query" type="search" placeholder="Aeltere Nachrichten suchen..." />
          <select id="search-sender"><option value="all">Alle Absender</option></select>
          <input id="search-from" type="date" />
          <input id="search-to" type="date" />
          <button id="search-reset" type="button" class="ghost">Zuruecksetzen</button>
        </section>

        <div id="result-meta" class="result-meta">Kein aktiver Chat.</div>
      </div>
      <section id="messages" class="messages"></section>
    </main>
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
  upload: must<HTMLInputElement>('#chat-upload'),
  clearData: must<HTMLButtonElement>('#clear-data'),
  chatList: must<HTMLDivElement>('#chat-list'),
  chatTitle: must<HTMLHeadingElement>('#chat-title'),
  chatMeta: must<HTMLParagraphElement>('#chat-meta'),
  query: must<HTMLInputElement>('#search-query'),
  sender: must<HTMLSelectElement>('#search-sender'),
  from: must<HTMLInputElement>('#search-from'),
  to: must<HTMLInputElement>('#search-to'),
  reset: must<HTMLButtonElement>('#search-reset'),
  owner: must<HTMLSelectElement>('#owner-select'),
  prev: must<HTMLButtonElement>('#prev-result'),
  next: must<HTMLButtonElement>('#next-result'),
  resultMeta: must<HTMLDivElement>('#result-meta'),
  messages: must<HTMLElement>('#messages'),
};

const state: {
  chats: ChatData[];
  selectedChatId: string | null;
  filters: SearchFilters;
  matchedIndexes: number[];
  activeMatch: number;
  visibleStartIndex: number;
} = {
  chats: [],
  selectedChatId: null,
  filters: {
    query: '',
    sender: 'all',
    dateFrom: '',
    dateTo: '',
  },
  matchedIndexes: [],
  activeMatch: -1,
  visibleStartIndex: 0,
};

function escapeHtml(text: string): string {
  return text
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function highlighted(text: string, query: string): string {
  if (!query) {
    return escapeHtml(text).replaceAll('\n', '<br/>');
  }

  const lower = text.toLowerCase();
  const token = query.toLowerCase();
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

function selectedChat(): ChatData | null {
  return state.chats.find((chat) => chat.id === state.selectedChatId) ?? null;
}

function sanitizeForSave(chats: ChatData[]): ChatData[] {
  return chats.map((chat) => ({
    ...chat,
    messages: chat.messages.map((message) => ({
      ...message,
      mediaUrl: undefined,
    })),
  }));
}

async function persist(): Promise<void> {
  await saveState({
    chats: sanitizeForSave(state.chats),
    selectedChatId: state.selectedChatId,
  });
}

function buildSenderOptions(chat: ChatData | null): void {
  const previous = state.filters.sender;
  elements.sender.innerHTML = '<option value="all">Alle Absender</option>';

  if (!chat) {
    return;
  }

  for (const sender of chat.participants) {
    const option = document.createElement('option');
    option.value = sender;
    option.textContent = sender;
    elements.sender.appendChild(option);
  }

  if (chat.participants.includes(previous)) {
    elements.sender.value = previous;
  }
}

function buildOwnerOptions(chat: ChatData | null): void {
  const previousOwner = chat?.owner ?? '';
  elements.owner.innerHTML = '<option value="">Waehlen...</option>';

  if (!chat) {
    return;
  }

  for (const sender of chat.participants) {
    const option = document.createElement('option');
    option.value = sender;
    option.textContent = sender;
    elements.owner.appendChild(option);
  }

  if (previousOwner && chat.participants.includes(previousOwner)) {
    elements.owner.value = previousOwner;
  }
}

function renderChatList(): void {
  elements.chatList.innerHTML = '';

  if (!state.chats.length) {
    elements.chatList.innerHTML = '<p class="placeholder">Noch keine Chats importiert.</p>';
    return;
  }

  const sorted = [...state.chats].sort((a, b) => b.importedAt - a.importedAt);
  for (const chat of sorted) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = `chat-item ${chat.id === state.selectedChatId ? 'active' : ''}`;
    button.innerHTML = `
      <strong>${escapeHtml(chat.name)}</strong>
      <span>${chat.messages.length} Nachrichten</span>
    `;
    button.addEventListener('click', () => {
      state.selectedChatId = chat.id;
      state.activeMatch = -1;
      resetVisibleWindow(chat);
      buildSenderOptions(chat);
      buildOwnerOptions(chat);
      updateSearch();
      render({ scrollToBottom: true });
      void persist();
    });
    elements.chatList.appendChild(button);
  }
}

function renderMessages(chat: ChatData | null): void {
  elements.messages.innerHTML = '';

  if (!chat) {
    elements.messages.innerHTML = '<div class="empty-state">Datei hochladen, um Nachrichten anzuzeigen.</div>';
    return;
  }

  let lastDay = '';
  const activeIndex = state.activeMatch >= 0 ? state.matchedIndexes[state.activeMatch] : -1;
  const matchedSet = new Set<number>(state.matchedIndexes);
  const rendered = getRenderedIndexes(chat);

  if (rendered.hiddenOlderCount > 0 && !hasSearchQuery()) {
    const olderButton = document.createElement('button');
    olderButton.type = 'button';
    olderButton.className = 'older-button';
    olderButton.textContent = `${rendered.hiddenOlderCount} aeltere Nachrichten laden`;
    olderButton.addEventListener('click', loadOlderMessages);
    elements.messages.appendChild(olderButton);
  }

  rendered.indexes.forEach((index) => {
    const message = chat.messages[index];
    if (message.dayKey !== lastDay) {
      const day = document.createElement('div');
      day.className = 'day-divider';
      day.textContent = message.dayKey;
      elements.messages.appendChild(day);
      lastDay = message.dayKey;
    }

    if (message.kind === 'system') {
      const system = document.createElement('div');
      system.className = 'system-msg';
      system.textContent = message.text;
      elements.messages.appendChild(system);
      return;
    }

    const bubble = document.createElement('article');
    const mine = message.sender === chat.owner;
    const isMatch = matchedSet.has(index);
    const classes = ['bubble', mine ? 'mine' : 'theirs'];
    if (isMatch) {
      classes.push('search-match');
    }
    if (index === activeIndex) {
      classes.push('active-match');
    }
    bubble.className = classes.join(' ');
    bubble.id = `msg-${index}`;

    if (message.kind === 'media') {
      const isSticker = message.text.toLowerCase() === 'sticker';
      bubble.innerHTML = `
        <div class="sender">${escapeHtml(message.sender)}</div>
        <div class="media-chip ${isSticker ? 'sticker' : ''}">
          ${message.mediaUrl
            ? `<img src="${message.mediaUrl}" alt="${isSticker ? 'Sticker Vorschau' : 'Datei Vorschau'}"/>`
            : '<div class="media-empty" aria-label="Keine Vorschau verfuegbar"></div>'}
        </div>
        <div class="media-meta-row">
          <span class="meta">${message.timestampLabel}</span>
        </div>
      `;
    } else {
      bubble.innerHTML = `
        <div class="sender">${escapeHtml(message.sender)}</div>
        <div class="text-row">
          <div class="text">${highlighted(message.text, state.filters.query)}</div>
          <span class="meta">${message.timestampLabel}</span>
        </div>
      `;
    }

    elements.messages.appendChild(bubble);
  });

  loadVisibleMediaPreviews(chat, rendered.indexes);
}

function updateSearch(): void {
  const chat = selectedChat();
  const result = runSearch(chat, state.filters);
  state.matchedIndexes = result.indexes;

  if (!state.matchedIndexes.length) {
    state.activeMatch = -1;
  } else if (state.activeMatch < 0 || state.activeMatch >= state.matchedIndexes.length) {
    state.activeMatch = 0;
  }
}

function updateMeta(): void {
  const chat = selectedChat();

  if (!chat) {
    elements.chatTitle.textContent = 'Kein Chat ausgewaehlt';
    elements.chatMeta.textContent = 'Lade einen WhatsApp-Export hoch, um zu starten.';
    elements.resultMeta.textContent = 'Kein aktiver Chat.';
    return;
  }

  elements.chatTitle.textContent = chat.name;
  elements.chatMeta.textContent = `${chat.messages.length} Nachrichten • ${chat.participants.length} Teilnehmer`;
  elements.resultMeta.textContent = state.filters.query
    ? `${state.matchedIndexes.length} Treffer fuer "${state.filters.query}"`
    : `${state.matchedIndexes.length} Nachrichten nach aktuellen Filtern`;
}

function hasSearchQuery(): boolean {
  return Boolean(state.filters.query.trim());
}

function hasOtherFilters(): boolean {
  return (
    state.filters.sender !== 'all' || Boolean(state.filters.dateFrom) || Boolean(state.filters.dateTo)
  );
}

function resetVisibleWindow(chat: ChatData | null): void {
  if (!chat) {
    state.visibleStartIndex = 0;
    return;
  }

  state.visibleStartIndex = Math.max(0, chat.messages.length - MESSAGE_WINDOW_SIZE);
}

function getRenderedIndexes(chat: ChatData): { indexes: number[]; hiddenOlderCount: number } {
  if (hasSearchQuery()) {
    const bucket = new Set<number>();

    for (const matchIndex of state.matchedIndexes) {
      const start = Math.max(0, matchIndex - SEARCH_CONTEXT_RADIUS);
      const end = Math.min(chat.messages.length - 1, matchIndex + SEARCH_CONTEXT_RADIUS);

      for (let index = start; index <= end; index += 1) {
        bucket.add(index);
      }
    }

    const indexes = [...bucket].sort((a, b) => a - b);
    return {
      indexes,
      hiddenOlderCount: indexes[0] ?? 0,
    };
  }

  if (hasOtherFilters()) {
    const start = Math.max(0, state.matchedIndexes.length - MESSAGE_WINDOW_SIZE);
    return {
      indexes: state.matchedIndexes.slice(start),
      hiddenOlderCount: start,
    };
  }

  const start = Math.max(0, state.visibleStartIndex);
  const indexes: number[] = [];
  for (let index = start; index < chat.messages.length; index += 1) {
    indexes.push(index);
  }

  return {
    indexes,
    hiddenOlderCount: start,
  };
}

function loadOlderMessages(): void {
  const previousHeight = elements.messages.scrollHeight;
  const previousTop = elements.messages.scrollTop;
  state.visibleStartIndex = Math.max(0, state.visibleStartIndex - MESSAGE_WINDOW_SIZE);
  render();

  requestAnimationFrame(() => {
    const nextHeight = elements.messages.scrollHeight;
    elements.messages.scrollTop = nextHeight - previousHeight + previousTop;
  });
}

function ensureActiveMatchVisible(chat: ChatData | null): void {
  if (!chat || state.activeMatch < 0 || hasSearchQuery() || hasOtherFilters()) {
    return;
  }

  const activeMessageIndex = state.matchedIndexes[state.activeMatch];
  if (activeMessageIndex < state.visibleStartIndex) {
    state.visibleStartIndex = Math.max(0, activeMessageIndex - 40);
  }
}

function loadVisibleMediaPreviews(chat: ChatData, indexes: number[]): void {
  for (const index of indexes) {
    const message = chat.messages[index];
    if (message.kind !== 'media' || message.mediaUrl || !message.mediaKey) {
      continue;
    }

    const loadingKey = `${chat.id}:${message.mediaKey}`;
    if (loadingPreviewKeys.has(loadingKey)) {
      continue;
    }

    loadingPreviewKeys.add(loadingKey);

    void loadMediaPreview(chat.id, message.mediaKey)
      .then((preview) => {
        if (!preview) {
          return;
        }

        message.mediaUrl = preview.url;
        message.mediaMime = preview.mime;
        render();
      })
      .finally(() => {
        loadingPreviewKeys.delete(loadingKey);
      });
  }
}

function scrollMessagesToBottom(): void {
  requestAnimationFrame(() => {
    elements.messages.scrollTop = elements.messages.scrollHeight;
  });
}

function render(options?: { scrollToBottom?: boolean }): void {
  const chat = selectedChat();
  ensureActiveMatchVisible(chat);
  renderChatList();
  renderMessages(chat);
  updateMeta();

  if (options?.scrollToBottom) {
    scrollMessagesToBottom();
  }
}

function jumpToActiveMatch(): void {
  if (state.activeMatch < 0 || !state.matchedIndexes.length) {
    return;
  }

  const idx = state.matchedIndexes[state.activeMatch];
  const target = document.getElementById(`msg-${idx}`);
  target?.scrollIntoView({ behavior: 'smooth', block: 'center' });
}

function cycleMatch(direction: 1 | -1): void {
  if (!state.matchedIndexes.length) {
    return;
  }

  if (state.activeMatch < 0) {
    state.activeMatch = 0;
  } else {
    const total = state.matchedIndexes.length;
    state.activeMatch = (state.activeMatch + direction + total) % total;
  }

  render();
  jumpToActiveMatch();
}

async function handleUpload(files: FileList): Promise<void> {
  const imported: ChatData[] = [];
  const failures: string[] = [];

  for (const file of Array.from(files)) {
    try {
      const chat = await importChat(file);
      imported.push(chat);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Import fehlgeschlagen';
      failures.push(`${file.name}: ${message}`);
    }
  }

  if (imported.length) {
    state.chats = [...imported, ...state.chats];
    state.selectedChatId = imported[0].id;
    resetVisibleWindow(imported[0]);
    buildSenderOptions(imported[0]);
    buildOwnerOptions(imported[0]);
    updateSearch();
    render({ scrollToBottom: true });
    await persist();
  }

  if (failures.length) {
    window.alert(`Einige Dateien konnten nicht importiert werden:\n${failures.join('\n')}`);
  }
}

function wireEvents(): void {
  elements.upload.addEventListener('change', async () => {
    if (!elements.upload.files?.length) {
      return;
    }
    await handleUpload(elements.upload.files);
    elements.upload.value = '';
  });

  const onFilter = () => {
    state.filters.query = elements.query.value;
    elements.stickyQuery.value = elements.query.value;
    state.filters.sender = elements.sender.value;
    state.filters.dateFrom = elements.from.value;
    state.filters.dateTo = elements.to.value;
    updateSearch();
    render();
  };

  elements.query.addEventListener('input', onFilter);
  elements.stickyQuery.addEventListener('input', () => {
    elements.query.value = elements.stickyQuery.value;
    onFilter();
  });
  elements.sender.addEventListener('change', onFilter);
  elements.from.addEventListener('change', onFilter);
  elements.to.addEventListener('change', onFilter);

  elements.reset.addEventListener('click', () => {
    state.filters = {
      query: '',
      sender: 'all',
      dateFrom: '',
      dateTo: '',
    };
    elements.query.value = '';
    elements.stickyQuery.value = '';
    elements.sender.value = 'all';
    elements.from.value = '';
    elements.to.value = '';
    updateSearch();
    render();
  });

  elements.prev.addEventListener('click', () => cycleMatch(-1));
  elements.next.addEventListener('click', () => cycleMatch(1));
  elements.stickyPrev.addEventListener('click', () => cycleMatch(-1));
  elements.stickyNext.addEventListener('click', () => cycleMatch(1));

  elements.owner.addEventListener('change', async () => {
    const chat = selectedChat();
    if (!chat || !elements.owner.value) {
      return;
    }
    chat.owner = elements.owner.value;
    render();
    await persist();
  });

  elements.clearData.addEventListener('click', async () => {
    const ok = window.confirm('Alle lokal gespeicherten Chats in diesem Browser loeschen?');
    if (!ok) {
      return;
    }

    state.chats = [];
    state.selectedChatId = null;
    state.activeMatch = -1;
    state.matchedIndexes = [];
    state.filters = {
      query: '',
      sender: 'all',
      dateFrom: '',
      dateTo: '',
    };

    elements.query.value = '';
    elements.stickyQuery.value = '';
    elements.sender.innerHTML = '<option value="all">Alle Absender</option>';
    elements.owner.innerHTML = '<option value="">Waehlen...</option>';
    elements.from.value = '';
    elements.to.value = '';

    await clearState();
    render();
  });
}

async function bootstrap(): Promise<void> {
  wireEvents();

  const persisted = await loadState();
  if (persisted) {
    state.chats = persisted.chats;
    state.selectedChatId = persisted.selectedChatId;

    if (state.selectedChatId && !state.chats.some((chat) => chat.id === state.selectedChatId)) {
      state.selectedChatId = state.chats[0]?.id ?? null;
    }

    buildSenderOptions(selectedChat());
    buildOwnerOptions(selectedChat());
  }

  resetVisibleWindow(selectedChat());

  updateSearch();
  elements.stickyQuery.value = elements.query.value;
  render({ scrollToBottom: true });
}

void bootstrap();
