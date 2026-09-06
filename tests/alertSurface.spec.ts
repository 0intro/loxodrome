import { describe, expect, it } from 'vitest';
import { alertSurface, type AlertSurfaceInput } from '../src/lib/nav/alertSurface';
import type { VolumeAlert } from '../src/lib/nav/airspaceAlert';
import type { AlertVolume } from '../src/lib/nav/alertVolumes';

/* The fold never reads `volume`; a placeholder keeps the literals lean. */
const VOL = {} as AlertVolume;

function al(key: string, over: Partial<VolumeAlert> = {}): VolumeAlert {
	return {
		key,
		volume: VOL,
		action: 'avoid',
		severity: 'approaching',
		etaSec: 120,
		distNM: 4,
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

function input(over: Partial<AlertSurfaceInput> = {}): AlertSurfaceInput {
	return {
		alerts: [],
		suspended: null,
		gaps: null,
		stopPending: false,
		stale: false,
		prevOrder: [],
		...over,
	};
}

describe('banner and badge', () => {
	it('puts the dominant unacked alert on the banner and counts the split', () => {
		const m = alertSurface(
			input({
				alerts: [
					al('ctr', { action: 'clearance', severity: 'inside' }),
					al('r1', { severity: 'approaching' }),
					al('d1', { action: 'caution', severity: 'inside', acked: true }),
				],
			}),
		);
		expect(m.banner?.key).toBe('r1');
		expect(m.badge).toEqual({ unacked: 2, acked: 1 });
		expect(m.panel.active.map((a) => a.key)).toEqual(['r1', 'ctr']);
		expect(m.panel.acked.map((a) => a.key)).toEqual(['d1']);
		expect(m.regions).toEqual(['banner']);
	});

	it('counts a planned unacked alert as unacked, demoted between equipment and caution', () => {
		const m = alertSurface(
			input({
				alerts: [
					al('p', { action: 'clearance', severity: 'imminent', planned: true }),
					al('d', { action: 'caution', severity: 'proximity' }),
					al('rmz', { action: 'radio', severity: 'imminent' }),
				],
			}),
		);
		expect(m.badge).toEqual({ unacked: 3, acked: 0 });
		expect(m.order).toEqual(['rmz', 'p', 'd']);
		expect(m.banner?.key).toBe('rmz');
	});

	it('collapses the banner when every alert is acknowledged', () => {
		const m = alertSurface(
			input({
				alerts: [al('a', { acked: true }), al('b', { acked: true })],
			}),
		);
		expect(m.banner).toBeNull();
		expect(m.regions).toEqual([]);
		expect(m.badge).toEqual({ unacked: 0, acked: 2 });
		expect(m.chip).toEqual({ kind: 'acked', ink: 'muted', solid: false });
		expect(m.panel.acked.map((a) => a.key)).toEqual(['a', 'b']);
	});

	it('re-enters the banner when an acknowledged alert escalates back', () => {
		const first = alertSurface(
			input({ alerts: [al('r1', { acked: true }), al('r2', { acked: true })] }),
		);
		expect(first.banner).toBeNull();
		const second = alertSurface(
			input({
				alerts: [al('r1', { severity: 'imminent' }), al('r2', { acked: true })],
				prevOrder: first.order,
			}),
		);
		expect(second.banner?.key).toBe('r1');
		expect(second.chip?.kind).toBe('alerts');
	});
});

describe('the chip', () => {
	it('wears the dominant ink, solid only for the unplanned inside form', () => {
		const avoid = alertSurface(input({ alerts: [al('r', { severity: 'inside' })] }));
		expect(avoid.chip).toEqual({ kind: 'alerts', ink: 'danger', solid: true });
		const ahead = alertSurface(input({ alerts: [al('r')] }));
		expect(ahead.chip).toEqual({ kind: 'alerts', ink: 'danger', solid: false });
		const contact = alertSurface(
			input({ alerts: [al('ctr', { action: 'clearance', severity: 'imminent' })] }),
		);
		expect(contact.chip).toEqual({ kind: 'alerts', ink: 'alert', solid: false });
		const planned = alertSurface(
			input({ alerts: [al('ctr', { action: 'clearance', severity: 'inside', planned: true })] }),
		);
		expect(planned.chip).toEqual({ kind: 'alerts', ink: 'alert', solid: false });
		const caution = alertSurface(
			input({ alerts: [al('d', { action: 'caution', severity: 'inside' })] }),
		);
		expect(caution.chip).toEqual({ kind: 'alerts', ink: 'caution', solid: true });
	});

	it('raises no chip over a bare data gap: the line and the tab carry it', () => {
		const noAirspaces = alertSurface(input({ gaps: { airspaces: true, briefing: true } }));
		expect(noAirspaces.chip).toBeNull();
		expect(noAirspaces.regions).toEqual(['gapLine']);
		expect(noAirspaces.panel.caveats).toEqual(['airspaces', 'briefing']);
		const noBriefing = alertSurface(input({ gaps: { airspaces: false, briefing: true } }));
		expect(noBriefing.chip).toBeNull();
		expect(noBriefing.regions).toEqual([]);
		expect(noBriefing.panel.caveats).toEqual(['briefing']);
	});

	it('is null whenever nothing alerts and nothing is suspended', () => {
		expect(alertSurface(input()).chip).toBeNull();
	});
});

describe('suspension', () => {
	it('replaces the banner and subsumes the quality note', () => {
		const m = alertSurface(input({ suspended: 'lost', stale: true }));
		expect(m.banner).toBeNull();
		expect(m.suspended).toBe('lost');
		expect(m.chip).toEqual({ kind: 'suspended', ink: 'danger', solid: false });
		expect(m.regions).toEqual(['suspended']);
	});

	it('dresses the acquiring form calm: danger is for a position that was live', () => {
		const m = alertSurface(input({ suspended: 'noFix' }));
		expect(m.chip).toEqual({ kind: 'suspended', ink: 'alert', solid: false });
		expect(m.regions).toEqual(['suspended']);
	});

	it('keeps the no-evaluation line beside the suspension', () => {
		const m = alertSurface(input({ suspended: 'noFix', gaps: { airspaces: true, briefing: false } }));
		expect(m.chip?.kind).toBe('suspended');
		expect(m.regions).toEqual(['suspended', 'gapLine']);
	});
});

describe('regions', () => {
	it('keeps the no-evaluation caveat beside a NOTAM-volume banner', () => {
		const m = alertSurface(
			input({
				alerts: [al('notam1')],
				gaps: { airspaces: true, briefing: false },
			}),
		);
		expect(m.regions).toEqual(['banner', 'gapLine']);
	});

	it('orders the stop countdown after the banner slot and the quality note last', () => {
		const under = alertSurface(
			input({ alerts: [al('r')], stopPending: true, stale: true }),
		);
		expect(under.regions).toEqual(['banner', 'stopSoon', 'quality']);
		const bare = alertSurface(input({ stopPending: true, stale: true }));
		expect(bare.regions).toEqual(['stopSoon', 'quality']);
		const susp = alertSurface(input({ suspended: 'lost', stopPending: true, stale: true }));
		expect(susp.regions).toEqual(['suspended', 'stopSoon']);
	});
});

describe('the hidden-strip escape', () => {
	it('escapes avoid at any severity and every tier once imminent, never planned', () => {
		expect(alertSurface(input({ alerts: [al('r')] })).bannerEscapes).toBe(true);
		expect(
			alertSurface(input({ alerts: [al('c', { action: 'clearance', severity: 'imminent' })] }))
				.bannerEscapes,
		).toBe(true);
		expect(
			alertSurface(input({ alerts: [al('c', { action: 'clearance', severity: 'approaching' })] }))
				.bannerEscapes,
		).toBe(false);
		expect(
			alertSurface(input({ alerts: [al('d', { action: 'caution', severity: 'inside' })] }))
				.bannerEscapes,
		).toBe(true);
		expect(
			alertSurface(input({ alerts: [al('r', { planned: true, severity: 'inside' })] }))
				.bannerEscapes,
		).toBe(false);
	});
});

describe('order stability', () => {
	it('keeps equal-rank rows in their previous order while etas swap', () => {
		const first = alertSurface(
			input({
				alerts: [al('a', { etaSec: 120 }), al('b', { etaSec: 180 })],
			}),
		);
		expect(first.order).toEqual(['a', 'b']);
		const second = alertSurface(
			input({
				alerts: [al('a', { etaSec: 200 }), al('b', { etaSec: 90 })],
				prevOrder: first.order,
			}),
		);
		expect(second.order).toEqual(['a', 'b']);
		expect(second.banner?.key).toBe('a');
	});

	it('reorders on a real severity change and slots a new alert by rank', () => {
		const first = alertSurface(
			input({ alerts: [al('a'), al('b')] }),
		);
		const second = alertSurface(
			input({
				alerts: [al('a'), al('b', { severity: 'imminent' }), al('c', { severity: 'proximity' })],
				prevOrder: first.order,
			}),
		);
		expect(second.order).toEqual(['b', 'a', 'c']);
	});

	it('covers acked rows too, band-stable under an acknowledgement', () => {
		const first = alertSurface(input({ alerts: [al('a'), al('b'), al('c')] }));
		expect(first.order).toEqual(['a', 'b', 'c']);
		const second = alertSurface(
			input({
				alerts: [al('a', { acked: true }), al('b'), al('c')],
				prevOrder: first.order,
			}),
		);
		expect(second.order).toEqual(['b', 'c', 'a']);
		expect(second.banner?.key).toBe('b');
	});
});
