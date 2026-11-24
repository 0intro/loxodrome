/* The METAR station panel's category chip (MetarStationDetail.svelte) reads
 * the same observation its WeatherSection shows with its age, and that
 * section exists only while Live weather is on. The map's tile cache outlives
 * the switch, so the chip reads it only while the section shows. Rendered on
 * the server. */

import { render } from 'svelte/server';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { MapStation } from '$lib/state/metarStations.svelte';
import type { AwcMetar } from '$lib/weather/awc';
import { installLeafletNode } from './helpers/leafletNode';

const LFPO: AwcMetar = {
	icaoId: 'LFPO',
	obsTime: 0,
	rawOb: 'METAR LFPO 180230Z 24008KT CAVOK 09/05 Q1021',
	lat: 48.72,
	lon: 2.38,
	fltCat: 'VFR',
	name: 'Paris-Orly, ID, FR',
};

vi.mock('$lib/state/metarStations.svelte', async (importOriginal) => ({
	...(await importOriginal<typeof import('$lib/state/metarStations.svelte')>()),
	stationFeed: (): MapStation[] => [{ metar: LFPO, cat: 'VFR', ageMin: 400, freshness: 'expired' }],
}));

// The panel's import graph reaches the map layers, which extend Leaflet's
// classes as they load.
installLeafletNode();
const { default: MetarStationDetail } = await import('$lib/components/detail/MetarStationDetail.svelte');
const { display } = await import('$lib/state/display.svelte');

const chip = (html: string): string | null => /cat-chip[^>]*>\s*([^<]*?)\s*</.exec(html)?.[1] ?? null;
const station = { id: 'LFPO', lat: 48.72, lon: 2.38 };

afterEach(() => {
	display.liveWeather = true;
});

describe('the station panel chip', () => {
	it("shows the tile cache's category while Live weather is on", () => {
		display.liveWeather = true;
		expect(chip(render(MetarStationDetail, { props: { station } }).body)).toBe('VFR');
	});

	it('reads no category with Live weather off, whatever the tile cache holds', () => {
		display.liveWeather = false;
		expect(chip(render(MetarStationDetail, { props: { station } }).body)).toBe('No category');
	});
});
