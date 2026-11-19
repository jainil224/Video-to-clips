/**
 * Live Stream Highlight Detector
 * Runs on http://localhost:5178
 */

import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = 5178;

// Paths
const ROOT = path.resolve(__dirname, '..');
const YTDLP_PATH = path.join(ROOT, '.tools', 'venv', 'Scripts', 'yt-dlp.exe');
const TMP_DIR = path.join(ROOT, 'data', 'live-tmp');
fs.mkdirSync(TMP_DIR, { recursive: true });

let session = null;
const sseClients = new Set();

function broadcast(obj) {
  const line = `data: ${JSON.stringify(obj)}\n\n`;
  for (const res of sseClients) res.write(line);
}

function ytdlp() {
  if (fs.existsSync(YTDLP_PATH)) return YTDLP_PATH;
  const r = spawnSync(process.platform === 'win32' ? 'where' : 'which', ['yt-dlp'], { encoding: 'utf8' });
  if (r.status === 0) return r.stdout.trim().split(/\r?\n/)[0];
  throw new Error('yt-dlp not found.');
}

function ffmpegLoudness(filePath) {
  return new Promise((resolve) => {
    const p = spawn('ffmpeg', [
      '-i', filePath,
      '-af', 'volumedetect',
      '-vn', '-sn', '-dn',
      '-f', 'null', '-'
    ], { stdio: ['ignore', 'pipe', 'pipe'] });

    let stderr = '';
    p.stderr.on('data', d => stderr += d);
    p.on('close', () => {
      const meanMatch = stderr.match(/mean_volume:\s*([-\d.]+)\s*dB/);
      const maxMatch = stderr.match(/max_volume:\s*([-\d.]+)\s*dB/);
      resolve({
        mean: meanMatch ? parseFloat(meanMatch[1]) : -91,
        max: maxMatch ? parseFloat(maxMatch[1]) : -91,
      });
    });
    p.on('error', () => resolve({ mean: -91, max: -91 }));
  });
}

function ffprobeDuration(filePath) {
  return new Promise((resolve) => {
    const p = spawn('ffprobe', [
      '-v', 'error',
      '-show_entries', 'format=duration',
      '-of', 'default=noprint_wrappers=1:nokey=1',
      filePath
    ], { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    p.stdout.on('data', d => out += d);
    p.on('close', () => resolve(parseFloat(out.trim()) || 0));
    p.on('error', () => resolve(0));
  });
}

function getVideoInfo(url) {
  return new Promise((resolve, reject) => {
    const ytdlpBin = ytdlp();
    const p = spawn(ytdlpBin, [
      '--no-warnings', '--no-progress',
      '-J', '--ignore-config', '--no-playlist',
      url
    ], { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    p.stdout.on('data', d => out += d);
    p.on('close', code => {
      if (code !== 0) return reject(new Error('Could not read stream info'));
      try { resolve(JSON.parse(out)); } catch { reject(new Error('Bad response from yt-dlp')); }
    });
    p.on('error', reject);
  });
}

const FUNNY_PATTERN = /(😂|🤣|💀|😭|😱|🔥|😳|🤯|😮|😲|\blol+\b|\blmfa?o+\b|\brofl\b|\b(?:ha){2,}h?\b|\bxd+\b|\bkekw?\b|\bomegalul\b|\bpog+\b|\blulw?\b|\bjaja+\b|\bwow+\b|\bomg+\b|\bno+ way\b|\bnoo+\b|\binsane\b|\bcrazy\b|\bclutch\b|\bgg+\b|\blet'?s go+\b|\bgoat\b|\bw\b|\bnice+\b|!{2,}|\?{3,})/iu;
const BOT_PATTERN = /^(nightbot|streamelements|streamlabs|moobot|fossabot|wizebot|botrix|sery_bot|soundalerts)/i;

function startChatMonitor(url, sessionId) {
  if (!url) return null;
  const ytdlpBin = ytdlp();
  const p = spawn(ytdlpBin, [
    '--no-warnings',
    '--ignore-config',
    '--no-playlist',
    '--skip-download',
    '--write-subs',
    '--sub-langs', 'live_chat',
    '-o', path.join(TMP_DIR, `${sessionId}-chat.%(ext)s`),
    url
  ], { stdio: ['ignore', 'pipe', 'pipe'] });

  const chatFile = path.join(TMP_DIR, `${sessionId}-chat.live_chat.json`);
  let lastSize = 0;
  let buffer = '';

  const chatInterval = setInterval(() => {
    const s = session;
    if (!s || s.id !== sessionId) { clearInterval(chatInterval); return; }
    if (!fs.existsSync(chatFile)) return;
    try {
      const stat = fs.statSync(chatFile);
      if (stat.size <= lastSize) return;
      const fd = fs.openSync(chatFile, 'r');
      const buf = Buffer.alloc(stat.size - lastSize);
      fs.readSync(fd, buf, 0, buf.length, lastSize);
      fs.closeSync(fd);
      lastSize = stat.size;
      buffer += buf.toString('utf8');
      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';
      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const obj = JSON.parse(line);
          const action = obj?.replayChatItemAction;
          if (!action) continue;
          const timeSec = Number(action.videoOffsetTimeMsec || 0) / 1000;
          for (const act of action.actions ?? []) {
            const item = act?.addChatItemAction?.item;
            if (!item) continue;
            const renderer = item.liveChatTextMessageRenderer || item.liveChatPaidMessageRenderer;
            if (!renderer) continue;
            const author = renderer.authorName?.simpleText ?? '';
            if (BOT_PATTERN.test(author)) continue;
            const text = (renderer.message?.runs ?? [])
              .map(r => r.text || (r.emoji ? (r.emoji.shortcuts?.[0] ?? '') : ''))
              .join('').trim();
            if (!text) continue;
            const isFunny = FUNNY_PATTERN.test(text);
            s.chatMessages.push({ t: timeSec || s.elapsed, author, text, funny: isFunny });
            if (isFunny) s.chatFunnyCount++;
            if (s.chatMessages.length > 500) s.chatMessages.shift();
            broadcast({ type: 'chat', msg: { author, text, funny: isFunny, t: timeSec || s.elapsed } });
          }
        } catch {}
      }
    } catch {}
  }, 1000);

  p.on('close', () => clearInterval(chatInterval));
  p.on('error', () => clearInterval(chatInterval));
  return p;
}

async function analyseChunk(chunkFile, chunkIndex, chunkStartSec, session) {
  const [loudness, duration] = await Promise.all([
    ffmpegLoudness(chunkFile),
    ffprobeDuration(chunkFile),
  ]);

  const chatWindow = session.chatMessages.filter(m =>
    m.t >= chunkStartSec && m.t < chunkStartSec + duration
  );
  const funnyChatCount = chatWindow.filter(m => m.funny).length;
  const totalChatCount = chatWindow.length;

  const baselineMean = session.baselineMean ?? -30;
  const audioScore = Math.max(0, Math.min(100, (loudness.max - baselineMean) * 3));
  const chatScore = Math.min(100, funnyChatCount * 15 + totalChatCount * 2);
  const totalScore = Math.round(audioScore * 0.55 + chatScore * 0.45);

  if (session.baselineMean == null) {
    session.baselineMean = loudness.mean;
  } else {
    session.baselineMean = session.baselineMean * 0.85 + loudness.mean * 0.15;
  }

  const moment = {
    id: `chunk-${chunkIndex}`,
    chunkIndex,
    startSec: chunkStartSec,
    endSec: chunkStartSec + duration,
    duration,
    audioMean: loudness.mean,
    audioMax: loudness.max,
    audioScore: Math.round(audioScore),
    chatScore: Math.round(chatScore),
    score: totalScore,
    funnyChatCount,
    totalChatCount,
    sampleChat: chatWindow.filter(m => m.funny).slice(-3).map(m => m.text),
    file: path.basename(chunkFile),
    isHighlight: totalScore >= 35,
  };

  session.chunks.push(moment);
  broadcast({ type: 'chunk', moment });

  if (moment.isHighlight) {
    broadcast({ type: 'highlight', moment });
    console.log(`🔥 HIGHLIGHT at ${formatTime(chunkStartSec)} - score ${totalScore}`);
  }

  return moment;
}

async function startSession(url) {
  if (session) await stopSession();

  const id = `live-${Date.now()}`;
  const dir = path.join(TMP_DIR, id);
  fs.mkdirSync(dir, { recursive: true });

  broadcast({ type: 'status', state: 'connecting', msg: 'Getting stream info...' });
  let info;
  try {
    info = await getVideoInfo(url);
  } catch (e) {
    broadcast({ type: 'status', state: 'error', msg: e.message });
    return;
  }

  const isLive = info.live_status === 'is_live' || info.is_live === true;
  const title = info.title || 'Live Stream';
  const channel = info.channel || info.uploader || '';
  const thumb = info.thumbnail || info.thumbnails?.at(-1)?.url || '';

  broadcast({ type: 'info', title, channel, thumb, isLive });

  session = {
    id, url, dir,
    title, channel, thumb, isLive,
    startedAt: Date.now(),
    elapsed: 0,
    state: 'recording',
    chunks: [],
    chatMessages: [],
    chatFunnyCount: 0,
    baselineMean: null,
    processes: [],
  };

  broadcast({ type: 'status', state: 'recording', msg: isLive ? 'Recording live stream...' : 'Recording VOD...' });

  const chatProc = startChatMonitor(url, id);
  if (chatProc) session.processes.push(chatProc);

  const ytdlpBin = ytdlp();
  const chunkTemplate = path.join(dir, 'chunk-%03d.mp4');

  const ytdlpProc = spawn(ytdlpBin, [
    '--no-warnings',
    '--ignore-config',
    '--no-playlist',
    '-f', 'worstaudio[ext=m4a]/worstaudio/bestaudio/best',
    '--no-part',
    '-o', '-',
    url,
  ], { stdio: ['ignore', 'pipe', 'pipe'] });

  const CHUNK_SECS = 60;
  const ffmpegProc = spawn('ffmpeg', [
    '-i', 'pipe:0',
    '-f', 'segment',
    '-segment_time', String(CHUNK_SECS),
    '-reset_timestamps', '1',
    '-c', 'copy',
    '-y',
    chunkTemplate,
  ], { stdio: ['pipe', 'pipe', 'pipe'] });

  ytdlpProc.stdout.pipe(ffmpegProc.stdin);
  ytdlpProc.on('error', e => broadcast({ type: 'warn', msg: `yt-dlp: ${e.message}` }));
  ffmpegProc.on('error', e => broadcast({ type: 'warn', msg: `ffmpeg: ${e.message}` }));

  session.processes.push(ytdlpProc, ffmpegProc);

  let lastKnownChunk = -1;

  const watchInterval = setInterval(async () => {
    const s = session;
    if (!s || s.id !== id) { clearInterval(watchInterval); return; }

    s.elapsed = Math.round((Date.now() - s.startedAt) / 1000);
    broadcast({ type: 'tick', elapsed: s.elapsed });

    let files;
    try {
      files = fs.readdirSync(dir)
        .filter(f => /^chunk-\d+\.mp4$/.test(f))
        .sort();
    } catch { return; }

    const toAnalyse = files.slice(0, Math.max(0, files.length - 1));
    for (const file of toAnalyse) {
      const idx = parseInt(file.match(/chunk-(\d+)/)[1]);
      if (idx <= lastKnownChunk) continue;
      lastKnownChunk = idx;
      const chunkPath = path.join(dir, file);
      const startSec = idx * CHUNK_SECS;
      try {
        await analyseChunk(chunkPath, idx, startSec, s);
      } catch (e) {
        console.warn(`Chunk ${idx} analysis failed:`, e.message);
      }
    }
  }, 3000);

  session.watchInterval = watchInterval;

  ytdlpProc.on('close', () => {
    clearInterval(watchInterval);
    if (session?.id === id) {
      session.state = 'done';
      broadcast({ type: 'status', state: 'done', msg: 'Stream ended.' });
    }
  });
}

async function stopSession() {
  if (!session) return;
  const s = session;
  session = null;
  clearInterval(s.watchInterval);
  for (const p of s.processes) {
    try { p.kill('SIGKILL'); } catch {}
  }
  broadcast({ type: 'status', state: 'stopped', msg: 'Session stopped.' });
  try { fs.rmSync(s.dir, { recursive: true, force: true }); } catch {}
}

function formatTime(sec) {
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = Math.floor(sec % 60);
  return h ? `${h}:${String(m).padStart(2,'0')}:${String(s).padStart(2,'0')}`
           : `${m}:${String(s).padStart(2,'0')}`;
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);

  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

  if (url.pathname === '/events') {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    res.write('data: {"type":"hello"}\n\n');
    sseClients.add(res);

    if (session) {
      res.write(`data: ${JSON.stringify({ type: 'info', title: session.title, channel: session.channel, thumb: session.thumb, isLive: session.isLive })}\n\n`);
      res.write(`data: ${JSON.stringify({ type: 'status', state: session.state, msg: `${session.state} - ${formatTime(session.elapsed)} elapsed` })}\n\n`);
      for (const chunk of session.chunks) {
        res.write(`data: ${JSON.stringify({ type: 'chunk', moment: chunk })}\n\n`);
      }
    }

    const ping = setInterval(() => res.write(': ping\n\n'), 25000);
    req.on('close', () => { clearInterval(ping); sseClients.delete(res); });
    return;
  }

  if (url.pathname === '/api/start' && req.method === 'POST') {
    let body = '';
    req.on('data', d => body += d);
    req.on('end', async () => {
      try {
        const { url: streamUrl } = JSON.parse(body);
        if (!streamUrl) { res.writeHead(400); res.end(JSON.stringify({ error: 'url required' })); return; }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true }));
        startSession(streamUrl).catch(e => broadcast({ type: 'error', msg: e.message }));
      } catch (e) {
        res.writeHead(400); res.end(JSON.stringify({ error: e.message }));
      }
    });
    return;
  }

  if (url.pathname === '/api/stop' && req.method === 'POST') {
    await stopSession();
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true }));
    return;
  }

  if (url.pathname === '/api/state' && req.method === 'GET') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(session ? {
      id: session.id,
      title: session.title,
      channel: session.channel,
      isLive: session.isLive,
      state: session.state,
      elapsed: session.elapsed,
      chunks: session.chunks,
    } : null));
    return;
  }

  if (url.pathname.startsWith('/api/clip/') && req.method === 'GET') {
    const chunkId = url.pathname.replace('/api/clip/', '');
    const s = session;
    if (!s) { res.writeHead(404); res.end('No session'); return; }
    const chunk = s.chunks.find(c => c.id === chunkId);
    if (!chunk) { res.writeHead(404); res.end('Chunk not found'); return; }
    const filePath = path.join(s.dir, chunk.file);
    if (!fs.existsSync(filePath)) { res.writeHead(404); res.end('File not found'); return; }
    const stat = fs.statSync(filePath);
    res.writeHead(200, {
      'Content-Type': 'video/mp4',
      'Content-Length': stat.size,
      'Content-Disposition': `attachment; filename="highlight-${formatTime(chunk.startSec).replace(/:/g,'-')}.mp4"`,
    });
    fs.createReadStream(filePath).pipe(res);
    return;
  }

  if (url.pathname === '/' || url.pathname === '/index.html') {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(HTML);
    return;
  }

  res.writeHead(404); res.end('Not found');
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`\n  Live Highlight Detector: http://localhost:${PORT}\n`);
});

const HTML = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1"/>
<title>Live Highlight Detector - Fivestar</title>
<style>
  *{box-sizing:border-box;margin:0;padding:0}
  :root{
    --bg:#0d0d14;--surface:#14141f;--surface2:#1c1c2e;--accent:#a855f7;
    --accent2:#ec4899;--green:#22c55e;--yellow:#eab308;--red:#ef4444;
    --text:#f1f0ff;--muted:#8b87a8;--border:#2a2a3e;
  }
  body{background:var(--bg);color:var(--text);font:15px/1.5 system-ui,sans-serif;min-height:100vh}
  header{
    background:var(--surface);border-bottom:1px solid var(--border);
    padding:14px 20px;display:flex;align-items:center;gap:14px;
  }
  .badge{
    display:inline-flex;align-items:center;gap:5px;padding:3px 10px;
    border-radius:20px;font-size:.75rem;font-weight:600;
  }
  .badge.live{background:#ef44441a;color:var(--red);border:1px solid #ef444433}
  .badge.vod{background:#3b82f61a;color:#60a5fa;border:1px solid #3b82f633}
  main{max-width:1100px;margin:0 auto;padding:20px;display:grid;grid-template-columns:1fr 320px;gap:20px}
  @media(max-width:800px){main{grid-template-columns:1fr}}
  .card{background:var(--surface);border:1px solid var(--border);border-radius:12px;padding:18px}
  .card h2{font-size:1rem;font-weight:600;color:var(--muted);margin-bottom:12px;text-transform:uppercase}
  .input-row{display:flex;gap:8px}
  .input-row input{
    flex:1;background:var(--surface2);border:1px solid var(--border);border-radius:8px;
    padding:10px 14px;color:var(--text);font:inherit;outline:none;
  }
  button{
    background:var(--accent);color:#fff;border:none;border-radius:8px;
    padding:10px 18px;font:600 .9rem system-ui;cursor:pointer;
  }
  button.danger{background:var(--red)}
  button.secondary{background:var(--surface2);border:1px solid var(--border);color:var(--text)}
  .status-bar{
    display:flex;align-items:center;gap:10px;padding:10px 14px;
    background:var(--surface2);border-radius:8px;font-size:.88rem;margin-top:14px;
  }
  .status-bar .dot{width:8px;height:8px;border-radius:50%;background:var(--muted)}
  .status-bar.recording .dot{background:var(--red)}
  .status-bar.done .dot{background:var(--green)}
  #stream-info{display:none;gap:12px;align-items:center;margin-top:14px}
  #stream-info img{width:80px;height:45px;object-fit:cover;border-radius:6px}
  .highlight-list{display:flex;flex-direction:column;gap:10px;margin-top:4px}
  .hl-item{
    background:var(--surface2);border-radius:10px;padding:12px 14px;
    border-left:3px solid var(--border);
  }
  .hl-item.fire{border-color:var(--accent2)}
  .hl-item.hot{border-color:var(--accent)}
  .hl-item.warm{border-color:var(--yellow)}
  .hl-item .hl-top{display:flex;align-items:center;justify-content:space-between}
  .hl-score{font-weight:700;font-size:1.1rem;padding:2px 8px;border-radius:6px;background:#a855f71a;color:var(--accent)}
  .hl-bars{display:flex;gap:6px;margin:7px 0 5px}
  .bar-wrap{flex:1}
  .bar-label{font-size:.7rem;color:var(--muted)}
  .bar-track{height:6px;background:#ffffff12;border-radius:3px;overflow:hidden}
  .bar-fill{height:100%;border-radius:3px}
  .bar-fill.audio{background:linear-gradient(90deg,#a855f7,#ec4899)}
  .bar-fill.chat{background:linear-gradient(90deg,#22c55e,#06b6d4)}
  .hl-actions{margin-top:8px;display:flex;gap:6px}
  .empty-state{text-align:center;padding:30px 20px;color:var(--muted)}
  #chat-feed{height:320px;overflow-y:auto;display:flex;flex-direction:column;gap:4px}
  .chat-msg{padding:4px 0;font-size:.82rem;border-bottom:1px solid #ffffff08}
  .chat-msg .author{font-weight:600;color:var(--accent);margin-right:5px}
  .stats-grid{display:grid;grid-template-columns:1fr 1fr;gap:8px}
  .stat-box{background:var(--surface2);border-radius:8px;padding:12px;text-align:center}
  .stat-box .num{font-size:1.4rem;font-weight:700;color:var(--accent)}
  .stat-box .lbl{font-size:.72rem;color:var(--muted);text-transform:uppercase}
</style>
</head>
<body>
<header>
  <span style="font-size:1.5rem">🎯</span>
  <div>
    <h1>Live Highlight Detector</h1>
    <div style="font-size:.78rem;color:var(--muted)">Powered by Fivestar · Real-time live stream moments</div>
  </div>
  <span id="timer" style="margin-left:auto;display:none">⏱ 0:00</span>
</header>
<main>
  <div style="display:flex;flex-direction:column;gap:16px">
    <div class="card">
      <h2>🔴 Stream Link</h2>
      <div class="input-row">
        <input id="url-input" type="url" placeholder="Paste YouTube Live / Twitch link here..." />
        <button id="start-btn" onclick="startStream()">▶ Start</button>
        <button id="stop-btn" class="danger" onclick="stopStream()" style="display:none">■ Stop</button>
      </div>
      <div id="stream-info">
        <img id="thumb" src="" alt=""/>
        <div>
          <div id="stream-title" style="font-weight:600">-</div>
          <div id="stream-channel" style="color:var(--muted);font-size:.82rem"></div>
        </div>
        <span id="live-badge" class="badge live">LIVE</span>
        <span id="vod-badge" class="badge vod" style="display:none">VOD</span>
      </div>
      <div class="status-bar" id="status-bar">
        <span class="dot"></span>
        <span id="status-msg">Paste a live stream link above and click Start.</span>
      </div>
    </div>
    <div class="card">
      <h2>🔥 Detected Highlights</h2>
      <div class="highlight-list" id="highlight-list">
        <div class="empty-state">Highlights will appear here as the stream is analysed...</div>
      </div>
    </div>
    <div class="card">
      <h2>📊 All Analysed Segments</h2>
      <div class="highlight-list" id="chunk-list">
        <div class="empty-state">Segments appear every ~60 seconds...</div>
      </div>
    </div>
  </div>
  <div style="display:flex;flex-direction:column;gap:16px">
    <div class="card">
      <h2>📈 Session Stats</h2>
      <div class="stats-grid">
        <div class="stat-box"><div class="num" id="stat-highlights">0</div><div class="lbl">Highlights</div></div>
        <div class="stat-box"><div class="num" id="stat-segments">0</div><div class="lbl">Segments</div></div>
        <div class="stat-box"><div class="num" id="stat-chat">0</div><div class="lbl">Chat Msgs</div></div>
        <div class="stat-box"><div class="num" id="stat-funny">0</div><div class="lbl">Funny Chat</div></div>
      </div>
    </div>
    <div class="card" style="flex:1">
      <h2>💬 Live Chat Feed</h2>
      <div id="chat-feed"><div style="text-align:center;padding:20px;color:var(--muted)">Chat will appear when the stream starts...</div></div>
    </div>
  </div>
</main>
<script>
const evtSrc = new EventSource('/events');
let statsHighlights = 0, statsSegments = 0, statsChat = 0, statsFunny = 0;
let timerInterval = null, elapsedStart = 0;

function fmt(sec) {
  const h = Math.floor(sec/3600), m = Math.floor((sec%3600)/60), s = Math.floor(sec%60);
  return h ? h+':'+String(m).padStart(2,'0')+':'+String(s).padStart(2,'0') : m+':'+String(s).padStart(2,'0');
}
function score2class(s) { return s>=65?'fire':s>=40?'hot':'warm'; }

evtSrc.onmessage = e => {
  const d = JSON.parse(e.data);
  if (d.type==='status') {
    const bar = document.getElementById('status-bar');
    bar.className = 'status-bar ' + (d.state||'');
    document.getElementById('status-msg').textContent = d.msg || d.state;
    if (d.state==='recording') {
      document.getElementById('start-btn').style.display='none';
      document.getElementById('stop-btn').style.display='';
    } else {
      document.getElementById('start-btn').style.display='';
      document.getElementById('stop-btn').style.display='none';
    }
  }
  if (d.type==='info') {
    document.getElementById('stream-info').style.display='flex';
    document.getElementById('stream-title').textContent = d.title;
    document.getElementById('stream-channel').textContent = d.channel;
    document.getElementById('thumb').src = d.thumb;
    document.getElementById('live-badge').style.display = d.isLive ? '' : 'none';
    document.getElementById('vod-badge').style.display = d.isLive ? 'none' : '';
    elapsedStart = Date.now();
    document.getElementById('timer').style.display='';
    clearInterval(timerInterval);
    timerInterval = setInterval(()=>{
      document.getElementById('timer').textContent='⏱ '+fmt(Math.round((Date.now()-elapsedStart)/1000));
    }, 1000);
  }
  if (d.type==='chunk') {
    statsSegments++;
    document.getElementById('stat-segments').textContent = statsSegments;
    const list = document.getElementById('chunk-list');
    if (list.querySelector('.empty-state')) list.innerHTML='';
    const el = document.createElement('div');
    el.className = 'hl-item '+score2class(d.moment.score);
    el.innerHTML = chunkHTML(d.moment);
    list.prepend(el);
  }
  if (d.type==='highlight') {
    statsHighlights++;
    document.getElementById('stat-highlights').textContent = statsHighlights;
    const list = document.getElementById('highlight-list');
    if (list.querySelector('.empty-state')) list.innerHTML='';
    const el = document.createElement('div');
    el.className = 'hl-item '+score2class(d.moment.score);
    el.innerHTML = chunkHTML(d.moment);
    list.prepend(el);
  }
  if (d.type==='chat') {
    statsChat++;
    if (d.msg.funny) statsFunny++;
    document.getElementById('stat-chat').textContent = statsChat;
    document.getElementById('stat-funny').textContent = statsFunny;
    const feed = document.getElementById('chat-feed');
    if (feed.querySelector('[style*="text-align"]')) feed.innerHTML='';
    const el = document.createElement('div');
    el.className = 'chat-msg';
    el.innerHTML = '<span class="author">'+d.msg.author+': </span>'+d.msg.text;
    feed.appendChild(el);
    feed.scrollTop = feed.scrollHeight;
  }
};

function chunkHTML(m) {
  return \`
    <div class="hl-top">
      <span>\${fmt(m.startSec)} - \${fmt(m.endSec)}</span>
      <span class="hl-score">\${m.score}</span>
    </div>
    <div class="hl-bars">
      <div class="bar-wrap">
        <div class="bar-label">Audio \${m.audioScore}%</div>
        <div class="bar-track"><div class="bar-fill audio" style="width:\${m.audioScore}%"></div></div>
      </div>
      <div class="bar-wrap">
        <div class="bar-label">Chat \${m.chatScore}%</div>
        <div class="bar-track"><div class="bar-fill chat" style="width:\${m.chatScore}%"></div></div>
      </div>
    </div>
    <div class="hl-actions">
      <a href="/api/clip/\${m.id}" download><button class="secondary">⬇ Save Clip</button></a>
    </div>
  \`;
}

async function startStream() {
  const url = document.getElementById('url-input').value.trim();
  if (!url) return alert('Enter stream URL');
  await fetch('/api/start',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({url})});
}
async function stopStream() {
  await fetch('/api/stop',{method:'POST'});
}
</script>
</body>
</html>`;

