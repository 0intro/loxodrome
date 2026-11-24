/* The touch floor keys off :root.touch-ui, the app's ONE definition of being
 * touched or in flight: App.svelte stamps it for a coarse pointer OR a running
 * recording (gloves and turbulence make any pointer coarse), the viewer's
 * shell for a coarse pointer. A component's own @media (pointer: coarse)
 * misses the recording half, and eight such blocks had drifted back in beside
 * the written rule. The media query lives in script, where the class is
 * stamped; no stylesheet carries one. */

import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { cssRulesOf } from './helpers/cssRules';

function styleSheets(dir: string): string[] {
	const out: string[] = [];
	for (const entry of readdirSync(dir, { withFileTypes: true })) {
		const path = join(dir, entry.name);
		if (entry.isDirectory()) {
			out.push(...styleSheets(path));
		} else if (entry.name.endsWith('.css') || (entry.name.endsWith('.svelte') && readFileSync(path, 'utf8').includes('<style'))) {
			out.push(path);
		}
	}
	return out;
}

describe('touch sizing', () => {
	it('keys off :root.touch-ui, never a stylesheet pointer query', () => {
		const sheets = styleSheets('src');
		expect(sheets.length).toBeGreaterThan(100);
		const offenders = sheets.flatMap((file) =>
			cssRulesOf(file)
				.filter((r) => r.parents.some((p) => /^@media\b.*\bpointer\s*:\s*coarse\b/.test(p)))
				.map((r) => `${file}: ${r.selectors.join(', ')}`),
		);
		expect(offenders).toEqual([]);
	});
});
