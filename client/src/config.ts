/**
 * Client configuration.
 *
 * `SERVER_URL` is read from a Vite env var at *build* time so the same source
 * builds for three targets:
 *   - local dev / browser  -> defaults to http://localhost:3000 (zero-config, silent)
 *   - production browser    -> set VITE_SERVER_URL to the VPS URL before `build`
 *   - Capacitor Android     -> MUST bake VITE_SERVER_URL=https://<vps> at build
 *     time, because the WebView has no "localhost" server to talk to.
 *
 * Vite statically replaces `import.meta.env.VITE_SERVER_URL` with the literal
 * value during the build, so nothing is read from the environment at runtime.
 *
 * PROD guard: in a production build (`vite build`), if VITE_SERVER_URL was NOT
 * set at build time, a loud console.error fires at module load so the misconfig
 * is immediately visible in devtools.  The app still falls back to localhost so
 * it at least boots locally, but any deployed/WebView context will fail to
 * connect.  Fix: set VITE_SERVER_URL=https://<vps> before running `npm run build`.
 */
function resolveServerUrl(): string {
  const baked: string | undefined = import.meta.env.VITE_SERVER_URL;
  if (!baked) {
    if (import.meta.env.PROD) {
      // eslint-disable-next-line no-console
      console.error(
        '[config] VITE_SERVER_URL was not set at build time. ' +
        'This production/Android build will try http://localhost:3000, ' +
        'which will fail in any deployed or WebView context. ' +
        'Fix: set VITE_SERVER_URL=https://<your-vps> before running `npm run build`, ' +
        'then re-run `npm run cap:sync` for Android.',
      );
    }
    return 'http://localhost:3000';
  }
  return baked;
}

export const SERVER_URL: string = resolveServerUrl();

/** Default lobby room everyone joins so two tabs meet without any UI. */
export const DEFAULT_ROOM = 'default';

// Movement speeds are NOT configured here: walk/sprint speeds live once in
// `@shared/step` (WALK_SPEED / SPRINT_SPEED / moveSpeed) so client prediction and
// server authority can never disagree. main.ts predicts via shared moveSpeed().
