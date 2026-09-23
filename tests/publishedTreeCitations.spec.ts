/* Nothing in the published tree cites the Claude context file. Publishing
 * squashes dev's tree into main WITHOUT that file, the docs/ directory and
 * .claude/, so a citation of it dangles on GitHub, code comments included:
 * state the fact in place instead. Six had crept into one session's work
 * (the map views, the context menu, the weather tab, the viewer's About and
 * its spec) with nothing to say so before a publish. Comments may keep their
 * docs/*.md cross-references, which is a separate, deliberate choice. */

import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

const ROOT = process.cwd();
/** The context file's name, spelled so this file does not cite it. */
const NAME = ['CLAUDE', 'md'].join('.');
/** What the published tree carries that a person writes. */
const ROOTS = [
	'src',
	'tests',
	'scripts',
	'public',
	'notam-proxy',
	'account-api',
	'notam-viewer-net',
	'cmd',
	'internal',
	'android/app/src',
];
/** Generated or vendored, and the committed datasets, whose upstream text is
 *  kept verbatim. */
const SKIP = new Set(['node_modules', 'dist', 'build', '.gradle', 'public/data']);
const TEXT = /\.(ts|svelte|js|mjs|cjs|go|java|kt|md|html|css|toml|ya?ml|xml|json)$/;

function files(dir: string, out: string[]): void {
	for (const name of readdirSync(dir)) {
		const p = join(dir, name);
		if (SKIP.has(name) || SKIP.has(relative(ROOT, p))) {
			continue;
		}
		const st = statSync(p);
		if (st.isDirectory()) {
			files(p, out);
		} else if (TEXT.test(name) && st.size < 2_000_000) {
			out.push(p);
		}
	}
}

describe('the published tree', () => {
	it('cites no file the publish leaves out', () => {
		const all: string[] = [];
		for (const r of ROOTS) {
			files(join(ROOT, r), all);
		}
		for (const f of ['README.md', 'index.html', 'notam.html', 'vite.config.ts', 'vite.notam.config.ts']) {
			all.push(join(ROOT, f));
		}
		expect(all.length).toBeGreaterThan(500);
		const citing = all
			.filter((f) => readFileSync(f, 'utf8').includes(NAME))
			.map((f) => relative(ROOT, f));
		expect(citing).toEqual([]);
	});
});
