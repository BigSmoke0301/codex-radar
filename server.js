'use strict';

/*
 * Codex Radar
 *
 * A deliberately small, dependency-free local dashboard.  The only source of
 * Codex data is the local app-server JSONL/JSON-RPC transport.  In particular,
 * this file never reads browser storage, cookies, auth files, or auth tokens.
 */

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { spawn, spawnSync, execFile } = require('node:child_process');
const { EventEmitter } = require('node:events');

const APP_SERVER_ARGS = ['app-server', '--listen', 'stdio://'];
const USAGE_URL = 'https://chatgpt.com/codex/settings/usage';
const DEFAULT_PORT = 3838;
const DEFAULT_REFRESH_MS = 3000;
const SYSTEM_SOUND_PLAYER = '/usr/bin/afplay';
const SYSTEM_SOUND_PATH = '/System/Library/Sounds/Glass.aiff';
// Keep the original one-shot Glass constants for callers that used the first
// version of Radar.  Strong alarms use a more noticeable built-in sound and
// speech, both of which are available on a stock macOS installation.
const STRONG_ALARM_SOUND_PLAYER = '/usr/bin/afplay';
const STRONG_ALARM_SOUND_PATH = '/System/Library/Sounds/Sosumi.aiff';
const STRONG_ALARM_SPEECH_PLAYER = '/usr/bin/say';
const WINDOWS_ALARM_FILE = 'alarm.wav';
const DEFAULT_ALARM_SECONDS = 24;
const TEST_ALARM_SECONDS = 6;
const MIN_ALARM_SECONDS = 5;
const MAX_ALARM_SECONDS = 60;
const ALARM_REPEAT_MS = 3500;
const ALARM_SPEECH = {
  completed: 'Codex 任务完成了，请查看结果',
  failed: 'Codex 任务失败了，请查看结果',
  interrupted: 'Codex 任务已中断，请查看结果',
};
const MAX_THREAD_PAGES = 8;
const MAX_THREADS = 400;
const MAX_ACTIVE_READS = 12;
// Keep refresh fan-out bounded.  SQLite supplies status/items for the rest;
// only this small set needs app-server detail calls.
const MAX_DETAIL_THREADS = 32;
const DEFAULT_STALE_AFTER_SECONDS = 30 * 60;
const DEFAULT_THREAD_HISTORY_DB = path.join(os.homedir(), '.codex', 'thread_history_1.sqlite');

const STATUS_LABELS = {
  active: '运行中',
  waitingOnApproval: '等待授权',
  waitingOnUserInput: '等待输入',
  systemError: '系统错误',
  completed: '已完成',
  failed: '失败',
  interrupted: '已中断',
  idle: '空闲',
  notLoaded: '未加载',
  stale: '可能已失联',
  unknown: '未知',
};

function finiteNumber(value) {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return null;
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function normalizeAlarmSeconds(value, fallback = DEFAULT_ALARM_SECONDS) {
  const parsed = finiteNumber(value);
  const safeFallback = finiteNumber(fallback) === null
    ? DEFAULT_ALARM_SECONDS
    : finiteNumber(fallback);
  if (parsed === null) return clamp(Math.round(safeFallback), MIN_ALARM_SECONDS, MAX_ALARM_SECONDS);
  return clamp(Math.round(parsed), MIN_ALARM_SECONDS, MAX_ALARM_SECONDS);
}

function toEpochSeconds(value) {
  const number = finiteNumber(value);
  if (number === null) return null;
  return number > 100000000000 ? number / 1000 : number;
}

function isoFromEpochSeconds(value) {
  const seconds = toEpochSeconds(value);
  if (seconds === null || seconds <= 0) return null;
  const date = new Date(seconds * 1000);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function compactWhitespace(value) {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

function redactSecrets(value) {
  return String(value || '')
    .replace(/Bearer\s+[A-Za-z0-9._~+\/-]+/gi, 'Bearer [已隐藏]')
    .replace(/\bsk-[A-Za-z0-9_-]+/g, 'sk-[已隐藏]')
    .replace(/((?:api[_-]?key|access[_-]?token|refresh[_-]?token|password|passwd|secret)\s*[=:]\s*)[^\s,;]+/gi, '$1[已隐藏]')
    .replace(/([?&](?:token|key|secret|password)=[^&\s]+)/gi, '$1[已隐藏]');
}

function stripMarkdown(value) {
  return compactWhitespace(redactSecrets(String(value || '')
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, ' ')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/^\s*[-*+]\s+/gm, '')
    .replace(/^\s*#+\s*/gm, '')));
}

function shortText(value, max = 180) {
  const text = stripMarkdown(value);
  if (text.length <= max) return text;
  return `${text.slice(0, Math.max(0, max - 1)).trimEnd()}…`;
}

function safeError(error) {
  const raw = error && error.message ? error.message : String(error || '未知错误');
  const safe = redactSecrets(raw).replace(/[\r\n]+/g, ' ').trim();
  return safe.slice(0, 240) || '未知错误';
}

function parseArgs(argv) {
  const options = {
    port: finiteNumber(process.env.CODEX_RADAR_PORT || process.env.PORT) || DEFAULT_PORT,
    host: process.env.CODEX_RADAR_HOST || '127.0.0.1',
    noOpen: false,
    noNotify: process.env.CODEX_RADAR_NO_NOTIFY === '1',
    noSound: process.env.CODEX_RADAR_NO_SOUND === '1',
    alarmSeconds: normalizeAlarmSeconds(process.env.CODEX_RADAR_ALARM_SECONDS),
    refreshMs: finiteNumber(process.env.CODEX_RADAR_REFRESH_MS) || DEFAULT_REFRESH_MS,
    staleAfterSeconds: finiteNumber(process.env.CODEX_RADAR_STALE_AFTER_SECONDS) || DEFAULT_STALE_AFTER_SECONDS,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--no-open') options.noOpen = true;
    else if (arg === '--no-notify') options.noNotify = true;
    else if (arg === '--no-sound') options.noSound = true;
    else if (arg === '--alarm-seconds' && argv[index + 1]) options.alarmSeconds = Number(argv[++index]);
    else if (arg.startsWith('--alarm-seconds=')) options.alarmSeconds = Number(arg.slice('--alarm-seconds='.length));
    else if (arg === '--port' && argv[index + 1]) options.port = Number(argv[++index]);
    else if (arg.startsWith('--port=')) options.port = Number(arg.slice('--port='.length));
    else if (arg === '--host' && argv[index + 1]) options.host = argv[++index];
    else if (arg.startsWith('--host=')) options.host = arg.slice('--host='.length);
    else if (arg === '--refresh-ms' && argv[index + 1]) options.refreshMs = Number(argv[++index]);
    else if (arg.startsWith('--refresh-ms=')) options.refreshMs = Number(arg.slice('--refresh-ms='.length));
    else if (arg === '--stale-after-seconds' && argv[index + 1]) options.staleAfterSeconds = Number(argv[++index]);
    else if (arg.startsWith('--stale-after-seconds=')) options.staleAfterSeconds = Number(arg.slice('--stale-after-seconds='.length));
    else if (arg === '--help' || arg === '-h') options.help = true;
  }

  if (!Number.isFinite(options.port) || options.port < 0 || options.port > 65535) options.port = DEFAULT_PORT;
  if (!Number.isFinite(options.refreshMs) || options.refreshMs < 500) options.refreshMs = DEFAULT_REFRESH_MS;
  if (!Number.isFinite(options.staleAfterSeconds) || options.staleAfterSeconds < 60) options.staleAfterSeconds = DEFAULT_STALE_AFTER_SECONDS;
  options.alarmSeconds = normalizeAlarmSeconds(options.alarmSeconds);
  return options;
}

function isRunnableFile(candidate, platform = process.platform, statSyncImpl = fs.statSync) {
  try {
    const stat = statSyncImpl(candidate);
    return stat.isFile() && (platform === 'win32' || (stat.mode & 0o111));
  } catch (_) {
    return false;
  }
}

function addVersionedWindowsCandidates(candidates, root, readdirSyncImpl = fs.readdirSync) {
  if (!root) return;
  let entries = [];
  try {
    entries = readdirSyncImpl(root, { withFileTypes: true });
  } catch (_) {
    return;
  }
  for (const entry of entries) {
    const name = typeof entry === 'string' ? entry : entry.name;
    const directory = typeof entry === 'string' || (entry && typeof entry.isDirectory === 'function' && entry.isDirectory());
    if (!directory || !/^app-/i.test(name)) continue;
    candidates.push(path.win32.join(root, name, 'resources', 'codex.exe'));
    candidates.push(path.win32.join(root, name, 'resources', 'app', 'codex.exe'));
  }
}

function findCodexPath(options = {}) {
  const platform = options.platform || process.platform;
  const env = options.env || process.env;
  const homeDir = options.homeDir || os.homedir();
  const execPath = options.execPath || process.execPath;
  const statSyncImpl = options.statSyncImpl || fs.statSync;
  const readdirSyncImpl = options.readdirSyncImpl || fs.readdirSync;
  const pathApi = platform === 'win32' ? path.win32 : path;
  const candidates = [];
  if (env.CODEX_BIN) candidates.push(env.CODEX_BIN);
  if (platform === 'win32') {
    candidates.push(pathApi.join(pathApi.dirname(execPath), 'codex.exe'));
    candidates.push(pathApi.join(homeDir, '.codex', 'bin', 'codex.exe'));
    candidates.push(pathApi.join(homeDir, '.codex', 'bin', 'codex.cmd'));
    const localAppData = env.LOCALAPPDATA || pathApi.join(homeDir, 'AppData', 'Local');
    const programFiles = env.ProgramFiles || env.PROGRAMFILES || 'C:\\Program Files';
    const programFilesX86 = env['ProgramFiles(x86)'] || env.PROGRAMFILES_X86;
    for (const root of [
      pathApi.join(localAppData, 'Programs', 'ChatGPT'),
      pathApi.join(localAppData, 'OpenAI', 'ChatGPT'),
      pathApi.join(localAppData, 'ChatGPT'),
      pathApi.join(programFiles, 'ChatGPT'),
      programFilesX86 ? pathApi.join(programFilesX86, 'ChatGPT') : null,
    ].filter(Boolean)) {
      candidates.push(pathApi.join(root, 'resources', 'codex.exe'));
      candidates.push(pathApi.join(root, 'resources', 'app', 'codex.exe'));
    }
    candidates.push(pathApi.join(localAppData, 'Microsoft', 'WindowsApps', 'codex.exe'));
    addVersionedWindowsCandidates(candidates, pathApi.join(localAppData, 'ChatGPT'), readdirSyncImpl);
    addVersionedWindowsCandidates(candidates, pathApi.join(localAppData, 'Programs', 'ChatGPT'), readdirSyncImpl);
  } else {
    candidates.push('/Applications/ChatGPT.app/Contents/Resources/codex');
    candidates.push(path.join(homeDir, '.codex', 'bin', 'codex'));
  }
  const pathEntries = String(env.PATH || '').split(platform === 'win32' ? ';' : path.delimiter).filter(Boolean);
  for (const entry of pathEntries) {
    candidates.push(pathApi.join(entry, platform === 'win32' ? 'codex.exe' : 'codex'));
    if (platform === 'win32') candidates.push(pathApi.join(entry, 'codex.cmd'));
  }

  for (const candidate of candidates) {
    if (candidate && isRunnableFile(candidate, platform, statSyncImpl)) return candidate;
  }
  return null;
}

function codexSpawnSpec(codexPath, args = APP_SERVER_ARGS, platform = process.platform, env = process.env) {
  if (platform === 'win32' && /\.(?:cmd|bat)$/i.test(codexPath)) {
    const command = env.ComSpec || env.COMSPEC || 'cmd.exe';
    const quotedPath = `"${String(codexPath).replace(/"/g, '""')}"`;
    return { command, args: ['/d', '/s', '/c', `${quotedPath} ${args.join(' ')}`] };
  }
  return { command: codexPath, args };
}

class AppServerClient extends EventEmitter {
  constructor(options = {}) {
    super();
    this.codexPath = options.codexPath || findCodexPath();
    this.platform = options.platform || process.platform;
    this.env = options.env || process.env;
    this.spawnImpl = options.spawnImpl || spawn;
    this.requestTimeoutMs = options.requestTimeoutMs || 15000;
    this.clientInfo = options.clientInfo || {
      name: 'codex-radar',
      title: 'Codex Radar',
      version: '0.1.0',
    };
    this.child = null;
    this.buffer = '';
    this.pending = new Map();
    this.nextId = 1;
    this.ready = false;
    this.startPromise = null;
    this.stopping = false;
  }

  async start() {
    if (this.ready && this.child) return;
    if (this.startPromise) return this.startPromise;
    if (!this.codexPath) throw new Error('找不到本机 Codex 可执行文件');

    this.stopping = false;
    this.startPromise = new Promise((resolve, reject) => {
      let settled = false;
      let child;
      try {
        const spec = codexSpawnSpec(this.codexPath, APP_SERVER_ARGS, this.platform, this.env);
        child = this.spawnImpl(spec.command, spec.args, {
          stdio: ['pipe', 'pipe', 'pipe'],
          env: process.env,
        });
      } catch (error) {
        reject(error);
        return;
      }

      this.child = child;
      this.ready = false;
      this.buffer = '';

      const failStart = (error) => {
        if (!settled) {
          settled = true;
          reject(error);
        }
      };

      // A process can report EPIPE on stdin after close() has already killed
      // it.  Always attach a listener so that race is never an unhandled
      // EventEmitter error; while stopping, close() has already rejected all
      // pending requests and there is nothing left to report.
      if (child.stdin && typeof child.stdin.once === 'function') {
        child.stdin.once('error', (error) => {
          if (this.stopping) return;
          failStart(error);
          this._rejectPending(error);
          this._resetChild(child);
        });
      }

      child.stdout.on('data', (chunk) => this._consume(chunk));
      // app-server writes diagnostic logs to stderr.  Do not forward them to
      // the browser or log them: diagnostics can contain account/environment
      // details that are irrelevant to this dashboard.
      child.stderr.on('data', () => {});
      child.once('error', (error) => {
        failStart(error);
        this._rejectPending(error);
        this._resetChild(child);
      });
      child.once('exit', (code, signal) => {
        const error = new Error(`app-server 已退出 (${code === null ? signal || '未知原因' : `code ${code}`})`);
        failStart(error);
        this._rejectPending(error);
        this._resetChild(child);
      });

      this._request('initialize', {
        clientInfo: this.clientInfo,
        capabilities: {
          experimentalApi: true,
          requestAttestation: false,
        },
      }).then(() => {
        if (this.child !== child || !child.stdin || child.stdin.destroyed) {
          throw new Error('app-server 初始化后连接已关闭');
        }
        this._write({ jsonrpc: '2.0', method: 'initialized' });
        this.ready = true;
        settled = true;
        resolve();
      }).catch((error) => {
        failStart(error);
        try { child.kill(); } catch (_) {}
      });
    });

    try {
      await this.startPromise;
    } finally {
      this.startPromise = null;
    }
  }

  async request(method, params) {
    if (this.stopping) throw new Error('app-server 连接已关闭');
    await this.start();
    if (this.stopping) throw new Error('app-server 连接已关闭');
    return this._request(method, params);
  }

  close() {
    this.stopping = true;
    const child = this.child;
    this.ready = false;
    this._rejectPending(new Error('app-server 连接已关闭'));
    if (child) {
      try { child.kill(); } catch (_) {}
    }
    this._resetChild(child);
  }

  _resetChild(child) {
    if (child && this.child !== child) return;
    this.child = null;
    this.ready = false;
    this.buffer = '';
  }

  _rejectPending(error) {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
  }

  _write(message) {
    if (this.stopping) {
      throw new Error('app-server 连接已关闭');
    }
    if (!this.child || !this.child.stdin || this.child.stdin.destroyed) {
      throw new Error('app-server stdin 不可用');
    }
    this.child.stdin.write(`${JSON.stringify(message)}\n`);
  }

  _request(method, params) {
    if (this.stopping) return Promise.reject(new Error('app-server 连接已关闭'));
    const id = this.nextId++;
    const message = { jsonrpc: '2.0', id, method };
    if (params !== undefined) message.params = params;

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`请求 ${method} 超时`));
      }, this.requestTimeoutMs);
      this.pending.set(id, { resolve, reject, timer, method });
      try {
        this._write(message);
      } catch (error) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(error);
      }
    });
  }

  _consume(chunk) {
    this.buffer += Buffer.isBuffer(chunk) ? chunk.toString('utf8') : String(chunk);
    let newline;
    while ((newline = this.buffer.indexOf('\n')) >= 0) {
      const line = this.buffer.slice(0, newline).trim();
      this.buffer = this.buffer.slice(newline + 1);
      if (!line) continue;
      let message;
      try {
        message = JSON.parse(line);
      } catch (_) {
        // JSONL protocol messages are line-delimited. Ignore a malformed line
        // rather than exposing it or taking down the monitor.
        continue;
      }
      if (message && Object.prototype.hasOwnProperty.call(message, 'id') && message.id !== null && (message.result !== undefined || message.error !== undefined)) {
        const pending = this.pending.get(message.id);
        if (!pending) continue;
        this.pending.delete(message.id);
        clearTimeout(pending.timer);
        if (message.error) {
          const detail = message.error && message.error.message ? message.error.message : 'app-server 请求失败';
          const error = new Error(redactSecrets(detail));
          error.code = message.error.code;
          pending.reject(error);
        } else {
          pending.resolve(message.result);
        }
      } else if (message && typeof message.method === 'string') {
        this.emit('notification', message);
      }
    }
  }
}

function mapThreadStatus(status, latestTurn) {
  const type = status && typeof status === 'object' ? status.type : null;
  const flags = Array.isArray(status && status.activeFlags) ? status.activeFlags : [];

  if (type === 'systemError') return { kind: 'systemError', label: STATUS_LABELS.systemError, running: true, flags };
  if (type === 'active') {
    if (flags.includes('waitingOnApproval')) return { kind: 'waitingOnApproval', label: STATUS_LABELS.waitingOnApproval, running: true, flags };
    if (flags.includes('waitingOnUserInput')) return { kind: 'waitingOnUserInput', label: STATUS_LABELS.waitingOnUserInput, running: true, flags };
    return { kind: 'active', label: STATUS_LABELS.active, running: true, flags };
  }
  if (latestTurn && latestTurn.status === 'inProgress') return { kind: 'active', label: STATUS_LABELS.active, running: true, flags };
  if (latestTurn && latestTurn.status === 'completed') return { kind: 'completed', label: STATUS_LABELS.completed, running: false, flags };
  if (latestTurn && latestTurn.status === 'failed') return { kind: 'failed', label: STATUS_LABELS.failed, running: false, flags };
  if (latestTurn && latestTurn.status === 'interrupted') return { kind: 'interrupted', label: STATUS_LABELS.interrupted, running: false, flags };
  if (type === 'idle') return { kind: 'idle', label: STATUS_LABELS.idle, running: false, flags };
  if (type === 'notLoaded') return { kind: 'notLoaded', label: STATUS_LABELS.notLoaded, running: false, flags };
  return { kind: 'unknown', label: STATUS_LABELS.unknown, running: false, flags };
}

function itemText(item) {
  if (!item || typeof item !== 'object') return '';
  if (item.type === 'agentMessage') return item.text || '';
  if (item.type === 'plan') return item.text || '';
  if (item.type === 'reasoning') return Array.isArray(item.summary) ? item.summary.join(' · ') : '';
  if (item.type === 'commandExecution') return item.command || '';
  if (item.type === 'mcpToolCall') return [item.server, item.tool].filter(Boolean).join(' / ');
  if (item.type === 'dynamicToolCall') return [item.namespace, item.tool].filter(Boolean).join(' / ');
  if (item.type === 'collabAgentToolCall') return item.prompt || item.tool || '';
  if (item.type === 'subAgentActivity') return item.kind || '';
  return '';
}

function summarizeItems(items, options = {}) {
  const list = Array.isArray(items) ? items : [];
  const inProgress = list.find((item) => {
    if (!item || typeof item !== 'object') return false;
    if (item.type === 'commandExecution' || item.type === 'mcpToolCall' || item.type === 'dynamicToolCall') return item.status === 'inProgress';
    if (item.type === 'collabAgentToolCall') return item.status === 'inProgress';
    // `completed` and `interacted` are historical lifecycle entries, not a
    // currently running sub-agent.  Only the explicit `started` event should
    // take the in-progress branch here.
    return item.type === 'subAgentActivity' && item.kind === 'started';
  });
  if (inProgress) {
    if (inProgress.type === 'commandExecution') return `正在执行命令：${shortText(inProgress.command, 145)}`;
    if (inProgress.type === 'mcpToolCall') return `正在调用工具：${shortText([inProgress.server, inProgress.tool].filter(Boolean).join(' / '), 145)}`;
    if (inProgress.type === 'dynamicToolCall') return `正在调用工具：${shortText([inProgress.namespace, inProgress.tool].filter(Boolean).join(' / '), 145)}`;
    if (inProgress.type === 'collabAgentToolCall') return `正在协作：${shortText(itemText(inProgress), 145)}`;
    return `正在处理协作代理：${shortText(itemText(inProgress), 145)}`;
  }

  const plan = list.find((item) => item && item.type === 'plan' && item.text);
  if (plan) return `计划：${shortText(plan.text, 150)}`;
  const agentMessage = list.find((item) => item && item.type === 'agentMessage' && item.text);
  if (agentMessage) return shortText(agentMessage.text, 180);
  const command = list.find((item) => item && item.type === 'commandExecution' && item.command);
  if (command) return `最近执行：${shortText(command.command, 150)}`;
  const tool = list.find((item) => item && (item.type === 'mcpToolCall' || item.type === 'dynamicToolCall') && itemText(item));
  if (tool) return `最近调用：${shortText(itemText(tool), 150)}`;
  const reasoning = list.find((item) => item && item.type === 'reasoning' && Array.isArray(item.summary) && item.summary.length);
  if (reasoning) return `最近步骤：${shortText(itemText(reasoning), 170)}`;
  if (options.fallback) return options.fallback;
  return '';
}

function selectLatestTurn(turns) {
  if (!Array.isArray(turns) || turns.length === 0) return null;
  return turns.reduce((latest, turn) => {
    if (!latest) return turn;
    const latestTime = finiteNumber(latest.startedAt) || finiteNumber(latest.completedAt) || 0;
    const turnTime = finiteNumber(turn && turn.startedAt) || finiteNumber(turn && turn.completedAt) || 0;
    return turnTime >= latestTime ? turn : latest;
  }, null);
}

function extractModel(thread) {
  const candidates = [
    thread && thread.model,
    thread && thread.modelName,
    thread && thread.settings && thread.settings.model,
    thread && thread.extra && thread.extra.model,
    thread && thread.extra && thread.extra.modelName,
    thread && thread.modelProvider,
  ];
  const model = candidates.find((candidate) => typeof candidate === 'string' && candidate.trim());
  return model ? model.trim() : '未提供';
}

function extractItems(detail) {
  const fromTurn = detail && detail.latestTurn && detail.latestTurn.items;
  if (Array.isArray(fromTurn) && fromTurn.length) return fromTurn.slice().reverse();
  const entries = detail && Array.isArray(detail.itemEntries) ? detail.itemEntries : [];
  return entries.map((entry) => entry && entry.item).filter(Boolean);
}

function deriveThreadRecord(thread, detail = {}) {
  const appServerTurn = detail.latestTurn || selectLatestTurn(thread && thread.turns);
  const localTurn = detail.localTurn || null;
  const latestTurn = localTurn || appServerTurn;
  const stale = Boolean(detail.localStale && localTurn && localTurn.status === 'inProgress');
  let status = mapThreadStatus(thread && thread.status, latestTurn);
  // The local projection is the freshest cross-process signal.  In particular,
  // an inProgress turn wins over a new app-server connection's notLoaded state;
  // terminal local turns also prevent an old active notification from keeping
  // a task falsely marked as running.
  if (localTurn && localTurn.status === 'inProgress') {
    status = stale
      ? { kind: 'stale', label: STATUS_LABELS.stale, running: false, flags: [] }
      : (status.kind === 'waitingOnApproval' || status.kind === 'waitingOnUserInput'
        ? status
        : { kind: 'active', label: STATUS_LABELS.active, running: true, flags: status.flags || [] });
  } else if (localTurn && ['completed', 'failed', 'interrupted'].includes(localTurn.status)) {
    status = mapThreadStatus({ type: 'idle' }, localTurn);
  }
  const localItems = detail.localItems && detail.localItems.length ? detail.localItems : [];
  const appItems = extractItems({ ...detail, latestTurn });
  const itemById = new Map();
  for (const item of [...localItems, ...appItems]) {
    if (!item || typeof item !== 'object') continue;
    const key = item.id ? String(item.id) : `${item.type}:${itemText(item)}`;
    if (!itemById.has(key)) itemById.set(key, item);
  }
  const items = Array.from(itemById.values());
  let summary = summarizeItems(items, {
    fallback: status.kind === 'waitingOnApproval' ? '等待你批准下一步操作' : status.kind === 'waitingOnUserInput' ? '等待你提供输入' : status.running ? '正在运行，暂无步骤详情' : '',
  });
  if (stale) summary = '最新 turn 长时间没有更新，状态可能已过期';
  const createdAt = toEpochSeconds(thread && thread.createdAt);
  const latestStartedAt = toEpochSeconds(latestTurn && latestTurn.startedAt);
  const updatedAt = toEpochSeconds(thread && thread.updatedAt) || toEpochSeconds(latestTurn && (latestTurn.completedAt || latestTurn.startedAt)) || createdAt;
  const terminal = ['completed', 'failed', 'interrupted'].includes(status.kind);
  const errorMessage = latestTurn && latestTurn.error && latestTurn.error.message ? shortText(latestTurn.error.message, 180) : null;
  const title = shortText((thread && (thread.name || thread.preview)) || '未命名任务', 120) || '未命名任务';
  return {
    id: thread && thread.id ? String(thread.id) : '',
    title,
    cwd: typeof (thread && thread.cwd) === 'string' ? thread.cwd : '—',
    model: extractModel(thread),
    modelProvider: typeof (thread && thread.modelProvider) === 'string' ? thread.modelProvider : null,
    status: status.kind,
    statusLabel: status.label,
    running: status.running,
    terminal,
    stale,
    summary,
    error: errorMessage,
    flags: status.flags,
    createdAt,
    createdAtIso: isoFromEpochSeconds(createdAt),
    startedAt: latestStartedAt || createdAt,
    startedAtIso: isoFromEpochSeconds(latestStartedAt || createdAt),
    updatedAt,
    updatedAtIso: isoFromEpochSeconds(updatedAt),
    completedAt: terminal ? toEpochSeconds(latestTurn && latestTurn.completedAt) || updatedAt : null,
    completedAtIso: terminal ? isoFromEpochSeconds(toEpochSeconds(latestTurn && latestTurn.completedAt) || updatedAt) : null,
    latestTurnStatus: latestTurn && latestTurn.status ? latestTurn.status : null,
    source: typeof (thread && thread.source) === 'string' ? thread.source : null,
  };
}

function normalizeWindow(window) {
  if (!window || typeof window !== 'object') return null;
  const usedValue = finiteNumber(window.usedPercent !== undefined ? window.usedPercent : window.used_percent);
  const usedPercent = usedValue === null ? null : clamp(usedValue, 0, 100);
  const resetsAt = toEpochSeconds(window.resetsAt !== undefined ? window.resetsAt : (window.resetAt !== undefined ? window.resetAt : window.resets_at));
  const duration = finiteNumber(window.windowDurationMins !== undefined ? window.windowDurationMins : window.window_duration_mins);
  return {
    available: usedPercent !== null || resetsAt !== null || duration !== null,
    usedPercent,
    remainingPercent: usedPercent === null ? null : Math.max(0, 100 - usedPercent),
    windowDurationMins: duration,
    resetsAt,
    resetsAtIso: isoFromEpochSeconds(resetsAt),
  };
}

function normalizeCredits(credits) {
  if (!credits || typeof credits !== 'object') return null;
  return {
    available: true,
    hasCredits: Boolean(credits.hasCredits !== undefined ? credits.hasCredits : credits.has_credits),
    unlimited: Boolean(credits.unlimited),
    balance: credits.balance === null || credits.balance === undefined ? null : String(credits.balance),
  };
}

function normalizeAccount(payload) {
  const account = payload && payload.account ? payload.account : null;
  if (!account || typeof account !== 'object') return { available: false, type: null, plan: null };
  return {
    available: true,
    type: typeof account.type === 'string' ? account.type : null,
    plan: typeof account.planType === 'string' ? account.planType : (typeof account.plan_type === 'string' ? account.plan_type : null),
  };
}

function chooseRateSnapshot(payload) {
  if (!payload || typeof payload !== 'object') return null;
  const byLimit = payload.rateLimitsByLimitId || payload.rate_limits_by_limit_id;
  if (byLimit && typeof byLimit === 'object') {
    if (byLimit.codex) return byLimit.codex;
    const first = Object.values(byLimit).find((value) => value && typeof value === 'object');
    if (first) return first;
  }
  return payload.rateLimits || payload.rate_limits || payload;
}

function normalizeRateLimits(payload, accountPayload) {
  const account = normalizeAccount(accountPayload);
  const snapshot = chooseRateSnapshot(payload);
  if (!snapshot || typeof snapshot !== 'object' || (!snapshot.primary && !snapshot.secondary && !snapshot.credits && !snapshot.planType && !snapshot.plan_type)) {
    return {
      available: false,
      message: '暂不可用',
      officialUrl: USAGE_URL,
      plan: account.plan,
      primary: null,
      secondary: null,
      credits: null,
      limitName: null,
      rateLimitReachedType: null,
      spendControlReached: null,
    };
  }
  const plan = typeof snapshot.planType === 'string' ? snapshot.planType : (typeof snapshot.plan_type === 'string' ? snapshot.plan_type : account.plan);
  return {
    available: true,
    message: null,
    officialUrl: USAGE_URL,
    plan: plan || null,
    primary: normalizeWindow(snapshot.primary),
    secondary: normalizeWindow(snapshot.secondary),
    credits: normalizeCredits(snapshot.credits),
    limitName: snapshot.limitName || snapshot.limit_name || snapshot.limitId || snapshot.limit_id || null,
    rateLimitReachedType: snapshot.rateLimitReachedType || snapshot.rate_limit_reached_type || null,
    spendControlReached: snapshot.spendControlReached === undefined ? (snapshot.spend_control_reached === undefined ? null : snapshot.spend_control_reached) : snapshot.spendControlReached,
  };
}

function sqliteQuote(value) {
  return `'${String(value).replace(/'/g, "''")}'`;
}

function defaultThreadHistoryDb() {
  const configured = process.env.CODEX_RADAR_DB;
  if (configured) return configured;
  return DEFAULT_THREAD_HISTORY_DB;
}

function runtimeDirectory(execPath = process.execPath) {
  return process.pkg ? path.dirname(execPath) : __dirname;
}

function findPublicDirectory(options = {}) {
  const baseDir = options.baseDir || runtimeDirectory(options.execPath || process.execPath);
  const statSyncImpl = options.statSyncImpl || fs.statSync;
  const candidates = [
    path.join(baseDir, 'public'),
    path.resolve(baseDir, '..', 'Resources', 'public'),
  ];
  for (const candidate of candidates) {
    try {
      if (statSyncImpl(candidate).isDirectory()) return candidate;
    } catch (_) {}
  }
  return candidates[0];
}

function findSqlitePath(options = {}) {
  const platform = options.platform || process.platform;
  const env = options.env || process.env;
  const execPath = options.execPath || process.execPath;
  const statSyncImpl = options.statSyncImpl || fs.statSync;
  const baseDir = options.baseDir || runtimeDirectory(execPath);
  const pathApi = platform === 'win32' ? path.win32 : path;
  const executable = platform === 'win32' ? 'sqlite3.exe' : 'sqlite3';
  const candidates = [
    env.CODEX_RADAR_SQLITE,
    pathApi.join(baseDir, 'tools', executable),
    pathApi.join(baseDir, executable),
    pathApi.join(__dirname, 'vendor', platform === 'win32' ? 'windows' : platform, executable),
  ].filter(Boolean);
  const delimiter = platform === 'win32' ? ';' : path.delimiter;
  for (const entry of String(env.PATH || '').split(delimiter).filter(Boolean)) {
    candidates.push(pathApi.join(entry, executable));
  }
  for (const candidate of candidates) {
    if (isRunnableFile(candidate, platform, statSyncImpl)) return candidate;
  }
  // Preserve the previous PATH lookup behavior when no concrete candidate can
  // be inspected.  spawnSync will fail safely and the dashboard will fall back
  // to app-server data.
  return executable;
}

function parseSqliteItem(row) {
  if (!row || typeof row !== 'object') return null;
  try {
    const item = JSON.parse(row.item_json);
    if (item && typeof item === 'object') return item;
  } catch (_) {
    // Keep the item type as a safe placeholder.  Never surface raw JSON.
  }
  return row.item_type ? { type: row.item_type } : null;
}

/**
 * Read only the thread runtime projection maintained by Codex.  A standalone
 * app-server has its own in-memory loaded-thread set, so thread/list can say
 * `notLoaded` for a task that is running in the desktop app.  This projection
 * supplies the latest turn status and a bounded set of item summaries.  The
 * query is intentionally scoped to IDs returned by app-server and touches only
 * thread_turns/thread_items; it never reads credential or auth tables.
 */
function readLocalThreadState(threadIds, dbPath = defaultThreadHistoryDb(), options = {}) {
  const result = new Map();
  const uniqueIds = Array.from(new Set((Array.isArray(threadIds) ? threadIds : [])
    .map((id) => String(id))
    .filter((id) => /^[A-Za-z0-9._:-]+$/.test(id))));
  if (!uniqueIds.length || !dbPath) return result;
  try {
    if (!fs.statSync(dbPath).isFile()) return result;
  } catch (_) {
    return result;
  }

  const inClause = uniqueIds.map(sqliteQuote).join(', ');
  const query = `
WITH latest_turns AS (
  SELECT t.*
  FROM thread_turns t
  JOIN (
    SELECT thread_id, MAX(rollout_ordinal) AS max_rollout
    FROM thread_turns
    WHERE thread_id IN (${inClause})
    GROUP BY thread_id
  ) latest ON latest.thread_id = t.thread_id AND latest.max_rollout = t.rollout_ordinal
), ranked_items AS (
  SELECT i.*, ROW_NUMBER() OVER (PARTITION BY i.thread_id ORDER BY i.rollout_ordinal DESC) AS item_rank
  FROM thread_items i
  WHERE i.thread_id IN (${inClause})
)
SELECT 'turn' AS row_kind, thread_id, turn_id, status, started_at, completed_at,
       duration_ms, rollout_ordinal, NULL AS item_type, NULL AS item_json, NULL AS created_at_ms
FROM latest_turns
UNION ALL
SELECT 'item' AS row_kind, thread_id, turn_id, NULL AS status, NULL AS started_at,
       NULL AS completed_at, NULL AS duration_ms, rollout_ordinal, item_type,
       item_json, created_at_ms
FROM ranked_items
WHERE item_rank <= 24
ORDER BY thread_id, row_kind, rollout_ordinal DESC;
`;
  const sqlite = options.spawnSyncImpl || spawnSync;
  const sqlitePath = options.sqlitePath || findSqlitePath(options);
  let output;
  try {
    const completed = sqlite(sqlitePath, ['-readonly', '-json', dbPath, query], {
      encoding: 'utf8',
      maxBuffer: 24 * 1024 * 1024,
      windowsHide: true,
    });
    if (!completed || completed.status !== 0 || !completed.stdout) return result;
    output = JSON.parse(completed.stdout);
  } catch (_) {
    return result;
  }
  if (!Array.isArray(output)) return result;
  for (const row of output) {
    if (!row || !row.thread_id) continue;
    const id = String(row.thread_id);
    const state = result.get(id) || { latestTurn: null, items: [], lastActivityAt: null };
    if (row.row_kind === 'turn') {
      state.latestTurn = {
        id: row.turn_id || null,
        status: row.status || null,
        startedAt: finiteNumber(row.started_at),
        completedAt: finiteNumber(row.completed_at),
        durationMs: finiteNumber(row.duration_ms),
        items: [],
      };
      state.lastActivityAt = Math.max(
        toEpochSeconds(row.started_at) || 0,
        toEpochSeconds(row.completed_at) || 0,
        state.lastActivityAt || 0,
      ) || null;
    } else if (row.row_kind === 'item') {
      const item = parseSqliteItem(row);
      if (item) state.items.push(item);
      const created = toEpochSeconds(row.created_at_ms);
      if (created !== null) state.lastActivityAt = Math.max(state.lastActivityAt || 0, created);
    }
    result.set(id, state);
  }
  for (const state of result.values()) {
    // sqlite returns items newest first; deriveThreadRecord accepts the same
    // order as thread/items/list, so keep it bounded and deterministic.
    state.items = state.items.slice(0, 24);
  }
  return result;
}

function unavailableUsage() {
  return {
    available: false,
    message: '暂不可用',
    officialUrl: USAGE_URL,
    account: { available: false, type: null, plan: null },
    plan: null,
    primary: null,
    secondary: null,
    credits: null,
    limitName: null,
    rateLimitReachedType: null,
    spendControlReached: null,
  };
}

async function settledCall(call) {
  try {
    return { ok: true, value: await call() };
  } catch (error) {
    return { ok: false, error };
  }
}

function threadListParams(cursor) {
  const params = {
    limit: 100,
    sortKey: 'updated_at',
    sortDirection: 'desc',
    archived: false,
  };
  if (cursor) params.cursor = cursor;
  return params;
}

async function listAllThreads(client) {
  const threads = [];
  let cursor = null;
  for (let page = 0; page < MAX_THREAD_PAGES && threads.length < MAX_THREADS; page += 1) {
    const response = await client.request('thread/list', threadListParams(cursor));
    const data = response && Array.isArray(response.data) ? response.data : [];
    threads.push(...data);
    cursor = response && response.nextCursor ? response.nextCursor : null;
    if (!cursor || data.length === 0) break;
  }
  const byId = new Map();
  for (const thread of threads) {
    if (thread && thread.id) byId.set(String(thread.id), thread);
  }
  return Array.from(byId.values());
}

function windowsPowerShellPath(env = process.env) {
  const systemRoot = env.SystemRoot || env.SYSTEMROOT;
  return systemRoot
    ? path.win32.join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
    : 'powershell.exe';
}

function powershellArgs(script) {
  return [
    '-NoLogo',
    '-NoProfile',
    '-NonInteractive',
    '-ExecutionPolicy',
    'Bypass',
    '-EncodedCommand',
    Buffer.from(String(script), 'utf16le').toString('base64'),
  ];
}

function powershellString(value) {
  return `'${String(value || '').replace(/'/g, "''")}'`;
}

function findWindowsAlarmSound(options = {}) {
  const execPath = options.execPath || process.execPath;
  const statSyncImpl = options.statSyncImpl || fs.statSync;
  const baseDir = options.baseDir || runtimeDirectory(execPath);
  const candidates = [
    options.soundPath,
    path.join(baseDir, 'assets', WINDOWS_ALARM_FILE),
    path.join(baseDir, WINDOWS_ALARM_FILE),
    path.join(__dirname, 'assets', WINDOWS_ALARM_FILE),
  ].filter(Boolean);
  for (const candidate of candidates) {
    try {
      if (statSyncImpl(candidate).isFile()) return candidate;
    } catch (_) {}
  }
  return path.join(baseDir, 'assets', WINDOWS_ALARM_FILE);
}

function windowsSoundScript(soundPath) {
  const file = powershellString(soundPath);
  return [
    `$path = ${file}`,
    'if (Test-Path -LiteralPath $path) {',
    '  $player = New-Object System.Media.SoundPlayer $path',
    '  $player.PlaySync()',
    '} else {',
    '  [System.Media.SystemSounds]::Hand.Play()',
    '  Start-Sleep -Milliseconds 900',
    '  [System.Media.SystemSounds]::Exclamation.Play()',
    '  Start-Sleep -Milliseconds 900',
    '  [System.Media.SystemSounds]::Hand.Play()',
    '}',
  ].join('\n');
}

function windowsSpeechScript(text) {
  return [
    'Add-Type -AssemblyName System.Speech',
    '$speaker = New-Object System.Speech.Synthesis.SpeechSynthesizer',
    '$speaker.Volume = 100',
    '$speaker.Rate = 0',
    'try {',
    "  $voice = $speaker.GetInstalledVoices() | Where-Object { $_.VoiceInfo.Culture.Name -like 'zh-*' } | Select-Object -First 1",
    '  if ($voice) { $speaker.SelectVoice($voice.VoiceInfo.Name) }',
    '} catch {}',
    `$speaker.Speak(${powershellString(text)})`,
    '$speaker.Dispose()',
  ].join('\n');
}

/**
 * A bounded, local-only alarm made from platform-native audio and speech.
 *
 * The controller deliberately owns every timer and child process it starts.
 * Starting a new alarm first tears down the previous session, so a burst of
 * completed tasks can never leave a pile of afplay/say processes running.
 */
class AlarmController {
  constructor(options = {}) {
    this.spawnImpl = options.spawnImpl || spawn;
    this.setTimeoutImpl = options.setTimeoutImpl || setTimeout;
    this.clearTimeoutImpl = options.clearTimeoutImpl || clearTimeout;
    this.setIntervalImpl = options.setIntervalImpl || setInterval;
    this.clearIntervalImpl = options.clearIntervalImpl || clearInterval;
    this.noSound = Boolean(options.noSound);
    this.platform = options.platform || process.platform;
    this.env = options.env || process.env;
    this.defaultDurationSeconds = normalizeAlarmSeconds(options.defaultDurationSeconds);
    this.repeatMs = clamp(Math.round(finiteNumber(options.repeatMs) || ALARM_REPEAT_MS), 1000, 10000);
    const windows = this.platform === 'win32';
    this.soundPlayer = options.soundPlayer || (windows ? windowsPowerShellPath(this.env) : STRONG_ALARM_SOUND_PLAYER);
    this.soundPath = options.soundPath || (windows ? findWindowsAlarmSound(options) : STRONG_ALARM_SOUND_PATH);
    this.speechPlayer = options.speechPlayer || (windows ? windowsPowerShellPath(this.env) : STRONG_ALARM_SPEECH_PLAYER);
    this.soundArgsFactory = options.soundArgsFactory || (windows
      ? (() => powershellArgs(windowsSoundScript(this.soundPath)))
      : (() => [this.soundPath]));
    this.speechArgsFactory = options.speechArgsFactory || (windows
      ? ((text) => powershellArgs(windowsSpeechScript(text)))
      : ((text) => [text]));
    this.childProcesses = new Set();
    // Public alias kept intentionally small: it is useful for diagnostics and
    // makes the owned process handles easy to inspect in tests.
    this.children = this.childProcesses;
    this.session = null;
    this.nextSessionId = 1;
  }

  isActive() {
    return Boolean(this.session && !this.session.stopped);
  }

  start(record = {}, options = {}) {
    if (this.noSound) {
      return {
        ok: true,
        enabled: false,
        started: false,
        active: false,
        durationSeconds: 0,
        message: '声音已关闭',
      };
    }

    const durationSeconds = normalizeAlarmSeconds(options.durationSeconds, this.defaultDurationSeconds);
    // Reuse the single alarm slot.  This also cleans up children from a
    // previous terminal transition before a new transition is announced.
    this.stopAlarm();
    const session = {
      id: this.nextSessionId++,
      record,
      stopped: false,
      endsAt: Date.now() + durationSeconds * 1000,
      timers: new Set(),
      intervals: new Set(),
      children: new Set(),
      channelChildren: { sound: null, speech: null },
      spawned: 0,
      errors: [],
    };
    this.session = session;

    this._playCycle(session, record, options);
    try {
      const timeout = this.setTimeoutImpl(() => this._finishSession(session), durationSeconds * 1000);
      if (timeout) {
        session.timers.add(timeout);
        this._unref(timeout);
      }
    } catch (error) {
      session.errors.push(safeError(error));
      this._finishSession(session);
    }

    if (this.isActive() && session !== this.session) {
      return {
        ok: false,
        enabled: true,
        started: false,
        active: false,
        durationSeconds,
        message: '强提醒已停止',
      };
    }

    if (this.isActive()) {
      try {
        const interval = this.setIntervalImpl(() => {
          if (!this._isCurrent(session)) return;
          if (Date.now() >= session.endsAt) {
            this._finishSession(session);
            return;
          }
          this._playCycle(session, record, options);
        }, this.repeatMs);
        if (interval) {
          session.intervals.add(interval);
          this._unref(interval);
        }
      } catch (error) {
        session.errors.push(safeError(error));
      }
    }

    const started = session.spawned > 0;
    return {
      ok: started || session.errors.length === 0,
      enabled: true,
      started,
      active: this.isActive(),
      durationSeconds,
      sessionId: session.id,
      sound: { started: Boolean(session.channelStarted && session.channelStarted.sound) },
      speech: { started: Boolean(session.channelStarted && session.channelStarted.speech) },
      errors: session.errors.slice(0, 4),
      message: started ? `强提醒已启动（${durationSeconds} 秒）` : '强提醒启动失败',
    };
  }

  stopAlarm() {
    const session = this.session;
    const children = new Set(this.childProcesses);
    if (session) {
      session.stopped = true;
      for (const timer of session.timers) {
        try { this.clearTimeoutImpl(timer); } catch (_) {}
      }
      for (const interval of session.intervals) {
        try { this.clearIntervalImpl(interval); } catch (_) {}
      }
      for (const child of session.children) children.add(child);
      session.timers.clear();
      session.intervals.clear();
      session.children.clear();
      session.channelChildren.sound = null;
      session.channelChildren.speech = null;
    }
    let stoppedChildren = 0;
    for (const child of children) {
      if (!child) continue;
      try {
        if (typeof child.kill === 'function') child.kill('SIGTERM');
        else if (typeof child.destroy === 'function') child.destroy();
        stoppedChildren += 1;
      } catch (_) {
        // A child can exit between the snapshot and kill.  It is already
        // harmless, and one failed channel must not affect monitoring.
      }
      this.childProcesses.delete(child);
    }
    this.session = null;
    return {
      ok: true,
      stopped: Boolean(session || children.size),
      active: false,
      childrenStopped: stoppedChildren,
      message: session || children.size ? '强提醒已停止' : '当前没有正在播放的提醒',
    };
  }

  close() {
    return this.stopAlarm();
  }

  _isCurrent(session) {
    return this.session === session && !session.stopped;
  }

  _finishSession(session) {
    if (!this._isCurrent(session)) return;
    this.stopAlarm();
  }

  _playCycle(session, record, options) {
    if (!this._isCurrent(session)) return;
    if (!session.channelStarted) session.channelStarted = { sound: false, speech: false };
    const sound = this._spawnChannel(session, 'sound', this.soundPlayer, this.soundArgsFactory(record, options));
    const speechText = options.speechText || alarmSpeechForRecord(record);
    const speech = this._spawnChannel(session, 'speech', this.speechPlayer, this.speechArgsFactory(speechText, record, options));
    if (sound.ok) session.channelStarted.sound = true;
    if (speech.ok) session.channelStarted.speech = true;
  }

  _spawnChannel(session, channel, command, args) {
    if (!this._isCurrent(session) || session.channelChildren[channel]) {
      return { ok: false, skipped: true };
    }
    let child;
    try {
      child = this.spawnImpl(command, args, {
        stdio: 'ignore',
        windowsHide: true,
      });
    } catch (error) {
      session.errors.push(`${channel}: ${safeError(error)}`);
      return { ok: false, error: safeError(error) };
    }
    if (!child) {
      const error = `${channel}: 未返回子进程句柄`;
      session.errors.push(error);
      return { ok: false, error };
    }

    let released = false;
    const release = () => {
      if (released) return;
      released = true;
      if (session.channelChildren[channel] === child) session.channelChildren[channel] = null;
      session.children.delete(child);
      this.childProcesses.delete(child);
    };
    const attach = (event) => {
      try {
        if (typeof child.once === 'function') child.once(event, release);
        else if (typeof child.on === 'function') child.on(event, release);
      } catch (_) {}
    };
    attach('error');
    attach('close');
    attach('exit');
    session.channelChildren[channel] = child;
    session.children.add(child);
    this.childProcesses.add(child);
    session.spawned += 1;
    return { ok: true };
  }

  _unref(handle) {
    try {
      if (handle && typeof handle.unref === 'function') handle.unref();
    } catch (_) {}
  }
}

function alarmSpeechForRecord(record = {}) {
  return ALARM_SPEECH[record.status] || ALARM_SPEECH.completed;
}

class DashboardMonitor extends EventEmitter {
  constructor(options = {}) {
    super();
    this.client = options.client || new AppServerClient();
    this.noNotify = options.noNotify === undefined
      ? process.env.CODEX_RADAR_NO_NOTIFY === '1'
      : Boolean(options.noNotify);
    this.noSound = options.noSound === undefined
      ? process.env.CODEX_RADAR_NO_SOUND === '1'
      : Boolean(options.noSound);
    this.notify = options.notify || sendLocalNotification;
    this.alarmSeconds = normalizeAlarmSeconds(
      options.alarmSeconds === undefined ? process.env.CODEX_RADAR_ALARM_SECONDS : options.alarmSeconds,
    );
    this.alarm = options.alarm || new AlarmController({
      noSound: this.noSound,
      defaultDurationSeconds: this.alarmSeconds,
      spawnImpl: options.spawnImpl || options.alarmSpawnImpl,
      setTimeoutImpl: options.setTimeoutImpl,
      clearTimeoutImpl: options.clearTimeoutImpl,
      setIntervalImpl: options.setIntervalImpl,
      clearIntervalImpl: options.clearIntervalImpl,
    });
    // Custom playSound handlers remain supported for tests and platform
    // adapters.  The normal path is the bounded AlarmController above.
    this.playSound = options.playSound || options.sound || ((record, alertOptions) => this.alarm.start(record, alertOptions));
    this.refreshMs = options.refreshMs || DEFAULT_REFRESH_MS;
    this.staleAfterSeconds = options.staleAfterSeconds || DEFAULT_STALE_AFTER_SECONDS;
    this.dbPath = options.dbPath || defaultThreadHistoryDb();
    this.sqliteReader = options.sqliteReader || readLocalThreadState;
    this.maxActiveReads = options.maxActiveReads || MAX_ACTIVE_READS;
    this.maxDetailThreads = options.maxDetailThreads || MAX_DETAIL_THREADS;
    this.state = {
      generatedAt: new Date().toISOString(),
      lastUpdated: null,
      source: '本机 app-server',
      connection: { status: 'connecting', message: '正在连接本机 app-server', lastSuccessAt: null },
      runningCount: 0,
      running: [],
      attention: [],
      completed: [],
      usage: unavailableUsage(),
    };
    this.previous = new Map();
    this.hasBaseline = false;
    this.notified = new Set();
    this.refreshPromise = null;
    this.timer = null;
    this.client.on('notification', (notification) => {
      if (!notification || typeof notification.method !== 'string') return;
      if (/^(thread\/status\/changed|turn\/(started|completed)|item\/(started|completed)|account\/rateLimits\/updated)$/.test(notification.method)) {
        if (!this.refreshPromise) {
          setTimeout(() => this.refresh().catch(() => {}), 50).unref();
        }
      }
    });
  }

  start() {
    if (this.timer) return;
    this.refresh().catch(() => {});
    this.timer = setInterval(() => this.refresh().catch(() => {}), this.refreshMs);
    this.timer.unref();
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.stopAlarm();
    this.client.close();
  }

  stopAlarm() {
    if (this.alarm && typeof this.alarm.stopAlarm === 'function') {
      try {
        return this.alarm.stopAlarm();
      } catch (_) {
        return { ok: false, stopped: false, active: false, message: '强提醒停止失败' };
      }
    }
    return { ok: true, stopped: false, active: false, message: '当前没有正在播放的提醒' };
  }

  stopAlert() {
    return this.stopAlarm();
  }

  async refresh() {
    if (this.refreshPromise) return this.refreshPromise;
    this.refreshPromise = this._refresh();
    try {
      return await this.refreshPromise;
    } finally {
      this.refreshPromise = null;
    }
  }

  async _refresh() {
    const [threadsResult, accountResult, rateResult] = await Promise.all([
      settledCall(() => listAllThreads(this.client)),
      settledCall(() => this.client.request('account/read', { refreshToken: false })),
      settledCall(() => this.client.request('account/rateLimits/read')),
    ]);

    const anySuccess = threadsResult.ok || accountResult.ok || rateResult.ok;
    if (!anySuccess) {
      this.state = {
        ...this.state,
        generatedAt: new Date().toISOString(),
        connection: {
          status: 'offline',
          message: '无法连接本机 app-server',
          detail: safeError(threadsResult.error || accountResult.error || rateResult.error),
          lastSuccessAt: this.state.connection.lastSuccessAt,
        },
      };
      this.emit('state', this.state);
      return this.state;
    }

    let records = this.state.running.concat(this.state.completed);
    if (threadsResult.ok) {
      const threads = threadsResult.value;
      let localStates = new Map();
      try {
        localStates = this.sqliteReader(
          threads.map((thread) => thread && thread.id).filter(Boolean),
          this.dbPath,
        ) || new Map();
      } catch (_) {
        localStates = new Map();
      }
      const nowSeconds = Date.now() / 1000;
      for (const localState of localStates.values()) {
        const turn = localState && localState.latestTurn;
        if (!turn || turn.status !== 'inProgress') continue;
        const lastActivity = Math.max(toEpochSeconds(turn.startedAt) || 0, localState.lastActivityAt || 0);
        localState.stale = lastActivity > 0 && nowSeconds - lastActivity > this.staleAfterSeconds;
      }
      const active = threads.filter((thread) => {
        const type = thread && thread.status && thread.status.type;
        const local = localStates.get(String(thread && thread.id));
        return type === 'active' || type === 'systemError' || Boolean(local && local.latestTurn && local.latestTurn.status === 'inProgress');
      });
      const detailThreads = [];
      const seen = new Set();
      // Active threads are the only ones that need the more expensive full
      // `thread/read` enrichment.  For historical threads, the SQLite
      // projection already has the latest turn and bounded item JSON; skip
      // redundant app-server calls when that projection is complete.
      for (const thread of active.slice(0, this.maxActiveReads)) {
        if (!thread || !thread.id || seen.has(thread.id)) continue;
        if (detailThreads.length >= this.maxDetailThreads) break;
        seen.add(thread.id);
        detailThreads.push(thread);
      }
      for (const thread of threads) {
        if (!thread || !thread.id || seen.has(thread.id)) continue;
        if (detailThreads.length >= this.maxDetailThreads) break;
        const local = localStates.get(String(thread.id));
        if (local && local.latestTurn && Array.isArray(local.items) && local.items.length) continue;
        seen.add(thread.id);
        detailThreads.push(thread);
      }
      const details = await Promise.all(detailThreads.map((thread) => this._readDetail(
        thread,
        active.includes(thread) && active.indexOf(thread) < this.maxActiveReads,
        localStates.get(String(thread.id)),
      )));
      const detailsById = new Map(details.map((detail) => [detail.id, detail]));
      // Threads whose projection was complete were intentionally skipped above
      // to avoid a fan-out of detail calls.  Still pass that projection into
      // deriveThreadRecord so their latest terminal status is not lost.
      for (const [id, localState] of localStates.entries()) {
        if (detailsById.has(id) || !localState) continue;
        detailsById.set(id, {
          id,
          latestTurn: null,
          localTurn: localState.latestTurn || null,
          localItems: Array.isArray(localState.items) ? localState.items : [],
          localStale: Boolean(localState.stale),
          itemEntries: [],
        });
      }
      records = threads.map((thread) => deriveThreadRecord(thread, detailsById.get(String(thread.id)) || {})).filter((record) => record.id);
      this._detectTransitions(records);
    }

    const running = records.filter((record) => record.running && !record.stale).sort(sortByUpdatedDescending);
    const attention = records.filter((record) => record.stale).sort(sortByUpdatedDescending).slice(0, 30);
    const completed = records.filter((record) => record.terminal).sort(sortByUpdatedDescending).slice(0, 30);
    const account = accountResult.ok ? normalizeAccount(accountResult.value) : this.state.usage.account;
    const usage = rateResult.ok ? normalizeRateLimits(rateResult.value, accountResult.ok ? accountResult.value : null) : {
      ...this.state.usage,
      account,
      available: false,
      message: '暂不可用',
      officialUrl: USAGE_URL,
    };
    if (rateResult.ok) usage.account = account;

    const now = new Date().toISOString();
    const connectionStatus = threadsResult.ok && accountResult.ok && rateResult.ok ? 'connected' : 'degraded';
    this.state = {
      generatedAt: now,
      lastUpdated: now,
      source: '本机 app-server',
      connection: {
        status: connectionStatus,
        message: connectionStatus === 'connected' ? '已连接' : '部分数据暂不可用',
        detail: threadsResult.ok ? null : safeError(threadsResult.error),
        lastSuccessAt: now,
      },
      runningCount: running.length,
      running,
      attention,
      completed,
      usage,
    };
    this.emit('state', this.state);
    return this.state;
  }

  async _readDetail(thread, readFull, localState = null) {
    const id = String(thread.id);
    const requests = [
      settledCall(() => this.client.request('thread/turns/list', {
        threadId: id,
        limit: 1,
        sortDirection: 'desc',
        itemsView: 'summary',
      })),
      settledCall(() => this.client.request('thread/items/list', {
        threadId: id,
        limit: 24,
        sortDirection: 'desc',
      })),
    ];
    if (readFull) {
      requests.push(settledCall(() => this.client.request('thread/read', { threadId: id, includeTurns: true })));
    }
    const [turnsResult, itemsResult, readResult] = await Promise.all(requests);
    let latestTurn = null;
    if (readResult && readResult.ok && readResult.value && readResult.value.thread) {
      latestTurn = selectLatestTurn(readResult.value.thread.turns);
    }
    if (!latestTurn && turnsResult && turnsResult.ok) {
      latestTurn = selectLatestTurn(turnsResult.value && turnsResult.value.data);
    }
    let itemEntries = itemsResult && itemsResult.ok && itemsResult.value && Array.isArray(itemsResult.value.data) ? itemsResult.value.data : [];
    if (latestTurn && Array.isArray(latestTurn.items) && latestTurn.items.length) itemEntries = [];
    return {
      id,
      latestTurn,
      localTurn: localState && localState.latestTurn ? localState.latestTurn : null,
      localItems: localState && Array.isArray(localState.items) ? localState.items : [],
      localStale: Boolean(localState && localState.stale),
      itemEntries,
      readThread: readResult && readResult.ok ? readResult.value.thread : null,
    };
  }

  _detectTransitions(records) {
    const current = new Map(records.map((record) => [record.id, record]));
    if (!this.hasBaseline) {
      this.previous = new Map(records.map((record) => [record.id, { running: record.running, status: record.status, title: record.title }]));
      this.hasBaseline = true;
      return;
    }
    for (const record of records) {
      const old = this.previous.get(record.id);
      if (old && old.running && record.terminal && !this.notified.has(`${record.id}:${record.status}`)) {
        this.notified.add(`${record.id}:${record.status}`);
        this._dispatchAlert(record);
      }
    }
    this.previous = new Map(Array.from(current.entries()).map(([id, record]) => [id, { running: record.running, status: record.status, title: record.title }]));
  }

  /**
   * Trigger the two local alert channels independently.  A notification
   * implementation or sound player can be supplied by tests (or a future
   * platform adapter); one channel must never prevent the other from firing.
   */
  _dispatchAlert(record, alertOptions = {}) {
    const notification = {
      enabled: !this.noNotify,
      attempted: false,
      ok: true,
    };
    const sound = {
      enabled: !this.noSound,
      attempted: false,
      ok: true,
    };

    if (notification.enabled) {
      notification.attempted = true;
      const notificationResult = safelyInvokeAlert(this.notify, record, alertOptions);
      notification.ok = alertResultOk(notificationResult);
    }
    if (sound.enabled) {
      sound.attempted = true;
      const soundResult = safelyInvokeAlert(this.playSound, record, alertOptions);
      sound.ok = alertResultOk(soundResult);
      if (soundResult && typeof soundResult === 'object') sound.detail = soundResult;
    }
    return { notification, sound };
  }

  /** Trigger a short one-off strong reminder from the dashboard button. */
  testAlert(options = {}) {
    const result = this._dispatchAlert({
      id: 'codex-radar-test-alert',
      title: 'Codex Radar',
      status: 'completed',
      statusLabel: '测试提醒',
    }, {
      ...options,
      durationSeconds: normalizeAlarmSeconds(options.durationSeconds, TEST_ALARM_SECONDS),
      test: true,
    });
    return {
      ok: result.notification.ok && result.sound.ok,
      message: '测试强提醒已触发',
      ...result,
    };
  }
}

function sortByUpdatedDescending(left, right) {
  return (right.updatedAt || 0) - (left.updatedAt || 0);
}

function sendMacNotification(record) {
  if (process.platform !== 'darwin') return false;
  const body = `${record.title}：${record.statusLabel || '已结束'}`;
  const script = `display notification ${JSON.stringify(body)} with title ${JSON.stringify('Codex Radar')}`;
  execFile('osascript', ['-e', script], { windowsHide: true }, () => {});
  return true;
}

function sendWindowsNotification(record, options = {}) {
  const body = `${record.title || 'Codex 任务'}：${record.statusLabel || '已结束'}`;
  const script = [
    '[Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime] > $null',
    '[Windows.UI.Notifications.ToastNotification, Windows.UI.Notifications, ContentType = WindowsRuntime] > $null',
    '$template = [Windows.UI.Notifications.ToastTemplateType]::ToastText02',
    '$xml = [Windows.UI.Notifications.ToastNotificationManager]::GetTemplateContent($template)',
    '$texts = $xml.GetElementsByTagName("text")',
    `$texts.Item(0).AppendChild($xml.CreateTextNode(${powershellString('Codex Radar')})) > $null`,
    `$texts.Item(1).AppendChild($xml.CreateTextNode(${powershellString(body)})) > $null`,
    '$toast = [Windows.UI.Notifications.ToastNotification]::new($xml)',
    `[Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier(${powershellString('Codex Radar')}).Show($toast)`,
  ].join('\n');
  const spawnImpl = options.spawnImpl || spawn;
  try {
    const child = spawnImpl(windowsPowerShellPath(options.env || process.env), powershellArgs(script), {
      stdio: 'ignore',
      windowsHide: true,
    });
    if (child && typeof child.once === 'function') child.once('error', () => {});
    if (child && typeof child.unref === 'function') child.unref();
    return true;
  } catch (_) {
    return false;
  }
}

function sendLocalNotification(record, options = {}) {
  const platform = options.platform || process.platform;
  if (platform === 'win32') return sendWindowsNotification(record, options);
  if (platform === 'darwin') return sendMacNotification(record);
  return false;
}

function sendMacSound() {
  // The dashboard is intended for macOS.  Avoid attempting to invoke a
  // platform-specific executable when the test suite is run elsewhere.
  if (process.platform !== 'darwin') return false;
  execFile(SYSTEM_SOUND_PLAYER, [SYSTEM_SOUND_PATH], { windowsHide: true }, () => {});
  return true;
}

function startWindowsSleepPrevention(options = {}) {
  const platform = options.platform || process.platform;
  if (platform !== 'win32') return null;
  const script = [
    "Add-Type -TypeDefinition @'",
    'using System;',
    'using System.Runtime.InteropServices;',
    'public static class CodexRadarPower {',
    '  [DllImport("kernel32.dll")] public static extern uint SetThreadExecutionState(uint esFlags);',
    '}',
    "'@",
    '$continuous = [uint32]0x80000000',
    '$systemRequired = [uint32]0x00000001',
    'try {',
    '  while ($true) {',
    '    [CodexRadarPower]::SetThreadExecutionState($continuous -bor $systemRequired) > $null',
    '    Start-Sleep -Seconds 30',
    '  }',
    '} finally {',
    '  [CodexRadarPower]::SetThreadExecutionState($continuous) > $null',
    '}',
  ].join('\n');
  try {
    const child = (options.spawnImpl || spawn)(
      windowsPowerShellPath(options.env || process.env),
      powershellArgs(script),
      { stdio: 'ignore', windowsHide: true },
    );
    if (child && typeof child.once === 'function') child.once('error', () => {});
    return child || null;
  } catch (_) {
    return null;
  }
}

function startMacSleepPrevention(options = {}) {
  const platform = options.platform || process.platform;
  const env = options.env || process.env;
  if (platform !== 'darwin' || env.CODEX_RADAR_CAFFEINATED === '1') return null;
  try {
    const child = (options.spawnImpl || spawn)(
      '/usr/bin/caffeinate',
      ['-i', '-w', String(options.pid || process.pid)],
      { stdio: 'ignore', windowsHide: true },
    );
    if (child && typeof child.once === 'function') child.once('error', () => {});
    return child || null;
  } catch (_) {
    return null;
  }
}

function startSleepPrevention(options = {}) {
  const platform = options.platform || process.platform;
  if (platform === 'win32') return startWindowsSleepPrevention(options);
  if (platform === 'darwin') return startMacSleepPrevention(options);
  return null;
}

function safelyInvokeAlert(handler, record, options) {
  if (typeof handler !== 'function') return false;
  try {
    const result = handler(record, options);
    if (result && typeof result.then === 'function') result.catch(() => {});
    return result;
  } catch (_) {
    return false;
  }
}

function alertResultOk(result) {
  if (result === false) return false;
  if (result && typeof result === 'object' && result.ok === false) return false;
  return true;
}

function isLoopbackAddress(address) {
  const normalized = String(address || '').toLowerCase();
  if (normalized === '::1' || normalized === '0:0:0:0:0:0:0:1') return true;
  const ipv4 = normalized.startsWith('::ffff:') ? normalized.slice('::ffff:'.length) : normalized;
  const parts = ipv4.split('.');
  return parts.length === 4
    && parts[0] === '127'
    && parts.every((part) => /^\d{1,3}$/.test(part) && Number(part) <= 255);
}

function jsonResponse(response, statusCode, body) {
  const data = JSON.stringify(body);
  response.writeHead(statusCode, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
  });
  response.end(data);
}

function createHttpServer(options) {
  const monitor = options.monitor;
  const publicDir = options.publicDir;
  const files = {
    '/': { name: 'index.html', type: 'text/html; charset=utf-8' },
    '/index.html': { name: 'index.html', type: 'text/html; charset=utf-8' },
    '/styles.css': { name: 'styles.css', type: 'text/css; charset=utf-8' },
    '/app.js': { name: 'app.js', type: 'text/javascript; charset=utf-8' },
  };

  return http.createServer(async (request, response) => {
    const requestUrl = new URL(request.url || '/', `http://${request.headers.host || 'localhost'}`);
    if (requestUrl.pathname === '/api/test-alert' || requestUrl.pathname === '/api/stop-alert') {
      if (!isLoopbackAddress(request.socket && request.socket.remoteAddress)) {
        jsonResponse(response, 403, { ok: false, error: '提醒控制只允许本机访问' });
        return;
      }
      if (request.method !== 'POST') {
        response.setHeader('Allow', 'POST');
        jsonResponse(response, 405, {
          ok: false,
          error: requestUrl.pathname === '/api/test-alert' ? '测试强提醒仅支持 POST' : '停止提醒仅支持 POST',
        });
        return;
      }
      const isStopAlert = requestUrl.pathname === '/api/stop-alert';
      try {
        const durationValue = requestUrl.searchParams.get('durationSeconds');
        const testOptions = durationValue === null ? {} : { durationSeconds: Number(durationValue) };
        const rawResult = isStopAlert
          ? (typeof monitor.stopAlert === 'function'
            ? await monitor.stopAlert()
            : (typeof monitor.stopAlarm === 'function' ? await monitor.stopAlarm() : { ok: false, error: '停止提醒暂不可用' }))
          : (typeof monitor.testAlert === 'function'
            ? await monitor.testAlert(testOptions)
            : { ok: false, error: '测试强提醒暂不可用' });
        const result = rawResult && typeof rawResult === 'object'
          ? rawResult
          : { ok: rawResult !== false, message: isStopAlert ? '强提醒已停止' : '测试强提醒已触发' };
        jsonResponse(response, result && result.ok === false ? 500 : 200, result);
      } catch (error) {
        jsonResponse(response, 500, {
          ok: false,
          error: isStopAlert ? '停止提醒失败' : '测试强提醒触发失败',
          detail: safeError(error),
        });
      }
      return;
    }
    if (request.method !== 'GET') {
      response.writeHead(405, { Allow: 'GET' });
      response.end('Method Not Allowed');
      return;
    }
    if (requestUrl.pathname === '/api/status' || requestUrl.pathname === '/api/state') {
      if (requestUrl.searchParams.get('refresh') === '1') await monitor.refresh().catch(() => {});
      jsonResponse(response, 200, monitor.state);
      return;
    }
    if (requestUrl.pathname === '/api/health') {
      jsonResponse(response, 200, { ok: monitor.state.connection.status !== 'offline', connection: monitor.state.connection.status });
      return;
    }
    const file = files[requestUrl.pathname];
    if (!file) {
      response.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      response.end('Not Found');
      return;
    }
    try {
      const filePath = path.join(publicDir, file.name);
      const content = await fs.promises.readFile(filePath);
      response.writeHead(200, { 'Content-Type': file.type, 'Cache-Control': 'no-cache', 'X-Content-Type-Options': 'nosniff' });
      response.end(content);
    } catch (error) {
      jsonResponse(response, 500, { error: '界面文件读取失败', detail: safeError(error) });
    }
  });
}

function checkExistingRadar(host, port, options = {}) {
  const requestImpl = options.requestImpl || http.get;
  const timeoutMs = options.timeoutMs || 1500;
  return new Promise((resolve) => {
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      resolve(Boolean(value));
    };
    let request;
    try {
      request = requestImpl({ hostname: host, port, path: '/api/health', timeout: timeoutMs }, (response) => {
        if (!response || response.statusCode !== 200) {
          if (response && typeof response.resume === 'function') response.resume();
          finish(false);
          return;
        }
        let body = '';
        response.setEncoding('utf8');
        response.on('data', (chunk) => {
          if (body.length < 4096) body += chunk;
        });
        response.on('end', () => {
          try {
            const parsed = JSON.parse(body);
            finish(parsed && typeof parsed.connection === 'string' && typeof parsed.ok === 'boolean');
          } catch (_) {
            finish(false);
          }
        });
        response.on('error', () => finish(false));
      });
    } catch (_) {
      finish(false);
      return;
    }
    if (request && typeof request.on === 'function') {
      request.on('timeout', () => {
        try { request.destroy(); } catch (_) {}
        finish(false);
      });
      request.on('error', () => finish(false));
    }
  });
}

function openBrowser(url) {
  if (process.platform === 'darwin') {
    execFile('open', [url], { windowsHide: true }, () => {});
    return true;
  }
  if (process.platform === 'win32') {
    execFile('explorer.exe', [url], { windowsHide: true }, () => {});
    return true;
  }
  execFile('xdg-open', [url], { windowsHide: true }, () => {});
  return true;
}

async function main(argv = process.argv.slice(2)) {
  const options = parseArgs(argv);
  if (options.help) {
    console.log('用法：双击 CodexRadar.exe / start.command，或 node server.js [--port 3838] [--no-open] [--no-sound] [--alarm-seconds 24]');
    return null;
  }
  const client = new AppServerClient();
  const monitor = new DashboardMonitor({
    client,
    noNotify: options.noNotify,
    noSound: options.noSound,
    alarmSeconds: options.alarmSeconds,
    refreshMs: options.refreshMs,
    staleAfterSeconds: options.staleAfterSeconds,
  });
  const server = createHttpServer({ monitor, publicDir: findPublicDirectory() });
  let sleepPrevention = null;
  const close = () => {
    monitor.stop();
    try {
      if (sleepPrevention && typeof sleepPrevention.kill === 'function') sleepPrevention.kill('SIGTERM');
    } catch (_) {}
    server.close(() => process.exit(0));
  };
  try {
    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(options.port, options.host, resolve);
    });
  } catch (error) {
    const loopbackHost = ['127.0.0.1', 'localhost', '::1'].includes(String(options.host).toLowerCase());
    if (error && error.code === 'EADDRINUSE' && options.port > 0 && loopbackHost
      && await checkExistingRadar(options.host, options.port)) {
      const existingUrl = `http://${options.host}:${options.port}/`;
      monitor.stop();
      if (!options.noOpen) openBrowser(existingUrl);
      console.log(`Codex Radar 已在运行：${existingUrl}`);
      return { server: null, monitor: null, client, url: existingUrl, alreadyRunning: true };
    }
    throw error;
  }
  process.once('SIGINT', close);
  process.once('SIGTERM', close);
  process.once('exit', () => {
    try {
      if (sleepPrevention && typeof sleepPrevention.kill === 'function') sleepPrevention.kill('SIGTERM');
    } catch (_) {}
  });
  sleepPrevention = startSleepPrevention();
  const address = server.address();
  const actualPort = address && typeof address === 'object' ? address.port : options.port;
  const url = `http://${options.host}:${actualPort}/`;
  console.log(`Codex Radar 已启动：${url}`);
  console.log(`数据源：本机 app-server${client.codexPath ? `（${client.codexPath}）` : '（未找到可执行文件）'}`);
  if (process.platform === 'win32' || process.platform === 'darwin') {
    console.log('防休眠：运行期间阻止系统因空闲自动睡眠（不保持屏幕常亮）');
  }
  monitor.start();
  if (!options.noOpen) openBrowser(url);
  return { server, monitor, client, url };
}

if (require.main === module) {
  main().catch((error) => {
    console.error(`Codex Radar 启动失败：${safeError(error)}`);
    process.exitCode = 1;
  });
}

module.exports = {
  APP_SERVER_ARGS,
  AppServerClient,
  AlarmController,
  DashboardMonitor,
  STATUS_LABELS,
  SYSTEM_SOUND_PATH,
  SYSTEM_SOUND_PLAYER,
  STRONG_ALARM_SOUND_PATH,
  STRONG_ALARM_SOUND_PLAYER,
  STRONG_ALARM_SPEECH_PLAYER,
  DEFAULT_ALARM_SECONDS,
  TEST_ALARM_SECONDS,
  MIN_ALARM_SECONDS,
  MAX_ALARM_SECONDS,
  USAGE_URL,
  clamp,
  createHttpServer,
  checkExistingRadar,
  deriveThreadRecord,
  extractModel,
  findCodexPath,
  findSqlitePath,
  findPublicDirectory,
  findWindowsAlarmSound,
  isoFromEpochSeconds,
  mapThreadStatus,
  normalizeAccount,
  normalizeAlarmSeconds,
  normalizeCredits,
  normalizeRateLimits,
  normalizeWindow,
  parseArgs,
  readLocalThreadState,
  redactSecrets,
  safeError,
  sendMacSound,
  sendMacNotification,
  sendWindowsNotification,
  sendLocalNotification,
  startWindowsSleepPrevention,
  startMacSleepPrevention,
  startSleepPrevention,
  codexSpawnSpec,
  powershellArgs,
  alarmSpeechForRecord,
  isLoopbackAddress,
  shortText,
  stripMarkdown,
  summarizeItems,
  toEpochSeconds,
};
