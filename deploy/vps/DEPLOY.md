# Shiba Hit Backend — VPS Deploy Guide

One self-contained file (`server.cjs`, all dependencies baked in) + asset folders.
**No `npm install` is ever run on the VPS — nothing can fail to build.**

## What's in this package
- `server.cjs`            — the entire backend, single file (Node 18+)
- `public/`               — Knife Hit game + arcade files served at /game and /arcade
- `server/templates/`     — landing page template
- `app.json`              — app name for the landing page
- `.env.example`          — copy to `.env` and fill in
- `shib-backend.service`  — systemd unit (auto-start + auto-restart)
- `nginx-backend.webcod.in.conf` — nginx reverse proxy with WebSocket support

## 1. One-time VPS setup (as root)

```bash
# Install Node.js 20 if not present (check first: node -v)
curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
apt-get install -y nodejs nginx certbot python3-certbot-nginx unzip

# Create app directory
mkdir -p /opt/shib-backend
```

## 2. Upload and unpack

From your own computer (where the zip is):
```bash
scp shib-backend-vps.zip root@YOUR_VPS_IP:/opt/shib-backend/
```

On the VPS:
```bash
cd /opt/shib-backend
unzip -o shib-backend-vps.zip
cp .env.example .env
nano .env        # fill in the values — see section 3
chmod 600 .env
chown -R www-data:www-data /opt/shib-backend
```

## 3. Fill in .env

Copy the SAME values Railway currently uses (Railway dashboard → Variables):
- `PB_ADMIN_EMAIL` / `PB_ADMIN_PASSWORD` — your PocketBase admin login
- `SESSION_SECRET` — **must be the same value as on Railway**, otherwise
  game sessions started before the switch get rejected.
  If Railway has NO SESSION_SECRET set, leave it empty here too for the
  cutover (both servers then use the same built-in fallback). A day after
  the cutover, set a real one (`openssl rand -hex 32`) and restart —
  do it at a quiet hour, since any game in progress at that exact moment
  will be asked to replay.
- `SMTP_USER` / `SMTP_KEY` — Brevo SMTP credentials (optional)
- Keep `NODE_ENV=production` and `PORT=3001`
  (the server also honors `SERVER_PORT` — either works)

## 4. Start the service

```bash
cp /opt/shib-backend/shib-backend.service /etc/systemd/system/
systemctl daemon-reload
systemctl enable --now shib-backend
systemctl status shib-backend      # should say "active (running)"
journalctl -u shib-backend -f      # live logs (Ctrl+C to exit)

# Local smoke test:
curl -s http://127.0.0.1:3001/ | head -5     # should print landing page HTML
```

## 5. nginx + TLS certificate — BEFORE touching DNS

Get the certificate FIRST, while backend.webcod.in still points at Railway.
This avoids a broken window where apps reach the VPS but get a TLS error.
Use the DNS challenge (no traffic to the VPS needed):

```bash
certbot certonly --manual --preferred-challenges dns -d backend.webcod.in
# certbot prints a TXT record like:
#   _acme-challenge.backend.webcod.in  →  "random-string"
# Add that TXT record in your DNS panel, wait ~2 min, press Enter.
# Cert lands in /etc/letsencrypt/live/backend.webcod.in/
```

Install the nginx site and add the cert:
```bash
cp /opt/shib-backend/nginx-backend.webcod.in.conf /etc/nginx/sites-available/backend.webcod.in
ln -sf /etc/nginx/sites-available/backend.webcod.in /etc/nginx/sites-enabled/
certbot install --nginx -d backend.webcod.in   # wires the cert into the site
nginx -t && systemctl reload nginx
```

Also lower the TTL of the `backend` DNS record to 300 (5 min) NOW, so the
switch in step 6 propagates fast.

## 6. Switch DNS (the actual cutover)

In your DNS panel for webcod.in:
- DELETE the CNAME record `backend` → `shib-mine-backend-production.up.railway.app`
- ADD an A record: `backend` → `YOUR_VPS_IP`   (TTL 300)

Verify from anywhere:
```bash
curl -s https://backend.webcod.in/ | head -5
curl -s -o /dev/null -w "%{http_code}\n" https://backend.webcod.in/game/index.html   # 200
```

## 7. Kill Railway — ONLY after step 6 verified

Every installed APK reaches the backend as `https://backend.webcod.in`, so once
DNS points at the VPS and the curl checks above pass, Railway receives no more
traffic and you can delete the Railway service. **Do not delete it before the
DNS switch is verified** or live apps will break.

## Updating the backend later

When the code changes, a new `server.cjs` is built on Replit. To update:
```bash
scp server.cjs root@YOUR_VPS_IP:/opt/shib-backend/server.cjs
ssh root@YOUR_VPS_IP systemctl restart shib-backend
```
That's it — one file, one restart, zero build steps.
