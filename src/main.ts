import './style.css';
import { importChat } from './importer';
import { runSearch } from './search';
import { clearState, loadState, saveState } from './storage';
import type { ChatData, SearchFilters } from './types';

const app = document.querySelector<HTMLDivElement>('#app');

if (!app) {
  throw new Error('Missing #app root element.');
}

app.innerHTML = `
  <div class="shell">
    <aside class="sidebar">
      <div class="sidebar-head">
        <h1>Chat Mirror</h1>
        <p>Upload WhatsApp exports and browse old messages like WhatsApp.</p>
      </div>
      <label class="upload-btn" for="chat-upload">Upload .txt or .zip</label>
      <input id="chat-upload" class="hidden-input" type="file" accept=".txt,.zip" multiple />
      <button id="clear-data" class="ghost" type="button">Clear local data</button>
      <div id="chat-list" class="chat-list"></div>
      <p class="privacy-note">All parsing and search run in your browser. No server upload.</p>
    </aside>

    <main class="main">
      <header class="main-head">
        <div>
          <h2 id="chat-title">No chat selected</h2>
          <p id="chat-meta">Upload a WhatsApp export to start.</p>
        </div>
        <div class="search-nav">
          <button id="prev-result" class="ghost" type="button">Prev</button>
          <button id="next-result" class="ghost" type="button">Next</button>
        </div>
      </header>

      <section class="search-bar">
        <input id="search-query" type="search" placeholder="Search older messages..." />
        <select id="search-sender"><option value="all">All senders</option></select>
        <input id="search-from" type="date" />
        <input id="search-to" type="date" />
        <button id="search-reset" type="button" class="ghost">Reset</button>
      </section>

      <div id="result-meta" class="result-meta">No active chat.</div>
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
  elements.sender.innerHTML = '<option value="all">All senders</option>';

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

function renderChatList(): void {
  elements.chatList.innerHTML = '';

  if (!state.chats.length) {
    elements.chatList.innerHTML = '<p class="placeholder">No imported chats yet.</p>';
    return;
  }

  const sorted = [...state.chats].sort((a, b) => b.importedAt - a.importedAt);
  for (const chat of sorted) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = `chat-item ${chat.id === state.selectedChatId ? 'active' : ''}`;
    button.innerHTML = `
      <strong>${escapeHtml(chat.name)}</strong>
      <span>${chat.messages.length} messages</span>
    `;
    button.addEventListener('click', () => {
      state.selectedChatId = chat.id;
      state.activeMatch = -1;
      buildSenderOptions(chat);
      updateSearch();
      render();
      void persist();
    });
    elements.chatList.appendChild(button);
  }
}

function renderMessages(chat: ChatData | null): void {
  elements.messages.innerHTML = '';

  if (!chat) {
    elements.messages.innerHTML = '<div class="empty-state">Upload a file to start viewing messages.</div>';
    return;
  }

  let lastDay = '';
  const activeIndex = state.activeMatch >= 0 ? state.matchedIndexes[state.activeMatch] : -1;
  const matchedSet = new Set<number>(state.matchedIndexes);

  chat.messages.forEach((message, index) => {
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

    const mediaBlock =
      message.kind === 'media'
        ? `
          <div class="media-chip">
            ${message.mediaUrl ? `<img src="${message.mediaUrl}" alt="${escapeHtml(message.mediaName ?? 'media')}"/>` : ''}
            <span>${escapeHtml(message.mediaName ?? 'Media')}</span>
          </div>
        `
        : '';

    bubble.innerHTML = `
      <div class="sender">${escapeHtml(message.sender)}</div>
      <div class="text">${highlighted(message.text, state.filters.query)}</div>
      ${mediaBlock}
      <div class="meta">${message.timestampLabel}</div>
    `;

    elements.messages.appendChild(bubble);
  });
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
    elements.chatTitle.textContent = 'No chat selected';
    elements.chatMeta.textContent = 'Upload a WhatsApp export to start.';
    elements.resultMeta.textContent = 'No active chat.';
    return;
  }

  elements.chatTitle.textContent = chat.name;
  elements.chatMeta.textContent = `${chat.messages.length} messages • ${chat.participants.length} participants`;
  elements.resultMeta.textContent = state.filters.query
    ? `${state.matchedIndexes.length} match(es) for "${state.filters.query}"`
    : `${state.matchedIndexes.length} messages after current filters`;
}

function render(): void {
  const chat = selectedChat();
  renderChatList();
  renderMessages(chat);
  updateMeta();
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
      const message = error instanceof Error ? error.message : 'Import failed';
      failures.push(`${file.name}: ${message}`);
    }
  }

  if (imported.length) {
    state.chats = [...imported, ...state.chats];
    state.selectedChatId = imported[0].id;
    buildSenderOptions(imported[0]);
    updateSearch();
    render();
    await persist();
  }

  if (failures.length) {
    window.alert(`Some files failed to import:\n${failures.join('\n')}`);
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
    state.filters.sender = elements.sender.value;
    state.filters.dateFrom = elements.from.value;
    state.filters.dateTo = elements.to.value;
    updateSearch();
    render();
  };

  elements.query.addEventListener('input', onFilter);
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
    elements.sender.value = 'all';
    elements.from.value = '';
    elements.to.value = '';
    updateSearch();
    render();
  });

  elements.prev.addEventListener('click', () => cycleMatch(-1));
  elements.next.addEventListener('click', () => cycleMatch(1));

  elements.clearData.addEventListener('click', async () => {
    const ok = window.confirm('Delete all locally saved chats from this browser?');
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
    elements.sender.innerHTML = '<option value="all">All senders</option>';
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
  }

  updateSearch();
  render();
}

void bootstrap();
