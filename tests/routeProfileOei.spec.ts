/* The route profile's one-engine ceiling line (RouteProfile oeiCeilingFt):
 * a step-line per leg at the ceilings given, labelled "OEI" at its run's
 * END (the MSA's label rides the start), gapping where a leg has none, and
 * absent without data; the layer's toggle is a stored preference like the
 * others (prefRoundTrip). Server-rendered. */

import { render } from 'svelte/server';
import { describe, expect, it } from 'vitest';
import RouteProfile from '$lib/components/RouteProfile.svelte';

const WAYPOINTS = [
	{ distNM: 0, altFt: 800, label: 'LFLB', name: 'LFLB' },
	{ distNM: 10, altFt: 4500, label: 'P1', name: 'P1' },
	{ distNM: 28, altFt: 1300, label: 'LFLS', name: 'LFLS' },
];

function chart(oeiCeilingFt: (number | null)[] | null, msaFt: (number | null)[] | null = null): string {
	return render(RouteProfile, {
		props: {
			bands: [],
			terrain: [],
			waypoints: WAYPOINTS,
			altitudePath: {
				vertices: WAYPOINTS.map((w) => ({ distNM: w.distNM, altFt: w.altFt })),
				markers: WAYPOINTS.map((w) => ({ distNM: w.distNM, altFt: w.altFt })),
			},
			legAltsFt: [4500, 4500],
			fromNM: 0,
			toNM: 28,
			floorFt: 0,
			ceilingFt: 10000,
			widthPx: 800,
			heightPx: 400,
			oeiCeilingFt,
			msaFt,
		},
	}).body;
}

/** Every element `tag` carrying `cls`, its attributes and its text. */
function elements(html: string, tag: string, cls: string): { attrs: Record<string, string>; text: string }[] {
	const out: { attrs: Record<string, string>; text: string }[] = [];
	for (const m of html.matchAll(new RegExp(`<${tag}\\b([^>]*)>([^<]*)`, 'g'))) {
		const attrs = Object.fromEntries([...m[1].matchAll(/([\w-]+)="([^"]*)"/g)].map((a) => [a[1], a[2]]));
		if ((attrs.class ?? '').split(/\s+/).includes(cls)) {
			out.push({ attrs, text: m[2] });
		}
	}
	return out;
}

describe('the one-engine ceiling line', () => {
	it('steps across the legs at the ceilings given, labelled at its end', () => {
		const html = chart([4300, 3600], [5700, 5700]);
		const lines = elements(html, 'path', 'oei');
		expect(lines).toHaveLength(1);
		// Two flat legs joined by a step: four points.
		expect((lines[0].attrs.d.match(/[ML]/g) ?? []).length).toBe(4);
		expect(elements(html, 'path', 'oei-casing')).toHaveLength(1);
		const labels = elements(html, 'text', 'oei-label');
		expect(labels.map((l) => l.text)).toEqual(['OEI']);
		const msaLabel = elements(html, 'text', 'msa-label')[0];
		// The OEI label sits right of the MSA's, at the run's end.
		expect(Number(labels[0].attrs.x)).toBeGreaterThan(Number(msaLabel.attrs.x) + 400);
	});

	it('gaps where a leg has no ceiling', () => {
		const html = chart([4300, null]);
		expect(elements(html, 'path', 'oei')).toHaveLength(1);
		expect((elements(html, 'path', 'oei')[0].attrs.d.match(/[ML]/g) ?? []).length).toBe(2);
	});

	it('is absent without data', () => {
		expect(elements(chart(null), 'path', 'oei')).toHaveLength(0);
		expect(elements(chart(null), 'text', 'oei-label')).toHaveLength(0);
	});
});
