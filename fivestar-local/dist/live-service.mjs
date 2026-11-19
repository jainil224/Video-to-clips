/**
 * Live Stream Highlight & Viral Moments Service
 * Directly integrated with Fivestar's Express server
 */

import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const YTDLP_PATH = path.join(ROOT, '.tools', 'venv', 'Scripts', 'yt-dlp.exe');
const TMP_DIR = path.join(ROOT, 'data', 'live-tmp');
const PROJECTS_DIR = path.join(ROOT, 'data', 'projects');

fs.mkdirSync(TMP_DIR, { recursive: true });
fs.mkdirSync(PROJECTS_DIR, { recursive: true });

let session = null;
const sseClients = new Set();

function broadcast(obj) {
  const line = `data: ${JSON.stringify(obj)}\n\n`;
  for (const res of sseClients) {
    try { res.write(line); } catch {}
  }
}

function ytdlp() {
  if (fs.existsSync(YTDLP_PATH)) return YTDLP_PATH;
  const r = spawnSync(process.platform === 'win32' ? 'where' : 'which', ['yt-dlp'], { encoding: 'utf8' });
  if (r.status === 0) return r.stdout.trim().split(/\r?\n/)[0];
  throw new Error('yt-dlp not found. Run npm run setup');
}

function validateStreamUrl(rawUrl) {
  let parsed;
  try {
    let clean = rawUrl.trim();
    if (!/^https?:\/\//i.test(clean)) clean = `https://${clean}`;
    parsed = new URL(clean);
  } catch {
    throw new Error('Please enter a valid web URL (e.g. https://www.youtube.com/watch?v=... or https://youtube.com/live/...).');
  }

  const host = parsed.hostname.toLowerCase();
  const pathParts = parsed.pathname.split('/').filter(Boolean);

  if (/youtube\.com$/i.test(host) || /youtu\.be$/i.test(host)) {
    if (pathParts.length === 0) {
      throw new Error('You pasted the YouTube homepage (youtube.com). Please open a specific live stream and copy its link from your browser.');
    }
    const first = pathParts[0]?.toLowerCase() || '';
    if (first === 'results' || first === 'search') {
      throw new Error('That is a search results page. Click on the stream you want to watch, then copy and paste its link.');
    }
    if (first === 'feed' || first === 'explore') {
      throw new Error('That is a YouTube feed page. Open a specific stream and paste its link.');
    }
    if (first === 'playlist') {
      throw new Error('That link is a playlist. Please open an individual stream and copy its link.');
    }
  }

  return parsed.toString();
}

function cleanYtdlpError(errStr) {
  const lines = errStr.split(/[\r\n]+/).map(s => s.trim()).filter(Boolean);
  const found = lines.reverse().find(l => /error/i.test(l)) || lines[0] || 'Unknown error';
  const cleaned = found.replace(/^ERROR:\s*/i, '').trim();

  if (/private video/i.test(cleaned)) return 'This video/stream is private.';
  if (/members-only/i.test(cleaned)) return 'This stream is for channel members only.';
  if (/unavailable|removed/i.test(cleaned)) return 'This stream is unavailable or ended.';
  if (/not a valid url/i.test(cleaned)) return 'That link is not a valid video stream URL.';
  return cleaned || 'Could not access the stream.';
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
    let err = '';
    p.stdout.on('data', d => out += d);
    p.stderr.on('data', d => err += d);
    p.on('close', code => {
      if (code !== 0) {
        return reject(new Error(cleanYtdlpError(err)));
      }
      try {
        const json = JSON.parse(out);
        if (json._type === 'playlist') {
          return reject(new Error('That link is a channel, feed or playlist. Please open the specific stream or video and paste its URL.'));
        }
        resolve(json);
      } catch {
        reject(new Error('Received invalid data from stream service. Please try again.'));
      }
    });
    p.on('error', (e) => reject(new Error('Failed to run stream downloader: ' + e.message)));
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

async function analyseChunk(chunkFile, chunkIndex, chunkStartSec, currentSession) {
  const [loudness, duration] = await Promise.all([
    ffmpegLoudness(chunkFile),
    ffprobeDuration(chunkFile),
  ]);

  const chatWindow = currentSession.chatMessages.filter(m =>
    m.t >= chunkStartSec && m.t < chunkStartSec + duration
  );
  const funnyChatCount = chatWindow.filter(m => m.funny).length;
  const totalChatCount = chatWindow.length;

  const baselineMean = currentSession.baselineMean ?? -30;
  const audioScore = Math.max(0, Math.min(100, (loudness.max - baselineMean) * 3));
  const chatScore = Math.min(100, funnyChatCount * 15 + totalChatCount * 2);
  const totalScore = Math.round(audioScore * 0.55 + chatScore * 0.45);

  if (currentSession.baselineMean == null) {
    currentSession.baselineMean = loudness.mean;
  } else {
    currentSession.baselineMean = currentSession.baselineMean * 0.85 + loudness.mean * 0.15;
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

  currentSession.chunks.push(moment);
  broadcast({ type: 'chunk', moment });

  if (moment.isHighlight) {
    broadcast({ type: 'highlight', moment });
  }

  return moment;
}

async function startLiveSession(rawUrl) {
  const cleanUrl = validateStreamUrl(rawUrl);

  if (session) await stopLiveSession();

  const id = `live-${Date.now()}`;
  const dir = path.join(TMP_DIR, id);
  fs.mkdirSync(dir, { recursive: true });

  broadcast({ type: 'status', state: 'connecting', msg: 'Connecting to live stream...' });
  let info;
  try {
    info = await getVideoInfo(cleanUrl);
  } catch (e) {
    broadcast({ type: 'status', state: 'error', msg: e.message });
    throw e;
  }

  const isLive = info.live_status === 'is_live' || info.is_live === true;
  const title = info.title || 'Live Stream';
  const channel = info.channel || info.uploader || '';
  const thumb = info.thumbnail || info.thumbnails?.at(-1)?.url || '';

  session = {
    id, url: cleanUrl, dir,
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

  broadcast({ type: 'info', title, channel, thumb, isLive });
  broadcast({ type: 'status', state: 'recording', msg: isLive ? 'Monitoring live stream in real-time...' : 'Monitoring stream...' });

  const chatProc = startChatMonitor(cleanUrl, id);
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
    cleanUrl,
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

  return session;
}

async function stopLiveSession() {
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

export function setupLiveRoutes(app) {
  // SSE Event stream
  app.get('/api/live/events', (req, res) => {
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

    const ping = setInterval(() => {
      try { res.write(': ping\n\n'); } catch {}
    }, 25000);

    req.on('close', () => {
      clearInterval(ping);
      sseClients.delete(res);
    });
  });

  // Start live stream monitoring
  app.post('/api/live/start', async (req, res) => {
    try {
      const { url } = req.body || {};
      if (!url) return res.status(400).json({ error: 'Please paste a stream URL.' });
      const current = await startLiveSession(url);
      res.json({ ok: true, session: { id: current.id, title: current.title, isLive: current.isLive } });
    } catch (e) {
      res.status(400).json({ error: e.message });
    }
  });

  // Stop live monitoring
  app.post('/api/live/stop', async (req, res) => {
    await stopLiveSession();
    res.json({ ok: true });
  });

  // Current state
  app.get('/api/live/state', (req, res) => {
    res.json(session ? {
      id: session.id,
      title: session.title,
      channel: session.channel,
      isLive: session.isLive,
      state: session.state,
      elapsed: session.elapsed,
      chunks: session.chunks,
      thumb: session.thumb,
    } : null);
  });

  // Download raw clip
  app.get('/api/live/clip/:chunkId', (req, res) => {
    const { chunkId } = req.params;
    const s = session;
    if (!s) return res.status(404).send('No active session');
    const chunk = s.chunks.find(c => c.id === chunkId);
    if (!chunk) return res.status(404).send('Chunk not found');
    const filePath = path.join(s.dir, chunk.file);
    if (!fs.existsSync(filePath)) return res.status(404).send('File not found');

    const stat = fs.statSync(filePath);
    res.writeHead(200, {
      'Content-Type': 'video/mp4',
      'Content-Length': stat.size,
      'Content-Disposition': `attachment; filename="highlight-${formatTime(chunk.startSec).replace(/:/g,'-')}.mp4"`,
    });
    fs.createReadStream(filePath).pipe(res);
  });

  // Import directly to Fivestar Project
  app.post('/api/live/import', async (req, res) => {
    const { chunkId } = req.body || {};
    const s = session;
    if (!s) return res.status(400).json({ error: 'No active session' });
    const chunk = s.chunks.find(c => c.id === chunkId);
    if (!chunk) return res.status(404).json({ error: 'Chunk not found' });
    const srcFile = path.join(s.dir, chunk.file);
    if (!fs.existsSync(srcFile)) return res.status(404).json({ error: 'Clip file missing' });

    try {
      const projId = 'p' + Math.random().toString(36).slice(2, 8) + Date.now().toString(36).slice(-4);
      const projDir = path.join(PROJECTS_DIR, projId);
      fs.mkdirSync(projDir, { recursive: true });

      const destFile = path.join(projDir, 'source.mp4');
      fs.copyFileSync(srcFile, destFile);

      const thumbFile = path.join(projDir, 'thumb.jpg');
      spawnSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-ss', '1', '-i', destFile, '-frames:v', '1', '-vf', 'scale=-2:360', '-q:v', '4', thumbFile]);

      const duration = chunk.duration || 60;
      const momentId = 'm' + Math.random().toString(36).slice(2, 8);

      const projJson = {
        id: projId,
        createdAt: Date.now(),
        source: {
          kind: 'file',
          platform: 'file',
          title: `Live Highlight: ${s.title} (${formatTime(chunk.startSec)})`,
          duration,
          width: 1920,
          height: 1080,
          tags: ['live', 'highlight', 'viral'],
          file: 'source.mp4',
          thumbnail: `/files/projects/${projId}/thumb.jpg`,
        },
        status: 'ready',
        steps: [
          { key: 'score', label: 'Find the best moments', state: 'done', note: 'Live viral moment' }
        ],
        signals: [
          { key: 'audio', available: true, detail: `Audio peak score: ${chunk.audioScore}%` },
          { key: 'chat', available: true, detail: `Chat reaction score: ${chunk.chatScore}%` }
        ],
        moments: [
          {
            id: momentId,
            rank: 1,
            start: 0,
            end: Math.min(duration, 60),
            peak: Math.min(duration / 2, 30),
            heat: chunk.score,
            stars: chunk.score >= 60 ? 5 : chunk.score >= 40 ? 4 : 3,
            reasons: [
              { signal: 'chat', strength: chunk.chatScore / 100, label: `Live chat spiked with reactions` },
              { signal: 'audio', strength: chunk.audioScore / 100, label: `Loudest streamer moment` }
            ],
            chat: [],
            custom: false,
          }
        ],
        clips: [],
      };

      fs.writeFileSync(path.join(projDir, 'project.json'), JSON.stringify(projJson, null, 2));

      res.json({ ok: true, projectId: projId });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });
}
