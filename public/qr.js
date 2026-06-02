(() => {
  const mode = window.QR_MODE || 'post';
  const eventKey = (() => {
    const m = location.pathname.match(/\/q\/([^\/]+)/);
    return m ? decodeURIComponent(m[1]) : null;
  })();

  const qr = document.getElementById('qr');
  const urlEl = document.getElementById('url');

  async function main() {
    if (!eventKey) throw new Error('bad url');
    const res = await fetch(`/api/v1/e/${encodeURIComponent(eventKey)}/public`, { cache: 'no-store' });
    const j = await res.json();
    if (!j.ok) throw new Error('public config fetch failed');
    const baseUrl = (j.baseUrl || location.origin).replace(/\/+$/, '');
    const target = mode === 'screen'
      ? `${baseUrl}/s/${encodeURIComponent(eventKey)}`
      : `${baseUrl}/p/${encodeURIComponent(eventKey)}`;

    urlEl.textContent = target;
    const size = new URL(location.href).searchParams.get('size') || '900';
    const api = `https://api.qrserver.com/v1/create-qr-code/?size=${encodeURIComponent(size)}x${encodeURIComponent(size)}&data=${encodeURIComponent(target)}`;
    qr.src = api;
    qr.onerror = () => {
      // fallback: show url text if image blocked
      urlEl.style.opacity = '1';
      urlEl.style.fontSize = '28px';
      urlEl.style.opacity = '1';
      urlEl.textContent = target;
    };
  }

  document.body.addEventListener('click', () => {
    if (!document.fullscreenElement) document.documentElement.requestFullscreen?.();
  });

  main().catch(() => {
    urlEl.style.opacity = '1';
    urlEl.textContent = 'QRの生成に失敗しました';
  });
})();
