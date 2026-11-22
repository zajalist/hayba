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
import { Terrain } from './terrain';
import './workspace.css';

const api = window.haybaDesktop;
const brand = <img className="brandmark" src="HaybaLogo.svg" alt="" />;
const actions = [
  [Layers3, 'Inspect a level', 'Summarize the current Unreal level and its actor count.'],
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
        <Dialog.Content className="palette" aria-describedby={undefined}>
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
function Message({ message, copy }) {
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
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        if (!snapshot.current?.busy) setFind((v) => !v);
      }
      if (e.key === 'Escape' && window.innerWidth <= 760) setRail(false);
    };
    window.addEventListener('keydown', keys);
    return () => window.removeEventListener('keydown', keys);
  }, []);
  useLayoutEffect(() => {
    if (atEnd.current && scroll.current) scroll.current.scrollTop = scroll.current.scrollHeight;
  }, [state]);
  if (!state) return null;
  const { workspace: w, messages, busy } = state;
  const command = (action, value = '') => api.command({ action, value, generation: state.generation });
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
      <div className={'shell ' + (rail ? 'showrail' : '')}>
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
                disabled={busy}
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
              <div className="railheading">Conversations</div>
              <nav aria-label="Conversations">
                {w.sessions.map((s) => (
                  <button
                    key={s.id}
                    disabled={busy}
                    aria-current={s.id === state.generation ? 'page' : undefined}
                    onClick={() => choose(s.id)}
                  >
                    <MessageSquare />
                    <span>{s.title}</span>
                  </button>
                ))}
              </nav>
              <button className="railsettings" disabled={busy} onClick={() => command('settings')}>
                <Settings2 />
                Provider settings
              </button>
            </aside>
          </>
        )}
        <main>
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
            {!messages.length ? (
              <div className="welcome">
                <section className="hero">
                  <div className="heroart">
                    <Terrain />
                  </div>
                  <div className="herotext">
                    <h1>
                      Your workspace<span>.</span>
                    </h1>
                    <p>Explore an idea, plan a build, or work with your Unreal level.</p>
                  </div>
                </section>
                <div className="sectionhead">
                  <h2>Start with a prompt</h2>
                </div>
                <div className="starters">
                  {actions.map(([Icon, label, text]) => (
                    <button
                      key={label}
                      onClick={() => {
                        edit(text);
                        prompt.current?.focus();
                      }}
                    >
                      <Icon />
                      <span>{label}</span>
                      <ArrowUpRight />
                    </button>
                  ))}
                </div>
              </div>
            ) : (
              <div id="messages" className="transcript">
                {messages.map((m) => (
                  <Message key={state.generation + '-' + m.id} message={m} copy={(text) => command('copy', text)} />
                ))}
                {busy && (
                  <p role="status" className="responding">
                    Responding…
                  </p>
                )}
              </div>
            )}
          </div>
          <div className="dock">
            {!state.canSend && (
              <div className="setup">
                <Cable />
                <div>
                  <strong>Connect a provider</strong>
                  <span>Use your OpenAI or Anthropic API key.</span>
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
                  if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
                    e.preventDefault();
                    if (!busy) send();
                  }
                }}
              />
              <div className="tools">
                <button
                  disabled={busy}
                  title={w.sharedProject ? 'Stop sharing this project' : 'Select an open Unreal project'}
                  onClick={() => command('project')}
                >
                  <Box />
                  <span>{w.sharedProject || 'Unreal level'}</span>
                </button>
                <span className="divider" />
                <button className="model" disabled={busy} onClick={() => command('settings')}>
                  <SlidersHorizontal />
                  <span>{w.model.name}</span>
                  <ChevronDown />
                </button>
                <IconButton
                  id="send-button"
                  label={busy ? 'Stop response' : 'Send message'}
                  className="send"
                  disabled={!busy && !draft.trim()}
                  onClick={send}
                >
                  {busy ? <Square /> : <ArrowUp />}
                </IconButton>
              </div>
            </div>
          </div>
        </main>
        <SearchDialog open={find} setOpen={setFind} sessions={w.sessions} choose={choose} />
      </div>
    </Tooltip.Provider>
  );
}
createRoot(document.getElementById('root')).render(<Workspace />);
