import React, { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import * as Dialog from '@radix-ui/react-dialog';
import * as Tooltip from '@radix-ui/react-tooltip';
import {
  Plus,
  Search,
  Settings2,
  MessageSquare,
  ArrowUp,
  Square,
  Box,
  ChevronDown,
  PanelLeft,
  X,
  ArrowUpRight,
  Layers3,
  Workflow,
  ListChecks,
  SlidersHorizontal,
  Cable,
  Copy,
  Check,
} from 'lucide-react';
import Markdown from 'react-markdown';
import { LightingCard, LightingPicker } from './lighting';
import { ConversationHistory } from './history.jsx';
import { Lightbulb } from 'lucide-react';
import './workspace.css';

const api = window.haybaDesktop;
const brand = <img className="brandmark" src="HaybaLogo.svg" alt="" />;
const actions = [
  [Layers3, 'Inspect a level', 'Summarize the current Unreal level and its actor count.', true],
  [Workflow, 'Plan a feature', 'Help me break a new feature into implementation steps.'],
  [ListChecks, 'Review a design', 'Help me review a technical design and identify trade-offs.'],
];
function IconButton({ label, children, ...props }) {
  return (
    <Tooltip.Root>
      <Tooltip.Trigger asChild>
        <button aria-label={label} {...props}>
          {children}
        </button>
      </Tooltip.Trigger>
      <Tooltip.Portal>
        <Tooltip.Content className="tip" sideOffset={6}>
          {label}
        </Tooltip.Content>
      </Tooltip.Portal>
    </Tooltip.Root>
  );
}
function SearchDialog({ open, setOpen, sessions, choose }) {
  const [query, setQuery] = useState('');
  const input = useRef(null);
  const filtered = sessions.filter((s) => s.title.toLowerCase().includes(query.trim().toLowerCase()));
  return (
    <Dialog.Root
      open={open}
      onOpenChange={(value) => {
        setOpen(value);
        if (!value) setQuery('');
      }}
    >
      <Dialog.Portal>
        <Dialog.Overlay className="overlay" />
        <Dialog.Content
          className="palette"
          aria-describedby={undefined}
          onOpenAutoFocus={(event) => {
            event.preventDefault();
            input.current?.focus();
          }}
        >
          <div className="dialoghead">
            <Dialog.Title>Find a conversation</Dialog.Title>
            <Dialog.Close asChild>
              <button aria-label="Close search">
                <X />
              </button>
            </Dialog.Close>
          </div>
          <label className="searchbox">
            <Search />
            <input
              ref={input}
              aria-label="Search conversations"
              placeholder="Search conversations…"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
            />
          </label>
          <div className="results">
            {filtered.map((s) => (
              <button
                key={s.id}
                onClick={() => {
                  choose(s.id);
                  setOpen(false);
                  setQuery('');
                }}
              >
                <MessageSquare />
                {s.title}
              </button>
            ))}
            {!filtered.length && <p>No matching conversations.</p>}
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
function LevelRead({ read, pending, expand }) {
  if (read.status !== 'complete') {
    const label =
      read.status === 'unavailable'
        ? 'Level unavailable. Open this project in Unreal with Hayba enabled.'
        : read.status === 'reading' && pending
          ? 'Reading level from Unreal…'
          : 'Level inspection stopped.';
    return (
      <p className="read-status" role="status">
        <Layers3 />
        {label}
      </p>
    );
  }
  const level = read.metadata;
  return (
    <details className="read-result" open={expand || undefined}>
      <summary>
        <Layers3 />
        <span>
          Read level <strong>{level.map_name}</strong>
        </span>
        <ChevronDown />
      </summary>
      <dl>
        <dt>Package</dt>
        <dd>{level.package_path ?? 'Unavailable'}</dd>
        <dt>Actors</dt>
        <dd>{level.actor_count ?? 'Unavailable'}</dd>
        <dt>Play in Editor</dt>
        <dd>
          {typeof level.is_pie_running === 'boolean' ? (level.is_pie_running ? 'Running' : 'Stopped') : 'Unavailable'}
        </dd>
      </dl>
    </details>
  );
}
function Message({ message, copy, pending, expand }) {
  const [copied, setCopied] = useState(false);
  const user = message.role === 'user';
  return (
    <article
      aria-label={user ? 'Your message' : 'Hayba message'}
      className={user ? 'user message' : 'assistant message'}
    >
      <header>
        {!user && brand}
        <strong>{user ? 'You' : 'Hayba'}</strong>
      </header>
      {message.levelRead && <LevelRead read={message.levelRead} pending={pending} expand={expand} />}
      {message.steps?.some((s) => s.label !== 'Read level') && (
        <details className="read-result" open={expand || undefined}>
          <summary><Workflow /><span>{message.steps.length} tool {message.steps.length === 1 ? 'step' : 'steps'}</span><ChevronDown /></summary>
          <ol>{message.steps.map((s, i) => <li key={i}>{s.label} · {s.status}{s.detail && <span> — {s.detail}</span>}</li>)}</ol>
        </details>
      )}
      <div className="body">
        {user ? (
          message.text
        ) : (
          <Markdown
            skipHtml
            components={{
              img: ({ alt }) => <span>{alt}</span>,
              a: ({ children, href }) => (
                <span title={href}>
                  {children} {href && <small>({href})</small>}
                </span>
              ),
            }}
          >
            {message.text}
          </Markdown>
        )}
      </div>
      {!user && message.text && !message.incomplete && (
        <IconButton
          label="Copy reply"
          className="copy"
          onClick={() => {
            copy(message.text);
            setCopied(true);
            setTimeout(() => setCopied(false), 1500);
          }}
        >
          {copied ? <Check /> : <Copy />}
        </IconButton>
      )}
    </article>
  );
}
function Workspace() {
  const [state, setState] = useState(null),
    [lightsOpen, setLightsOpen] = useState(false),
    [lightsList, setLightsList] = useState(null),
    [draft, setDraft] = useState(''),
    [find, setFind] = useState(false),
    [rail, setRail] = useState(() => window.innerWidth > 760);
  const snapshot = useRef(null),
    prompt = useRef(null),
    scroll = useRef(null),
    atEnd = useRef(true);
  useEffect(() => {
    api.onSnapshot((s) => {
      if (snapshot.current?.generation !== s.generation) atEnd.current = true;
      snapshot.current = s;
      setState(s);
    });
    api.onDraft(setDraft);
    api.command({ action: 'ready', value: '' }).then((value) => {
      if (typeof value === 'string') setDraft(value);
    });
    const keys = (e) => {
      if (document.querySelector('[role="dialog"]')) return;
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        if (!snapshot.current?.busy) setFind((v) => !v);
      }
      if ((e.ctrlKey || e.metaKey) && !e.shiftKey && ['n', ','].includes(e.key.toLowerCase())) {
        e.preventDefault();
        const s = snapshot.current;
        if (s && !s.busy && !s.lightingBusy) {
          void api.command({ action: e.key === ',' ? 'settings' : 'new', value: '', generation: s.generation });
        }
      }
      if (e.key === 'Escape' && window.innerWidth <= 760) setRail(false);
    };
    window.addEventListener('keydown', keys);
    return () => window.removeEventListener('keydown', keys);
  }, []);
  useLayoutEffect(() => {
    if (state?.workspace.preferences.followOutput && atEnd.current && scroll.current)
      scroll.current.scrollTop = scroll.current.scrollHeight;
  }, [state]);
  useEffect(() => {
    if (state?.generation) prompt.current?.focus();
  }, [state?.generation]);
  if (!state) return null;
  const { workspace: w, messages } = state;
  const busy = state.busy || state.lightingBusy;
  const command = (action, value = '') => api.command({ action, value, generation: state.generation });
  const lightCommand = (op, args = {}) => command('lighting-' + op, JSON.stringify(args));
  const showLights = async () => {
    if (!w.sharedProject && !(await command('project'))) return;
    setLightsList(null);
    setLightsOpen(true);
    setLightsList(await lightCommand('list'));
  };
  const edit = (text) => {
    setDraft(text);
    command('draft_changed', text);
  };
  const send = () => {
    if (busy) return command('stop');
    if (!state.canSend) return command('settings');
    if (draft.trim()) {
      command('send', draft.trim());
      setDraft('');
      atEnd.current = true;
    }
  };
  const choose = (id) => {
    command('session', id);
    if (window.innerWidth <= 760) setRail(false);
  };
  return (
    <Tooltip.Provider delayDuration={250}>
      <div className={'shell ' + (rail ? 'showrail' : '')} data-density={w.preferences.density} data-transcript={w.preferences.transcriptSize}>
        {rail && (
          <>
            <button className="backdrop" onClick={() => setRail(false)} aria-label="Dismiss navigation" />
            <aside className="rail">
              <div className="brand">
                {brand}
                <span>Hayba Desktop</span>
                <IconButton label="Hide sidebar" className="railclose" onClick={() => setRail(false)}>
                  <PanelLeft />
                </IconButton>
              </div>
              <button
                className="new"
                title="New chat (Ctrl+N)"
                disabled={busy || (!messages.length && !draft.trim())}
                onClick={() => {
                  command('new');
                  if (window.innerWidth <= 760) setRail(false);
                }}
              >
                <Plus />
                New chat
              </button>
              <button className="find" disabled={busy} onClick={() => setFind(true)}>
                <Search />
                Search chats<kbd>Ctrl K</kbd>
              </button>
              <ConversationHistory sessions={w.sessions} archivedSessions={w.archivedSessions}
                currentId={state.generation} busy={busy} choose={choose}
                archive={(id) => command('archive', id)} restore={(id) => command('restore', id)} />
              <button className="railsettings" disabled={busy} onClick={() => command('settings')}>
                <Settings2 />
                Settings
              </button>
            </aside>
          </>
        )}
        <main className={messages.length ? '' : 'empty-chat'}>
          <div className="topbar">
            {!rail && (
              <IconButton label="Show sidebar" onClick={() => setRail(true)}>
                <PanelLeft />
              </IconButton>
            )}
            <MessageSquare className="topicon" />
            <span className="crumb">Workspace</span>
            <span className="slash">/</span>
            <strong>{w.title}</strong>
            <IconButton label="Search conversations" disabled={busy} onClick={() => setFind(true)}>
              <Search />
            </IconButton>
          </div>
          <div
            className="scroll"
            ref={scroll}
            onScroll={(e) => {
              const el = e.currentTarget;
              atEnd.current = el.scrollHeight - el.scrollTop - el.clientHeight < 50;
            }}
          >
            {messages.length > 0 && (
              <div id="messages" className="transcript">
                {messages.map((m) =>
                  m.lighting ? (
                    <LightingCard
                      key={m.lighting.id}
                      record={m.lighting}
                      active={state.activeLightingId === m.lighting.id}
                      attached={Boolean(w.sharedProject)}
                      automatic={w.mode === 'automatic'}
                      busy={busy}
                      run={lightCommand}
                    />
                  ) : (
                    <Message
                      key={state.generation + '-' + m.id}
                      message={m}
                      expand={w.preferences.expandToolDetails}
                      pending={busy && m === messages.at(-1)}
                      copy={(text) => command('copy', text)}
                    />
                  ),
                )}
                {state.busy && (
                  <p role="status" className="responding">
                    Responding…
                  </p>
                )}
              </div>
            )}
          </div>
          <div className="dock">
            {!messages.length && <h1>What are you working on?</h1>}
            {!state.canSend && (
              <div className="setup">
                <Cable />
                <div>
                  <strong>Connect a provider</strong>
                  <span>Choose a hosted provider or a local model.</span>
                </div>
                <button aria-label="Open settings" onClick={() => command('settings')}>
                  Set up <ArrowUpRight />
                </button>
              </div>
            )}
            <div className="composer">
              <textarea
                ref={prompt}
                id="prompt"
                aria-label="Message Hayba"
                placeholder="Message Hayba…"
                value={draft}
                onChange={(e) => edit(e.target.value)}
                onKeyDown={(e) => {
                  const modifier = e.ctrlKey || e.metaKey;
                  if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing &&
                      (w.preferences.sendShortcut === 'modifier-enter' ? modifier : !modifier)) {
                    e.preventDefault();
                    if (!busy) send();
                  }
                }}
              />
              <div className="tools">
                <button
                  disabled={busy}
                  title={
                    w.sharedProject
                      ? 'Stop sharing level metadata in this chat'
                      : 'Share level metadata from an open Unreal project in this chat'
                  }
                  onClick={() => command('project')}
                >
                  <Box />
                  <span>{w.sharedProject || 'Share Unreal level'}</span>
                </button>
                <span className="divider" />
                <button disabled={busy} title="Inspect two lights and review an intensity change" onClick={showLights}>
                  <Lightbulb />
                  <span>Lighting</span>
                </button>
                {w.sharedProject && (
                  <select className="permission-mode" aria-label="Project approval mode" disabled={busy}
                    title="Automatic applies supported edits without approval when Unreal Plan Mode is off."
                    value={w.mode} onChange={(e) => command('mode', e.target.value)}>
                    <option value="review">Review edits</option>
                    <option value="automatic">Automatic · no approvals</option>
                  </select>
                )}
                <button className="model" disabled={busy} onClick={() => command('settings')}>
                  <SlidersHorizontal />
                  <span>{w.model.name}</span>
                  <ChevronDown />
                </button>
                <IconButton
                  id="send-button"
                  label={busy ? 'Stop response' : 'Send message'}
                  className="send"
                  disabled={state.lightingBusy || (!busy && !draft.trim())}
                  onClick={send}
                >
                  {busy ? <Square /> : <ArrowUp />}
                </IconButton>
              </div>
            </div>
            {w.sharedProject && w.mode === 'automatic' && (
              <p className="mode-help">Automatic edits use this project. For zero approvals, switch off Plan Mode in Unreal’s Hayba settings.</p>
            )}
            {!messages.length && (
              <div className="starters" data-drafting={Boolean(draft)} role="group" aria-label="Suggested prompts">
                {actions.map(([Icon, label, text, needsProject]) => (
                  <button
                    key={label}
                    onClick={async () => {
                      if (needsProject && !w.sharedProject && !(await command('project'))) return;
                      edit(text);
                      prompt.current?.focus();
                    }}
                  >
                    <Icon />
                    {label}
                  </button>
                ))}
              </div>
            )}
          </div>
        </main>
        <SearchDialog open={find} setOpen={setFind} sessions={w.sessions} choose={choose} />
        {lightsOpen && (
          <LightingPicker
            open
            close={() => setLightsOpen(false)}
            list={lightsList}
            inspect={(first, second) => lightCommand('inspect', { first, second })}
          />
        )}
      </div>
    </Tooltip.Provider>
  );
}
createRoot(document.getElementById('root')).render(<Workspace />);
