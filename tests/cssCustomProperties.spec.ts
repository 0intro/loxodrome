/* Every custom property the stylesheets read is declared somewhere. A
 * `var(--x)` naming nothing resolves to the property's initial value with no
 * warning anywhere: `--nav-accent` left the Navigation tab's flown leg with
 * the text colour for a border and its pinned leg with no fill at all, and
 * `--muted` left the NOTAM Viewer's head links in the inherited ink. A
 * fallback hides the same mistake differently (the fallback is then the only
 * value there ever is), so a property read ONLY with a fallback must be
 * declared too, or written as the literal it always was.
 *
 * Declarations are read from every file under src/ (the stylesheets, the
 * components' markup and styles, the scripts): CSS declarations, Svelte's
 * `style:--x` directive, and quoted names handed to `setProperty` or kept as
 * object keys (ui/stageRect.ts). Comments are stripped first, since they
 * quote declarations. */

import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

function walk(dir: string, out: string[] = []): string[] {
	for (const name of readdirSync(dir)) {
		const p = path.join(dir, name);
		if (statSync(p).isDirectory()) walk(p, out);
		else if (/\.(svelte|css|ts|html)$/.test(name)) out.push(p);
	}
	return out;
}

function stripComments(text: string, file: string): string {
	// CSS and markup comments everywhere; line comments only in scripts, where
	// `//` never starts a URL inside a style (the CSS files hold none either).
	let s = text.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/<!--[\s\S]*?-->/g, ' ');
	if (/\.(ts|svelte)$/.test(file)) s = s.replace(/(^|[^:'"`\\])\/\/[^\n]*/g, '$1');
	return s;
}

const NAME = '--[A-Za-z0-9_-]+';
const files = [...walk('src'), 'index.html', 'notam.html'];
const declared = new Set<string>();
const read = new Map<string, { bare: boolean; files: Set<string> }>();

for (const file of files) {
	const text = stripComments(readFileSync(file, 'utf8'), file);
	for (const m of text.matchAll(new RegExp(`(?<![\\w-])(${NAME})\\s*:`, 'g'))) declared.add(m[1]);
	for (const m of text.matchAll(new RegExp(`style:(${NAME})`, 'g'))) declared.add(m[1]);
	for (const m of text.matchAll(new RegExp(`['"\`](${NAME})['"\`]`, 'g'))) declared.add(m[1]);
	for (const m of text.matchAll(new RegExp(`var\\(\\s*(${NAME})\\s*([,)])`, 'g'))) {
		const e = read.get(m[1]) ?? { bare: false, files: new Set<string>() };
		if (m[2] === ')') e.bare = true;
		e.files.add(file);
		read.set(m[1], e);
	}
}

describe('every custom property read is declared', () => {
	it('finds the declarations it reads (the scan works)', () => {
		expect(declared.has('--surface')).toBe(true);
		expect(declared.has('--stage-l')).toBe(true);
		expect(read.get('--surface')?.bare).toBe(true);
	});

	it('declares every property read without a fallback', () => {
		const missing = [...read].filter(([n, e]) => e.bare && !declared.has(n)).map(([n, e]) => `${n} (${[...e.files].join(', ')})`);
		expect(missing).toEqual([]);
	});

	it('reads no property only through its fallback', () => {
		const fallbackOnly = [...read].filter(([n, e]) => !e.bare && !declared.has(n)).map(([n, e]) => `${n} (${[...e.files].join(', ')})`);
		expect(fallbackOnly).toEqual([]);
	});
});
