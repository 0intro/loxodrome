/* notamReferenceLinks: the NOTAM a NOTAMR replaces, the ones it cites and
 * the ones citing it, resolved within the citing NOTAM's State. A number is
 * unique only within a State (the US numbers per aerodrome), and the parser
 * gives the bare id to the first NOTAM of a number it meets, so a world
 * briefing holds a Ukrainian NOTAMR replacing "A0086/25" beside American
 * NOTAMs numbered A0086/25 (World-20260512). */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { parseNotams } from '$lib/notam';
import type { Notam } from '$lib/notam/types';
import { filter } from '$lib/state/filter.svelte';
import { notamState } from '$lib/state/notam.svelte';
import { notamReferenceLinks } from '$lib/state/notamLinks.svelte';

const KECG = `A0086/25 NOTAMN
Q) KZDC/QPICH/I/NBO/A/000/999/3616N07610W005
A) KECG B) 2504161408 C) 2704161408EST
E) ECG IAP ELIZABETH CITY CG AIR STATION/RGNL, ELIZABETH CITY, NC.
`;
const KMKL = `A0086/25 NOTAMN
Q) KZME/QPICH/I/NBO/A/000/999/3536N08855W005
A) KMKL B) 2503111302 C) 2703111302EST
E) MKL IAP JACKSON RGNL, JACKSON, TN.
`;
const UKHH_R = `A0010/26 NOTAMR A0086/25
Q) UKDV/QNAAS/IV/NBO/AE/000/999/4956N03617E025
A) UKHH B) 2603100905 C) 2606092359EST
E) RADIONAVIGATION AIDS OUT OF SERVICE.
PERIODIC FLIGHT CHECKS NOT PERFORMED.
`;
const UKHH_N = `A0086/25 NOTAMN
Q) UKDV/QNAAS/IV/NBO/AE/000/999/4956N03617E025
A) UKHH B) 2512100905 C) 2603100905
E) RADIONAVIGATION AIDS OUT OF SERVICE.
`;
const KMKL_R = `A0101/25 NOTAMR A0086/25
Q) KZME/QPICH/I/NBO/A/000/999/3536N08855W005
A) KMKL B) 2506111302 C) 2703111302EST
E) MKL IAP JACKSON RGNL, JACKSON, TN. AMENDED.
`;

function seed(...texts: string[]): Notam[] {
	notamState.notams = parseNotams(texts.join('\n'));
	notamState.parsedAt = Date.now();
	return notamState.notams;
}

function byId(id: string): Notam {
	const n = notamState.notams.find((x) => x.id === id);
	expect(n, id).toBeDefined();
	return n!;
}

beforeEach(() => {
	notamState.notams = [];
	notamState.parsedAt = 0;
	// The American NOTAMs are IFR only, which the default VFR rules hide.
	filter.trafficMode = 'all';
});

afterEach(() => {
	filter.trafficMode = 'vfr';
	filter.query = '';
});

describe('notamReferenceLinks', () => {
	it('never resolves a number to another State\'s NOTAM', () => {
		seed(KECG, UKHH_R);
		const r = notamReferenceLinks(byId('A0010/26'));
		expect(r.replaces).toEqual({ id: 'A0086/25', loaded: null, hidden: false });
		expect(notamReferenceLinks(byId('A0086/25')).referencedBy).toEqual([]);
	});

	it('resolves it to the NOTAM of the citing State', () => {
		// The American NOTAM came first and holds the bare id, the Ukrainian
		// one is labelled with its A) location.
		seed(KECG, UKHH_N, UKHH_R);
		const r = notamReferenceLinks(byId('A0010/26'));
		expect(r.replaces?.loaded?.notam.id).toBe('UKHH-A0086/25');
		const back = notamReferenceLinks(byId('UKHH-A0086/25')).referencedBy;
		expect(back.map((it) => it.notam.id)).toEqual(['A0010/26']);
		expect(notamReferenceLinks(byId('A0086/25')).referencedBy).toEqual([]);
	});

	it('says a cited NOTAM a filter hides is hidden', () => {
		seed(
			`A0019/26 NOTAMN
Q) UKDV/QMRLC/IV/NBO/A/000/999/4956N03617E005
A) UKHH B) 2603100905 C) 2606092359
E) RWY 07/25 CLSD.
`,
			`A0020/26 NOTAMN
Q) UKDV/QNAAS/IV/NBO/AE/000/999/4956N03617E025
A) UKHH B) 2603100905 C) 2606092359
E) RADIONAVIGATION AIDS OUT OF SERVICE. REF NOTAM A0019/26 AND A0018/26.
`,
		);
		filter.query = 'radionavigation';
		const r = notamReferenceLinks(byId('A0020/26'));
		expect(r.references).toEqual([
			{ id: 'A0019/26', loaded: null, hidden: true },
			{ id: 'A0018/26', loaded: null, hidden: false },
		]);
	});

	it('reads an American number at the citing aerodrome', () => {
		seed(KECG, KMKL, KMKL_R);
		const r = notamReferenceLinks(byId('A0101/25'));
		expect(r.replaces?.loaded?.notam.id).toBe('KMKL-A0086/25');
		expect(notamReferenceLinks(byId('A0086/25')).referencedBy).toEqual([]);
	});
});
