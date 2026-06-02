(() => {
  const $ = (id) => document.getElementById(id);

  const eventKey = (() => {
    const m = location.pathname.match(/\/p\/([^\/]+)/);
    return m ? decodeURIComponent(m[1]) : null;
  })();

  const state = {
    baseUrl: null,
    allowedColors: [],
    guestColorEnabled: false,
    selectedColor: null,
  };

  function showStatus(kind, msg) {
    const el = $('status');
    el.style.display = 'block';
    el.className = 'status ' + (kind === 'ok' ? 'ok' : 'bad');
    el.textContent = msg;
  }

  function hideStatus() {
    const el = $('status');
    el.style.display = 'none';
  }

  function renderColors() {
    const area = $('colorArea');
    const box = $('colors');
    box.innerHTML = '';
    if (!state.guestColorEnabled || !state.allowedColors.length) {
      area.style.display = 'none';
      return;
    }
    area.style.display = 'block';

    state.allowedColors.forEach((c, idx) => {
      const btn = document.createElement('div');
      btn.className = 'colorBtn' + ((state.selectedColor || state.allowedColors[0]) === c ? ' selected' : '');
      btn.style.background = c;
      btn.title = c;
      btn.onclick = () => {
        state.selectedColor = c;
        renderColors();
      };
      box.appendChild(btn);
      if (!state.selectedColor && idx === 0) state.selectedColor = c;
    });
  }

  async function fetchPublic() {
    const res = await fetch(`/api/v1/e/${encodeURIComponent(eventKey)}/public`, { cache: 'no-store' });
    const j = await res.json();
    if (!j.ok) throw new Error('public config fetch failed');
    state.baseUrl = j.baseUrl;
    state.allowedColors = (j.features && Array.isArray(j.features.allowedGuestColors)) ? j.features.allowedGuestColors : [];
    state.guestColorEnabled = !!(j.features && j.features.guestColorEnabled);
    $('eventPill').textContent = 'event: ' + j.eventKey;
    $('count').textContent = `max ${j.limits.maxTextLen}`;
    renderColors();
  }

  async function send() {
    hideStatus();
    const text = $('text').value || '';
    const payload = { text };
    if (state.guestColorEnabled && state.selectedColor) payload.color = state.selectedColor;

    const res = await fetch(`/api/v1/e/${encodeURIComponent(eventKey)}/comment`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      cache: 'no-store'
    });
    const j = await res.json();
    if (j.ok) {
      showStatus('ok', '送信しました');
      $('text').value = '';
      $('text').focus();
      return;
    }
    // soft errors (ok: false)
    const code = j.code || 'ERROR';
    const msg = ({
      'RATE_LIMIT': '連投が速すぎます。少し待ってから送ってください。',
      'QUEUE_FULL': '混雑中です。少し待ってから送ってください。',
      'EVENT_PAUSED': '現在受付停止中です。',
      'TOO_LONG': '文字数が多すぎます。',
      'EMPTY': '空のコメントは送れません。',
      'REJECTED': 'このコメントは送れません（NG判定）'
    })[code] || ('送信できませんでした: ' + code);
    showStatus('bad', msg);
  }

  $('send').onclick = () => send().catch(e => showStatus('bad', e.message));
  $('clear').onclick = () => { $('text').value=''; hideStatus(); $('text').focus(); };

  $('text').addEventListener('input', () => {
    $('count').textContent = String(($('text').value || '').length);
  });

  $('text').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); send().catch(e2 => showStatus('bad', e2.message)); }
  });

  if (!eventKey) {
    showStatus('bad', 'URLが不正です');
    return;
  }

  fetchPublic().catch(e => showStatus('bad', e.message));
})();
