import { execFile, spawn } from 'node:child_process';
import { appendFile, mkdir, readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { createServer } from 'node:http';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

async function resolveCodexBinary() {
  if (process.env.ATLAS_CODEX) return process.env.ATLAS_CODEX;
  const desktopRuntime = process.env.CODEX_APP_RUNTIME_CLI_PATH;
  if (desktopRuntime && existsSync(desktopRuntime)) return desktopRuntime;
  if (process.platform !== 'win32') return 'codex';

  const systemRoot = process.env.SystemRoot || 'C:\\Windows';
  const powershell = join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  const command = [
    '$package = Get-AppxPackage -Name OpenAI.Codex -ErrorAction SilentlyContinue | Sort-Object Version -Descending | Select-Object -First 1',
    'if ($package) { Join-Path $package.InstallLocation "app\\resources\\codex.exe" }',
  ].join('\n');
  try {
    const { stdout } = await promisify(execFile)(powershell, ['-NoProfile', '-NonInteractive', '-Command', command], {
      timeout: 5000,
      windowsHide: true,
    });
    const installedRuntime = stdout.trim();
    if (installedRuntime && existsSync(installedRuntime)) return installedRuntime;
  } catch {
    // A standalone Codex CLI installation can still work through PATH.
  }
  return 'codex';
}

const workspace = fileURLToPath(new URL('.', import.meta.url));
const journalDirectory = join(workspace, '.atlas');
const journalPath = join(journalDirectory, 'approvals.jsonl');
const port = Number(process.env.ATLAS_PORT ?? 8899);
if (!Number.isInteger(port) || port < 1 || port > 65535) {
  throw new Error('ATLAS_PORT precisa ser uma porta entre 1 e 65535.');
}
const codexBinary = await resolveCodexBinary();

const assets = new Map([
  ['/', ['atlas.html', 'text/html; charset=utf-8']],
  ['/atlas.js', ['atlas.js', 'text/javascript; charset=utf-8']],
  ['/plano', ['ATLAS-MVP.html', 'text/html; charset=utf-8']],
]);
const approvalMethods = new Set([
  'item/commandExecution/requestApproval',
  'item/fileChange/requestApproval',
  'item/permissions/requestApproval',
]);
const clients = new Set();
const maxBodyBytes = 256 * 1024;
const maxQueuedEventBytes = 2 * 1024 * 1024;
let connection;
let lastDisconnect;
let journalWrites = Promise.resolve();

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

function writeEventStream(client, data) {
  if (client.writableLength > maxQueuedEventBytes) client.destroy();
  else client.write(data);
}

function sendEvent(client, event) {
  writeEventStream(client, `data: ${JSON.stringify(event)}\n\n`);
}

function broadcast(event) {
  for (const client of clients) sendEvent(client, event);
}

function disconnect(session, message) {
  if (connection !== session) return;
  connection = undefined;
  lastDisconnect = { method: 'atlas/disconnected', params: { message } };
  for (const { reject, timer } of session.calls.values()) {
    clearTimeout(timer);
    reject(new HttpError(503, message));
  }
  session.calls.clear();
  session.approvals.clear();
  session.turns.clear();
  session.child.kill();
  broadcast(lastDisconnect);
}

function writeMessage(session, message) {
  return new Promise((resolve, reject) => {
    if (connection !== session || !session.child.stdin.writable) {
      reject(new HttpError(503, 'A conexão com o Codex foi encerrada.'));
      return;
    }
    session.child.stdin.write(`${JSON.stringify(message)}\n`, error => {
      if (!error) {
        resolve();
        return;
      }
      disconnect(session, 'A conexão com o Codex foi encerrada.');
      reject(new HttpError(503, 'A conexão com o Codex foi encerrada.'));
    });
  });
}

function callCodex(session, method, params) {
  return new Promise((resolve, reject) => {
    const id = ++session.id;
    const timer = setTimeout(() => {
      session.calls.delete(id);
      reject(new HttpError(504, `O Codex demorou para responder a ${method}.`));
    }, 45_000);
    session.calls.set(id, { resolve, reject, timer });
    const request = params === undefined ? { id, method } : { id, method, params };
    writeMessage(session, request).catch(error => {
      clearTimeout(timer);
      session.calls.delete(id);
      reject(error);
    });
  });
}

function handleServerRequest(session, request) {
  const { id, method, params } = request;
  if (approvalMethods.has(method)) {
    session.approvals.set(id, { request });
    broadcast(request);
    return;
  }

  // The MVP has no form editor or delegated tool host.
  if (method === 'mcpServer/elicitation/request') {
    return writeMessage(session, { id, result: { action: 'cancel', content: null, _meta: null } });
  }
  if (method === 'item/tool/requestUserInput') {
    return writeMessage(session, { id, result: { answers: {} } });
  }
  return writeMessage(session, {
    id,
    error: { code: -32601, message: `O Atlas não oferece suporte a ${method}.` },
  });
}

function trackedTurn(session, turnId) {
  if (!session.turns.has(turnId)) {
    session.turns.set(turnId, { items: new Map(), decisions: new Set() });
  }
  return session.turns.get(turnId);
}

function saveApproval(record) {
  const write = journalWrites.then(async () => {
    await mkdir(journalDirectory, { recursive: true });
    // Start on a fresh line even if the previous append was interrupted.
    await appendFile(journalPath, `\n${JSON.stringify(record)}`, { encoding: 'utf8', flush: true });
  });
  journalWrites = write.catch(() => {});
  return write;
}

function updateApproval(pending, updates) {
  const record = { ...pending.record, ...updates };
  pending.record = record;
  saveApproval(record)
    .then(() => {
      if (pending.delivered) broadcast({ method: 'atlas/approvalDecided', params: record });
    })
    .catch(() => console.error('Não foi possível registrar o estado de uma aprovação em .atlas/approvals.jsonl.'));
}

function trackApprovalState(session, { method, params }) {
  if (method === 'item/started' || method === 'item/completed') {
    const { id, type, status, command, cwd, changes } = params.item;
    if (type !== 'commandExecution' && type !== 'fileChange') return;
    const item = { id, type, status, command, cwd, changes: changes?.map(({ path, kind }) => ({ path, kind })) };
    const turn = trackedTurn(session, params.turnId);
    turn.items.set(id, item);
    for (const pending of turn.decisions) {
      if (pending.record.params.itemId === id) updateApproval(pending, { item });
    }
  } else if (method === 'turn/completed') {
    const { id, status } = params.turn;
    for (const pending of session.turns.get(id)?.decisions ?? []) {
      updateApproval(pending, { turnStatus: status });
    }
    session.turns.delete(id);
  }
}

function receiveMessage(session, line) {
  if (connection !== session || !line.trim()) return;
  let message;
  try {
    message = JSON.parse(line);
    if (!message || typeof message !== 'object' || Array.isArray(message)) throw new Error();
  } catch {
    disconnect(session, 'O App Server retornou dados inválidos.');
    return;
  }

  if (typeof message.method === 'string') {
    if (Object.hasOwn(message, 'id')) {
      handleServerRequest(session, message)?.catch(() => {
        disconnect(session, 'A conexão com o Codex foi encerrada.');
      });
      return;
    }

    const { params } = message;
    trackApprovalState(session, message);
    if (message.method === 'serverRequest/resolved') {
      session.approvals.delete(params?.requestId);
    } else if (message.method === 'turn/completed') {
      for (const [id, { request }] of session.approvals) {
        if (request.params?.threadId === params?.threadId && request.params?.turnId === params?.turn?.id) {
          session.approvals.delete(id);
        }
      }
    }
    broadcast(message);
    return;
  }

  const call = session.calls.get(message.id);
  if (!call) return;
  clearTimeout(call.timer);
  session.calls.delete(message.id);
  if (message.error) {
    call.reject(new HttpError(502, message.error.message ?? 'O Codex rejeitou a solicitação.'));
  } else {
    call.resolve(message.result);
  }
}

async function initialize(session) {
  try {
    await callCodex(session, 'initialize', {
      clientInfo: { name: 'atlas', title: 'Atlas', version: '0.1.0' },
      capabilities: { experimentalApi: true, requestAttestation: false },
    });
    await writeMessage(session, { method: 'initialized' });
    lastDisconnect = undefined;
    broadcast({ method: 'atlas/connected', params: {} });
  } catch (error) {
    disconnect(session, 'O Atlas não conseguiu inicializar o Codex App Server. Confira se o Codex inicia normalmente.');
    throw error;
  }
}

async function connect() {
  if (!connection) {
    const child = spawn(codexBinary, ['app-server', '--listen', 'stdio://'], {
      cwd: workspace,
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'ignore'],
    });
    const session = {
      child,
      id: 0,
      calls: new Map(),
      approvals: new Map(),
      turns: new Map(),
      threadModels: new Map(),
    };
    connection = session;
    child.once('error', error => {
      const message = error.code === 'ENOENT'
        ? 'Codex não encontrado. Confira o PATH ou defina ATLAS_CODEX com o caminho de codex.exe.'
        : 'Falha ao iniciar o Codex App Server. Confira se o Codex inicia normalmente.';
      disconnect(session, message);
    });
    child.once('close', (code, signal) => {
      disconnect(session, `O Codex App Server foi encerrado (${code ?? signal}). Tente novamente.`);
    });
    child.stdin.on('error', () => {
      disconnect(session, 'A conexão com o Codex foi encerrada.');
    });
    createInterface({ input: child.stdout }).on('line', line => receiveMessage(session, line));
    session.ready = initialize(session);
  }
  const session = connection;
  await session.ready;
  return session;
}

function requiredString(value, field) {
  if (typeof value !== 'string' || !value.trim()) {
    throw new HttpError(400, `Informe um valor válido para ${field}.`);
  }
  return value;
}

async function workspaceConfig(session) {
  const { config } = await callCodex(session, 'config/read', { cwd: workspace });
  const overrides = { cwd: workspace, approvalPolicy: config.approval_policy ?? 'on-request' };
  // Allow configured read-only and named permission profiles to retain their restrictions.
  if (!config.default_permissions && config.sandbox_mode !== 'read-only') {
    overrides.sandbox = 'workspace-write';
  }
  if (config.model) {
    const fallback = await modelFallback(session, config.model, config.model_reasoning_effort);
    if (fallback) {
      overrides.model = fallback.model;
      overrides.config = { model_reasoning_effort: fallback.effort };
    }
  }
  return overrides;
}

async function modelFallback(session, model, reasoningEffort) {
  const { data } = await callCodex(session, 'model/list', { limit: 100, includeHidden: false });
  if (data.some(entry => entry.model === model)) return;
  const fallback = data.find(entry => entry.isDefault) ?? data[0];
  if (fallback) {
    const effortSupported = fallback.supportedReasoningEfforts.some(option => option.reasoningEffort === reasoningEffort);
    return {
      model: fallback.model,
      effort: effortSupported ? reasoningEffort : fallback.defaultReasoningEffort,
    };
  }
}

function rpcRequest(body) {
  const { method, params = {} } = body;
  if (!params || typeof params !== 'object' || Array.isArray(params)) {
    throw new HttpError(400, 'Parâmetros inválidos.');
  }
  switch (method) {
    case 'account/read':
      return { method, params: { refreshToken: false } };
    case 'account/rateLimits/read':
      return { method };
    case 'project/list': {
      const { cursor, limit } = params;
      return { method, params: { cursor, limit } };
    }
    case 'thread/list': {
      const { cursor, limit, sortKey, sortDirection, archived, cwd, projectId, searchTerm, sourceKinds, useStateDbOnly } = params;
      // Native filtering distinguishes an omitted projectId from null (unassigned).
      return { method, params: { cursor, limit, sortKey, sortDirection, archived, cwd, projectId, searchTerm, sourceKinds, useStateDbOnly } };
    }
    case 'thread/start':
      return { method, params: {} };
    case 'thread/read':
      return { method, params: { threadId: requiredString(params.threadId, 'threadId'), includeTurns: true } };
    case 'thread/resume':
      return { method, params: { threadId: requiredString(params.threadId, 'threadId') } };
    case 'turn/start':
      if (!Array.isArray(params.input) || !params.input.length) {
        throw new HttpError(400, 'Digite uma mensagem para o Codex.');
      }
      return {
        method,
        params: {
          threadId: requiredString(params.threadId, 'threadId'),
          input: params.input.map(item => {
            if (item?.type !== 'text') throw new HttpError(400, 'O Atlas recebe mensagens de texto.');
            return { type: 'text', text: requiredString(item.text, 'texto'), text_elements: [] };
          }),
        },
      };
    case 'turn/interrupt':
      return {
        method,
        params: {
          threadId: requiredString(params.threadId, 'threadId'),
          turnId: requiredString(params.turnId, 'turnId'),
        },
      };
    default:
      throw new HttpError(400, 'Método indisponível no Atlas.');
  }
}

async function rpc(body) {
  const { method, params } = rpcRequest(body);
  const session = await connect();
  if (method === 'thread/start') {
    Object.assign(params, await workspaceConfig(session));
  }
  if (method === 'turn/start') {
    Object.assign(params, session.threadModels.get(params.threadId));
  }
  const result = await callCodex(session, method, params);
  if (method === 'project/list') {
    return {
      data: result.data.map(({ id, name, roots, position }) => ({
        id,
        name,
        roots: roots.map(({ path }) => ({ path })),
        position,
      })),
      nextCursor: result.nextCursor,
    };
  }
  if (method === 'thread/resume') {
    const fallback = await modelFallback(session, result.model, result.reasoningEffort);
    if (fallback) {
      session.threadModels.set(params.threadId, fallback);
      result.atlasTurnModel = fallback.model;
    } else {
      session.threadModels.delete(params.threadId);
    }
  }
  if (method === 'account/read' && result.account) {
    const { type, planType } = result.account;
    result.account = { type, planType };
  }
  return result;
}

function approvalResponse(request, decision) {
  if (request.method === 'item/permissions/requestApproval') {
    // The protocol's narrowest permission scope is the current turn.
    return {
      permissions: decision === 'accept' ? request.params.permissions : {},
      scope: 'turn',
    };
  }
  const available = request.params?.availableDecisions;
  if (!Array.isArray(available) || available.includes(decision)) return { decision };
  if (decision === 'decline' && available.includes('cancel')) return { decision: 'cancel' };
  throw new HttpError(400, 'O Codex não ofereceu essa decisão para esta solicitação.');
}

async function decideApproval({ id, decision, threadId, turnId, itemId }) {
  if (decision !== 'accept' && decision !== 'decline') {
    throw new HttpError(400, 'Escolha aprovar ou recusar a solicitação.');
  }
  const session = connection;
  const pending = session?.approvals.get(id);
  if (!pending || pending.record) throw new HttpError(409, 'Esta solicitação já foi encerrada.');
  const { request } = pending;
  const scope = request.params;
  if (scope.threadId !== threadId || scope.turnId !== turnId || scope.itemId !== itemId) {
    throw new HttpError(409, 'Esta solicitação pertence a outra ação do Codex. Atualize a conversa.');
  }
  const result = approvalResponse(request, decision);
  const turn = trackedTurn(session, request.params.turnId);
  pending.record = {
    ...request,
    decision,
    decidedAt: new Date().toISOString(),
    item: turn.items.get(request.params.itemId),
  };
  try {
    await saveApproval(pending.record);
  } catch {
    delete pending.record;
    throw new HttpError(500, 'Não foi possível registrar a decisão em .atlas/approvals.jsonl.');
  }
  if (session.approvals.get(id) !== pending) {
    throw new HttpError(409, 'A decisão foi registrada, mas a solicitação já foi encerrada pelo Codex.');
  }
  turn.decisions.add(pending);
  try {
    await writeMessage(session, { id, result });
  } catch {
    throw new HttpError(503, 'A decisão foi registrada. A conexão caiu antes de encaminhá-la ao Codex.');
  }
  pending.delivered = true;
  broadcast({ method: 'atlas/approvalDecided', params: pending.record });
  return pending.record;
}

async function approvalHistory(threadId) {
  try {
    const contents = await readFile(journalPath, 'utf8');
    const records = new Map();
    for (const line of contents.split('\n')) {
      if (!line) continue;
      try {
        const record = JSON.parse(line);
        if (record?.params?.threadId === threadId) {
          const key = JSON.stringify([record.params.turnId, record.params.itemId, record.id, record.decidedAt]);
          records.set(key, record);
        }
      } catch {
        // A crash can leave an incomplete final line.
      }
    }
    return [...records.values()];
  } catch (error) {
    if (error.code === 'ENOENT') return [];
    throw error;
  }
}

async function readJson(request) {
  if (request.headers['content-type']?.split(';')[0].trim().toLowerCase() !== 'application/json') {
    throw new HttpError(415, 'Envie o corpo em JSON.');
  }
  if (Number(request.headers['content-length']) > maxBodyBytes) {
    throw new HttpError(413, 'A mensagem excede o tamanho permitido.');
  }
  let size = 0;
  const chunks = [];
  for await (const chunk of request.iterator({ destroyOnReturn: false })) {
    size += chunk.length;
    if (size > maxBodyBytes) throw new HttpError(413, 'A mensagem excede o tamanho permitido.');
    chunks.push(chunk);
  }
  try {
    const value = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    if (value && !Array.isArray(value) && typeof value === 'object') return value;
  } catch {
    // Return the same error for malformed JSON and unsupported top-level values.
  }
  throw new HttpError(400, 'Corpo JSON inválido.');
}

function sendJson(response, status, body) {
  response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  response.end(JSON.stringify(body));
}

function openEvents(response) {
  response.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    Connection: 'keep-alive',
  });
  response.write(': Atlas\n\n');
  clients.add(response);
  response.on('close', () => clients.delete(response));
  if (lastDisconnect) sendEvent(response, lastDisconnect);
  for (const { request, record } of connection?.approvals.values() ?? []) {
    if (!record) sendEvent(response, request);
  }
}

async function handleHttp(request, response) {
  const { host, origin, 'sec-fetch-site': fetchSite } = request.headers;
  if (host !== `127.0.0.1:${port}` && host !== `localhost:${port}`) {
    throw new HttpError(403, 'O Atlas só aceita conexões locais.');
  }
  if ((origin && origin !== `http://${host}`) || (fetchSite && fetchSite !== 'same-origin' && fetchSite !== 'none')) {
    throw new HttpError(403, 'A solicitação precisa partir do Atlas.');
  }
  if (request.method === 'POST' && fetchSite && !origin) {
    throw new HttpError(403, 'A solicitação precisa partir do Atlas.');
  }
  if (!request.url.startsWith('/') || request.url.startsWith('//')) {
    throw new HttpError(400, 'Caminho inválido.');
  }
  const { pathname, searchParams } = new URL(request.url, `http://${host}`);
  if (request.method === 'GET') {
    if (pathname === '/api/events') return openEvents(response);
    if (pathname === '/api/approvals') {
      const threadId = requiredString(searchParams.get('threadId'), 'threadId');
      return sendJson(response, 200, { result: await approvalHistory(threadId) });
    }
    const asset = assets.get(pathname);
    if (asset) {
      const [filename, type] = asset;
      const contents = await readFile(join(workspace, filename));
      response.writeHead(200, { 'Content-Type': type });
      return response.end(contents);
    }
  }
  if (request.method === 'POST') {
    if (pathname === '/api/rpc') return sendJson(response, 200, { result: await rpc(await readJson(request)) });
    if (pathname === '/api/approval') {
      return sendJson(response, 200, { result: await decideApproval(await readJson(request)) });
    }
  }
  throw new HttpError(404, 'Página não encontrada.');
}

const server = createServer((request, response) => {
  response.setHeader('X-Content-Type-Options', 'nosniff');
  response.setHeader('X-Frame-Options', 'DENY');
  response.setHeader('Cache-Control', 'no-store');
  handleHttp(request, response).catch(error => {
    if (response.destroyed) return;
    const status = error.status ?? (error.code === 'ENOENT' ? 404 : 500);
    sendJson(response, status, { error: { message: error.status ? error.message : 'Erro local no Atlas.' } });
  });
});

const heartbeat = setInterval(() => {
  for (const client of clients) writeEventStream(client, ': Atlas\n\n');
}, 20_000);
heartbeat.unref();

function shutdown() {
  if (connection) disconnect(connection, 'O Atlas foi encerrado.');
  server.close();
  for (const client of clients) client.end();
}

process.once('SIGINT', shutdown);
process.once('SIGTERM', shutdown);
server.listen(port, '127.0.0.1', () => console.log(`Atlas em http://127.0.0.1:${port}`));
