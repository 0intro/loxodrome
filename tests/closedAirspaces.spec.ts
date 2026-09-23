/* closedAirspaceLinks(): which FIS sectors the map draws as having no radio.
 *
 * The case is A5453/26, the NOTAM this whole surface exists for: it withdraws
 * 119.800 and shuts SIV BEAUVAIS 2, and it names three FIC PARIS sectors and
 * its own sibling BEAUVAIS 1 along the way, the first three only as the units
 * to call instead. Before the substitute rule those four were linked, which
 * put five airspaces on a NOTAM about one AND, because resolveAirspaceRadios
 * applies closures per row, raised a "closure could not be applied" flag on
 * each of them.
 *
 * The NOTAM plumbing is mocked (the freqOverride.spec idiom) so nothing
 * fetches; the by-name link and the closure ladder are the real ones, which is
 * the point: this file judges what the two do together.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { parseNotams } from '$lib/notam/parser';
import type { Airspace } from '$lib/data/airspaces';
import type { Notam } from '$lib/notam/types';

const m = vi.hoisted(() => ({
	items: [] as { notam: Notam; index: number }[],
	rows: [] as Airspace[],
}));

vi.mock('$lib/state/notam.svelte', async () => {
	const real =
		await vi.importActual<typeof import('$lib/state/notam.svelte')>('$lib/state/notam.svelte');
	return {
		...real,
		filteredNotams: () => m.items,
		notamsByIdent: () => new Map(),
		// Wide open: the validity gate has its own contract, and this file
		// judges which ROW a closure lands on.
		activeEvalWindow: () => ({ from: -8.64e15, to: 8.64e15 }),
		drawnStateAt: () => ({ fromMs: -8.64e15, toMs: 8.64e15 }),
	};
});

vi.mock('$lib/state/data.svelte', async () => {
	const real =
		await vi.importActual<typeof import('$lib/state/data.svelte')>('$lib/state/data.svelte');
	return { ...real, getAirspaces: () => m.rows };
});

const { closedAirspaceLinks, resolveAirspaceRadios } = await import('$lib/state/freqOverride.svelte');

/** The published rows, with the frequencies fr-airspaces.json really carries. */
function row(id: string, name: string, type: 'SIV' | 'FIC', freq: string): Airspace {
	return {
		id,
		key: id,
		name,
		type,
		source: 'fr',
		category: 'siv',
		radio: [{ freq, unit: `LFOB ${name}`, call: `${name} - INFORMATION` }],
		ring: [],
	} as unknown as Airspace;
}

const ROWS = [
	row('LFOBFS1', 'BEAUVAIS 1', 'SIV', '123.985'),
	row('LFOBFS2', 'BEAUVAIS 2', 'SIV', '119.8'),
	row('LFFFFIC1', 'PARIS NORD', 'FIC', '125.700'),
	row('LFFFFIC2', 'PARIS OUEST', 'FIC', '129.625'),
	row('LFFFFIC3', 'PARIS SUD', 'FIC', '126.100'),
];

const A5453_EN = `A5453/26 NOTAMN
Q) LFFF/QSEAU/IV/BO/AE/000/085/4924N00312E029
A) LFOB B) 2609010000 C) 2609302359
E) 'BEAUVAIS' INFO FREQ 119.800MHZ NOT AVBL :
- 'BEAUVAIS' FIS AREA 2 CLOSED
- CONTACT 'PARIS INFO' 125.700MHZ, OR IF IFR OR NGT VFR FLT CONTACT
'PARIS CTL' 128.275MHZ`;

const A5453_FR = `A5453/26 NOTAMN
Q) LFFF/QSEAU/IV/BO/AE/000/085/4924N00312E029
A) LFOB B) 2609010000 C) 2609302359
E) FREQUENCE BEAUVAIS INFO 119,8MHZ INDISPONIBLE :
- SIV 2 BEAUVAIS FERME,
- CONTACTER PARIS INFO 125.7MHZ, OU SI VOUS EVOLUEZ EN IFR OU VFR DE
NUIT CONTACTEZ PARIS CONTROLE 128.275MHZ.`;

function load(text: string): void {
	m.items = parseNotams(text).map((notam, index) => ({ notam, index }));
}

beforeEach(() => {
	m.rows = ROWS;
	m.items = [];
});

describe('closedAirspaceLinks', () => {
	it('draws the one sector the NOTAM shuts, in either language', () => {
		for (const text of [A5453_EN, A5453_FR]) {
			load(text);
			const closed = closedAirspaceLinks();
			expect([...closed.values()].map((c) => c.airspace.name)).toEqual(['BEAUVAIS 2']);
			expect(closed.get('LFOBFS2')?.source.notam.id).toBe('A5453/26');
		}
	});

	it('leaves the sibling sector on its own frequency alone', () => {
		load(A5453_EN);
		expect(closedAirspaceLinks().has('LFOBFS1')).toBe(false);
	});

	it('never draws the units the NOTAM says to contact instead', () => {
		load(A5453_EN);
		const closed = closedAirspaceLinks();
		for (const id of ['LFFFFIC1', 'LFFFFIC2', 'LFFFFIC3']) {
			expect(closed.has(id)).toBe(false);
		}
	});

	it('raises no closure flag on a substitute unit', () => {
		load(A5453_EN);
		// The regression: each of these used to carry "a closure could not be
		// applied" because the NOTAM named them and none publishes 119.800.
		for (const r of ROWS.filter((r) => r.type === 'FIC')) {
			expect(resolveAirspaceRadios(r).flags).toEqual([]);
		}
		// The sector it does shut keeps its row, struck, with provenance.
		const beauvais2 = resolveAirspaceRadios(ROWS[1]);
		expect(beauvais2.flags).toEqual([]);
		expect(beauvais2.radios[0].closed).toBe(true);
		expect(beauvais2.radios[0].closedBy?.source.notam.id).toBe('A5453/26');
	});

	it('names the NOTAM that closed the row, not one that could only flag', () => {
		// A hedged outage on the same sector: QSELT states no outage of its own,
		// so applyClosures can only flag it. Whichever order the two are named
		// in, the row's provenance must be the authoritative one.
		const hedged = `A9999/26 NOTAMN
Q) LFFF/QSELT/IV/BO/AE/000/085/4924N00312E029
A) LFOB B) 2609010000 C) 2609302359
E) FIS ON 'BEAUVAIS' INFO 119.800MHZ POTENTIALLY NOT AVBL`;
		for (const order of [`${hedged}\n\n${A5453_EN}`, `${A5453_EN}\n\n${hedged}`]) {
			load(order);
			expect(closedAirspaceLinks().get('LFOBFS2')?.source.notam.id).toBe('A5453/26');
		}
	});

	it('never draws a sector that still has a working radio', () => {
		// CHAMBERY 1 publishes Chambery Information AND Lyon Information
		// (fr-airspaces.json; BIARRITZ and STRASBOURG 1, 2 and 4 carry two as
		// well). Withdrawing one leaves the other answering in that very sector,
		// so a mark saying nobody answers there would be false. The panel still
		// strikes the withdrawn line, which is where the partial answer lives.
		const chambery = {
			...row('LFLBFS1', 'CHAMBERY 1', 'SIV', '123.705'),
			radio: [
				{ freq: '123.705', unit: 'LFLB CHAMBERY', call: 'CHAMBERY - INFORMATION' },
				{ freq: '135.53', unit: 'LFLL LYON SAINT EXUPERY', call: 'LYON - INFORMATION' },
			],
		} as unknown as Airspace;
		m.rows = [chambery];
		load(`A9998/26 NOTAMN
Q) LFMM/QSEAU/IV/BO/AE/000/115/4533N00556E025
A) LFLB B) 2609010000 C) 2609302359
E) 'CHAMBERY' INFO FREQ 123.705MHZ NOT AVBL :
- 'CHAMBERY' FIS AREA 1 CLOSED`);
		const radios = resolveAirspaceRadios(chambery).radios;
		// The precondition: the ladder did close the one line it names.
		expect(radios.map((r) => r.closed === true)).toEqual([true, false]);
		expect(closedAirspaceLinks().has('LFLBFS1')).toBe(false);
	});

	it('is empty with no briefing, and when no row carries the withdrawn value', () => {
		expect(closedAirspaceLinks().size).toBe(0);
		m.rows = [row('LFOBFS1', 'BEAUVAIS 1', 'SIV', '123.985')];
		load(A5453_EN);
		expect(closedAirspaceLinks().size).toBe(0);
	});
});
