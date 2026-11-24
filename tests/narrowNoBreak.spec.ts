/* The app joins what must not break with the narrow no-break space
 * (U+202F), never U+00A0: Bitstream Vera Sans, which fontconfig gives
 * Firefox for system-ui on Fedora, draws U+00A0 at twice its space, so
 * "23 nov." and "3 (1 night)" showed a wide gap. The Overview's blank
 * cells keep U+00A0 as their placeholder, which draws nothing. */

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

function sources(dir: string): string[] {
	return readdirSync(dir).flatMap((name) => {
		const p = join(dir, name);
		if (statSync(p).isDirectory()) {
			return sources(p);
		}
		return /\.(ts|svelte)$/.test(name) ? [p] : [];
	});
}

/** The blank cells' placeholders, the one use of U+00A0 left. */
const PLACEHOLDERS = 'src/lib/components/flightprep/DossierPage.svelte';

describe('a no-break join', () => {
	it('is the narrow no-break space in every source but the blank cells', () => {
		const found: string[] = [];
		for (const p of sources('src')) {
			if (p === PLACEHOLDERS) {
				continue;
			}
			readFileSync(p, 'utf8')
				.split('\n')
				.forEach((line, i) => {
					if (/\u00a0|\\u00a0|&nbsp;|&#160;|&#xa0;/i.test(line)) {
						found.push(`${p}:${i + 1}`);
					}
				});
		}
		expect(found).toEqual([]);
	});
});
