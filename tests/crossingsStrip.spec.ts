/* The crossings strip (components/CrossingsStrip.svelte) rendered on the
 * server: a zone activated for the flight wears ACTIVE in every rendition,
 * NO-GO or not, as the chart's hatch says nothing of the flight's own
 * period, and an active raptor zone the height to overfly it at. */
import { render } from 'svelte/server';
import { describe, expect, it, vi } from 'vitest';
import CrossingsStrip from '$lib/components/CrossingsStrip.svelte';
import type { BandCrossing } from '$lib/route/routeProfile';

vi.mock('$lib/state/zsm.svelte', async (importOriginal) => {
	const actual = await importOriginal<typeof import('$lib/state/zsm.svelte')>();
	return { ...actual, zsmById: (id: string) => (id === 'zsm:5991' ? { id, name: 'Le Rompeau', overflyM: 3110 } : null) };
});

const row = (key: string, over: Partial<BandCrossing>): BandCrossing => ({
	key,
	label: key,
	badge: 'D',
	badgeKind: 'zone',
	color: '#1971c2',
	limitsText: '1000 ft-3000 ft',
	tooltip: key,
	pens: [{ fromNM: 8, toNM: 10 }],
	firstNM: 8,
	forbidden: false,
	extentUnknown: false,
	groundUnknown: false,
	active: false,
	unknown: false,
	reason: null,
	period: null,
	...over,
});

describe('the crossings strip', () => {
	for (const interactive of [true, false]) {
		it(`words a crossing that may be active by why (${interactive ? 'interactive' : 'paper'})`, () => {
			const { body } = render(CrossingsStrip, {
				props: {
					crossings: [
						row('LFR9', { unknown: true, reason: 'notam-unbriefed' }),
						row('LFR151', { unknown: true, reason: 'activable' }),
					],
					interactive,
				},
			});
			const at = (key: string): string => {
				const i = body.indexOf(key);
				return body.slice(i, body.indexOf(' NM', i));
			};
			expect(at('LFR9')).toContain('activity unknown');
			expect(at('LFR151')).toContain('may be active');
			expect(at('LFR151')).not.toContain('activity unknown');
		});
	}

	for (const interactive of [true, false]) {
		it(`says a crossing the pilot's note settles, with its end (${interactive ? 'interactive' : 'paper'})`, () => {
			const note = { startMs: Date.UTC(2026, 10, 23, 8, 40), endMs: Date.UTC(2026, 10, 23, 16) };
			const { body } = render(CrossingsStrip, {
				props: {
					crossings: [
						row('ZRTBLOIS', { reason: 'noted', period: note }),
						row('LFR151', { active: true, reason: 'noted', period: note }),
					],
					interactive,
				},
			});
			const at = (key: string): string => {
				const i = body.indexOf(key);
				return body.slice(i, body.indexOf(' NM', i));
			};
			expect(at('ZRTBLOIS')).toContain('noted until 16:00Z');
			expect(at('ZRTBLOIS')).not.toContain('may be active');
			expect(at('LFR151')).toContain('ACTIVE');
			expect(at('LFR151')).toContain('noted until 16:00Z');
		});
	}

	it('carries its notes in the chip’s title, paper the word alone', () => {
		const crossings = [row('LFR151', { unknown: true, reason: 'activable' })];
		const notes = new Map([['LFR151', ['May be active from 09:00Z to 15:11Z.', 'Activity known on BLOIS INFO 118.455.']]]);
		const screen = render(CrossingsStrip, { props: { crossings, notes, interactive: true } }).body;
		expect(screen).toContain('title="LFR151\nMay be active from 09:00Z to 15:11Z.\nActivity known on BLOIS INFO 118.455."');
		const paper = render(CrossingsStrip, { props: { crossings, notes, interactive: false } }).body;
		expect(paper).toContain('may be active');
		expect(paper).not.toContain('Activity known on');
	});

	it('says on its label how its crossings were judged', () => {
		const crossings = [row('LFR151', { unknown: true, reason: 'activable' })];
		const label = (judged?: 'timed' | 'day' | 'now') => {
			const { body } = render(CrossingsStrip, { props: { crossings, interactive: judged !== undefined, judged } });
			const i = body.lastIndexOf('<', body.indexOf('cx-label'));
			return body.slice(i, body.indexOf('>', i));
		};
		expect(label('timed')).toContain(
			'title="Each crossing is judged at its planned time, from 15 min before its entry to 60 min after its exit."',
		);
		expect(label('day')).toContain('over the flight’s day. State a departure time');
		expect(label('now')).toContain('from now on, for the flight’s length');
		// Paper carries the rows alone.
		expect(label()).not.toContain('title=');
	});

	for (const interactive of [true, false]) {
		it(`says ACTIVE on an activated zone that is no NO-GO (${interactive ? 'interactive' : 'paper'})`, () => {
			const { body } = render(CrossingsStrip, {
				props: { crossings: [row('LFD7', { active: true }), row('LFD8', {})], interactive },
			});
			const at = (key: string): string => {
				const i = body.indexOf(key);
				return body.slice(i, body.indexOf(' NM', i));
			};
			expect(at('LFD7')).toContain('ACTIVE');
			expect(at('LFD8')).not.toContain('ACTIVE');
		});

		it(`says the height to overfly an active raptor zone at (${interactive ? 'interactive' : 'paper'})`, () => {
			const { body } = render(CrossingsStrip, {
				props: { crossings: [row('zsm:5991', { label: 'Le Rompeau', badge: 'ZSM', active: true })], interactive },
			});
			const chip = body.slice(body.indexOf('Le Rompeau'), body.indexOf(' NM', body.indexOf('Le Rompeau')));
			expect(chip).toMatch(/class="[^"]*\bcx-unknown\b[^"]*">overfly above 10\u202f210\u202fft</);
			expect(chip).not.toContain('ACTIVE');
		});
	}
});
