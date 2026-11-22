import React, { useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { Cable, LockKeyhole, MessagesSquare, Settings2, SlidersHorizontal } from 'lucide-react';
import preferences from './preferences.cjs';
import './preferences.css';

const { DEFAULT_PREFERENCES } = preferences;
const api = window.providerSettings;
const sections = [
  { id: 'connection', title: 'Connection', icon: Cable },
  { id: 'chat', title: 'Chat & display', icon: MessagesSquare },
  { id: 'agent', title: 'Agent behavior', icon: SlidersHorizontal },
];
const fallbackProviders = [
  { id: 'anthropic', label: 'Anthropic', needsKey: true },
  { id: 'openai', label: 'OpenAI', needsKey: true },
];
const chatKeys = ['sendShortcut', 'transcriptSize', 'density', 'expandToolDetails', 'followOutput'];
const agentKeys = ['customInstructions', 'maxTokens', 'maxToolCalls'];

function Heading({ title, children }) {
  return <header className="section-heading"><h2>{title}</h2><p>{children}</p></header>;
}

function Row({ id, label, hint, children }) {
  return (
    <div className="setting-row">
      <div><label htmlFor={id}>{label}</label>{hint && <p id={id + '-hint'}>{hint}</p>}</div>
      {children}
    </div>
  );
}

function SelectRow({ id, label, hint, value, onChange, options }) {
  return (
    <Row id={id} label={label} hint={hint}>
      <select id={id} aria-describedby={hint ? id + '-hint' : undefined}
        value={value} onChange={(e) => onChange(typeof value === 'number' ? Number(e.target.value) : e.target.value)}>
        {options.map(([id, name]) => <option key={id} value={id}>{name}</option>)}
      </select>
    </Row>
  );
}

function SwitchRow({ id, label, hint, value, onChange }) {
  return (
    <Row id={id} label={label} hint={hint}>
      <input className="switch" type="checkbox" id={id} role="switch" aria-describedby={id + '-hint'}
        checked={value} onChange={(e) => onChange(e.target.checked)} />
    </Row>
  );
}

function Connection({ info, value, setValue }) {
  const providers = info?.providers?.length ? info.providers : fallbackProviders;
  const entry = providers.find((item) => item.id === value.provider);
  const savedDestination = info?.provider === value.provider && (info.baseURL || '') === value.baseURL.trim();
  const savedKey = savedDestination && (info.hasKey ?? entry?.needsKey);
  const endpoint = value.baseURL.trim() || entry?.baseURLDefault;

  function selectProvider(id) {
    const saved = info?.provider === id;
    setValue({ provider: id, model: saved ? info.model : '', baseURL: saved ? info.baseURL || '' : '', key: '' });
  }

  return (
    <>
      <Heading title="Connection">Choose the provider and model for your conversations.</Heading>
      <div className="field">
        <label htmlFor="provider">Provider</label>
        <select id="provider" value={value.provider} onChange={(e) => selectProvider(e.target.value)}>
          {providers.map((item) => <option value={item.id} key={item.id}>{item.label}</option>)}
        </select>
      </div>
      <div className="field">
        <label htmlFor="model">Model ID</label>
        <input id="model" required maxLength={160} value={value.model} spellCheck={false} autoComplete="off"
          onChange={(e) => setValue({ ...value, model: e.target.value })}
          placeholder={entry?.defaultModel || 'Exact model ID from your provider'} />
      </div>
      <div className="field">
        <div className="field-title"><label htmlFor="endpoint">Custom endpoint</label>
          {value.provider !== 'custom' && <small>Optional</small>}</div>
        <input type="url" id="endpoint" required={value.provider === 'custom'} maxLength={2048}
          value={value.baseURL} autoComplete="off" spellCheck={false} aria-describedby="endpoint-hint"
          placeholder={entry?.baseURLDefault || 'API base URL'}
          onChange={(e) => setValue({ ...value, baseURL: e.target.value, key: '' })} />
        <p id="endpoint-hint">{value.provider === 'custom' ? 'Enter the base URL of your OpenAI-compatible server.' : 'Leave blank to use the provider’s default endpoint.'}</p>
      </div>
      <div className="field">
        <div className="field-title"><label htmlFor="api-key">API key</label>
          {(savedKey || !entry?.needsKey) && <small>{savedKey ? 'Key saved' : 'Optional'}</small>}</div>
        <input id="api-key" type="password" required={Boolean(entry?.needsKey && !savedKey)} maxLength={4096}
          value={value.key} autoComplete="off" spellCheck={false}
          onChange={(e) => setValue({ ...value, key: e.target.value })}
          placeholder={savedKey ? 'Leave blank to keep your saved key' : entry?.needsKey ? 'Enter a key for this endpoint' : 'Enter a key if your server requires one'} />
      </div>
      <div className="destination">
        <LockKeyhole aria-hidden="true" />
        <div><strong>{endpoint || 'Selected endpoint'}</strong>
          <p>This endpoint receives your messages and any API key. Windows encrypts saved keys for your account.</p>
        </div>
      </div>
    </>
  );
}

function ChatSettings({ value, change }) {
  return (
    <>
      <Heading title="Chat & display">Set how you send messages and read conversations.</Heading>
      <h3>Composer</h3>
      <SelectRow id="sendShortcut" label="Send message with" hint={value.sendShortcut === 'enter' ? 'Shift + Enter inserts a new line.' : 'Enter inserts a new line.'}
        value={value.sendShortcut} onChange={(v) => change('sendShortcut', v)}
        options={[['enter', 'Enter'], ['modifier-enter', 'Ctrl + Enter']]} />
      <h3>Transcript</h3>
      <SelectRow id="transcriptSize" label="Text size" value={value.transcriptSize}
        onChange={(v) => change('transcriptSize', v)} options={[['small', 'Small'], ['standard', 'Standard'], ['large', 'Large']]} />
      <SelectRow id="density" label="Message spacing" value={value.density} onChange={(v) => change('density', v)}
        options={[['comfortable', 'Comfortable'], ['compact', 'Compact']]} />
      <SwitchRow id="expandToolDetails" label="Expand tool details" hint="Open tool results in the transcript by default."
        value={value.expandToolDetails} onChange={(v) => change('expandToolDetails', v)} />
      <SwitchRow id="followOutput" label="Follow new output" hint="Scroll with replies while you’re at the bottom of the chat."
        value={value.followOutput} onChange={(v) => change('followOutput', v)} />
    </>
  );
}

function AgentSettings({ value, change }) {
  return (
    <>
      <Heading title="Agent behavior">Set the guidance and limits Hayba uses for new replies.</Heading>
      <div className="field">
        <label htmlFor="instructions">Custom instructions</label>
        <p id="instructions-hint">Included with each request to your selected provider.</p>
        <textarea id="instructions" rows={3} maxLength={2000} value={value.customInstructions}
          aria-describedby="instructions-hint" placeholder="For example, use Unreal asset paths when referring to levels."
          onChange={(e) => change('customInstructions', e.target.value)} />
        <small className="count">{value.customInstructions.length.toLocaleString()} / 2,000</small>
      </div>
      <h3>Request limits</h3>
      <SelectRow id="maxTokens" label="Response token limit" hint="Maximum output per provider request."
        value={value.maxTokens} onChange={(v) => change('maxTokens', v)}
        options={[[1024, '1,024 tokens'], [4096, '4,096 tokens'], [8192, '8,192 tokens']]} />
      <SelectRow id="maxToolCalls" label="Tool calls per turn" hint="Maximum number of tool calls for one message."
        value={value.maxToolCalls} onChange={(v) => change('maxToolCalls', v)}
        options={[[4, '4 calls'], [12, '12 calls'], [24, '24 calls']]} />
      <div className="editor-note"><strong>Editor safety</strong>
        <p>Set review or automatic edits in the chat composer after sharing a project. Configure Plan Mode and tool permissions in Hayba’s Unreal settings.</p>
      </div>
    </>
  );
}

function Settings() {
  const [section, setSection] = useState('connection');
  const [info, setInfo] = useState(null);
  const [connection, setConnection] = useState({ provider: 'anthropic', model: '', key: '', baseURL: '' });
  const [saved, setSaved] = useState(null);
  const [draft, setDraft] = useState(DEFAULT_PREFERENCES);
  const [loadingError, setLoadingError] = useState({});
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    api.info().then((info) => {
      if (!info) throw Error();
      setInfo(info);
      setConnection({ provider: info.provider || 'anthropic', model: info.model || '', baseURL: info.baseURL || '', key: '' });
    }).catch(() => setLoadingError((v) => ({ ...v, connection: 'Could not read your connection. Reopen Settings to retry.' })));
    api.preferences().then((prefs) => {
      if (!prefs) throw Error();
      setSaved(prefs);
      setDraft(prefs);
    }).catch(() => setLoadingError((v) => ({ ...v, preferences: 'Could not read your preferences. Reopen Settings to retry.' })));
  }, []);

  const changed = Object.fromEntries(Object.entries(draft).filter(([key, value]) => saved && value !== saved[key]));
  const dirty = Object.keys(changed).length > 0;
  const isConnection = section === 'connection';
  const disabled = saving || (isConnection ? !info : !saved);
  const currentError = error || loadingError[isConnection ? 'connection' : 'preferences'];
  function switchSection(id) {
    setSection(id);
    setNotice('');
    setError('');
  }
  function change(key, value) {
    setDraft((v) => ({ ...v, [key]: value }));
    setNotice('');
    setError('');
  }
  function restoreDefaults() {
    const keys = section === 'chat' ? chatKeys : agentKeys;
    setDraft((v) => ({ ...v, ...Object.fromEntries(keys.map((key) => [key, DEFAULT_PREFERENCES[key]])) }));
    setNotice('');
    setError('');
  }
  async function save(remove = false) {
    setSaving(true);
    setError('');
    setNotice('');
    try {
      if (dirty) {
        const next = await api.savePreferences(changed);
        if (!next) throw Error();
        setSaved(next);
        setDraft(next);
      }
    } catch {
      setError('Could not save preferences. Try again.');
      setSaving(false);
      return;
    }
    if (isConnection) {
      const { provider, model, baseURL, key } = connection;
      try {
        if (await api.save(remove ? null : { provider, model: model.trim(), baseURL: baseURL.trim(), key: key.trim() })) return;
      } catch { /* Show a message without exposing native errors or credentials. */ }
      setError(remove ? 'Could not remove the connection. Try again.' : 'Could not save the connection. Check the model ID, endpoint, and key.');
    } else {
      setNotice('Preferences saved.');
    }
    setSaving(false);
  }
  return (
    <div className="settings-shell">
      <aside>
        <div className="settings-title"><Settings2 aria-hidden="true" /><h1>Settings</h1></div>
        <nav aria-label="Settings sections">
          {sections.map(({ id, title, icon: Icon }) => (
            <button key={id} type="button" aria-current={section === id ? 'page' : undefined}
              disabled={saving} onClick={() => switchSection(id)}><Icon aria-hidden="true" />{title}</button>
          ))}
        </nav>
      </aside>
      <main>
        <form onSubmit={(e) => { e.preventDefault(); save(); }}>
          <div className="pane" key={section}>
            <fieldset disabled={disabled}>
              {isConnection
                ? <Connection info={info} value={connection} setValue={(v) => { setConnection(v); setError(''); }} />
                : section === 'chat' ? <ChatSettings value={draft} change={change} /> : <AgentSettings value={draft} change={change} />}
            </fieldset>
          </div>
          <footer>
            {currentError && <p role="alert">{currentError}</p>}
            <div className="actions">
              {isConnection && info?.provider === connection.provider && (
                <button type="button" className="subtle" disabled={disabled} onClick={() => save(true)}>Remove connection</button>
              )}
              {!isConnection && <button type="button" className="subtle" disabled={disabled} onClick={restoreDefaults}>Use defaults</button>}
              <span className="save-status" role="status">{dirty ? 'Unsaved changes' : notice}</span>
              <button type="submit" disabled={disabled || (!isConnection && !dirty)}>
                {saving ? 'Saving…' : isConnection ? 'Save connection' : 'Save preferences'}
              </button>
            </div>
          </footer>
        </form>
      </main>
    </div>
  );
}
createRoot(document.getElementById('root')).render(<Settings />);
