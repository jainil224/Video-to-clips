/**
 * Fivestar Live Stream Clipper & Viral Moments Addon
 * Injected into Fivestar's web UI
 */

(function () {
  console.log('[Fivestar Live Addon] Loaded');

  let activeSession = null;
  let eventSource = null;
  let timerInterval = null;
  let isLiveViewOpen = false;

  // Inject styles
  const styleEl = document.createElement('style');
  styleEl.textContent = `
    /* Topbar Live Button */
    .btn-live-tab {
      display: inline-flex;
      align-items: center;
      gap: 7px;
      padding: 6px 14px;
      margin-left: 10px;
      border-radius: 20px;
      font-size: 13px;
      font-weight: 700;
      color: #fff;
      background: linear-gradient(135deg, #ec4899 0%, #a855f7 100%);
      border: 1px solid rgba(236, 72, 153, 0.4);
      cursor: pointer;
      transition: all 0.2s ease;
      text-decoration: none;
      box-shadow: 0 2px 10px rgba(236, 72, 153, 0.25);
    }
    .btn-live-tab:hover {
      transform: translateY(-1px);
      box-shadow: 0 4px 14px rgba(236, 72, 153, 0.4);
      filter: brightness(1.1);
    }
    .live-pulse-dot {
      width: 8px;
      height: 8px;
      border-radius: 50%;
      background: #ff2255;
      box-shadow: 0 0 8px #ff2255;
      animation: liveGlow 1.2s infinite alternate;
    }
    @keyframes liveGlow {
      0% { opacity: 0.4; transform: scale(0.85); }
      100% { opacity: 1; transform: scale(1.15); }
    }

    /* Live Stream Main Overlay Modal */
    #fivestar-live-modal {
      position: fixed;
      top: 0;
      left: 0;
      width: 100vw;
      height: 100vh;
      background: rgba(10, 8, 20, 0.95);
      backdrop-filter: blur(12px);
      z-index: 99999;
      display: flex;
      flex-direction: column;
      overflow-y: auto;
      color: #f1f0ff;
      font-family: Barlow, system-ui, sans-serif;
      opacity: 0;
      pointer-events: none;
      transition: opacity 0.25s ease;
    }
    #fivestar-live-modal.active {
      opacity: 1;
      pointer-events: auto;
    }

    .live-modal-header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      padding: 16px 28px;
      border-bottom: 1px solid rgba(255, 255, 255, 0.1);
      background: rgba(18, 14, 32, 0.8);
      position: sticky;
      top: 0;
      z-index: 10;
    }
    .live-modal-title {
      display: flex;
      align-items: center;
      gap: 12px;
      font-size: 1.25rem;
      font-weight: 700;
      letter-spacing: 0.5px;
    }
    .live-modal-close {
      background: rgba(255, 255, 255, 0.08);
      border: 1px solid rgba(255, 255, 255, 0.15);
      color: #fff;
      padding: 7px 16px;
      border-radius: 8px;
      font-size: 13px;
      font-weight: 600;
      cursor: pointer;
      transition: background 0.15s;
    }
    .live-modal-close:hover {
      background: rgba(255, 255, 255, 0.18);
    }

    .live-modal-body {
      max-width: 1200px;
      width: 100%;
      margin: 0 auto;
      padding: 24px;
      display: grid;
      grid-template-columns: 1fr 340px;
      gap: 24px;
    }
    @media (max-width: 900px) {
      .live-modal-body { grid-template-columns: 1fr; }
    }

    .live-card {
      background: rgba(22, 18, 38, 0.85);
      border: 1px solid rgba(139, 92, 246, 0.2);
      border-radius: 14px;
      padding: 20px;
      box-shadow: 0 4px 20px rgba(0, 0, 0, 0.4);
    }
    .live-card-title {
      font-size: 0.85rem;
      font-weight: 700;
      color: #cdbfe0;
      text-transform: uppercase;
      letter-spacing: 0.8px;
      margin-bottom: 14px;
    }

    /* URL input */
    .live-input-box {
      display: flex;
      gap: 10px;
    }
    .live-input-box input {
      flex: 1;
      background: rgba(14, 11, 25, 0.9);
      border: 1px solid rgba(139, 92, 246, 0.35);
      border-radius: 10px;
      padding: 12px 16px;
      color: #fff;
      font-size: 15px;
      outline: none;
      transition: border-color 0.2s;
    }
    .live-input-box input:focus {
      border-color: #ec4899;
      box-shadow: 0 0 10px rgba(236, 72, 153, 0.3);
    }
    .live-btn-primary {
      background: linear-gradient(135deg, #ec4899 0%, #8b5cf6 100%);
      color: #fff;
      border: none;
      padding: 12px 22px;
      border-radius: 10px;
      font-weight: 700;
      font-size: 14px;
      cursor: pointer;
      transition: opacity 0.2s, transform 0.15s;
      white-space: nowrap;
    }
    .live-btn-primary:hover {
      opacity: 0.9;
      transform: translateY(-1px);
    }
    .live-btn-danger {
      background: #ef4444;
      color: #fff;
      border: none;
      padding: 12px 18px;
      border-radius: 10px;
      font-weight: 700;
      font-size: 14px;
      cursor: pointer;
    }

    /* Stream status banner */
    .live-status-bar {
      margin-top: 14px;
      padding: 10px 14px;
      border-radius: 8px;
      background: rgba(14, 11, 25, 0.7);
      border: 1px solid rgba(255, 255, 255, 0.08);
      font-size: 13px;
      display: flex;
      align-items: center;
      gap: 10px;
    }

    #live-stream-details {
      display: none;
      align-items: center;
      gap: 14px;
      margin-top: 14px;
      padding: 12px;
      background: rgba(255, 255, 255, 0.03);
      border-radius: 10px;
    }
    #live-stream-details img {
      width: 90px;
      height: 52px;
      border-radius: 6px;
      object-fit: cover;
    }

    /* Highlight moments */
    .live-moment-list {
      display: flex;
      flex-direction: column;
      gap: 12px;
      margin-top: 8px;
    }
    .live-moment-card {
      background: rgba(14, 11, 26, 0.85);
      border: 1px solid rgba(139, 92, 246, 0.25);
      border-left: 4px solid #8b5cf6;
      border-radius: 10px;
      padding: 14px;
      transition: all 0.2s;
    }
    .live-moment-card.viral {
      border-left-color: #ec4899;
      box-shadow: 0 2px 14px rgba(236, 72, 153, 0.15);
    }
    .live-moment-top {
      display: flex;
      align-items: center;
      justify-content: space-between;
    }
    .live-score-pill {
      font-weight: 800;
      font-size: 1.05rem;
      padding: 2px 10px;
      border-radius: 6px;
      background: rgba(236, 72, 153, 0.15);
      color: #ec4899;
      display: inline-flex;
      align-items: center;
      gap: 4px;
    }
    .live-meter-wrap {
      display: flex;
      gap: 8px;
      margin: 8px 0;
    }
    .live-meter {
      flex: 1;
    }
    .live-meter-label {
      font-size: 11px;
      color: #9d95ba;
      margin-bottom: 2px;
    }
    .live-meter-bar {
      height: 6px;
      background: rgba(255, 255, 255, 0.1);
      border-radius: 3px;
      overflow: hidden;
    }
    .live-meter-fill-audio {
      height: 100%;
      background: linear-gradient(90deg, #a855f7, #ec4899);
      border-radius: 3px;
    }
    .live-meter-fill-chat {
      height: 100%;
      background: linear-gradient(90deg, #10b981, #06b6d4);
      border-radius: 3px;
    }
    .live-chat-sample {
      font-size: 12px;
      color: #cdbfe0;
      font-style: italic;
      margin-top: 4px;
    }
    .live-moment-actions {
      display: flex;
      gap: 8px;
      margin-top: 10px;
    }
    .live-btn-action {
      background: rgba(255, 255, 255, 0.08);
      border: 1px solid rgba(255, 255, 255, 0.12);
      color: #fff;
      padding: 6px 12px;
      border-radius: 6px;
      font-size: 12px;
      font-weight: 600;
      cursor: pointer;
      text-decoration: none;
      display: inline-flex;
      align-items: center;
      gap: 4px;
      transition: background 0.15s;
    }
    .live-btn-action:hover {
      background: rgba(255, 255, 255, 0.16);
    }
    .live-btn-action.editor {
      background: rgba(139, 92, 246, 0.25);
      border-color: rgba(139, 92, 246, 0.4);
      color: #d8b4fe;
    }
    .live-btn-action.editor:hover {
      background: rgba(139, 92, 246, 0.4);
    }

    /* Live chat box */
    #live-chat-stream {
      height: 380px;
      overflow-y: auto;
      display: flex;
      flex-direction: column;
      gap: 4px;
      padding-right: 4px;
    }
    .live-chat-row {
      font-size: 12px;
      padding: 4px 6px;
      border-radius: 4px;
      background: rgba(255, 255, 255, 0.02);
    }
    .live-chat-row.funny {
      background: rgba(236, 72, 153, 0.12);
      border-left: 2px solid #ec4899;
    }
    .live-chat-user {
      font-weight: 700;
      color: #c084fc;
      margin-right: 4px;
    }
    .live-stats-row {
      display: grid;
      grid-template-columns: 1fr 1fr;
      gap: 8px;
      margin-bottom: 16px;
    }
    .live-stat-card {
      background: rgba(14, 11, 25, 0.6);
      border-radius: 8px;
      padding: 10px;
      text-align: center;
    }
    .live-stat-val {
      font-size: 1.3rem;
      font-weight: 800;
      color: #ec4899;
    }
    .live-stat-lbl {
      font-size: 10px;
      color: #9d95ba;
      text-transform: uppercase;
      letter-spacing: 0.5px;
    }
  `;
  document.head.appendChild(styleEl);

  // Create Modal element
  const modal = document.createElement('div');
  modal.id = 'fivestar-live-modal';
  modal.innerHTML = `
    <div class="live-modal-header">
      <div class="live-modal-title">
        <span class="live-pulse-dot"></span>
        <span>Live Stream Viral Moments Finder</span>
        <span style="font-size:0.75rem;padding:3px 8px;background:rgba(236,72,153,0.2);color:#f472b6;border-radius:12px;border:1px solid rgba(236,72,153,0.3)">REAL-TIME</span>
      </div>
      <div style="display:flex;align-items:center;gap:12px">
        <span id="live-timer-badge" style="font-size:13px;color:#9d95ba;display:none">⏱ 0:00</span>
        <button class="live-modal-close" id="btn-close-live">✕ Close</button>
      </div>
    </div>

    <div class="live-modal-body">
      <!-- Left Column: Stream controls & Moments -->
      <div style="display:flex;flex-direction:column;gap:18px">
        <div class="live-card">
          <div class="live-card-title">🔴 Paste Live Stream Link</div>
          <div class="live-input-box">
            <input id="live-url-input" type="url" placeholder="Paste YouTube Live, Twitch or Kick stream link..." />
            <button id="btn-start-live" class="live-btn-primary">▶ Start Live Monitor</button>
            <button id="btn-stop-live" class="live-btn-danger" style="display:none">■ Stop</button>
          </div>

          <div id="live-stream-details">
            <img id="live-stream-thumb" src="" alt="Thumbnail" />
            <div style="flex:1">
              <div id="live-stream-title" style="font-weight:700;font-size:14px">—</div>
              <div id="live-stream-channel" style="color:#9d95ba;font-size:12px"></div>
            </div>
            <span style="padding:3px 8px;background:rgba(239,68,68,0.2);color:#ef4444;border-radius:12px;font-size:11px;font-weight:700">LIVE NOW</span>
          </div>

          <div class="live-status-bar" id="live-status-bar">
            <span class="live-pulse-dot" style="width:6px;height:6px"></span>
            <span id="live-status-text">Paste a running live stream link to find viral moments in real time.</span>
          </div>
        </div>

        <div class="live-card">
          <div class="live-card-title">🔥 Detected Viral Moments</div>
          <div class="live-moment-list" id="live-moment-list">
            <div style="text-align:center;padding:32px 16px;color:#857c9c;font-size:13px">
              Moments with high audio volume spikes & chat reaction floods will automatically appear here...
            </div>
          </div>
        </div>
      </div>

      <!-- Right Column: Stats & Live Chat -->
      <div style="display:flex;flex-direction:column;gap:18px">
        <div class="live-card">
          <div class="live-card-title">📈 Live Stream Stats</div>
          <div class="live-stats-row">
            <div class="live-stat-card"><div class="live-stat-val" id="stat-hl-count">0</div><div class="live-stat-lbl">Highlights</div></div>
            <div class="live-stat-card"><div class="live-stat-val" id="stat-sec-count">0</div><div class="live-stat-lbl">Minutes Monitored</div></div>
            <div class="live-stat-card"><div class="live-stat-val" id="stat-msg-count">0</div><div class="live-stat-lbl">Chat Messages</div></div>
            <div class="live-stat-card"><div class="live-stat-val" id="stat-fun-count">0</div><div class="live-stat-lbl">Reaction Spikes</div></div>
          </div>
        </div>

        <div class="live-card" style="flex:1">
          <div class="live-card-title">💬 Live Reaction Chat</div>
          <div id="live-chat-stream">
            <div style="text-align:center;padding:24px 10px;color:#857c9c;font-size:12px">Chat stream will appear when monitoring starts...</div>
          </div>
        </div>
      </div>
    </div>
  `;
  document.body.appendChild(modal);

  // Close button
  document.getElementById('btn-close-live').onclick = () => {
    modal.classList.remove('active');
    isLiveViewOpen = false;
  };

  function openLiveModal(prefillUrl = '') {
    modal.classList.add('active');
    isLiveViewOpen = true;
    if (prefillUrl) {
      document.getElementById('live-url-input').value = prefillUrl;
    }
  }

  // Topbar injection observer
  function injectLiveButton() {
    const topbar = document.querySelector('header.topbar');
    if (!topbar || document.getElementById('fivestar-live-topbar-btn')) return;

    const btn = document.createElement('button');
    btn.id = 'fivestar-live-topbar-btn';
    btn.className = 'btn-live-tab';
    btn.innerHTML = `<span class="live-pulse-dot"></span><span>Live Stream</span>`;
    btn.onclick = () => openLiveModal();

    const spacer = topbar.querySelector('.topbar-spacer') || topbar.children[1];
    if (spacer) {
      topbar.insertBefore(btn, spacer);
    } else {
      topbar.appendChild(btn);
    }
  }

  // Poll for topbar presence
  setInterval(injectLiveButton, 500);

  // Format time helper
  function fmtTime(sec) {
    const m = Math.floor(sec / 60);
    const s = Math.floor(sec % 60);
    return `${m}:${String(s).padStart(2, '0')}`;
  }

  // Connect SSE
  function connectSSE() {
    if (eventSource) eventSource.close();
    eventSource = new EventSource('/api/live/events');

    eventSource.onmessage = (e) => {
      try {
        const d = JSON.parse(e.data);
        handleLiveEvent(d);
      } catch {}
    };
  }

  let hlCount = 0, msgCount = 0, funCount = 0;

  function handleLiveEvent(d) {
    if (d.type === 'status') {
      document.getElementById('live-status-text').textContent = d.msg || d.state;
      if (d.state === 'recording') {
        document.getElementById('btn-start-live').style.display = 'none';
        document.getElementById('btn-stop-live').style.display = '';
      } else {
        document.getElementById('btn-start-live').style.display = '';
        document.getElementById('btn-stop-live').style.display = 'none';
      }
    }

    if (d.type === 'info') {
      const details = document.getElementById('live-stream-details');
      details.style.display = 'flex';
      document.getElementById('live-stream-title').textContent = d.title;
      document.getElementById('live-stream-channel').textContent = d.channel;
      document.getElementById('live-stream-thumb').src = d.thumb;

      const timerBadge = document.getElementById('live-timer-badge');
      timerBadge.style.display = '';
      const startT = Date.now();
      clearInterval(timerInterval);
      timerInterval = setInterval(() => {
        const elapsed = Math.round((Date.now() - startT) / 1000);
        timerBadge.textContent = '⏱ ' + fmtTime(elapsed);
        document.getElementById('stat-sec-count').textContent = Math.round(elapsed / 60);
      }, 1000);
    }

    if (d.type === 'chunk' || d.type === 'highlight') {
      const m = d.moment;
      if (m.isHighlight) {
        hlCount++;
        document.getElementById('stat-hl-count').textContent = hlCount;
        renderMomentCard(m);
      }
    }

    if (d.type === 'chat') {
      msgCount++;
      if (d.msg.funny) funCount++;
      document.getElementById('stat-msg-count').textContent = msgCount;
      document.getElementById('stat-fun-count').textContent = funCount;

      const chatBox = document.getElementById('live-chat-stream');
      if (chatBox.querySelector('[style*="text-align"]')) chatBox.innerHTML = '';

      const row = document.createElement('div');
      row.className = 'live-chat-row' + (d.msg.funny ? ' funny' : '');
      row.innerHTML = `<span class="live-chat-user">${escapeHtml(d.msg.author)}:</span> <span>${escapeHtml(d.msg.text)}</span>`;
      chatBox.appendChild(row);
      chatBox.scrollTop = chatBox.scrollHeight;
      if (chatBox.children.length > 120) chatBox.removeChild(chatBox.firstChild);
    }
  }

  function renderMomentCard(m) {
    const list = document.getElementById('live-moment-list');
    if (list.querySelector('[style*="text-align"]')) list.innerHTML = '';

    const card = document.createElement('div');
    card.className = 'live-moment-card' + (m.score >= 50 ? ' viral' : '');

    const chatQuote = m.sampleChat && m.sampleChat.length ? `"${escapeHtml(m.sampleChat[0])}"` : '';

    card.innerHTML = `
      <div class="live-moment-top">
        <span style="font-weight:700;font-size:13px">${fmtTime(m.startSec)} – ${fmtTime(m.endSec)}</span>
        <span class="live-score-pill">🔥 ${m.score}</span>
      </div>
      <div class="live-meter-wrap">
        <div class="live-meter">
          <div class="live-meter-label">Audio Peak: ${m.audioScore}%</div>
          <div class="live-meter-bar"><div class="live-meter-fill-audio" style="width:${m.audioScore}%"></div></div>
        </div>
        <div class="live-meter">
          <div class="live-meter-label">Chat Reactions: ${m.chatScore}%</div>
          <div class="live-meter-bar"><div class="live-meter-fill-chat" style="width:${m.chatScore}%"></div></div>
        </div>
      </div>
      ${chatQuote ? `<div class="live-chat-sample">💬 Chat reaction: ${chatQuote}</div>` : ''}
      <div class="live-moment-actions">
        <a class="live-btn-action" href="/api/live/clip/${m.id}" download>⬇ Save Clip</a>
        <button class="live-btn-action editor" onclick="window.importLiveMomentToFivestar('${m.id}')">✨ Open in Fivestar Editor</button>
      </div>
    `;
    list.prepend(card);
  }

  function escapeHtml(str) {
    return String(str).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  window.importLiveMomentToFivestar = async function (chunkId) {
    try {
      const res = await fetch('/api/live/import', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chunkId }),
      });
      const data = await res.json();
      if (data.ok && data.projectId) {
        modal.classList.remove('active');
        window.location.href = `/stream/${data.projectId}`;
      } else {
        alert(data.error || 'Failed to import clip');
      }
    } catch (e) {
      alert('Error importing clip: ' + e.message);
    }
  };

  // Start live monitoring button
  document.getElementById('btn-start-live').onclick = async () => {
    const url = document.getElementById('live-url-input').value.trim();
    if (!url) return alert('Please enter a live stream URL.');

    hlCount = 0; msgCount = 0; funCount = 0;
    document.getElementById('stat-hl-count').textContent = '0';
    document.getElementById('stat-msg-count').textContent = '0';
    document.getElementById('stat-fun-count').textContent = '0';
    document.getElementById('live-moment-list').innerHTML = '<div style="text-align:center;padding:24px 10px;color:#857c9c;font-size:13px">Monitoring stream... highlights will appear shortly.</div>';
    document.getElementById('live-status-text').textContent = 'Connecting...';

    connectSSE();

    try {
      const res = await fetch('/api/live/start', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url }),
      });
      const data = await res.json();
      if (!data.ok) throw new Error(data.error || 'Failed to connect');
    } catch (err) {
      alert(err.message);
      document.getElementById('live-status-text').textContent = 'Failed: ' + err.message;
    }
  };

  // Stop live monitoring button
  document.getElementById('btn-stop-live').onclick = async () => {
    await fetch('/api/live/stop', { method: 'POST' });
    clearInterval(timerInterval);
    document.getElementById('live-timer-badge').style.display = 'none';
  };

  // Intercept main Fivestar form submission if a live stream is pasted
  window.addEventListener('submit', (e) => {
    const input = document.querySelector('input[type="url"], input[type="text"]');
    if (input && input.value && (/youtube\.com\/live/i.test(input.value) || /live/i.test(input.value) || /twitch\.tv/i.test(input.value))) {
      // User entered a live stream link in the main page
      openLiveModal(input.value);
    }
  }, true);

  connectSSE();
})();
