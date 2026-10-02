/* Virtual-module types for vite-plugin-pwa so svelte-check can resolve the
 * `virtual:pwa-register` import used by $lib/state/pwa.svelte.ts. The plugin
 * generates the service worker at build time (see vite.config.ts). */

/// <reference types="vite-plugin-pwa/client" />
