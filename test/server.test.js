'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs');
const { EventEmitter } = require('node:events');

const {
  APP_SERVER_ARGS,
  AppServerClient,
  DashboardMonitor,
  AlarmController,
  createHttpServer,
  deriveThreadRecord,
  isLoopbackAddress,
  mapThreadStatus,
  normalizeRateLimits,
  normalizeWindow,
  parseArgs,
  readLocalThreadState,
  summarizeItems,
  SYSTEM_SOUND_PATH,
  SYSTEM_SOUND_PLAYER,
  STRONG_ALARM_SOUND_PATH,
  STRONG_ALARM_SOUND_PLAYER,
  STRONG_ALARM_SPEECH_PLAYER,
  DEFAULT_ALARM_SECONDS,
  TEST_ALARM_SECONDS,
  MAX_ALARM_SECONDS,
  findCodexPath,
  findSqlitePath,
  codexSpawnSpec,
  powershellArgs,
  sendWindowsNotification,
  startWindowsSleepPrevention,
  startMacSleepPrevention,
  findPublicDirectory,
  checkExistingRadar,
} = require('../server');

test('app-server status and turn status map to clear Chinese states', () => {
  assert.equal(mapThreadStatus({ type: 'active', activeFlags: [] }).kind, 'active');
  assert.equal(mapThreadStatus({ type: 'active', activeFlags: ['waitingOnApproval'] }).kind, 'waitingOnApproval');
  assert.equal(mapThreadStatus({ type: 'active', activeFlags: ['waitingOnUserInput'] }).kind, 'waitingOnUserInput');
  assert.equal(mapThreadStatus({ type: 'systemError' }).kind, 'systemError');
  assert.equal(mapThreadStatus({ type: 'idle' }, { status: 'completed' }).kind, 'completed');
  assert.equal(mapThreadStatus({ type: 'idle' }, { status: 'failed' }).kind, 'failed');
  assert.equal(mapThreadStatus({ type: 'idle' }, { status: 'interrupted' }).kind, 'interrupted');
  assert.equal(mapThreadStatus({ type: 'notLoaded' }, { status: 'inProgress' }).kind, 'active');
});

test('app-server client rejects requests while stopping and handles stdin EPIPE safely', async () => {
  class FakeStdin extends EventEmitter {
    constructor() {
      super();
      this.destroyed = false;
      this.writes = [];
    }
    write(value) {
      this.writes.push(value);
      return true;
    }
  }
  const child = new EventEmitter();
  child.stdin = new FakeStdin();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.kill = () => {
    child.stdin.destroyed = true;
    return true;
  };
  const client = new AppServerClient({
    codexPath: '/fake/codex',
    spawnImpl: () => child,
    requestTimeoutMs: 1000,
  });

  const startPromise = client.start();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(child.stdin.writes.length, 1);
  child.stdout.emit('data', `${JSON.stringify({ jsonrpc: '2.0', id: 1, result: {} })}\n`);
  await startPromise;

  const pending = client.request('thread/list');
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(child.stdin.writes.length, 3);
  const epipe = new Error('write EPIPE');
  epipe.code = 'EPIPE';
  assert.doesNotThrow(() => child.stdin.emit('error', epipe));
  await assert.rejects(pending, /EPIPE/);
  assert.equal(client.child, null);

  client.close();
  await assert.rejects(client.request('thread/list'), /连接已关闭/);
});

test('rate-limit schema is normalized without estimates', () => {
  const usage = normalizeRateLimits({
    rateLimits: {
      limitId: 'codex',
      planType: 'pro',
      primary: { usedPercent: 6, windowDurationMins: 10080, resetsAt: 1788748175 },
      secondary: null,
      credits: { hasCredits: true, unlimited: false, balance: '435.0024367500' },
    },
  }, { account: { type: 'chatgpt', planType: 'pro' } });
  assert.equal(usage.available, true);
  assert.equal(usage.plan, 'pro');
  assert.equal(usage.primary.usedPercent, 6);
  assert.equal(usage.primary.remainingPercent, 94);
  assert.equal(usage.primary.windowDurationMins, 10080);
  assert.equal(usage.credits.balance, '435.0024367500');
  assert.equal(usage.secondary, null);
  assert.equal(normalizeWindow(null), null);
  assert.equal(normalizeRateLimits(null, null).available, false);
});

test('current turn from the local projection wins over standalone notLoaded', () => {
  const record = deriveThreadRecord({
    id: 'thread-1',
    name: '本地任务',
    preview: '本地任务',
    cwd: '/tmp/project',
    modelProvider: 'openai-sse',
    createdAt: 1788180000,
    updatedAt: 1788180100,
    status: { type: 'notLoaded' },
  }, {
    localTurn: { status: 'inProgress', startedAt: 1788180000, items: [] },
    localItems: [{ type: 'commandExecution', command: 'npm test', status: 'inProgress' }],
    localStale: false,
  });
  assert.equal(record.running, true);
  assert.equal(record.status, 'active');
  assert.match(record.summary, /npm test/);

  const stale = deriveThreadRecord({
    id: 'thread-2', name: '陈旧任务', preview: '陈旧任务', cwd: '/tmp', createdAt: 1, updatedAt: 1,
    status: { type: 'notLoaded' },
  }, { localTurn: { status: 'inProgress', startedAt: 1, items: [] }, localStale: true });
  assert.equal(stale.status, 'stale');
  assert.equal(stale.running, false);
  assert.equal(stale.stale, true);
  assert.match(stale.summary, /可能已过期/);
});

test('item summaries are concise and redact secret-looking command values', () => {
  const summary = summarizeItems([
    { type: 'commandExecution', status: 'inProgress', command: 'curl -H "Authorization: Bearer super-secret" --api-key=sk-123456 https://example.test' },
  ]);
  assert.match(summary, /正在执行命令/);
  assert.doesNotMatch(summary, /super-secret|sk-123456/);
  assert.match(summary, /已隐藏/);
});

test('completed or interacted sub-agent lifecycle entries do not look active', () => {
  const summary = summarizeItems([
    { type: 'subAgentActivity', kind: 'completed', agentThreadId: 'child-1' },
    { type: 'subAgentActivity', kind: 'interacted', agentThreadId: 'child-1' },
    { type: 'agentMessage', text: '已完成子任务并回报结果' },
  ]);
  assert.equal(summary, '已完成子任务并回报结果');
});

test('hidden UI panels remain hidden when usage is available', () => {
  const css = fs.readFileSync(require('node:path').join(__dirname, '..', 'public', 'styles.css'), 'utf8');
  assert.match(css, /\[hidden\]\s*\{[^}]*display:\s*none\s*!important/);
});

test('UI exposes a test reminder control wired to the local endpoint', () => {
  const path = require('node:path');
  const html = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');
  const app = fs.readFileSync(path.join(__dirname, '..', 'public', 'app.js'), 'utf8');
  assert.match(html, /id="test-alert-button"/);
  assert.match(html, /测试提醒/);
  assert.match(html, /id="stop-alert-button"/);
  assert.match(html, /停止提醒/);
  assert.match(app, /fetch\('\/api\/test-alert'/);
  assert.match(app, /fetch\('\/api\/stop-alert'/);
  assert.match(app, /method:\s*'POST'/);
});

test('startup completed tasks do not notify, later running-to-terminal does', async () => {
  class FakeClient extends EventEmitter {
    constructor() { super(); this.phase = 'active'; }
    async request(method) {
      const thread = {
        id: 'thread-1', name: '通知测试', preview: '通知测试', cwd: '/tmp', modelProvider: 'openai',
        createdAt: 1788180000, updatedAt: 1788180100,
        status: this.phase === 'active' ? { type: 'active', activeFlags: [] } : { type: 'idle' },
      };
      if (method === 'thread/list') return { data: [thread], nextCursor: null };
      if (method === 'account/read') return { account: { type: 'chatgpt', planType: 'pro' } };
      if (method === 'account/rateLimits/read') return { rateLimits: { primary: { usedPercent: 1 }, planType: 'pro' } };
      if (method === 'thread/turns/list') return { data: [{ id: 'turn-1', status: this.phase === 'active' ? 'inProgress' : 'completed', startedAt: 1788180000, completedAt: this.phase === 'active' ? null : 1788180100, items: [] }] };
      if (method === 'thread/items/list') return { data: [{ turnId: 'turn-1', item: { type: 'agentMessage', text: '正在工作' } }] };
      if (method === 'thread/read') return { thread: { ...thread, turns: [{ id: 'turn-1', status: this.phase === 'active' ? 'inProgress' : 'completed', startedAt: 1788180000, completedAt: this.phase === 'active' ? null : 1788180100, items: [] }] } };
      throw new Error(`unexpected ${method}`);
    }
    close() {}
  }
  const notifications = [];
  const sounds = [];
  const client = new FakeClient();
  const monitor = new DashboardMonitor({ client, notify: (task) => notifications.push(task), playSound: (task) => sounds.push(task), noNotify: false, noSound: false, sqliteReader: () => new Map() });
  await monitor.refresh();
  assert.equal(notifications.length, 0);
  assert.equal(sounds.length, 0);
  client.phase = 'completed';
  await monitor.refresh();
  assert.equal(notifications.length, 1);
  assert.equal(sounds.length, 1);
  await monitor.refresh();
  assert.equal(notifications.length, 1);
  assert.equal(sounds.length, 1);
});

test('notification and sound channels remain independent across terminal transitions', () => {
  const notifications = [];
  const sounds = [];
  const monitor = new DashboardMonitor({
    notify: () => { throw new Error('notification unavailable'); },
    playSound: (task) => sounds.push(task),
    noNotify: false,
    noSound: false,
  });
  const running = { id: 'thread-failure', title: '失败隔离', status: 'active', running: true, terminal: false };
  const failed = { ...running, status: 'failed', statusLabel: '失败', running: false, terminal: true };
  assert.doesNotThrow(() => monitor._detectTransitions([running]));
  assert.doesNotThrow(() => monitor._detectTransitions([failed]));
  assert.equal(sounds.length, 1);
  assert.doesNotThrow(() => monitor._detectTransitions([failed]));
  assert.equal(sounds.length, 1);

  const noNotify = [];
  const soundWithNoNotify = new DashboardMonitor({
    notify: (task) => noNotify.push(task),
    playSound: (task) => sounds.push(task),
    noNotify: true,
    noSound: false,
  });
  soundWithNoNotify._detectTransitions([{ ...running, id: 'thread-no-notify' }]);
  soundWithNoNotify._detectTransitions([{ ...failed, id: 'thread-no-notify' }]);
  assert.equal(noNotify.length, 0);
  assert.equal(sounds.length, 2);

  const notifyWithNoSound = [];
  const noSoundMonitor = new DashboardMonitor({
    notify: (task) => notifyWithNoSound.push(task),
    playSound: () => { throw new Error('sound unavailable'); },
    noNotify: false,
    noSound: true,
  });
  noSoundMonitor._detectTransitions([{ ...running, id: 'thread-no-sound' }]);
  noSoundMonitor._detectTransitions([{ ...failed, id: 'thread-no-sound' }]);
  assert.equal(notifyWithNoSound.length, 1);
});

test('completed, failed, and interrupted transitions each alert once', () => {
  for (const status of ['completed', 'failed', 'interrupted']) {
    const notifications = [];
    const sounds = [];
    const monitor = new DashboardMonitor({
      notify: (record) => notifications.push(record.status),
      playSound: (record) => sounds.push(record.status),
      noNotify: false,
      noSound: false,
    });
    const id = `thread-${status}`;
    monitor._detectTransitions([{ id, status: 'active', running: true, terminal: false }]);
    monitor._detectTransitions([{ id, status, running: false, terminal: true }]);
    monitor._detectTransitions([{ id, status, running: false, terminal: true }]);
    assert.deepEqual(notifications, [status]);
    assert.deepEqual(sounds, [status]);
  }
});

test('default sound uses a built-in macOS system sound path', () => {
  assert.equal(SYSTEM_SOUND_PLAYER, '/usr/bin/afplay');
  assert.equal(SYSTEM_SOUND_PATH, '/System/Library/Sounds/Glass.aiff');
});

test('Windows discovers packaged Codex and bundled sqlite tools', () => {
  const existing = new Set([
    'C:\\Users\\tester\\AppData\\Local\\Programs\\ChatGPT\\resources\\codex.exe',
    'C:\\Radar\\tools\\sqlite3.exe',
  ]);
  const statSyncImpl = (candidate) => {
    if (!existing.has(candidate)) throw new Error('missing');
    return { isFile: () => true, mode: 0 };
  };
  const codex = findCodexPath({
    platform: 'win32',
    homeDir: 'C:\\Users\\tester',
    execPath: 'C:\\Radar\\CodexRadar.exe',
    env: {
      LOCALAPPDATA: 'C:\\Users\\tester\\AppData\\Local',
      ProgramFiles: 'C:\\Program Files',
      PATH: '',
    },
    statSyncImpl,
    readdirSyncImpl: () => [],
  });
  assert.equal(codex, 'C:\\Users\\tester\\AppData\\Local\\Programs\\ChatGPT\\resources\\codex.exe');
  assert.equal(findSqlitePath({
    platform: 'win32',
    baseDir: 'C:\\Radar',
    execPath: 'C:\\Radar\\CodexRadar.exe',
    env: { PATH: '' },
    statSyncImpl,
  }), 'C:\\Radar\\tools\\sqlite3.exe');
});

test('Windows command adapters use cmd for npm shims and encoded PowerShell', () => {
  const spec = codexSpawnSpec('C:\\Tools\\codex.cmd', APP_SERVER_ARGS, 'win32', { ComSpec: 'C:\\Windows\\System32\\cmd.exe' });
  assert.equal(spec.command, 'C:\\Windows\\System32\\cmd.exe');
  assert.deepEqual(spec.args.slice(0, 3), ['/d', '/s', '/c']);
  assert.match(spec.args[3], /codex\.cmd.*app-server.*stdio:\/\//);

  const encoded = powershellArgs('Write-Output "任务完成"');
  assert.equal(encoded.at(-2), '-EncodedCommand');
  assert.equal(Buffer.from(encoded.at(-1), 'base64').toString('utf16le'), 'Write-Output "任务完成"');
});

test('Windows alarm uses bundled WAV, speech, toast, and an idle-sleep guard', () => {
  const calls = [];
  const child = new EventEmitter();
  child.kill = () => true;
  child.unref = () => {};
  const spawnImpl = (command, args, options) => {
    calls.push({ command, args, options });
    return child;
  };
  const alarm = new AlarmController({
    platform: 'win32',
    env: { SystemRoot: 'C:\\Windows' },
    soundPath: 'C:\\Radar\\assets\\alarm.wav',
    spawnImpl,
    setTimeoutImpl: (callback, ms) => ({ callback, ms, unref() {} }),
    setIntervalImpl: (callback, ms) => ({ callback, ms, unref() {} }),
  });
  const result = alarm.start({ status: 'completed' });
  assert.equal(result.started, true);
  assert.equal(calls.length, 2);
  assert.equal(calls[0].command, 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe');
  const soundScript = Buffer.from(calls[0].args.at(-1), 'base64').toString('utf16le');
  const speechScript = Buffer.from(calls[1].args.at(-1), 'base64').toString('utf16le');
  assert.match(soundScript, /alarm\.wav/);
  assert.match(soundScript, /SoundPlayer/);
  assert.match(speechScript, /SpeechSynthesizer/);
  assert.match(speechScript, /Codex 任务完成了/);
  alarm.stopAlarm();

  assert.equal(sendWindowsNotification({ title: '测试', statusLabel: '已完成' }, {
    spawnImpl,
    env: { SystemRoot: 'C:\\Windows' },
  }), true);
  const toastScript = Buffer.from(calls.at(-1).args.at(-1), 'base64').toString('utf16le');
  assert.match(toastScript, /ToastNotificationManager/);
  assert.match(toastScript, /测试/);

  const guard = startWindowsSleepPrevention({
    platform: 'win32',
    spawnImpl,
    env: { SystemRoot: 'C:\\Windows' },
  });
  assert.equal(guard, child);
  const guardScript = Buffer.from(calls.at(-1).args.at(-1), 'base64').toString('utf16le');
  assert.match(guardScript, /SetThreadExecutionState/);
  assert.doesNotMatch(guardScript, /DISPLAY_REQUIRED/i);
});

test('macOS app bundle resolves Resources/public and owns a caffeinate guard', () => {
  const expected = '/Applications/Codex Radar.app/Contents/Resources/public';
  const publicDir = findPublicDirectory({
    baseDir: '/Applications/Codex Radar.app/Contents/MacOS',
    statSyncImpl: (candidate) => ({ isDirectory: () => candidate === expected }),
  });
  assert.equal(publicDir, expected);

  const calls = [];
  const child = new EventEmitter();
  child.kill = () => true;
  const guard = startMacSleepPrevention({
    platform: 'darwin',
    env: {},
    pid: 4321,
    spawnImpl: (command, args, options) => {
      calls.push({ command, args, options });
      return child;
    },
  });
  assert.equal(guard, child);
  assert.equal(calls[0].command, '/usr/bin/caffeinate');
  assert.deepEqual(calls[0].args, ['-i', '-w', '4321']);
  assert.equal(startMacSleepPrevention({ platform: 'darwin', env: { CODEX_RADAR_CAFFEINATED: '1' } }), null);
});

test('existing Radar probe recognizes only the local health response', async () => {
  let valid = true;
  const server = http.createServer((request, response) => {
    response.writeHead(200, { 'Content-Type': 'application/json' });
    response.end(valid ? JSON.stringify({ ok: true, connection: 'connected' }) : JSON.stringify({ status: 'other-service' }));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  try {
    assert.equal(await checkExistingRadar('127.0.0.1', port), true);
    valid = false;
    assert.equal(await checkExistingRadar('127.0.0.1', port), false);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test('strong alarm repeats built-in sound and speech, stays single-session, and stops children', () => {
  const spawnCalls = [];
  const children = [];
  const clearedTimeouts = [];
  const clearedIntervals = [];
  const spawnImpl = (command, args, options) => {
    const child = new EventEmitter();
    child.killCalls = [];
    child.kill = (signal) => { child.killCalls.push(signal); return true; };
    children.push(child);
    spawnCalls.push({ command, args, options });
    return child;
  };
  const alarm = new AlarmController({
    spawnImpl,
    setTimeoutImpl: (callback, ms) => ({ callback, ms, unref() {} }),
    clearTimeoutImpl: (timer) => clearedTimeouts.push(timer),
    setIntervalImpl: (callback, ms) => ({ callback, ms, unref() {} }),
    clearIntervalImpl: (timer) => clearedIntervals.push(timer),
  });

  const first = alarm.start({ status: 'completed' });
  assert.equal(first.ok, true);
  assert.equal(first.durationSeconds, DEFAULT_ALARM_SECONDS);
  assert.equal(first.active, true);
  assert.equal(spawnCalls.length, 2);
  assert.deepEqual(spawnCalls[0].args, [STRONG_ALARM_SOUND_PATH]);
  assert.equal(spawnCalls[0].command, STRONG_ALARM_SOUND_PLAYER);
  assert.equal(spawnCalls[1].command, STRONG_ALARM_SPEECH_PLAYER);
  assert.equal(spawnCalls[1].args[0], 'Codex 任务完成了，请查看结果');

  const second = alarm.start({ status: 'failed' }, { durationSeconds: 100 });
  assert.equal(second.durationSeconds, MAX_ALARM_SECONDS);
  assert.equal(first.active, true);
  assert.deepEqual(children.slice(0, 2).map((child) => child.killCalls), [['SIGTERM'], ['SIGTERM']]);
  assert.equal(spawnCalls.length, 4);
  assert.equal(spawnCalls[3].args[0], 'Codex 任务失败了，请查看结果');

  const stopped = alarm.stopAlarm();
  assert.equal(stopped.ok, true);
  assert.equal(stopped.stopped, true);
  assert.equal(stopped.active, false);
  assert.equal(clearedTimeouts.length, 2);
  assert.equal(clearedIntervals.length, 2);
  assert.deepEqual(children.slice(2).map((child) => child.killCalls), [['SIGTERM'], ['SIGTERM']]);
  assert.equal(alarm.isActive(), false);
  assert.equal(alarm.stopAlarm().stopped, false);
});

test('test strong alarm uses a short bounded duration and no-sound skips all child processes', () => {
  const calls = [];
  const alarm = new AlarmController({
    spawnImpl: (command, args) => {
      calls.push([command, args]);
      const child = new EventEmitter();
      child.kill = () => true;
      return child;
    },
    setTimeoutImpl: (callback, ms) => ({ callback, ms, unref() {} }),
    setIntervalImpl: (callback, ms) => ({ callback, ms, unref() {} }),
  });
  const monitor = new DashboardMonitor({ alarm, noNotify: true, noSound: false, notify: () => {} });
  const result = monitor.testAlert();
  assert.equal(result.ok, true);
  assert.equal(result.sound.detail.durationSeconds, TEST_ALARM_SECONDS);
  assert.equal(calls.length, 2);

  const mutedCalls = [];
  const muted = new AlarmController({ noSound: true, spawnImpl: (...args) => mutedCalls.push(args) });
  const mutedResult = muted.start({ status: 'completed' });
  assert.equal(mutedResult.ok, true);
  assert.equal(mutedResult.enabled, false);
  assert.equal(mutedCalls.length, 0);
});

test('testAlert triggers both channels and respects independent switches', () => {
  const calls = [];
  const monitor = new DashboardMonitor({
    notify: (record) => calls.push(['notification', record.statusLabel]),
    playSound: (record) => calls.push(['sound', record.statusLabel]),
    noNotify: false,
    noSound: false,
  });
  const result = monitor.testAlert();
  assert.equal(result.ok, true);
  assert.deepEqual(calls, [['notification', '测试提醒'], ['sound', '测试提醒']]);
  assert.equal(result.notification.enabled, true);
  assert.equal(result.sound.enabled, true);

  const muted = new DashboardMonitor({
    notify: () => calls.push(['muted-notification']),
    playSound: () => calls.push(['muted-sound']),
    noNotify: true,
    noSound: true,
  }).testAlert();
  assert.equal(muted.ok, true);
  assert.equal(muted.notification.enabled, false);
  assert.equal(muted.sound.enabled, false);
  assert.deepEqual(calls, [['notification', '测试提醒'], ['sound', '测试提醒']]);
});

test('SQLite-complete historical threads do not trigger redundant detail calls', async () => {
  class CountingClient extends EventEmitter {
    constructor() { super(); this.detailCalls = 0; }
    async request(method) {
      if (method === 'thread/list') {
        return { data: Array.from({ length: 40 }, (_, index) => ({
          id: `thread-${index}`, name: `历史任务 ${index}`, preview: '历史任务', cwd: '/tmp', modelProvider: 'openai',
          createdAt: 1788180000, updatedAt: 1788180100, status: { type: 'notLoaded' },
        })), nextCursor: null };
      }
      if (method === 'account/read') return { account: { type: 'chatgpt', planType: 'pro' } };
      if (method === 'account/rateLimits/read') return { rateLimits: { primary: { usedPercent: 1 }, planType: 'pro' } };
      this.detailCalls += 1;
      throw new Error(`unexpected detail ${method}`);
    }
    close() {}
  }
  const client = new CountingClient();
  const sqliteReader = (ids) => new Map(ids.map((id) => [id, {
    latestTurn: { status: 'completed', startedAt: 1788180000, completedAt: 1788180100, items: [] },
    items: [{ type: 'agentMessage', text: '已完成' }],
    lastActivityAt: 1788180100,
  }]));
  const monitor = new DashboardMonitor({ client, sqliteReader, noNotify: true });
  await monitor.refresh();
  assert.equal(client.detailCalls, 0);
  assert.equal(monitor.state.runningCount, 0);
  assert.equal(monitor.state.completed.length, 30);
});

test('SQLite reader ignores invalid IDs and missing databases', () => {
  assert.equal(readLocalThreadState(['../secrets', ''], '/tmp/does-not-exist.sqlite').size, 0);
});

test('argument parsing supports test port and no-open', () => {
  const args = parseArgs(['--port', '0', '--no-open', '--refresh-ms=1200', '--no-sound']);
  assert.equal(args.port, 0);
  assert.equal(args.noOpen, true);
  assert.equal(args.refreshMs, 1200);
  assert.equal(args.noSound, true);
});

test('Finder launcher uses temporary caffeinate idle-sleep prevention without display flag', () => {
  const launcher = fs.readFileSync(require('node:path').join(__dirname, '..', 'start.command'), 'utf8');
  assert.match(launcher, /\/usr\/bin\/caffeinate/);
  assert.match(launcher, /caffeinate["']?\s+-i\s+\S*\s+\S*server\.js/);
  assert.doesNotMatch(launcher, /caffeinate[^\n]*\s-d(?:\s|$)/);
});

test('test-alert endpoint is localhost-only POST and always returns JSON', async () => {
  const calls = [];
  const monitor = {
    state: { runningCount: 0, running: [], completed: [], usage: { available: false, message: '暂不可用' }, connection: { status: 'connected' } },
    async refresh() {},
    testAlert() {
      calls.push('test-alert');
      return { ok: true, notification: { enabled: true, attempted: true, ok: true }, sound: { enabled: true, attempted: true, ok: true } };
    },
  };
  const server = createHttpServer({ monitor, publicDir: require('node:path').join(__dirname, '..', 'public') });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  const request = (method, requestPath) => new Promise((resolve, reject) => {
    const clientRequest = http.request({ hostname: '127.0.0.1', port: address.port, path: requestPath, method }, (response) => {
      let data = '';
      response.setEncoding('utf8');
      response.on('data', (chunk) => { data += chunk; });
      response.on('end', () => resolve({ status: response.statusCode, headers: response.headers, data }));
    });
    clientRequest.on('error', reject);
    clientRequest.end();
  });

  try {
    const post = await request('POST', '/api/test-alert');
    assert.equal(post.status, 200);
    assert.match(post.headers['content-type'], /application\/json/);
    assert.equal(JSON.parse(post.data).ok, true);
    assert.deepEqual(calls, ['test-alert']);

    const get = await request('GET', '/api/test-alert');
    assert.equal(get.status, 405);
    assert.equal(get.headers.allow, 'POST');
    assert.equal(JSON.parse(get.data).ok, false);
    assert.deepEqual(calls, ['test-alert']);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test('stop-alert endpoint is localhost-only POST and calls the alarm stop hook', async () => {
  const calls = [];
  const monitor = {
    state: { runningCount: 0, running: [], completed: [], usage: { available: false }, connection: { status: 'connected' } },
    async refresh() {},
    stopAlert() {
      calls.push('stop-alert');
      return { ok: true, stopped: true, active: false, message: '强提醒已停止' };
    },
  };
  const server = createHttpServer({ monitor, publicDir: require('node:path').join(__dirname, '..', 'public') });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  const request = (method, requestPath) => new Promise((resolve, reject) => {
    const clientRequest = http.request({ hostname: '127.0.0.1', port: address.port, path: requestPath, method }, (response) => {
      let data = '';
      response.setEncoding('utf8');
      response.on('data', (chunk) => { data += chunk; });
      response.on('end', () => resolve({ status: response.statusCode, headers: response.headers, data }));
    });
    clientRequest.on('error', reject);
    clientRequest.end();
  });

  try {
    const post = await request('POST', '/api/stop-alert');
    assert.equal(post.status, 200);
    assert.match(post.headers['content-type'], /application\/json/);
    assert.equal(JSON.parse(post.data).stopped, true);
    assert.deepEqual(calls, ['stop-alert']);

    const get = await request('GET', '/api/stop-alert');
    assert.equal(get.status, 405);
    assert.equal(get.headers.allow, 'POST');
    assert.equal(JSON.parse(get.data).ok, false);
    assert.deepEqual(calls, ['stop-alert']);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test('loopback address check accepts local IPv4 and IPv6 only', () => {
  assert.equal(isLoopbackAddress('127.0.0.1'), true);
  assert.equal(isLoopbackAddress('::ffff:127.0.0.1'), true);
  assert.equal(isLoopbackAddress('::1'), true);
  assert.equal(isLoopbackAddress('192.168.1.2'), false);
  assert.equal(isLoopbackAddress(''), false);
});

test('local HTTP API exposes the current state without raw protocol data', async () => {
  const monitor = { state: { runningCount: 1, running: [], completed: [], usage: { available: false, message: '暂不可用' }, connection: { status: 'connected' } }, async refresh() {} };
  const server = createHttpServer({ monitor, publicDir: require('node:path').join(__dirname, '..', 'public') });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  const body = await new Promise((resolve, reject) => {
    http.get({ hostname: '127.0.0.1', port: address.port, path: '/api/status' }, (response) => {
      let data = '';
      response.setEncoding('utf8');
      response.on('data', (chunk) => { data += chunk; });
      response.on('end', () => resolve({ status: response.statusCode, data }));
    }).on('error', reject);
  });
  await new Promise((resolve) => server.close(resolve));
  assert.equal(body.status, 200);
  assert.equal(JSON.parse(body.data).usage.message, '暂不可用');
});
