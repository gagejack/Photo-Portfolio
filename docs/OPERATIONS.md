# Operations Guide

Running the photo portfolio on the Ubuntu server.

## Where things live

| Thing | Path |
|---|---|
| App code | `/opt/photoportfolio` |
| Config / secrets | `/opt/photoportfolio/.env` |
| Database | `/opt/photoportfolio/data/app.db` |
| Photo files | `/opt/photoportfolio/data/photos/` (`originals/`, `display/`, `thumb/`) |
| systemd unit | `/etc/systemd/system/photoportfolio.service` |
| Cloudflare tunnel config | `/etc/cloudflared/config.yml` |

- Runs as user `gagejack`, bound to `127.0.0.1:3000`.
- Public URL `https://gagejack.com` via the shared `cloudflared` tunnel (same tunnel also serves `outbidarcade.lol`).
- Originals are never served to browsers — only `display` and `thumb` variants.

## Service control

```bash
# Status — is it running, when did it start, recent log lines
sudo systemctl status photoportfolio

# Restart (after a code change or config edit)
sudo systemctl restart photoportfolio

# Stop
sudo systemctl stop photoportfolio

# Start
sudo systemctl start photoportfolio

# Disable autostart on boot (leave it enabled normally)
sudo systemctl disable photoportfolio

# Re-enable autostart on boot
sudo systemctl enable photoportfolio
```

After editing `/etc/systemd/system/photoportfolio.service`:

```bash
sudo systemctl daemon-reload
sudo systemctl restart photoportfolio
```

## Logs

```bash
# Live tail
journalctl -u photoportfolio -f

# Last 100 lines
journalctl -u photoportfolio -n 100 --no-pager

# Since a time
journalctl -u photoportfolio --since "1 hour ago" --no-pager
```

## Deploy a code change

```bash
cd /opt/photoportfolio
git pull
npm ci --omit=dev
sudo systemctl restart photoportfolio
journalctl -u photoportfolio -n 20 --no-pager   # confirm it came back
```

## Health checks

```bash
# Local (bypasses Cloudflare)
curl -sI http://127.0.0.1:3000/                 # expect 200
curl -sI http://127.0.0.1:3000/admin            # expect 302 -> /admin/login

# Through the public domain
curl -sI https://gagejack.com/                  # expect 200, x-powered-by: Express
curl -s -o /dev/null -w "%{http_code}\n" https://gagejack.com/photos/originals/   # expect 404
```

If local works but the domain does not, the problem is the tunnel, not the app.

## Cloudflare tunnel

```bash
sudo systemctl status cloudflared
sudo systemctl restart cloudflared
journalctl -u cloudflared -n 30 --no-pager
```

The tunnel is shared with outbid arcade. Its routing lives in `/etc/cloudflared/config.yml`:

```yaml
ingress:
  - hostname: outbidarcade.lol
    service: http://localhost:8080
  - hostname: gagejack.com
    service: http://127.0.0.1:3000
  - service: http_status:404
```

After editing that file:

```bash
cloudflared tunnel ingress validate      # expect OK
sudo systemctl restart cloudflared
```

Do NOT run `cloudflared tunnel route dns ...` for `gagejack.com` — the CLI
mis-targets it into the `outbidarcade.lol` zone. Manage DNS records in the
Cloudflare dashboard instead. The `gagejack.com` zone needs one record:

```
CNAME  @  ccf90de1-e697-4b67-b0bd-5f0cc15ccfcd.cfargotunnel.com   (Proxied)
```

## Change the admin password

```bash
cd /opt/photoportfolio
npm run hash -- 'new-password'
```

Copy the `$argon2id$...` line into `.env` as `ADMIN_PASSWORD_HASH=`, then:

```bash
sudo systemctl restart photoportfolio
```

## Rotate the session secret

Invalidates the current login session (you just log in again).

```bash
openssl rand -hex 32                      # copy output
nano /opt/photoportfolio/.env             # replace SESSION_SECRET=
sudo systemctl restart photoportfolio
```

## Database backup

Photo bytes are also on the SSD. The database (captions, categories, dates)
is only on the server.

```bash
# One-off backup
sqlite3 /opt/photoportfolio/data/app.db ".backup '/opt/backups/app-$(date +%F).db'"

# Restore (service stopped first)
sudo systemctl stop photoportfolio
cp /opt/backups/app-YYYY-MM-DD.db /opt/photoportfolio/data/app.db
rm -f /opt/photoportfolio/data/app.db-wal /opt/photoportfolio/data/app.db-shm
sudo systemctl start photoportfolio
```

## Uploading photos

Through the admin panel only — `https://gagejack.com/admin`, log in as
`gagejack`. Drag-drop in batches. Uploads are idempotent: the filename is a
content hash, so re-uploading the same file overwrites its own derivatives
rather than creating a duplicate.

## Troubleshooting

| Symptom | Check |
|---|---|
| `https://gagejack.com` returns Cloudflare 404 | `cloudflared` not restarted after config edit, or CNAME missing in dashboard |
| Domain down, `curl 127.0.0.1:3000` works | tunnel problem — restart `cloudflared` |
| Both down | `sudo systemctl status photoportfolio`, then `journalctl -u photoportfolio -n 50` |
| `Missing required environment variable` on start | `.env` missing a key, or has Windows CRLF line endings — run `sed -i 's/\r$//' /opt/photoportfolio/.env` |
| Service keeps restarting | `journalctl -u photoportfolio -n 50` for the crash stack |
| Uploads fail | disk full (`df -h`), or `data/photos` not writable |
