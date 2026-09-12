import { describe, it, expect } from 'vitest';
import { parseNotams } from '$lib/notam';
import { extractActivatedSups, extractAipSups } from '$lib/notam/aipSup';
import { isReferenceContext } from '$lib/notam/citationContext';
import { activatedAirspaceIds, isActiveTrigger } from '$lib/state/notamLinks.svelte';

// Real corpus NOTAMs that CREATE an inline ZRT and only REFERENCE other areas /
// SUPs (as exceptions or sources). They must not read as activating those.
const R0566 = `R0566/26
Q) LFFF/QRTCA/IV/BO/W/000/015/5016N00130E009
A) LFFF
B) 2603150000 C) 2612312359
E) TEMPORARY RESTRICTED AREA (ZRT) 'ZRT SOMME 1' :
-DESCRIPTION :
-UNMANNED ACFT FLIGHTS, BEYOND VISUAL LINE OF SIGHT,
-ZRT MAY BE ACTIVATED H24 WITH A 24HR PN,
-ZRT CENTRE : RDL195/17NM LFAT ARP
1-LATERAL LIMITS :
500803N 0012616E
502318N 0013347E
502136N 0013816E
500736N 0013008E
500803N 0012616E
2-VERTICAL LIMITS :
SR-30 / SS+30 : SFC / 500FT ASFC
SS+30 / SR-30 : SFC / 1500FT AMSL
3-STATUS :
TEMPORARY RESTRICTED AREA (ZRT) REPLACES THE OVERLAPPING AIRSPACE
PARTS, EXCEPT RESTRICTED AREAS LF-R400E 'DEP AULT' AND LF-R400D 'DEP
HOURDEL' (SUP AIP 215/25).
F) SFC
G) 1500FT AMSL
`;

const R1552 = `R1552/26
Q) LFBB/QRTCA/IV/BO/AW/000/015/4532N00105W006
A) LFDK
B) 2606010000 C) 2611102359
D) MON-FRI H24
E) CREATION OF A TEMPORARY RESTRICTED AREA (ZRT) 'ZRT CESA SOULAC'
OVER
'SOULAC SUR MER' AERODROME FOR UNMANNED ACFT FLIGHTS.
THE 'ZRT CESA SOULAC' WILL BE ACTIVATED FOR JOINING THE 'ZRT CESA
NORD ETE' PUBLISHED BY AIP SUP 188/25.
1- LATERAL LIMITS :
5NM RADIUS CIRCLE CENTRED ON 453156N 0010513W EXC THE LF-D 18 A4 AND
THE 'ZRT CESA NORD ETE' WHEN IT IS ACTIVE (REF AIP SUP188/25)
2- STATUS :
TEMPORARY RESTRICTED AREA WHICH REPLACES OVERLAPPING AIRSPACE.
F) SFC
G) 1500FT AMSL
`;

// Genuine activations that MUST stay linked.
const ACT_OCHEY = `R0916/26
Q) LFEE/QRTCA/IV/BO/AW/000/075/4835N00557E007
A) LFSO
B) 2603300518 C) 2609301718
E) TEMPO RESTRICTED AREA (ZRT) 'COUTEAU DELTA' ON NANCY OCHEY AD :
ZRT, WHEN ACT, REPLACES OVERLAPPING AIRSPACES.
ZRT OCHEY (AIP SUP 167/25).
F) SFC
G) FL075
`;
const ACT_ENGHIEN = `LFFA-R2112/25
DU: 13 09 2025 00:00 AU: 15 04 2026 23:59
A) LFFE
Q) LFFF / QRRCA / IV / BO / AW / 000/015 / 4904N00220E003
E) ZONE REGLEMENTEE LF-R262 'ENGHIEN' MODIFIEE
F) SFC
G) 1500FT AMSL
`;

describe('isReferenceContext', () => {
	it('flags citations in an EXCEPT clause', () => {
		const t = 'REPLACES AIRSPACE EXCEPT LF-R400E (SUP AIP 215/25).';
		expect(isReferenceContext(t, t.indexOf('LF-R400E'))).toBe(true);
		expect(isReferenceContext(t, t.indexOf('SUP AIP'))).toBe(true);
	});
	it('flags a PUBLISHED BY / REF reference', () => {
		const t = "JOINING 'X' PUBLISHED BY AIP SUP 188/25.";
		expect(isReferenceContext(t, t.indexOf('AIP SUP'))).toBe(true);
	});
	it('keeps a plain activation citation', () => {
		const t = "AIP SUP 093/26 : 'ZRT LOURDES' ACT";
		expect(isReferenceContext(t, t.indexOf('AIP SUP'))).toBe(false);
	});
	it('does not let a keyword bleed past a clause boundary', () => {
		const t = 'ACT EXCEPT WEEKENDS. ZONE LF-R45A ACTIVATED';
		expect(isReferenceContext(t, t.indexOf('LF-R45A'))).toBe(false);
	});
});

describe('extractActivatedSups', () => {
	it('drops the excepted SUP but the raw extractor still lists it', () => {
		const n = parseNotams(R0566)[0];
		expect(extractAipSups(n.fullContent).map((r) => r.display)).toContain('AIP SUP 215/25');
		expect(extractActivatedSups(n.fullContent)).toEqual([]);
	});
	it('drops a "PUBLISHED BY" SUP', () => {
		const n = parseNotams(R1552)[0];
		expect(extractActivatedSups(n.fullContent)).toEqual([]);
	});
	it('keeps a genuine activation SUP', () => {
		const n = parseNotams(ACT_OCHEY)[0];
		expect(extractActivatedSups(n.fullContent).map((r) => r.display)).toEqual([
			'AIP SUP 167/25',
		]);
	});
});

describe('trigger / activation flag on reference-only NOTAMs', () => {
	it('R0566/26: excepted ids + parenthetical SUP are not activations', () => {
		const n = parseNotams(R0566)[0];
		expect(activatedAirspaceIds(n)).toEqual([]);
		expect(isActiveTrigger(n)).toBe(false);
	});
	it('R1552/26: "PUBLISHED BY" SUP is not an activation', () => {
		const n = parseNotams(R1552)[0];
		expect(isActiveTrigger(n)).toBe(false);
	});
	it('a genuine SUP activation is still flagged', () => {
		expect(isActiveTrigger(parseNotams(ACT_OCHEY)[0])).toBe(true);
	});
	it('a genuine airspace activation still resolves its id', () => {
		const n = parseNotams(ACT_ENGHIEN)[0];
		expect(activatedAirspaceIds(n)).toEqual(['LFR262']);
		expect(isActiveTrigger(n)).toBe(true);
	});
});

describe('isReferenceContext clause boundaries', () => {
	it('a decimal point inside a distance is not a clause boundary', () => {
		const text = 'REPLACES OVERLAPPING AIRSPACE EXCEPT AREAS WITHIN 1.5NM OF LF-R400E ACT';
		expect(isReferenceContext(text, text.indexOf('LF-R400E'))).toBe(true);
	});

	it('a sentence-final period still bounds the clause', () => {
		const text = 'EXCEPT AREA ALPHA. ACTIVATION OF LF-R400E';
		expect(isReferenceContext(text, text.indexOf('LF-R400E'))).toBe(false);
	});
});
