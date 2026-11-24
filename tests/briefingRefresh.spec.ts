/* When the app fetches the briefing for the planned flight on its own
 * (notam/briefingRefresh.ts). A run is due only through every gate, after
 * the plan has held still, the spacing since the last run and the backoff
 * since a failure, and only when a fetch would cure a reason of the verdict
 * or refresh an old briefing the pilot is using. On Android, the RTBA
 * release the verdict waits for is the reminder's instant. */

import { describe, expect, it } from 'vitest';
import {
	ACTIVE_MS,
	BACKOFF_CAP_MS,
	IDLE_AGE_MS,
	SPACING_MS,
	STILL_MS,
	backoffMs,
	fetchCures,
	noticeShown,
	leftStanding,
	refreshDue,
	reminderDue,
	type NoticeInput,
	type RefreshInput,
} from '$lib/notam/briefingRefresh';

const MIN = 60_000;
const NOW = Date.UTC(2026, 10, 24, 15, 0);

/** Every gate open, the plan long still, no run yet, and no briefing. */
function input(over: Partial<RefreshInput> = {}): RefreshInput {
	return {
		nowMs: NOW,
		enabled: true,
		restored: true,
		sourceReady: true,
		visible: true,
		online: true,
		busy: false,
		onGround: true,
		replaceable: true,
		planSig: 'p1',
		planSigSinceMs: 0,
		lastRunMs: null,
		failures: 0,
		failedMs: null,
		reasons: [{ code: 'none' }],
		ageMs: null,
		activeMs: null,
		left: null,
		day: '2026-11-24',
		source: 'sofia',
		...over,
	};
}

describe('the gates', () => {
	it('runs with every gate open and a reason to cure', () => {
		expect(refreshDue(input())).toEqual({ due: true, wakeMs: null });
	});

	const shut: [string, Partial<RefreshInput>][] = [
		['the switch off', { enabled: false }],
		['the plan not restored yet', { restored: false }],
		['a source that cannot brief the plan', { sourceReady: false }],
		['a hidden page', { visible: false }],
		['offline', { online: false }],
		['a fetch or a print going on', { busy: true }],
		['in the air', { onGround: false }],
		['a bulletin by hand, a map view or a typed period loaded', { replaceable: false }],
		['nothing to cure', { reasons: [] }],
	];
	for (const [name, over] of shut) {
		it(`waits for a change of state with ${name}`, () => {
			expect(refreshDue(input(over))).toEqual({ due: false, wakeMs: null });
		});
	}
});

describe('the pacing', () => {
	it('waits for the plan to hold still', () => {
		const since = NOW - 5_000;
		expect(refreshDue(input({ planSigSinceMs: since }))).toEqual({ due: false, wakeMs: since + STILL_MS });
	});

	it('leaves the spacing after the last run', () => {
		const last = NOW - MIN;
		expect(refreshDue(input({ lastRunMs: last }))).toEqual({ due: false, wakeMs: last + SPACING_MS });
		expect(refreshDue(input({ lastRunMs: NOW - SPACING_MS })).due).toBe(true);
	});

	it('backs off 1, 2, 4 and 8 min after failures, then every 15', () => {
		expect([1, 2, 3, 4, 5, 9].map(backoffMs)).toEqual([MIN, 2 * MIN, 4 * MIN, 8 * MIN, BACKOFF_CAP_MS, BACKOFF_CAP_MS]);
		const failed = NOW - 3 * MIN;
		expect(refreshDue(input({ failures: 3, failedMs: failed, lastRunMs: failed }))).toEqual({
			due: false,
			wakeMs: failed + 4 * MIN,
		});
		expect(refreshDue(input({ failures: 2, failedMs: failed, lastRunMs: failed })).due).toBe(true);
	});

	it('retries a minute after the first failure, the backoff pacing it in the spacing’s place', () => {
		const failed = NOW - MIN;
		expect(refreshDue(input({ failures: 1, failedMs: failed, lastRunMs: failed })).due).toBe(true);
		expect(refreshDue(input({ failures: 1, failedMs: NOW - 59_000, lastRunMs: NOW - 59_000 }))).toEqual({
			due: false,
			wakeMs: NOW + 1_000,
		});
	});

	it('waits for the latest of the three', () => {
		const d = refreshDue(input({ planSigSinceMs: NOW - 1_000, lastRunMs: NOW - MIN, failures: 4, failedMs: NOW - MIN }));
		expect(d).toEqual({ due: false, wakeMs: NOW - MIN + 8 * MIN });
	});
});

describe('what a fetch cures', () => {
	const left = { sig: 'p1', day: '2026-11-24', source: 'sofia', codes: ['failed'] };

	it('asks once for a reason the last run left standing', () => {
		const failed = { code: 'failed' as const, labels: ['LFPN-LFOZ'], total: 1 };
		expect(refreshDue(input({ reasons: [failed], left })).due).toBe(false);
		// Another plan, another day or another source asks again.
		expect(refreshDue(input({ reasons: [failed], left: { ...left, sig: 'p2' } })).due).toBe(true);
		expect(refreshDue(input({ reasons: [failed], left: { ...left, day: '2026-11-25' } })).due).toBe(true);
		expect(refreshDue(input({ reasons: [failed], left: { ...left, source: 'autorouter' } })).due).toBe(true);
		// And the briefing growing old asks again through its age.
		const age = { code: 'age' as const, at: NOW - 4 * 60 * MIN, ageMs: 4 * 60 * MIN };
		expect(refreshDue(input({ reasons: [failed, age], left })).due).toBe(true);
	});

	it('waits for the RTBA release before asking for it', () => {
		const rtba = (releaseMs: number) => ({ code: 'rtba' as const, dayMs: Date.UTC(2026, 10, 25), releaseMs });
		expect(refreshDue(input({ reasons: [rtba(NOW + MIN)] })).due).toBe(false);
		expect(refreshDue(input({ reasons: [rtba(NOW - MIN)] })).due).toBe(true);
		// A print and the Fly tap ask the same, past what a run left standing.
		expect(fetchCures([rtba(NOW + MIN)], NOW)).toBe(false);
		expect(fetchCures([rtba(NOW)], NOW)).toBe(true);
		expect(fetchCures([rtba(NOW + MIN), { code: 'none' }], NOW)).toBe(true);
		expect(fetchCures([], NOW)).toBe(false);
	});

	it('refreshes a briefing past half an hour while the pilot uses the app', () => {
		const old = { reasons: [], ageMs: IDLE_AGE_MS + MIN };
		expect(refreshDue(input({ ...old, activeMs: NOW - ACTIVE_MS })).due).toBe(true);
		expect(refreshDue(input({ ...old, activeMs: NOW - ACTIVE_MS - 1 })).due).toBe(false);
		expect(refreshDue(input({ ...old, activeMs: null })).due).toBe(false);
		expect(refreshDue(input({ reasons: [], ageMs: IDLE_AGE_MS, activeMs: NOW })).due).toBe(false);
	});
});

describe('the map notice', () => {
	const notice = (over: Partial<NoticeInput> = {}): boolean =>
		noticeShown({
			phase: 'ground',
			reasons: [{ code: 'none' }],
			curing: false,
			running: false,
			enabled: true,
			planStill: true,
			...over,
		});

	it('says nothing while the briefing covers the flight, or in the air', () => {
		expect(notice({ reasons: [] })).toBe(false);
		expect(notice({ phase: 'air' })).toBe(false);
	});

	it('leaves the ground to the app while it cures the reason itself', () => {
		expect(notice({ curing: true })).toBe(false);
		expect(notice({ running: true })).toBe(false);
		expect(notice({ curing: false })).toBe(true);
	});

	it('with the switch off, waits for the plan to hold still', () => {
		expect(notice({ enabled: false, planStill: false })).toBe(false);
		expect(notice({ enabled: false, planStill: true })).toBe(true);
	});

	it('from the start of a recording to the takeoff, stands while any reason does', () => {
		expect(notice({ phase: 'departing', curing: true, running: true })).toBe(true);
		expect(notice({ phase: 'departing', reasons: [] })).toBe(false);
	});
});

describe('the reminder at the RTBA release', () => {
	const DAY = Date.UTC(2026, 10, 25);
	const RELEASE = Date.UTC(2026, 10, 24, 17, 30);
	const rtba = { code: 'rtba', dayMs: DAY, releaseMs: RELEASE } as const;
	const age = { code: 'age', at: NOW - 4 * 60 * MIN, ageMs: 4 * 60 * MIN } as const;

	it('is set for the release of the day the verdict waits for, and stays past it', () => {
		expect(reminderDue({ ...input({ reasons: [age, rtba] }), planned: true })).toEqual({ atMs: RELEASE, dayMs: DAY });
		expect(reminderDue({ ...input({ reasons: [rtba] }), planned: true })).toEqual({ atMs: RELEASE, dayMs: DAY });
	});

	it('is taken back with the reason, or where the app would not fetch by itself', () => {
		expect(reminderDue({ ...input({ reasons: [age] }), planned: true })).toBeNull();
		// A recording, or a planned window behind us: the verdict's window rolls.
		expect(reminderDue({ ...input({ reasons: [rtba] }), planned: false })).toBeNull();
		for (const over of [{ enabled: false }, { sourceReady: false }, { replaceable: false }]) {
			expect(reminderDue({ ...input({ ...over, reasons: [rtba] }), planned: true }), JSON.stringify(over)).toBeNull();
		}
	});
});

describe('what a run leaves standing', () => {
	const RELEASE = Date.UTC(2026, 10, 24, 17, 30);
	const rtba = { code: 'rtba', dayMs: Date.UTC(2026, 10, 25), releaseMs: RELEASE } as const;
	const route = { code: 'route' as const, labels: ['LFPN-LFOZ'], at: NOW, cause: 'track' as const };

	it('is what a fetch could have cured, so the RTBA release starts a run that day', () => {
		const at = Date.UTC(2026, 10, 24, 14, 0);
		const codes = leftStanding([route, rtba], at);
		expect(codes).toEqual(['route']);
		const left = { sig: 'p1', day: '2026-11-24', source: 'sofia', codes };
		const after = input({ nowMs: RELEASE + 60_000, reasons: [rtba], left, lastRunMs: at, ageMs: RELEASE + 60_000 - at });
		expect(refreshDue(after)).toEqual({ due: true, wakeMs: null });
		expect(refreshDue({ ...after, reasons: [route] })).toEqual({ due: false, wakeMs: null });
	});
});

describe('what the pilot stopped or cleared', () => {
	it('holds every run for its plan, day and source, the age with the pilot about included', () => {
		const left = { sig: 'p1', day: '2026-11-24', source: 'sofia', codes: [], held: true };
		const held = input({ left, ageMs: 2 * 60 * MIN, activeMs: NOW });
		expect(refreshDue(held)).toEqual({ due: false, wakeMs: null });
		expect(refreshDue({ ...held, planSig: 'p2' }).due).toBe(true);
		expect(refreshDue({ ...held, day: '2026-11-25' }).due).toBe(true);
		expect(refreshDue({ ...held, source: 'autorouter' }).due).toBe(true);
	});
});
