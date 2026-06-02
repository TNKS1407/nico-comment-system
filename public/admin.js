(() => {
  const $ = (id) => document.getElementById(id);

  function showMsg(s) {
    const el = $('msg');
    el.style.display = 'block';
    el.textContent = s;
  }

  async function getState() {
    const res = await fetch('/api/v1/admin/state', { cache: 'no-store' });
    return res.json();
  }

  async function apply(patch) {
    const res = await fetch('/api/v1/admin/apply', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(patch),
      cache: 'no-store'
    });
    return res.json();
  }

  async function reloadConfig() {
    const res = await fetch('/api/v1/admin/reload-config', { cache: 'no-store' });
    return res.json();
  }

  function setLinks(baseUrl, eventKey) {
    const b = baseUrl.replace(/\/+$/, '');
    $('linkPost').href = `${b}/p/${encodeURIComponent(eventKey)}`;
    $('linkScreen').href = `${b}/s/${encodeURIComponent(eventKey)}`;
    $('linkQrPost').href = `${b}/q/${encodeURIComponent(eventKey)}`;
    $('linkQrScreen').href = `${b}/q/${encodeURIComponent(eventKey)}/screen`;
  }

  function renderPalette(colors) {
    const box = $('palette');
    box.innerHTML = '';
    (colors || []).forEach(c => {
      const d = document.createElement('div');
      d.className = 'colorBtn';
      d.style.background = c;
      d.title = c;
      box.appendChild(d);
    });
  }

  async function refresh() {
    const st = await getState();
    if (!st.ok) throw new Error('state fetch failed');
    $('eventPill').textContent = 'event: ' + st.eventKey;
    $('baseUrl').textContent = st.baseUrl;

    setLinks(st.baseUrl, st.eventKey);

    $('togglePosting').textContent = '投稿: ' + (st.postingEnabled ? 'ON' : 'OFF');
    $('toggleRendering').textContent = '表示: ' + (st.renderingEnabled ? 'ON' : 'OFF');

    $('stats').textContent =
      `pending=${st.stats.pending} / sseClients=${st.stats.sseClients} / rateLimit=${st.rateLimit.maxPerWindow} per ${st.rateLimit.windowMs}ms`;

    // renderer
    $('defaultTextColor').value = st.renderer.defaultTextColor || '#ffffff';
    $('strokeColor').value = st.renderer.strokeColor || '#000000';
    $('lanes').value = st.renderer.lanes;
    $('speed').value = st.renderer.speedPxPerSec;
    $('fontSize').value = st.renderer.fontSizePx;
    $('strokePx').value = st.renderer.strokePx;

    $('forceSingleColor').checked = !!(st.features && st.features.forceSingleColor);

    // chime
    $('chimeEnabled').checked = !!(st.chime && st.chime.enabled);
    $('chimePause').checked = !!(st.chime && st.chime.pauseCommentsWhileShowing);
    $('chimeInterval').value = st.chime.intervalMinutes || 10;
    $('chimeDuration').value = st.chime.durationSeconds || 20;
    $('chimeFormat').value = st.chime.format || 'HH:mm';

    // screen QR overlay
    const qro = st.screenQrOverlay || {};
    if ($('screenQrEnabled')) {
      $('screenQrEnabled').checked = !!qro.enabled;
      $('screenQrMode').value = qro.mode || 'post';
      $('screenQrPosition').value = qro.position || 'bottom-right';
      $('screenQrSize').value = qro.sizePx || 120;
      $('screenQrMargin').value = qro.marginPx || 16;
      $('screenQrOpacity').value = (qro.opacity ?? 0.95);
      $('screenQrStatus').textContent = '';
    }

    // guest colors
    $('guestColorEnabled').checked = !!(st.features && st.features.guestColorEnabled);
    renderPalette(st.features.allowedGuestColors);

    showMsg('');
  }

  $('togglePosting').onclick = async () => {
    const st = await getState();
    await apply({ postingEnabled: !st.postingEnabled });
    await refresh();
  };

  $('toggleRendering').onclick = async () => {
    const st = await getState();
    await apply({ renderingEnabled: !st.renderingEnabled });
    await refresh();
  };

  $('clearQueue').onclick = async () => {
    await apply({ clearQueue: true });
    await refresh();
  };

  $('emergencyStop').onclick = async () => {
    if (!confirm('緊急停止しますか？（投稿停止＋表示停止＋キュークリア）')) return;
    await apply({ emergencyStop: true });
    await refresh();
  };

  $('releaseEmergency').onclick = async () => {
    await apply({ releaseEmergency: true, postingEnabled: true, renderingEnabled: true });
    await refresh();
  };

  $('applyRenderer').onclick = async () => {
    await apply({
      renderer: {
        defaultTextColor: $('defaultTextColor').value,
        strokeColor: $('strokeColor').value,
        lanes: Number($('lanes').value),
        speedPxPerSec: Number($('speed').value),
        fontSizePx: Number($('fontSize').value),
        strokePx: Number($('strokePx').value),
      },
      features: {
        forceSingleColor: $('forceSingleColor').checked
      }
    });
    await refresh();
  };

  $('applyChime').onclick = async () => {
    await apply({
      chime: {
        enabled: $('chimeEnabled').checked,
        pauseCommentsWhileShowing: $('chimePause').checked,
        intervalMinutes: Number($('chimeInterval').value),
        durationSeconds: Number($('chimeDuration').value),
        format: $('chimeFormat').value
      }
    });
    await refresh();
  };

  $('applyGuestColors').onclick = async () => {
    await apply({
      features: {
        guestColorEnabled: $('guestColorEnabled').checked
      }
    });
    await refresh();
  };

  $('applyScreenQr').onclick = async () => {
    await apply({
      screenQrOverlay: {
        enabled: $('screenQrEnabled').checked,
        mode: $('screenQrMode').value,
        position: $('screenQrPosition').value,
        sizePx: Number($('screenQrSize').value),
        marginPx: Number($('screenQrMargin').value),
        opacity: Number($('screenQrOpacity').value)
      }
    });
    await refresh();
    $('screenQrStatus').textContent = '反映しました';
  };

  $('reload').onclick = async () => {
    await reloadConfig();
    await refresh();
  };

  refresh().catch(e => showMsg('Error: ' + e.message));
})();
