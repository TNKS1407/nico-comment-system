Nico Comment System - Clean Start (Windows)

1) Extract this ZIP to any folder (avoid very long paths).
2) Double-click: RUNME_SETUP.bat
   - It installs Node.js LTS and cloudflared (via winget) if missing
   - It logs into Cloudflare (browser opens) and creates/updates a tunnel for nico.tnks1407.com
   - It starts Node server + tunnel
3) Open:
   - https://nico.tnks1407.com/p/<eventKey>  (post)
   - https://nico.tnks1407.com/s/<eventKey>  (screen)
   - https://nico.tnks1407.com/admin         (admin)
   - https://nico.tnks1407.com/q/<eventKey>  (QR board)

Important:
- Change admin password and security.hashSalt in config/config.json
- cloudflared will create/update DNS record for nico.tnks1407.com to point to THIS PC's tunnel.
