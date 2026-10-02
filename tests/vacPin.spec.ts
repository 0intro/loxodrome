/* The chart the reader asked for, and the one being pointed at. */

import { beforeEach, describe, expect, it } from 'vitest';

import {
	clearVacPin,
	leadingChart,
	pinVacChart,
	previewVacChart,
	vacPin,
} from '$lib/state/vacPin.svelte';

beforeEach(() => {
	clearVacPin();
	previewVacChart(null);
});

describe('vacPin', () => {
	it('pins a chart, and lets go when the same one is asked for again', () => {
		pinVacChart('LFPL');
		expect(leadingChart()).toBe('LFPL');
		pinVacChart('LFPL');
		expect(leadingChart()).toBeNull();
	});

	it('moves the pin to another chart rather than keeping both', () => {
		pinVacChart('LFPL');
		pinVacChart('LFPO');
		expect(vacPin.ident).toBe('LFPO');
	});

	it('lets a preview win, and gives the pin back when it ends', () => {
		// Pointing at a row in the menu shows that chart, the way hovering
		// an airspace row lights that airspace up. It is a look, not a
		// choice, so what was pinned is still pinned underneath.
		pinVacChart('LFPL');
		previewVacChart('LFPO');
		expect(leadingChart()).toBe('LFPO');
		expect(vacPin.ident).toBe('LFPL');
		previewVacChart(null);
		expect(leadingChart()).toBe('LFPL');
	});

	it('previews with nothing pinned, and leaves nothing behind', () => {
		previewVacChart('LFPO');
		expect(leadingChart()).toBe('LFPO');
		previewVacChart(null);
		expect(leadingChart()).toBeNull();
		expect(vacPin.ident).toBeNull();
	});
});
