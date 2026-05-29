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

// Movement speeds are NOT configured here: walk/sprint speeds live once in
// `@shared/step` (WALK_SPEED / SPRINT_SPEED / moveSpeed) so client prediction and
// server authority can never disagree. main.ts predicts via shared moveSpeed().
