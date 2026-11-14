/* Local presentation only. Native Unreal owns sessions, tools and authorization. */
(() => {
  'use strict';
  const $ = (id) => document.getElementById(id);
  const viewport = $('conversation'),
    rows = $('messages');
  let token = '',
    state = { generation: '', messages: [] },
    pending = null,
    sending = false;
  const commands = [],
    rendered = new Map();
  const pageSize = 80;
  let first = 0,
    last = 0,
    navigating = false;
  const el = (tag, cls, text) => {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
  };
  const announce = (text) => {
    $('announcement').textContent = text;
  };
  function appHost() {
    return document.body?.dataset.haybaHost === 'app';
  }
  let snapshotPoll;
  function pollSnapshot() {
    clearInterval(snapshotPoll);
    snapshotPoll = setInterval(() => {
      fetch('/workspace/snapshot')
        .then((r) => r.json())
        .then((next) => {
          receive(next);
          if (!next.busy) clearInterval(snapshotPoll);
        })
        .catch(() => clearInterval(snapshotPoll));
    }, 160);
  }
  function dispatch(action, value = '', extra = {}) {
    if (!token && !appHost()) return;
    if (['draft', 'retry', 'use_result', 'use_subagent_result', 'new', 'session'].includes(action))
      window.haybaWorkspace?.flushDraft();
    commands.push({
      token: token || 'app',
      generation: state.generation,
      action,
      value: String(value),
      ...extra,
    });
    flush();
  }
  function flush() {
    if (sending || !commands.length) return;
    sending = true;
    if (appHost()) {
      const command = commands.shift();
      fetch('/workspace/event', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(command),
      })
        .then((r) => r.json())
        .then((data) => {
          if (data.snapshot) receive(data.snapshot);
          if (data.snapshot?.busy) pollSnapshot();
        })
        .finally(() => {
          window.haybaChat.ack();
        });
      return;
    }
    const url = 'hayba-chat://event/' + encodeURIComponent(JSON.stringify(commands.shift()));
    let frame = document.getElementById('hayba-bridge');
    if (!frame) {
      frame = el('iframe');
      frame.id = 'hayba-bridge';
      frame.title = 'Hayba editor bridge';
      frame.setAttribute('aria-hidden', 'true');
      frame.style.cssText = 'position:absolute;width:0;height:0;border:0;visibility:hidden';
      document.documentElement.append(frame);
    }
    frame.src = url;
  }
  function button(label, action, cls = '') {
    const b = el('button', cls, label);
    b.type = 'button';
    b.addEventListener('click', action);
    return b;
  }
  function copy(text) {
    dispatch('copy', text);
  }
  function copyButton(text, label = 'Copy') {
    const b = button(
      '',
      () => {
        copy(typeof text === 'function' ? text() : text);
      },
      'copy',
    );
    b.title = label;
    b.setAttribute('aria-label', label);
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('viewBox', '0 0 16 16');
    svg.setAttribute('aria-hidden', 'true');
    const path = document.createElementNS(svg.namespaceURI, 'path');
    path.setAttribute('d', 'M6 6h7v7H6z M10 6V3H3v7h3');
    svg.append(path);
    b.append(svg);
    return b;
  }
  // All prose becomes text nodes. Only explicit Markdown links receive a safe native action.
  function inline(parent, text) {
    const pattern = /(`[^`\n]+`|\*\*[^*\n]+\*\*|\[[^\]\n]+\]\([^\s)]+\))/g;
    let at = 0;
    for (const match of text.matchAll(pattern)) {
      parent.append(document.createTextNode(text.slice(at, match.index)));
      const part = match[0];
      if (part[0] === '`') parent.append(el('code', '', part.slice(1, -1)));
      else if (part.startsWith('**')) parent.append(el('strong', '', part.slice(2, -2)));
      else {
        const link = /^\[([^\]]+)\]\(([^)]+)\)$/.exec(part);
        if (/^(https:\/\/|\/Game\/)/.test(link[2])) {
          const a = el('a', '', link[1]);
          a.href = '#';
          a.title = link[2];
          a.addEventListener('click', (e) => {
            e.preventDefault();
            dispatch('link', link[2]);
          });
          parent.append(a);
        } else parent.append(document.createTextNode(part));
      }
      at = match.index + part.length;
    }
    parent.append(document.createTextNode(text.slice(at)));
  }
  function markdown(text, plain) {
    const root = el('div', 'body');
    if (plain) {
      root.append(el('p', '', text));
      return root;
    }
    const lines = text.replace(/\r\n/g, '\n').split('\n');
    for (let i = 0; i < lines.length;) {
      const line = lines[i];
      if (!line.trim()) {
        i++;
        continue;
      }
      if (/^\s*```/.test(line)) {
        const lang = line.trim().slice(3).trim(),
          code = [];
        for (i++; i < lines.length && !/^\s*```/.test(lines[i]); i++) code.push(lines[i]);
        if (i < lines.length) i++;
        const block = el('div', 'code-block'),
          header = el('div', 'code-header');
        header.append(el('span', '', lang || 'Code'), copyButton(code.join('\n'), 'Copy code'));
        const pre = el('pre');
        pre.append(el('code', '', code.join('\n')));
        block.append(header, pre);
        root.append(block);
        continue;
      }
      const heading = /^(#{1,4})\s+(.+)$/.exec(line);
      if (heading) {
        const h = el('h' + Math.min(heading[1].length + 1, 4));
        inline(h, heading[2]);
        root.append(h);
        i++;
        continue;
      }
      if (line.includes('|') && i + 1 < lines.length && /^\s*\|?\s*:?-{3,}/.test(lines[i + 1])) {
        const wrap = el('div', 'table-scroll'),
          table = el('table');
        const cells = (row) =>
          row
            .trim()
            .replace(/^\||\|$/g, '')
            .split('|');
        const tr = el('tr');
        for (const cell of cells(line)) {
          const th = el('th');
          inline(th, cell.trim());
          tr.append(th);
        }
        const head = el('thead');
        head.append(tr);
        table.append(head);
        i += 2;
        const body = el('tbody');
        while (i < lines.length && lines[i].includes('|') && lines[i].trim()) {
          const row = el('tr');
          for (const cell of cells(lines[i++])) {
            const td = el('td');
            inline(td, cell.trim());
            row.append(td);
          }
          body.append(row);
        }
        table.append(body);
        wrap.append(table);
        root.append(wrap);
        continue;
      }
      const list = /^\s*(?:[-*]|\d+\.)\s+/.exec(line);
      if (list) {
        const ordered = /^\s*\d+\./.test(line),
          group = el(ordered ? 'ol' : 'ul');
        if (ordered) group.start = parseInt(line, 10);
        while (i < lines.length && (ordered ? /^\s*\d+\.\s+/ : /^\s*[-*]\s+/).test(lines[i])) {
          const li = el('li');
          inline(li, lines[i++].replace(/^\s*(?:[-*]|\d+\.)\s+/, ''));
          group.append(li);
        }
        root.append(group);
        continue;
      }
      if (/^>\s?/.test(line)) {
        const q = el('blockquote');
        inline(q, line.replace(/^>\s?/, ''));
        root.append(q);
        i++;
        continue;
      }
      const paragraph = [lines[i++]];
      while (
        i < lines.length &&
        lines[i].trim() &&
        !/^\s*(```|#{1,4}\s|[-*]\s|\d+\.\s|>)/.test(lines[i]) &&
        !(lines[i].includes('|') && /^\s*\|?\s*:?-{3,}/.test(lines[i + 1] || ''))
      )
        paragraph.push(lines[i++]);
      const p = el('p');
      inline(p, paragraph.join('\n'));
      root.append(p);
    }
    return root;
  }
  const stateClass = (label) =>
    /Succeeded|Completed/.test(label)
      ? 'success'
      : /Failed/.test(label)
        ? 'failure'
        : /approval|uncertain/i.test(label)
          ? 'attention'
          : '';
  function activity(a, previous) {
    const shell = el('div');
    const details = el('details', 'activity');
    details.open = previous ? previous.open : false;
    const summary = el('summary');
    summary.dataset.focusKey = 'activity';
    summary.append(el('span', 'activity-title', a.title), el('span', 'state ' + stateClass(a.state), a.state));
    details.append(summary);
    const content = el('div', 'activity-content');
    for (const step of a.steps || []) {
      const row = el('div', 'step'),
        heading = el('div', 'step-heading');
      heading.append(el('span', '', step.name), el('span', 'state ' + stateClass(step.state), step.state));
      row.append(heading);
      for (const key of ['input', 'result'])
        if (step[key]) {
          const raw = el('details');
          raw.dataset.detailKey = step.id + key;
          const old =
            previous &&
            Array.from(previous.querySelectorAll('[data-detail-key]')).find(
              (n) => n.dataset.detailKey === raw.dataset.detailKey,
            );
          raw.open = !!old && old.open;
          const toggle = el('summary', '', key === 'input' ? 'Input' : 'Result');
          toggle.dataset.focusKey = raw.dataset.detailKey;
          raw.append(toggle, el('pre', '', step[key]));
          row.append(raw);
        }
      content.append(row);
    }
    for (const verdict of a.verdicts || []) content.append(el('p', '', verdict));
    if (a.error) content.append(el('p', 'error-detail', a.error));
    details.append(content);
    shell.append(details);
    if (a.approval) {
      const review = el('div', 'approval');
      review.append(el('p', '', a.approval.hint || 'Review this action before continuing.'));
      if (a.approval.native)
        review.append(el('p', '', 'Review the exact operation in the Unreal approval panel above.'));
      else {
        review.append(el('pre', 'approval-args', a.approval.input));
        const actions = el('div', 'actions');
        const extra = { approval: a.approval.id };
        const approve = button('Approve once', () => dispatch('approve', a.id, extra), 'primary');
        const reject = button('Reject', () => dispatch('reject', a.id, extra));
        approve.dataset.focusKey = 'approve:' + a.approval.id;
        reject.dataset.focusKey = 'reject:' + a.approval.id;
        approve.disabled = reject.disabled = !a.approval.enabled;
        actions.append(approve, reject);
        review.append(actions);
      }
      // Approval stays visible even when activity details are collapsed.
      shell.append(review);
    }
    return shell;
  }
  function updateRow(row, msg) {
    const old = row._message;
    row._message = msg;
    if (!old || old.text !== msg.text || old.role !== msg.role) {
      if (!old || old.role !== msg.role) {
        const header = el('div', 'message-header');
        if (msg.role === 'assistant') {
          const logo = el('img');
          logo.src = '../HaybaLogo.svg';
          logo.alt = '';
          header.append(logo);
        }
        header.append(
          el(
            'span',
            '',
            msg.role === 'user'
              ? 'You'
              : msg.role === 'inspection'
                ? 'World inspection'
                : msg.notice
                  ? 'Needs attention'
                  : 'Hayba',
          ),
          copyButton(() => row._message.text, 'Copy message'),
        );
        const previous = row.querySelector('.message-header');
        if (previous) previous.replaceWith(header);
        else row.prepend(header);
      }
      const body = markdown(msg.notice ? msg.text.replace(/^⚠\s*/, '') : msg.text, msg.role === 'user');
      const existing = row.querySelector('.body');
      if (existing) {
        const next = Array.from(body.children);
        next.forEach((block, i) => {
          const before = existing.children[i];
          if (!before) existing.append(block);
          else if (before.outerHTML !== block.outerHTML) before.replaceWith(block);
        });
        while (existing.children.length > next.length) existing.lastChild.remove();
      } else row.append(body);
    }
    const serialized = JSON.stringify(msg.activity || null);
    if (row._activity !== serialized) {
      const oldActivity = row.querySelector('.activity-slot'),
        slot = el('div', 'activity-slot');
      if (msg.activity) slot.append(activity(msg.activity, oldActivity && oldActivity.querySelector('.activity')));
      const focused = oldActivity && oldActivity.contains(document.activeElement) ? document.activeElement : null;
      const focusKey = focused && focused.dataset.focusKey;
      if (oldActivity) oldActivity.replaceWith(slot);
      else row.append(slot);
      row._activity = serialized;
      if (focused) {
        const replacement = Array.from(slot.querySelectorAll('[data-focus-key]')).find(
          (n) => n.dataset.focusKey === focusKey,
        );
        (replacement || slot.querySelector('summary'))?.focus({ preventScroll: true });
      }
    }
    const actionKey = [msg.retry, msg.community, state.canSend].join(':');
    if (row._actions !== actionKey) {
      const oldActions = row.querySelector('.message-actions'),
        actions = el('div', 'message-actions actions');
      if (msg.retry) {
        const retry = button('Edit and resend', () => dispatch('retry', msg.id));
        retry.disabled = !state.canSend;
        actions.append(retry);
      }
      if (msg.community) {
        const fallback = button('Use Community for this chat', () => dispatch('community', msg.id));
        fallback.disabled = !state.canSend;
        actions.append(fallback);
      }
      if (oldActions) oldActions.replaceWith(actions);
      else row.append(actions);
      row._actions = actionKey;
    }
    row.className =
      'message ' +
      (msg.role === 'user' ? 'user' : msg.role === 'inspection' ? 'inspection' : '') +
      (msg.notice ? ' notice' : '');
    row._message = msg;
  }
  const nearBottom = () => viewport.scrollHeight - viewport.clientHeight - viewport.scrollTop < 40;
  const earlier = button('Earlier messages', () => showRange(Math.max(0, first - pageSize)), 'history-page');
  const later = button('Later messages', () => showRange(last), 'history-page');
  rows.before(earlier);
  rows.after(later);
  function showRange(start, targetId) {
    window.getSelection()?.removeAllRanges();
    first = Math.max(0, Math.min(start, state.messages.length - 1));
    last = Math.min(state.messages.length, first + pageSize);
    navigating = true;
    receive(state);
    navigating = false;
    const target = targetId == null ? null : rendered.get(String(targetId));
    if (target) {
      target.tabIndex = -1;
      target.scrollIntoView({ block: 'start' });
      target.focus({ preventScroll: true });
    } else viewport.scrollTop = 0;
  }
  function jumpTo(id) {
    const index = state.messages.findIndex((m) => String(m.id) === String(id));
    if (index >= 0) showRange(Math.max(0, index - 2), id);
  }
  function jumpLatest() {
    showRange(Math.max(0, state.messages.length - pageSize));
    viewport.scrollTop = viewport.scrollHeight;
    $('latest').hidden = true;
  }
  function receive(next) {
    const wasNearBottom = nearBottom();
    window.haybaWorkspace?.receive(next);
    // Hold updates while text is selected; never tear a selection out of the reader's hands.
    const selection = window.getSelection();
    if (
      next.generation === state.generation &&
      selection &&
      !selection.isCollapsed &&
      viewport.contains(selection.anchorNode)
    ) {
      pending = next;
      return;
    }
    pending = null;
    const changedSession = next.generation !== state.generation;
    const pinned = !navigating && (changedSession || (last >= state.messages.length && wasNearBottom));
    if (changedSession) {
      rows.replaceChildren();
      rendered.clear();
      commands.length = 0;
    }
    if (changedSession || pinned) {
      last = next.messages.length;
      first = Math.max(0, last - pageSize);
    } else if (!navigating && last >= state.messages.length) last = Math.min(next.messages.length, first + pageSize);
    state = next;
    const ids = new Set();
    let position = 0;
    for (const msg of state.messages.slice(first, last)) {
      const id = String(msg.id);
      ids.add(id);
      let row = rendered.get(id);
      if (!row) {
        row = el('article', 'message');
        row.setAttribute('aria-label', msg.role === 'user' ? 'Your message' : 'Hayba message');
        rendered.set(id, row);
      }
      if (rows.children[position] !== row) rows.insertBefore(row, rows.children[position] || null);
      ++position;
      updateRow(row, msg);
    }
    for (const [id, row] of rendered)
      if (!ids.has(id)) {
        row.remove();
        rendered.delete(id);
      }
    $('empty').hidden = state.messages.length !== 0 || !!state.externalReview;
    $('working').hidden = !state.busy && !state.awaitingApproval;
    $('working-label').textContent = state.awaitingApproval
      ? 'Waiting for your review'
      : state.inspecting
        ? 'Inspecting the loaded world…'
        : 'Working…';
    document.querySelectorAll('.starters [data-action]').forEach((b) => (b.disabled = !state.canSend));
    earlier.hidden = first === 0;
    earlier.textContent = 'Earlier messages · ' + first + ' before this page';
    later.hidden = last >= state.messages.length;
    later.textContent = 'Later messages · ' + (state.messages.length - last) + ' after this page';
    if (pinned) viewport.scrollTop = viewport.scrollHeight;
    $('latest').hidden = !!state.awaitingApproval || (last >= state.messages.length && (pinned || nearBottom()));
  }
  viewport.addEventListener('scroll', () => {
    if (last >= state.messages.length && nearBottom()) $('latest').hidden = true;
  });
  document.addEventListener('selectionchange', () => {
    if (pending && window.getSelection().isCollapsed) receive(pending);
  });
  $('latest').addEventListener('click', jumpLatest);
  document
    .querySelectorAll('[data-action]')
    .forEach((b) => b.addEventListener('click', () => dispatch(b.dataset.action, b.dataset.value || '')));
  window.haybaChat = {
    init(value) {
      token = value;
      dispatch('ready');
    },
    receive,
    dispatch,
    jumpTo,
    jumpLatest,
    ack(result) {
      if (result?.action === 'copy') {
        const message = result.ok ? 'Copied to clipboard' : 'Could not copy to clipboard';
        announce(message);
        window.haybaWorkspace?.toast(message);
      }
      sending = false;
      flush();
    },
  };
  function startAppHost() {
    if (document.body?.dataset.haybaHost !== 'app') return;
    token = 'app';
    dispatch('ready');
  }
  window.addEventListener('load', startAppHost);
})();
