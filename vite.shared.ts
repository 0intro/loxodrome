/* What both builds are, beyond what each one is.
 *
 * Two apps ship from this repo: Loxodrome (index.html) and the NOTAM Viewer
 * (notam.html), over one `src/lib`. The things they must agree on live here,
 * because a second spelling of the `$lib` alias or of the version stamp would
 * be a difference nobody meant to make.
 *
 * In tsconfig's include beside vite.config.ts, so the type-aware lint reads it.
 */

import { execSync } from 'node:child_process';
import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import pkg from './package.json' with { type: 'json' };
import { shippedDataValidUntilMs, type ShippedSidecar } from './src/lib/data/airacValidity.ts';

/** `$lib` matches the SvelteKit / Vite-Svelte convention and the tsconfig
 *  paths entry, so dev / build / svelte-check / vitest all resolve
 *  identically. */
export const libDir = fileURLToPath(new URL('./src/lib', import.meta.url));

/** Short git SHA of the working-tree commit, baked into the bundle so the
 *  About modal can show "v2.0.0 · abc1234". Falls back to 'unknown' if git is
 *  unavailable (a packaged tarball build). */
export const gitSha = ((): string => {
	try {
		return execSync('git rev-parse --short HEAD', {
			stdio: ['ignore', 'pipe', 'ignore'],
		})
			.toString()
			.trim();
	} catch {
		return 'unknown';
	}
})();

/** When the datasets this build ships stop being current, as an ISO instant
 *  (src/lib/data/airacValidity.ts), read from the sidecars in public/data at
 *  build time. Null when none carries a usable date. */
export const dataValidUntil = ((): string | null => {
	const dir = fileURLToPath(new URL('./public/data/', import.meta.url));
	const sidecars: ShippedSidecar[] = [];
	for (const file of readdirSync(dir)) {
		if (!file.endsWith('.meta.json')) {
			continue;
		}
		try {
			const meta = JSON.parse(readFileSync(dir + file, 'utf-8')) as { effective?: unknown };
			sidecars.push({ file, effective: meta.effective });
		} catch {
			// An unreadable sidecar says nothing about validity.
		}
	}
	const ms = shippedDataValidUntilMs(sidecars, Date.now());
	return ms === null ? null : new Date(ms).toISOString();
})();

/** How both builds bundle a web worker (the airspace decorations' paint,
 *  src/lib/map/decoPaint.worker.ts, and the offline pack transfer,
 *  src/lib/offline/packTransfer.worker.ts, the site's alone): one classic
 *  script each, emitted under assets/ as .js beside the app's own chunks,
 *  which the service worker's precache pattern already covers. Classic, so
 *  no top-level await in a worker entry. */
export const appWorker = { format: 'iife' as const };

/** The build-time constants src/types/build.d.ts declares. */
export const appDefine = {
	__APP_VERSION__: JSON.stringify(pkg.version),
	__APP_SHA__: JSON.stringify(gitSha),
	__DATA_VALID_UNTIL__: JSON.stringify(dataValidUntil),
};
