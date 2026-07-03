# Chat Mirror

A WhatsApp-look-alike web app to upload old chats and browse them in a familiar interface.

## Features

- Upload WhatsApp exports as `.txt` or `.zip`
- WhatsApp-style message bubbles with day separators
- Instant message search for older messages
- Filters by sender and date range
- Previous/next match navigation
- Local browser persistence so chats stay available after refresh
- Privacy-first: parsing and searching are done in-browser

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
- WhatsApp exported zip (`.zip`) containing transcript `.txt` and optional media files

## Notes

- Media in zip is shown as placeholders, and image preview appears when filename references match.
- Data is saved only in the browser where you imported it.
- Use the **Clear local data** button to remove all imported chats from this browser.
