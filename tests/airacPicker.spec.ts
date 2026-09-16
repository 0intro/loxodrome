import { describe, it, expect } from 'vitest';
import { pickActiveDataset, wouldSwitch } from '../src/lib/data/meta';

const NOW = new Date('2026-05-22T12:00:00Z');
const CURRENT_URL = '/data/airspaces.json';
const NEXT_URL = '/data/airspaces.next.json';

describe('pickActiveDataset', () => {
	it('uses current when only the current cycle is published', () => {
		const p = pickActiveDataset(
			'2026-05-14T00:00:00.000+02:00',
			null,
			CURRENT_URL,
			NEXT_URL,
			NOW,
		);
		expect(p.url).toBe(CURRENT_URL);
		expect(p.slot).toBe('current');
		expect(p.effective).toBe('2026-05-14T00:00:00.000+02:00');
	});

	it('uses current when the next cycle is still in the future', () => {
		const p = pickActiveDataset(
			'2026-05-14T00:00:00.000+02:00',
			'2026-06-11T00:00:00.000+02:00',
			CURRENT_URL,
			NEXT_URL,
			NOW,
		);
		expect(p.url).toBe(CURRENT_URL);
		expect(p.slot).toBe('current');
	});

	it('uses next when its effective has passed and beats current', () => {
		const after = new Date('2026-06-12T00:00:00Z');
		const p = pickActiveDataset(
			'2026-05-14T00:00:00.000+02:00',
			'2026-06-11T00:00:00.000+02:00',
			CURRENT_URL,
			NEXT_URL,
			after,
		);
		expect(p.url).toBe(NEXT_URL);
		expect(p.slot).toBe('next');
		expect(p.effective).toBe('2026-06-11T00:00:00.000+02:00');
	});

	it('ignores a stale next that is older than the current', () => {
		const p = pickActiveDataset(
			'2026-05-14T00:00:00.000+02:00',
			'2020-01-01T00:00:00.000Z', // older than current; misbuild
			CURRENT_URL,
			NEXT_URL,
			NOW,
		);
		expect(p.slot).toBe('current');
	});

	it('treats both-null effectives as current-no-info', () => {
		const p = pickActiveDataset(null, null, CURRENT_URL, NEXT_URL, NOW);
		expect(p.url).toBe(CURRENT_URL);
		expect(p.slot).toBe('current');
		expect(p.effective).toBeNull();
	});

	it('falls back to current when the next effective is unparseable', () => {
		const p = pickActiveDataset(
			'2026-05-14T00:00:00.000+02:00',
			'not-a-date',
			CURRENT_URL,
			NEXT_URL,
			NOW,
		);
		expect(p.slot).toBe('current');
	});
});

describe('effective-date parse (calendar-date convention)', () => {
	// The SIA stamps AIRAC effectives at local midnight ('+02:00'), an
	// instant of 22:00Z the EVE of the cycle date; a raw Date.parse flipped
	// the slot two hours early. The picker must hold until 00:00Z of the
	// stamp's own calendar date.
	const CURRENT = '2026-07-09T00:00:00.000+02:00';
	const NEXT = '2026-08-06T00:00:00.000+02:00';

	it('keeps current on the eve of the next cycle date, past the raw 22:00Z instant', () => {
		const eve = new Date('2026-08-05T23:00:00Z');
		const p = pickActiveDataset(CURRENT, NEXT, CURRENT_URL, NEXT_URL, eve);
		expect(p.slot).toBe('current');
	});

	it('activates next at 00:00Z of its own calendar date', () => {
		const midnight = new Date('2026-08-06T00:00:00Z');
		const p = pickActiveDataset(CURRENT, NEXT, CURRENT_URL, NEXT_URL, midnight);
		expect(p.slot).toBe('next');
		expect(p.url).toBe(NEXT_URL);
	});

	it('wouldSwitch prompts at the same instant, not before', () => {
		expect(wouldSwitch(CURRENT, NEXT, 'current', new Date('2026-08-05T23:00:00Z'))).toBe(false);
		expect(wouldSwitch(CURRENT, NEXT, 'current', new Date('2026-08-06T00:00:00Z'))).toBe(true);
	});
});

describe('wouldSwitch', () => {
	const CURRENT = '2026-05-14T00:00:00.000+02:00';
	const NEXT = '2026-06-11T00:00:00.000+02:00';
	const BEFORE = new Date('2026-05-22T12:00:00Z'); // next still future
	const AFTER = new Date('2026-06-12T00:00:00Z'); // next now effective

	it('does not prompt while the loaded current slot is still active', () => {
		expect(wouldSwitch(CURRENT, NEXT, 'current', BEFORE)).toBe(false);
	});

	it('prompts once the next cycle becomes effective and current is loaded', () => {
		expect(wouldSwitch(CURRENT, NEXT, 'current', AFTER)).toBe(true);
	});

	it('never prompts when the next slot is already loaded (regression)', () => {
		// The loaders set dataState.*Effective to the *picked* slot's effective,
		// so once next is loaded the first argument equals the next argument. The
		// old heartbeat then computed `next > current` over equal dates (false),
		// concluded the picker wanted current, and flagged a phantom switch on
		// every tick; the banner stuck even right after a reload that had already
		// loaded the new cycle.
		expect(wouldSwitch(NEXT, NEXT, 'next', AFTER)).toBe(false);
	});

	it('keeps the loaded next slot terminal far into the future', () => {
		expect(wouldSwitch(NEXT, NEXT, 'next', new Date('2027-01-01T00:00:00Z'))).toBe(
			false,
		);
	});

	it('does not prompt before any slot is loaded', () => {
		expect(wouldSwitch(null, null, null, AFTER)).toBe(false);
	});

	it('does not prompt when no next cycle is published', () => {
		expect(wouldSwitch(CURRENT, null, 'current', AFTER)).toBe(false);
	});

	it('does not prompt for a stale next older than current', () => {
		expect(
			wouldSwitch(CURRENT, '2020-01-01T00:00:00.000Z', 'current', AFTER),
		).toBe(false);
	});
});
