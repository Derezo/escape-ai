#!/usr/bin/env bash
#
# provision-escape.sh — one-time, idempotent VPS setup for Escape AI.
#
# Run ONCE on the VPS with root privileges (via sudo). It creates the dedicated,
# secure app user and everything the deploy needs:
#
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
#
# Everything is parameterised by env (see scripts/deploy.env.example) so no host,
# user, domain, or port is hard-coded. Re-running is safe: each step checks for
# existing state first.
#
# Usage (on the VPS):
#   sudo APP_DOMAIN=escape.example.com APP_USER=escape APP_PORT=3390 \
#        bash provision-escape.sh
#   # or copy scripts/deploy.env alongside this script and just: sudo bash provision-escape.sh
#
set -euo pipefail

log() { printf '\033[1;36m==>\033[0m %s\n' "$*"; }
die() { printf '\033[1;31mERROR:\033[0m %s\n' "$*" >&2; exit 1; }

# --- config (env-driven; load scripts/deploy.env if present) ----------------
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
if [[ -f "${SCRIPT_DIR}/deploy.env" ]]; then
  # shellcheck disable=SC1091
  set -a; . "${SCRIPT_DIR}/deploy.env"; set +a
fi

# Required, NO default: the public hostname reveals your infrastructure and must
# not be hard-coded in the committed script. Set it in scripts/deploy.env.
[[ -n "${APP_DOMAIN:-}" ]] || die "APP_DOMAIN is not set. Copy scripts/deploy.env.example to scripts/deploy.env and fill it in (or export APP_DOMAIN)."

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
# DNS for APP_DOMAIN resolves to this VPS — rerun without it once DNS is live).
SKIP_CERTBOT="${SKIP_CERTBOT:-0}"

NGINX_AVAILABLE="/etc/nginx/sites-available/${APP_USER}.conf"
NGINX_ENABLED="/etc/nginx/sites-enabled/${APP_USER}.conf"
WEBROOT="/var/www/certbot"   # shared ACME webroot for HTTP-01 challenges

[[ "$(id -u)" -eq 0 ]] || die "must run as root (use sudo)."
command -v nginx   >/dev/null || die "nginx not installed."
command -v pm2     >/dev/null || die "pm2 not installed (npm i -g pm2)."
command -v node    >/dev/null || die "node not installed."

log "Provisioning '${APP_USER}' → ${APP_DOMAIN} (loopback :${APP_PORT}, root ${REMOTE_PATH})"

# --- 0. firewall (ufw): open the web edge, keep the app port closed ----------
# The public edge is nginx on 80/443; the node app port is loopback-only and must
# NEVER be exposed. So this step (a) ensures HTTP/HTTPS is allowed (idempotent —
# skips if a matching rule already exists), and (b) as defense in depth, removes
# any stray rule that publicly opens APP_PORT. All conditional: if ufw is absent
# or inactive, we note it and move on rather than fail.
if command -v ufw >/dev/null 2>&1 && ufw status 2>/dev/null | grep -q "Status: active"; then
  UFW_STATUS="$(ufw status 2>/dev/null)"

  # (a) Allow the web edge. Reuse the 'Nginx Full' app profile if registered
  # (80+443 in one rule); otherwise allow the two ports directly. Only add when
  # not already present so reruns don't pile up duplicate rules.
  if echo "${UFW_STATUS}" | grep -qE "Nginx Full|(^|[^0-9])80,443/tcp"; then
    log "ufw: web edge (80/443) already allowed — leaving as is."
  elif ufw app list 2>/dev/null | grep -q "Nginx Full"; then
    log "ufw: allowing 'Nginx Full' (80/443)"
    ufw allow "Nginx Full" >/dev/null
  else
    log "ufw: allowing 80,443/tcp"
    ufw allow 80,443/tcp >/dev/null
  fi

  # (b) Defense in depth: if a rule publicly opens APP_PORT, delete it. The app
  # port belongs on loopback behind nginx — it should not appear here at all.
  # The port must be a whole token (no adjacent digit on either side) so a short
  # APP_PORT can't false-match a longer port (e.g. 390 inside 3390).
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
  # --system: no aging/expiry; --shell nologin: cannot log in; home is the
  # deploy root so pm2 ($HOME/.pm2) and the files live together.
  useradd --system --create-home --home-dir "${REMOTE_PATH}" \
          --shell /usr/sbin/nologin "${APP_USER}"
  # Belt-and-suspenders: lock the password so no credential auth is possible.
  passwd --lock "${APP_USER}" >/dev/null
fi

# --- 2. deploy root + runtime dirs, owned by the app user, tight perms -------
log "Ensuring ${REMOTE_PATH} (+ logs/, data/, client/, server/, shared/)"
mkdir -p "${REMOTE_PATH}"/{logs,data,client,server,shared}
chown -R "${APP_USER}:${APP_USER}" "${REMOTE_PATH}"
# 0750: owner full, group read/exec (nginx reads the static client as its own
# user — add nginx to the group so it can traverse), world none.
chmod 750 "${REMOTE_PATH}"
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
  # AS ${APP_USER} with PM2_HOME=${REMOTE_PATH}/.pm2 (the unit hardcodes both from
  # these flags). The first deploy's `pm2 save` (as the app user) then writes the
  # dump this unit resurrects on boot.
  pm2 startup systemd -u "${APP_USER}" --hp "${REMOTE_PATH}" >/dev/null
  systemctl enable "${PM2_UNIT}" >/dev/null 2>&1 || true
fi

# --- 4. nginx vhost: static client + socket/health proxy --------------------
log "Writing nginx vhost ${NGINX_AVAILABLE}"
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

ln -sf "${NGINX_AVAILABLE}" "${NGINX_ENABLED}"

# --- 5. Let's Encrypt certificate -------------------------------------------
if [[ "${SKIP_CERTBOT}" == "1" ]]; then
  log "SKIP_CERTBOT=1 — skipping TLS issuance (rerun without it once DNS resolves)."
elif [[ -f "/etc/letsencrypt/live/${APP_DOMAIN}/fullchain.pem" ]]; then
  log "Certificate for ${APP_DOMAIN} already present — skipping issuance."
else
  command -v certbot >/dev/null || die "certbot not installed and no cert present."
  mkdir -p "${WEBROOT}"
  log "Requesting Let's Encrypt cert for ${APP_DOMAIN} (webroot ${WEBROOT})"
  certbot certonly --webroot -w "${WEBROOT}" -d "${APP_DOMAIN}" \
    --non-interactive --agree-tos -m "${CERTBOT_EMAIL}" \
    || die "certbot failed — check that ${APP_DOMAIN} resolves to this VPS, then rerun."
fi

# --- validate + reload nginx ------------------------------------------------
# If the cert is still missing (SKIP_CERTBOT before DNS), `nginx -t` would fail
# on the ssl_certificate lines — guard the reload on the cert existing.
if [[ -f "/etc/letsencrypt/live/${APP_DOMAIN}/fullchain.pem" ]]; then
  log "Validating + reloading nginx"
  nginx -t && systemctl reload nginx
else
  log "Cert not present yet — NOT reloading nginx. Provision TLS, then: nginx -t && systemctl reload nginx"
fi

log "Done. Deploy the app with:  ./scripts/deploy-server.sh"
log "  (the systemd unit resurrects pm2 on reboot; the first deploy starts the process.)"
