/* Build-time constants injected by Vite `define` in vite.config.ts.
 * Surfaced in the About modal so users can pin a bug report to a build. */

declare const __APP_VERSION__: string;
declare const __APP_SHA__: string;
/** When the shipped datasets stop being current, an ISO instant or null
 *  (src/lib/data/airacValidity.ts; AiracBanner reads it). */
declare const __DATA_VALID_UNTIL__: string | null;
