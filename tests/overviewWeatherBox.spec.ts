/* The Overview's weather box STATES what the plan flies with
 * (flightprep/weatherBox.ts over flightprep/windBasis.ts): the wind each trip
 * flies, set where it acts (the Route tab's wind switch), what the plan's
 * forecast says beside it (the levels behind its mean, ISA, the lowest
 * freezing level), and the departure's QNH as its take-off column reads it.
 * A wind typed there no longer sits in a box the forecast silently
 * overrules. Only Date is faked. */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('$lib/weather/openMeteo', async (orig) =>
	(await import('./helpers/fakeOpenMeteo')).withFakeColumns(await orig()),
);

import { fake } from './helpers/fakeOpenMeteo';
import { display } from '$lib/state/display.svelte';
import { flightPrep } from '$lib/state/flightPrep.svelte';
import { i18n } from '$lib/state/i18n.svelte';
import { routeSettings, type Route, type Waypoint } from '$lib/state/route.svelte';
import {
	ensureRouteWindFor,
	plansForecastFacts,
	plansForecastSource,
	plansMeanForecast,
	pruneRouteWind,
} from '$lib/state/routeWind.svelte';
import { resetWindAloftForTest, windAloft } from '$lib/state/windAloft.svelte';
import { routeWindBasis, type WindBasis } from '$lib/components/flightprep/windBasis';
import { departureQnhLines, overviewWindLines, type PlanWx } from '$lib/components/flightprep/weatherBox';

const T0 = Date.UTC(2026, 9, 2, 9, 40);

let seq = 0;
function route(...lats: number[]): Route {
	const id = `box-${seq++}`;
	return {
		id,
		name: null,
		selectedWaypointId: null,
		waypoints: lats.map(
			(lat, i): Waypoint => ({ id: `${id}-${i}`, lat, lon: 2, kind: 'free', alt: 3000, altAuto: true }),
		),
	};
}

const texts = (lines: { text: string; ink: string }[]): string[][] => lines.map((l) => [l.text, l.ink]);

/** What the Overview passes for these routes: the plan-wide readers, the
 *  levels in feet (no semicircular rule). */
const wxOf = (routes: Route[], taFt = Infinity): PlanWx => ({
	mean: plansMeanForecast(routes),
	facts: plansForecastFacts(routes),
	source: plansForecastSource(routes),
	taFt,
});

beforeEach(() => {
	vi.useFakeTimers({ toFake: ['Date'] });
	vi.setSystemTime(T0);
	fake.reset();
	resetWindAloftForTest();
	flightPrep.dossier.flightDate = '2026-10-02';
	flightPrep.dossier.departureTime = '10:00';
	i18n.locale = 'en';
});

afterEach(() => {
	pruneRouteWind([]);
	vi.useRealTimers();
	flightPrep.dossier.flightDate = null;
	flightPrep.dossier.departureTime = null;
	display.liveWeather = true;
	windAloft.useForecastForLegs = true;
	routeSettings.windDirDeg = null;
	routeSettings.windSpeedKt = null;
});

describe('the wind each trip flies', () => {
	it('is the forecast, its mean at its level, its temperatures and its source', async () => {
		const r = route(47, 48, 49);
		await ensureRouteWindFor(r);
		const basis = routeWindBasis(r);
		expect(basis.kind).toBe('forecast');
		// +5 at 925 hPa (800 m), +2 at 850 hPa (1500 m): ISA -4.8 at 3000 ft,
		// no freezing level under the ladder's top.
		expect(texts(overviewWindLines([{ route: r, basis }], wxOf([r])))).toEqual([
			['Mean forecast wind 250°/20 kt at 3000 ft', 'plain'],
			['ISA -5', 'plain'],
			[expect.stringMatching(/./), 'muted'],
		]);
	});

	it('names the legs the forecast misses and what they fly instead', async () => {
		const r = route(47, 48, 49, 50);
		fake.windAt = (i) => (i === 2 ? null : [250, 20]);
		await ensureRouteWindFor(r);
		// A leg without a forecast: no mean and no temperatures, which hold
		// only for the whole plan.
		expect(texts(overviewWindLines([{ route: r, basis: routeWindBasis(r) }], wxOf([r])))).toEqual([
			['Forecast winds', 'plain'],
			['Leg 3 without a forecast, still air', 'manual'],
			[expect.stringMatching(/./), 'muted'],
		]);
		routeSettings.windDirDeg = 270;
		routeSettings.windSpeedKt = 15;
		expect(overviewWindLines([{ route: r, basis: routeWindBasis(r) }], wxOf([r]))[1]?.text).toBe(
			'Leg 3 without a forecast, manual wind 270°/15 kt',
		);
	});

	it('counts two missed legs of one trip, a line that fits its column on paper', async () => {
		const r = route(47, 48, 49, 50);
		fake.windAt = (i) => (i === 0 || i === 2 ? null : [250, 20]);
		routeSettings.windDirDeg = 270;
		routeSettings.windSpeedKt = 15;
		await ensureRouteWindFor(r);
		const basis = routeWindBasis(r);
		expect(basis.kind === 'forecast' ? basis.missed : null).toEqual([1, 3]);
		expect(overviewWindLines([{ route: r, basis }], wxOf([r]))[1]).toEqual({
			text: '2 legs without a forecast, manual wind 270°/15 kt',
			ink: 'manual',
		});
		i18n.locale = 'fr';
		expect(overviewWindLines([{ route: r, basis }], wxOf([r]))[1]?.text).toBe(
			'2 segments sans prévision, vent manuel 270°/15 kt',
		);
		routeSettings.windDirDeg = null;
		routeSettings.windSpeedKt = null;
		expect(overviewWindLines([{ route: r, basis: routeWindBasis(r) }], wxOf([r]))[1]?.text).toBe(
			'2 segments sans prévision, calcul sans vent',
		);
	});

	it('is the manual wind, the forecast still giving its temperatures and their source', async () => {
		const r = route(47, 48, 49);
		windAloft.useForecastForLegs = false;
		routeSettings.windDirDeg = 90;
		routeSettings.windSpeedKt = 10;
		await ensureRouteWindFor(r);
		const basis = routeWindBasis(r);
		expect(basis.kind).toBe('manual');
		if (basis.kind === 'manual') {
			// Northbound: the 250/20 forecast pushes from behind (about 7 kt of
			// tailwind), the easterly 10 kt is all crosswind. The forecast
			// would make the trip shorter.
			expect(basis.forecastDeltaMin).toBeLessThan(0);
		}
		expect(texts(overviewWindLines([{ route: r, basis }], wxOf([r])))).toEqual([
			['Wind 090°/10 kt manual', 'manual'],
			['ISA -5', 'plain'],
			[expect.stringMatching(/./), 'muted'],
		]);
		// Live weather off: nothing of the forecast.
		display.liveWeather = false;
		expect(texts(overviewWindLines([{ route: r, basis: routeWindBasis(r) }], wxOf([r])))).toEqual([
			['Wind 090°/10 kt manual', 'manual'],
		]);
	});

	it('takes the freezing level off the held forecast, inked where a leg flies into it', async () => {
		// +3 at 800 m, -4 at 1500 m: freezing at 1100 m, 3609 ft.
		fake.temps = [3, -4];
		const r = route(47, 48, 49);
		r.waypoints[1].alt = 4500;
		await ensureRouteWindFor(r);
		const line = overviewWindLines([{ route: r, basis: routeWindBasis(r) }], wxOf([r]))[1];
		expect(line?.text).toMatch(/^ISA -\d+, freezing level down to 3600 ft$/);
		expect(line?.parts?.at(-1)?.ink).toBe('manual');
		// Both legs under it now: the altitude edit re-reads the held columns.
		r.waypoints[1].alt = 3000;
		expect(overviewWindLines([{ route: r, basis: routeWindBasis(r) }], wxOf([r]))[1]?.parts?.at(-1)?.ink).toBe('plain');
	});

	it('is still air when nothing is known, said once for several trips', () => {
		const a = route(47, 48);
		const b = route(48, 49);
		windAloft.useForecastForLegs = false;
		const lines = overviewWindLines(
			[
				{ route: a, basis: routeWindBasis(a) },
				{ route: b, basis: routeWindBasis(b) },
			],
			wxOf([a, b]),
		);
		expect(texts(lines)).toEqual([['No wind known: still air', 'manual']]);
	});

	it('leads with the legs flying their own wind when the forecast flies none', async () => {
		const r = route(47, 48, 49);
		for (const w of r.waypoints.slice(0, -1)) {
			w.windDirDeg = 90;
			w.windSpeedKt = 15;
		}
		await ensureRouteWindFor(r);
		expect(texts(overviewWindLines([{ route: r, basis: routeWindBasis(r) }], wxOf([r])))).toEqual([
			['2 legs with a manual wind', 'manual'],
			['ISA -5', 'plain'],
			[expect.stringMatching(/./), 'muted'],
		]);
	});

	it('stays four lines at most for a plan of several trips: one mean, counted gaps', async () => {
		const a = route(47, 48, 49);
		const b = route(49, 48, 47);
		const c = route(47, 46);
		fake.windAt = (i) => (i === 0 ? null : [250, 20]);
		await Promise.all([ensureRouteWindFor(a), ensureRouteWindFor(b), ensureRouteWindFor(c)]);
		const trips = [a, b, c].map((r) => ({ route: r, basis: routeWindBasis(r) }));
		const lines = overviewWindLines(trips, wxOf([a, b, c]));
		// The first leg of each route has no forecast: no plan-wide mean, the
		// gaps counted across the trips, the source once.
		expect(texts(lines)).toEqual([
			['Forecast winds', 'plain'],
			['3 legs without a forecast, still air', 'manual'],
			[expect.stringMatching(/./), 'muted'],
		]);
		fake.windAt = () => [250, 20];
		const d = route(46, 45, 44);
		const e = route(44, 45);
		await Promise.all([ensureRouteWindFor(d), ensureRouteWindFor(e)]);
		const whole = overviewWindLines(
			[d, e].map((r) => ({ route: r, basis: routeWindBasis(r) })),
			wxOf([d, e]),
		);
		expect(texts(whole).slice(0, 2)).toEqual([
			['Mean forecast wind 250°/20 kt at 3000 ft', 'plain'],
			['ISA -5', 'plain'],
		]);
		expect(whole.length).toBe(3);
	});
});

/* The wording, from the plan's figures alone: the levels as the nav log
 * prints them (flight levels above the transition altitude under the
 * semicircular rule), French contracting "à le" and "de le". */
describe('the forecast beside the wind', () => {
	const basis: WindBasis = {
		kind: 'forecast',
		source: 'AROME 09:00Z 9 Oct',
		missed: [],
		missedWind: null,
		legs: 4,
		overrides: 0,
	};
	const r = route(47, 48);
	const wx = (o: Omit<Partial<PlanWx>, 'facts'> & { facts?: Partial<NonNullable<PlanWx['facts']>> }): PlanWx => ({
		mean: { kind: 'mean', dirDeg: 250, speedKt: 18 },
		source: 'AROME 09:00Z 9 Oct',
		taFt: 5000,
		...o,
		facts: { levels: { lowFt: 2500, highFt: 6500 }, isaDevC: 6, freezing: null, ...o.facts },
	});
	const at = (o: Parameters<typeof wx>[0]): string[][] => texts(overviewWindLines([{ route: r, basis }], wx(o)));

	it('states one level, else the range, in feet or as flight levels', () => {
		expect(at({})[0]?.[0]).toBe('Mean forecast wind 250°/18 kt, 2500 ft to FL 065');
		expect(at({ facts: { levels: { lowFt: 3500, highFt: 3500 } } })[0]?.[0]).toBe(
			'Mean forecast wind 250°/18 kt at 3500 ft',
		);
		expect(at({ taFt: Infinity })[0]?.[0]).toBe('Mean forecast wind 250°/18 kt, 2500 ft to 6500 ft');
		expect(at({ mean: { kind: 'varies' } })[0]?.[0]).toBe('Forecast wind varies, 2500 ft to FL 065');
		expect(at({ mean: { kind: 'light' }, facts: { levels: { lowFt: 6500, highFt: 6500 } } })[0]?.[0]).toBe(
			'Forecast wind light and variable at FL 065',
		);
		i18n.locale = 'fr';
		expect(at({})[0]?.[0]).toBe('Vent moyen prévu 250°/18 kt, de 2500 ft au FL 065');
		expect(at({ facts: { levels: { lowFt: 5500, highFt: 7500 } } })[0]?.[0]).toBe(
			'Vent moyen prévu 250°/18 kt, du FL 055 au FL 075',
		);
		expect(at({ facts: { levels: { lowFt: 6500, highFt: 6500 } } })[0]?.[0]).toBe('Vent moyen prévu 250°/18 kt au FL 065');
		expect(at({ facts: { levels: { lowFt: 3500, highFt: 3500 } } })[0]?.[0]).toBe('Vent moyen prévu 250°/18 kt à 3500 ft');
		expect(at({ taFt: Infinity })[0]?.[0]).toBe('Vent moyen prévu 250°/18 kt, de 2500 ft à 6500 ft');
	});

	it('states ISA and the lowest freezing level on one line, the freezing level inked where a leg reaches it', () => {
		const line = overviewWindLines(
			[{ route: r, basis }],
			wx({ facts: { freezing: { lowestFt: 4800, atOrBelow: false, reached: true } } }),
		)[1];
		expect(line?.text).toBe('ISA +6, freezing level down to 4800 ft');
		expect(line?.ink).toBe('plain');
		expect(line?.parts?.map((x) => [x.text, x.ink])).toEqual([
			['ISA +6', 'plain'],
			[', ', 'plain'],
			['freezing level down to 4800 ft', 'manual'],
		]);
		expect(at({ facts: { freezing: { lowestFt: 4800, atOrBelow: false, reached: false } } })[1]).toEqual([
			'ISA +6, freezing level down to 4800 ft',
			'plain',
		]);
		expect(at({ facts: { isaDevC: -0.4, freezing: { lowestFt: 1500, atOrBelow: true, reached: true } } })[1]?.[0]).toBe(
			'ISA +0, freezing level at or below 1500 ft',
		);
		expect(at({ facts: { isaDevC: null, freezing: { lowestFt: 4800, atOrBelow: false, reached: false } } })[1]?.[0]).toBe(
			'Freezing level down to 4800 ft',
		);
		expect(at({})[1]).toEqual(['ISA +6', 'plain']);
		i18n.locale = 'fr';
		expect(at({ facts: { freezing: { lowestFt: 4800, atOrBelow: false, reached: false } } })[1]?.[0]).toBe(
			'ISA +6, isotherme 0 °C au plus bas à 4800 ft',
		);
		expect(at({ facts: { freezing: { lowestFt: 1500, atOrBelow: true, reached: true } } })[1]?.[0]).toBe(
			'ISA +6, isotherme 0 °C à 1500 ft ou plus bas',
		);
		expect(at({ facts: { isaDevC: null, freezing: { lowestFt: 4800, atOrBelow: false, reached: false } } })[1]?.[0]).toBe(
			'Isotherme 0 °C au plus bas à 4800 ft',
		);
	});

	it('keeps four lines with legs flying their own wind', () => {
		const lines = overviewWindLines(
			[{ route: r, basis: { ...basis, overrides: 2 } }],
			wx({ facts: { freezing: { lowestFt: 4800, atOrBelow: false, reached: false } } }),
		);
		expect(texts(lines)).toEqual([
			['Mean forecast wind 250°/18 kt, 2500 ft to FL 065', 'plain'],
			['ISA +6, freezing level down to 4800 ft', 'plain'],
			['2 legs with a manual wind', 'manual'],
			['AROME 09:00Z 9 Oct', 'muted'],
		]);
	});
});

describe("the departure's QNH", () => {
	it('says where it comes from, a typed one standing out', () => {
		const now = Date.UTC(2026, 9, 2, 9, 0);
		const metar = { icaoId: 'LFPN', obsTime: Date.UTC(2026, 9, 2, 8, 30) / 1000 };
		expect(
			texts(
				departureQnhLines(
					{ icao: 'LFPN', hpa: 1028, typed: false, source: 'metar', pick: { kind: 'metar', pick: { metar, distanceM: 0 } as never } },
					now,
				),
			),
		).toEqual([
			['1028 hPa', 'plain'],
			['LFPN METAR 08:30Z', 'muted'],
		]);
		expect(texts(departureQnhLines({ icao: 'LFPN', hpa: 1020, typed: true, source: 'standard', pick: null }, now))).toEqual([
			['1020 hPa', 'manual'],
			['typed on the performance page', 'manual'],
		]);
		expect(departureQnhLines({ icao: 'LFPN', hpa: 1013, typed: false, source: 'standard', pick: null }, now)[1]?.text).toBe(
			'standard, no METAR or forecast',
		);
		expect(departureQnhLines(null, now)).toEqual([{ text: '—', ink: 'muted' }]);
	});
});
