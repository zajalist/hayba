import { writeFileSync, existsSync, mkdirSync } from 'fs';
import path from 'path';
import ytApi from 'youtube-transcript-api';

interface TranscriptSegment {
  text: string;
  duration: number;
  offset: number;
}

const TRANSCRIPTS_DIR = './src/gaea/transcripts';

const VIDEO_URLS = [
  'https://www.youtube.com/watch?v=f5YIzzoQJwI',
  'https://www.youtube.com/watch?v=7-SQ3Xg8Qcc',
  'https://www.youtube.com/watch?v=VXJHETyCHJk',
  'https://www.youtube.com/watch?v=-zJHscHbobY',
  'https://www.youtube.com/watch?v=7XfdVYVMYs0',
  'https://www.youtube.com/watch?v=4j3ErgwL8TM',
  'https://www.youtube.com/watch?v=A-v4euFzMAw',
  'https://www.youtube.com/watch?v=Ae0pP5YxxL0',
  'https://www.youtube.com/watch?v=KwSfAJtdATs',
  'https://www.youtube.com/watch?v=fqF2zE3PKnQ',
  'https://www.youtube.com/watch?v=AyJtx2kp-WY',
  'https://www.youtube.com/watch?v=-PjaJ0P0mWA',
  'https://www.youtube.com/watch?v=ZdFC9rjb0jA',
];

function extractVideoId(url: string): string {
  const match = url.match(/(?:v=|youtu\.be\/)([a-zA-Z0-9_-]{11})/);
  return match ? match[1] : '';
}

async function scrapeTranscript(videoId: string): Promise<string | null> {
  try {
    const clientClass = (ytApi as unknown as { default: new () => { getTranscript: (id: string, opts: { language: string }) => Promise<TranscriptSegment[]> } }).default;
    const client = new clientClass();
    const transcript = await client.getTranscript(videoId, { language: 'en' });
    const text = transcript.map((item: TranscriptSegment) => item.text).join(' ');
    return text;
  } catch (err) {
    console.error(`Failed to scrape ${videoId}:`, err);
    return null;
  }
}

async function main() {
  if (!existsSync(TRANSCRIPTS_DIR)) {
    mkdirSync(TRANSCRIPTS_DIR, { recursive: true });
  }

  let newCount = 0;
  for (const url of VIDEO_URLS) {
    const videoId = extractVideoId(url);
    if (!videoId) {
      console.log(`Invalid URL: ${url}`);
      continue;
    }

    const filePath = path.join(TRANSCRIPTS_DIR, `${videoId}.txt`);

    if (existsSync(filePath)) {
      console.log(`Already exists: ${videoId}`);
      continue;
    }

    console.log(`Scraping: ${videoId}`);
    const transcript = await scrapeTranscript(videoId);

    if (transcript) {
      writeFileSync(filePath, transcript);
      console.log(`Saved: ${filePath}`);
      newCount++;
    }

    await new Promise(resolve => setTimeout(resolve, 1000));
  }

  console.log(`Done! Scraped ${newCount} new transcripts.`);
}

main().catch(console.error);