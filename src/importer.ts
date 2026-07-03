import JSZip from 'jszip';
import { parseWhatsappText } from './parser';
import type { ChatData } from './types';

const IMAGE_EXTENSIONS = new Set(['jpg', 'jpeg', 'png', 'gif', 'webp', 'heic']);

function guessNameFromFile(fileName: string): string {
  const clean = fileName.replace(/\.[^/.]+$/, '');
  return clean || 'Imported chat';
}

function scoreWhatsappText(text: string): number {
  const sample = text.split(/\r?\n/).slice(0, 200);
  const starter = /^(\d{1,2}[\/.\-]\d{1,2}[\/.\-]\d{2,4}),\s\d{1,2}:\d{2}/;
  return sample.reduce((acc, line) => (starter.test(line) ? acc + 1 : acc), 0);
}

function getExtension(fileName: string): string {
  const match = fileName.toLowerCase().match(/\.([a-z0-9]+)$/);
  return match?.[1] ?? '';
}

async function buildMediaMap(zip: JSZip): Promise<Map<string, { url: string; mime: string }>> {
  const mediaMap = new Map<string, { url: string; mime: string }>();

  for (const entry of Object.values(zip.files)) {
    if (entry.dir) {
      continue;
    }

    const extension = getExtension(entry.name);
    if (!IMAGE_EXTENSIONS.has(extension)) {
      continue;
    }

    const blob = await entry.async('blob');
    const mime = `image/${extension === 'jpg' ? 'jpeg' : extension}`;
    const url = URL.createObjectURL(blob);
    const fileName = entry.name.split('/').pop()?.toLowerCase();

    if (fileName) {
      mediaMap.set(fileName, { url, mime });
    }
  }

  return mediaMap;
}

function chooseTranscript(files: Array<{ name: string; content: string }>): { name: string; content: string } {
  if (files.length === 1) {
    return files[0];
  }

  return files.reduce((best, current) =>
    scoreWhatsappText(current.content) > scoreWhatsappText(best.content) ? current : best,
  );
}

export async function importChat(file: File): Promise<ChatData> {
  if (file.name.toLowerCase().endsWith('.txt')) {
    const content = await file.text();
    return parseWhatsappText(content, guessNameFromFile(file.name), new Map());
  }

  if (!file.name.toLowerCase().endsWith('.zip')) {
    throw new Error('Unsupported file type. Use .txt or .zip exports.');
  }

  const zip = await JSZip.loadAsync(file);
  const textEntries = Object.values(zip.files).filter(
    (entry) => !entry.dir && entry.name.toLowerCase().endsWith('.txt'),
  );

  if (!textEntries.length) {
    throw new Error('No .txt transcript found in zip file.');
  }

  const transcripts: Array<{ name: string; content: string }> = [];
  for (const entry of textEntries) {
    transcripts.push({
      name: entry.name,
      content: await entry.async('text'),
    });
  }

  const transcript = chooseTranscript(transcripts);
  const mediaMap = await buildMediaMap(zip);
  const chatName = guessNameFromFile(transcript.name.split('/').pop() ?? file.name);

  return parseWhatsappText(transcript.content, chatName, mediaMap);
}
