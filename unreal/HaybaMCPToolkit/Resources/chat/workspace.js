/* Shared local workspace. Unreal owns credentials, execution and persisted sessions. */
(() => {
  'use strict';
  const $ = (id) => document.getElementById(id),
    icon = (name) => window.HaybaIcons.create(name);
  const node = (tag, cls, text) => {
    const n = document.createElement(tag);
    n.className = cls || '';
    if (text != null) n.textContent = text;
    return n;
  };
  const button = (label, glyph, run, cls = 'small-button') => {
    const b = node('button', cls);
    b.type = 'button';
    if (glyph) b.append(icon(glyph));
    b.append(node('span', '', label));
    b.addEventListener('click', run);
    return b;
  };
  const send = (action, value = '', extra = {}) => window.haybaChat.dispatch(action, value, extra);
  document.querySelectorAll('[data-icon]').forEach((n) => n.append(icon(n.dataset.icon)));
  let state = {},
    ws = {},
    generation = '',
    seq = 0,
    draftTimer,
    toastTimer,
    overlay,
    opener,
    refreshOverlay,
    pendingOverlay = false,
    overlaySignature = '',
    ignoreOutsideClick = false,
    currentView = 'chat';
  let selectedProvider = 'meshy',
    generationPrompt = '',
    generationImage = '',
    generationStyle = 'photorealistic';
  let navigatorTab = 'threads',
    historyQuery = '',
    historyTimer,
    turnQuery = '',
    turnPage = 0,
    turnFilter = 'turns';
  const providers = [
    { id: 'meshy', name: 'Meshy', kind: 'model', detail: 'Text to mesh · optional texture pass' },
    { id: 'tripo', name: 'Tripo', kind: 'model', detail: 'Text or image to textured model' },
    { id: 'aholo', name: 'Aholo', kind: 'model', detail: 'Lux3D · text and image generation' },
    { id: 'fal', name: 'fal.ai', kind: 'video', detail: 'Wan 2.7 · text to video' },
    { id: 'worldlabs', name: 'World Labs', kind: 'splat', detail: 'Marble · explorable splat worlds' },
  ];
  const modes = [
    {
      id: 'explore',
      name: 'Inspect',
      detail: 'Read the scene without changing it.',
      hint: 'Read-only access',
      glyph: 'search',
    },
    {
      id: 'draft',
      name: 'Draft',
      detail: 'Propose changes for your review.',
      hint: 'Approval required for changes',
      glyph: 'new',
    },
    {
      id: 'production',
      name: 'Production',
      detail: 'Propose and verify reviewed changes.',
      hint: 'Approval required for changes',
      glyph: 'shield',
    },
  ];
  function toast(text) {
    $('toast').textContent = text;
    $('toast').hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => ($('toast').hidden = true), 3500);
  }
  function resize() {
    $('prompt').style.height = 'auto';
    $('prompt').style.height = Math.min($('prompt').scrollHeight, 180) + 'px';
  }
  function sendState() {
    const busy = !!state.busy;
    $('send-button').disabled =
      !busy && (!state.generation || state.canSend === false || !$('prompt').value.trim());
    $('send-button').classList.toggle('stopping', busy);
    $('send-button').setAttribute('aria-label', busy ? 'Stop response' : 'Send message');
    $('send-button').title = busy ? 'Stop response' : 'Send message (Enter)';
    $('send-button').replaceChildren(icon(busy ? 'stop' : 'send'));
  }
  function submit() {
    if (state.busy) {
      send('stop');
      return;
    }
    const text = $('prompt').value.trim();
    if (!text) return;
    if (!state.generation) {
      toast(
        document.body?.dataset.haybaHost === 'app'
          ? 'Hayba is still starting. Try Send again in a moment.'
          : 'Chat is still connecting to the editor. Try Send again in a moment.',
      );
      return;
    }
    if (state.canSend === false) {
      toast('Wait until Hayba finishes the current step, then send.');
      return;
    }
    clearTimeout(draftTimer);
    draftTimer = null;
    send('send', text, { seq: ++seq });
  }
  function flushDraft() {
    if (!draftTimer) return;
    clearTimeout(draftTimer);
    draftTimer = null;
    send('draft_changed', $('prompt').value, { seq });
  }
  $('prompt').addEventListener('input', () => {
    ++seq;
    resize();
    sendState();
    clearTimeout(draftTimer);
    draftTimer = setTimeout(flushDraft, 120);
  });
  let enterLock = false;
  const onEnter = (e) => {
    if (e.key !== 'Enter' || e.shiftKey || e.isComposing || state.busy) return;
    e.preventDefault();
    if (enterLock) return;
    enterLock = true;
    try {
      submit();
    } finally {
      queueMicrotask(() => {
        enterLock = false;
      });
    }
  };
  $('prompt').addEventListener('keydown', onEnter);
  $('prompt').addEventListener('keypress', onEnter);
  $('send-button').addEventListener('click', submit);
  function close(restore = true) {
    clearTimeout(historyTimer);
    $('overlay-root').replaceChildren();
    overlay = null;
    refreshOverlay = null;
    pendingOverlay = false;
    overlaySignature = '';
    const previous = opener;
    opener?.setAttribute('aria-expanded', 'false');
    opener = null;
    if (restore) previous?.focus();
  }
  function open(anchor, title, sheet = false) {
    if (overlay && opener === anchor && overlay.getAttribute('aria-label') === title) {
      close();
      return null;
    }
    close(false);
    opener = anchor;
    opener?.setAttribute('aria-expanded', 'true');
    overlay = node('section', sheet ? 'sheet' : 'popover');
    overlay.setAttribute('role', 'dialog');
    overlay.setAttribute('aria-label', title);
    if (sheet) {
      const shade = node('div', 'sheet-shade');
      shade.addEventListener('click', () => close());
      $('overlay-root').append(shade);
      overlay.setAttribute('aria-modal', 'true');
    }
    const heading = node('div', sheet ? 'sheet-header' : 'popover-header');
    heading.append(node('h2', '', title));
    const dismiss = button('', 'close', () => close(), 'icon-button');
    dismiss.setAttribute('aria-label', 'Close ' + title);
    heading.append(dismiss);
    overlay.append(heading);
    const content = node('div', sheet ? 'sheet-body' : 'popover-body');
    overlay.append(content);
    $('overlay-root').append(overlay);
    if (!sheet && anchor) {
      const rect = anchor.getBoundingClientRect();
      overlay.style.width = Math.min(360, innerWidth - 20) + 'px';
      overlay.style.left = Math.max(10, Math.min(rect.left, innerWidth - overlay.offsetWidth - 10)) + 'px';
      const above = rect.top > innerHeight / 2;
      overlay.style.maxHeight = Math.max(120, (above ? rect.top : innerHeight - rect.bottom) - 18) + 'px';
      if (above) overlay.style.bottom = innerHeight - rect.top + 6 + 'px';
      else overlay.style.top = rect.bottom + 6 + 'px';
    }
    queueMicrotask(() => {
      if (overlay) (overlay.querySelector('input,textarea,button:not([disabled])') || overlay).focus();
    });
    return content;
  }
  document.addEventListener(
    'pointerdown',
    (e) => {
      if (!overlay) return;
      if (overlay.contains(e.target) || opener?.contains(e.target) || e.target.closest('.sheet-shade')) return;
      close(false);
      ignoreOutsideClick = true;
    },
    true,
  );
  document.addEventListener(
    'click',
    (e) => {
      if (!ignoreOutsideClick) return;
      ignoreOutsideClick = false;
      e.stopPropagation();
      e.preventDefault();
    },
    true,
  );
  document.addEventListener('keydown', (e) => {
    if (!overlay) return;
    if (e.key === 'Escape') {
      e.preventDefault();
      close();
      return;
    }
    const items = [...overlay.querySelectorAll('button:not([disabled]),input,textarea,select,[tabindex="0"]')].filter(
      (n) => n.getClientRects().length,
    );
    if (!items.length) return;
    const current = items.indexOf(document.activeElement);
    if (e.key === 'Tab') {
      if (e.shiftKey && current <= 0) {
        e.preventDefault();
        items.at(-1).focus();
      } else if (!e.shiftKey && current === items.length - 1) {
        e.preventDefault();
        items[0].focus();
      }
    }
    if (
      ['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(e.key) &&
      !document.activeElement.matches('textarea,select') &&
      (e.key.startsWith('Arrow') || document.activeElement.tagName === 'BUTTON')
    ) {
      e.preventDefault();
      const index =
        e.key === 'Home'
          ? 0
          : e.key === 'End'
            ? items.length - 1
            : (current + (e.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length;
      items[index].focus();
    }
  });
  window.addEventListener('resize', () => {
    if (overlay?.classList.contains('popover')) close();
  });
  function row(label, detail, glyph, action, selected = false) {
    const b = node('button', 'menu-row');
    b.type = 'button';
    if (glyph) b.append(icon(glyph));
    const copy = node('span', 'row-text');
    copy.append(node('span', 'row-title', label));
    if (detail) copy.append(node('span', 'row-detail', detail));
    b.append(copy);
    if (selected) {
      b.append(icon('check'));
      b.setAttribute('aria-current', 'true');
    }
    b.addEventListener('click', action);
    return b;
  }
  function search(content, placeholder, render) {
    const box = node('div', 'search-field');
    box.append(icon('search'));
    const input = node('input');
    input.type = 'search';
    input.placeholder = placeholder;
    input.setAttribute('aria-label', placeholder);
    box.append(input);
    content.append(box);
    const list = node('div', 'menu-list');
    content.append(list);
    const update = () => render(list, input.value.toLowerCase());
    input.addEventListener('input', update);
    update();
    queueMicrotask(() => input.focus());
    return update;
  }
  function models() {
    const content = open($('model-button'), 'Model');
    if (!content) return;
    send('models');
    refreshOverlay = search(content, 'Search models…', (list, q) => {
      list.replaceChildren(node('div', 'menu-group-label', ws.model?.provider || 'Configured provider'));
      for (const model of ws.model?.models || [])
        if ((model.name + ' ' + model.id).toLowerCase().includes(q)) {
          const r = row(
            model.name || model.id,
            model.description || model.id,
            'sparkle',
            () => {
              send('model', model.id);
              close();
            },
            model.id === ws.model.id,
          );
          r.disabled = model.available === false || ws.model.locked;
          list.append(r);
        }
      if (list.children.length === 1)
        list.append(node('p', 'menu-empty', ws.model?.loading ? 'Loading available models…' : 'No matching models.'));
      if (ws.model?.message) list.append(node('p', 'menu-note', ws.model.message));
    });
    if (ws.model?.manualAllowed) {
      const form = node('form', 'manual-model'),
        input = node('input');
      input.placeholder = 'Enter a model ID';
      input.setAttribute('aria-label', 'Custom model ID');
      input.maxLength = 128;
      const apply = button('Use', null, () => {}, 'small-button');
      apply.type = 'submit';
      form.append(input, apply);
      form.addEventListener('submit', (e) => {
        e.preventDefault();
        if (input.value.trim()) {
          send('model', input.value.trim());
          close();
        }
      });
      content.append(form);
    }
    content.append(
      row('Provider settings', 'Manage your chat provider and API key', 'settings', () => {
        close();
        send('view', 'settings');
      }),
    );
  }
  function history(tab = 'threads', anchor = $('history-button')) {
    navigatorTab = tab;
    const content = open(anchor, 'Conversations', true);
    if (!content) return;
    overlay.classList.add('navigator');
    const tabs = node('div', 'navigator-tabs');
    tabs.setAttribute('role', 'tablist');
    tabs.setAttribute('aria-label', 'Browse workspace');
    for (const [id, label, glyph] of [
      ['threads', 'Threads', 'history'],
      ['turns', 'This chat', 'search'],
      ['agents', 'Agents', 'agents'],
    ]) {
      const b = button(label, glyph, () => history(id, anchor), 'navigator-tab');
      b.setAttribute('role', 'tab');
      b.setAttribute('aria-selected', String(tab === id));
      tabs.append(b);
    }
    content.append(tabs);
    const panel = node('div', 'navigator-panel');
    panel.setAttribute('role', 'tabpanel');
    panel.setAttribute('aria-label', tab === 'threads' ? 'Threads' : tab === 'turns' ? 'This chat' : 'Subagents');
    content.append(panel);
    if (tab === 'threads') threadBrowser(panel);
    else if (tab === 'turns') turnBrowser(panel);
    else agentBrowser(panel);
  }
  function searchBox(content, label, value, change) {
    const wrap = node('div', 'search-field'),
      input = node('input');
    input.type = 'search';
    input.maxLength = 200;
    input.placeholder = label;
    input.setAttribute('aria-label', label);
    input.value = value;
    wrap.append(icon('search'), input);
    content.append(wrap);
    input.addEventListener('input', () => change(input.value));
    queueMicrotask(() => input.focus());
    return input;
  }
  function pager(content, label, previous, next) {
    const bar = node('div', 'list-pager');
    bar.append(node('span', '', label));
    const prev = button('Previous', null, () => previous?.());
    const more = button('Next', null, () => next?.());
    prev.disabled = !previous;
    more.disabled = !next;
    bar.append(prev, more);
    content.append(bar);
  }
  function threadBrowser(content) {
    content.append(
      row('New conversation', 'Start with a clean context', 'new', () => {
        close();
        send('new');
      }),
    );
    const request = (offset = 0) => send('history', '', { query: historyQuery, offset });
    searchBox(content, 'Search conversations…', historyQuery, (value) => {
      historyQuery = value;
      clearTimeout(historyTimer);
      historyTimer = setTimeout(() => request(), 220);
      render();
    });
    const list = node('div', 'thread-list');
    content.append(list);
    function render() {
      list.replaceChildren();
      const h = ws.history || {},
        query = historyQuery.trim().toLowerCase();
      if (h.query != null && h.query !== historyQuery) {
        list.append(node('p', 'menu-empty', 'Searching conversations…'));
        return;
      }
      if (ws.sessionStatus) {
        list.append(
          node('p', 'menu-empty', ws.sessionStatus),
          button('Refresh history', 'refresh', () => request(h.offset || 0)),
        );
        return;
      }
      for (const session of ws.sessions || [])
        if (h.query != null || ((session.title || '') + ' ' + session.id).toLowerCase().includes(query)) {
          const date = new Date(session.updatedAt),
            current = session.id === ws.sessionId;
          const detail =
            (current ? 'Current · ' : '') +
            (Number.isNaN(date.valueOf())
              ? ''
              : date.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' }));
          const r = row(
            session.title || 'Untitled conversation',
            detail,
            'history',
            () => {
              send('session', session.id);
              close();
            },
            current,
          );
          r.disabled = !state.canSend || !!state.busy;
          list.append(r);
        }
      if (!list.children.length)
        list.append(
          node(
            'p',
            'menu-empty',
            ws.sessionStatus || (query ? 'No matching conversations.' : 'No saved conversations yet.'),
          ),
        );
      const offset = h.offset || 0,
        total = h.total ?? (ws.sessions || []).length;
      pager(
        list,
        total
          ? offset + 1 + '–' + Math.min(offset + (ws.sessions || []).length, total) + ' of ' + total
          : '0 conversations',
        offset > 0 ? () => request(Math.max(0, offset - 50)) : null,
        h.hasMore ? () => request(h.nextOffset) : null,
      );
      if (ws.sessionStatus && list.children.length > 1) list.append(node('p', 'menu-note', ws.sessionStatus));
    }
    refreshOverlay = render;
    render();
    request();
  }
  function turnBrowser(content) {
    searchBox(content, 'Find a message…', turnQuery, (value) => {
      turnQuery = value;
      turnPage = 0;
      render();
    });
    const filters = node('div', 'navigator-filters');
    content.append(filters);
    for (const [id, label] of [
      ['turns', 'Your turns'],
      ['all', 'All messages'],
    ]) {
      const b = button(label, null, () => {
        turnFilter = id;
        turnPage = 0;
        render();
      });
      b.dataset.filter = id;
      filters.append(b);
    }
    filters.append(
      button('Latest', 'send', () => {
        close();
        window.haybaChat.jumpLatest();
      }),
    );
    const list = node('div', 'turn-list');
    content.append(list);
    function render() {
      filters
        .querySelectorAll('[data-filter]')
        .forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.filter === turnFilter)));
      const query = turnQuery.toLowerCase(),
        matches = [];
      let turn = 0;
      for (const message of state.messages || []) {
        if (message.role === 'user') turn++;
        if ((turnFilter === 'all' || message.role === 'user') && (message.text || '').toLowerCase().includes(query))
          matches.push({ message, turn });
      }
      const count = 50;
      turnPage = Math.min(turnPage, Math.max(0, Math.ceil(matches.length / count) - 1));
      list.replaceChildren();
      for (const { message, turn } of matches.slice(turnPage * count, (turnPage + 1) * count)) {
        const text = message.text || '',
          at = query ? Math.max(0, text.toLowerCase().indexOf(query) - 35) : 0,
          snippet = (at ? '…' : '') + text.slice(at, at + 130).replace(/\s+/g, ' ');
        list.append(
          row(
            snippet || 'Empty message',
            'Turn ' +
              turn +
              ' · ' +
              (message.role === 'user' ? 'You' : message.role === 'inspection' ? 'Inspection' : 'Hayba'),
            message.role === 'user' ? 'new' : 'sparkle',
            () => {
              close();
              window.haybaChat.jumpTo(message.id);
            },
          ),
        );
      }
      if (!matches.length)
        list.append(
          node('p', 'menu-empty', query ? 'No messages match your search.' : 'Your conversation will appear here.'),
        );
      pager(
        list,
        matches.length + ' matching ' + (turnFilter === 'turns' ? 'turns' : 'messages'),
        turnPage > 0
          ? () => {
              --turnPage;
              render();
            }
          : null,
        (turnPage + 1) * count < matches.length
          ? () => {
              ++turnPage;
              render();
            }
          : null,
      );
    }
    refreshOverlay = render;
    render();
  }
  function agentBrowser(content) {
    send('subagents');
    content.append(node('p', 'sheet-intro', 'Work delegated by Hayba in this conversation.'));
    const status = node('p', 'menu-note'),
      list = node('div', 'agent-list');
    content.append(status, list);
    function update() {
      const agents = ws.subagents || {},
        rows = agents.agents || [];
      status.textContent =
        agents.error ||
        (agents.loading
          ? 'Refreshing subagents…'
          : rows.length
            ? rows.length + ' agent' + (rows.length === 1 ? '' : 's')
            : '');
      list.replaceChildren();
      for (const agent of [...rows].reverse())
        list.append(
          row(
            agent.task,
            (ws.preview ? 'Simulated · ' : '') + agent.status + ' · ' + (agent.specialist_id || 'Auto specialist'),
            'agents',
            () => agentDetails(agent.id),
          ),
        );
      if (!rows.length)
        list.append(
          node(
            'p',
            'empty-jobs',
            'No delegated work yet. When Hayba calls an agent, its progress and findings will appear here and in the chat.',
          ),
        );
    }
    refreshOverlay = update;
    update();
  }
  function delegatedActivity() {
    const container = $('delegated-activity'),
      agents = ws.subagents?.agents || [],
      signature = JSON.stringify(agents.map((a) => [a.id, a.task, a.status]));
    container.hidden = !agents.length;
    if (container.dataset.signature === signature) return;
    container.dataset.signature = signature;
    container.replaceChildren();
    const heading = node('div', 'delegated-heading');
    heading.append(
      icon('agents'),
      node('span', '', 'Delegated work'),
      button('View all', null, () => history('agents')),
    );
    container.append(heading);
    const active = agents.filter((a) => ['running', 'queued'].includes(a.status)),
      finished = agents
        .filter((a) => !['running', 'queued'].includes(a.status))
        .sort((a, b) => (b.created_at || '').localeCompare(a.created_at || ''));
    for (const agent of [...active, ...finished].slice(0, 3))
      container.append(
        row(agent.task, (ws.preview ? 'Simulated · ' : '') + agent.status, 'agents', () => agentDetails(agent.id)),
      );
  }
  function agentDetails(id) {
    const content = open($('history-button'), 'Subagent', true);
    if (!content) return;
    overlay.classList.add('navigator');
    content.append(button('All subagents', 'history', () => history('agents')));
    const detail = node('div', 'agent-detail');
    content.append(detail);
    function update() {
      const agent = ws.subagents?.agents?.find((a) => a.id === id);
      detail.replaceChildren();
      if (!agent) {
        detail.append(node('p', 'menu-empty', 'This subagent is no longer available in the current thread.'));
        return;
      }
      detail.append(
        node('h3', 'agent-task', agent.task),
        node(
          'p',
          'connection-state',
          (ws.preview ? 'Simulated · ' : '') + agent.status + ' · ' + (agent.specialist_id || 'Auto specialist'),
        ),
      );
      const actions = node('div', 'agent-actions');
      if (['running', 'queued'].includes(agent.status)) {
        const cancel = button(ws.subagents?.loading ? 'Updating task…' : 'Cancel task', 'stop', () =>
          send('cancel_subagent', id),
        );
        cancel.disabled = !!ws.subagents?.loading;
        actions.append(cancel);
      }
      if (agent.output) {
        if (agent.status === 'succeeded')
          actions.append(
            button('Use findings in chat', 'attach', () => {
              send('use_subagent_result', id);
              close();
              $('prompt').focus();
            }),
          );
        actions.append(button('Copy findings', 'file', () => send('copy', agent.output)));
      }
      detail.append(actions);
      if (agent.error) detail.append(node('p', 'job-error', agent.error));
      const tools = node('details', 'agent-tools');
      tools.open = true;
      tools.append(node('summary', '', (agent.tools || []).length + ' tool calls'));
      for (const tool of agent.tools || []) {
        const item = node('div', 'agent-tool');
        item.append(icon('activity'), node('span', '', tool.name), node('span', 'state', tool.status));
        tools.append(item);
      }
      detail.append(tools);
      if (agent.tools_truncated) detail.append(node('p', 'menu-note', 'Showing the most recent retained tool calls.'));
      detail.append(
        node('h4', 'section-title', 'Findings'),
        node(
          'div',
          'agent-output',
          agent.output ||
            (['running', 'queued'].includes(agent.status) ? 'Working on the task…' : 'No findings returned.'),
        ),
      );
      if (agent.output_truncated)
        detail.append(node('p', 'menu-note', 'These findings were shortened to fit the retained task summary.'));
    }
    refreshOverlay = update;
    update();
  }
  function efforts() {
    const content = open($('effort-button'), 'Reasoning effort');
    if (!content) return;
    const descriptions = {
      low: 'Faster answers for straightforward work.',
      medium: 'A balance of depth and speed.',
      high: 'More reasoning for complex tasks.',
      max: 'The deepest available reasoning.',
      none: 'Use the model’s default behavior.',
    };
    for (const effort of ws.effort?.options || [])
      content.append(
        row(
          effort ? effort[0].toUpperCase() + effort.slice(1) : 'Default',
          descriptions[effort] || 'Use the provider’s default reasoning behavior.',
          'brain',
          () => {
            send('effort', effort);
            close();
          },
          effort === ws.effort.value,
        ),
      );
    if (!ws.effort?.options?.length)
      content.append(node('p', 'menu-empty', 'This model uses its default reasoning behavior.'));
  }
  function access() {
    const content = open($('mode-button'), 'Access');
    if (!content) return;
    for (const m of modes)
      content.append(
        row(
          m.name,
          m.detail,
          m.glyph,
          () => {
            send('mode', m.id);
            close();
          },
          m.id === ws.mode,
        ),
      );
  }
  function attachments() {
    const content = open($('attach-button'), 'Add context');
    if (!content) return;
    content.append(
      row('Editor selection', 'Reference selected actors and assets', 'selection', () => {
        send('attach_selection');
        close();
      }),
      row('Choose a file', 'Attach a file path from this computer', 'file', () => {
        send('attach_file');
        close();
      }),
    );
    content.append(node('p', 'menu-note', 'Context stays with this draft until you send it.'));
  }
  function contextDetails(item, anchor) {
    const content = open(anchor, 'Attached context', true);
    if (!content) return;
    content.append(
      node('h3', 'agent-task', item.label),
      node(
        'p',
        'sheet-intro',
        item.kind === 'file'
          ? 'A file path attached to this draft. The file contents are read only when a tool requests them.'
          : 'An editor reference captured when you attached it. Tools inspect the current object state when they run.',
      ),
    );
    const path = node('pre', 'context-path', item.path || item.label);
    content.append(path);
    const actions = node('div', 'agent-actions');
    actions.append(button('Copy reference', 'file', () => send('copy', item.path || item.label)));
    if (item.kind === 'asset' && /^\/Game\//.test(item.path || ''))
      actions.append(button('Show asset', 'selection', () => send('link', item.path)));
    actions.append(
      button('Remove context', 'close', () => {
        send('remove_context', item.id);
        close();
      }),
    );
    content.append(
      actions,
      node(
        'p',
        'menu-note',
        'This reference belongs to the current draft. It is cleared after the message is accepted.',
      ),
    );
  }
  function more() {
    const content = open($('more-button'), 'Workspace');
    if (!content) return;
    content.append(
      row('Activity', 'Tool calls, changes and checks', 'activity', () => {
        close();
        send('view', 'activity');
      }),
      row('Subagents', 'Inspect delegated work and findings', 'agents', () => history('agents')),
      row('Connections', '3D models, video and splat worlds', 'plug', connections),
      row('Settings', 'Chat provider and editor preferences', 'settings', () => {
        close();
        send('view', 'settings');
      }),
      row('Keyboard shortcuts', 'Make yourself at home', 'info', () => {
        const c = open($('more-button'), 'Keyboard shortcuts');
        if (!c) return;
        const help = node('div', 'keyboard-help');
        for (const [name, key] of [
          ['Send message', 'Enter'],
          ['New line', 'Shift + Enter'],
          ['Close menu', 'Escape'],
          ['Move through menus', '↑ / ↓'],
          ['Next control', 'Tab'],
        ])
          help.append(node('span', '', name), node('span', '', key));
        c.append(help);
      }),
    );
  }
  function connection(id) {
    return (ws.connections || []).find((c) => c.id === id) || { id, configured: false, state: 'not_connected' };
  }
  function connectionLabel(c) {
    return (
      (ws.preview ? 'Simulated · ' : '') +
      ({
        not_connected: 'Not connected',
        configured: 'Key saved · not verified',
        checking: 'Checking connection…',
        verified: 'Connected',
        error: 'Connection needs attention',
      }[c.state] || 'Not connected')
    );
  }
  function connections() {
    const content = open($('more-button'), 'Connections', true);
    if (!content) return;
    send('connections');
    content.append(
      node(
        'p',
        'sheet-intro',
        'Bring your creative tools into the editor. Connect accounts for models, video and splat worlds, then create without leaving your conversation.',
      ),
    );
    const list = node('div');
    content.append(list);
    refreshOverlay = () => {
      list.replaceChildren();
      for (const p of providers) {
        const c = connection(p.id),
          r = node('div', 'provider-row'),
          mark = node('div', 'provider-symbol');
        mark.append(icon(p.id));
        const copy = node('div', 'provider-copy');
        copy.append(node('h3', '', p.name), node('p', 'provider-capability', p.detail));
        const status = node(
          'p',
          'connection-state ' + c.state,
          connectionLabel(c) + (c.keyLast4 ? ' · •••• ' + c.keyLast4 : ''),
        );
        copy.append(status);
        if (c.message) copy.append(node('p', 'provider-capability', c.message));
        const actions = node('div', 'provider-actions');
        const connect = button(c.configured ? 'Update key' : 'Connect', null, () => send('connect_provider', p.id));
        const blocked =
          !state.canSend || !!state.busy || !!state.inspecting || !!state.externalReview || !!ws.generation3d?.busy;
        connect.disabled = c.state === 'checking' || blocked;
        if (blocked) connect.title = 'Finish the active task or review before changing connections.';
        actions.append(connect);
        if (c.configured) {
          if (p.id !== 'fal') actions.append(button('Test', null, () => send('connections')));
          const disconnect = button('Disconnect', null, () => send('disconnect_provider', p.id));
          disconnect.disabled = blocked;
          actions.append(disconnect);
        }
        r.append(mark, copy, actions);
        list.append(r);
      }
    };
    refreshOverlay();
    const note = node('div', 'secure-note');
    note.append(
      icon('shield'),
      node(
        'span',
        '',
        'Keys are entered in Unreal’s secure dialog and stored in your Windows vault. They are never sent to this web UI.',
      ),
    );
    content.append(note);
  }
  function field(content, label, type, value, onChange) {
    const wrap = node('div', 'field'),
      id = 'field-' + label.toLowerCase().replace(/\W+/g, '-'),
      caption = node('label', '', label);
    caption.htmlFor = id;
    const input = node(type === 'textarea' ? 'textarea' : 'input');
    input.id = id;
    if (type !== 'textarea') input.type = type;
    input.value = value;
    input.addEventListener('input', () => onChange(input.value));
    wrap.append(caption, input);
    content.append(wrap);
    return input;
  }
  function create() {
    const content = open($('create-button'), 'Create media', true);
    if (!content) return;
    send('connections');
    content.append(
      node(
        'p',
        'sheet-intro',
        'Choose what to create, connect a provider, and describe your idea. Results stay with this workspace.',
      ),
    );
    const categories = node('div', 'media-categories');
    categories.setAttribute('aria-label', 'Media type');
    content.append(categories);
    for (const [kind, label, glyph] of [
      ['model', '3D model', 'cube'],
      ['video', 'Video', 'video'],
      ['splat', 'Splat world', 'splat'],
    ]) {
      const b = button(
        label,
        glyph,
        () => {
          selectedProvider = providers.find((p) => p.kind === kind).id;
          options();
          update();
        },
        'media-category',
      );
      b.dataset.kind = kind;
      categories.append(b);
    }
    const picker = node('div', 'field');
    picker.append(node('div', 'field-label', 'Provider'));
    const choices = node('div', 'provider-picker');
    picker.append(choices);
    content.append(picker);
    const status = node('div', 'generation-connect');
    content.append(status);
    const prompt = field(content, 'Describe your asset', 'textarea', generationPrompt, (v) => {
      generationPrompt = v;
      updateGenerate();
    });
    prompt.placeholder = 'A weathered brass lantern, worn leather handle, game-ready prop…';
    prompt.maxLength = 2000;
    const optional = node('div');
    content.append(optional);
    const generate = button(
      'Generate asset',
      'sparkle',
      () => {
        const payload = {};
        if (generationPrompt.trim()) payload.prompt = generationPrompt.trim();
        if (['tripo', 'aholo'].includes(selectedProvider) && generationImage.trim())
          payload.image_url = generationImage.trim();
        if (selectedProvider === 'tripo' && payload.image_url) delete payload.prompt;
        if (selectedProvider === 'aholo') payload.style = generationStyle;
        send('generate_3d', selectedProvider, payload);
      },
      'generate-button',
    );
    content.append(
      generate,
      node('p', 'credit-note', 'Uses credits from your provider account. Each generation is a paid request.'),
    );
    const error = node('p', 'job-error');
    error.setAttribute('role', 'status');
    content.append(error);
    const jobs = node('div', 'job-section');
    content.append(jobs);
    function updateGenerate() {
      generate.disabled =
        !!ws.generation3d?.busy ||
        !!state.busy ||
        !!state.awaitingApproval ||
        !state.canSend ||
        !!state.inspecting ||
        !!state.externalReview ||
        !connection(selectedProvider).configured ||
        (!generationPrompt.trim() && (!['tripo', 'aholo'].includes(selectedProvider) || !generationImage.trim()));
    }
    function options() {
      optional.replaceChildren();
      prompt.maxLength = selectedProvider === 'meshy' ? 800 : 2000;
      prompt.placeholder =
        selectedProvider === 'fal'
          ? 'A slow cinematic camera move through an abandoned space station, warm rim lighting…'
          : selectedProvider === 'worldlabs'
            ? 'An overgrown courtyard with worn stone arches, dappled sunlight and moss-covered steps…'
            : 'A weathered brass lantern, worn leather handle, game-ready prop…';
      if (['tripo', 'aholo'].includes(selectedProvider)) {
        const image = field(optional, 'Reference image URL (optional)', 'url', generationImage, (v) => {
          generationImage = v;
          updateGenerate();
        });
        image.placeholder = 'https://…';
        image.parentElement.append(
          node(
            'p',
            'field-note',
            selectedProvider === 'tripo'
              ? 'Image input replaces the text prompt for Tripo. Use a publicly accessible HTTPS image.'
              : 'Use a publicly accessible HTTPS image. It is sent to Aholo as a reference.',
          ),
        );
      } else if (selectedProvider === 'meshy')
        optional.append(
          node(
            'p',
            'field-note',
            'Meshy first creates an untextured preview. Add textures later as a separate paid step.',
          ),
        );
      else
        optional.append(
          node(
            'p',
            'field-note',
            selectedProvider === 'fal'
              ? 'Wan 2.7 · 5-second video. Uses fal.ai credits; your key is stored but cannot be verified without a generation.'
              : 'Marble 1.1 · a generated world with downloadable SPZ splat data. Opening a result does not import splats into Unreal.',
          ),
        );
      if (selectedProvider === 'aholo') {
        const wrap = node('div', 'field'),
          label = node('label', '', 'Style');
        label.htmlFor = 'generation-style';
        const select = node('select');
        select.id = 'generation-style';
        for (const name of ['photorealistic', 'cartoon', 'anime', 'hand_painted', 'cyberpunk', 'fantasy', 'glass']) {
          const o = node('option', '', name.replaceAll('_', ' '));
          o.value = name;
          select.append(o);
        }
        select.value = generationStyle;
        select.addEventListener('change', () => (generationStyle = select.value));
        wrap.append(label, select);
        optional.append(wrap);
      }
    }
    function update() {
      choices.replaceChildren();
      const kind = providers.find((p) => p.id === selectedProvider).kind;
      generate.querySelector('span').textContent =
        kind === 'video' ? 'Generate video' : kind === 'splat' ? 'Generate world' : 'Generate asset';
      categories
        .querySelectorAll('[data-kind]')
        .forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.kind === kind)));
      for (const p of providers.filter((p) => p.kind === kind)) {
        const b = button(
          p.name,
          p.id,
          () => {
            selectedProvider = p.id;
            options();
            update();
          },
          'provider-choice' + (selectedProvider === p.id ? ' selected' : ''),
        );
        b.setAttribute('aria-pressed', String(selectedProvider === p.id));
        b.append(node('small', '', connection(p.id).configured ? 'Key saved' : 'Not connected'));
        choices.append(b);
      }
      const c = connection(selectedProvider);
      status.replaceChildren(icon(c.state === 'verified' ? 'check' : 'plug'), node('span', '', connectionLabel(c)));
      if (!c.configured || c.state === 'error')
        status.append(
          button(c.configured ? 'Update key' : 'Connect', null, () => send('connect_provider', selectedProvider)),
        );
      error.textContent = ws.generation3d?.error || '';
      error.hidden = !error.textContent;
      updateGenerate();
      renderJobs(jobs);
    }
    options();
    refreshOverlay = update;
    update();
  }
  function renderJobs(container) {
    const jobs = ws.jobs || [];
    container.replaceChildren();
    const heading = node('h3', 'section-title', 'This session');
    heading.append(node('span', '', jobs.length ? jobs.length + ' job' + (jobs.length === 1 ? '' : 's') : ''));
    container.append(heading);
    if (!jobs.length) {
      container.append(
        node(
          'p',
          'empty-jobs',
          'Your generations will appear here. You can keep chatting while an asset is being created.',
        ),
      );
      return;
    }
    for (const job of [...jobs].reverse()) {
      const item = node('article', 'job'),
        head = node('div', 'job-heading'),
        copy = node('div', 'job-heading-text');
      head.append(icon(job.kind === 'video' ? 'video' : job.kind === 'splat' ? 'splat' : 'cube'), copy);
      copy.append(node('p', 'job-prompt', job.prompt || 'Textured model'));
      const percent = Number.isFinite(job.progress) ? ' · ' + Math.round(job.progress) + '%' : '';
      const meta = node('div', 'job-meta');
      meta.append(
        node(
          'span',
          '',
          (ws.preview ? 'Simulated · ' : '') +
            (providers.find((p) => p.id === job.provider)?.name || job.provider) +
            ' · ' +
            job.status +
            percent,
        ),
      );
      if (job.task_id) {
        const id = node('code', '', job.task_id);
        id.title = job.task_id;
        meta.append(id);
      }
      copy.append(meta);
      item.append(head);
      if (['queued', 'running'].includes(job.status) && Number.isFinite(job.progress)) {
        const track = node('div', 'job-progress'),
          fill = node('div');
        fill.style.width = Math.max(0, Math.min(100, job.progress)) + '%';
        track.setAttribute('role', 'progressbar');
        track.setAttribute('aria-label', 'Generation progress');
        track.setAttribute('aria-valuenow', job.progress);
        track.append(fill);
        item.append(track);
      }
      const actions = node('div', 'job-actions');
      if (job.status === 'succeeded' && (job.result_url || job.model_url)) {
        actions.append(
          button('Open result', 'download', () => send('open_result', job.id)),
          button('Use in chat', 'attach', () => {
            send('use_result', job.id);
            close();
            $('prompt').focus();
          }),
        );
      }
      if (job.status === 'succeeded' && job.provider === 'meshy' && job.phase === 'preview')
        actions.append(
          button('Add textures…', 'sparkle', () => {
            const c = open($('create-button'), 'Add textures', true);
            if (!c) return;
            c.append(
              node(
                'p',
                'sheet-intro',
                'Create a textured model from this Meshy preview. This submits a separate paid generation to your Meshy account.',
              ),
              button(
                'Generate textures · uses credits',
                'sparkle',
                () => {
                  send('generate_3d', 'meshy', { preview_task_id: job.task_id });
                  create();
                },
                'generate-button',
              ),
            );
          }),
        );
      if (job.task_id && job.status !== 'succeeded')
        actions.append(button('Refresh', 'refresh', () => send('refresh_3d', job.id)));
      item.append(actions);
      if (job.error) item.append(node('p', 'job-error', job.error));
      container.append(item);
    }
  }
  function fieldControl(kind, attrs = {}) {
    const el = node(kind === 'select' ? 'select' : 'input');
    if (kind !== 'select') el.type = kind;
    Object.assign(el, attrs);
    return el;
  }
  function settingsForm(root) {
    const s = ws.settings || {};
    const providers = s.providers || [];
    const selected = providers.find((p) => p.id === s.provider) || providers[0] || { id: '', label: 'Provider', needsKey: true };
    const draft = {
      provider: s.provider || selected.id,
      model: s.model || '',
      baseURL: s.baseURL || '',
      sidecarURL: s.sidecarURL || '',
      planMode: !!s.planMode,
      autoStartSidecar: !!s.autoStartSidecar,
      useHaybaPro: !!s.useHaybaPro,
      brainLlmMode: s.brainLlmMode || 'subscription',
      advisoryVerbosity: s.advisoryVerbosity || 'errors_and_warnings',
      leaseEnforcement: s.leaseEnforcement || 'enforced_for_writes',
    };
    const section = (title, detail) => {
      const wrap = node('section', 'settings-section');
      wrap.append(node('h3', '', title));
      if (detail) wrap.append(node('p', '', detail));
      root.append(wrap);
      return wrap;
    };
    const labeled = (parent, caption, control) => {
      const field = node('div', 'settings-field');
      const label = node('label', '', caption);
      if (control.id) label.htmlFor = control.id;
      field.append(label, control);
      parent.append(field);
      return control;
    };
    const chat = section(
      'Chat model',
      ws.standalone
        ? 'Provider, model, and key for Hayba. Keys stay on this computer and are sent only to the local Hayba app.'
        : 'Provider, model, and key for Hayba’s built-in chat. Keys stay in Unreal’s vault.',
    );
    const provider = fieldControl('select', { id: 'settings-provider' });
    for (const p of providers) {
      const opt = node('option', '', p.label);
      opt.value = p.id;
      if (p.id === draft.provider) opt.selected = true;
      provider.append(opt);
    }
    labeled(chat, 'Provider', provider);
    const current = () => providers.find((p) => p.id === provider.value) || selected;
    const keyRow = node('div', 'settings-row');
    const keyCopy = node('span');
    const refreshKey = () => {
      const p = current();
      keyCopy.replaceChildren();
      keyCopy.append(node('strong', '', 'API key'));
      keyCopy.append(
        node(
          'span',
          'row-detail',
          p.needsKey
            ? p.hasKey
              ? 'Stored · •••• ' + (p.keyLast4 || 'key')
              : ws.standalone
                ? 'Not stored. Enter a key below to enable chat.'
                : 'Not stored. Enter a key in Unreal’s secure dialog.'
            : 'This provider does not need a stored key.',
        ),
      );
    };
    refreshKey();
    const keyActions = node('div', 'settings-actions');
    const enterKey = button(
      'Enter key',
      'shield',
      () => {
        if (!ws.standalone) {
          send('connect_chat_key', provider.value);
          return;
        }
        const field = $('settings-api-key');
        if (field && field.value.trim()) send('submit_chat_key', field.value.trim(), { provider: provider.value });
        else toast('Paste your API key in the field first.');
      },
      'small-button',
    );
    const removeKey = button('Remove key', 'close', () => send('disconnect_chat_key', provider.value), 'small-button');
    keyActions.append(enterKey, removeKey);
    keyRow.append(keyCopy, keyActions);
    chat.append(keyRow);
    if (ws.standalone) {
      labeled(
        chat,
        'API key',
        fieldControl('password', {
          id: 'settings-api-key',
          maxLength: 4096,
          placeholder: current().keyHint || 'Paste API key',
        }),
      );
    }
    provider.addEventListener('change', () => {
      draft.provider = provider.value;
      const p = current();
      if (p.defaultModel) model.value = p.defaultModel;
      if (p.baseURLDefault != null) baseURL.value = p.baseURLDefault;
      refreshKey();
      enterKey.hidden = !p.needsKey;
      removeKey.hidden = !p.needsKey || !p.hasKey;
    });
    enterKey.hidden = !current().needsKey;
    removeKey.hidden = !current().needsKey || !current().hasKey;
    const model = labeled(chat, 'Model ID', fieldControl('text', { id: 'settings-model', value: draft.model, maxLength: 128 }));
    const baseURL = labeled(
      chat,
      'Base URL',
      fieldControl('text', { id: 'settings-base-url', value: draft.baseURL, maxLength: 512 }),
    );
    const safety = section('Editor safety', 'Review exact edits from external MCP clients. Built-in chat keeps its own approvals.');
    const plan = node('div', 'settings-row');
    const planCopy = node('span');
    planCopy.append(node('strong', '', 'Review each external edit'), node('span', 'row-detail', 'Approve one exact command and target once.'));
    const planToggle = fieldControl('checkbox', { id: 'settings-plan', checked: draft.planMode });
    plan.append(planCopy, planToggle);
    safety.append(plan);
    const lease = labeled(safety, 'When agents edit the same item', fieldControl('select', { id: 'settings-lease' }));
    for (const [id, label] of [
      ['enforced_for_writes', 'Block conflicting edits'],
      ['enforced', 'Block conflicting edits and reads'],
      ['advisory', 'Warn about conflicts'],
      ['off', 'Ignore conflicts'],
    ]) {
      const opt = node('option', '', label);
      opt.value = id;
      if (id === draft.leaseEnforcement) opt.selected = true;
      lease.append(opt);
    }
    const pro = section('Hayba Pro', s.brainEmail ? 'Signed in as ' + s.brainEmail + '.' : 'Use Hayba-hosted models or your own provider key.');
    const proRow = node('div', 'settings-row');
    const proCopy = node('span');
    proCopy.append(node('strong', '', 'Use Hayba Pro'), node('span', 'row-detail', 'Route chat through the hosted brain when signed in.'));
    const proToggle = fieldControl('checkbox', { id: 'settings-pro', checked: draft.useHaybaPro });
    proRow.append(proCopy, proToggle);
    pro.append(proRow);
    const brainMode = labeled(pro, 'Model source', fieldControl('select', { id: 'settings-brain-mode' }));
    for (const [id, label] of [
      ['subscription', 'Hayba models'],
      ['byok', 'Your provider key'],
    ]) {
      const opt = node('option', '', label);
      opt.value = id;
      if (id === draft.brainLlmMode) opt.selected = true;
      brainMode.append(opt);
    }
    const connection = section('Sidecar', 'Local Hayba server used by chat. Only loopback URLs are accepted.');
    const sidecar = labeled(
      connection,
      'Sidecar URL',
      fieldControl('text', { id: 'settings-sidecar', value: draft.sidecarURL, maxLength: 512 }),
    );
    const autoRow = node('div', 'settings-row');
    const autoCopy = node('span');
    autoCopy.append(node('strong', '', 'Start sidecar with the editor'), node('span', 'row-detail', 'Starts the local chat server when Unreal opens.'));
    const autoToggle = fieldControl('checkbox', { id: 'settings-autostart', checked: draft.autoStartSidecar });
    autoRow.append(autoCopy, autoToggle);
    connection.append(autoRow);
    const guidance = section('Response guidance', 'Errors always appear. This only changes optional tips.');
    const advisory = labeled(guidance, 'Verbosity', fieldControl('select', { id: 'settings-advisory' }));
    for (const [id, label] of [
      ['errors_only', 'Errors only'],
      ['errors_and_warnings', 'Errors and warnings'],
      ['errors_warnings_and_tips', 'Errors, warnings and tips'],
    ]) {
      const opt = node('option', '', label);
      opt.value = id;
      if (id === draft.advisoryVerbosity) opt.selected = true;
      advisory.append(opt);
    }
    const actions = node('div', 'settings-actions');
    actions.append(
      button(
        'Save settings',
        null,
        () => {
          send('save_settings', '', {
            provider: provider.value,
            model: model.value.trim(),
            baseURL: baseURL.value.trim(),
            sidecarURL: sidecar.value.trim(),
            planMode: planToggle.checked ? '1' : '0',
            autoStartSidecar: autoToggle.checked ? '1' : '0',
            useHaybaPro: proToggle.checked ? '1' : '0',
            brainLlmMode: brainMode.value,
            advisoryVerbosity: advisory.value,
            leaseEnforcement: lease.value,
          });
        },
        'primary',
      ),
    );
    root.append(actions);
    if (s.message) root.append(node('p', 'menu-note', s.message));
    if (ws.preview) root.append(node('p', 'menu-note', 'Preview only. Real keys and sidecar changes are applied in Unreal.'));
  }
  function activityList(root) {
    const items = ws.activity || [];
    if (!items.length) {
      root.append(
        node('p', 'sheet-intro', 'Tool calls, reviewed edits and checks will appear here as Hayba works in this project.'),
      );
      return;
    }
    for (const item of items) {
      const row = node('article', 'activity-item');
      row.append(node('h3', '', item.title || 'Activity'));
      row.append(node('p', '', [item.state, item.detail].filter(Boolean).join(' · ')));
      if (item.error) row.append(node('p', 'job-error', item.error));
      root.append(row);
    }
  }
  function showView(name) {
    currentView = name === 'settings' || name === 'activity' ? name : 'chat';
    const app = $('app-view');
    const chat = $('chat-surface');
    const onChat = currentView === 'chat';
    chat.hidden = !onChat;
    app.hidden = onChat;
    if (onChat) {
      app.replaceChildren();
      return;
    }
    const header = node('div', 'app-view-header');
    const back = button('', 'right', () => send('view', 'chat'), 'icon-button');
    back.style.transform = 'scaleX(-1)';
    back.setAttribute('aria-label', 'Back to conversation');
    header.append(back, node('h2', '', currentView === 'settings' ? 'Settings' : 'Activity'));
    const body = node('div', 'app-view-body');
    if (currentView === 'settings') settingsForm(body);
    else activityList(body);
    app.replaceChildren(header, body);
    queueMicrotask(() => back.focus());
  }
  function receive(next) {
    state = next;
    const approval = (next.messages || []).findLast((m) => m.activity?.approval)?.activity.approval;
    $('review-notice').hidden = !next.awaitingApproval && !next.externalReview;
    $('review-button').hidden = !approval || !!approval.native || !!next.externalReview;
    $('review-label').textContent =
      approval?.native || next.externalReview
        ? 'Review the operation in the editor panel above.'
        : 'An action needs your review';
    if (!next.workspace) {
      sendState();
      return;
    }
    ws = next.workspace;
    delegatedActivity();
    if (next.generation !== generation) {
      generation = next.generation;
      seq = 0;
      clearTimeout(draftTimer);
      close(false);
    }
    if (ws.draft && ws.draft.ack >= seq && $('prompt').value !== ws.draft.text) {
      $('prompt').value = ws.draft.text || '';
      resize();
    }
    $('task-title').textContent = ws.title || 'New conversation';
    $('task-title').title = ws.title || '';
    $('project-name').textContent = ws.project || 'Unreal project';
    $('model-label').textContent = ws.model?.name || ws.model?.id || 'Choose model';
    $('model-button').disabled = !!ws.model?.locked;
    $('new-button').disabled =
      $('mode-button').disabled =
      $('effort-button').disabled =
        !next.canSend || !!next.busy || !!next.inspecting || !!next.externalReview;
    $('workspace-notice').hidden = !ws.credentialSetupRequired;
    if (ws.credentialSetupRequired && !$('workspace-notice').children.length) {
      $('workspace-notice').append(
        node('span', '', 'Add your chat provider key to send. Your draft is saved.'),
        button('Open settings', 'settings', () => send('view', 'settings')),
      );
    }
    $('effort-button').title = 'Reasoning effort: ' + (ws.effort?.value || 'default');
    const mode = modes.find((m) => m.id === ws.mode) || modes[0];
    $('mode-label').textContent = mode.name;
    $('mode-hint').textContent = mode.hint;
    const context = ws.context || [],
      signature = JSON.stringify(context);
    if ($('context-chips').dataset.signature !== signature) {
      $('context-chips').dataset.signature = signature;
      $('context-chips').replaceChildren();
      for (const item of context) {
        const chip = node('div', 'context-chip');
        chip.title = item.path || item.label;
        const label = button(
          item.label,
          ['selection', 'actor', 'asset'].includes(item.kind) ? 'selection' : 'file',
          () => contextDetails(item, label),
          'context-label',
        );
        label.setAttribute('aria-label', 'View context: ' + item.label);
        chip.append(label);
        const remove = button('', 'close', () => send('remove_context', item.id), '');
        remove.setAttribute('aria-label', 'Remove ' + item.label);
        chip.append(remove);
        $('context-chips').append(chip);
      }
    }
    $('context-chips').hidden = !context.length;
    const active = (ws.jobs || []).filter((j) => ['queued', 'running'].includes(j.status)).length;
    $('job-count').hidden = !active;
    $('job-count').textContent = active;
    sendState();
    const requested = ws.view === 'settings' || ws.view === 'activity' ? ws.view : 'chat';
    if (requested !== currentView || (requested !== 'chat' && $('app-view').dataset.signature !== JSON.stringify([ws.settings, ws.activity]))) {
      $('app-view').dataset.signature = JSON.stringify([ws.settings, ws.activity]);
      showView(requested);
    }
    const signatureOverlay = JSON.stringify([
      ws.model,
      ws.sessions,
      ws.sessionId,
      ws.sessionStatus,
      ws.connections,
      ws.jobs,
      ws.generation3d,
      ws.subagents,
      ws.history,
      ws.settings,
      ws.activity,
      state.messages?.length,
      state.messages?.at(-1)?.text?.length,
      next.canSend,
      next.busy,
      next.awaitingApproval,
    ]);
    if (overlay && signatureOverlay !== overlaySignature) {
      const selection = window.getSelection();
      if (selection && !selection.isCollapsed && overlay.contains(selection.anchorNode)) {
        pendingOverlay = true;
        return;
      }
      overlaySignature = signatureOverlay;
      refreshOverlay?.();
    }
  }
  document.addEventListener('selectionchange', () => {
    if (pendingOverlay && window.getSelection()?.isCollapsed) {
      pendingOverlay = false;
      refreshOverlay?.();
    }
  });
  $('history-button').addEventListener('click', () => history());
  $('find-button').addEventListener('click', () => history('turns', $('find-button')));
  document.addEventListener('keydown', (e) => {
    if ((e.ctrlKey || e.metaKey) && ['f', 'k'].includes(e.key.toLowerCase())) {
      e.preventDefault();
      history(
        e.key.toLowerCase() === 'f' ? 'turns' : 'threads',
        e.key.toLowerCase() === 'f' ? $('find-button') : $('history-button'),
      );
    }
  });
  $('review-button').addEventListener('click', () => {
    const message = (state.messages || []).findLast((m) => m.activity?.approval);
    if (message) window.haybaChat.jumpTo(message.id);
    const review = [...document.querySelectorAll('.approval')].at(-1);
    if (review) {
      review.scrollIntoView({ block: 'end' });
      review.querySelector('button')?.focus({ preventScroll: true });
    }
  });
  $('model-button').addEventListener('click', models);
  $('effort-button').addEventListener('click', efforts);
  $('mode-button').addEventListener('click', access);
  $('attach-button').addEventListener('click', attachments);
  $('more-button').addEventListener('click', more);
  $('new-button').addEventListener('click', () => send('new'));
  $('create-button').addEventListener('click', create);
  $('starter-3d').addEventListener('click', create);
  window.haybaWorkspace = { receive, toast, flushDraft };
})();
