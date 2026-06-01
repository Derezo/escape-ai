// server/ecosystem.config.js — pm2 process definition for the Escape AI server.
//
// Used in PRODUCTION on the VPS only: provision-escape.sh registers a per-user
// systemd unit (pm2-<APP_USER>.service) that `pm2 resurrect`s on boot, and
// deploy-server.sh runs `pm2 startOrReload ecosystem.config.js` as the app user
// from the deploy root. Local dev uses scripts/run-dev.sh, not pm2.
//
// PORT / DB_PATH are read from the process environment so the deploy can inject
// the loopback port (APP_PORT) without editing this file. The server's own
// config.js falls back to its defaults if they are unset.
module.exports = {
  apps: [
    {
      name: process.env.PM2_NAME || 'escape',
      // Resolved relative to this file's directory (the deployed server/ dir).
      script: './index.js',
      cwd: __dirname,
      instances: 1,
      exec_mode: 'fork',

      env: {
        NODE_ENV: 'production',
        // nginx reverse-proxies to this loopback port; deploy sets it from APP_PORT.
        // Loopback-only + never opened in ufw, so it is unreachable except via nginx.
        PORT: process.env.PORT || 3390,
        // Bind loopback only — the public edge is nginx + TLS, never the node port.
        HOST: process.env.HOST || '127.0.0.1'
      },

      // Restart if the process balloons past this (the world grid + snapshots
      // are small; this is a safety net, not an expected ceiling).
      max_memory_restart: '512M',

      // Logs live under the deploy root's logs/ (provision-escape.sh creates it).
      // cwd is __dirname = <deploy-root>/server, so step up one to reach logs/.
      error_file: '../logs/pm2-error.log',
      out_file: '../logs/pm2-out.log',
      log_date_format: 'YYYY-MM-DD HH:mm:ss Z',
      merge_logs: true,

      autorestart: true,
      max_restarts: 10,
      min_uptime: '10s',
      listen_timeout: 5000,
      kill_timeout: 5000,
      watch: false,

      // The server traps SIGTERM (index.js) for a clean engine.stop()/db.close().
      shutdown_with_message: true,
      exp_backoff_restart_delay: 100
    }
  ]
};
