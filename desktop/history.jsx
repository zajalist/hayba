import React, { useRef, useState } from 'react';
import * as Dialog from '@radix-ui/react-dialog';
import { Archive, ArchiveRestore, MessageSquare, PencilLine, Search, X } from 'lucide-react';
import './history.css';

export function ConversationHistory({ sessions, archivedSessions, currentId, busy, choose, archive, restore }) {
  const [query, setQuery] = useState('');
  const [announcement, setAnnouncement] = useState('');
  const archiveTrigger = useRef(null);
  const archiveSearch = useRef(null);
  const closeArchive = useRef(null);
  const matches = archivedSessions.filter((chat) => chat.title.toLowerCase().includes(query.trim().toLowerCase()));
  return (
    <>
      <div className="railheading">Conversations</div>
      <nav className="history-list" aria-label="Conversations">
        {sessions.map((chat) => (
          <div key={chat.id} className="history-row" data-selected={chat.id === currentId}>
            <button
              className="history-open"
              disabled={busy}
              aria-current={chat.id === currentId ? 'page' : undefined}
              aria-label={chat.title}
              title={chat.title}
              onClick={() => choose(chat.id)}
            >
              {chat.isDraft ? <PencilLine /> : <MessageSquare />}
              <span>{chat.title}</span>
              {chat.isDraft && <small>Draft</small>}
            </button>
            <button
              className="history-archive"
              aria-label={`Archive ${chat.title}`}
              title="Archive chat"
              disabled={busy}
              onClick={(event) => {
                const row = event.currentTarget.parentElement;
                const neighbor = row.nextElementSibling || row.previousElementSibling;
                (neighbor?.querySelector('.history-open') || archiveTrigger.current)?.focus();
                archive(chat.id);
                setAnnouncement(`Archived ${chat.title}`);
              }}
            >
              <Archive />
            </button>
          </div>
        ))}
      </nav>
      <span className="history-announcement" role="status">
        {announcement}
      </span>
      <Dialog.Root
        onOpenChange={(open) => {
          if (!open) setQuery('');
        }}
      >
        <Dialog.Trigger asChild>
          <button className="history-trigger" ref={archiveTrigger} disabled={busy}>
            <Archive />
            Archived chats
          </button>
        </Dialog.Trigger>
        <Dialog.Portal>
          <Dialog.Overlay className="overlay history-overlay" />
          <Dialog.Content
            className="palette history-dialog"
            aria-describedby={undefined}
            onOpenAutoFocus={(event) => {
              event.preventDefault();
              (archiveSearch.current || closeArchive.current)?.focus();
            }}
          >
            <div className="dialoghead">
              <Dialog.Title>Archived chats</Dialog.Title>
              <Dialog.Close asChild>
                <button ref={closeArchive} aria-label="Close archived chats">
                  <X />
                </button>
              </Dialog.Close>
            </div>
            {archivedSessions.length > 0 && (
              <label className="searchbox">
                <Search />
                <input
                  ref={archiveSearch}
                  aria-label="Search archived chats"
                  placeholder="Search archived chats…"
                  value={query}
                  onChange={(event) => setQuery(event.target.value)}
                />
              </label>
            )}
            <div className="history-results">
              {matches.map((chat) => (
                <div key={chat.id} className="history-result">
                  {chat.isDraft ? <PencilLine /> : <MessageSquare />}
                  <div className="history-result-title">
                    {chat.title}
                    {chat.isDraft && <small>Draft</small>}
                  </div>
                  <button
                    aria-label={`Restore ${chat.title}`}
                    disabled={busy}
                    onClick={(event) => {
                      const row = event.currentTarget.parentElement;
                      const neighbor = row.nextElementSibling || row.previousElementSibling;
                      (neighbor?.querySelector('button') || closeArchive.current)?.focus();
                      restore(chat.id);
                    }}
                  >
                    <ArchiveRestore /> Restore
                  </button>
                </div>
              ))}
              {matches.length === 0 && (
                <p role="status">{archivedSessions.length ? 'No matching archived chats.' : 'No archived chats.'}</p>
              )}
            </div>
          </Dialog.Content>
        </Dialog.Portal>
      </Dialog.Root>
    </>
  );
}
