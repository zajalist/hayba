import { randomBytes } from 'node:crypto';
import { getProvider, listProviders } from '../agents/providers.js';
import { last4, loadVault, saveVault, type AppVault } from './vault.js';

export interface ChatEvent {
  event: string;
  data: Record<string, unknown>;
}

export interface ChatClient {
  config(body: Record<string, unknown>): Promise<{ ok: boolean; error?: string }>;
  stream(
    body: Record<string, unknown>,
    onEvent: (event: ChatEvent) => void,
    signal: AbortSignal,
  ): Promise<void>;
  cancel(sessionId: string): Promise<void>;
}

export interface WorkspaceMessage {
  id: number;
  role: 'user' | 'assistant' | 'inspection';
  text: string;
  notice?: boolean;
}

type WorkspaceAction = {
  action?: string;
  value?: string;
  seq?: number;
  provider?: string;
  model?: string;
  baseURL?: string;
  api_key?: string;
  mode?: string;
};

export class WorkspaceHost {
  generation = randomBytes(8).toString('hex');
  sessionId = `app_${randomBytes(8).toString('hex')}`;
  draftAck = 0;
  lastSendSeq = 0;
  draft = '';
  busy = false;
  canSend = true;
  view = 'chat';
  mode = 'explore';
  settingsMessage = '';
  messages: WorkspaceMessage[] = [];
  abort: AbortController | null = null;
  vault: AppVault;

  constructor(
    private readonly chat: ChatClient,
    private readonly vaultPath?: string,
  ) {
    this.vault = loadVault(vaultPath);
  }

  snapshot() {
    const provider = getProvider(this.vault.provider);
    const hasKey = Boolean(this.vault.keys[this.vault.provider]);
    const needsKey = provider?.needsKey !== false;
    return {
      generation: this.generation,
      busy: this.busy,
      inspecting: false,
      awaitingApproval: false,
      canSend: this.canSend && !this.busy,
      externalReview: false,
      messages: this.messages,
      workspace: {
        standalone: true,
        sessionId: this.sessionId,
        credentialSetupRequired: Boolean(needsKey && !hasKey),
        title: this.messages.find((m) => m.role === 'user')?.text.slice(0, 80) || 'New conversation',
        project: 'Hayba',
        draft: { text: this.draft, revision: this.draftAck, ack: this.draftAck },
        mode: this.mode,
        model: {
          id: this.vault.model || provider?.defaultModel || '',
          name: this.vault.model || provider?.label || 'Choose model',
          provider: this.vault.provider,
          locked: this.busy,
          loading: false,
          message: this.settingsMessage,
          manualAllowed: true,
          models: [],
        },
        effort: { value: '', options: [] },
        sessions: { items: [], loading: false, query: '', offset: 0 },
        history: { items: [], query: '', offset: 0 },
        context: [],
        connections: [],
        jobs: [],
        subagents: { agents: [], loading: false },
        view: this.view,
        settings: {
          provider: this.vault.provider,
          model: this.vault.model,
          baseURL: this.vault.baseURL,
          sidecarURL: '',
          planMode: this.mode !== 'explore',
          autoStartSidecar: true,
          useHaybaPro: false,
          brainLlmMode: 'byok',
          brainEmail: '',
          advisoryVerbosity: 'errors_and_warnings',
          leaseEnforcement: 'advisory',
          message: this.settingsMessage,
          providers: listProviders()
            .filter((item) => item.id !== 'mock')
            .map((item) => ({
              id: item.id,
              label: item.label,
              baseURLDefault: item.baseURLDefault,
              defaultModel: item.defaultModel,
              needsKey: item.needsKey,
              keyHint: item.keyHint,
              hasKey: Boolean(this.vault.keys[item.id]),
              keyLast4: last4(this.vault.keys[item.id]),
            })),
        },
        activity: [],
        generation3d: { busy: false },
      },
    };
  }

  async handle(event: WorkspaceAction | Record<string, unknown>): Promise<ReturnType<WorkspaceHost['snapshot']>> {
    const action = String(event.action || '');
    const value = typeof event.value === 'string' ? event.value : '';
    if (action === 'ready') return this.snapshot();
    if (action === 'view' || action === 'settings' || action === 'activity') {
      this.view = action === 'view' ? value || 'chat' : action;
      return this.snapshot();
    }
    if (action === 'draft_changed') {
      const seq = Number(event.seq || 0);
      if (seq > this.draftAck) {
        this.draftAck = seq;
        this.draft = value;
      }
      return this.snapshot();
    }
    if (action === 'mode' && ['explore', 'draft', 'production'].includes(value)) this.mode = value;
    if (action === 'save_settings') {
      const provider = typeof event.provider === 'string' ? event.provider : '';
      const mode = typeof event.mode === 'string' ? event.mode : '';
      if (provider && getProvider(provider)) this.vault.provider = provider;
      if (typeof event.model === 'string') this.vault.model = event.model;
      if (typeof event.baseURL === 'string') this.vault.baseURL = event.baseURL;
      if (mode && ['explore', 'draft', 'production'].includes(mode)) this.mode = mode;
      saveVault(this.vault, this.vaultPath);
      this.settingsMessage = 'Settings saved.';
      this.view = 'settings';
      return this.snapshot();
    }
    if (action === 'submit_chat_key') {
      const requested = typeof event.provider === 'string' ? event.provider : '';
      const provider = requested && getProvider(requested) ? requested : this.vault.provider;
      const key = value.trim();
      if (!key || key.length > 4096) {
        this.settingsMessage = 'Enter a valid API key.';
        return this.snapshot();
      }
      this.vault.provider = provider;
      this.vault.keys[provider] = key;
      saveVault(this.vault, this.vaultPath);
      this.settingsMessage = 'Key saved. Chat will use this provider.';
      this.view = 'settings';
      await this.pushConfig();
      return this.snapshot();
    }
    if (action === 'disconnect_chat_key') {
      const provider = value && getProvider(value) ? value : this.vault.provider;
      delete this.vault.keys[provider];
      saveVault(this.vault, this.vaultPath);
      this.settingsMessage = 'Stored key removed.';
      return this.snapshot();
    }
    if (action === 'new') {
      this.abort?.abort();
      this.generation = randomBytes(8).toString('hex');
      this.sessionId = `app_${randomBytes(8).toString('hex')}`;
      this.messages = [];
      this.draft = '';
      this.draftAck = 0;
      this.lastSendSeq = 0;
      this.busy = false;
      this.canSend = true;
      this.view = 'chat';
      return this.snapshot();
    }
    if (action === 'stop') {
      this.abort?.abort();
      await this.chat.cancel(this.sessionId).catch(() => undefined);
      this.busy = false;
      this.canSend = true;
      return this.snapshot();
    }
    if (action === 'send') {
      const seq = Number(event.seq || 0);
      if (seq <= this.lastSendSeq) return this.snapshot();
      const text = value.trim();
      if (!text || this.busy) return this.snapshot();
      const provider = getProvider(this.vault.provider);
      if (provider?.needsKey && !this.vault.keys[this.vault.provider]) {
        this.settingsMessage = 'Add your chat provider key to send. Your draft is saved.';
        this.view = 'settings';
        this.draft = text;
        return this.snapshot();
      }
      this.lastSendSeq = seq;
      if (seq > this.draftAck) this.draftAck = seq;
      this.draft = '';
      this.messages.push({ id: this.messages.length, role: 'user', text });
      this.messages.push({ id: this.messages.length, role: 'assistant', text: 'Responding…' });
      this.busy = true;
      this.canSend = false;
      void this.runTurn(text);
      return this.snapshot();
    }
    return this.snapshot();
  }

  private async pushConfig(): Promise<void> {
    const key = this.vault.keys[this.vault.provider];
    const result = await this.chat.config({
      session_id: this.sessionId,
      provider: this.vault.provider,
      model: this.vault.model || undefined,
      base_url: this.vault.baseURL || undefined,
      api_key: key || undefined,
    });
    if (!result.ok) this.settingsMessage = result.error || 'Could not apply chat provider settings.';
  }

  private async runTurn(prompt: string): Promise<void> {
    this.abort = new AbortController();
    const assistant = this.messages[this.messages.length - 1];
    let text = '';
    try {
      await this.pushConfig();
      await this.chat.stream(
        {
          session_id: this.sessionId,
          prompt,
          provider: this.vault.provider,
          model: this.vault.model || undefined,
          mode: this.mode,
        },
        (frame) => {
          if (frame.event === 'text_delta' && typeof frame.data.text === 'string') {
            text += frame.data.text;
            if (assistant) assistant.text = text;
          } else if (frame.event === 'error') {
            const error = typeof frame.data.error === 'string' ? frame.data.error : 'The chat turn failed.';
            if (assistant) {
              assistant.text = `⚠ ${error}`;
              assistant.notice = true;
            }
          } else if (frame.event === 'done') {
            const finalText =
              typeof frame.data.assistant_text === 'string' && frame.data.assistant_text
                ? frame.data.assistant_text
                : text;
            if (assistant) assistant.text = finalText || assistant.text || 'Done.';
          }
        },
        this.abort.signal,
      );
    } catch (error) {
      if (assistant && !this.abort.signal.aborted) {
        assistant.text = `⚠ ${error instanceof Error ? error.message : 'The Hayba chat server did not complete this turn.'}`;
        assistant.notice = true;
      }
    } finally {
      this.busy = false;
      this.canSend = true;
      this.abort = null;
    }
  }
}

export function createHttpChatClient(base: string): ChatClient {
  const url = base.replace(/\/$/, '');
  return {
    async config(body) {
      const response = await fetch(`${url}/chat/config`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
      const json = (await response.json().catch(() => ({}))) as { error?: string };
      return { ok: response.ok, error: json.error };
    },
    async stream(body, onEvent, signal) {
      const response = await fetch(`${url}/chat/stream`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'text/event-stream' },
        body: JSON.stringify(body),
        signal,
      });
      if (!response.ok || !response.body) {
        const json = (await response.json().catch(() => ({}))) as { error?: string };
        throw new Error(json.error || `Chat stream failed (${response.status})`);
      }
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        let gap = buffer.indexOf('\n\n');
        while (gap >= 0) {
          const block = buffer.slice(0, gap);
          buffer = buffer.slice(gap + 2);
          let name = 'message';
          let data = '';
          for (const line of block.split('\n')) {
            if (line.startsWith('event:')) name = line.slice(6).trim();
            else if (line.startsWith('data:')) data += line.slice(5).trim();
          }
          if (data) {
            try {
              onEvent({ event: name, data: JSON.parse(data) as Record<string, unknown> });
            } catch {
              /* ignore malformed keepalives */
            }
          }
          gap = buffer.indexOf('\n\n');
        }
      }
    },
    async cancel(sessionId) {
      await fetch(`${url}/chat/cancel`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ session_id: sessionId }),
      }).catch(() => undefined);
    },
  };
}
