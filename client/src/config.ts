/**
 * Client configuration.
 *
 * `SERVER_URL` is read from a Vite env var at *build* time so the same source
 * builds for three targets:
 *   - local dev / browser  -> defaults to http://localhost:3000
 *   - production browser    -> set VITE_SERVER_URL to the VPS URL before `build`
 *   - Capacitor Android     -> MUST bake VITE_SERVER_URL=https://<vps> at build
 *     time, because the WebView has no "localhost" server to talk to.
 *
 * Vite statically replaces `import.meta.env.VITE_SERVER_URL` with the literal
 * value during the build, so nothing is read from the environment at runtime.
 */
export const SERVER_URL: string =
  import.meta.env.VITE_SERVER_URL ?? 'http://localhost:3000';

/** Default lobby room everyone joins so two tabs meet without any UI. */
export const DEFAULT_ROOM = 'default';

/**
 * Movement speed (units/sec) used for CLIENT-SIDE PREDICTION. MUST match the
 * server's PLAYER_SPEED (server/config.js defaults to 200) or prediction will
 * disagree with authority and the rectangle will rubber-band.
 */
export const PLAYER_SPEED = 200;
