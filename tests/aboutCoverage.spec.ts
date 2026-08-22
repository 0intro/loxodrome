/* Drift net over the About modal's account of itself.
 *
 * The modal is the app's only statement of where its data comes from, and its
 * Privacy section is also the source the hosted privacy policy is generated
 * from (scripts/gen-privacy.js, pinned by tests/privacyPage.spec.ts), so a
 * dataset that ships without appearing there is a real gap rather than a
 * cosmetic one. Four had accumulated before this
 * test existed: the six aerodrome-facility directories, the French and
 * Italian nature zones, and a 4 MB FAA aerodrome file no code even read.
 *
 * The net is deliberately structural. It reads the COMMITTED
 * public/data/ directory and the loader table, so a publisher added
 * tomorrow is covered the day its sidecar lands, which a hand-kept list
 * of expectations would not be. */

import { readFileSync, readdirSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

import { PUBLISHERS } from '../src/lib/state/layers.svelte';

const src = (rel: string): string =>
	readFileSync(new URL(`../src/${rel}`, import.meta.url), 'utf-8');

/** Every sidecar the repo ships, minus the `.next` twins, which are the
 *  same builder's output one cycle ahead and share their sibling's card. */
function shippedSidecars(): string[] {
	const dir = new URL('../public/data/', import.meta.url);
	return readdirSync(dir)
		.filter((f) => f.endsWith('.meta.json') && !f.endsWith('.next.meta.json'))
		.map((f) => `/data/${f}`)
		.sort();
}

/** loader name -> the sidecar path it fetches, read out of the loader
 *  declarations in data/meta.ts (`export const loadX = metaLoader<T>('…')`
 *  and its optional twin). */
function loaderPaths(): Map<string, string> {
	const out = new Map<string, string>();
	const re =
		/export const (\w+) = (?:optionalMetaLoader|metaLoader)<[^>]*>\(\s*'([^']+)'/g;
	for (const m of src('lib/data/meta.ts').matchAll(re)) {
		out.set(m[1], m[2]);
	}
	return out;
}

/** The loaders aboutMeta.ts actually imports, which is what decides
 *  whether a sidecar can reach the modal at all. */
function loadersUsedByAbout(): Set<string> {
	const text = src('lib/data/aboutMeta.ts');
	const block = text.slice(0, text.indexOf("} from './meta';"));
	const used = new Set<string>();
	for (const m of block.matchAll(/\b(load\w+Meta)\b/g)) {
		used.add(m[1]);
	}
	return used;
}

describe('About data-source coverage', () => {
	it('reaches every shipped dataset sidecar', () => {
		const paths = loaderPaths();
		const used = loadersUsedByAbout();
		const reachable = new Set(
			[...used].map((name) => paths.get(name)).filter((p): p is string => !!p),
		);
		const missing = shippedSidecars().filter((p) => !reachable.has(p));
		expect(
			missing,
			`these datasets ship but no About loader reads them:\n  ${missing.join('\n  ')}`,
		).toEqual([]);
	});

	it('declares a loader for every sidecar it imports', () => {
		const paths = loaderPaths();
		const unresolved = [...loadersUsedByAbout()].filter((n) => !paths.has(n));
		// A loader aboutMeta imports but meta.ts does not declare with a
		// literal path means the regex above stopped matching the file's
		// shape, not that anything is wrong with the modal. Fail loudly
		// rather than silently passing the test above on an empty set.
		expect(unresolved, 'loader paths went unresolved; check the regex').toEqual([]);
	});

	it('gives every publisher a card', () => {
		const modal = src('lib/components/AboutModal.svelte');
		// The per-country cards carry an explicit key; France, the FAA and
		// pruatlas are hand-written cards addressed by their own heading.
		const keyed = new Set(
			[...modal.matchAll(/\bkey: '([a-z]{2})'/g)].map((m) => m[1]),
		);
		// pruatlas titles its card with the product name itself, which is
		// locale-invariant and so lives in the markup rather than a key.
		const handWritten: Record<string, string> = {
			fr: 't.about.headFrance',
			faa: 't.about.headFaa',
			pruatlas: 'EUROCONTROL pruatlas',
		};
		const missing = PUBLISHERS.filter((p) => {
			if (keyed.has(p)) {
				return false;
			}
			const head = handWritten[p];
			return !(head && modal.includes(head));
		});
		expect(
			missing,
			`these publishers have no About card: ${missing.join(', ')}`,
		).toEqual([]);
	});
});
