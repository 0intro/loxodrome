/* Nothing in the published tree cites the Claude context file. Publishing
 * squashes dev's tree into main WITHOUT that file, the docs/ directory and
 * .claude/, so a citation of it dangles on GitHub, code comments included:
 * state the fact in place instead. Six had crept into one session's work
 * (the map views, the context menu, the weather tab, the viewer's About and
 * its spec) with nothing to say so before a publish. Comments may keep their
 * docs/*.md cross-references, which is a separate, deliberate choice. */

import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = process.cwd();
/** The context file's name, spelled so this file does not cite it. */
const NAME = ['CLAUDE', 'md'].join('.');
/** What the publish leaves out, and the committed datasets, whose upstream
 *  text is kept verbatim. */
const LEFT_OUT = [NAME, 'docs/', '.claude/', 'public/data/'];
/** The tracked text a person writes or a tool reads. Binary files and the
 *  lock file carry no citation. */
const TEXT =
	/(\.(ts|svelte|js|mjs|cjs|go|java|kt|md|html|css|toml|ya?ml|xml|json|gradle|properties|pro|txt|svg)|^\.[a-z]+rc(\.json)?|\.editorconfig|\.nvmrc|\.gitignore|LICENSE)$/;

describe('the published tree', () => {
	it('cites no file the publish leaves out', () => {
		// Every file the publish would carry, tracked or about to be (not
		// ignored): a walk of chosen roots missed the workflows and the root
		// configs.
		const tracked = execFileSync('git', ['ls-files', '-z', '--cached', '--others', '--exclude-standard'], {
			cwd: ROOT,
			encoding: 'utf8',
			maxBuffer: 64 << 20,
		})
			.split('\0')
			.filter((f) => f !== '' && !LEFT_OUT.some((x) => f === x || f.startsWith(x)));
		const all = tracked.filter((f) => {
			const p = join(ROOT, f);
			return TEXT.test(f.split('/').pop() ?? f) && existsSync(p) && statSync(p).size < 2_000_000;
		});
		expect(all.length).toBeGreaterThan(500);
		for (const f of ['.github/workflows/ci.yml', 'package.json', 'eslint.config.js', 'README.md']) {
			expect(all, f).toContain(f);
		}
		const citing = all.filter((f) => f !== 'package-lock.json' && readFileSync(join(ROOT, f), 'utf8').includes(NAME));
		expect(citing).toEqual([]);
	});
});
