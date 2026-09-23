/* The backoff's doubling belongs to ONE incident (state/radar.svelte.ts
 * rateLimited). The frames' refusals that last are the relay's aggregate
 * MISS ceiling's, while the index is an edge HIT that ceiling never counts:
 * it lists through the incident. Reset on any index listed after the
 * refusal, a sustained frames-only refusal was retried at 66, 132 and 264 s
 * round and round, never 528 and 900. An incident now ends when the timer's
 * retry pass draws no refusal, and the next one starts at the floor. */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { display } from '$lib/state/display.svelte';
import { ui } from '$lib/state/ui.svelte';
import { ensureRadar, radar, resetRadarForTest, setShowRadarOnMap, type RadarView } from '$lib/state/radar.svelte';
import { frameSlot } from '$lib/weather/opera';
import { MIN, frameBody, indexResponse, stubStorage } from './helpers/radarProxy';

const VIEW: RadarView = { product: 'DBZH', tiles: [30], p: 1 };

async function settleFake(): Promise<void> {
	for (let i = 0; i < 12; i++) {
		await vi.advanceTimersByTimeAsync(15);
	}
}

/** The wait the busy notice states, seconds, or -1 for none. */
function statedWait(): number {
	const m = /retry in (\d+)s/.exec(radar.error?.() ?? '');
	return m ? Number(m[1]) : -1;
}

/** The live feed: every slot whose frame has landed (4.2 min after its
 *  nominal time), the last half hour of them. */
function listed(): string[] {
	const last = Math.floor((Date.now() - 4.2 * MIN) / (5 * MIN)) * 5 * MIN;
	return Array.from({ length: 6 }, (_, i) => frameSlot(last - (5 - i) * 5 * MIN));
}

let refuse = true;

beforeEach(() => {
	vi.useFakeTimers();
	stubStorage();
	resetRadarForTest();
	refuse = true;
	vi.stubGlobal('fetch', async (input: string): Promise<Response> => {
		const url = new URL(input);
		if (url.pathname === '/opera/frames') {
			return indexResponse('DBZH', listed(), Date.now());
		}
		// The ceiling's refusal, a moment behind the edge hit.
		await new Promise((r) => setTimeout(r, 5));
		if (refuse) {
			return new Response('busy', { status: 429 });
		}
		return new Response(frameBody(url.searchParams.get('tiles')!.split(',').map(Number), 'DBZH'), { status: 200 });
	});
	display.liveWeather = true;
	ui.isMobile = false;
	setShowRadarOnMap(true);
});

afterEach(async () => {
	setShowRadarOnMap(false);
	await vi.advanceTimersByTimeAsync(2_000_000);
	vi.useRealTimers();
	vi.unstubAllGlobals();
});

/** Run the timer out and the ensure pass its retrySeq triggers. */
async function retryPass(waitS: number): Promise<void> {
	const seq = radar.retrySeq;
	await vi.advanceTimersByTimeAsync(Math.max(1, waitS) * 1000 + 100);
	expect(radar.retrySeq).toBe(seq + 1);
	ensureRadar(VIEW, Date.now());
	await settleFake();
}

describe('a frames-only refusal behind an index the edge keeps serving', () => {
	it('doubles through the incident, whatever the index lists meanwhile', async () => {
		ensureRadar(VIEW, Date.now());
		await settleFake();
		ensureRadar(VIEW, Date.now());
		await settleFake();
		const waits: number[] = [];
		for (let k = 0; k < 7; k++) {
			waits.push(statedWait());
			await retryPass(waits[waits.length - 1]);
		}
		expect(waits).toEqual([66, 132, 264, 528, 900, 900, 900]);
	});

	it('starts the next incident at the floor once a retry pass drew no refusal', async () => {
		ensureRadar(VIEW, Date.now());
		await settleFake();
		ensureRadar(VIEW, Date.now());
		await settleFake();
		expect(statedWait()).toBe(66);
		await retryPass(66);
		expect(statedWait()).toBe(132);
		// The relay recovers: the retry pass is answered.
		refuse = false;
		await retryPass(132);
		expect(radar.status).not.toBe('error');
		// Minutes later, a new incident.
		await vi.advanceTimersByTimeAsync(10 * MIN);
		refuse = true;
		ensureRadar(VIEW, Date.now());
		await settleFake();
		ensureRadar(VIEW, Date.now());
		await settleFake();
		expect(statedWait()).toBe(66);
	});
});
