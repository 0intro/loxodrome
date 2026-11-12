/* The place panel (detail/PlaceDetail.svelte): a town or a typed position as
 * a detail target, its head in both languages, the lists' compass points and
 * scan, and the map's mark (docs/search.md "The place panel"). */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { compassPoint } from '$lib/format/compass';
import { nearestPoints } from '$lib/nav/nearest';
import { i18n } from '$lib/state/i18n.svelte';
import { closeDetail, navigateToAirport, selectPlace, ui } from '$lib/state/ui.svelte';
import {
	detailBackLabel,
	detailCanCenter,
	detailOpen,
	detailScrollKey,
	detailSubtitle,
	detailTitle,
} from '$lib/components/detail/detailHead.svelte';

vi.mock('leaflet', () => ({ default: {} }));

const ETAMPES = {
	id: 'fr:91223',
	name: 'Étampes',
	admin: 'Essonne',
	country: 'FR',
	pop: 25_000,
	commune: true,
	lat: 48.4347,
	lon: 2.1617,
};

afterEach(() => {
	closeDetail();
	i18n.locale = 'en';
});

describe('compassPoint', () => {
	it('reads eight points, a boundary going clockwise', () => {
		const cases: [number, string][] = [
			[0, 'N'],
			[22.4, 'N'],
			[22.5, 'NE'],
			[90, 'E'],
			[157.5, 'S'],
			[202.5, 'SW'],
			[292.4, 'W'],
			[337.4, 'NW'],
			[337.5, 'N'],
			[360, 'N'],
			[-45, 'NW'],
			[405, 'NE'],
		];
		for (const [deg, point] of cases) {
			expect(compassPoint(deg), String(deg)).toBe(point);
		}
	});
});

describe('nearestPoints', () => {
	it('keeps the radius and the limit, nearest first, ties on the name', () => {
		const pts = [
			{ id: 'far', lat: 1, lon: 0 },
			{ id: 'b', lat: 0, lon: 0.1 },
			{ id: 'a', lat: 0, lon: -0.1 },
			{ id: 'near', lat: 0.05, lon: 0 },
		];
		const near = nearestPoints(pts, 0, 0, { limit: 3, radiusNM: 10 }, (p) => p.id);
		expect(near.map((h) => h.item.id)).toEqual(['near', 'a', 'b']);
		expect(near[0].distNM).toBeCloseTo(3, 0);
		expect(compassPoint(near[1].bearingTrueDeg)).toBe('W');
	});
});

describe('a place as the detail', () => {
	it('is a fresh selection that holds everything its panel shows', () => {
		navigateToAirport('LFOX');
		selectPlace(ETAMPES);
		expect(ui.detail).toEqual({ kind: 'place', ...ETAMPES });
		expect(ui.detailBack).toBeNull();
		expect(detailOpen()).toBe(true);
		expect(detailCanCenter()).toBe(true);
		expect(detailScrollKey({ kind: 'place', ...ETAMPES })).toBe('place:fr:91223');
	});

	it('is titled by its name and says what and where it is, in both languages', () => {
		selectPlace(ETAMPES);
		expect(detailTitle()).toBe('Étampes');
		expect(detailSubtitle()).toBe('Commune, Essonne, France');
		selectPlace({ id: 'de:2867714', name: 'München', admin: 'Bavaria', country: 'DE', lat: 48.137, lon: 11.575 });
		expect(detailSubtitle()).toBe('Town, Bavaria, Germany');
		i18n.locale = 'fr';
		expect(detailSubtitle()).toBe('Localité, Bavaria, Allemagne');
	});

	it('titles a typed position by its coordinates', () => {
		selectPlace({ id: 'pt:48.82000,2.62000', lat: 48.82, lon: 2.62 });
		expect(detailTitle()).toBe('48°49\'12"N 002°37\'12"E');
		expect(detailSubtitle()).toBe('Position');
	});

	it('names the way back, the French preposition contracted with the article', () => {
		const back = (name: string | undefined, locale: 'en' | 'fr'): string => {
			i18n.locale = locale;
			selectPlace({ ...ETAMPES, name });
			navigateToAirport('LFOX');
			return detailBackLabel();
		};
		expect(back('Étampes', 'en')).toBe('Back to Étampes');
		expect(back('Étampes', 'fr')).toBe('Retour à Étampes');
		expect(back('Le Havre', 'fr')).toBe('Retour au Havre');
		expect(back('Les Mureaux', 'fr')).toBe('Retour aux Mureaux');
		expect(back('La Rochelle', 'fr')).toBe('Retour à La Rochelle');
		expect(back('Lesquin', 'fr')).toBe('Retour à Lesquin');
		expect(back(undefined, 'fr')).toBe('Retour à la position');
		expect(back(undefined, 'en')).toBe('Back to the position');
	});
});

describe('the place mark and the panel', () => {
	const read = (rel: string): string => readFileSync(rel, 'utf8');

	it('is drawn from the one selection switch, on its own pane, never a click target', () => {
		expect(read('src/lib/map/selectionHighlight.ts')).toContain(
			"markPlace(detail?.kind === 'place' ? detail : null);",
		);
		const layer = read('src/lib/map/placeLayer.ts');
		expect(layer).toContain("const PLACE_PANE_Z = '652';");
		expect(layer).toContain('interactive: false,');
		expect(layer).not.toMatch(/\.on\(\s*'click'/);
	});

	it('is the detail body for a place, and adds to the route in one undo step', () => {
		expect(read('src/lib/components/detail/DetailBody.svelte')).toContain(
			'<PlaceDetail place={selection.place} />',
		);
		const panel = read('src/lib/components/detail/PlaceDetail.svelte');
		expect(panel).toContain("offerUndoFor('added', () => addWaypointFromSnap(point))");
		expect(panel).toContain("offerUndoFor('inserted', () => insertWaypointAfter(at, point))");
		expect(panel).toContain('bestInsertionIndex(activeRoute().waypoints, place)');
	});
});
