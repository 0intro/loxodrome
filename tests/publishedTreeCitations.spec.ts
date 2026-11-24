/* Nothing in the published tree cites the Claude context: the root file or
 * the topic rules beside it. Publishing squashes dev's tree into main
 * WITHOUT that file, the docs/ directory and .claude/, so a citation of
 * either dangles on GitHub, code comments included: state the fact in place
 * instead. And the publish leaves out only the ROOT ones, so a context file
 * anywhere below the root would ship. Six had crept into one session's work
 * (the map views, the context menu, the weather tab, the viewer's About and
 * its spec) with nothing to say so before a publish. Comments may keep their
 * docs/*.md cross-references, which is a separate, deliberate choice. */

import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = process.cwd();
/** The context file's name and the rules directory, spelled so this file
 *  cites neither. */
const NAME = ['CLAUDE', 'md'].join('.');
const RULES = ['.claude', 'rules'].join('/');
/** What the publish leaves out, and the committed datasets, whose upstream
 *  text is kept verbatim. */
const LEFT_OUT = [NAME, 'docs/', '.claude/', 'public/data/'];
/** The tracked text a person writes or a tool reads. Binary files and the
 *  lock file carry no citation. */
const TEXT =
	/(\.(ts|svelte|js|mjs|cjs|go|java|kt|md|html|css|toml|ya?ml|xml|json|gradle|properties|pro|txt|svg)|^\.[a-z]+rc(\.json)?|\.editorconfig|\.nvmrc|\.gitignore|LICENSE)$/;

/** Every file the publish would see, tracked or about to be (not ignored):
 *  a walk of chosen roots missed the workflows and the root configs. */
function listed(): string[] {
	return execFileSync('git', ['ls-files', '-z', '--cached', '--others', '--exclude-standard'], {
		cwd: ROOT,
		encoding: 'utf8',
		maxBuffer: 64 << 20,
	})
		.split('\0')
		.filter((f) => f !== '');
}

describe('the published tree', () => {
	it('carries no context file below the root', () => {
		const nested = listed().filter(
			(f) => (f.endsWith('/' + NAME) || f.includes('/.claude/')) && !f.startsWith('.claude/'),
		);
		expect(nested).toEqual([]);
	});

	it('cites no file the publish leaves out', () => {
		const tracked = listed().filter((f) => !LEFT_OUT.some((x) => f === x || f.startsWith(x)));
		const all = tracked.filter((f) => {
			const p = join(ROOT, f);
			return TEXT.test(f.split('/').pop() ?? f) && existsSync(p) && statSync(p).size < 2_000_000;
		});
		expect(all.length).toBeGreaterThan(500);
		for (const f of ['.github/workflows/ci.yml', 'package.json', 'eslint.config.js', 'README.md']) {
			expect(all, f).toContain(f);
		}
		const citing = all.filter((f) => {
			if (f === 'package-lock.json') {
				return false;
			}
			const text = readFileSync(join(ROOT, f), 'utf8');
			return text.includes(NAME) || text.includes(RULES);
		});
		expect(citing).toEqual([]);
		// A git walk and some 2 000 files read: tens of milliseconds alone, and
		// past the default 5 s inside a full run on a loaded machine.
	}, 60_000);
});
