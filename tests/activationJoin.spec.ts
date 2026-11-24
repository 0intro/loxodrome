/* The activation join beyond France (state/notamLinks.svelte.ts
 * activatedAirspaceIds): an activation NOTAM of a linked State reaches the
 * loaded zones whose numbered designators it cites, under its own Q) FIR's
 * grammar. Over the world fixtures, per publisher, the share of its
 * activation NOTAMs that reach a loaded zone is pinned, which is what links
 * it (data/publishers.ts activation). A briefing silent on a zone speaks
 * only for a zone the join can reach (nav/alertVolumes.ts
 * volumeLinksActivations), so no activation NOTAM may name such a zone, by
 * its designator or by a name no reached row shares, without reaching it.
 * The datasets are the shipped ones. */

import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import type { Airspace } from '$lib/data/airspaces';
import { activationFirPublisher, linksActivations, PUBLISHER_TABLE, type Publisher } from '$lib/data/publishers';
import { airspaceVolumes, volumeLinksActivations } from '$lib/nav/alertVolumes';
import { parseNotams } from '$lib/notam';
import { designatorKey, notamPublisher, usSuaCitable } from '$lib/notam/airspaceIds';
import { isActivationQCode } from '$lib/notam/qcode';
import type { Notam } from '$lib/notam/types';

vi.mock('$lib/state/data.svelte', async (importOriginal) => {
	const actual = await importOriginal<typeof import('$lib/state/data.svelte')>();
	const fs = await import('node:fs');
	const { rowToAirspace } = await import('$lib/data/airspaces');
	const all: Airspace[] = [];
	for (const file of fs.readdirSync('public/data')) {
		const m = /^([a-z]+)-airspaces\.json$/.exec(file);
		if (!m) {
			continue;
		}
		const d = JSON.parse(fs.readFileSync(`public/data/${file}`, 'utf8')) as { rows: unknown[][] };
		for (const r of d.rows) {
			const a = rowToAirspace(r, m[1] as Publisher);
			if (a) {
				all.push(a);
			}
		}
	}
	return { ...actual, getAirspaces: () => all, dataState: { ...actual.dataState, airspacesLoaded: true } };
});

const { getAirspaces } = await import('$lib/state/data.svelte');
const { activatedAirspaceIds } = await import('$lib/state/notamLinks.svelte');

const FIXTURES = ['world-en-20260610.txt', 'world-en-20261122.txt'] as const;

/** The FIRs a publisher's activation NOTAMs come under: its NOTAM routing,
 *  else its activation's own (the FAA's). */
function routing(p: (typeof PUBLISHER_TABLE)[number]): readonly string[] {
	return p.firs.length > 0 ? p.firs : 'activation' in p && typeof p.activation === 'object' ? p.activation.firs : [];
}

/** A publisher's activation NOTAMs in a world fixture, each once: the raw
 *  text cut on the NOTAM header and kept by its Q) FIR before parsing, as
 *  ids collide across States in a world file. */
function activations(fixture: string, p: (typeof PUBLISHER_TABLE)[number]): Notam[] {
	const text = readFileSync(`tests/fixtures/${fixture}`, 'utf-8');
	const blocks = text.split(/\n(?=[A-Z]\d{4}\/\d{2} NOTAM[NRC]\b)/).filter((b) => {
		const m = /(^|\n)Q\)\s*([A-Z]{4})/.exec(b);
		return m !== null && routing(p).some((f) => m[2].startsWith(f));
	});
	const seen = new Set<string>();
	return parseNotams(blocks.join('\n\n')).filter((n) => {
		const fir = n.qualifier?.fir ?? '';
		if (seen.has(n.id) || !isActivationQCode(n.qCode) || (notamPublisher(fir, n.icaoCodes) ?? activationFirPublisher(fir)) !== p.id) {
			return false;
		}
		seen.add(n.id);
		return true;
	});
}

const ABROAD = PUBLISHER_TABLE.filter((p) => routing(p).length > 0 && p.id !== 'fr');

/** Per fixture and publisher: its activation NOTAMs, and those that reach a
 *  loaded zone. A publisher with none reached stays unlinked. */
const REACH: Record<(typeof FIXTURES)[number], Record<string, [number, number]>> = {
	'world-en-20260610.txt': {
		faa: [300, 72], uk: [125, 62], es: [247, 55], be: [59, 13], de: [42, 41], at: [20, 18], ge: [7, 7], nl: [86, 82],
		ro: [317, 179], fi: [81, 65], it: [77, 10], sk: [0, 0], ie: [18, 12], rs: [38, 0], xk: [0, 0], is: [9, 0], se: [16, 4],
	},
	'world-en-20261122.txt': {
		faa: [106, 77], uk: [60, 31], es: [294, 44], be: [33, 18], de: [7, 5], at: [13, 12], ge: [5, 5], nl: [7, 7],
		ro: [255, 153], fi: [47, 33], it: [81, 19], sk: [2, 0], ie: [8, 5], rs: [33, 0], xk: [0, 0], is: [1, 0], se: [10, 0],
	},
};

const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** A zone's designator in any spacing a NOTAM may write it: the key's
 *  parts apart ("EG D61" for EGD061), the FAA's without its hyphen ("W13A
 *  HIGH" for W-13A HIGH). Null for a zone with no designator. */
function looseCite(id: string, publisher: string): RegExp | null {
	if (publisher === 'faa') {
		const m = /^([RWP])-(\d{2,4})([A-Z]{0,2})(?: ([A-Z]+))?$/.exec(id);
		return m ? new RegExp(`\\b${m[1]}-?${m[2]}${m[3]}${m[4] ? `\\s+${m[4]}` : ''}\\b`) : null;
	}
	const m = /^([A-Z]{2})([A-Z]+?)(\d+)([A-Z0-9]*)$/.exec(designatorKey(id) ?? '');
	return m ? new RegExp(`\\b${m[1]}[\\s-]?${m[2]}[\\s-]?0*${m[3]}${m[4] ? `[\\s-]?${esc(m[4])}` : ''}\\b`) : null;
}

describe('the activation join beyond France', () => {
	for (const fixture of FIXTURES) {
		it(`reaches each linked State's zones from its activation NOTAMs (${fixture})`, () => {
			const got: Record<string, [number, number]> = {};
			for (const p of ABROAD) {
				const list = activations(fixture, p);
				got[p.id] = [list.length, list.filter((n) => activatedAirspaceIds(n).length > 0).length];
			}
			expect(got).toEqual(REACH[fixture]);
		});

		it(`reaches a State's own rows alone (${fixture})`, () => {
			const source = new Map((getAirspaces() ?? []).map((a) => [a.id, a.source]));
			for (const p of ABROAD) {
				for (const n of activations(fixture, p)) {
					for (const id of activatedAirspaceIds(n)) {
						expect([n.id, id, source.get(id)]).toEqual([n.id, id, p.id]);
					}
				}
			}
		});

		it(`never leaves a zone a briefing speaks for unreached (${fixture})`, () => {
			const misses: string[] = [];
			for (const p of ABROAD.filter((x) => linksActivations(x.id))) {
				const volumes = airspaceVolumes((getAirspaces() ?? []).filter((a) => a.source === p.id));
				// The zones a silent briefing reads inactive: linked, and by NOTAM.
				const spoken = volumes.filter((v) => volumeLinksActivations(v) && v.activity.rules.some((r) => r.mode === 'notam'));
				for (const n of activations(fixture, p)) {
					const reached = new Set(activatedAirspaceIds(n));
					const names = new Set(volumes.filter((v) => reached.has(v.id)).map((v) => v.name.toUpperCase()));
					const e = (/\bE\)([\s\S]*?)(?:\b[FG]\)|$)/.exec(n.fullContent)?.[1] ?? '').toUpperCase();
					for (const v of spoken) {
						if (reached.has(v.id)) {
							continue;
						}
						const cited = looseCite(v.id, p.id)?.test(e) ?? false;
						const named = v.name.length >= 5 && !names.has(v.name.toUpperCase()) && new RegExp(`\\b${esc(v.name.toUpperCase())}\\b`).test(e);
						if (cited || named) {
							misses.push(`${n.id} ${v.id}`);
						}
					}
				}
			}
			expect(misses).toEqual([]);
		});
	}

	it('links the States it reaches, and Serbia, Iceland, Slovakia and Kosovo none', () => {
		expect(ABROAD.filter((p) => linksActivations(p.id)).map((p) => p.id)).toEqual([
			'uk', 'es', 'be', 'de', 'at', 'faa', 'ge', 'nl', 'ro', 'fi', 'it', 'ie', 'se',
		]);
	});

	it('speaks for a zone the join can reach', () => {
		const row = (id: string) => (getAirspaces() ?? []).find((a) => a.id === id);
		const linked = (id: string) => {
			const a = row(id);
			return a ? airspaceVolumes([a]).map(volumeLinksActivations)[0] : undefined;
		};
		// Numbered designators of linked States, the FAA's, and France's own.
		expect([linked('EGD061'), linked('EDR117'), linked('R-5302B'), linked('LFR174')]).toEqual([true, true, true, true]);
		// Named outside the grammar, and a State left unlinked.
		expect([linked('EGVMIL001'), linked('EDRPEENEMU'), linked('LOTRASHR')]).toEqual([false, false, false]);
		const serbian = (getAirspaces() ?? []).find((a) => a.source === 'rs' && designatorKey(a.id) !== null);
		expect(serbian && airspaceVolumes([serbian]).map(volumeLinksActivations)[0]).toBe(false);
	});

	it('activates the FAA areas a NOTAM cites, a part where it names one', () => {
		const ids = (fir: string, e: string) =>
			activatedAirspaceIds(
				parseNotams(`A1234/26 NOTAMN
Q) ${fir}/QRDCA/IV/BO/W/000/230/2706N08108W050
A) ${fir} B) 2611230800 C) 2611231700
E) ${e}`)[0],
			);
		expect(ids('KZDC', 'AIRSPACE R5302B ACT 100FT AGL-14000FT')).toEqual(['R-5302B']);
		expect(ids('KZMA', 'AIRSPACE W13A HIGH ACT FL300-FL500')).toEqual(['W-13A HIGH']);
		expect(ids('KZMA', 'AIRSPACE W13A ACT')).toEqual(['W-13A HIGH', 'W-13A LOW']);
		expect(ids('PAZA', 'AIRSPACE YUKON 3B MOA ACT')).toEqual(['YUKON 3B MOA']);
		// An FAA zone the grammar names is one a silent briefing speaks for.
		expect(['R-5302B', 'W-13A HIGH', 'YUKON 3B MOA', 'MMTY'].map(usSuaCitable)).toEqual([true, true, true, false]);
	});

	it('activates the Italian zone a NOTAM cites with its slash sub-letter', () => {
		const [n] = parseNotams(`W3642/26 NOTAMN
Q) LIRR/QRRCA/IV/BO/W/000/080/4140N01450E005
A) LIRR B) 2611230800 C) 2611231600
E) RESTRICTED AREA LI R309/A - CASACALENDA ACTIVATED REF AIP ENR 5.1.2-34`);
		expect(activatedAirspaceIds(n)).toEqual(['LIR309A']);
	});

	it('activates the cross-border area a French NOTAM cites, on the Belgian row holding it', () => {
		// R3491/26 as the 2026-11-22 world briefing prints it.
		const [n] = parseNotams(`R3491/26 NOTAMN
Q) LFFF/QRRCA/IV/BO/W/065/115/4950N00442E024
A) LFFF B) 2611230800 C) 2611232030
E) LF-CBA16B ACT.
F) FL065 G) FL115`);
		expect(activatedAirspaceIds(n)).toEqual(['BE-LFCBA16B-CROSS-BORDER-AREA-16-BRAVO']);
	});

	it('activates the UK danger area a NOTAM cites, under its own grammar', () => {
		const [n] = parseNotams(`B1234/26 NOTAMN
Q) EGTT/QRDCA/IV/BO/W/000/030/5041N00320W003
A) EGTT B) 2611230800 C) 2611231700
E) DANGER AREA EGD061 WOODBURY COMMON ACTIVATED.
F) SFC G) 3000FT AMSL`);
		expect(activatedAirspaceIds(n)).toEqual(['EGD061']);
	});
});
