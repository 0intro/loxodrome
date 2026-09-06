import { describe, it, expect } from 'vitest';
import {
	allFreqs,
	freqReplacement,
	parseFreqAssignments,
	singleFreq,
} from '$lib/notam/freqChange';
import { isFrequencyChangeCondition } from '$lib/notam/qcode';

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

