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
import { fileURLToPath } from 'node:url';
import pkg from './package.json' with { type: 'json' };

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

/** The build-time constants src/types/build.d.ts declares. */
export const appDefine = {
	__APP_VERSION__: JSON.stringify(pkg.version),
	__APP_SHA__: JSON.stringify(gitSha),
};
