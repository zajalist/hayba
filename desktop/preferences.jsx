import React, { useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { KeyRound, ShieldCheck } from 'lucide-react';
import './preferences.css';
function Settings() {
  const [saved, setSaved] = useState(null),
    [provider, setProvider] = useState('anthropic'),
    [model, setModel] = useState(''),
    [key, setKey] = useState(''),
    [error, setError] = useState(''),
    [saving, setSaving] = useState(false);
  useEffect(() => {
    window.providerSettings
      .info()
      .then((info) => {
        setSaved(info);
        setProvider(info.provider || 'anthropic');
        setModel(info.model || '');
      })
      .catch(() => setError('Could not read provider settings. Reopen this window to retry.'));
  }, []);
  const known = saved?.provider === provider;
  async function save(value) {
    setSaving(true);
    setError('');
    try {
      if (await window.providerSettings.save(value)) return;
    } catch {}
    setSaving(false);
    setError('Could not save the connection. Check the key and model ID and try again.');
  }
  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        save({ provider, model: model.trim(), key: key.trim() });
      }}
    >
      <div className="keyicon">
        <KeyRound />
      </div>
      <h1>Provider settings</h1>
      <p>Choose the account and model for your conversations.</p>
      <fieldset disabled={!saved || saving}>
        <label>
          Provider
          <select
            id="provider"
            value={provider}
            onChange={(e) => {
              const p = e.target.value;
              setProvider(p);
              setKey('');
              setModel(saved?.provider === p ? saved.model : '');
            }}
          >
            <option value="anthropic">Anthropic</option>
            <option value="openai">OpenAI</option>
          </select>
        </label>
        <label>
          Model ID
          <input
            required
            maxLength="160"
            value={model}
            onChange={(e) => setModel(e.target.value)}
            placeholder="Model ID from your provider"
          />
        </label>
        <label>
          API key
          <input
            required={!known}
            type="password"
            maxLength="4096"
            value={key}
            onChange={(e) => setKey(e.target.value)}
            placeholder={known ? 'Leave blank to keep your saved key' : 'Paste your API key'}
            autoComplete="off"
          />
        </label>
        <div className="privacy">
          <ShieldCheck />
          <span>Windows encrypts your key for this account. Messages are sent to your chosen provider.</span>
        </div>
        <div className="buttons">
          {known && (
            <button type="button" onClick={() => save(null)}>
              Remove key
            </button>
          )}
          <button type="submit">{saving ? 'Saving…' : 'Save connection'}</button>
        </div>
      </fieldset>
      {error && <p role="alert">{error}</p>}
    </form>
  );
}
createRoot(document.getElementById('root')).render(<Settings />);
