/* Which routes print a vertical profile sheet, read from the sources (the
 * printReview precedent): in the dossier every route, an alternate
 * included, each after its group's cards, on prefetched terrain and clouds
 * for every route. The route profile's printer prints those sheets alone,
 * one for every route. */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const read = (p: string): string => readFileSync(new URL(`../${p}`, import.meta.url), 'utf8');

const doc = read('src/lib/components/flightprep/PrintDoc.svelte');
const host = read('src/lib/components/PackPrintHost.svelte');

describe('the dossier\'s profile sheets', () => {
	it('print for every route of a group, the alternate included', () => {
		expect(doc).toContain('const rs = t.alternate ? [t.route, t.alternate] : [t.route];');
		expect(doc).toMatch(/profiled: rs,/);
		expect(doc).toMatch(/profiled: \[o\],/);
		expect(doc).toMatch(/\{#each g\.profiled as r \(r\.id\)\}\s*\{@render profileSheet\(r\)\}/);
		expect(doc).not.toMatch(/ByTrip\b/);
	});

	it('stay one page under every margins preset of the print dialog', () => {
		// "Minimum" takes the printer's unprintable edge off the 210mm page,
		// 4.2mm a side on a laser (240 twips), and a fixed sheet taller than
		// what is left puts its empty end on a blank page.
		const edgeMm = (240 / 1440) * 25.4;
		const m = /\.fpd-profile \{[^}]*height: ([\d.]+)mm;/.exec(doc);
		expect(m, '.fpd-profile states no height in mm').not.toBeNull();
		expect(Number(m![1])).toBeLessThanOrEqual(210 - 2 * edgeMm);
	});

	it('draw on terrain and clouds prefetched for every route', () => {
		expect(host).toContain('...printableRoutes.map(async (r) => {\n\t\t\t\t\t\ttry {\n\t\t\t\t\t\t\tterrain[r.id] = await sampleProfile(');
		expect(host).toContain('...printableRoutes.map((r) => ensureRouteCloudsFor(r, { retry: true })),');
		expect(host).toContain("plan.push({ kind: 'terrain', total: printableRoutes.length });");
	});
});

describe('the route profile\'s printer', () => {
	const modal = read('src/lib/components/RouteProfileModal.svelte');

	it('prints every route\'s sheet, the button, the phone row and Ctrl+P alike', () => {
		expect(modal.match(/requestPackPrint\('profiles'\)/g)).toHaveLength(3);
		expect(modal).not.toContain("printSurface('routeProfile')");
	});

	it('prints the dossier\'s sheets alone, for every route in the order flown', () => {
		expect(doc).toMatch(/\{#if mode === 'profiles'\}\s*\{#each profileRoutes as r \(r\.id\)\}\s*\{@render profileSheet\(r\)\}/);
		expect(doc).toContain("{#if mode === 'prep' || mode === 'dossier'}");
		expect(doc).toContain("const annex = $derived(mode === 'dossier' || mode === 'wx');");
		expect(host).toContain("const sheets = dossier || mode === 'profiles';");
		expect(host).toContain("profiles: 'profile'");
	});
});
