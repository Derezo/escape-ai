import type { CapacitorConfig } from '@capacitor/cli';

/**
 * Capacitor config for the TINS 2026 Android wrapper.
 *
 * Strategy (per ARCHITECTURE.md): "browser-first, Android nice-to-have."
 * Capacitor packages the *already-built* Vite bundle (client/dist) into an
 * Android WebView app. The web client is the product; this just ships it.
 *
 * KEY FACTS that make this work:
 *
 * 1. `webDir: 'dist'` — the Vite build output. `vite.config.ts` sets
 *    `base: './'` so assets load via relative URLs inside the WebView (an
 *    absolute `/assets/...` would resolve to the device root and 404).
 *
 * 2. `server.androidScheme: 'https'` — the WebView serves the bundled assets
 *    from `https://localhost` (a secure origin). This is required so the page
 *    counts as a "secure context": Socket.IO/WebSocket calls to the HTTPS VPS
 *    are not blocked as mixed content, and browser APIs gated on secure
 *    contexts (crypto, etc.) keep working. Do NOT change this to 'http' for
 *    production.
 *
 * 3. The server URL the client talks to is NOT configured here — it is baked
 *    into the JS bundle at build time from VITE_SERVER_URL (see src/config.ts).
 *    For an Android build you MUST run:
 *        VITE_SERVER_URL=https://<your-vps> npm run build
 *    before `cap sync`, or the app will try to reach http://localhost:3000,
 *    which does not exist on a phone. See docs/ANDROID.md.
 *
 * appId: reverse-domain identifier. "org.tins2026.app" is a placeholder — RENAME
 * it to a domain you control before any public/Play-Store release (it is the
 * permanent package name and cannot change after publishing). Renaming later in
 * a jam means deleting and re-adding the android/ platform, so pick it now.
 */
const config: CapacitorConfig = {
  appId: 'org.tins2026.app',
  appName: 'TINS 2026',
  webDir: 'dist',
  server: {
    // Serve bundled assets from https://localhost — a secure origin, so calls
    // to the HTTPS VPS are not flagged as mixed content. Production-safe.
    androidScheme: 'https',

    // --- DEV-ONLY ESCAPE HATCHES (commented out; keep prod HTTPS-only) ---
    //
    // If you must test against a plain-HTTP / non-TLS server (e.g. the dev
    // server on your LAN at http://192.168.x.x:3000), the WebView will block
    // those requests as cleartext + mixed content. To allow it TEMPORARILY:
    //
    //   allowNavigation: ['192.168.*'],
    //   cleartext: true,           // permits http:// traffic from the WebView
    //
    // Never ship `cleartext: true` — it disables transport security for the app.
    // Prefer giving the VPS a real cert and using HTTPS everywhere instead.
    //
    // Alternatively, point the WebView at a live URL (live-reload / quick demo)
    // instead of bundled assets:
    //   url: 'https://tins.mittonvillage.com',
    // With `url` set, Capacitor loads that remote page directly and webDir is
    // ignored. That is effectively the TWA approach (see docs/ANDROID.md).
  },
};

export default config;
