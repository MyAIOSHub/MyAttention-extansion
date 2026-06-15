#!/usr/bin/env node

import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import { createServer as createNetServer } from 'node:net';
import { homedir, tmpdir } from 'node:os';
import { basename, resolve } from 'node:path';
import { TLSSocket, createSecureContext } from 'node:tls';

const ROOT = process.cwd();
const DIST_DIR = resolve(ROOT, 'dist');
const SYSTEM_CHROME_PATHS = [
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Chromium.app/Contents/MacOS/Chromium',
  '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
];
const DEFAULT_CHROME_PATHS = [
  process.env.CHROME_BIN,
  ...findCachedChromiumExecutables(),
  ...SYSTEM_CHROME_PATHS,
].filter(Boolean);

const REQUIRED_DIST_FILES = [
  'manifest.json',
  'background.js',
  'content-script.js',
  'popup.js',
  'html/popup.html',
  'html/options.html',
  'html/simulcast_offscreen.html',
  'simulcast-offscreen.js',
];

const AST_EVENTS = {
  StartSession: 100,
  FinishSession: 102,
  SessionStarted: 150,
  TaskRequest: 200,
  SourceSubtitleResponse: 651,
  TranslationSubtitleResponse: 654,
};

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

function findChromeExecutable() {
  const candidate = DEFAULT_CHROME_PATHS.find((path) => path && existsSync(path));
  if (!candidate) {
    throw new Error('Chrome executable not found. Set CHROME_BIN to a Chrome/Chromium binary.');
  }
  return candidate;
}

function findCachedChromiumExecutables() {
  const candidates = [];
  const codexBrowserRoot = resolve(homedir(), 'Library/Caches/codex-browsers/chromium');

  if (existsSync(codexBrowserRoot)) {
    for (const buildDir of safeReadDir(codexBrowserRoot)) {
      candidates.push(
        resolve(
          codexBrowserRoot,
          buildDir,
          'chrome-mac/Chromium.app/Contents/MacOS/Chromium'
        )
      );
    }
  }

  return candidates;
}

function safeReadDir(path) {
  try {
    return readdirSync(path);
  } catch {
    return [];
  }
}

function verifyDistArtifacts() {
  for (const relativePath of REQUIRED_DIST_FILES) {
    const filePath = resolve(DIST_DIR, relativePath);
    assert(existsSync(filePath), `Missing dist artifact: ${relativePath}. Run npm run build first.`);
  }

  const manifest = JSON.parse(readFileSync(resolve(DIST_DIR, 'manifest.json'), 'utf8'));
  assert(
    manifest.permissions?.includes('offscreen') &&
      manifest.permissions?.includes('tabCapture') &&
      manifest.permissions?.includes('declarativeNetRequestWithHostAccess'),
    'dist manifest is missing required simulcast permissions.'
  );
}

function startFixtureServer() {
  const server = createServer(async (request, response) => {
    const url = new URL(request.url ?? '/', 'http://127.0.0.1');

    if (request.method === 'OPTIONS') {
      response.writeHead(204, corsHeaders());
      response.end();
      return;
    }

    if (url.pathname === '/sample.html') {
      response.writeHead(200, {
        'Content-Type': 'text/html; charset=utf-8',
      });
      response.end(`<!doctype html>
<html>
  <head><title>SaySo Translation Runtime Fixture</title></head>
  <body>
    <main role="main" class="fern-docs-page">
      <div class="heading-xl">Runtime verification</div>
      <div class="text-base">Hello from browser translation runtime.</div>
      <div class="text-base">The plugin injects generated documentation content through div blocks.</div>
      <video id="runtime-video" playsinline controls style="width: 320px; height: 180px"></video>
      <button id="start-runtime-media">Start runtime media</button>
    </main>
    <script>
      window.startRuntimeMedia = async () => {
        const audioContext = new AudioContext();
        const oscillator = audioContext.createOscillator();
        const gain = audioContext.createGain();
        const audioDestination = audioContext.createMediaStreamDestination();
        oscillator.frequency.value = 440;
        gain.gain.value = 0.08;
        oscillator.connect(gain);
        gain.connect(audioDestination);

        const canvas = document.createElement('canvas');
        canvas.width = 320;
        canvas.height = 180;
        const context = canvas.getContext('2d');
        context.fillStyle = '#1f2937';
        context.fillRect(0, 0, canvas.width, canvas.height);
        context.fillStyle = '#fff';
        context.font = '20px sans-serif';
        context.fillText('Runtime media', 88, 95);

        const mediaStream = canvas.captureStream(10);
        mediaStream.addTrack(audioDestination.stream.getAudioTracks()[0]);
        const video = document.getElementById('runtime-video');
        video.srcObject = mediaStream;
        oscillator.start();
        await audioContext.resume();
        await video.play();
        window.__runtimeMedia = { audioContext, oscillator, mediaStream };
        return {
          audioTracks: mediaStream.getAudioTracks().length,
          videoTracks: mediaStream.getVideoTracks().length,
          paused: video.paused
        };
      };
      document.getElementById('start-runtime-media').addEventListener('click', () => {
        window.startRuntimeMedia();
      });
    </script>
  </body>
</html>`);
      return;
    }

    if (url.pathname === '/v1/chat/completions') {
      await readRequestBody(request);
      response.writeHead(200, {
        ...corsHeaders(),
        'Content-Type': 'application/json; charset=utf-8',
      });
      response.end(
        JSON.stringify({
          choices: [
            {
              message: {
                content: JSON.stringify({
                  translations: [
                    { id: 'sayso-t-1', text: '运行时验证' },
                    { id: 'sayso-t-2', text: '来自浏览器翻译运行时的问候。' },
                  ],
                }),
              },
            },
          ],
        })
      );
      return;
    }

    response.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    response.end('not found');
  });

  return new Promise((resolvePromise, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      assert(address && typeof address === 'object', 'Unable to allocate fixture server port.');
      resolvePromise({
        server,
        origin: `http://127.0.0.1:${address.port}`,
      });
    });
  });
}

function corsHeaders() {
  return {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'authorization, content-type',
    'Access-Control-Allow-Methods': 'POST, GET, OPTIONS',
  };
}

function readRequestBody(request) {
  return new Promise((resolvePromise, reject) => {
    const chunks = [];
    request.on('data', (chunk) => chunks.push(chunk));
    request.on('end', () => resolvePromise(Buffer.concat(chunks).toString('utf8')));
    request.on('error', reject);
  });
}

function pickDebuggingPort() {
  return 9300 + Math.floor(Math.random() * 500);
}

async function launchChrome({ chromePath, userDataDir, debuggingPort, astProxyPort }) {
  const args = [
    `--user-data-dir=${userDataDir}`,
    `--remote-debugging-port=${debuggingPort}`,
    `--disable-extensions-except=${DIST_DIR}`,
    `--load-extension=${DIST_DIR}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-background-networking',
    '--disable-sync',
    '--disable-component-update',
    '--disable-features=Translate',
    '--ignore-certificate-errors',
    'about:blank',
  ];

  if (astProxyPort) {
    args.push(`--proxy-server=127.0.0.1:${astProxyPort}`);
    args.push('--proxy-bypass-list=127.0.0.1;localhost');
  }

  if (process.env.EXT_VERIFY_HEADLESS === '1') {
    args.push('--headless=new');
  }

  const child = spawn(chromePath, args, {
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  child.stdout.on('data', (chunk) => {
    if (process.env.EXT_VERIFY_DEBUG) {
      process.stdout.write(`[chrome] ${chunk}`);
    }
  });
  child.stderr.on('data', (chunk) => {
    if (process.env.EXT_VERIFY_DEBUG) {
      process.stderr.write(`[chrome] ${chunk}`);
    }
  });

  child.once('exit', (code) => {
    if (code !== null && code !== 0 && process.env.EXT_VERIFY_DEBUG) {
      console.error(`[verify:extension-runtime] Chrome exited with code ${code}`);
    }
  });

  return child;
}

async function startMockAstProxy(workDir) {
  const cert = createSelfSignedCertificate(workDir);
  const secureContext = createSecureContext(cert);
  const state = {
    connectRequests: [],
    handshakes: [],
    startSessions: 0,
    taskRequests: 0,
    finishSessions: 0,
    binaryFrames: 0,
    authHeaderOk: false,
    sessionId: '',
    subtitleSent: false,
  };

  const server = createNetServer((socket) => {
    let connectBuffer = Buffer.alloc(0);
    socket.once('error', () => undefined);
    socket.on('data', function onConnectData(chunk) {
      connectBuffer = Buffer.concat([connectBuffer, chunk]);
      const headerEnd = connectBuffer.indexOf('\r\n\r\n');
      if (headerEnd === -1) {
        return;
      }

      socket.off('data', onConnectData);
      const headerText = connectBuffer.slice(0, headerEnd).toString('utf8');
      const [connectLine] = headerText.split('\r\n');
      state.connectRequests.push(connectLine);

      if (connectLine !== 'CONNECT openspeech.bytedance.com:443 HTTP/1.1') {
        socket.end('HTTP/1.1 502 Bad Gateway\r\n\r\n');
        return;
      }

      socket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      const tlsSocket = new TLSSocket(socket, {
        isServer: true,
        secureContext,
      });
      attachMockAstWebSocket(tlsSocket, state);
    });
  });

  await new Promise((resolvePromise, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolvePromise);
  });

  const address = server.address();
  assert(address && typeof address === 'object', 'Unable to allocate mock AST proxy port.');

  return {
    server,
    state,
    port: address.port,
  };
}

function createSelfSignedCertificate(workDir) {
  const keyPath = resolve(workDir, 'mock-ast.key.pem');
  const certPath = resolve(workDir, 'mock-ast.cert.pem');
  const result = spawnSync(
    'openssl',
    [
      'req',
      '-x509',
      '-newkey',
      'rsa:2048',
      '-nodes',
      '-keyout',
      keyPath,
      '-out',
      certPath,
      '-days',
      '1',
      '-subj',
      '/CN=openspeech.bytedance.com',
    ],
    { stdio: 'ignore' }
  );

  assert(result.status === 0, 'Unable to create mock AST TLS certificate with openssl.');
  return {
    key: readFileSync(keyPath),
    cert: readFileSync(certPath),
  };
}

function attachMockAstWebSocket(tlsSocket, state) {
  let handshakeBuffer = Buffer.alloc(0);
  let websocketBuffer = Buffer.alloc(0);
  let upgraded = false;

  tlsSocket.once('error', () => undefined);
  tlsSocket.on('data', (chunk) => {
    if (!upgraded) {
      handshakeBuffer = Buffer.concat([handshakeBuffer, chunk]);
      const headerEnd = handshakeBuffer.indexOf('\r\n\r\n');
      if (headerEnd === -1) {
        return;
      }

      const headerText = handshakeBuffer.slice(0, headerEnd).toString('utf8');
      const { requestLine, headers } = parseHttpHeaders(headerText);
      state.handshakes.push({ requestLine, headers });
      state.authHeaderOk =
        headers['x-api-key'] === 'runtime-ast-key' &&
        headers['x-api-resource-id'] === 'volc.service_type.10053';
      acceptWebSocket(tlsSocket, headers['sec-websocket-key']);
      upgraded = true;

      const remaining = handshakeBuffer.slice(headerEnd + 4);
      if (remaining.length > 0) {
        websocketBuffer = Buffer.concat([websocketBuffer, remaining]);
      }
    } else {
      websocketBuffer = Buffer.concat([websocketBuffer, chunk]);
    }

    const parsed = parseClientWebSocketFrames(websocketBuffer);
    websocketBuffer = parsed.remaining;
    parsed.frames.forEach((frame) => handleAstFrame(tlsSocket, state, frame));
  });
}

function parseHttpHeaders(headerText) {
  const lines = headerText.split('\r\n');
  const requestLine = lines.shift() ?? '';
  const headers = {};
  lines.forEach((line) => {
    const separator = line.indexOf(':');
    if (separator === -1) {
      return;
    }
    headers[line.slice(0, separator).trim().toLowerCase()] = line
      .slice(separator + 1)
      .trim();
  });
  return { requestLine, headers };
}

function acceptWebSocket(socket, key) {
  const accept = createHash('sha1')
    .update(`${key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`)
    .digest('base64');
  socket.write(
    [
      'HTTP/1.1 101 Switching Protocols',
      'Upgrade: websocket',
      'Connection: Upgrade',
      `Sec-WebSocket-Accept: ${accept}`,
      '\r\n',
    ].join('\r\n')
  );
}

function parseClientWebSocketFrames(buffer) {
  const frames = [];
  let offset = 0;

  while (offset + 2 <= buffer.length) {
    const first = buffer[offset];
    const second = buffer[offset + 1];
    const opcode = first & 0x0f;
    const masked = (second & 0x80) !== 0;
    let length = second & 0x7f;
    let headerLength = 2;

    if (length === 126) {
      if (offset + 4 > buffer.length) {
        break;
      }
      length = buffer.readUInt16BE(offset + 2);
      headerLength = 4;
    } else if (length === 127) {
      if (offset + 10 > buffer.length) {
        break;
      }
      const high = buffer.readUInt32BE(offset + 2);
      const low = buffer.readUInt32BE(offset + 6);
      length = high * 2 ** 32 + low;
      headerLength = 10;
    }

    const maskLength = masked ? 4 : 0;
    const frameEnd = offset + headerLength + maskLength + length;
    if (frameEnd > buffer.length) {
      break;
    }

    let payload = buffer.slice(offset + headerLength + maskLength, frameEnd);
    if (masked) {
      const mask = buffer.slice(offset + headerLength, offset + headerLength + 4);
      payload = Buffer.from(payload.map((byte, index) => byte ^ mask[index % 4]));
    }

    frames.push({ opcode, payload });
    offset = frameEnd;
  }

  return {
    frames,
    remaining: buffer.slice(offset),
  };
}

function handleAstFrame(socket, state, frame) {
  if (frame.opcode === 8) {
    socket.end();
    return;
  }
  if (frame.opcode !== 2) {
    return;
  }

  state.binaryFrames += 1;
  const request = decodeAstRequestFrame(frame.payload);
  if (request.sessionId) {
    state.sessionId = request.sessionId;
  }

  if (request.event === AST_EVENTS.StartSession) {
    state.startSessions += 1;
    socket.write(buildServerWebSocketFrame(encodeAstResponseFrame({
      event: AST_EVENTS.SessionStarted,
      sessionId: request.sessionId,
      text: 'session started',
    })));
    setTimeout(() => {
      state.subtitleSent = true;
      socket.write(buildServerWebSocketFrame(encodeAstResponseFrame({
        event: AST_EVENTS.SourceSubtitleResponse,
        sessionId: request.sessionId,
        text: 'runtime source subtitle',
        startTime: 1000,
        endTime: 1600,
        speakerId: 'speaker-a',
      })));
      socket.write(buildServerWebSocketFrame(encodeAstResponseFrame({
        event: AST_EVENTS.TranslationSubtitleResponse,
        sessionId: request.sessionId,
        text: '运行时同传字幕',
        startTime: 1000,
        endTime: 1600,
        speakerId: 'speaker-a',
      })));
    }, 300);
  } else if (request.event === AST_EVENTS.TaskRequest) {
    state.taskRequests += 1;
  } else if (request.event === AST_EVENTS.FinishSession) {
    state.finishSessions += 1;
  }
}

function buildServerWebSocketFrame(payload) {
  const length = payload.length;
  if (length < 126) {
    return Buffer.concat([Buffer.from([0x82, length]), Buffer.from(payload)]);
  }
  if (length <= 0xffff) {
    const header = Buffer.alloc(4);
    header[0] = 0x82;
    header[1] = 126;
    header.writeUInt16BE(length, 2);
    return Buffer.concat([header, Buffer.from(payload)]);
  }
  throw new Error('Mock AST response is too large.');
}

function decodeAstRequestFrame(bytes) {
  const reader = new ProtoReader(bytes);
  const request = {
    event: 0,
    sessionId: '',
  };

  while (!reader.done()) {
    const tag = reader.readTag();
    if (tag.field === 1 && tag.wireType === 2) {
      request.sessionId = decodeRequestMeta(reader.readBytes()).sessionId;
    } else if (tag.field === 2 && tag.wireType === 0) {
      request.event = reader.readVarint();
    } else {
      reader.skip(tag.wireType);
    }
  }

  return request;
}

function decodeRequestMeta(bytes) {
  const reader = new ProtoReader(bytes);
  const meta = { sessionId: '' };
  while (!reader.done()) {
    const tag = reader.readTag();
    if (tag.field === 6 && tag.wireType === 2) {
      meta.sessionId = reader.readString();
    } else {
      reader.skip(tag.wireType);
    }
  }
  return meta;
}

function encodeAstResponseFrame({
  event,
  sessionId,
  text,
  startTime = 0,
  endTime = 320,
  speakerId = '',
}) {
  const meta = new Uint8Array([
    ...fieldString(1, sessionId),
    ...fieldVarint(3, 0),
    ...fieldString(4, 'ok'),
  ]);
  return new Uint8Array([
    ...fieldBytes(1, meta),
    ...fieldVarint(2, event),
    ...fieldString(4, text),
    ...fieldVarint(5, startTime),
    ...fieldVarint(6, endTime),
    ...fieldString(9, speakerId),
  ]);
}

function fieldVarint(field, value) {
  return [...varint((field << 3) | 0), ...varint(value)];
}

function fieldString(field, value) {
  const payload = new TextEncoder().encode(value);
  return [...varint((field << 3) | 2), ...varint(payload.length), ...payload];
}

function fieldBytes(field, value) {
  return [...varint((field << 3) | 2), ...varint(value.length), ...value];
}

function varint(value) {
  const bytes = [];
  let current = value >>> 0;
  while (current >= 0x80) {
    bytes.push((current & 0x7f) | 0x80);
    current >>>= 7;
  }
  bytes.push(current);
  return bytes;
}

class ProtoReader {
  constructor(bytes) {
    this.bytes = bytes;
    this.offset = 0;
  }

  done() {
    return this.offset >= this.bytes.length;
  }

  readTag() {
    const tag = this.readVarint();
    return {
      field: tag >>> 3,
      wireType: tag & 0x07,
    };
  }

  readVarint() {
    let shift = 0;
    let result = 0;
    while (this.offset < this.bytes.length) {
      const byte = this.bytes[this.offset++];
      result |= (byte & 0x7f) << shift;
      if ((byte & 0x80) === 0) {
        return result >>> 0;
      }
      shift += 7;
    }
    throw new Error('Invalid protobuf varint');
  }

  readBytes() {
    const length = this.readVarint();
    const start = this.offset;
    const end = start + length;
    if (end > this.bytes.length) {
      throw new Error('Invalid protobuf length');
    }
    this.offset = end;
    return this.bytes.slice(start, end);
  }

  readString() {
    return new TextDecoder().decode(this.readBytes());
  }

  skip(wireType) {
    if (wireType === 0) {
      this.readVarint();
      return;
    }
    if (wireType === 2) {
      this.readBytes();
      return;
    }
    if (wireType === 5) {
      this.offset += 4;
      return;
    }
    if (wireType === 1) {
      this.offset += 8;
      return;
    }
    throw new Error(`Unsupported protobuf wire type: ${wireType}`);
  }
}

async function fetchJson(url, options) {
  const response = await fetch(url, options);
  if (!response.ok) {
    throw new Error(`${url} returned HTTP ${response.status}`);
  }
  return response.json();
}

async function waitForDevTools(port) {
  const url = `http://127.0.0.1:${port}/json/version`;
  return retry(async () => fetchJson(url), {
    timeoutMs: 15000,
    intervalMs: 200,
    label: 'Chrome DevTools endpoint',
  });
}

async function discoverExtensionId({ port, userDataDir }) {
  const fromPreferences = await retry(async () => readExtensionIdFromPreferences(userDataDir), {
    timeoutMs: 10000,
    intervalMs: 250,
    label: 'extension id in Chrome preferences',
    swallowTimeout: true,
  });

  if (fromPreferences) {
    return fromPreferences;
  }

  const fromTargets = await retry(
    async () => readExtensionIdFromTargets(port),
    {
      timeoutMs: 5000,
      intervalMs: 250,
      label: 'SaySo extension target discovery',
      swallowTimeout: true,
    }
  );

  if (fromTargets) {
    return fromTargets;
  }

  throw new Error('SaySo extension id not found. Chrome did not load the unpacked dist directory.');
}

async function readExtensionIdFromTargets(port) {
  const targets = await fetchJson(`http://127.0.0.1:${port}/json/list`);
  const candidates = targets.filter((item) => {
    const url = item.url ?? '';
    return item.webSocketDebuggerUrl && url.startsWith('chrome-extension://');
  });

  for (const target of candidates) {
    const manifest = await readTargetManifest(target.webSocketDebuggerUrl).catch(() => null);
    if (isSaySoManifest(manifest)) {
      const match = target.url.match(/^chrome-extension:\/\/([^/]+)/);
      if (match) {
        return match[1];
      }
    }
  }

  throw new Error('SaySo extension target not visible yet');
}

async function readTargetManifest(webSocketDebuggerUrl) {
  const worker = new CdpConnection(webSocketDebuggerUrl);
  try {
    await worker.send('Runtime.enable');
    const result = await worker.send('Runtime.evaluate', {
      expression: 'chrome.runtime.getManifest()',
      returnByValue: true,
    });
    return result.result?.value;
  } finally {
    worker.close();
  }
}

function isSaySoManifest(manifest) {
  return Boolean(
    manifest?.action?.default_popup === 'html/popup.html' &&
      manifest?.background?.service_worker === 'background.js' &&
      manifest?.permissions?.includes('tabCapture') &&
      manifest?.permissions?.includes('offscreen')
  );
}

function readExtensionIdFromPreferences(userDataDir) {
  const preferencesPaths = [
    resolve(userDataDir, 'Default', 'Preferences'),
    resolve(userDataDir, 'Profile 1', 'Preferences'),
  ];
  const preferencesPath = preferencesPaths.find((path) => existsSync(path));
  if (!preferencesPath) {
    throw new Error('Chrome preferences file not written yet');
  }

  const preferences = JSON.parse(readFileSync(preferencesPath, 'utf8'));
  const settings = preferences.extensions?.settings ?? {};
  const distBasename = basename(DIST_DIR);

  for (const [extensionId, value] of Object.entries(settings)) {
    const path = value?.path;
    const manifestName = value?.manifest?.name;
    if (path === DIST_DIR || path?.endsWith(`/${distBasename}`) || manifestName === '__MSG_extensionName__') {
      return extensionId;
    }
  }

  throw new Error('extension id not found in preferences');
}

class CdpConnection {
  constructor(webSocketUrl) {
    this.nextId = 1;
    this.pending = new Map();
    this.events = [];
    this.socket = new WebSocket(webSocketUrl);
    this.ready = new Promise((resolvePromise, reject) => {
      this.socket.addEventListener('open', resolvePromise, { once: true });
      this.socket.addEventListener('error', reject, { once: true });
    });
    this.socket.addEventListener('message', (event) => this.handleMessage(event));
  }

  async send(method, params = {}, sessionId) {
    await this.ready;
    const id = this.nextId++;
    const payload = { id, method, params };
    if (sessionId) {
      payload.sessionId = sessionId;
    }

    const promise = new Promise((resolvePromise, reject) => {
      this.pending.set(id, { resolve: resolvePromise, reject });
    });
    this.socket.send(JSON.stringify(payload));
    return promise;
  }

  close() {
    this.socket.close();
  }

  handleMessage(event) {
    const message = JSON.parse(event.data);
    if (message.id) {
      const pending = this.pending.get(message.id);
      if (!pending) {
        return;
      }
      this.pending.delete(message.id);
      if (message.error) {
        pending.reject(new Error(`${message.error.message}: ${message.error.data ?? ''}`));
      } else {
        pending.resolve(message.result);
      }
      return;
    }

    this.events.push(message);
  }
}

async function createTargetSession(cdp, url) {
  const { targetId } = await cdp.send('Target.createTarget', { url });
  const { sessionId } = await cdp.send('Target.attachToTarget', {
    targetId,
    flatten: true,
  });
  await cdp.send('Page.enable', {}, sessionId);
  await cdp.send('Runtime.enable', {}, sessionId);
  return { targetId, sessionId };
}

async function evaluate(cdp, sessionId, expression) {
  const result = await cdp.send(
    'Runtime.evaluate',
    {
      expression,
      awaitPromise: true,
      returnByValue: true,
      userGesture: true,
    },
    sessionId
  );

  if (result.exceptionDetails) {
    throw new Error(
      result.exceptionDetails.exception?.description ??
        result.exceptionDetails.text ??
        'Runtime.evaluate failed'
    );
  }

  return result.result?.value;
}

async function verifyPopup(cdp, sessionId) {
  let lastPopupState = null;
  const result = await retry(
    async () => {
      const value = await evaluate(
        cdp,
        sessionId,
        `new Promise((resolve) => {
          const done = () => {
            const immersiveTab = document.getElementById('tab-immersive-translation');
            const simulcastTab = document.getElementById('tab-simultaneous-interpretation');
            if (!immersiveTab || !simulcastTab) {
              resolve({
                url: location.href,
                title: document.title,
                readyState: document.readyState,
                hasImmersiveTab: Boolean(immersiveTab),
                hasSimulcastTab: Boolean(simulcastTab),
                bodyText: document.body?.innerText?.slice(0, 300) ?? ''
              });
              return;
            }
            immersiveTab.click();
            const immersiveVisible = !document
              .getElementById('immersive-translation-content')
              ?.classList.contains('hidden');
            simulcastTab.click();
            const simulcastVisible = !document
              .getElementById('simultaneous-interpretation-content')
              ?.classList.contains('hidden');
            resolve({
              title: document.title,
              immersiveVisible,
              simulcastVisible,
              translateButton: Boolean(document.getElementById('immersive-translate-current-page')),
              simulcastStartButton: Boolean(document.getElementById('simulcast-start-btn')),
              simulcastOffscreenDeclared: ${JSON.stringify(
                readFileSync(resolve(DIST_DIR, 'html', 'simulcast_offscreen.html'), 'utf8').includes(
                  '../simulcast-offscreen.js'
                )
              )},
            });
          };
          if (document.readyState === 'loading') {
            document.addEventListener('DOMContentLoaded', () => setTimeout(done, 100), { once: true });
          } else {
            setTimeout(done, 100);
          }
        })`
      );

      lastPopupState = value;
      if (!value?.immersiveVisible || !value?.simulcastVisible) {
        throw new Error(`popup translation tabs are not interactive yet: ${JSON.stringify(value)}`);
      }
      return value;
    },
    {
      timeoutMs: 8000,
      intervalMs: 250,
      label: 'popup translation tabs',
    }
  ).catch((error) => {
    const runtimeErrors = cdp.events
      .filter((event) => event.method === 'Runtime.exceptionThrown')
      .slice(-5);
    throw new Error(
      `${error.message}; lastPopupState=${JSON.stringify(lastPopupState)}; runtimeErrors=${JSON.stringify(runtimeErrors)}`
    );
  });

  assert(result.translateButton, 'Popup missing page translation button.');
  assert(result.simulcastStartButton, 'Popup missing simulcast start button.');
  assert(result.simulcastOffscreenDeclared, 'Offscreen simulcast document is not wired to bundle.');
  return result;
}

async function configureMockLlm(cdp, sessionId, origin) {
  const result = await evaluate(
    cdp,
    sessionId,
    `new Promise((resolve) => {
      chrome.storage.sync.set({
        settings: {
          llmApi: {
            provider: 'custom',
            apiKey: 'runtime-verifier-key',
            baseUrl: '${origin}/v1',
            model: 'runtime-verifier-model'
          }
        }
      }, () => resolve({ error: chrome.runtime.lastError?.message ?? null }));
    })`
  );

  assert(!result?.error, `Unable to configure mock LLM: ${result?.error}`);
}

async function verifySimulcastRuntime(cdp, sessionId) {
  const result = await evaluate(
    cdp,
    sessionId,
    `new Promise((resolve) => {
      chrome.runtime.sendMessage({ type: 'simulcast:getStatus' }, (response) => {
        resolve({
          error: chrome.runtime.lastError?.message ?? null,
          response
        });
      });
    })`
  );

  assert(!result?.error, `Unable to query simulcast runtime: ${result?.error}`);
  assert(
    result?.response?.simulcast?.state === 'stopped' ||
      result?.response?.data?.simulcast?.state === 'stopped',
    `Unexpected simulcast runtime status: ${JSON.stringify(result?.response)}`
  );

  return result.response?.simulcast ?? result.response?.data?.simulcast;
}

async function verifySimulcastStart(
  cdp,
  popupSessionId,
  pageSessionId,
  sampleTargetId,
  astState
) {
  const media = await retry(
    async () => {
      const result = await evaluate(
        cdp,
        pageSessionId,
        `new Promise((resolve, reject) => {
          if (typeof window.startRuntimeMedia !== 'function') {
            reject(new Error('runtime media fixture is not ready'));
            return;
          }
          window.startRuntimeMedia().then(resolve, reject);
        })`
      );
      if (result?.audioTracks !== 1 || result?.videoTracks !== 1 || result?.paused !== false) {
        throw new Error(`unexpected runtime media state: ${JSON.stringify(result)}`);
      }
      return result;
    },
    {
      timeoutMs: 8000,
      intervalMs: 250,
      label: 'runtime media fixture',
    }
  );

  await cdp.send('Target.activateTarget', { targetId: sampleTargetId });
  await invokeExtensionActionShortcut(cdp, pageSessionId);

  await evaluate(
    cdp,
    popupSessionId,
    `(() => {
      document.getElementById('tab-simultaneous-interpretation')?.click();
      const values = {
        'simulcast-api-key': 'runtime-ast-key',
        'simulcast-source-language': 'en',
        'simulcast-target-language': 'zh-CN',
        'simulcast-model': 'Doubao_scene_SLM_Doubao_SI_model2000000748711437826',
        'simulcast-output-mode': 'subtitlesOnly',
        'simulcast-subtitle-mode': 'bilingual',
        'simulcast-original-volume': '0',
        'simulcast-translated-volume': '0',
        'simulcast-translated-delay-ms': '300'
      };
      Object.entries(values).forEach(([id, value]) => {
        const element = document.getElementById(id);
        if (!element) {
          throw new Error('missing simulcast control: ' + id);
        }
        element.value = value;
        element.dispatchEvent(new Event('input', { bubbles: true }));
        element.dispatchEvent(new Event('change', { bubbles: true }));
      });
      const voiceClone = document.getElementById('simulcast-voice-clone-toggle');
      if (voiceClone) {
        voiceClone.checked = true;
      }
      document.getElementById('simulcast-start-btn')?.click();
      return { clicked: true };
    })()`
  );

  const startResult = await retry(
    async () => {
      const result = await evaluate(
        cdp,
        popupSessionId,
        `(() => {
          const status = document.getElementById('simulcast-status')?.textContent?.trim() ?? '';
          return {
            status,
            original: document.getElementById('simulcast-original-text')?.textContent?.trim() ?? '',
            translated: document.getElementById('simulcast-translated-text')?.textContent?.trim() ?? ''
          };
        })()`
      );

      if (result?.status.includes('Extension has not been invoked')) {
        throw new Error(result.status);
      }
      if (
        !result?.status.includes('已开始捕获当前标签页音频') &&
        !result?.status.includes('同声传译运行中')
      ) {
        throw new Error(`simulcast start status not ready: ${JSON.stringify(result)}`);
      }
      return result;
    },
    {
      timeoutMs: 15000,
      intervalMs: 500,
      label: 'simulcast:start popup action',
    }
  );

  const ast = await retry(
    async () => {
      if (!astState.authHeaderOk) {
        throw new Error(`AST auth headers were not installed: ${JSON.stringify(astState.handshakes)}`);
      }
      if (astState.startSessions < 1) {
        throw new Error('AST StartSession frame not observed');
      }
      if (astState.taskRequests < 1) {
        throw new Error('AST audio TaskRequest frame not observed');
      }
      return {
        authHeaderOk: astState.authHeaderOk,
        connectRequests: astState.connectRequests,
        handshakes: astState.handshakes.map((handshake) => handshake.requestLine),
        startSessions: astState.startSessions,
        taskRequests: astState.taskRequests,
        finishSessions: astState.finishSessions,
        binaryFrames: astState.binaryFrames,
        subtitleSent: astState.subtitleSent,
      };
    },
    {
      timeoutMs: 15000,
      intervalMs: 250,
      label: 'mock Volcengine AST session',
    }
  );

  const popupSubtitles = await retry(
    async () => {
      const result = await evaluate(
        cdp,
        popupSessionId,
        `(() => ({
          original: document.getElementById('simulcast-original-text')?.textContent?.trim() ?? '',
          translated: document.getElementById('simulcast-translated-text')?.textContent?.trim() ?? '',
          status: document.getElementById('simulcast-status')?.textContent?.trim() ?? '',
          speakerLog: document.getElementById('simulcast-speaker-log')?.textContent?.trim() ?? '',
          delayValue: document.getElementById('simulcast-translated-delay-ms')?.value ?? ''
        }))()`
      );
      if (!result.original.includes('runtime source subtitle')) {
        throw new Error(`source subtitle not rendered yet: ${JSON.stringify(result)}`);
      }
      if (!result.translated.includes('运行时同传字幕')) {
        throw new Error(`translation subtitle not rendered yet: ${JSON.stringify(result)}`);
      }
      if (!result.speakerLog.includes('说话人 1') || !result.speakerLog.includes('原文') || !result.speakerLog.includes('译文')) {
        throw new Error(`speaker log not rendered yet: ${JSON.stringify(result)}`);
      }
      if (result.delayValue !== '300') {
        throw new Error(`simulcast delay control was not retained: ${JSON.stringify(result)}`);
      }
      return result;
    },
    {
      timeoutMs: 8000,
      intervalMs: 250,
      label: 'popup simulcast subtitles',
    }
  );

  const stopResult = await evaluate(
    cdp,
    popupSessionId,
    `new Promise((resolve) => {
      chrome.runtime.sendMessage({ type: 'simulcast:stop' }, (response) => {
        resolve({
          error: chrome.runtime.lastError?.message ?? null,
          response
        });
      });
    })`
  );

  assert(!stopResult?.error, `Unable to stop simulcast runtime: ${stopResult?.error}`);
  const stopped = stopResult?.response?.simulcast ?? stopResult?.response?.data?.simulcast;
  assert(stopped?.state === 'stopped', `Unexpected simulcast stop response: ${JSON.stringify(stopResult?.response)}`);

  return {
    media,
    started: startResult,
    ast,
    popupSubtitles,
    stopped,
  };
}

async function invokeExtensionActionShortcut(cdp, pageSessionId) {
  const modifiers = process.platform === 'darwin' ? 12 : 10;
  const common = {
    key: 'Y',
    code: 'KeyY',
    windowsVirtualKeyCode: 89,
    nativeVirtualKeyCode: 89,
    modifiers,
  };
  await cdp.send('Input.dispatchKeyEvent', { ...common, type: 'rawKeyDown' }, pageSessionId);
  await cdp.send('Input.dispatchKeyEvent', { ...common, type: 'keyUp' }, pageSessionId);
  await new Promise((resolvePromise) => setTimeout(resolvePromise, 500));
}

async function verifyPageTranslation(cdp, popupSessionId, pageSessionId, sampleUrl) {
  const messageResult = await retry(
    async () => {
      const result = await evaluate(
        cdp,
        popupSessionId,
        `new Promise((resolve) => {
          chrome.tabs.query({}, (tabs) => {
            const tab = tabs.find((candidate) => candidate.url === '${sampleUrl}');
            if (!tab?.id) {
              resolve({ error: 'sample tab not found', tabs: tabs.map((item) => item.url) });
              return;
            }
            chrome.tabs.sendMessage(
              tab.id,
              {
                type: 'translation:translateCurrentPage',
                sourceLanguage: 'en',
                targetLanguage: 'zh-CN',
                mode: 'bilingual',
                range: 'main'
              },
              (response) => {
                resolve({
                  error: chrome.runtime.lastError?.message ?? null,
                  response
                });
              }
            );
          });
        })`
      );

      if (result?.error) {
        throw new Error(result.error);
      }
      if (result?.response?.status !== 'ok' || result.response.translatedCount < 1) {
        throw new Error(`unexpected translation response: ${JSON.stringify(result?.response)}`);
      }
      return result;
    },
    {
      timeoutMs: 10000,
      intervalMs: 300,
      label: 'content-script page translation message',
    }
  );

  const domResult = await retry(
    async () => {
      const result = await evaluate(
        cdp,
        pageSessionId,
        `(() => {
          const blocks = Array.from(document.querySelectorAll('.sayso-translation-block'))
            .map((element) => element.textContent?.trim())
            .filter(Boolean);
          return {
            blockCount: blocks.length,
            blocks
          };
        })()`
      );
      if (result.blockCount < 1) {
        throw new Error('translation blocks not rendered yet');
      }
      return result;
    },
    {
      timeoutMs: 5000,
      intervalMs: 200,
      label: 'translated DOM blocks',
    }
  );

  return {
    messageResult,
    domResult,
  };
}

async function retry(task, options) {
  const startedAt = Date.now();
  let lastError;

  while (Date.now() - startedAt < options.timeoutMs) {
    try {
      return await task();
    } catch (error) {
      lastError = error;
      await new Promise((resolvePromise) => setTimeout(resolvePromise, options.intervalMs));
    }
  }

  if (options.swallowTimeout) {
    return null;
  }

  throw new Error(`${options.label} timed out: ${lastError?.message ?? 'unknown error'}`);
}

async function closeServer(server) {
  await new Promise((resolvePromise) => server.close(resolvePromise));
}

async function main() {
  verifyDistArtifacts();
  assert(typeof WebSocket === 'function', 'Node.js WebSocket global is required for CDP.');

  const chromePath = findChromeExecutable();
  const debuggingPort = pickDebuggingPort();
  const userDataDir = await mkdtemp(resolve(tmpdir(), 'sayso-extension-runtime-'));
  const fixture = await startFixtureServer();
  const mockAst = await startMockAstProxy(userDataDir);
  const chrome = await launchChrome({
    chromePath,
    userDataDir,
    debuggingPort,
    astProxyPort: mockAst.port,
  });

  let cdp;

  try {
    const version = await waitForDevTools(debuggingPort);
    cdp = new CdpConnection(version.webSocketDebuggerUrl);

    const extensionId = await discoverExtensionId({
      port: debuggingPort,
      userDataDir,
    });
    const popupUrl = `chrome-extension://${extensionId}/html/popup.html`;
    const sampleUrl = `${fixture.origin}/sample.html`;

    const popupTarget = await createTargetSession(cdp, popupUrl);
    const sampleTarget = await createTargetSession(cdp, sampleUrl);

    const popup = await verifyPopup(cdp, popupTarget.sessionId);
    const simulcast = await verifySimulcastRuntime(cdp, popupTarget.sessionId);
    await configureMockLlm(cdp, popupTarget.sessionId, fixture.origin);
    const pageTranslation = await verifyPageTranslation(
      cdp,
      popupTarget.sessionId,
      sampleTarget.sessionId,
      sampleUrl
    );
    const simulcastStart = await verifySimulcastStart(
      cdp,
      popupTarget.sessionId,
      sampleTarget.sessionId,
      sampleTarget.targetId,
      mockAst.state
    );

    console.log(
      JSON.stringify(
        {
          status: 'ok',
          chrome: basename(chromePath),
          extensionId,
          popup,
          simulcast,
          pageTranslation: {
            translatedCount: pageTranslation.messageResult.response.translatedCount,
            blockCount: pageTranslation.domResult.blockCount,
            blocks: pageTranslation.domResult.blocks,
          },
          simulcastStart,
        },
        null,
        2
      )
    );
  } finally {
    cdp?.close();
    chrome.kill('SIGTERM');
    await closeServer(fixture.server).catch(() => undefined);
    await closeServer(mockAst.server).catch(() => undefined);
    await rm(userDataDir, { recursive: true, force: true }).catch(() => undefined);
  }
}

main().catch((error) => {
  console.error(`[verify:extension-runtime] FAILED: ${error instanceof Error ? error.message : error}`);
  process.exit(1);
});
