import { describe, it, expect, vi, afterEach } from 'vitest';
import { createWebSpeechTts, createNoopTts } from './tts.js';

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('createNoopTts', () => {
  it('available() returns false', () => {
    expect(createNoopTts().available()).toBe(false);
  });
  it('speak() resolves immediately', async () => {
    await expect(createNoopTts().speak('hi')).resolves.toBeUndefined();
  });
  it('stop() does not throw', () => {
    expect(() => createNoopTts().stop()).not.toThrow();
  });
});

describe('createWebSpeechTts', () => {
  it('available() returns false when window has no speechSynthesis', () => {
    vi.stubGlobal('window', {});
    expect(createWebSpeechTts().available()).toBe(false);
  });

  it('available() returns true when window.speechSynthesis exists', () => {
    vi.stubGlobal('window', { speechSynthesis: { speak() {}, cancel() {}, getVoices: () => [] } });
    expect(createWebSpeechTts().available()).toBe(true);
  });

  it('speak() invokes synthesis.speak with an utterance carrying text, rate, and pitch', async () => {
    const speak = vi.fn();
    const utterances: Array<{ text: string; rate?: number; pitch?: number; onend?: () => void }> = [];
    class FakeUtterance {
      text: string;
      rate?: number;
      pitch?: number;
      lang?: string;
      voice?: unknown;
      onend?: () => void;
      onerror?: (e: unknown) => void;
      constructor(text: string) {
        this.text = text;
        utterances.push(this);
      }
    }
    vi.stubGlobal('window', {
      speechSynthesis: {
        speak: (u: FakeUtterance) => {
          speak(u);
          // simulate async end
          queueMicrotask(() => u.onend?.());
        },
        cancel() {},
        getVoices: () => [],
      },
      SpeechSynthesisUtterance: FakeUtterance,
    });

    const tts = createWebSpeechTts();
    await tts.speak('hi', { rate: 1.1, pitch: 0.9 });

    expect(speak).toHaveBeenCalledTimes(1);
    expect(utterances).toHaveLength(1);
    expect(utterances[0]!.text).toBe('hi');
    expect(utterances[0]!.rate).toBe(1.1);
    expect(utterances[0]!.pitch).toBe(0.9);
  });

  it('stop() calls speechSynthesis.cancel and is idempotent', () => {
    const cancel = vi.fn();
    vi.stubGlobal('window', {
      speechSynthesis: { speak() {}, cancel, getVoices: () => [] },
    });
    const tts = createWebSpeechTts();
    tts.stop();
    tts.stop();
    expect(cancel).toHaveBeenCalledTimes(2);
  });
});
