/* The airport panel's NOTAM fetch control (AerodromeNotamFetch.svelte),
 * rendered on the server in both languages.
 *
 * What it says matters more than how it looks: "no NOTAMs" used to be said
 * with no briefing loaded at all, an all-clear the app cannot give. So each
 * state gets its own sentence, and what the briefing holds but the panel does
 * not show is counted rather than silently missing. */

import { render } from 'svelte/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('$lib/state/data.svelte', async (importOriginal) => {
	const real = await importOriginal<typeof import('$lib/state/data.svelte')>();
	return { ...real, ensureAirports: () => Promise.resolve([]), ensureAirspaces: () => Promise.resolve([]) };
});

const { amendBriefing, clearNotams, commitBriefing } = await import('$lib/state/notam.svelte');
const { aerodromeRefresh } = await import('$lib/state/aerodromeRefresh.svelte');
const { filter } = await import('$lib/state/filter.svelte');
const { i18n } = await import('$lib/state/i18n.svelte');
const { default: Fetch } = await import('$lib/components/detail/AerodromeNotamFetch.svelte');

function notam(id: string, opts: { a?: string; traffic?: string } = {}): string {
	const { a = 'LFPN', traffic = 'IV' } = opts;
	return [
		`${id} NOTAMN`,
		`Q) LFFF/QMRLC/${traffic}/NBO/A/000/999/4845N00207E005`,
		`A) ${a} B) 2601010000 C) PERM`,
		'E) RWY 07/25 CLSD.',
	].join('\n');
}

const LFPN = { lat: 48.75194, lon: 2.10611 };
const LFOZ = { lat: 47.89694, lon: 2.16333 };

/** The rendered text, tags and comments out, ASCII whitespace folded (not
 *  \s, which would fold the French narrow no-break space too). */
const text = (ident: string, shown: number, at = LFPN): string =>
	render(Fetch, { props: { ident, shown, ...at } })
		.body.replace(/<!--[^]*?-->/g, '')
		.replace(/<[^>]+>/g, ' ')
		.replace(/[ \t\r\n]+/g, ' ')
		.trim();

beforeEach(() => {
	clearNotams();
	i18n.locale = 'en';
	filter.trafficMode = 'all';
	aerodromeRefresh.error = null;
	aerodromeRefresh.errorDetail = null;
	aerodromeRefresh.errorIdent = null;
	aerodromeRefresh.fetching = null;
});

afterEach(() => {
	vi.useRealTimers();
	i18n.locale = 'en';
	filter.trafficMode = 'all';
});

describe('the airport panel NOTAM fetch', () => {
	it('says no briefing is loaded rather than that there is no NOTAM', () => {
		expect(text('lfpn', 0)).toBe('Get NOTAMs No NOTAM briefing loaded.');
		i18n.locale = 'fr';
		expect(text('lfpn', 0)).toBe('Récupérer les NOTAM Aucun briefing NOTAM chargé.');
	});

	it('says the loaded briefing holds nothing under the ident', () => {
		commitBriefing(notam('B0001/26', { a: 'LFPG' }), { source: 'sofia', kind: 'route', briefed: null });
		expect(text('LFPN', 0)).toBe('Get NOTAMs No NOTAM filed under LFPN in the loaded briefing.');
	});

	it('counts what a filter hides, and offers a refresh for what is held', () => {
		commitBriefing(notam('A0001/26', { traffic: 'I' }), { source: 'sofia', kind: 'route', briefed: null });
		filter.trafficMode = 'vfr';
		expect(text('LFPN', 0)).toBe('Refresh 1 NOTAM hidden by filters.');
	});

	it('counts what lies outside the region the briefing was fetched for', () => {
		commitBriefing(notam('A0001/26'), {
			source: 'autorouter',
			kind: 'viewport',
			briefed: null,
			fetchScope: { kind: 'bbox', bbox: { minLat: 42, minLon: 1, maxLat: 45, maxLon: 5 } },
		});
		expect(text('LFPN', 0)).toBe('Refresh 1 NOTAM outside the region that was fetched.');
	});

	it('stamps a fetch with its source, time and window, and what it removed or kept', () => {
		// Another day than the fetch's, so its time is written in full.
		vi.useFakeTimers({ toFake: ['Date'] });
		vi.setSystemTime(new Date('2026-10-05T12:00:00Z'));
		commitBriefing([notam('A0001/26'), notam('A0002/26'), notam('A0003/26')].join('\n\n'), {
			source: 'sofia',
			kind: 'route',
			briefed: null,
		});
		const at = Date.parse('2026-10-02T15:10:00Z');
		const briefed = { from: Date.parse('2026-10-02T15:12:00Z'), to: Date.parse('2026-10-03T15:11:00Z') };
		// A0002 is covered and gone; A0003's coverage cannot be told.
		amendBriefing('LFPN', [notam('A0001/26')], { source: 'sofia', at, briefed }, (n) =>
			n.id === 'A0003/26' ? null : true,
		);
		const body = text('LFPN', 2);
		expect(body).toContain('Fetched from SOFIA at 2026-10-02 15:10Z: 1 NOTAM filed under LFPN.');
		expect(body).toContain('Covering 2026-10-02 15:12Z – 2026-10-03 15:11Z.');
		expect(body).toContain('1 withdrawn since the earlier briefing.');
		expect(body).toContain('1 from the earlier briefing kept, not confirmed by SOFIA.');
		expect(body.startsWith('Refresh ')).toBe(true);
		i18n.locale = 'fr';
		const fr = text('LFPN', 2);
		expect(fr).toContain('Récupération depuis SOFIA à 2026-10-02 15:10Z : 1 NOTAM déposé sous LFPN.');
		expect(fr).toContain('1 retiré depuis le briefing précédent.');
		expect(fr).toContain('1 du briefing précédent conservé, non confirmé par SOFIA.');
	});

	it("shows a failure under its own aerodrome only, and the briefing's state beside it", () => {
		aerodromeRefresh.error = () => 'The request timed out.';
		aerodromeRefresh.errorIdent = 'LFPN';
		expect(text('LFPN', 0)).toBe(
			'Get NOTAMs The request timed out. The loaded NOTAMs are unchanged. No NOTAM briefing loaded.',
		);
		expect(text('LFOB', 0)).toBe('Get NOTAMs No NOTAM briefing loaded.');
	});

	it('offers Stop to the fetch running, and waits for another', () => {
		aerodromeRefresh.fetching = 'LFPN';
		expect(text('LFPN', 0)).toBe('Stop Fetching the NOTAMs filed under LFPN from SOFIA…');
		const other = render(Fetch, { props: { ident: 'LFOB', shown: 0, ...LFPN } }).body;
		expect(other).toMatch(/<button[^>]*disabled/);
	});

	it('offers nothing for an ident no NOTAM office files under', () => {
		expect(text('LF1234', 0)).toBe('No NOTAM briefing loaded.');
	});
});

describe('where the route briefing reaches the field', () => {
	// Etampes-Mondesir, inside the corridor between the ends, and Lille, off it.
	const LFOX = { lat: 48.38139, lon: 2.07528 };
	const LFQQ = { lat: 50.56333, lon: 3.08694 };
	beforeEach(() => {
		commitBriefing(notam('B0001/26', { a: 'LFPG' }), {
			source: 'sofia',
			kind: 'route',
			briefed: null,
			asked: {
				region: {
					kind: 'tracks',
					tracks: [{ label: 'LFPN-LFOZ', path: [LFPN, LFOZ], landed: true, ends: ['LFPN', 'LFOZ'] }],
					halfWidthNM: 15.3,
				},
				aim: 'flight',
			},
		});
	});

	it('says nothing more of a route end, which SOFIA briefs whole', () => {
		expect(text('LFPN', 0)).toBe('Get NOTAMs No NOTAM filed under LFPN in the loaded briefing.');
	});

	it('says a field between the ends comes back thinly', () => {
		expect(text('LFOX', 0, LFOX)).toBe(
			"Get NOTAMs No NOTAM filed under LFOX in the loaded briefing. SOFIA briefs in full only a route's first and last aerodrome. Only some NOTAMs filed under this one are in the briefing.",
		);
		i18n.locale = 'fr';
		expect(text('LFOX', 0, LFOX)).toContain(
			'SOFIA ne briefe en entier que le premier et le dernier aérodrome d’une route. Seule une partie des NOTAM déposés sous celui-ci figurent dans le briefing.',
		);
	});

	it('says a field off the corridor lies outside the briefing, until fetched by name', () => {
		expect(text('LFQQ', 0, LFQQ)).toBe('Get NOTAMs LFQQ lies outside the area the loaded briefing covers.');
		i18n.locale = 'fr';
		expect(text('LFQQ', 0, LFQQ)).toBe(
			'Récupérer les NOTAM LFQQ est hors de la zone que couvre le briefing chargé.',
		);
		i18n.locale = 'en';
		const at = Date.now();
		amendBriefing('LFQQ', [], { source: 'sofia', at, briefed: { from: at, to: at + 86_400_000 } }, () => true);
		expect(text('LFQQ', 0, LFQQ)).not.toContain('outside');
	});
});
