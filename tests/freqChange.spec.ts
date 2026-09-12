import { describe, it, expect } from 'vitest';
import {
	allFreqs,
	allReplacements,
	freqReplacement,
	parseFreqAssignments,
	singleFreq,
} from '$lib/notam/freqChange';
import { isFrequencyChangeCondition, isFrequencyChangeQCode } from '$lib/notam/qcode';

// The E) text each real NOTAM (both languages) the feature was built against,
// verbatim. The parser runs the same whitespace-normalised or raw text, so the
// line breaks here are exercised on purpose.

describe('isFrequencyChangeCondition', () => {
	it('flags the CF (operating frequency changed) condition', () => {
		// Every sample NOTAM below (LFPB, LFPM, LFQB, SEINE SIV) carries QCACF.
		expect(isFrequencyChangeCondition('QCACF')).toBe(true);
	});

	it('flags the ME (frequency changed) condition', () => {
		expect(isFrequencyChangeCondition('QNMME')).toBe(true);
	});

	it('rejects other conditions and malformed codes', () => {
		expect(isFrequencyChangeCondition('QCAAS')).toBe(false); // unserviceable
		expect(isFrequencyChangeCondition('QRRCA')).toBe(false); // activated
		expect(isFrequencyChangeCondition('CF')).toBe(false);
		expect(isFrequencyChangeCondition('')).toBe(false);
	});

	it('stays the CONDITION test: QCACS is not one', () => {
		// The value-LESS notice keys on this, and "installed" does not say a
		// published value moved.
		expect(isFrequencyChangeCondition('QCACS')).toBe(false);
	});
});

describe('isFrequencyChangeQCode', () => {
	it('admits the explicit conditions whatever the subject', () => {
		expect(isFrequencyChangeQCode('QCACF')).toBe(true);
		expect(isFrequencyChangeQCode('QSTCF')).toBe(true);
		expect(isFrequencyChangeQCode('QNMME')).toBe(true);
	});

	it('admits the air/ground facility INSTALLED filing (QCACS)', () => {
		// How the SIA files its 8.33 kHz channel conversions: E3291/26 LFPT
		// below, A1455/26 LFBO, C1108/26 LFLY.
		expect(isFrequencyChangeQCode('QCACS')).toBe(true);
	});

	it('does not let CS on another subject reach the radios', () => {
		expect(isFrequencyChangeQCode('QCDCS')).toBe(false); // CPDLC installed
		expect(isFrequencyChangeQCode('QCSCS')).toBe(false); // secondary radar
		expect(isFrequencyChangeQCode('QIGCS')).toBe(false); // glide path
		expect(isFrequencyChangeQCode('QAPCS')).toBe(false); // reporting point
	});

	it('rejects other conditions and malformed codes', () => {
		expect(isFrequencyChangeQCode('QCAAS')).toBe(false);
		expect(isFrequencyChangeQCode('QCACS ')).toBe(false);
		expect(isFrequencyChangeQCode('CACS')).toBe(false);
		expect(isFrequencyChangeQCode('')).toBe(false);
	});
});

// ------------------------------------------------------------------ //
// E3291/26 - LFPT, the 8.33 kHz conversion: a labelled list whose      //
// rows each state the value they take over from, with the connector   //
// spelled AU LIEU DE / INSTEAD OF rather than REMPLACE / REPLACES.     //
// The English half is the SOFIA text verbatim, mid-word wrap included. //
// ------------------------------------------------------------------ //
describe('E3291/26 LFPT (labelled list, INSTEAD OF connector)', () => {
	const en = `NEW FREQUENCIES :
- PONTOISE TWR : 121.205MHZ INSTEAD OF 121.200MHZ
- PONTOISE GONIO : 121.205MHZ INSTEAD OF 121.200MHZ
- PONTOISE ATIS : 124.130MHZ INSTEAD OF 124.125MHZ
REF AIP FRANCE AD 2 LFPT APP 01, AD 2 LFPT.AD 2.18, AD 2 LFPT ADC
01, AD 2
LFPT STAR RWY ALL RNAV, AD 2 LFPT IAC`;
	const fr = `NOUVELLES FREQUENCES :
- PONTOISE TWR : 121.205MHZ AU LIEU DE 121.200MHZ
- PONTOISE GONIO : 121.205MHZ AU LIEU DE 121.200MHZ
- PONTOISE ATIS : 124.130MHZ AU LIEU DE 124.125MHZ
REF AIP FRANCE AD 2 LFPT APP 01, AD 2 LFPT.AD 2.18, AD 2 LFPT ADC 01, AD 2 LFPT STAR RWY ALL RNAV, AD 2 LFPT IAC`;

	const assignments = [
		{ label: 'PONTOISE TWR', freq: '121.205', was: '121.200' },
		{ label: 'PONTOISE GONIO', freq: '121.205', was: '121.200' },
		{ label: 'PONTOISE ATIS', freq: '124.130', was: '124.125' },
	];

	it('EN: each row carries the frequency it takes over from', () => {
		expect(parseFreqAssignments(en)).toEqual(assignments);
	});

	it('FR: same values from the French connector', () => {
		expect(parseFreqAssignments(fr)).toEqual(assignments);
	});

	it('collapses the gonio restatement: two moves, not three', () => {
		// The SIA publishes the direction finder on the tower's own channel, so
		// the GONIO row repeats the TWR pair verbatim. One channel change.
		const pairs = [
			{ freq: '121.205', was: '121.200' },
			{ freq: '124.130', was: '124.125' },
		];
		expect(allReplacements(en)).toEqual(pairs);
		expect(allReplacements(fr)).toEqual(pairs);
	});

	it('does not mine the AD 2.18 / ADC 01 chart references as frequencies', () => {
		expect(allFreqs(en)).toEqual(['121.205', '121.200', '121.205', '121.200', '124.130', '124.125']);
		expect(allFreqs(fr)).toEqual(allFreqs(en));
	});

	it('abstains from the single-value form (several distinct values)', () => {
		expect(singleFreq(en)).toBeNull();
		expect(singleFreq(fr)).toBeNull();
	});

	it('gives the same result on whitespace-normalised text', () => {
		expect(parseFreqAssignments(en.replace(/\s+/g, ' '))).toEqual(parseFreqAssignments(en));
		expect(allReplacements(en.replace(/\s+/g, ' '))).toEqual(allReplacements(en));
	});
});

// ------------------------------------------------------------------ //
// The document-level shape: one pair under a header naming every       //
// service that shares the channel. No per-row label to read, so the    //
// old value is what places it (B0367/26 LFOK, C0562/26 LFAT).          //
// ------------------------------------------------------------------ //
describe('document-level replacement (READ / LIRE)', () => {
	const en =
		'FREQUENCIES A/A, VDF, AFIS AND TWR VATRY MODIFIED : READ 129.405MHZ INSTEAD OF 129.400MHZ';
	const fr =
		'FREQUENCES A/A, VDF, AFIS ET TWR VATRY MODIFIEES : LIRE 129.405MHZ AU LIEU DE 129.400MHZ';

	it('EN / FR: one pair, placed by the value it replaces', () => {
		expect(allReplacements(en)).toEqual([{ freq: '129.405', was: '129.400' }]);
		expect(allReplacements(fr)).toEqual([{ freq: '129.405', was: '129.400' }]);
	});

	it('reads no labelled assignment: the header names four services, not one', () => {
		// A value introduced by READ / LIRE is deliberately outside the labelled
		// grammar, so "AFIS ET TWR VATRY MODIFIEES" can never narrow a change
		// that concerns the whole channel to one row.
		expect(parseFreqAssignments(en)).toEqual([]);
		expect(parseFreqAssignments(fr)).toEqual([]);
	});

	it('reads a connector the State wrapped mid-phrase', () => {
		// C0562/26 (LFAT) breaks the English line between INSTEAD and OF while
		// its French half runs on: a literal space would read one language only.
		const wrapped =
			'A/A, VDF AND LE TOUQUET TWR FREQUENCIES : READ 118.455MHZ INSTEAD \nOF 118.450MHZ';
		const oneLine =
			'FREQUENCES A/A, VDF ET TWR LE TOUQUET : LIRE 118.455MHZ AU LIEU DE 118.450MHZ';
		const pair = [{ freq: '118.455', was: '118.450' }];
		expect(allReplacements(wrapped)).toEqual(pair);
		expect(allReplacements(oneLine)).toEqual(pair);
	});

	it('reads a connector that names the thing before its value', () => {
		// C0438/26 swaps the two Warsaw FIS sectors, writing the word FREQ on
		// both sides of the connector. Both pairs, in order, and the swap is
		// what the resolver's own "a moved row is out of reach" guard needs.
		const warsaw =
			'UPDATE INFORMATION ABOUT FREQ FIS WARSZAWA POLNOC I AND FIS WARSZAWA POLNOC II: ' +
			'- FIS WARSZAWA POLNOC I: SHOULD BE FREQ 123.975MHZ INSTEAD OF FREQ 118.775MHZ, ' +
			'- FIS WARSZAWA POLNOC II: SHOULD BE FREQ 118.775MHZ INSTEAD OF FREQ 123.975MHZ.';
		expect(allReplacements(warsaw)).toEqual([
			{ freq: '123.975', was: '118.775' },
			{ freq: '118.775', was: '123.975' },
		]);
		expect(allReplacements('READ 118.500MHZ INSTEAD OF THE FREQUENCY 118.450MHZ')).toEqual([
			{ freq: '118.500', was: '118.450' },
		]);
	});

	it('will not bridge two clauses to find an old value', () => {
		// The noise word is a CLOSED set for this reason: a run of arbitrary
		// words would pair a new value with a contact frequency further along
		// the sentence, and a wrong prior value moves a wrong row.
		expect(
			allReplacements('READ 118.500MHZ INSTEAD OF THE PREVIOUS ARRANGEMENT, CONTACT PARIS INFO 125.700MHZ'),
		).toEqual([]);
		// An old value attributed to ANOTHER unit is a handover, not a
		// conversion, and is left for the caller to flag.
		expect(
			allReplacements('READ STRASBOURG APPROACH 134.575MHZ INSTEAD OF LORRAINE APPROACH 119.125MHZ'),
		).toEqual([]);
	});

	it('keeps several pairs in one text (A0613/26 LFRN moves two rows)', () => {
		const rennes =
			'RENNES TWR FREQUENCIES MODIFIED : RENNES GND : READ 121.730MHZ INSTEAD OF ' +
			'121.725MHZ RENNES TWR : READ 120.505MHZ INSTEAD OF 120.500MHZ REF : AD2 LFRN COM 01';
		expect(allReplacements(rennes)).toEqual([
			{ freq: '121.730', was: '121.725' },
			{ freq: '120.505', was: '120.500' },
		]);
	});
});

// ------------------------------------------------------------------ //
// E1868/26 - SEINE SIV, single new frequency for sectors 4 and 5.     //
// ------------------------------------------------------------------ //
describe('E1868/26 SEINE SIV (single frequency)', () => {
	const en = 'FIS SEINE INFORMATION (FIS 4 AND 5) FREQ : 120.330MHZ';
	const fr = 'FREQ SIV SEINE INFORMATION (SIV 4 ET 5) : 120.330MHZ';

	it('EN: one new frequency, no labelled aerodrome service', () => {
		expect(singleFreq(en)).toBe('120.330');
		expect(freqReplacement(en)).toBeNull();
		expect(parseFreqAssignments(en)).toEqual([]);
	});

	it('FR: one new frequency, no labelled aerodrome service', () => {
		expect(singleFreq(fr)).toBe('120.330');
		expect(freqReplacement(fr)).toBeNull();
		expect(parseFreqAssignments(fr)).toEqual([]);
	});

	it('does not mine the sector-count digits as frequencies', () => {
		expect(allFreqs(en)).toEqual(['120.330']);
		expect(allFreqs(fr)).toEqual(['120.330']);
	});
});

// ------------------------------------------------------------------ //
// C2025/26 - SEINE SIV, "READ <new> (INSTEAD OF <old>)": move only    //
// the row currently on 120.325 to 120.330.                           //
// ------------------------------------------------------------------ //
describe('C2025/26 SEINE SIV (read new instead of old)', () => {
	const en =
		'SEINE INFORMATION FREQ : READ 120.330MHZ (INSTEAD OF 120.325MHZ)\n' +
		'REFERENCE AIP FRANCE AD 2 LFQB ATT 01.';
	const fr =
		'FREQ SEINE INFORMATION : LIRE 120.330MHZ (AU LIEU DE 120.325MHZ)\n' +
		'REFERENCE AIP FRANCE AD 2 LFQB ATT 01.';

	it('EN: extracts the new/old pair so only 120.325 is replaced', () => {
		expect(freqReplacement(en)).toEqual({ freq: '120.330', was: '120.325' });
	});

	it('FR: extracts the new/old pair so only 120.325 is replaced', () => {
		expect(freqReplacement(fr)).toEqual({ freq: '120.330', was: '120.325' });
	});

	it('is not mistaken for a single-frequency change (two values present)', () => {
		// singleFreq must abstain here: the resolver keys on the old value, not
		// the sole-row fallback, so unrelated SEINE sectors stay untouched.
		expect(singleFreq(en)).toBeNull();
		expect(singleFreq(fr)).toBeNull();
	});

	it('carries no labelled aerodrome assignment', () => {
		expect(parseFreqAssignments(en)).toEqual([]);
		expect(parseFreqAssignments(fr)).toEqual([]);
	});
});

// ------------------------------------------------------------------ //
// A2706/26 - LFPB, REPLACES / REMPLACE table (new + old per service). //
// ------------------------------------------------------------------ //
describe('A2706/26 LFPB (REPLACES table)', () => {
	const en = `FREQ CHANGED - REF AIP FRANCE AD2 LFPB ADC 01:
ATIS:     120.005MHZ REPLACES 120.000MHZ
DELIVERY: 121.955MHZ REPLACES 121.950MHZ
GND:      121.905MHZ REPLACES 121.900MHZ
TWR:      118.930MHZ REPLACES 118.925MHZ`;
	const fr = `FREQUENCES CHANGEES - REF AIP FRANCE AD2 LFPB ADC 01:
ATIS:   120.005MHZ REMPLACE 120.000MHZ
PREVOL: 121.955MHZ REMPLACE 121.950MHZ
GND:    121.905MHZ REMPLACE 121.900MHZ
TWR:    118.930MHZ REMPLACE 118.925MHZ`;

	it('EN: pairs each new frequency with the one it replaces', () => {
		expect(parseFreqAssignments(en)).toEqual([
			{ label: 'ATIS', freq: '120.005', was: '120.000' },
			{ label: 'DELIVERY', freq: '121.955', was: '121.950' },
			{ label: 'GND', freq: '121.905', was: '121.900' },
			{ label: 'TWR', freq: '118.930', was: '118.925' },
		]);
	});

	it('FR: same, with the REMPLACE keyword and the PREVOL (delivery) label', () => {
		expect(parseFreqAssignments(fr)).toEqual([
			{ label: 'ATIS', freq: '120.005', was: '120.000' },
			{ label: 'PREVOL', freq: '121.955', was: '121.950' },
			{ label: 'GND', freq: '121.905', was: '121.900' },
			{ label: 'TWR', freq: '118.930', was: '118.925' },
		]);
	});

	it('does not read the "...ADC 01:" header prefix as an assignment', () => {
		expect(parseFreqAssignments(en)).toHaveLength(4);
		expect(parseFreqAssignments(fr)).toHaveLength(4);
	});

	it('gives the same result on whitespace-normalised text', () => {
		expect(parseFreqAssignments(en.replace(/\s+/g, ' '))).toEqual(
			parseFreqAssignments(en),
		);
	});
});

// ------------------------------------------------------------------ //
// E1867/26 - LFPM, MODIFICATION list (new frequency per service).    //
// ------------------------------------------------------------------ //
describe('E1867/26 LFPM (MODIFICATION list)', () => {
	const en = `MODIFICATION OF FLW FREQ :
- MELUN TWR : 121.105MHZ
- AFIS MELUN INFORMATION : 121.105MHZ
- STAP ABSENCE ATS : 121.105MHZ
- ABSENCE ATS A/A : 121.105MHZ
REF AD2 LFPM APP01`;
	const fr = `MODIFICATION DES FREQUENCES SUIVANTES :
- MELUN TOUR : 121.105MHZ
- AFIS MELUN INFORMATION : 121.105MHZ
- STAP ABSENCE ATS : 121.105MHZ
- ABSENCE ATS A/A : 121.105MHZ
REF AD2 LFPM APP01`;

	it('EN: keeps each printed service label and its new frequency (no "was")', () => {
		expect(parseFreqAssignments(en)).toEqual([
			{ label: 'MELUN TWR', freq: '121.105', was: null },
			{ label: 'AFIS MELUN INFORMATION', freq: '121.105', was: null },
			{ label: 'STAP ABSENCE ATS', freq: '121.105', was: null },
			{ label: 'ABSENCE ATS A/A', freq: '121.105', was: null },
		]);
	});

	it('FR: same, with the "MELUN TOUR" label', () => {
		expect(parseFreqAssignments(fr).map((a) => a.label)).toEqual([
			'MELUN TOUR',
			'AFIS MELUN INFORMATION',
			'STAP ABSENCE ATS',
			'ABSENCE ATS A/A',
		]);
	});

	it('drops the bare word FREQUENCY, in either language', () => {
		// An AD 2.18 table prints the field name alone above its value; the
		// French singular was listed as structural and the English one was not,
		// so the two halves of a bilingual NOTAM read differently.
		expect(parseFreqAssignments('- FREQUENCY: 121.500 MHZ, RMK: EMERGENCY')).toEqual([]);
		expect(parseFreqAssignments('- FREQUENCE: 121.500 MHZ, RMK: SECOURS')).toEqual([]);
		expect(parseFreqAssignments('FREQUENCIES : 121.500MHZ')).toEqual([]);
		// A real service label spelling one of them out is still a service.
		expect(parseFreqAssignments('TWR FREQUENCY : 121.505MHZ')).toEqual([
			{ label: 'TWR FREQUENCY', freq: '121.505', was: null },
		]);
	});

	it('ignores the header and the trailing REF line', () => {
		const labels = parseFreqAssignments(en).map((a) => a.label);
		expect(labels).not.toContain('FREQ');
		expect(labels).not.toContain('REF AD2 LFPM APP01');
	});
});

describe('freqReplacement: degenerate input', () => {
	it('returns null when there is no replacement pair', () => {
		expect(freqReplacement('FREQ : 120.330MHZ')).toBeNull();
		expect(freqReplacement('FREQ CHANGED REF AIP')).toBeNull();
		// @ts-expect-error guarding the runtime contract
		expect(freqReplacement(undefined)).toBeNull();
	});

	it('is the first of allReplacements', () => {
		const two = 'READ 121.730MHZ INSTEAD OF 121.725MHZ READ 120.505MHZ INSTEAD OF 120.500MHZ';
		expect(freqReplacement(two)).toEqual(allReplacements(two)[0]);
		expect(allReplacements('')).toEqual([]);
		// @ts-expect-error guarding the runtime contract
		expect(allReplacements(undefined)).toEqual([]);
	});
});

describe('parseFreqAssignments: degenerate input', () => {
	it('returns [] for empty / non-string', () => {
		expect(parseFreqAssignments('')).toEqual([]);
		// @ts-expect-error guarding the runtime contract
		expect(parseFreqAssignments(undefined)).toEqual([]);
	});
});

describe('comma decimals (the SOFIA French corpus)', () => {
	// The FR texts really print both separators in one NOTAM (A3345/26:
	// "119,800MHZ INDISPONIBLE ... CONTACTER PARIS INFO 125.700MHZ"), so
	// every extractor accepts the comma and hands back the dot form.
	it('parseFreqAssignments normalises the comma', () => {
		expect(parseFreqAssignments('- MELUN TWR : 121,105MHZ')).toEqual([
			{ label: 'MELUN TWR', freq: '121.105', was: null },
		]);
	});

	it('freqReplacement and singleFreq normalise it too', () => {
		expect(freqReplacement('LIRE 120,330MHZ (AU LIEU DE 120,325MHZ)')).toEqual({
			freq: '120.330',
			was: '120.325',
		});
		// Mixed separators are one value, not two distinct frequencies.
		expect(singleFreq('FIS SEINE INFORMATION FREQ : 120,330MHZ PUIS 120.330MHZ')).toBe(
			'120.330',
		);
	});
});

