/* Every chart on the shared pointer machine (ui/plotGestures.ts) hands it
 * only its capture element's OWN lostpointercapture. A finger's press holds
 * capture on the column or band it landed on, and the pan taking capture on
 * the chart fires one at that child, which bubbles up: read as the
 * machine's, it ended a touch pan one step in (the map profile panned 6 px
 * for a 60 px drag). */
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const dir = join(process.cwd(), 'src/lib/components');
const charts = readdirSync(dir)
	.filter((f) => f.endsWith('.svelte'))
	.map((f) => ({ f, src: readFileSync(join(dir, f), 'utf8') }))
	.filter(({ src }) => src.includes('createPlotGestures('));

describe('a chart on the shared pointer machine', () => {
	it('is found: the route chart and the column chart', () => {
		expect(charts.map((c) => c.f).sort()).toEqual(expect.arrayContaining(['RouteProfile.svelte', 'VerticalProfile.svelte']));
	});

	for (const { f, src } of charts) {
		it(`${f} hands the machine its capture element's own lostpointercapture alone`, () => {
			const el = /captureEl: \(\) => (\w+)/.exec(src)?.[1];
			expect(el, 'the capture element').toBeTruthy();
			const handler = /onlostpointercapture=\{(\w+)\}/.exec(src)?.[1];
			expect(handler, 'the lostpointercapture handler on the chart').toBeTruthy();
			const at = src.indexOf(`function ${handler}(e: PointerEvent): void {`);
			expect(at).toBeGreaterThan(0);
			const body = src.slice(at, src.indexOf('\n\t}', at));
			expect(body).toMatch(new RegExp(`if \\(e\\.target !== ${el}\\) \\{\\s*return;\\s*\\}\\s*gestures\\.lost\\(e\\);`));
		});
	}
});
