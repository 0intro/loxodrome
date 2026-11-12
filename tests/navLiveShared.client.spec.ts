/* The live navigation state, evaluated once per change whoever reads it
 * (state/navLiveShared.svelte.ts). navLiveFor, the flown route and the
 * active route are stood in for (tests/helpers/navLiveHosts.svelte.ts); the
 * readers are real host effects, which is why this runs in the client
 * project: the server build never runs an effect.
 *
 * What it pins: every reader of one question shares one evaluation per
 * change; the flown and the active questions share one while they name the
 * same route; a reader going away leaves the others updating; and no number
 * of route ids ever leaves a reader holding an old answer, which is how the
 * registry this module replaced froze the nav log and the route profile
 * after the ninth route of a session. */

import { flushSync } from 'svelte';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { evaluations, fake, mountReader, type Reader } from './helpers/navLiveHosts.svelte';

vi.mock('$lib/state/navLive.svelte', async () => {
	const h = await import('./helpers/navLiveHosts.svelte');
	return { navLiveFor: h.fakeNavLiveFor };
});
vi.mock('$lib/state/navRoute.svelte', async () => {
	const h = await import('./helpers/navLiveHosts.svelte');
	return { navRouteId: () => h.fake.flownId };
});
vi.mock('$lib/state/route.svelte', async () => {
	const h = await import('./helpers/navLiveHosts.svelte');
	return { activeRoute: () => ({ id: h.fake.activeId }) };
});

const { navLiveActive, navLiveNow } = await import('$lib/state/navLiveShared.svelte');

/** A state write, then the effects it wakes. */
function act(write: () => void): void {
	write();
	flushSync();
}

/** Evaluations since the last ask, per route id, the ids never evaluated left out. */
function evaluated(): Record<string, number> {
	const out = Object.fromEntries(evaluations);
	evaluations.clear();
	return out;
}

const readers: Reader[] = [];

/** A reader, mounted and run once. */
function reader(read: typeof navLiveNow): Reader {
	const r = mountReader(read);
	readers.push(r);
	flushSync();
	return r;
}

beforeEach(() => {
	act(() => {
		fake.flownId = 'r1';
		fake.activeId = 'r1';
		fake.tick = 0;
	});
	evaluations.clear();
});

afterEach(() => {
	for (const r of readers.splice(0)) {
		r.stop();
	}
});

describe('navLiveNow', () => {
	it('evaluates once per change, however many read it', () => {
		const band = reader(navLiveNow);
		const tab = reader(navLiveNow);
		const map = reader(navLiveNow);
		expect(evaluated()).toEqual({ r1: 1 });
		for (let k = 1; k <= 5; k++) {
			act(() => {
				fake.tick = k;
			});
			expect(evaluated(), `tick ${k}`).toEqual({ r1: 1 });
			for (const r of [band, tab, map]) {
				expect(r.seen()).toEqual({ routeId: 'r1', tick: k });
			}
		}
	});

	it('keeps the others updating when one reader goes away', () => {
		const first = reader(navLiveNow);
		const second = reader(navLiveNow);
		first.stop();
		act(() => {
			fake.tick = 1;
		});
		expect(second.seen()).toEqual({ routeId: 'r1', tick: 1 });
		expect(evaluated()).toEqual({ r1: 2 });
	});
});

describe('navLiveActive', () => {
	it('shares the flown evaluation while the active route is the flown one', () => {
		const band = reader(navLiveNow);
		const log = reader(navLiveActive);
		const profile = reader(navLiveActive);
		expect(evaluated()).toEqual({ r1: 1 });
		act(() => {
			fake.tick = 1;
		});
		expect(evaluated()).toEqual({ r1: 1 });
		for (const r of [band, log, profile]) {
			expect(r.seen()).toEqual({ routeId: 'r1', tick: 1 });
		}
		// Paged to another route: the planning surfaces follow it, the band
		// stays on the flown one, and each is evaluated once.
		act(() => {
			fake.activeId = 'r2';
		});
		expect(evaluated()).toEqual({ r2: 1 });
		expect(log.seen()).toEqual({ routeId: 'r2', tick: 1 });
		expect(band.seen()).toEqual({ routeId: 'r1', tick: 1 });
		act(() => {
			fake.tick = 2;
		});
		expect(evaluated()).toEqual({ r1: 1, r2: 1 });
		expect(profile.seen()).toEqual({ routeId: 'r2', tick: 2 });
		// And paged back, it rides the flown evaluation again.
		act(() => {
			fake.activeId = 'r1';
		});
		act(() => {
			fake.tick = 3;
		});
		expect(evaluated()).toEqual({ r1: 1 });
		expect(log.seen()).toEqual({ routeId: 'r1', tick: 3 });
	});
});

describe('many routes in a session', () => {
	it('never freeze a reader while another pages through them', () => {
		// The band stays on the flown route while the nav log pages through
		// the plan's others: the registry disposed every derived past eight
		// ids, the band's among them, and the band, whose own inputs had not
		// moved, never ran again.
		const band = reader(navLiveNow);
		const log = reader(navLiveActive);
		for (let i = 2; i <= 12; i++) {
			act(() => {
				fake.activeId = `r${i}`;
			});
		}
		act(() => {
			fake.tick = 1;
		});
		expect(band.seen()).toEqual({ routeId: 'r1', tick: 1 });
		expect(log.seen()).toEqual({ routeId: 'r12', tick: 1 });
		// The mirror: the log stays on its route while the flown one moves on
		// (each Direct-To is a new route).
		for (let i = 13; i <= 23; i++) {
			act(() => {
				fake.flownId = `r${i}`;
			});
		}
		act(() => {
			fake.tick = 2;
		});
		expect(log.seen()).toEqual({ routeId: 'r12', tick: 2 });
		expect(band.seen()).toEqual({ routeId: 'r23', tick: 2 });
	});

	it('never leave a reader holding an old answer', () => {
		const band = reader(navLiveNow);
		const log = reader(navLiveActive);
		// Direct-To and plan loads make new route ids; the registry this
		// replaced disposed its deriveds past eight of them.
		for (let i = 2; i <= 24; i++) {
			act(() => {
				fake.activeId = `r${i}`;
				fake.flownId = `r${i}`;
			});
			act(() => {
				fake.tick = i;
			});
			expect(log.seen(), `route ${i}`).toEqual({ routeId: `r${i}`, tick: i });
			expect(band.seen(), `route ${i}`).toEqual({ routeId: `r${i}`, tick: i });
		}
		// Back to the first route of the session, still live.
		act(() => {
			fake.activeId = 'r1';
			fake.flownId = 'r1';
		});
		act(() => {
			fake.tick = 100;
		});
		expect(log.seen()).toEqual({ routeId: 'r1', tick: 100 });
		expect(band.seen()).toEqual({ routeId: 'r1', tick: 100 });
	});
});
