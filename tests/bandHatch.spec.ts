/* The hatch the route profile draws on a band (components/profileBand.ts
 * bandHatch): each band whose zone is active where the flight crosses it,
 * a zone in force at all times keeping its chart look and a NOTAM band its
 * own hatch, its tooltip line naming the NOTAMs that activate the zone over
 * its active period, else the state as the zone's panel says it. */

import { describe, expect, it } from 'vitest';
import type { ActivityAnswer } from '$lib/data/activity';
import { bandHatch } from '$lib/components/profileBand';
import type { Notam } from '$lib/notam/types';
import type { IndexedNotam } from '$lib/state/notam.svelte';

const H = 3_600_000;
const NOON = Date.UTC(2026, 11, 4, 12);
const AT = { fromMs: NOON - 6 * H, toMs: NOON + 6 * H };

const answer = (state: ActivityAnswer['state'], reason: ActivityAnswer['reason'], from = NOON, to = NOON + 4 * H): ActivityAnswer => ({
	state,
	reason,
	period: { startMs: from, endMs: to },
});

function activation(id: string, from: number, to: number): IndexedNotam {
	const notam = {
		id,
		fullContent: 'E) RESTRICTED AREA LF-R 174 ACTIVE',
		coordinates: [],
		icaoCodes: ['LFEE'],
		isPolygon: false,
		startDate: new Date(from),
		endDate: new Date(to),
		permanent: false,
		estimated: false,
		qCode: 'QRRCA',
		obstacleType: '',
		serviceStatus: '',
		qualifier: null,
		fgLower: null,
		fgUpper: null,
		replaces: null,
	} as unknown as Notam;
	return { notam, index: 0 };
}

const NO_LINKS = new Map<string, IndexedNotam[]>();

describe('the band hatch', () => {
	it('hatches the zones active at the crossing, a permanent one and a NOTAM band left out', () => {
		const states = new Map<string, ActivityAnswer>([
			['LFR174|R 174', answer('active', 'published')],
			['LFR275|R 275', { state: 'active', reason: 'permanent', period: null }],
			['LFR151|R 151', answer('activable', 'activable')],
			['LFR57|R 57', { state: 'inactive', reason: 'outside', period: null }],
			['notam:R1234/26', answer('active', 'published')],
		]);
		const hatch = bandHatch(states, new Map(), NO_LINKS, 'flight', AT);
		expect([...(hatch?.keys() ?? [])]).toEqual(['LFR174|R 174']);
		expect(hatch?.get('LFR174|R 174')).toBe('Active from 12:00Z to 16:00Z. Active in its published hours.');
	});

	it('names the NOTAMs that activate the zone over its active period', () => {
		const states = new Map([['LFR174|R 174', answer('active', 'notam')]]);
		const ids = new Map([['LFR174|R 174', 'LFR174']]);
		const links = new Map([
			['LFR174', [activation('R2724/26', NOON - 2 * H, NOON + 6 * H), activation('R2799/26', NOON + 30 * H, NOON + 40 * H)]],
		]);
		expect(bandHatch(states, ids, links, 'flight', AT)?.get('LFR174|R 174')).toBe('Activated by NOTAM R2724/26');
	});

	it('says the state where no NOTAM it holds reaches the period', () => {
		const states = new Map([['LFR174|R 174', answer('active', 'notam')]]);
		const ids = new Map([['LFR174|R 174', 'LFR174']]);
		const links = new Map([['LFR174', [activation('R2799/26', NOON + 30 * H, NOON + 40 * H)]]]);
		expect(bandHatch(states, ids, links, 'flight', AT)?.get('LFR174|R 174')).toBe(
			'Active from 12:00Z to 16:00Z. Activated by NOTAM.',
		);
	});

	it('hatches nothing where no zone is active', () => {
		const states = new Map([['LFR151|R 151', answer('activable', 'activable')]]);
		expect(bandHatch(states, new Map(), NO_LINKS, 'flight', AT)).toBeNull();
	});
});
