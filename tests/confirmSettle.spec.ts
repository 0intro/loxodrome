/* ConfirmDialog refuses a press within 250 ms of its question, a tap aimed
 * at whatever was there before. It timed the question on the wall clock, so
 * a backward step of the clock while a question was up (an NTP or NITZ
 * correction as the phone regains the network after landing) refused every
 * press on Stop, Discard or Resume until the clock caught up: in a dev
 * session with Date.now stepped back an hour, a press 600 ms after the
 * question left the dialog up. The guard times on the monotonic clock.
 * Pinned from the source, as tests/radarCaution.spec.ts pins the dialog's
 * effects: a client spec has no DOM to mount it in. */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const src = readFileSync(join(process.cwd(), 'src/lib/components/ConfirmDialog.svelte'), 'utf8');

describe("the confirm's settle guard", () => {
	it('times the question on the monotonic clock', () => {
		expect(src).toContain('let shownAt = performance.now();');
		const pre = src.slice(src.indexOf('$effect.pre(() => {'), src.indexOf('});', src.indexOf('$effect.pre(() => {')) + 3);
		expect(pre.replace(/\s+/g, ' ')).toBe('$effect.pre(() => { void message; shownAt = performance.now(); });');
		expect(src).toContain('return performance.now() - shownAt >= SETTLE_MS;');
		expect(src).not.toContain('Date.now()');
	});
});
