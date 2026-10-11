/* Position-quality thresholds (src/lib/nav/positionQuality.ts): when the
 * displayed pose stops being a claim about now. Contract: docs/nav-live.md. */

import { describe, expect, it } from 'vitest';
import {
	positionQualityAt,
	DEGRADED_ACCURACY_M,
	DEGRADED_REJECTS,
	LOST_MS,
	STALE_MS,
	type PositionQualityInput,
} from '../src/lib/nav/positionQuality';

const T0 = Date.UTC(2026, 6, 26, 9, 0, 0);

function at(over: Partial<PositionQualityInput> = {}): PositionQualityInput {
	return {
		recording: true,
		lastFixMs: T0,
		nowMs: T0,
		accuracyM: 8,
		rejected: 0,
		...over,
	};
}

describe('positionQualityAt', () => {
	it('is good on a fresh, accurate fix', () => {
		expect(positionQualityAt(at())).toBe('good');
	});

	it('is always good off a recording: a replay pose is a recorded fact', () => {
		// Every input that would otherwise read lost.
		expect(
			positionQualityAt(at({ recording: false, lastFixMs: null, accuracyM: 900, rejected: 99 })),
		).toBe('good');
	});

	it('is lost while recording before the first fix', () => {
		expect(positionQualityAt(at({ lastFixMs: null }))).toBe('lost');
	});

	it('degrades at the stale threshold and is lost at the lost one', () => {
		expect(positionQualityAt(at({ nowMs: T0 + STALE_MS - 1 }))).toBe('good');
		expect(positionQualityAt(at({ nowMs: T0 + STALE_MS }))).toBe('degraded');
		expect(positionQualityAt(at({ nowMs: T0 + LOST_MS - 1 }))).toBe('degraded');
		expect(positionQualityAt(at({ nowMs: T0 + LOST_MS }))).toBe('lost');
	});

	it('degrades on a coarse fix however fresh', () => {
		expect(positionQualityAt(at({ accuracyM: DEGRADED_ACCURACY_M }))).toBe('good');
		expect(positionQualityAt(at({ accuracyM: DEGRADED_ACCURACY_M + 1 }))).toBe('degraded');
	});

	it('accepts a fix that reports no accuracy at all', () => {
		expect(positionQualityAt(at({ accuracyM: null }))).toBe('good');
	});

	it('degrades once fixes are being rejected: a stalled trace has to say so', () => {
		expect(positionQualityAt(at({ rejected: DEGRADED_REJECTS - 1 }))).toBe('good');
		expect(positionQualityAt(at({ rejected: DEGRADED_REJECTS }))).toBe('degraded');
	});

	it('treats a fix stamped in the future as current, not as impossibly fresh', () => {
		// Device clock skew; the age clamps at zero rather than going negative.
		expect(positionQualityAt(at({ nowMs: T0 - 60_000 }))).toBe('good');
	});

	it('reports the worst state when several conditions hold', () => {
		expect(positionQualityAt(at({ nowMs: T0 + LOST_MS, accuracyM: 900, rejected: 9 }))).toBe(
			'lost',
		);
	});
});
