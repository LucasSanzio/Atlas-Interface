(() => {
  'use strict';

  const find = selector => document.querySelector(selector);
  const ui = {
    orbit: find('#atlas-orbita'),
    history: find('.atlas-history'),
    transcript: find('.atlas-transcript'),
    title: find('.atlas-chat-title'),
    context: find('.atlas-chat-context'),
    tabs: find('#atlas-tabs'),
    tabWarning: find('#atlas-tab-warning'),
    openOrbitThread: find('#atlas-open-orbit-thread'),
    label: find('.atlas-thread-label strong'),
    position: find('.atlas-thread-label span'),
    previous: find('.atlas-prev'),
    next: find('.atlas-next'),
    presence: find('.atlas-presence'),
    form: find('.atlas-compose'),
    input: find('.atlas-input'),
    newThread: find('#atlas-new'),
    stop: find('#atlas-stop'),
    connection: find('#atlas-connection'),
    usage: find('#atlas-usage'),
    alert: find('#atlas-alert'),
    openProjects: find('#atlas-open-projects'),
    openSettings: find('#atlas-open-settings'),
    projectOrbit: find('#atlas-project-orbit'),
    projectDialog: find('#atlas-project-dialog'),
    projectDialogTitle: find('#atlas-project-dialog-title'),
    projectDialogBody: find('#atlas-project-dialog-body'),
    projectTabWarning: find('#atlas-project-tab-warning'),
  };
  const projectRails = [...ui.projectOrbit.querySelectorAll('.atlas-project-rail')];
  const submit = ui.form.querySelector('[type="submit"]');
  const threads = new Map();
  const approvals = new Map();
  const resolving = new Set();
  const stopping = new Set();
  const drafts = new Map();
  const tabsKey = 'atlas.conversationTabs';
  const tabLimit = 2;
  const tabLimitMessage = 'Feche uma aba para abrir outra conversa.';
  const pinnedProjectsKey = 'atlas.pinnedProjects';
  const historyDate = new Intl.DateTimeFormat('pt-BR', { dateStyle: 'medium', timeStyle: 'short' });
  const approvalTitles = {
    'item/commandExecution/requestApproval': 'Executar comando',
    'item/fileChange/requestApproval': 'Alterar arquivos',
    'item/permissions/requestApproval': 'Conceder permissões',
  };
  const itemStates = {
    inProgress: 'Em execução',
    completed: 'Concluída',
    failed: 'Falhou',
    declined: 'Recusada',
    interrupted: 'Interrompida',
  };

  let selectedId = null;
  let orbitId = null;
  let openIds = [];
  let savedTabs;
  let legacySelection;
  let pinnedProjects;
  try {
    const storedTabs = JSON.parse(localStorage.getItem(tabsKey));
    if (Array.isArray(storedTabs?.tabs)) savedTabs = storedTabs;
    legacySelection = localStorage.getItem('atlas.selectedThread');
    const storedPins = JSON.parse(localStorage.getItem(pinnedProjectsKey));
    if (Array.isArray(storedPins)) pinnedProjects = new Set(storedPins.filter(id => typeof id === 'string'));
  } catch {}
  let openPreviewOnChat = !savedTabs;
  let projects = new Map();
  let projectsPromise;
  let projectView;
  let online = false;
  let transportOpen = false;
  let checking = true;
  let reconnectTimer;
  let refreshPromise;
  let connectionError = '';
  let historyError = '';
  let cursor = null;
  let nextPagePromise;
  let pendingSteps = 0;
  let orbitMoving = false;
  let writing = false;
  let version = 0;
  let generation = 0;
  let rateLimits;
  let rateRevision = 0;
  let account;
  let accountKnown = false;
  let rateError = false;
  let actionError = '';
  let frame = 0;
  let renderedThread;

  const stream = new EventSource('/api/events');

  function errorMessage(error, fallback) {
    const message = error?.message || fallback;
    if (/model_not_found|model .+does not exist|model .+not (found|supported|available)/i.test(message)) {
      return 'O modelo solicitado não está disponível para sua conta do Codex.';
    }
    if (/usage_limit_reached|usageLimitExceeded/i.test(`${message} ${error?.codexErrorInfo ?? ''}`)) {
      return 'O limite de uso da sua conta do Codex foi atingido.';
    }
    return message;
  }

  async function request(path, data) {
    const options = data === undefined ? {} : {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(data),
    };
    const response = await fetch(path, options);
    const payload = await response.json();
    if (!response.ok || payload.error) {
      throw new Error(errorMessage(payload.error, `Falha na conexão local (${response.status}).`));
    }
    return payload.result;
  }

  const rpc = (method, params = {}) => request('/api/rpc', { method, params });
  const decisionsPath = threadId => `/api/approvals?${new URLSearchParams({ threadId })}`;

  function threadState(id) {
    if (!threads.has(id)) {
      threads.set(id, { id, turns: new Map(), meta: {}, statusAt: 0 });
    }
    return threads.get(id);
  }

  function applyMeta(state, thread, snapshotVersion = version) {
    const { turns, status, ...meta } = thread;
    state.meta = { ...state.meta, ...meta };
    if (status && state.statusAt <= snapshotVersion) {
      state.status = status.type;
      state.statusAt = snapshotVersion;
    }
  }

  function turnState(thread, id) {
    if (!thread.turns.has(id)) {
      thread.turns.set(id, { id, items: new Map(), updatedAt: 0, statusAt: 0 });
    }
    return thread.turns.get(id);
  }

  function setItem(turn, item, final, at = version) {
    const existing = turn.items.get(item.id);
    if (existing?.updatedAt > at || (existing?.final && !final)) return;
    turn.items.set(item.id, { ...item, final, updatedAt: at });
  }

  function applyTurn(thread, turn, at, fromHistory = false) {
    const state = turnState(thread, turn.id);
    if (state.statusAt <= at) {
      state.status = turn.status;
      state.error = turn.error;
      state.statusAt = at;
    }
    if (!fromHistory && turn.status === 'inProgress') state.liveIn = generation;
    state.updatedAt = Math.max(state.updatedAt, at);
    if (fromHistory) {
      // Rollout history supplies the canonical item order and IDs for finished turns.
      const live = state.items;
      const finished = turn.status !== 'inProgress';
      state.items = new Map();
      for (const item of turn.items ?? []) {
        const current = live.get(item.id);
        if (current && (current.updatedAt > at || (!finished && current.final))) {
          state.items.set(item.id, current);
        } else {
          setItem(state, item, finished || item.type === 'userMessage', at);
        }
      }
      for (const [id, current] of live) {
        if (!state.items.has(id) && (!finished || current.updatedAt > at)) {
          state.items.set(id, current);
        }
      }
      return;
    }
    for (const item of turn.items ?? []) {
      setItem(state, item, turn.status !== 'inProgress' || item.type === 'userMessage', at);
    }
  }

  function applyHistory(thread, at) {
    const state = threadState(thread.id);
    const live = state.turns;
    state.turns = new Map();
    applyMeta(state, thread, at);
    const archived = archivedFromPath(thread.path);
    if (archived !== undefined) updateArchived(state, archived, at);
    for (const turn of thread.turns ?? []) {
      if (live.has(turn.id)) state.turns.set(turn.id, live.get(turn.id));
      applyTurn(state, turn, at, true);
    }
    for (const [id, turn] of live) {
      const streaming = turn.status === 'inProgress' && turn.liveIn === generation;
      if (!state.turns.has(id) && (streaming || state.status === 'active' || turn.updatedAt > at)) {
        state.turns.set(id, turn);
      }
    }
  }

  function orderedThreads() {
    return [...threads.values()].filter(thread => thread.listed)
      .sort((first, second) => (second.meta.createdAt ?? 0) - (first.meta.createdAt ?? 0));
  }

  function projectName(thread) {
    if (!thread) return 'Nova conversa';
    const cwd = thread.meta.cwd?.trim();
    if (!cwd) return 'Projeto sem pasta';
    return cwd.split(/[\\/]+/).filter(Boolean).at(-1) ?? cwd;
  }

  function activeTurn(thread) {
    return [...(thread?.turns.values() ?? [])].findLast(turn => turn.status === 'inProgress');
  }

  function make(tag, className, label) {
    const element = document.createElement(tag);
    if (className) element.className = className;
    if (label) element.textContent = label;
    return element;
  }

  function keyed(element, key) {
    element.dataset.key = key;
    return element;
  }

  function reconcile(container, children) {
    const existing = new Map([...container.children].map(child => [child.dataset.key, child]));
    const retained = new Set();
    let position = container.firstElementChild;
    for (const child of children) {
      const old = existing.get(child.dataset.key);
      if (old?.querySelector('details[open]')) {
        const details = child.querySelector('details');
        if (details) details.open = true;
      }
      let next = child;
      if (old?.isEqualNode(child)) next = old;
      if (next !== position) container.insertBefore(next, position);
      retained.add(next);
      position = next.nextElementSibling;
    }
    for (const child of [...container.children]) {
      if (!retained.has(child)) child.remove();
    }
  }

  async function collectPages(method, field, params = {}) {
    const entries = [];
    const seenCursors = new Set();
    let pageCursor = null;
    do {
      const page = await rpc(method, { ...params, cursor: pageCursor, limit: 100 });
      entries.push(...page[field]);
      seenCursors.add(pageCursor);
      pageCursor = page.nextCursor;
    } while (pageCursor && !seenCursors.has(pageCursor));
    return entries;
  }

  function visibleProjectIds() {
    return pinnedProjects ?? new Set([...projects.keys()].slice(0, 3));
  }

  function renderProjectOrbit() {
    const visible = visibleProjectIds();
    const nodes = [...projects.values()].filter(project => visible.has(project.id)).map(project => {
      const button = make('button', 'atlas-node');
      button.type = 'button';
      button.title = project.name;
      button.dataset.projectId = project.id;
      button.setAttribute('aria-haspopup', 'dialog');
      button.setAttribute('aria-controls', ui.projectDialog.id);
      const satellite = make('span', 'atlas-satellite', '◈');
      satellite.setAttribute('aria-hidden', 'true');
      button.append(satellite, make('span', 'atlas-node-name', project.name));
      return keyed(button, project.id);
    });
    const midpoint = Math.ceil(nodes.length / 2);
    reconcile(projectRails[0], nodes.slice(0, midpoint));
    reconcile(projectRails[1], nodes.slice(midpoint));
  }

  function loadProjects() {
    projectsPromise ??= collectPages('project/list', 'data').then(entries => {
      projects = new Map(entries.map(project => [project.id, project]));
      renderProjectOrbit();
    }).finally(() => { projectsPromise = undefined; });
    return projectsPromise;
  }

  function projectButton(className, label, onClick) {
    const button = make('button', className, label);
    button.type = 'button';
    button.addEventListener('click', onClick);
    return button;
  }

  function projectStatus(text) {
    const status = make('p', 'atlas-project-empty', text);
    status.setAttribute('role', 'status');
    return status;
  }

  function showProjectView(title, body) {
    const view = {};
    projectView = view;
    ui.projectTabWarning.textContent = '';
    ui.projectDialogTitle.textContent = title;
    ui.projectDialogBody.replaceChildren(body);
    ui.projectDialogBody.scrollTop = 0;
    if (!ui.projectDialog.open) ui.projectDialog.showModal();
    ui.projectDialogTitle.focus();
    return view;
  }

  function hasProjectView(view) {
    return ui.projectDialog.open && projectView === view;
  }

  function showProjectError(container, message, retry) {
    container.replaceChildren(projectStatus(message), projectButton('atlas-project-row', 'Tentar novamente', retry));
  }

  function projectPreference(project, visible) {
    const control = make('label', 'atlas-project-check');
    const checkbox = make('input');
    checkbox.type = 'checkbox';
    checkbox.checked = visible.has(project.id);
    checkbox.addEventListener('change', () => {
      pinnedProjects ??= visibleProjectIds();
      if (checkbox.checked) pinnedProjects.add(project.id);
      else pinnedProjects.delete(project.id);
      try { localStorage.setItem(pinnedProjectsKey, JSON.stringify([...pinnedProjects])); } catch {}
      renderProjectOrbit();
    });
    control.append(checkbox, make('span', '', project.name));
    return control;
  }

  async function openProjectCatalog(settings = false) {
    const list = make('div', 'atlas-project-list');
    const body = make('div', 'atlas-project-list');
    if (settings) body.append(make('p', 'atlas-project-history-meta', 'Projetos visíveis no painel orbital'));
    body.append(list);
    list.append(projectStatus('Carregando projetos…'));
    const view = showProjectView(settings ? 'Configurações' : 'Projetos', body);
    try {
      await loadProjects();
      if (!hasProjectView(view)) return;
      const visible = visibleProjectIds();
      const rows = [...projects.values()].map(project => settings ? projectPreference(project, visible)
        : projectButton('atlas-project-row', project.name, () => void openProjectHistory(project, true)));
      list.replaceChildren(...rows);
      if (!rows.length) list.append(projectStatus('Nenhum projeto disponível no Codex.'));
    } catch {
      if (hasProjectView(view)) showProjectError(list, 'Não foi possível carregar os projetos do Codex.', () => void openProjectCatalog(settings));
    }
  }

  async function projectHistory(project) {
    const paths = [...new Set(project.roots.map(root => root.path).filter(Boolean))];
    const scopes = [{ projectId: project.id }];
    if (paths.length) scopes.push({ projectId: null, cwd: paths });
    const requests = [];
    for (const archived of [false, true]) {
      for (const scope of scopes) {
        requests.push(collectPages('thread/list', 'data', { ...scope, archived, sortKey: 'updated_at' })
          .then(entries => entries.map(thread => ({ thread, archived }))));
      }
    }
    const groups = await Promise.all(requests);
    const history = new Map();
    for (const entry of groups.flat()) history.set(entry.thread.id, entry);
    const updated = thread => thread.updatedAt ?? thread.createdAt ?? 0;
    return [...history.values()].sort((first, second) => updated(second.thread) - updated(first.thread));
  }

  function openProjectThread(thread, archived, at) {
    if (!online || writing || !hasTabSpace(thread.id, ui.projectTabWarning)) return;
    const state = threadState(thread.id);
    applyMeta(state, thread, at);
    updateArchived(state, archived, at);
    ui.projectDialog.close();
    openThread(thread.id);
    ui.orbit.dispatchEvent(new CustomEvent('atlas-open-chat'));
  }

  async function openProjectHistory(project, fromCatalog = false) {
    const body = make('div', 'atlas-project-list');
    if (fromCatalog) body.append(projectButton('atlas-project-row', 'Voltar aos projetos', () => void openProjectCatalog()));
    const list = make('div', 'atlas-project-list');
    list.append(projectStatus('Carregando conversas…'));
    body.append(list);
    const view = showProjectView(project.name, body);
    const at = version;
    try {
      const entries = await projectHistory(project);
      if (!hasProjectView(view)) return;
      const rows = entries.map(({ thread, archived }) => {
        const title = thread.name?.trim() || 'Conversa';
        const row = projectButton('atlas-project-row', '', () => openProjectThread(thread, archived, at));
        row.dataset.threadId = thread.id;
        row.disabled = !online || writing;
        const date = new Date((thread.updatedAt ?? thread.createdAt) * 1000);
        const details = [Number.isFinite(date.getTime()) ? historyDate.format(date) : '', archived ? 'Arquivada' : ''].filter(Boolean);
        row.append(make('span', '', title));
        if (details.length) row.append(make('span', 'atlas-project-history-meta', details.join(' · ')));
        return row;
      });
      view.threadRows = rows;
      list.replaceChildren(...rows);
      if (!rows.length) list.append(projectStatus('Nenhuma conversa neste projeto.'));
    } catch {
      if (hasProjectView(view)) showProjectError(list, 'Não foi possível carregar as conversas deste projeto.', () => void openProjectHistory(project, fromCatalog));
    }
  }

  function renderHistory(entries) {
    const children = entries.map(thread => {
      const name = projectName(thread);
      const button = make('button', 'atlas-history-entry', name);
      button.type = 'button';
      button.title = name;
      button.dataset.threadId = thread.id;
      button.disabled = !online || writing;
      if (thread.id === selectedId) button.setAttribute('aria-current', 'true');
      return keyed(button, thread.id);
    });
    if (cursor) {
      const more = make('button', 'atlas-history-entry', nextPagePromise ? 'Carregando…' : 'Carregar mais');
      more.type = 'button';
      more.dataset.more = 'true';
      more.disabled = !online || Boolean(nextPagePromise);
      children.push(keyed(more, 'more'));
    }
    if (!children.length || historyError) {
      const message = historyError || (checking ? 'Carregando conversas…' : 'Nenhuma conversa disponível.');
      children.push(keyed(make('p', 'atlas-status', message), 'history-status'));
    }
    reconcile(ui.history, children);
  }

  function renderTabs() {
    for (const tab of [...ui.tabs.children]) {
      if (!openIds.includes(tab.dataset.threadId)) tab.remove();
    }
    const names = openIds.map(id => projectName(threads.get(id)));
    for (const [index, id] of openIds.entries()) {
      let tab = [...ui.tabs.children].find(child => child.dataset.threadId === id);
      if (!tab) {
        tab = make('div', 'atlas-conversation-tab');
        tab.dataset.threadId = id;
        const selectTab = make('button', 'atlas-tab-select');
        const closeTab = make('button', 'atlas-tab-close', '×');
        selectTab.type = closeTab.type = 'button';
        tab.append(selectTab, closeTab);
        ui.tabs.append(tab);
      }
      const [selectTab, closeTab] = tab.children;
      const project = names[index];
      const duplicate = names.indexOf(project) !== names.lastIndexOf(project);
      const name = duplicate ? `${project} (${index + 1})` : project;
      if (selectTab.textContent !== name) selectTab.textContent = name;
      selectTab.title = name;
      selectTab.setAttribute('aria-pressed', String(id === selectedId));
      selectTab.disabled = writing && id !== selectedId;
      closeTab.setAttribute('aria-label', `Fechar aba ${name}`);
      closeTab.disabled = writing;
    }
  }

  function approvalKey({ id, params }) {
    return JSON.stringify([params.threadId, params.turnId, params.itemId, id]);
  }

  function saveApproval(record) {
    if (!record?.params?.threadId || !approvalTitles[record.method]) return;
    const key = approvalKey(record);
    const current = approvals.get(key);
    if (current?.decision && !record.decision) return;
    const merged = { ...current, ...record };
    merged.resolved = Boolean(merged.decision || merged.resolved);
    approvals.set(key, merged);
  }

  function approvalDetails(card, record, item) {
    const { params } = record;
    if (params.reason) card.append(make('p', '', params.reason));
    if (params.networkApprovalContext) {
      const { protocol, host } = params.networkApprovalContext;
      if (host) card.append(make('p', '', `Destino · ${protocol ? `${protocol} · ` : ''}${host}`));
    } else if (params.command || item?.command) {
      card.append(make('pre', '', params.command || item.command));
    }
    const cwd = params.cwd || item?.cwd;
    if (cwd) card.append(make('p', '', `Diretório · ${cwd}`));
    if (params.grantRoot) card.append(make('p', '', `Raiz solicitada · ${params.grantRoot}`));
    const permissions = params.permissions || params.additionalPermissions;
    if (permissions) card.append(make('pre', '', JSON.stringify(permissions, null, 2)));
    if (item?.changes?.length) {
      for (const change of item.changes) card.append(make('p', '', change.path));
      const patch = item.changes.map(change => change.diff).filter(Boolean).join('\n');
      if (patch) {
        const details = make('details');
        details.append(make('summary', '', 'Ver alteração'), make('pre', '', patch));
        card.append(details);
      }
    }
  }

  function approvalCard(key, record, item, turnStatus) {
    const title = record.params.networkApprovalContext ? 'Permitir acesso à rede' : approvalTitles[record.method];
    const card = keyed(make('li', 'atlas-approval'), `approval:${key}`);
    const details = record.item ? { ...record.item, ...item } : item;
    const outcome = record.item?.status && record.item.status !== 'inProgress' ? record.item.status : details?.status;
    turnStatus = record.turnStatus || turnStatus;
    card.append(make('strong', '', title));
    approvalDetails(card, record, details);
    if (record.resolved) {
      const decision = { accept: 'Aprovada', decline: 'Recusada', cancel: 'Cancelada' }[record.decision];
      let action = itemStates[outcome];
      if (outcome === 'inProgress' || !action) {
        if (turnStatus === 'interrupted') action = 'Interrompida';
        else if (turnStatus === 'failed') action = 'Turno com falha';
        else if (!action && turnStatus === 'inProgress' && record.decision === 'accept') action = 'Aguardando resultado';
        else if (!action && record.decision === 'accept') action = 'Resultado da ação indisponível';
      }
      const date = record.decidedAt && new Date(record.decidedAt);
      const time = date && Number.isFinite(date.getTime()) ? date.toLocaleString('pt-BR') : '';
      const status = [decision || 'Pedido encerrado', action === decision ? '' : action, time];
      card.append(make('p', 'atlas-status', status.filter(Boolean).join(' · ')));
      return card;
    }
    const actions = make('div', 'atlas-approval-actions');
    const allowed = record.params.availableDecisions;
    for (const [value, label] of [['accept', 'Aprovar'], ['decline', 'Recusar']]) {
      const offered = !Array.isArray(allowed) || allowed.includes(value)
        || (value === 'decline' && allowed.includes('cancel'));
      const button = make('button', '', label);
      button.type = 'button';
      button.dataset.approval = key;
      button.dataset.decision = value;
      button.disabled = !online || threads.get(record.params.threadId)?.archived || resolving.has(key) || !offered;
      actions.append(button);
    }
    card.append(actions);
    return card;
  }

  function itemNode(item, turnId) {
    let node;
    if (item.type === 'userMessage' || item.type === 'agentMessage') {
      const user = item.type === 'userMessage';
      const text = user ? item.content?.map(part => part.type === 'text' ? part.text : '[Anexo]').join('\n') : item.text;
      if (!text) return null;
      node = make('li', `atlas-message ${user ? 'user' : 'assistant'}`);
      node.append(make('span', '', user ? 'Você' : 'Codex'), document.createTextNode(text));
    } else if (item.type === 'commandExecution' || item.type === 'fileChange') {
      const summary = item.command || item.changes?.map(change => change.path).join(', ');
      const kind = item.type === 'commandExecution' ? 'Comando' : 'Alteração de arquivos';
      node = make('li', 'atlas-status', [kind, summary, itemStates[item.status]].filter(Boolean).join(' · '));
    } else if (item.type === 'plan' && item.text) {
      node = make('li', 'atlas-message assistant');
      node.append(make('span', '', 'Plano'), document.createTextNode(item.text));
    }
    return node && keyed(node, `item:${turnId}:${item.id}`);
  }

  function renderTranscript(thread, records) {
    const children = [];
    const displayed = new Set();
    if (thread?.loading) children.push(keyed(make('li', 'atlas-status', 'Carregando conversa…'), 'loading'));
    if (thread?.loadError) children.push(keyed(make('li', 'atlas-status', thread.loadError), 'read-error'));
    if (thread?.decisionsError) children.push(keyed(make('li', 'atlas-status', thread.decisionsError), 'decision-error'));
    for (const turn of thread?.turns.values() ?? []) {
      for (const item of turn.items.values()) {
        const related = records.filter(([, record]) => record.params.turnId === turn.id && record.params.itemId === item.id);
        if (related.length) {
          for (const [key, record] of related) {
            children.push(approvalCard(key, record, item, turn.status));
            displayed.add(key);
          }
          continue;
        }
        const node = itemNode(item, turn.id);
        if (node) children.push(node);
      }
      for (const [key, record] of records) {
        if (!displayed.has(key) && record.params.turnId === turn.id) {
          children.push(approvalCard(key, record, null, turn.status));
          displayed.add(key);
        }
      }
      if (turn.status === 'failed' || turn.status === 'interrupted') {
        const message = turn.status === 'interrupted' ? 'Resposta interrompida.' : errorMessage(turn.error, 'A execução falhou.');
        children.push(keyed(make('li', 'atlas-status', message), `turn:${turn.id}`));
      }
    }
    for (const [key, record] of records) {
      if (!displayed.has(key)) children.push(approvalCard(key, record, null, thread?.turns.get(record.params.turnId)?.status));
    }
    if (!children.length) {
      const empty = thread?.archived ? 'Nenhuma mensagem disponível.' : 'Envie uma mensagem para o Codex.';
      children.push(keyed(make('li', 'atlas-status', empty), 'empty'));
    }
    const area = ui.transcript;
    const atEnd = area.scrollHeight - area.clientHeight - area.scrollTop < 60;
    reconcile(area, children);
    if (renderedThread !== selectedId || atEnd) area.scrollTop = area.scrollHeight;
    renderedThread = selectedId;
  }

  function setStatus(element, state, label) {
    element.dataset.state = state;
    if (element.textContent !== label) element.textContent = label;
  }

  function render() {
    frame = 0;
    const entries = orderedThreads();
    if (!threads.get(orbitId)?.listed) orbitId = entries[0]?.id ?? null;
    const index = entries.findIndex(thread => thread.id === orbitId);
    const thread = threads.get(selectedId);
    const records = [...approvals].filter(([, record]) => record.params.threadId === selectedId);
    const pending = records.some(([, record]) => !record.resolved);
    const currentTurn = activeTurn(thread);
    const running = Boolean(currentTurn || thread?.status === 'active');
    const windows = [rateLimits?.primary, rateLimits?.secondary].filter(window => Number.isFinite(window?.usedPercent));
    const limitedWindow = windows.find(window => window.usedPercent >= 100);
    const limited = Boolean(rateLimits?.rateLimitReachedType || limitedWindow);
    const resetsAt = limitedWindow?.resetsAt;
    const limit = resetsAt ? `Limite do Codex atingido · renova em ${new Date(resetsAt * 1000).toLocaleString('pt-BR')}.`
      : 'Limite do Codex atingido.';
    const plan = account?.planType ? `ChatGPT ${account.planType}` : 'Codex';
    const usage = windows.map(window => `${window.usedPercent}%`).join(' / ');

    setStatus(ui.connection, online ? 'online' : checking ? 'pending' : 'offline',
      online ? 'Codex conectado' : checking ? 'Conectando ao Codex…' : 'Codex desconectado');
    setStatus(ui.usage, limited ? 'limited' : 'idle', usage ? `${plan} · ${usage} usado` : rateError ? `${plan} · uso indisponível` : plan);
    ui.usage.title = windows.map(window => {
      const duration = window.windowDurationMins;
      return `${window.usedPercent}%${duration ? ` em ${duration} min` : ''}`;
    }).join(' · ');
    const alert = connectionError || actionError || (limited ? limit : '')
      || (accountKnown && !account ? 'Entre no Codex pelo terminal para usar sua conta.' : '');
    ui.alert.hidden = !alert;
    if (ui.alert.textContent !== alert) ui.alert.textContent = alert;

    const state = !online ? 'offline' : pending ? 'approval' : running ? 'running'
      : limited ? 'limited' : actionError ? 'error' : 'idle';
    ui.orbit.dataset.state = state;
    const presence = {
      offline: 'Desconectado', approval: 'Aguardando aprovação', running: 'Em execução',
      limited: 'Limite atingido', error: 'Falha na execução', idle: 'Disponível',
    };
    setStatus(ui.presence, state, presence[state]);
    const name = projectName(thread);
    ui.title.textContent = name;
    ui.title.title = name;
    ui.context.textContent = ['Codex local', thread?.archived && 'Arquivada', thread?.model].filter(Boolean).join(' · ');
    const preview = entries[index];
    const previewName = preview ? projectName(preview) : 'Conversas do Codex';
    ui.label.textContent = previewName;
    ui.openOrbitThread.title = preview ? `Abrir conversa de ${previewName} no chat` : previewName;
    if (preview) ui.openOrbitThread.setAttribute('aria-label', ui.openOrbitThread.title);
    else ui.openOrbitThread.removeAttribute('aria-label');
    ui.openOrbitThread.disabled = !preview || !online || writing;
    ui.position.textContent = index < 0 ? 'Conversas do Codex' : `${index + 1} de ${entries.length}${cursor ? '+' : ''}`;
    const alternate = entries.length > (index < 0 ? 0 : 1);
    const canNavigate = online && !writing && (alternate || Boolean(cursor));
    ui.previous.disabled = !canNavigate;
    ui.next.disabled = !canNavigate;
    ui.newThread.disabled = !online || writing;
    ui.stop.hidden = !currentTurn || Boolean(thread?.archived);
    ui.stop.disabled = !online || !currentTurn || thread?.archived || stopping.has(selectedId);
    ui.input.readOnly = Boolean(thread?.archived);
    submit.disabled = !online || writing || thread?.archived || thread?.loading || running || !ui.input.value.trim();
    if (ui.projectDialog.open) {
      for (const row of projectView?.threadRows ?? []) row.disabled = !online || writing;
    }
    renderTabs();
    renderHistory(entries);
    renderTranscript(thread, records);
  }

  function scheduleRender() {
    if (!frame) frame = requestAnimationFrame(render);
  }

  async function loadThread(state) {
    if (state.fresh || state.loading) return;
    state.loading = true;
    state.loadError = '';
    state.decisionsError = '';
    const at = version;
    const startedIn = generation;
    scheduleRender();
    const [history, decisions] = await Promise.allSettled([
      rpc('thread/read', { threadId: state.id, includeTurns: true }),
      request(decisionsPath(state.id)),
    ]);
    state.loading = false;
    if (startedIn !== generation) {
      if (online && state.id === selectedId) void loadThread(state);
      scheduleRender();
      return;
    }
    if (history.status === 'fulfilled') applyHistory(history.value.thread, at);
    else state.loadError = `Histórico indisponível · ${history.reason.message}`;
    if (decisions.status === 'fulfilled') decisions.value.forEach(saveApproval);
    else state.decisionsError = `Decisões indisponíveis · ${decisions.reason.message}`;
    scheduleRender();
  }

  function select(id) {
    if (id !== selectedId) {
      drafts.set(selectedId, ui.input.value);
      selectedId = id;
      ui.input.value = drafts.get(id) ?? '';
      actionError = '';
    }
    if (id && online) void loadThread(threadState(id));
    scheduleRender();
  }

  function storeTabs() {
    const tabs = openIds.map(id => ({ id, archived: Boolean(threads.get(id)?.archived) }));
    try {
      localStorage.setItem(tabsKey, JSON.stringify({ tabs, selectedId }));
    } catch {}
  }

  function hasTabSpace(id, warning = ui.tabWarning) {
    if (openIds.includes(id) || openIds.length < tabLimit) return true;
    if (warning.textContent !== tabLimitMessage) warning.textContent = tabLimitMessage;
    return false;
  }

  function openThread(id) {
    if (!openIds.includes(id)) openIds.push(id);
    openPreviewOnChat = false;
    ui.tabWarning.textContent = '';
    ui.projectTabWarning.textContent = '';
    select(id);
    storeTabs();
  }

  function closeThread(id) {
    openIds = openIds.filter(openId => openId !== id);
    if (id === selectedId) select(openIds[0] ?? null);
    ui.tabWarning.textContent = '';
    ui.projectTabWarning.textContent = '';
    storeTabs();
    renderTabs();
    const selectedTab = ui.tabs.querySelector('.atlas-tab-select[aria-pressed="true"]');
    (selectedTab ?? ui.input).focus();
    scheduleRender();
  }

  function maybeOpenOrbitPreview() {
    if (openPreviewOnChat && online && !writing && !openIds.length && threads.get(orbitId)?.listed) openThread(orbitId);
  }

  function archivedFromPath(path) {
    if (typeof path !== 'string') return undefined;
    if (/[\\/]archived_sessions[\\/][^\\/]+$/i.test(path)) return true;
    if (/[\\/]sessions[\\/]\d{4}[\\/]\d{2}[\\/]\d{2}[\\/][^\\/]+$/i.test(path)) return false;
    return undefined;
  }

  function updateArchived(thread, archived, at = version) {
    if (thread.archiveAt > at) return;
    const changed = thread.archived !== archived;
    thread.archived = archived;
    thread.archiveAt = at;
    thread.listed = !archived;
    if (changed && openIds.includes(thread.id)) storeTabs();
  }

  async function getThreadPage(nextCursor = null) {
    const at = version;
    const startedIn = generation;
    const result = await rpc('thread/list', {
      cursor: nextCursor,
      limit: 50,
      sortKey: 'created_at',
      sourceKinds: ['cli', 'vscode', 'appServer'],
    });
    if (startedIn !== generation) return;
    for (const thread of result.data) {
      const state = threadState(thread.id);
      applyMeta(state, thread, at);
      updateArchived(state, false, at);
    }
    cursor = result.nextCursor === nextCursor ? null : result.nextCursor;
  }

  function loadNextThreadPage() {
    if (!nextPagePromise) {
      historyError = '';
      nextPagePromise = getThreadPage(cursor).finally(() => {
        nextPagePromise = undefined;
        scheduleRender();
      });
      scheduleRender();
    }
    return nextPagePromise;
  }

  async function refreshAccount() {
    const startedIn = generation;
    const revision = rateRevision;
    const results = await Promise.allSettled([rpc('account/read'), rpc('account/rateLimits/read')]);
    if (startedIn !== generation) return;
    const [identity, rates] = results;
    if (identity.status === 'fulfilled') {
      accountKnown = true;
      account = identity.value.account;
    }
    if (rateRevision === revision) {
      rateError = rates.status === 'rejected';
      rateLimits = rateError ? undefined : rates.value.rateLimitsByLimitId?.codex ?? rates.value.rateLimits;
    }
    scheduleRender();
  }

  function retryConnection() {
    clearTimeout(reconnectTimer);
    if (transportOpen) reconnectTimer = setTimeout(refresh, 5000);
  }

  async function restoreTabs(startedIn) {
    if (!savedTabs) return;
    const entries = new Map();
    for (const entry of savedTabs.tabs) {
      if (typeof entry?.id === 'string' && entry.id) entries.set(entry.id, entry);
      if (entries.size === tabLimit) break;
    }
    const valid = await Promise.allSettled([...entries.values()].map(async ({ id, archived }) => {
      if (threads.get(id)?.listed) return id;
      const at = version;
      const { thread } = await rpc('thread/read', { threadId: id });
      if (startedIn !== generation || thread.id !== id) return null;
      const state = threadState(id);
      applyMeta(state, thread, at);
      updateArchived(state, archivedFromPath(thread.path) ?? (archived === true), at);
      return id;
    }));
    if (!transportOpen || startedIn !== generation) return;
    openIds = valid.flatMap(result => result.status === 'fulfilled' && result.value ? [result.value] : []);
    const id = openIds.includes(savedTabs.selectedId) ? savedTabs.selectedId : openIds[0];
    savedTabs = undefined;
    select(id ?? null);
    storeTabs();
  }

  function refresh() {
    if (refreshPromise || !transportOpen) return;
    checking = !online;
    historyError = '';
    const startedIn = generation;
    scheduleRender();
    refreshPromise = (async () => {
      try {
        await getThreadPage();
        if (!transportOpen || startedIn !== generation) return;
        await restoreTabs(startedIn);
        if (!transportOpen || startedIn !== generation) return;
        online = true;
        connectionError = '';
        void loadProjects().catch(() => {});
        if (legacySelection && threads.get(legacySelection)?.listed) orbitId = legacySelection;
        legacySelection = null;
        if (!threads.get(orbitId)?.listed) orbitId = orderedThreads()[0]?.id ?? null;
        select(selectedId);
        if (ui.orbit.classList.contains('atlas-chat-open')) maybeOpenOrbitPreview();
        void refreshAccount();
      } catch (error) {
        if (!transportOpen) return;
        online = false;
        historyError = `Conversas indisponíveis · ${error.message}`;
        connectionError = error.message;
        retryConnection();
      } finally {
        checking = false;
        refreshPromise = null;
        if (startedIn !== generation && !online) retryConnection();
        scheduleRender();
      }
    })();
  }

  function disconnect(message) {
    online = false;
    checking = false;
    connectionError = message;
    generation += 1;
    for (const [key, record] of approvals) {
      if (!record.resolved) approvals.delete(key);
    }
    for (const thread of threads.values()) thread.fresh = false;
    retryConnection();
    scheduleRender();
  }

  function onEvent({ method, params = {}, id }) {
    version += 1;
    switch (method) {
      case 'atlas/connected':
        clearTimeout(reconnectTimer);
        if (!online) refresh();
        return;
      case 'atlas/disconnected':
        disconnect(params.message || 'O Codex App Server foi desconectado.');
        return;
      case 'account/updated':
        void refreshAccount();
        return;
      case 'account/rateLimits/updated':
        if (params.rateLimits?.limitId && params.rateLimits.limitId !== 'codex') return;
        rateRevision += 1;
        rateLimits = params.rateLimits;
        rateError = false;
        break;
      case 'atlas/approvalDecided':
        saveApproval(params);
        break;
      case 'serverRequest/resolved':
        for (const record of approvals.values()) {
          if (record.id === params.requestId && record.params.threadId === params.threadId) record.resolved = true;
        }
        break;
      case 'thread/started': {
        const thread = threadState(params.thread.id);
        applyMeta(thread, params.thread);
        updateArchived(thread, false);
        break;
      }
      case 'thread/archived':
      case 'thread/unarchived': {
        const thread = threads.get(params.threadId);
        if (thread) updateArchived(thread, method === 'thread/archived');
        break;
      }
      case 'thread/status/changed': {
        const thread = threadState(params.threadId);
        thread.status = params.status.type;
        thread.statusAt = version;
        break;
      }
      case 'turn/started':
        applyTurn(threadState(params.threadId), params.turn, version);
        break;
      case 'turn/completed':
        applyTurn(threadState(params.threadId), params.turn, version);
        for (const record of approvals.values()) {
          if (record.params.threadId === params.threadId && record.params.turnId === params.turn.id) record.resolved = true;
        }
        break;
      case 'item/started':
      case 'item/completed': {
        const thread = threadState(params.threadId);
        const turn = turnState(thread, params.turnId);
        turn.updatedAt = version;
        setItem(turn, params.item, method === 'item/completed');
        break;
      }
      case 'item/agentMessage/delta':
      case 'item/plan/delta': {
        const turn = turnState(threadState(params.threadId), params.turnId);
        turn.updatedAt = version;
        const item = turn.items.get(params.itemId);
        if (!item?.final) {
          const type = method === 'item/plan/delta' ? 'plan' : 'agentMessage';
          setItem(turn, { id: params.itemId, type, text: (item?.text ?? '') + params.delta }, false);
        }
        break;
      }
      case 'error':
        if (params.threadId === selectedId && !params.willRetry) actionError = errorMessage(params.error, 'O Codex informou um erro.');
        break;
      default:
        if (id === undefined || !approvalTitles[method]) return;
        saveApproval({ id, method, params });
    }
    scheduleRender();
  }

  async function createThread(transferDraft = false) {
    const startedIn = generation;
    const { thread, model } = await rpc('thread/start');
    if (!online || startedIn !== generation) throw new Error('A conexão mudou. Tente novamente.');
    const state = threadState(thread.id);
    applyMeta(state, thread);
    state.listed = true;
    state.fresh = true;
    state.resumedIn = generation;
    state.model = model;
    if (transferDraft) drafts.set(thread.id, ui.input.value);
    openThread(thread.id);
    if (transferDraft) drafts.delete(null);
    return state;
  }

  async function withWrite(operation) {
    if (!online || writing) return;
    writing = true;
    actionError = '';
    scheduleRender();
    try {
      await operation();
    } catch (error) {
      actionError = error.message;
    } finally {
      writing = false;
      scheduleRender();
    }
  }

  async function decide(key, decision) {
    const record = approvals.get(key);
    if (!online || !record || record.resolved || resolving.has(key)
      || record.params.threadId !== selectedId || threads.get(selectedId)?.archived) return;
    resolving.add(key);
    actionError = '';
    scheduleRender();
    try {
      const { threadId, turnId, itemId } = record.params;
      saveApproval(await request('/api/approval', { id: record.id, decision, threadId, turnId, itemId }));
    } catch (error) {
      if (record.params.threadId === selectedId) actionError = error.message;
    } finally {
      resolving.delete(key);
      scheduleRender();
    }
  }

  async function step(delta) {
    if (!online || writing) return;
    pendingSteps += delta;
    if (orbitMoving) return;
    orbitMoving = true;
    try {
      while (pendingSteps && online && !writing) {
        const entries = orderedThreads();
        if (!entries.length) break;
        const index = entries.findIndex(thread => thread.id === orbitId);
        const target = (index < 0 && pendingSteps < 0 ? 0 : index) + pendingSteps;
        if (cursor && (target < 0 || target >= entries.length)) {
          const anchor = orbitId;
          const startedIn = generation;
          await loadNextThreadPage();
          if (anchor !== orbitId || startedIn !== generation) break;
          continue;
        }
        const direction = Math.sign(pendingSteps);
        const count = Math.abs(pendingSteps);
        pendingSteps = 0;
        const wrapped = ((target % entries.length) + entries.length) % entries.length;
        if (entries[wrapped].id === orbitId) break;
        orbitId = entries[wrapped].id;
        window.dispatchEvent(new CustomEvent('atlas-rotate', { detail: { direction, count } }));
      }
    } catch (error) {
      historyError = error.message;
    } finally {
      pendingSteps = 0;
      orbitMoving = false;
      scheduleRender();
    }
  }

  stream.addEventListener('open', () => {
    transportOpen = true;
    refresh();
  });
  stream.addEventListener('error', () => {
    transportOpen = false;
    disconnect('Conexão com o Atlas perdida. Reconectando…');
  });
  stream.addEventListener('message', event => {
    try { onEvent(JSON.parse(event.data)); } catch (error) { console.error(error); }
  });
  ui.openProjects.addEventListener('click', () => void openProjectCatalog());
  ui.openSettings.addEventListener('click', () => void openProjectCatalog(true));
  ui.projectOrbit.addEventListener('click', event => {
    const node = event.target.closest('button[data-project-id]');
    const project = projects.get(node?.dataset.projectId);
    if (project) void openProjectHistory(project);
  });
  ui.projectDialog.addEventListener('close', () => {
    if (!ui.projectDialog.open) {
      projectView = undefined;
      ui.projectTabWarning.textContent = '';
    }
  });
  ui.orbit.addEventListener('atlas-chat-opened', maybeOpenOrbitPreview);
  ui.openOrbitThread.addEventListener('click', () => {
    if (!online || writing || !threads.get(orbitId)?.listed) return;
    if (hasTabSpace(orbitId)) openThread(orbitId);
    ui.orbit.dispatchEvent(new CustomEvent('atlas-open-chat'));
  });
  ui.tabs.addEventListener('click', event => {
    const button = event.target.closest('button');
    const id = button?.closest('[data-thread-id]')?.dataset.threadId;
    if (writing || !openIds.includes(id)) return;
    if (button.classList.contains('atlas-tab-close')) closeThread(id);
    else openThread(id);
  });
  ui.history.addEventListener('click', async event => {
    const entry = event.target.closest('button');
    if (!entry || !online || writing) return;
    if (entry.dataset.threadId && hasTabSpace(entry.dataset.threadId)) openThread(entry.dataset.threadId);
    if (!entry.dataset.more || !cursor || nextPagePromise) return;
    try {
      await loadNextThreadPage();
    } catch (error) {
      historyError = error.message;
      scheduleRender();
    }
  });
  ui.transcript.addEventListener('click', event => {
    const button = event.target.closest('button[data-approval]');
    if (button && !button.disabled) void decide(button.dataset.approval, button.dataset.decision);
  });
  ui.orbit.addEventListener('atlas-step', event => {
    const { direction, count = 1 } = event.detail ?? {};
    if ((direction === -1 || direction === 1) && Number.isSafeInteger(count) && count > 0) {
      void step(direction * count);
    }
  });
  ui.previous.addEventListener('click', () => step(-1));
  ui.next.addEventListener('click', () => step(1));
  ui.input.addEventListener('input', () => {
    const thread = threads.get(selectedId);
    submit.disabled = !online || writing || thread?.archived || thread?.loading || !!activeTurn(thread)
      || thread?.status === 'active' || !ui.input.value.trim();
  });
  ui.newThread.addEventListener('click', () => {
    if (!online || writing || !hasTabSpace(null)) return;
    void withWrite(async () => {
      await createThread();
      ui.input.focus();
    });
  });
  ui.form.addEventListener('submit', event => {
    event.preventDefault();
    const previous = threads.get(selectedId);
    const input = ui.input.value;
    if (!input.trim() || previous?.archived || previous?.loading || activeTurn(previous) || previous?.status === 'active') return;
    if (!previous && !hasTabSpace(null)) return;
    void withWrite(async () => {
      const thread = previous || await createThread(true);
      if (thread.resumedIn !== generation) {
        const at = version;
        const startedIn = generation;
        const { thread: resumed, model, atlasTurnModel } = await rpc('thread/resume', { threadId: thread.id });
        if (!online || startedIn !== generation) throw new Error('A conexão mudou. Tente enviar novamente.');
        applyHistory(resumed, at);
        thread.resumedIn = generation;
        thread.model = atlasTurnModel || model;
        if (activeTurn(thread) || thread.status === 'active') throw new Error('Já existe uma resposta em execução nesta conversa.');
      }
      if (thread.archived) throw new Error('A conversa está arquivada.');
      const at = version;
      const startedIn = generation;
      const { turn } = await rpc('turn/start', { threadId: thread.id, input: [{ type: 'text', text: input, text_elements: [] }] });
      if (ui.input.value === input) ui.input.value = '';
      thread.fresh = false;
      if (startedIn === generation) applyTurn(thread, turn, at);
      else if (online) void loadThread(thread);
    });
  });
  ui.stop.addEventListener('click', async () => {
    const thread = threads.get(selectedId);
    const turn = activeTurn(thread);
    if (!online || !turn || thread?.archived || stopping.has(thread.id)) return;
    stopping.add(thread.id);
    actionError = '';
    scheduleRender();
    try {
      await rpc('turn/interrupt', { threadId: thread.id, turnId: turn.id });
    } catch (error) {
      if (thread.id === selectedId) actionError = error.message;
    } finally {
      stopping.delete(thread.id);
      scheduleRender();
    }
  });
  scheduleRender();
})();
