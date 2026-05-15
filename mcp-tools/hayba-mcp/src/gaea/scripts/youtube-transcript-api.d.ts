declare module 'youtube-transcript-api' {
  interface TranscriptSegment {
    text: string;
    duration: number;
    offset: number;
  }
  export function getTranscript(videoId: string, options?: { language?: string }): Promise<TranscriptSegment[]>;
}
