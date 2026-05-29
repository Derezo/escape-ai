import { defineConfig } from 'vite';
import { fileURLToPath, URL } from 'node:url';

// Vite config for the TINS 2026 client.
//
// CRITICAL — `base: './'`: emit relative asset URLs (./assets/...). Capacitor
// loads the build from `file://` (or a custom scheme) inside an Android WebView,
// where absolute `/assets/...` paths resolve to the device root and 404. Relative
// paths are the only thing that works in both a browser and a WebView.
export default defineConfig({
  base: './',
  resolve: {
    alias: {
      // The shared module is ESM/NodeNext and uses `.js` import specifiers, but
      // Vite resolves those against the `.ts` source, so pointing the alias at
      // `../shared/src` lets us import the shared TypeScript directly (no build
      // of `shared` required for the client to compile/run).
      '@shared': fileURLToPath(new URL('../shared/src', import.meta.url)),
    },
  },
  build: {
    outDir: 'dist',
    // Keep the bundle browsers-and-WebView friendly.
    target: 'es2020',
  },
});
