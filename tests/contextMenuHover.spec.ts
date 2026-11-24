/* A map menu row lights its feature on the map while the pointer rests on
 * it (an airspace, a NOTAM, an aerodrome, a navaid, an obstacle, a SUP AIP
 * zone), and gave the map back only on its mouseleave. Escape, a follow pan
 * or Back closes the menu and takes its rows away under a still pointer,
 * which fires no mouseleave, so the feature stayed lit in place of the
 * selection's own highlight: in a dev session, PARIS 9 hovered in the menu
 * stayed lit after Escape. The close now hands the map back when a row
 * held it. Pinned from the source, as tests/radarCaution.spec.ts pins the
 * dialog's effects: a client spec has no DOM to mount the menu in. (The
 * SIGMET rows ride useSigmetHover, whose effect drops the clone with the
 * rows, tests/sigmetHover.client.spec.ts.) */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const src = readFileSync(join(process.cwd(), 'src/lib/components/ContextMenu.svelte'), 'utf8');

describe("the map menu's row hover", () => {
	it('is released when the menu closes', () => {
		const at = src.indexOf('untrack(leaveRow)');
		expect(at).toBeGreaterThan(0);
		const open = src.lastIndexOf('$effect(() => {', at);
		const close = src.indexOf('\n\t});', at);
		expect(src.slice(open, close + 5).replace(/\s+/g, ' ')).toBe(
			'$effect(() => { if (!contextMenu.open) { previewVacChart(null); untrack(leaveRow); } });',
		);
	});

	it('goes through the one held hover on every feature row', () => {
		const enters = [...src.matchAll(/onmouseenter=\{\(\) => (.*)\}\n/g)].map((m) => m[1]);
		const feature = enters.filter((e) => /hoverFeature\(|hoverSupaipZone\(/.test(e));
		expect(feature).toHaveLength(6);
		for (const e of feature) {
			expect(e).toMatch(/^enterRow\(/);
		}
		expect(src).not.toContain('onmouseleave={clearHover}');
		expect(src).not.toContain('onmouseleave={() => hoverSupaipZone(null)}');
	});
});
