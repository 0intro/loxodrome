/* The profiles' stack menu (ProfileStackMenu, opened by a right-click or a
 * long press) opens by REASSIGNING the modal's `ctxMenu` state, and its
 * close writes `ctxMenu.open`, which reads that signal: an $effect calling
 * the close bare subscribes to ctxMenu and re-runs at every opening, shutting
 * the menu in the very flush that opened it. The placement effect did so in
 * both modals from 2026-07-25, and the menu never opened, on a right-click as
 * on a long press (found by the cloud reading's drive, 2026-10-08). Pinned
 * on the source: no spec mounts the modals. */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

/** The bodies of a component's `$effect(() => { ... })` calls, braces
 *  matched. */
function effectBodies(src: string): string[] {
	const out: string[] = [];
	const re = /\$effect\(\s*\(\)\s*=>\s*\{/g;
	for (let m = re.exec(src); m; m = re.exec(src)) {
		let depth = 1;
		let i = m.index + m[0].length;
		const start = i;
		while (i < src.length && depth > 0) {
			if (src[i] === '{') {
				depth++;
			} else if (src[i] === '}') {
				depth--;
			}
			i++;
		}
		out.push(src.slice(start, i - 1));
	}
	return out;
}

/** An effect body with its untrack(...) calls taken out (one level of
 *  parentheses inside, enough for an arrow's empty parameter list). */
const tracked = (body: string): string => body.replace(/untrack\((?:[^()]|\([^()]*\))*\)/g, '');

describe('the profiles’ stack menu', () => {
	for (const file of ['RouteProfileModal', 'NavProfileModal']) {
		it(`${file}: closed by its effects untracked, so it can open`, () => {
			const bodies = effectBodies(readFileSync(`src/lib/components/${file}.svelte`, 'utf8'));
			// The placement effect still closes it...
			expect(bodies.some((b) => b.includes("placementOf('") && b.includes('untrack(closeCtxMenu)'))).toBe(true);
			// ...and no effect does so tracked.
			expect(bodies.filter((b) => /\bcloseCtxMenu\(\)/.test(tracked(b)))).toEqual([]);
		});
	}
});
