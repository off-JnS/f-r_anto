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
  <nav id="always-search" class="always-search hidden" aria-label="Schnellsuche">
    <div class="always-search-inner">
      <input id="sticky-query" type="search" placeholder="Nachrichten suchen..." />
      <button id="sticky-prev" class="ghost" type="button">Zurueck</button>
      <button id="sticky-next" class="ghost" type="button">Weiter</button>
    </div>
  </nav>

  <div class="shell single-shell">
    <main class="main single-main">
      <section id="home-screen" class="home-screen">
        <div class="home-card">
          <h1>chat mirror für anto</h1>
          <p>Waehle einen vorhandenen Chat oder lade einen neuen WhatsApp-Export hoch.</p>
          <label class="upload-btn" for="chat-upload">Neuen Chat auswaehlen</label>
          <input id="chat-upload" class="hidden-input" type="file" accept=".txt,.zip" multiple />
          <div id="pending-upload" class="pending-upload">Noch keine Datei ausgewaehlt.</div>
          <button id="start-import" class="ghost primary-action" type="button" disabled>Start</button>
          <div id="home-chat-list" class="chat-list home-chat-list"></div>
          <button id="clear-data" class="ghost danger-link" type="button">Alle lokalen Chats loeschen</button>
        </div>
      </section>

      <section id="chat-screen" class="chat-screen hidden">
        <header class="chat-header">
          <button id="back-home" class="ghost" type="button">Chats</button>
          <div class="chat-heading">
            <h2 id="chat-title">Kein Chat ausgewaehlt</h2>
            <p id="chat-meta">Waehle einen Chat, um zu starten.</p>
          </div>
          <div class="owner-wrap">
            <label for="owner-select">Ich bin</label>
            <select id="owner-select" class="ghost"><option value="">Waehlen...</option></select>
          </div>
        </header>
        <div id="result-meta" class="result-meta">Kein aktiver Chat.</div>
        <section id="messages" class="messages"></section>
      </section>
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
  alwaysSearch: must<HTMLElement>('#always-search'),
  stickyQuery: must<HTMLInputElement>('#sticky-query'),
  stickyPrev: must<HTMLButtonElement>('#sticky-prev'),
  stickyNext: must<HTMLButtonElement>('#sticky-next'),
  upload: must<HTMLInputElement>('#chat-upload'),
  startImport: must<HTMLButtonElement>('#start-import'),
  pendingUpload: must<HTMLDivElement>('#pending-upload'),
  clearData: must<HTMLButtonElement>('#clear-data'),
  homeScreen: must<HTMLElement>('#home-screen'),
  chatScreen: must<HTMLElement>('#chat-screen'),
  homeChatList: must<HTMLDivElement>('#home-chat-list'),
  backHome: must<HTMLButtonElement>('#back-home'),
  chatTitle: must<HTMLHeadingElement>('#chat-title'),
  chatMeta: must<HTMLParagraphElement>('#chat-meta'),
  owner: must<HTMLSelectElement>('#owner-select'),
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
  pendingFiles: File[];
  view: 'home' | 'chat';
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
  pendingFiles: [],
  view: 'home',
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
    selectedChatId: null,
  });
}

function resetVisibleWindow(chat: ChatData | null): void {
  if (!chat) {
    state.visibleStartIndex = 0;
    return;
  }

  state.visibleStartIndex = Math.max(0, chat.messages.length - MESSAGE_WINDOW_SIZE);
}

function hasSearchQuery(): boolean {
  return Boolean(state.filters.query.trim());
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

function renderHomeChatList(): void {
  elements.homeChatList.innerHTML = '';

  if (!state.chats.length) {
    elements.homeChatList.innerHTML = '<p class="placeholder">Noch keine gespeicherten Chats vorhanden.</p>';
    return;
  }

  const title = document.createElement('p');
  title.className = 'existing-title';
  title.textContent = 'Vorhandene Chats';
  elements.homeChatList.appendChild(title);

  const sorted = [...state.chats].sort((a, b) => b.importedAt - a.importedAt);
  for (const chat of sorted) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'chat-item';
    button.innerHTML = `
      <strong>${escapeHtml(chat.name)}</strong>
      <span>${chat.messages.length} Nachrichten</span>
    `;
    button.addEventListener('click', () => openChat(chat.id));
    elements.homeChatList.appendChild(button);
  }
}

function setView(view: 'home' | 'chat'): void {
  state.view = view;
  const isChat = view === 'chat';
  elements.homeScreen.classList.toggle('hidden', isChat);
  elements.chatScreen.classList.toggle('hidden', !isChat);
  elements.alwaysSearch.classList.toggle('hidden', !isChat);
}

function updatePendingUpload(): void {
  if (!state.pendingFiles.length) {
    elements.pendingUpload.textContent = 'Noch keine Datei ausgewaehlt.';
    elements.startImport.disabled = true;
    return;
  }

  const names = state.pendingFiles.map((file) => file.name).join(', ');
  elements.pendingUpload.textContent = names;
  elements.startImport.disabled = false;
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
    elements.chatMeta.textContent = 'Waehle einen gespeicherten Chat oder importiere einen neuen.';
    elements.resultMeta.textContent = 'Kein aktiver Chat.';
    return;
  }

  elements.chatTitle.textContent = chat.name;
  elements.chatMeta.textContent = `${chat.messages.length} Nachrichten`;
  elements.resultMeta.textContent = state.filters.query
    ? `${state.matchedIndexes.length} Treffer fuer "${state.filters.query}"`
    : 'Neueste Nachrichten';
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

function renderMessages(chat: ChatData | null): void {
  elements.messages.innerHTML = '';

  if (!chat) {
    elements.messages.innerHTML = '<div class="empty-state">Waehle einen Chat oder importiere einen neuen.</div>';
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

function scrollMessagesToBottom(): void {
  requestAnimationFrame(() => {
    elements.messages.scrollTop = elements.messages.scrollHeight;
  });
}

function render(options?: { scrollToBottom?: boolean }): void {
  renderHomeChatList();
  updatePendingUpload();
  updateMeta();
  renderMessages(selectedChat());

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

function openChat(chatId: string): void {
  const chat = state.chats.find((entry) => entry.id === chatId) ?? null;
  state.selectedChatId = chatId;
  state.activeMatch = -1;
  resetVisibleWindow(chat);
  buildOwnerOptions(chat);
  updateSearch();
  setView('chat');
  render({ scrollToBottom: true });
}

async function handleUpload(files: File[]): Promise<void> {
  const imported: ChatData[] = [];
  const failures: string[] = [];

  for (const file of files) {
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
    state.pendingFiles = [];
    await persist();
    openChat(imported[0].id);
  }

  if (failures.length) {
    window.alert(`Einige Dateien konnten nicht importiert werden:\n${failures.join('\n')}`);
  }
}

function resetSearch(): void {
  state.filters = {
    query: '',
    sender: 'all',
    dateFrom: '',
    dateTo: '',
  };
  elements.stickyQuery.value = '';
  updateSearch();
}

function wireEvents(): void {
  elements.upload.addEventListener('change', () => {
    state.pendingFiles = Array.from(elements.upload.files ?? []);
    updatePendingUpload();
  });

  elements.startImport.addEventListener('click', async () => {
    if (!state.pendingFiles.length) {
      return;
    }

    await handleUpload(state.pendingFiles);
    elements.upload.value = '';
    updatePendingUpload();
  });

  elements.stickyQuery.addEventListener('input', () => {
    state.filters.query = elements.stickyQuery.value;
    updateSearch();
    render();
  });

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

  elements.backHome.addEventListener('click', () => {
    state.selectedChatId = null;
    resetSearch();
    setView('home');
    render();
  });

  elements.clearData.addEventListener('click', async () => {
    const ok = window.confirm('Alle lokal gespeicherten Chats in diesem Browser loeschen?');
    if (!ok) {
      return;
    }

    state.chats = [];
    state.selectedChatId = null;
    state.pendingFiles = [];
    state.activeMatch = -1;
    state.visibleStartIndex = 0;
    resetSearch();
    elements.owner.innerHTML = '<option value="">Waehlen...</option>';
    await clearState();
    setView('home');
    render();
  });
}

async function bootstrap(): Promise<void> {
  wireEvents();

  const persisted = await loadState();
  if (persisted) {
    state.chats = persisted.chats;
  }

  setView('home');
  render();
}

void bootstrap();
