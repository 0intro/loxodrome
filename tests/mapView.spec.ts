/* The map's last settled view (state/mapView.ts): what a boot whose URL
 * carries no #map= opens on, instead of Paris. Read through the hash's own
 * parser, so a stored view means what a link's does, and it never carries a
 * layer choice, which is the layers document's. */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { memoryStorage } from './helpers/storage';

const KEY = 'loxodrome:map-view';

beforeEach(() => {
	vi.resetModules();
	vi.stubGlobal('localStorage', memoryStorage());
});

afterEach(() => {
	vi.unstubAllGlobals();
});

const load = () => import('$lib/state/mapView');

describe('the remembered map view', () => {
	it('is written in the hash grammar and read back', async () => {
		const m = await load();
		expect(m.rememberedMapView()).toBeNull();
		m.rememberMapView(9.4, 47.6553, -2.7603);
		expect(localStorage.getItem(KEY)).toBe('9/47.65530/-2.76030');
		expect(m.rememberedMapView()).toEqual({ center: [47.6553, -2.7603], zoom: 9 });
	});

	it('writes nothing for a view that is not one', async () => {
		const m = await load();
		m.rememberMapView(Number.NaN, 47, 2);
		m.rememberMapView(8, Number.POSITIVE_INFINITY, 2);
		expect(localStorage.getItem(KEY)).toBeNull();
	});

	it('reads anything the hash parser refuses, or a layer in it, as none', async () => {
		const m = await load();
		for (const raw of ['', ' ', 'nope', '9/95/2', '9/47/200', '9/47', '9/47/2/1', '9/47/2&layer=google', '#map=9/47/2', 'map=9/47/2']) {
			localStorage.setItem(KEY, raw);
			expect(m.rememberedMapView()).toBeNull();
		}
	});
});
