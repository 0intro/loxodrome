/* The phone's diversion list (components/phone/NearestAerodromes.svelte)
 * reads its closure mark and its frequency at the POSE's instant, the band's
 * own (navOverflight's), and re-reads it every minute. A source pin, the
 * popupMenu.spec idiom, there being no DOM here to mount the component in.
 *
 * Its instant was read untracked with the quantised position as the only
 * dependency, so a stationary aircraft (on the ground with the recording
 * running, a hold over one spot) kept a field marked open after its closure
 * had started, and a frequency change unshown, until it moved about 185 m. */

import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';

const src = readFileSync('src/lib/components/phone/NearestAerodromes.svelte', 'utf8');
const rows = src.slice(src.indexOf('const rows = $derived.by('), src.indexOf('function pick('));

describe('the diversion list instant', () => {
	it('tracks the playhead to the minute', () => {
		expect(src).toMatch(/const minuteStep = \$derived\(Math\.floor\(nav\.playheadMs \/ 60_000\)\);/);
		expect(rows).toContain('void minuteStep;');
	});

	it("resolves the frequency and the closure at the pose's instant", () => {
		expect(rows).toMatch(/const at = \{ fromMs: tMs, toMs: tMs \};/);
		expect(rows).toContain('airportContactUnit(h.airport, at)');
		expect(rows).toContain('aerodromeClosedByNotam(h.airport, at)');
	});
});
