# TINS 2026 — Android (Capacitor) Build Path

> Per `ARCHITECTURE.md`: **browser-first, Android nice-to-have.** Capacitor wraps
> the *already-built* Vite bundle (`client/dist`) into an Android WebView app. The
> web client is the product; this just ships it to a phone. Nothing here is on the
> critical path of the jam — do it once the game runs in a browser.
>
> Capacitor lives in **`client/`** (config: `client/capacitor.config.ts`), so
> `webDir` is just `"dist"` relative to it and `npm run build` + `cap sync` are one
> directory apart.

---

## Prerequisites (one-time, on your dev machine)

You need these only to produce the APK; the scaffold and `cap sync` already work
without them (verified — see the bottom of this doc).

1. **Android Studio** (latest stable). Installs the Android SDK + platform tools.
2. **JDK 17** — the version the Android Gradle Plugin expects. Android Studio
   bundles a JDK; if you build from the CLI, point `JAVA_HOME` at a JDK 17.
3. **Accept SDK licenses.** Open Android Studio once and let it download the
   default SDK + a build platform, or run:
   ```bash
   sdkmanager --licenses    # accept all
   ```
4. A device or emulator: a physical phone with USB debugging on, or an AVD
   created from Android Studio's Device Manager.

> The Capacitor npm packages (`@capacitor/core`, `@capacitor/cli`,
> `@capacitor/android`) are already installed and need **no** Android SDK to
> install. The SDK is only needed for the final Gradle build, which you run in
> Android Studio (or via `./gradlew`).

---

## The exact command sequence

From the repo root. Replace `<your-vps>` with the real HTTPS server URL.

```bash
cd client

# 1. Build the web bundle with the SERVER URL baked in (see the gotcha below).
VITE_SERVER_URL=https://<your-vps> npm run build

# 2. Add the native Android project (idempotent: skip if client/android/ exists).
npx cap add android

# 3. Copy the fresh dist/ into the native project + update native deps.
npx cap sync

# 4. Open the project in Android Studio.
npx cap open android
```

Then in Android Studio: **Build > Build Bundle(s) / APK(s) > Build APK(s)**.
A toast links to the generated APK.

Convenience npm scripts (in `client/package.json`) wrap steps 2–4:

```bash
npm run android:add     # npx cap add android
npm run cap:sync        # npm run build && npx cap sync   (use after any code change)
npm run android:open    # npx cap open android
```

> Re-run `npm run cap:sync` (or steps 1+3) after **every** web change — the APK
> only ever ships whatever is in `dist/` at sync time.

### Headless / CLI build (no Android Studio UI)

```bash
cd client/android
./gradlew assembleDebug
# APK lands at:
#   client/android/app/build/outputs/apk/debug/app-debug.apk
```

For a signed release APK/AAB you'll need a keystore and `assembleRelease` /
`bundleRelease` — out of scope for the jam.

---

## The server-URL gotcha (read this — it is the #1 way to ship a broken APK)

The client's server URL is **baked into the JS bundle at build time** from
`VITE_SERVER_URL` (see `client/src/config.ts`); Vite statically replaces
`import.meta.env.VITE_SERVER_URL` with a string literal. There is **no runtime
config** and **no `localhost` server inside a phone**.

Consequences:

- If you run `npm run build` without `VITE_SERVER_URL`, the app defaults to
  `http://localhost:3000` and **silently fails to connect** on a real device.
- You **must** set `VITE_SERVER_URL=https://<your-vps>` *before* the build, then
  `cap sync`. Rebuilding without re-syncing also ships the stale bundle.
- The WebView serves bundled assets from `https://localhost` (set via
  `server.androidScheme: 'https'` in `capacitor.config.ts`). That makes the page
  a **secure origin**, so it can talk to the HTTPS VPS without mixed-content
  blocking. **The VPS endpoint must therefore be HTTPS** (valid TLS cert), not
  plain `http://`.

**Cleartext (dev-only).** If you must test against a non-TLS server (e.g. the dev
box at `http://192.168.x.x:3000`), the WebView blocks it as cleartext +
mixed content. Temporarily uncomment in `capacitor.config.ts`:

```ts
server: {
  androidScheme: 'https',
  allowNavigation: ['192.168.*'],
  cleartext: true,            // permits http:// — NEVER ship this
}
```

then `cap sync`. Production stays **HTTPS-only**; give the VPS a real cert
instead of shipping cleartext.

---

## How to test the APK

1. Build the debug APK (Android Studio **Build APK** or `./gradlew assembleDebug`).
2. Install it:
   - Emulator/USB device: `adb install -r app/build/outputs/apk/debug/app-debug.apk`
     (or just **Run ▶** in Android Studio with a device selected).
3. Make sure the **VPS Socket.IO server is up** and reachable over HTTPS from the
   phone's network (open `https://<your-vps>` in the phone's browser first).
4. Launch the app. It should reach the lobby and a second client (another phone,
   or a browser tab pointed at the same VPS) should appear as a synced entity.
5. If it loads but never connects: you almost certainly built without
   `VITE_SERVER_URL` (see the gotcha) or the endpoint is HTTP, not HTTPS.
   Inspect via `chrome://inspect` (Chrome DevTools attaches to the WebView) and
   check the Console/Network tabs for the Socket.IO connection.

---

## Lighter alternative: TWA (Trusted Web Activity)

If the game is already deployed as an installable **PWA** at a public HTTPS URL,
a **TWA** (e.g. via [Bubblewrap](https://github.com/GoogleChromeLabs/bubblewrap))
ships that live URL inside a Chrome-backed activity — no bundled assets, no
Capacitor WebView, and updates the instant you redeploy the site.

**Prefer TWA when** the deployed web app is the single source of truth and you
want the APK to be a thin, always-up-to-date shell (and you're willing to add a
PWA manifest + service worker + Digital Asset Links). **Prefer Capacitor** (this
setup) when you want the bundled offline-capable build, native plugin access, or
you don't have/​want a full PWA — which is the default for this jam.

> You can approximate a TWA-style "load the live site" with Capacitor too: set
> `server.url: 'https://<your-vps>'` in `capacitor.config.ts` and the WebView
> loads the remote page directly (ignoring `webDir`).

---

## What's verified vs. deferred

**Verified in this environment (no Android SDK needed):**
- `npm install` in `client/` succeeds with the Capacitor deps.
- `npx cap --version` → `8.3.4`.
- `npm run build` produces `dist/`.
- `npx cap add android` scaffolded `client/android/` (purely local file copy,
  **no SDK download**).
- `npx cap sync` copies `dist/` → `android/app/src/main/assets/public` and bakes
  `capacitor.config.json` (`androidScheme: https`, `appId org.escapeai.app`).

**Deferred to Android Studio (intentionally — needs the Android SDK + JDK 17,
which we do not download here):**
- The Gradle build that turns `client/android/` into an actual `.apk`
  (`Build APK` / `./gradlew assembleDebug`).
- Installing and running on a device/emulator.

---

## Renaming the app id

`appId` is `org.escapeai.app` (placeholder). It is the permanent Android package
name — **change it to a domain you control before any public release**, and do so
*early*: renaming after `android/` exists means
`rm -rf android && npx cap add android` to regenerate with the new id.
