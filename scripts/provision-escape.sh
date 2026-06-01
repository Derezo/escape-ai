#!/usr/bin/env bash
#
# provision-escape.sh — one-time, idempotent VPS setup for Escape AI.
#
# Run from your DEV BOX (like deploy-server.sh). It connects to the VPS over SSH
# as DEPLOY_USER and provisions everything the deploy needs, as root (sudo is
# added automatically when DEPLOY_USER is not root). It is NOT meant to be run on
# the VPS directly — the dev box is the single control point.
#
# What it creates on the VPS (idempotent — safe to re-run):
#   1. A login-DISABLED system user (APP_USER, nologin) that owns the files and
#      runs the node process under its own pm2 — it can never ssh in, has no
#      shell, and no password.
#   2. /var/www/<app> with logs/ + data/, owned by that user, locked to 0750.
#   3. A per-user pm2 systemd unit (pm2-<APP_USER>.service) that resurrects the
#      process on reboot. pm2 runs as APP_USER, not root.
#   4. An nginx vhost for APP_DOMAIN: serves the static client bundle from disk
#      and reverse-proxies ONLY /socket.io/ + /health to the loopback node port
#      (single origin → no CORS, production CORS stays locked to `origin:false`).
#   5. A Let's Encrypt certificate via certbot (HTTP-01), with HTTP→HTTPS redirect.
#   6. Conditional ufw rules (allow 80/443; keep the app port closed).
#
# All config is env-driven via scripts/deploy.env (copy from deploy.env.example).
# DEPLOY_USER, DEPLOY_HOST, APP_DOMAIN have NO defaults — the script errors if
# unset, so no host/user is hard-coded in this committed file.
#
# Usage:  cp scripts/deploy.env.example scripts/deploy.env && edit it, then:
#         ./scripts/provision-escape.sh
#         SKIP_CERTBOT=1 ./scripts/provision-escape.sh   # before DNS resolves
#
set -euo pipefail

log() { printf '\033[1;36m==>\033[0m %s\n' "$*"; }
die() { printf '\033[1;31mERROR:\033[0m %s\n' "$*" >&2; exit 1; }

# --- config (env-driven; load scripts/deploy.env if present) ----------------
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
if [[ -f "${SCRIPT_DIR}/deploy.env" ]]; then
  # deploy.env names your host/user/paths — keep it owner-only. Self-correct loose
  # perms (e.g. a fresh `cp` from the example inherits your umask, often 0644/0664)
  # so the secret-adjacent config can't be read by other local users.
  chmod 600 "${SCRIPT_DIR}/deploy.env" 2>/dev/null || true
  # shellcheck disable=SC1091
  set -a; . "${SCRIPT_DIR}/deploy.env"; set +a
fi

# Required, NO default: the SSH target + public hostname identify your
# infrastructure and must not be hard-coded. Set them in scripts/deploy.env.
require_env() {
  local name="$1"
  [[ -n "${!name:-}" ]] || die "${name} is not set. Copy scripts/deploy.env.example to scripts/deploy.env and fill it in (or export ${name})."
}
require_env DEPLOY_USER   # SSH login user (a sudoer; root needs no sudo)
require_env DEPLOY_HOST   # VPS hostname
require_env APP_DOMAIN    # public hostname (nginx server_name + TLS cert)

# App-internal identity: safe, non-host-revealing defaults are fine.
APP_USER="${APP_USER:-escape}"
REMOTE_PATH="${REMOTE_PATH:-/var/www/${APP_USER}}"
# Loopback port for the node server. Pick one free on your VPS (3389 is avoided —
# the well-known RDP port). It is bound to 127.0.0.1 only and NEVER opened in ufw;
# the public reaches it solely through nginx on 443.
APP_PORT="${APP_PORT:-3390}"
# Email Let's Encrypt uses for expiry notices. Defaults to the registrant of the
# apex domain; override CERTBOT_EMAIL in deploy.env to use a real inbox.
CERTBOT_EMAIL="${CERTBOT_EMAIL:-admin@${APP_DOMAIN#*.}}"
# Set SKIP_CERTBOT=1 to provision everything except the TLS cert (e.g. before
# DNS for APP_DOMAIN resolves to the VPS — rerun without it once DNS is live).
SKIP_CERTBOT="${SKIP_CERTBOT:-0}"

SSH_KEY="${SSH_KEY:-$HOME/.ssh/id_ed25519}"
SSH_TARGET="${DEPLOY_USER}@${DEPLOY_HOST}"
SSH_OPTS=(-i "${SSH_KEY}" -o StrictHostKeyChecking=accept-new -o ConnectTimeout=20)
[[ -f "${SSH_KEY}" ]] || die "SSH key not found: ${SSH_KEY} (set SSH_KEY in scripts/deploy.env)."

# Privilege prefix: root needs nothing; a non-root sudoer gets `sudo -n` (fails
# fast instead of hanging on a password prompt over a non-TTY SSH session).
if [[ "${DEPLOY_USER}" == "root" ]]; then SUDO=""; else SUDO="sudo -n"; fi

log "Provisioning ${APP_DOMAIN} on ${SSH_TARGET} (app user '${APP_USER}', loopback :${APP_PORT}, root ${REMOTE_PATH})"

# --- ship the provisioning body to the VPS and run it as root ---------------
# The remote body reads its config from the leading `env` assignment (the dev-box
# values), so the nginx heredoc below interpolates remotely-literal $VARS with no
# fragile local quoting. The whole thing runs in one ssh/bash invocation.
ssh "${SSH_OPTS[@]}" "${SSH_TARGET}" \
  ${SUDO} env \
    APP_USER="${APP_USER}" \
    APP_DOMAIN="${APP_DOMAIN}" \
    REMOTE_PATH="${REMOTE_PATH}" \
    APP_PORT="${APP_PORT}" \
    CERTBOT_EMAIL="${CERTBOT_EMAIL}" \
    SKIP_CERTBOT="${SKIP_CERTBOT}" \
    bash -s <<'REMOTE'
set -euo pipefail

log() { printf '\033[1;36m  [vps]\033[0m %s\n' "$*"; }
die() { printf '\033[1;31m  [vps] ERROR:\033[0m %s\n' "$*" >&2; exit 1; }

NGINX_AVAILABLE="/etc/nginx/sites-available/${APP_USER}.conf"
NGINX_ENABLED="/etc/nginx/sites-enabled/${APP_USER}.conf"
WEBROOT="/var/www/certbot"   # shared ACME webroot for HTTP-01 challenges

[[ "$(id -u)" -eq 0 ]] || die "remote provisioning is not running as root (DEPLOY_USER needs sudo)."
command -v nginx >/dev/null || die "nginx not installed on the VPS."
command -v pm2   >/dev/null || die "pm2 not installed on the VPS (npm i -g pm2)."
command -v node  >/dev/null || die "node not installed on the VPS."

# --- 0. firewall (ufw): open the web edge, keep the app port closed ----------
# The public edge is nginx on 80/443; the node app port is loopback-only and must
# NEVER be exposed. (a) ensure HTTP/HTTPS is allowed (idempotent); (b) defense in
# depth, remove any stray rule that publicly opens APP_PORT. Conditional: if ufw
# is absent or inactive, note it and move on rather than fail.
if command -v ufw >/dev/null 2>&1 && ufw status 2>/dev/null | grep -q "Status: active"; then
  UFW_STATUS="$(ufw status 2>/dev/null)"
  if echo "${UFW_STATUS}" | grep -qE "Nginx Full|(^|[^0-9])80,443/tcp"; then
    log "ufw: web edge (80/443) already allowed — leaving as is."
  elif ufw app list 2>/dev/null | grep -q "Nginx Full"; then
    log "ufw: allowing 'Nginx Full' (80/443)"; ufw allow "Nginx Full" >/dev/null
  else
    log "ufw: allowing 80,443/tcp"; ufw allow 80,443/tcp >/dev/null
  fi
  # Whole-token match so a short APP_PORT can't false-match a longer port (390 in 3390).
  if echo "${UFW_STATUS}" | grep -qE "(^|[^0-9])${APP_PORT}(/tcp)?([^0-9]|$)"; then
    log "ufw: found a public rule for app port ${APP_PORT} — removing (should be loopback-only)"
    ufw delete allow "${APP_PORT}/tcp" >/dev/null 2>&1 || true
    ufw delete allow "${APP_PORT}"     >/dev/null 2>&1 || true
  else
    log "ufw: app port ${APP_PORT} is not publicly exposed (correct — loopback only)."
  fi
else
  log "ufw not active/installed — skipping firewall step (ensure 80/443 are reachable some other way)."
fi

# --- 1. dedicated nologin app user ------------------------------------------
if id "${APP_USER}" &>/dev/null; then
  log "User '${APP_USER}' already exists — leaving as is."
else
  log "Creating system user '${APP_USER}' (nologin, no password)"
  # --system: no aging/expiry; --shell nologin: cannot log in; home is the deploy
  # root so pm2 ($HOME/.pm2) and the files live together.
  useradd --system --create-home --home-dir "${REMOTE_PATH}" \
          --shell /usr/sbin/nologin "${APP_USER}"
  passwd --lock "${APP_USER}" >/dev/null   # lock the password — no credential auth
fi

# --- 2. deploy root + runtime dirs, owned by the app user, tight perms -------
log "Ensuring ${REMOTE_PATH} (+ logs/, data/, client/, server/, shared/)"
mkdir -p "${REMOTE_PATH}"/{logs,data,client,server,shared}
chown -R "${APP_USER}:${APP_USER}" "${REMOTE_PATH}"
chmod 750 "${REMOTE_PATH}"   # owner full, group rx (nginx via group), world none
# Let the web server's group descend to serve client/ statics.
if getent group www-data >/dev/null; then
  usermod -aG "${APP_USER}" www-data || true
fi

# --- 3. per-user pm2 systemd unit (resurrect on boot, runs as APP_USER) ------
PM2_UNIT="pm2-${APP_USER}.service"
if systemctl list-unit-files | grep -q "^${PM2_UNIT}"; then
  log "${PM2_UNIT} already registered — leaving as is."
else
  log "Registering ${PM2_UNIT} (pm2 startup for ${APP_USER})"
  # Run as root with -u/--hp: pm2 generates+installs a systemd unit that runs pm2
  # AS ${APP_USER} with PM2_HOME=${REMOTE_PATH}/.pm2. The first deploy's `pm2 save`
  # (as the app user) then writes the dump this unit resurrects on boot.
  pm2 startup systemd -u "${APP_USER}" --hp "${REMOTE_PATH}" >/dev/null
  systemctl enable "${PM2_UNIT}" >/dev/null 2>&1 || true
fi

# --- 4. nginx vhost + TLS (two-phase bootstrap) -----------------------------
# Chicken-and-egg: the full vhost references a TLS cert, but certbot's HTTP-01
# challenge needs nginx already serving /.well-known/acme-challenge/ on port 80.
# An ssl_certificate line pointing at a missing file makes `nginx -t` fail HARD,
# so we can't just write the full vhost and reload. The fix is two phases:
#   Phase A — write an HTTP-ONLY vhost (port 80 + ACME webroot), reload, get cert.
#   Phase B — now the cert exists, write the FULL vhost (adds 443/SSL), reload.
CERT="/etc/letsencrypt/live/${APP_DOMAIN}/fullchain.pem"
mkdir -p "${WEBROOT}"

# Phase A vhost: port 80 only. Serves the ACME challenge from the webroot; every
# other path 404s until the full vhost lands (no redirect-to-https yet — there's
# no cert to redirect to). Safe to `nginx -t` because it references no cert.
write_http_only_vhost() {
  cat > "${NGINX_AVAILABLE}" <<NGINX
# Escape AI — generated by scripts/provision-escape.sh (HTTP-only ACME bootstrap).
server {
    listen 80;
    listen [::]:80;
    server_name ${APP_DOMAIN};
    location /.well-known/acme-challenge/ { root ${WEBROOT}; }
    location / { return 404; }
}
NGINX
}

# Phase B vhost: the full config (static client + socket/health proxy on 443,
# HTTP→HTTPS redirect). Only valid once the cert exists.
write_full_vhost() {
  cat > "${NGINX_AVAILABLE}" <<NGINX
# Escape AI — generated by scripts/provision-escape.sh.
# Static client bundle served from disk; only /socket.io/ + /health proxy to node.
limit_req_zone \$binary_remote_addr zone=${APP_USER}_limit:10m rate=200r/s;

upstream ${APP_USER}_upstream {
    server 127.0.0.1:${APP_PORT};
    keepalive 16;
}

server {
    listen 443 ssl http2;
    listen [::]:443 ssl http2;
    server_name ${APP_DOMAIN};

    ssl_certificate     /etc/letsencrypt/live/${APP_DOMAIN}/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/${APP_DOMAIN}/privkey.pem;
    include /etc/letsencrypt/options-ssl-nginx.conf;

    access_log /var/log/nginx/${APP_USER}.access.log;
    error_log  /var/log/nginx/${APP_USER}.error.log;

    root  ${REMOTE_PATH}/client;
    index index.html;

    client_max_body_size 4m;

    # Authoritative server health — proxied, no rate limit, no access log.
    location /health {
        proxy_pass         http://${APP_USER}_upstream;
        proxy_http_version 1.1;
        proxy_set_header   Host              \$host;
        proxy_set_header   X-Real-IP         \$remote_addr;
        proxy_set_header   X-Forwarded-For   \$proxy_add_x_forwarded_for;
        proxy_set_header   X-Forwarded-Proto \$scheme;
        access_log off;
    }

    # WebSocket / Socket.IO — long-lived upgrade to the node engine.
    location /socket.io/ {
        proxy_pass         http://${APP_USER}_upstream;
        proxy_http_version 1.1;
        proxy_set_header   Upgrade   \$http_upgrade;
        proxy_set_header   Connection "upgrade";
        proxy_set_header   Host              \$host;
        proxy_set_header   X-Real-IP         \$remote_addr;
        proxy_set_header   X-Forwarded-For   \$proxy_add_x_forwarded_for;
        proxy_set_header   X-Forwarded-Proto \$scheme;
        proxy_read_timeout 3600s;
    }

    # Everything else is the static client bundle (SPA: fall back to index.html).
    location / {
        limit_req        zone=${APP_USER}_limit burst=200 nodelay;
        limit_req_status 429;
        try_files \$uri \$uri/ /index.html;
    }

    # The Android APK (served by the /android download page). Force a download
    # with the correct package MIME, serve =404 if absent (never the SPA HTML),
    # and don't rate-limit a single large binary. The file is staged into the
    # bundle by scripts/deploy-server.sh.
    location = /android/escape-ai.apk {
        types { }
        default_type application/vnd.android.package-archive;
        add_header Content-Disposition 'attachment; filename="escape-ai.apk"';
        try_files \$uri =404;
        access_log off;
    }

    # Cache the hashed Vite bundles + generated assets aggressively.
    location ~* \.(?:js|css|png|jpg|jpeg|gif|svg|woff2?|wav|mp3|ogg|json)\$ {
        try_files \$uri =404;
        expires 7d;
        add_header Cache-Control "public";
        access_log off;
    }

    # Defense in depth: block dotfiles + common scanner patterns.
    location ~ /\. {
        deny all; access_log off; log_not_found off;
    }
    location ~* (wp-admin|wp-login|xmlrpc\.php|\.env|\.git) {
        deny all; access_log off; log_not_found off;
    }
}

server {
    listen 80;
    listen [::]:80;
    server_name ${APP_DOMAIN};

    location /.well-known/acme-challenge/ { root ${WEBROOT}; }
    location / { return 301 https://\$host\$request_uri; }
}
NGINX
}

reload_nginx() { nginx -t && systemctl reload nginx; }

if [[ -f "${CERT}" ]]; then
  # Re-run / cert already present: go straight to the full vhost.
  log "Certificate present — writing full nginx vhost ${NGINX_AVAILABLE}"
  write_full_vhost
  ln -sf "${NGINX_AVAILABLE}" "${NGINX_ENABLED}"
  log "Validating + reloading nginx"
  reload_nginx || die "nginx -t failed with the full vhost — inspect ${NGINX_AVAILABLE}."
elif [[ "${SKIP_CERTBOT}" == "1" ]]; then
  # Bootstrap the HTTP-only vhost so the box is ready; defer TLS to a later run.
  log "SKIP_CERTBOT=1 — writing HTTP-only vhost, deferring TLS issuance."
  write_http_only_vhost
  ln -sf "${NGINX_AVAILABLE}" "${NGINX_ENABLED}"
  reload_nginx || die "nginx -t failed with the HTTP-only vhost — inspect ${NGINX_AVAILABLE}."
  log "Done bootstrapping. Once DNS resolves, rerun WITHOUT SKIP_CERTBOT to issue the cert."
else
  # Phase A: HTTP-only vhost live so certbot's HTTP-01 challenge can be served.
  command -v certbot >/dev/null || die "certbot not installed and no cert present."
  log "Phase A: writing HTTP-only vhost + reloading nginx (for the ACME challenge)"
  write_http_only_vhost
  ln -sf "${NGINX_AVAILABLE}" "${NGINX_ENABLED}"
  reload_nginx || die "nginx -t failed with the HTTP-only vhost — inspect ${NGINX_AVAILABLE}."

  log "Requesting Let's Encrypt cert for ${APP_DOMAIN} (webroot ${WEBROOT})"
  certbot certonly --webroot -w "${WEBROOT}" -d "${APP_DOMAIN}" \
    --non-interactive --agree-tos -m "${CERTBOT_EMAIL}" \
    || die "certbot failed — check that ${APP_DOMAIN} resolves to this VPS, then rerun."

  # Phase B: cert now exists → write the full vhost and reload.
  log "Phase B: writing full nginx vhost + reloading nginx"
  write_full_vhost
  reload_nginx || die "nginx -t failed with the full vhost — inspect ${NGINX_AVAILABLE}."
fi

log "VPS provisioning complete."
REMOTE

log "Done. Now deploy the app with:  ./scripts/deploy-server.sh"
log "  (the systemd unit resurrects pm2 on reboot; the first deploy starts the process.)"
