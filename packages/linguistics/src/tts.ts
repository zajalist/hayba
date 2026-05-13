/**
 * L23 — Speech synthesis (TTS).
 *
 * Thin wrapper over the browser Web Speech API. Quality is mediocre but free
 * and ubiquitous; this module is provider-shaped so a real phoneme-driven
 * synthesizer can be slotted in later.
 *
 * Feed romanized forms (not IPA) — TTS engines garble bare IPA glyphs.
 */

export interface TtsProvider {
  available(): boolean;
  speak(word: string, opts?: { rate?: number; pitch?: number; lang?: string }): Promise<void>;
  stop(): void;
}

interface SpeechSynthesisLike {
  speak(utterance: unknown): void;
  cancel(): void;
  getVoices(): Array<{ lang?: string; name?: string }>;
}

interface WindowLike {
  speechSynthesis?: SpeechSynthesisLike;
  SpeechSynthesisUtterance?: new (text: string) => unknown;
}

function getWindow(): WindowLike | undefined {
  if (typeof window === 'undefined') return undefined;
  return window as unknown as WindowLike;
}

export function createWebSpeechTts(): TtsProvider {
  return {
    available(): boolean {
      const w = getWindow();
      return !!w && 'speechSynthesis' in w && !!w.speechSynthesis;
    },
    speak(word, opts = {}) {
      const w = getWindow();
      if (!w || !w.speechSynthesis || !w.SpeechSynthesisUtterance) {
        return Promise.resolve();
      }
      const synth = w.speechSynthesis;
      const Utterance = w.SpeechSynthesisUtterance;
      return new Promise<void>((resolve, reject) => {
        const u = new Utterance(word) as Record<string, unknown> & {
          onend?: () => void;
          onerror?: (e: unknown) => void;
        };
        if (typeof opts.rate === 'number') u.rate = opts.rate;
        if (typeof opts.pitch === 'number') u.pitch = opts.pitch;
        if (opts.lang) {
          u.lang = opts.lang;
          try {
            const voices = synth.getVoices() ?? [];
            const match = voices.find(v => v.lang && v.lang.toLowerCase().startsWith(opts.lang!.toLowerCase()));
            if (match) u.voice = match;
          } catch {
            // ignore — leave default voice
          }
        }
        u.onend = () => resolve();
        u.onerror = (e: unknown) => reject(e instanceof Error ? e : new Error('TTS error'));
        synth.speak(u);
      });
    },
    stop(): void {
      const w = getWindow();
      if (w && w.speechSynthesis) {
        try { w.speechSynthesis.cancel(); } catch { /* idempotent */ }
      }
    },
  };
}

export function createNoopTts(): TtsProvider {
  return {
    available() { return false; },
    speak() { return Promise.resolve(); },
    stop() { /* no-op */ },
  };
}
