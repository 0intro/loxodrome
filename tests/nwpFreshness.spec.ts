/* How a column of our service's is judged still the forecast
 * (state/windAloft.svelte.ts columnStamp over weather/forecastCache.ts):
 * by x_latest, the newest run of each model the service held when it
 * answered, never by x_runs, the run that served (an older run serves what
 * the newest does not reach, and judged by it the column read stale on
 * landing and was asked again every minute); a run published whole a second
 * after its truncated publication outdates a column taken meanwhile; an
 * answer stating no runs at all anchors nothing. The clock is pinned to the
 * cases' own NOW: columnStamp reads Date.now() by default, and once the real
 * day had moved past these hours they read as final, every stale case
 * passing for current (2026-10-08). */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { memoryStorage } from './helpers/storage';

vi.stubGlobal('localStorage', memoryStorage());

const { normalizeForecast } = await import('$lib/weather/openMeteo');
const w = await import('$lib/state/windAloft.svelte');

const HOUR = 3600_000;
const IFS00 = Date.UTC(2026, 9, 7, 0) / 1000;
const IFS06 = Date.UTC(2026, 9, 7, 6) / 1000;
const NOW = Date.UTC(2026, 9, 7, 13);
const PARIS = { lat: 48.85, lon: 2.35 };

function answer(extra: Record<string, unknown>) {
	return normalizeForecast(
		{ latitude: PARIS.lat, longitude: PARIS.lon, elevation: 50, hourly: { time: [NOW / 1000], wind_speed_850hPa: [20] }, ...extra },
		'nwp',
	)[0];
}

beforeEach(() => {
	vi.useFakeTimers({ toFake: ['Date'] });
	vi.setSystemTime(NOW);
	w.resetWindAloftForTest();
});

afterEach(() => {
	vi.useRealTimers();
});

describe('a column of ours', () => {
	it('reads x_latest beside x_runs, in milliseconds', () => {
		const col = answer({ x_runs: { ifs025: IFS00 + 1 }, x_latest: { ifs025: IFS06 + 1 } });
		expect(col.runs).toEqual({ ifs025: (IFS00 + 1) * 1000 });
		expect(col.latest).toEqual({ ifs025: (IFS06 + 1) * 1000 });
	});

	it('served by an older run than the newest is current against the newest, not asked again every minute', () => {
		// A flight a week out: IFS 06Z stops at +144 h, 00Z serves on.
		const col = answer({ x_runs: { ifs025: IFS00 + 1 }, x_latest: { ifs025: IFS06 + 1 } });
		w.noteRuns([col]);
		const stamp = w.columnStamp(col, 'auto_chain', {});
		expect(w.stampIsCurrent(stamp, NOW, 'auto_chain', [PARIS], NOW + 60_000)).toBe(true);
		// Judged by the run that served, the same column read stale at once.
		const byServed = w.columnStamp({ ...col, latest: null }, 'auto_chain', {});
		expect(w.stampIsCurrent(byServed, NOW, 'auto_chain', [PARIS], NOW + 60_000)).toBe(false);
	});

	it('is outdated when the run it was taken under, truncated, is published whole', () => {
		const col = answer({ x_runs: { ifs025: IFS00 + 1 }, x_latest: { ifs025: IFS06 } });
		w.noteRuns([col]);
		const stamp = w.columnStamp(col, 'auto_chain', {});
		expect(w.stampIsCurrent(stamp, NOW, 'auto_chain', [PARIS], NOW + HOUR)).toBe(true);
		// The whole publication, a second after the truncated one.
		w.noteRuns([answer({ x_runs: { ifs025: IFS06 + 1 }, x_latest: { ifs025: IFS06 + 1 } })]);
		expect(w.stampIsCurrent(stamp, NOW, 'auto_chain', [PARIS], NOW + HOUR)).toBe(false);
	});

	it('of hours well behind us is final whoever answered: no replay asked again every hour', () => {
		const old = NOW - 8 * 24 * HOUR;
		const om = normalizeForecast({ latitude: PARIS.lat, longitude: PARIS.lon, elevation: 50, hourly: { time: [old / 1000], wind_speed_850hPa: [20] } }, 'open-meteo')[0];
		const stamp = w.columnStamp(om, 'auto_chain', {}, NOW);
		expect(w.stampIsCurrent(stamp, NOW, 'auto_chain', [PARIS], NOW + 48 * HOUR)).toBe(true);
		// An Open-Meteo column of hours ahead still ages out.
		const live = normalizeForecast({ latitude: PARIS.lat, longitude: PARIS.lon, elevation: 50, hourly: { time: [(NOW + HOUR) / 1000], wind_speed_850hPa: [20] } }, 'open-meteo')[0];
		const fresh = w.columnStamp(live, 'auto_chain', {}, NOW);
		expect(w.stampIsCurrent(fresh, NOW, 'auto_chain', [PARIS], NOW + 2 * HOUR)).toBe(false);
	});

	it('stating no runs at all anchors nothing, where an empty x_runs is final', () => {
		const none = answer({});
		expect(none.runs).toBeNull();
		const unanchored = w.columnStamp(none, 'auto_chain', {});
		expect(w.stampIsCurrent(unanchored, NOW, 'auto_chain', [PARIS], NOW + 2 * HOUR)).toBe(false);
		const past = answer({ x_runs: {}, x_latest: {} });
		const final = w.columnStamp(past, 'auto_chain', {});
		expect(w.stampIsCurrent(final, NOW, 'auto_chain', [PARIS], NOW + 48 * HOUR)).toBe(true);
	});
});
