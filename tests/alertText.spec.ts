/* The alert line (components/alertText.ts alertLine, alertAnnounce): one
 * sentence, its parts joined by commas, an active zone's period said at the
 * playhead, an instant on another UTC day with its date, in both languages. */

import { afterEach, describe, expect, it } from 'vitest';
import { alertAnnounce, alertLine } from '$lib/components/alertText';
import { NO_ENTRY } from '$lib/data/airspaceEntry';
import type { VolumeAlert } from '$lib/nav/airspaceAlert';
import { zsmVolumes, type AlertVolume } from '$lib/nav/alertVolumes';
import { fmtDayMonth, i18n } from '$lib/state/i18n.svelte';
import { nav } from '$lib/state/navRecording.svelte';

const T = Date.UTC(2026, 11, 3, 10, 0); // Thursday 3 December 2026, 10:00Z
const H = 3_600_000;

const VOLUME: AlertVolume = {
	key: 'metropole-2025-094#0',
	id: 'metropole-2025-094#0',
	name: 'ZRT DSV ROMORANTIN ALPHA',
	source: 'supaip',
	publisher: 'fr',
	rings: [],
	circles: [],
	bbox: { minLat: 0, minLon: 0, maxLat: 1, maxLon: 1 },
	vLower: null,
	vUpper: null,
	knownExtent: true,
	extent: 'known',
	type: '',
	airClass: '',
	category: '',
	rtba: false,
	entry: NO_ENTRY,
	qSubject: '',
	supKind: 'zrt',
	supRule: 'circumvent',
	supIfrOnly: false,
	radios: [],
	knownFrom: [],
	activity: { rules: [{ mode: 'firm' }] },
} as unknown as AlertVolume;

// 153/2026's ZRT BLOIS, "Activable de SR à SS-1HR", activity known on
// BLOIS INFO.
const BLOIS: AlertVolume = {
	...VOLUME,
	key: 'metropole-2026-153#0',
	id: 'metropole-2026-153#0',
	name: 'ZRT BLOIS',
	knownFrom: [{ unit: 'BLOIS INFO', freq: '118.455', phone: null }],
};

function alert(over: Partial<VolumeAlert>): VolumeAlert {
	return {
		subject: 'volume',
		key: VOLUME.key,
		volume: VOLUME,
		action: 'avoid',
		severity: 'inside',
		etaSec: null,
		distNM: null,
		activityState: 'active',
		window: null,
		coveredBy: null,
		verticalGap: false,
		gapSide: null,
		gapClosing: false,
		planned: false,
		altUnknown: false,
		extentUnknown: false,
		acked: false,
		...over,
	};
}

describe('alertLine', () => {
	afterEach(() => {
		i18n.locale = 'en';
	});
	nav.playheadMs = T;

	it('joins its parts by commas, the caveat in parentheses', () => {
		expect(alertLine(alert({ altUnknown: true }))).toBe('In ZRT DSV ROMORANTIN ALPHA, entry prohibited (altitude unknown)');
		expect(alertAnnounce(alert({}))).toBe('In ZRT DSV ROMORANTIN ALPHA, entry prohibited');
		expect(alertLine(alert({ severity: 'approaching', etaSec: 240, action: 'caution' }))).toBe(
			'ZRT DSV ROMORANTIN ALPHA in 4 min, caution',
		);
	});

	it('says until when a period in force runs, its date where it ends another day', () => {
		const today = { startMs: T - 2 * H, endMs: T + 5 * H };
		expect(alertLine(alert({ window: today }))).toBe('In ZRT DSV ROMORANTIN ALPHA, entry prohibited, active until 15:00Z');
		// A period of whole days, the validity's: ends at a midnight days away,
		// its day and month held by the narrow no-break space (formatDayMonth).
		const days = { startMs: Date.UTC(2026, 11, 1), endMs: Date.UTC(2026, 11, 9) };
		expect(alertLine(alert({ window: days }))).toBe(
			'In ZRT DSV ROMORANTIN ALPHA, entry prohibited, active until 9\u202fDec 00:00Z',
		);
	});

	it('says from when to when a period that begins later runs, its days where it runs on others', () => {
		const later = { startMs: T + 2 * H, endMs: T + 4 * H };
		expect(alertLine(alert({ severity: 'approaching', etaSec: 300, window: later }))).toBe(
			'ZRT DSV ROMORANTIN ALPHA in 5 min, entry prohibited, active from 12:00Z to 14:00Z',
		);
		const tomorrow = { startMs: T + 24 * H, endMs: T + 26 * H };
		const night = { startMs: T + 12 * H, endMs: T + 19 * H };
		const day = (ms: number) => fmtDayMonth(new Date(ms).toISOString().slice(0, 10));
		expect(alertLine(alert({ severity: 'approaching', etaSec: 300, window: tomorrow }))).toBe(
			`ZRT DSV ROMORANTIN ALPHA in 5 min, entry prohibited, active on ${day(T + 24 * H)} from 10:00Z to 12:00Z`,
		);
		expect(alertLine(alert({ severity: 'approaching', etaSec: 300, window: night }))).toBe(
			`ZRT DSV ROMORANTIN ALPHA in 5 min, entry prohibited, active from ${day(T)} 22:00Z to ${day(T + 19 * H)} 05:00Z`,
		);
		i18n.locale = 'fr';
		expect(alertLine(alert({ severity: 'approaching', etaSec: 300, window: night }))).toBe(
			`ZRT DSV ROMORANTIN ALPHA dans 5 min, pénétration interdite, active du ${day(T)} 22:00Z au ${day(T + 19 * H)} 05:00Z`,
		);
		i18n.locale = 'en';
	});

	it('says a zone that may be active does so, until when, and who knows', () => {
		const sun = { startMs: T - 2 * H, endMs: Date.UTC(2026, 11, 3, 15, 16) };
		const may = (over: Partial<VolumeAlert>) =>
			alert({ volume: BLOIS, key: BLOIS.key, severity: 'approaching', etaSec: 240, action: 'caution', activityState: 'activable', ...over });
		expect(alertLine(may({ window: sun }))).toBe(
			'ZRT BLOIS in 4 min, may be active until 15:16Z, activity known on BLOIS INFO 118.455',
		);
		expect(alertLine(may({}))).toBe('ZRT BLOIS in 4 min, may be active, activity known on BLOIS INFO 118.455');
		expect(alertAnnounce(may({ window: sun }))).toBe('ZRT BLOIS nearby, may be active');
		// A telephone alone says so; a stronger action stays beside it.
		const phone: AlertVolume = { ...BLOIS, knownFrom: [{ unit: 'OPS', freq: null, phone: '01 73 95 24 02' }] };
		expect(alertLine(may({ volume: phone, window: sun }))).toBe(
			'ZRT BLOIS in 4 min, may be active until 15:16Z, activity known by telephone',
		);
		expect(alertLine(may({ action: 'radio', window: sun, volume: { ...BLOIS, knownFrom: [] } }))).toBe(
			'ZRT BLOIS in 4 min, radio mandatory, may be active until 15:16Z',
		);
	});

	it('reads the same in French', () => {
		i18n.locale = 'fr';
		const days = { startMs: Date.UTC(2026, 11, 1), endMs: Date.UTC(2026, 11, 9) };
		expect(alertLine(alert({ window: days, altUnknown: true }))).toBe(
			'Dans ZRT DSV ROMORANTIN ALPHA, pénétration interdite, active jusqu’au 9\u202fdéc. 00:00Z (altitude inconnue)',
		);
		const later = { startMs: T + 2 * H, endMs: T + 4 * H };
		expect(alertLine(alert({ severity: 'approaching', etaSec: 300, window: later }))).toBe(
			'ZRT DSV ROMORANTIN ALPHA dans 5 min, pénétration interdite, active de 12:00Z à 14:00Z',
		);
		const sun = { startMs: T - 2 * H, endMs: Date.UTC(2026, 11, 3, 15, 16) };
		const may = alert({ volume: BLOIS, key: BLOIS.key, severity: 'approaching', etaSec: 240, action: 'caution', activityState: 'activable', window: sun });
		expect(alertLine(may)).toBe('ZRT BLOIS dans 4 min, activable jusqu’à 15:16Z, activité connue de BLOIS INFO 118.455');
	});

	it('asks to avoid a raptor zone or overfly it at its height', () => {
		const [rompeau] = zsmVolumes([
			{ id: 'zsm:5991', name: 'Le Rompeau', species: 'Gypaète barbu', taxon: '2852', active: true, topM: 2110, overflyM: 3110, modified: '2026-10-31', ring: [], bbox: { minLat: 0, minLon: 0, maxLat: 0, maxLon: 0 }, areaM2: 0 },
		]);
		const z = alert({ volume: rompeau, key: rompeau.key, severity: 'approaching', etaSec: 240, action: 'caution' });
		expect(alertLine(z)).toBe('ZSM Le Rompeau in 4 min, avoid or overfly above 10\u202f210\u202fft (3\u202f110\u202fm)');
		i18n.locale = 'fr';
		expect(alertLine(z)).toBe('ZSM Le Rompeau dans 4 min, à contourner ou survoler au-dessus de 10\u202f210\u202fft (3\u202f110\u202fm)');
	});
});
