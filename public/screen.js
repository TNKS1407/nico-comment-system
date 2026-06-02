(() => {
  const canvas = document.getElementById('c');
  const ctx = canvas.getContext('2d');
  const banner = document.getElementById('banner');
  const pausedEl = document.getElementById('paused');
  const timeOverlay = document.getElementById('timeOverlay');
  const timeText = document.getElementById('timeText');
  const qrOverlay = document.getElementById('qrOverlay');

  const eventKey = (() => {
    const m = location.pathname.match(/\/s\/([^\/]+)/);
    return m ? decodeURIComponent(m[1]) : null;
  })();

  const state = {
    baseUrl: null,
    renderer: {
      lanes: 10,
      speedPxPerSec: 240,
      fontFamily: 'sans-serif',
      fontSizePx: 48,
      strokePx: 6,
      defaultTextColor: '#FFFFFF',
      strokeColor: '#000000',
      laneGapPx: 10,
      entryGapPx: 40
    },
    features: {
      forceSingleColor: false
    },
    chime: {
      enabled: false,
      intervalMinutes: 10,
      durationSeconds: 20,
      pauseCommentsWhileShowing: true,
      format: 'HH:mm'
    },
    screenQrOverlay: { enabled:false, position:'bottom-right', mode:'post', sizePx:120, marginPx:16, opacity:0.95 },
    postingEnabled: true,
    renderingEnabled: true,
    emergency: false,
    delayMs: 3000,
    connected: false
  };

  // Scroller state
  const lanes = []; // lane -> { lastItem }
  let active = [];  // items currently moving
  let pending = []; // items waiting to be scheduled: { comment, readyAtMs }
  let lastFrameMs = performance.now();
  let pausedByAdmin = false;
  let pausedByChime = false;
  let lastChimeMinuteKey = null;

  function resize() {
    const dpr = window.devicePixelRatio || 1;
    canvas.width = Math.floor(window.innerWidth * dpr);
    canvas.height = Math.floor(window.innerHeight * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0); // draw in CSS pixels
  }
  window.addEventListener('resize', resize);
  resize();

  function clearAll() {
    active = [];
    pending = [];
    lanes.length = 0;
    for (let i = 0; i < state.renderer.lanes; i++) lanes.push({ last: null });
  }
  function applyState(s) {
    if (!s) return;
    state.baseUrl = s.baseUrl || state.baseUrl;
    state.postingEnabled = !!s.postingEnabled;
    state.renderingEnabled = !!s.renderingEnabled;
    state.emergency = !!s.emergency;
    state.delayMs = Number(s.delayMs || state.delayMs);
    state.features = s.features || state.features;
    state.renderer = s.renderer || state.renderer;
    state.chime = s.chime || state.chime;
    state.screenQrOverlay = s.screenQrOverlay || state.screenQrOverlay;

    // handle lanes change
    if (lanes.length !== state.renderer.lanes) {
      clearAll();
    }

    pausedByAdmin = !state.renderingEnabled || state.emergency;
    pausedEl.style.display = pausedByAdmin ? 'flex' : 'none';

    banner.textContent =
      `${state.baseUrl ? state.baseUrl.replace(/^https?:\/\//,'') : 'local'} | event ${eventKey} | ` +
      `clients: ${state.connected ? 'on' : 'off'} | post:${state.postingEnabled?'on':'off'} | render:${state.renderingEnabled?'on':'off'} | ` +
      `chime:${state.chime.enabled?'on':'off'}`;

    updateQrOverlay();
  }


  function updateQrOverlay(){
    if (!qrOverlay) return;
    const q = state.screenQrOverlay || {};
    if (q.enabled !== true){
      qrOverlay.style.display = 'none';
      return;
    }

    const size = Math.max(60, Math.min(320, Number(q.sizePx) || 120));
    const margin = Math.max(0, Math.min(120, Number(q.marginPx) || 16));
    const opacity = Number.isFinite(Number(q.opacity)) ? Number(q.opacity) : 0.95;

    // reset
    qrOverlay.style.top = '';
    qrOverlay.style.bottom = '';
    qrOverlay.style.left = '';
    qrOverlay.style.right = '';

    const pos = String(q.position || 'bottom-right');
    if (pos.includes('top')) qrOverlay.style.top = margin + 'px';
    else qrOverlay.style.bottom = margin + 'px';
    if (pos.includes('left')) qrOverlay.style.left = margin + 'px';
    else qrOverlay.style.right = margin + 'px';

    qrOverlay.style.opacity = String(opacity);

    // QR target
    const base = state.baseUrl || (location.origin || '');
    const mode = String(q.mode || 'post');
    const targetUrl = (mode === 'screen')
      ? `${base}/s/${eventKey}`
      : `${base}/p/${eventKey}`;

    const imgUrl = `https://api.qrserver.com/v1/create-qr-code/?size=${size}x${size}&margin=0&data=${encodeURIComponent(targetUrl)}`;
    qrOverlay.style.width = (size + 12) + 'px';
    qrOverlay.style.height = (size + 12) + 'px';

    if (qrOverlay.dataset.src !== imgUrl){
      qrOverlay.src = imgUrl;
      qrOverlay.dataset.src = imgUrl;
    }
    qrOverlay.style.display = 'block';
  }

  function colorFor(comment) {
    if (state.features && state.features.forceSingleColor) return state.renderer.defaultTextColor;
    return comment.color || state.renderer.defaultTextColor;
  }

  function measureWidth(text) {
    ctx.font = `${state.renderer.fontSizePx}px ${state.renderer.fontFamily}`;
    return ctx.measureText(text).width;
  }

  function laneY(i) {
    const h = state.renderer.fontSizePx;
    const gap = state.renderer.laneGapPx;
    return (i + 1) * (h + gap);
  }

  function canStartInLane(laneIndex, width) {
    const lane = lanes[laneIndex];
    if (!lane.last) return true;
    const last = lane.last;
    const rightEdge = last.x + last.width;
    const canvasW = window.innerWidth;
    return rightEdge + state.renderer.entryGapPx <= canvasW;
  }

  function startItem(comment) {
    const width = measureWidth(comment.text);
    // pick lane
    let laneIndex = -1;
    for (let i = 0; i < lanes.length; i++) {
      if (canStartInLane(i, width)) { laneIndex = i; break; }
    }
    if (laneIndex < 0) return false; // no lane free
    const item = {
      id: comment.id,
      text: comment.text,
      color: colorFor(comment),
      width,
      lane: laneIndex,
      x: window.innerWidth + 4,
      y: laneY(laneIndex),
    };
    lanes[laneIndex].last = item;
    active.push(item);
    return true;
  }

  function tickSchedule(nowMs) {
    if (pausedByAdmin || pausedByChime) return;
    // move ready comments from pending->attempt start
    pending.sort((a,b)=>a.readyAtMs-b.readyAtMs);
    let moved = true;
    while (moved) {
      moved = false;
      const readyIdx = pending.findIndex(p => p.readyAtMs <= nowMs);
      if (readyIdx === -1) break;
      const p = pending.splice(readyIdx, 1)[0];
      if (!startItem(p.comment)) {
        // put back and stop trying this frame
        pending.unshift(p);
        break;
      }
      moved = true;
    }
  }

  function update(dtSec) {
    if (pausedByAdmin || pausedByChime) return;
    const speed = state.renderer.speedPxPerSec;
    for (const it of active) {
      it.x -= speed * dtSec;
    }
    // remove offscreen
    active = active.filter(it => (it.x + it.width) > -20);
  }

  function draw() {
    // clear
    ctx.clearRect(0,0,window.innerWidth,window.innerHeight);
    // draw active comments
    ctx.font = `${state.renderer.fontSizePx}px ${state.renderer.fontFamily}`;
    ctx.textBaseline = 'alphabetic';
    ctx.lineJoin = 'round';
    ctx.lineCap = 'round';
    for (const it of active) {
      const x = it.x;
      const y = it.y;
      // stroke
      if (state.renderer.strokePx > 0) {
        ctx.lineWidth = state.renderer.strokePx;
        ctx.strokeStyle = state.renderer.strokeColor;
        ctx.strokeText(it.text, x, y);
      }
      ctx.fillStyle = it.color;
      ctx.fillText(it.text, x, y);
    }
  }

  function fmtTime(d) {
    const hh = String(d.getHours()).padStart(2,'0');
    const mm = String(d.getMinutes()).padStart(2,'0');
    const ss = String(d.getSeconds()).padStart(2,'0');
    switch (state.chime.format) {
      case 'HH:mm:ss': return `${hh}:${mm}:${ss}`;
      case 'HH:mm':
      default: return `${hh}:${mm}`;
    }
  }

  function maybeTriggerChime(now) {
    if (!state.chime.enabled) return;
    const interval = Math.max(1, Number(state.chime.intervalMinutes || 10));
    const minuteKey = `${now.getFullYear()}-${now.getMonth()}-${now.getDate()}-${now.getHours()}-${now.getMinutes()}`;
    if (lastChimeMinuteKey === minuteKey) return;
    if (now.getMinutes() % interval !== 0) return;
    if (now.getSeconds() > 1) return; // within first 2 seconds
    lastChimeMinuteKey = minuteKey;

    // show overlay
    timeText.textContent = fmtTime(now);
    timeOverlay.style.display = 'flex';

    if (state.chime.pauseCommentsWhileShowing) pausedByChime = true;

    const dur = Math.max(3, Number(state.chime.durationSeconds || 20));
    const start = Date.now();

    const timer = setInterval(() => {
      const n = new Date();
      timeText.textContent = fmtTime(n);
      if ((Date.now() - start) > dur * 1000) {
        clearInterval(timer);
        timeOverlay.style.display = 'none';
        pausedByChime = false;
      }
    }, 250);
  }

  function loop() {
    const nowPerf = performance.now();
    const now = Date.now();
    const dtMs = nowPerf - lastFrameMs;
    lastFrameMs = nowPerf;

    maybeTriggerChime(new Date());

    tickSchedule(now);
    update(dtMs / 1000);
    draw();

    requestAnimationFrame(loop);
  }

  function connectSSE() {
    const es = new EventSource(`/api/v1/e/${encodeURIComponent(eventKey)}/events`);
    es.addEventListener('open', () => {
      state.connected = true;
      applyState(state);
    });
    es.addEventListener('error', () => {
      state.connected = false;
      applyState(state);
    });
    es.addEventListener('state', (ev) => {
      try {
        const s = JSON.parse(ev.data);
        applyState(s);
      } catch {}
    });
    es.addEventListener('comment', (ev) => {
      try {
        const c = JSON.parse(ev.data);
        // schedule by server time
        const readyAt = Number(c.displayAfterMs || (Date.now() + state.delayMs));
        pending.push({ comment: c, readyAtMs: readyAt });
      } catch {}
    });
    es.addEventListener('control', (ev) => {
      try {
        const p = JSON.parse(ev.data);
        if (p.cmd === 'CLEAR') clearAll();
        if (p.cmd === 'STOP') { pausedByAdmin = true; pausedEl.style.display='flex'; }
      } catch {}
    });
  }

  if (!eventKey) {
    banner.textContent = 'Invalid URL';
    return;
  }

  clearAll();
  connectSSE();
  loop();

  // Allow click to toggle fullscreen
  document.body.addEventListener('click', () => {
    if (!document.fullscreenElement) document.documentElement.requestFullscreen?.();
  });
})();
