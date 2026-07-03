# Chat Mirror

A WhatsApp-look-alike web app to upload old chats and browse them in a familiar interface.

## Features

- Upload WhatsApp exports as `.txt` or `.zip` (German and English exports, Android and iOS formats)
- WhatsApp-style dark theme: bubbles with tails, ticks, day separators, doodle background
- Photos, stickers, videos, voice notes and documents from the zip are stored in the browser (IndexedDB) and survive reloads
- Tap a photo for a fullscreen view
- Instant search with match counter and previous/next navigation
- Handles very large chats: only a window of messages is rendered, older ones load as you scroll up
- Privacy-first: parsing, media and search stay entirely in your browser

## Run locally

```bash
npm install
npm run dev
```

## Build

```bash
npm run build
npm run preview
```

## Deploy to Netlify

1. Push this project to GitHub.
2. In Netlify, create a new site from that repository.
3. Build command: `npm run build`
4. Publish directory: `dist`
5. Deploy.

Or drag and drop the `dist` folder after running `npm run build`.

## Supported input

- WhatsApp exported text file (`.txt`)
- WhatsApp exported zip (`.zip`) containing the transcript `.txt` and optional media files

## Notes

- Pick who you are via the "Ich bin…" selector in the chat header so your messages appear on the right.
- Data is saved only in the browser where you imported it.
- Use **Alle lokalen Chats löschen** to remove all imported chats and media from this browser; single chats can be deleted from the list.
