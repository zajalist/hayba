import React, { useState } from 'react';
import * as Dialog from '@radix-ui/react-dialog';
import { Lightbulb, X } from 'lucide-react';

export function LightingPicker({ open, close, list, inspect }) {
  const [first, setFirst] = useState(''),
    [second, setSecond] = useState(''),
    [error, setError] = useState('');
  const options = list?.lights || [];
  return (
    <Dialog.Root
      open={open}
      onOpenChange={(v) => {
        if (!v) close();
      }}
    >
      <Dialog.Portal>
        <Dialog.Overlay className="overlay" />
        <Dialog.Content className="palette light-picker" aria-describedby={undefined}>
          <div className="dialoghead">
            <Dialog.Title>Inspect two lights</Dialog.Title>
            <Dialog.Close aria-label="Close lighting picker">
              <X />
            </Dialog.Close>
          </div>
          {list?.error ? (
            <p role="alert">{list.error}</p>
          ) : !list ? (
            <p role="status">Reading lights from Unreal…</p>
          ) : options.length < 2 ? (
            <p>Open a level with at least two loaded point, spot, rect or directional light actors.</p>
          ) : (
            <form
              onSubmit={async (e) => {
                e.preventDefault();
                const result = await inspect(first, second);
                if (result?.error) setError(result.error);
                else close();
              }}
            >
              {[
                ['First light', first, second, setFirst],
                ['Second light', second, first, setSecond],
              ].map(([label, value, other, set]) => (
                <label key={label}>
                  {label}
                  <select required value={value} onChange={(e) => set(e.target.value)}>
                    <option value="">Choose a light</option>
                    {options.map((l) => (
                      <option key={l.id} value={l.id} disabled={l.id === other}>
                        {l.label} · {l.actor_id}
                      </option>
                    ))}
                  </select>
                </label>
              ))}
              {error && <p role="alert">{error}</p>}
              <button className="primary" disabled={!first || !second || first === second}>
                Inspect lights
              </button>
            </form>
          )}
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

const states = {
  inspected: 'Inspected',
  proposed: 'Awaiting approval',
  applying: 'Applying and verifying…',
  checking: 'Checking both lights…',
  'editor-review':
    'Approve once in the Hayba panel in Unreal. Desktop will verify both lights when the editor accepts.',
  declined: 'Declined · both values verified',
  applied: 'Applied · both values verified',
  undone: 'Undone · both values verified',
  unverified: 'Verification incomplete',
  cancelled: 'Review cancelled in Desktop',
};

export function LightingCard({ record: r, active, attached, automatic, busy, run }) {
  const [target, setTarget] = useState(r.baseline[0].id),
    [value, setValue] = useState(''),
    [error, setError] = useState('');
  const light = r.baseline.find((l) => l.id === r.target);
  const act = async (op, input) => {
    setError('');
    const response = await run(op, input);
    if (response?.error) setError(response.error);
  };
  const editable = active && ['inspected', 'declined', 'undone'].includes(r.status);
  return (
    <section className="light-card" aria-label="Lighting review">
      <header>
        <Lightbulb />
        <strong>Lighting review</strong>
        <span>{r.map}</span>
      </header>
      <table>
        <thead>
          <tr>
            <th>Light</th>
            <th>Initial intensity</th>
            <th>Last read</th>
          </tr>
        </thead>
        <tbody>
          {r.baseline.map((l) => (
            <tr key={l.id}>
              <th scope="row" title={l.id}>
                {l.label}
                <small>{l.type}</small>
              </th>
              <td>{l.intensity}</td>
              <td>{r.observed?.find((o) => o.id === l.id)?.intensity ?? 'Unknown'}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <p role="status">
        {!active && ['editor-review', 'applying', 'checking', 'proposed'].includes(r.status)
          ? 'Review expired. Inspect the lights again.'
          : states[r.status]}
      </p>
      {editable && (
        <form
          className="light-edit"
          onSubmit={(e) => {
            e.preventDefault();
            void act('propose', { id: r.id, target, intensity: Number(value) });
          }}
        >
          <label>
            Change light
            <select value={target} onChange={(e) => setTarget(e.target.value)}>
              {r.baseline.map((l) => (
                <option value={l.id} key={l.id}>
                  {l.label}
                </option>
              ))}
            </select>
          </label>
          <label>
            New intensity
            <input required type="number" min="0" step="any" value={value} onChange={(e) => setValue(e.target.value)} />
          </label>
          <button disabled={busy || value === ''}>{automatic ? 'Apply change' : 'Review change'}</button>
        </form>
      )}
      {light && r.status === 'proposed' && (
        <p>
          <strong>{light.label}</strong> · Intensity {light.intensity} → {r.value}
        </p>
      )}
      {active && r.status === 'proposed' && (
        <div className="light-actions">
          <button className="primary" disabled={busy} onClick={() => act('approve', { token: r.token })}>
            Approve change
          </button>
          <button disabled={busy} onClick={() => act('decline', { token: r.token })}>
            Decline
          </button>
        </div>
      )}
      {active && r.status === 'editor-review' && (
        <button onClick={() => act('cancel', { token: r.token })}>Cancel review</button>
      )}
      {r.status === 'applied' && (
        <button
          disabled={busy || !attached}
          title={attached ? 'Restore and verify the original intensity' : 'Reattach the same project to undo'}
          onClick={() => act('undo', { id: r.id, token: r.token })}
        >
          Undo intensity change
        </button>
      )}
      {(error || r.error) && <p role="alert">{error || r.error}</p>}
      {!!r.history?.length && (
        <details>
          <summary>Review history</summary>
          <ol>
            {r.history.map((h, i) => (
              <li key={i}>
                {h.status} · {h.target} · {h.values.join(' / ')}
              </li>
            ))}
          </ol>
        </details>
      )}
    </section>
  );
}
