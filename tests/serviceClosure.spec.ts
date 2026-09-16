/* The FIS service-closure extractor and its pure application ladder, pinned
 * on the REAL texts: the live A4694/26 (August, retrieved 2026-08-18), and
 * the June instance A3345/26 in both languages from the world fixtures (the
 * French half prints a COMMA decimal on the withdrawn frequency and carries
 * the corpus's own typo, "SI VOUS EVOLUE"). The Toulouse QSELT sibling pins
 * the hedged tier: "POTENTIALLY NOT AVBL" must flag, never close. */

import { describe, it, expect } from 'vitest';
import {
	applyClosures,
	closureFreqKey,
	parseServiceClosure,
	type ClosureCandidate,
} from '$lib/notam/serviceClosure';
import { isFlightInfoServiceQCode, isUnserviceableCondition } from '$lib/notam/qcode';
import { parseNotams, parseSections } from '$lib/notam/parser';
import { formatFreqMHz } from '$lib/format/radio';

const EN_AUG = `A4694/26 NOTAMN
Q) LFFF/QSEAU/IV/BO/AE/000/085/4924N00312E029
A) LFOB B) 2608010000 C) 2608312359
D) 01-07 09-12 14 16-26 28-31  H24
E) 'BEAUVAIS' INFO FREQ 119.800MHZ NOT AVBL :
- 'BEAUVAIS' FIS AREA 2 CLOSED
- CONTACT 'PARIS INFO' 125.700MHZ, OR IF IFR OR NGT VFR FLT CONTACT
'PARIS CTL' 128.275MHZ.`;

const FR_JUN = `A3345/26 NOTAMN
Q) LFFF/QSEAU/IV/BO/AE/000/085/4924N00312E029
A) LFOB B) 2606010000 C) 2606302359
E) FREQUENCE BEAUVAIS INFO 119,800MHZ INDISPONIBLE :
- SIV 2 BEAUVAIS FERME,
- CONTACTER PARIS INFO 125.700MHZ, OU SI VOUS EVOLUE EN IFR OU VFR DE
NUIT CONTACTEZ PARIS CONTROLE 128.275MHZ.`;

const EN_TOULOUSE = `A1576/26 NOTAMN
Q) LFBB/QSELT/IV/BO/A/000/999/4337N00121E005
A) LFBO B) 2603290600 C) 2610241800
D) 0600-1800
E) FIS ON 'TOULOUSE' INFO 121.250MHZ POTENTIALLY NOT AVBL :
- AN AUTOMATIC INFORMATION TRANSMITTER ON THIS FREQUENCE
- IN CASE OF EMERGENCY, CONTACT 'TOULOUSE' APP 129.305MHZ.`;

function eOf(raw: string): string {
	const n = parseNotams(raw)[0];
	return parseSections(n.fullContent).E ?? '';
}

describe('parseServiceClosure', () => {
	it('reads the live August NOTAM (EN)', () => {
		expect(parseServiceClosure(eOf(EN_AUG))).toEqual({
			freq: '119.800',
			substitutes: [
				{ label: 'PARIS INFO', freq: '125.700' },
				{ label: 'PARIS CTL', freq: '128.275' },
			],
		});
	});

	it('reads the June instance (FR), comma decimal normalised', () => {
		expect(parseServiceClosure(eOf(FR_JUN))).toEqual({
			freq: '119.800',
			substitutes: [
				{ label: 'PARIS INFO', freq: '125.700' },
				{ label: 'PARIS CONTROLE', freq: '128.275' },
			],
		});
	});

	it('still yields the value on the hedged Toulouse text (the TIER, not the grammar, keeps it a flag)', () => {
		const c = parseServiceClosure(eOf(EN_TOULOUSE));
		expect(c.freq).toBe('121.250');
		expect(c.substitutes).toEqual([{ label: 'TOULOUSE APP', freq: '129.305' }]);
	});

	it('yields no frequency when no unavailability is adjacent to one', () => {
		expect(parseServiceClosure('ATIS: 120.005MHZ REPLACES 120.000MHZ').freq).toBeNull();
		expect(parseServiceClosure('').freq).toBeNull();
	});
});

describe('the tier gate on the real Q-codes', () => {
	it('QSEAU is the authoritative closure family', () => {
		const n = parseNotams(EN_AUG)[0];
		expect(isFlightInfoServiceQCode(n.qCode)).toBe(true);
		expect(isUnserviceableCondition(n.qCode)).toBe(true);
		expect(n.serviceStatus).toBe('unserviceable');
	});

	it('QSELT asserts the outage by TEXT only, the flag tier', () => {
		const n = parseNotams(EN_TOULOUSE)[0];
		expect(isFlightInfoServiceQCode(n.qCode)).toBe(true);
		expect(isUnserviceableCondition(n.qCode)).toBe(false);
		// classifyServiceStatus reads "NOT AVBL" out of the text, which is
		// exactly why the closure path must gate on the CONDITION: the text
		// tier carries the hedge ("POTENTIALLY") the classifier cannot see.
		expect(n.serviceStatus).toBe('unserviceable');
	});
});

describe('closureFreqKey', () => {
	it('mirrors formatFreqMHz across separators and precision', () => {
		for (const raw of ['119.8', '119.80', '119.800', '119,8', '119,800']) {
			expect(closureFreqKey(raw)).toBe('119.800');
			expect(closureFreqKey(raw)).toBe(formatFreqMHz(raw.replace(',', '.')));
		}
		expect(closureFreqKey('')).toBe('');
	});
});

describe('applyClosures', () => {
	// The real dataset rows: sector 2 on the withdrawn value, sector 1 on its
	// approach frequency, which must never close off a 119.8 statement.
	const SIV2 = { freq: '119.8', unit: 'LFOB BEAUVAIS', call: 'BEAUVAIS - INFORMATION' };
	const SIV1 = { freq: '123.985', unit: 'APP BEAUVAIS Approche', call: 'BEAUVAIS - APPROCHE' };
	const closure = parseServiceClosure(eOf(EN_AUG));
	const cand = (over: Partial<ClosureCandidate<string>> = {}): ClosureCandidate<string> => ({
		source: 'A4694/26',
		closure,
		active: true,
		authoritative: true,
		...over,
	});

	it('closes exactly the rows publishing the stated frequency', () => {
		const r = applyClosures([SIV2, SIV1], [cand()]);
		expect(r.flags).toEqual([]);
		expect(r.radios[0].closed).toBe(true);
		expect(r.radios[0].closedBy).toEqual({
			source: 'A4694/26',
			substitutes: closure.substitutes,
		});
		expect(r.radios[1].closed).toBeUndefined();
		// The input rows are never mutated.
		expect(SIV2).toEqual({ freq: '119.8', unit: 'LFOB BEAUVAIS', call: 'BEAUVAIS - INFORMATION' });
	});

	it('flags instead of closing on an unknown schedule', () => {
		const r = applyClosures([SIV2], [cand({ active: null })]);
		expect(r.radios[0].closed).toBeUndefined();
		expect(r.flags).toEqual([{ source: 'A4694/26', freq: '119.800' }]);
	});

	it('does nothing while the schedule says the sector is staffed', () => {
		const r = applyClosures([SIV2], [cand({ active: false })]);
		expect(r.radios[0].closed).toBeUndefined();
		expect(r.flags).toEqual([]);
	});

	it('flags a text-only (hedged) outage, never closes on it', () => {
		const r = applyClosures([SIV2], [cand({ authoritative: false })]);
		expect(r.radios[0].closed).toBeUndefined();
		expect(r.flags).toHaveLength(1);
	});

	it('flags a statement with no frequency to narrow to', () => {
		const r = applyClosures(
			[SIV2],
			[cand({ closure: { freq: null, substitutes: [] } })],
		);
		expect(r.radios[0].closed).toBeUndefined();
		expect(r.flags).toEqual([{ source: 'A4694/26', freq: null }]);
	});

	it('flags a stated value no loaded row publishes (stale data)', () => {
		const r = applyClosures([SIV1], [cand()]);
		expect(r.radios[0].closed).toBeUndefined();
		expect(r.flags).toEqual([{ source: 'A4694/26', freq: '119.800' }]);
	});
});
