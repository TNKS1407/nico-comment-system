# Nico Comment System (Portable / Windows)

## Local
- `start-local.bat` でローカル起動  
  - SCREEN: `http://localhost:3100/s/A7kP3dQ9`
  - ADMIN : `http://localhost:3100/admin`

## Public (Cloudflare Tunnel)
1. `setup_all.ps1` を実行（Tunnel作成/設定）
2. `start-public.bat` で起動（Node + cloudflared を別ウィンドウで起動）
3. 停止は `stop-all.bat`

## QR Overlay (表示画面にQR)
`config/config.json` の `screenQrOverlay`:
- `enabled`: true/false
- `position`: "top-left" / "top-right" / "bottom-left" / "bottom-right"
- `sizePx`: 120 など
