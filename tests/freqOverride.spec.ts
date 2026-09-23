/* The frequency-change resolver ($lib/state/freqOverride.svelte.ts) against
 * real NOTAMs and the rows fr-airports.json really publishes: which radio row
 * a stated value lands on, and what is said when none does.
 *
 * The NOTAM associations are mocked (the interactions.spec idiom) so nothing
 * fetches: `notamsByIdent` is rebuilt from the parsed NOTAMs under test and
 * the airspace links answer empty, which is what keeps every case on the
 * airport path. The evaluation window is wide open on purpose: the date gate
 * has its own contract and this file judges the VALUE logic.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { parseNotams } from '$lib/notam/parser';
import type { Airport } from '$lib/data/airports';
import type { Notam } from '$lib/notam/types';

const m = vi.hoisted(() => ({ items: [] as { notam: Notam; index: number }[] }));

vi.mock('$lib/state/notam.svelte', async () => {
	const real =
		await vi.importActual<typeof import('$lib/state/notam.svelte')>('$lib/state/notam.svelte');
	return {
		...real,
		filteredNotams: () => m.items,
		notamsByIdent: () => {
			const map = new Map<string, { notam: Notam; index: number }[]>();
			for (const it of m.items) {
				for (const code of it.notam.icaoCodes) {
					const k = code.toUpperCase();
					map.set(k, [...(map.get(k) ?? []), it]);
				}
			}
			return map;
		},
		activeEvalWindow: () => ({ from: -8.64e15, to: 8.64e15 }),
		// The panels' default range (tests/closureInstant pins which range
		// each surface reads); wide open here like the window above.
		drawnStateAt: () => ({ fromMs: -8.64e15, toMs: 8.64e15 }),
	};
});
// The airspace path reaches its sources through the by-name link. `named`
// stands in for it: the link's own rules (an FIS call sign beside the sector
// name) are notamLinks' contract and are pinned there; here it is switched on
// so this file can judge what the resolver DOES with a source it accepts.
const link = vi.hoisted(() => ({ named: false }));
vi.mock('$lib/state/notamLinks.svelte', () => ({
	// A sector the NOTAM names is what hands it to the airspace resolver, so
	// the airport path reads this too: `named` drives both sides at once,
	// which is exactly the case a NOTAM converting a whole field states.
	airspacesNamedByNotam: () => (link.named ? [{ id: 'X', key: 'X', name: 'X' }] : []),
	notamNamesAirspace: () => link.named,
	notamsForAirspace: () => (link.named ? m.items : []),
}));

import {
	resolveAirportRadios,
	resolveAirspaceRadios,
	flagText,
} from '$lib/state/freqOverride.svelte';
import type { Airspace } from '$lib/data/airspaces';

/** An aerodrome carrying only what this module reads. */
function airport(ident: string, radios: [string, string][]): Airport {
	return {
		ident,
		type: 'small_airport',
		radios: radios.map(([freq, unit]) => ({ freq, unit, call: '' })),
	} as Airport;
}

/** Load one ICAO-text NOTAM and make it the whole briefing. */
function brief(text: string): Notam {
	const parsed = parseNotams(text);
	expect(parsed).toHaveLength(1);
	m.items = parsed.map((notam, index) => ({ notam, index }));
	return parsed[0];
}

/** "<unit> <freq> [was <prior>]" per row, the panel's own reading. */
function reading(a: Airport): string[] {
	return resolveAirportRadios(a).radios.map(
		(r) => `${r.unit} ${r.freq}${r.override ? ` was ${r.override.was}` : ''}`,
	);
}

function flags(a: Airport): string[] {
	return resolveAirportRadios(a).flags.map((f) => flagText(f.info));
}

/** A FIS sector carrying only what this module reads. */
function airspace(id: string, radios: [string, string][]): Airspace {
	return {
		id,
		key: id,
		name: id,
		type: 'SIV',
		radio: radios.map(([freq, unit]) => ({ freq, unit, call: '' })),
	} as Airspace;
}

function sectorReading(a: Airspace): string[] {
	return resolveAirspaceRadios(a).radios.map(
		(r) => `${r.unit} ${r.freq}${r.override ? ` was ${r.override.was}` : ''}`,
	);
}

function sectorFlags(a: Airspace): string[] {
	return resolveAirspaceRadios(a).flags.map((f) => flagText(f.info));
}

// -------------------------------------------------------------------- //
// E3291/26 - LFPT. Filed QCACS ("air/ground facility, installed"), the   //
// way the SIA files its 8.33 kHz conversions, with each row stating the  //
// value it takes over from. The gonio rides the tower's own channel and  //
// cmd/fr emits no VDF row for it, so its line restates the tower's move. //
// -------------------------------------------------------------------- //
describe('E3291/26 LFPT (8.33 kHz conversion, QCACS)', () => {
	const head = `E3291/26 NOTAMN
Q) LFFF/QCACS/IV/BO/AE/000/195/4906N00202E025
A) LFPT B) 2608251200 C) PERM
E) `;
	// Both halves as SOFIA serves them, the English one wrapped mid-reference.
	const en = `${head}NEW FREQUENCIES :
- PONTOISE TWR : 121.205MHZ INSTEAD OF 121.200MHZ
- PONTOISE GONIO : 121.205MHZ INSTEAD OF 121.200MHZ
- PONTOISE ATIS : 124.130MHZ INSTEAD OF 124.125MHZ
REF AIP FRANCE AD 2 LFPT APP 01, AD 2 LFPT.AD 2.18, AD 2 LFPT ADC
01, AD 2
LFPT STAR RWY ALL RNAV, AD 2 LFPT IAC`;
	const fr = `${head}NOUVELLES FREQUENCES :
- PONTOISE TWR : 121.205MHZ AU LIEU DE 121.200MHZ
- PONTOISE GONIO : 121.205MHZ AU LIEU DE 121.200MHZ
- PONTOISE ATIS : 124.130MHZ AU LIEU DE 124.125MHZ
REF AIP FRANCE AD 2 LFPT APP 01, AD 2 LFPT.AD 2.18, AD 2 LFPT ADC 01, AD 2 LFPT STAR RWY ALL RNAV, AD 2 LFPT IAC`;

	// What fr-airports.json publishes for Pontoise.
	const lfpt = (): Airport =>
		airport('LFPT', [
			['121.2', 'TWR'],
			['124.125', 'ATIS'],
		]);

	for (const [lang, text] of [
		['EN', en],
		['FR', fr],
	] as const) {
		it(`${lang}: moves the tower and the ATIS, each showing what it replaces`, () => {
			brief(text);
			expect(reading(lfpt())).toEqual([
				'TWR 121.205 was 121.200',
				'ATIS 124.130 was 124.125',
			]);
		});

		it(`${lang}: says nothing else - the gonio line restates the tower's move`, () => {
			brief(text);
			expect(flags(lfpt())).toEqual([]);
		});
	}

	it('reads both languages identically', () => {
		brief(en);
		const enRead = reading(lfpt());
		brief(fr);
		expect(reading(lfpt())).toEqual(enRead);
	});

	it('still moves a gonio published on a channel of its own', () => {
		// The absorption is a fallback, not a pre-emption: against a field whose
		// direction finder has its own row, the third line has a row of its own
		// to move and is no longer a restatement of the tower's.
		brief(fr);
		const a = airport('LFPT', [
			['121.2', 'TWR'],
			['124.125', 'ATIS'],
			['118.5', 'GONIO'],
		]);
		expect(reading(a)).toEqual([
			'TWR 121.205 was 121.200',
			'ATIS 124.130 was 124.125',
			'GONIO 121.205 was 118.500',
		]);
		expect(flags(a)).toEqual([]);
	});

	it('is inert under a condition that changes no frequency', () => {
		brief(fr.replace('QCACS', 'QCAAS'));
		expect(reading(lfpt())).toEqual(['TWR 121.2', 'ATIS 124.125']);
		expect(flags(lfpt())).toEqual([]);
	});
});

// -------------------------------------------------------------------- //
// B0367/26 - LFOK. One pair under a header naming every service sharing //
// the channel: the old value places it, so all of them move.            //
// -------------------------------------------------------------------- //
describe('B0367/26 LFOK (document-level replacement)', () => {
	const en = `B0367/26 NOTAMN
Q) LFFF/QCACF/IV/BO/A/000/999/4845N00411E005
A) LFOK B) 2602170000 C) PERM
E) FREQUENCIES A/A, VDF, AFIS AND TWR VATRY MODIFIED :
READ 129.405MHZ INSTEAD OF 129.400MHZ
REF : LFOK AD 2.18`;
	const fr = en.replace(
		'FREQUENCIES A/A, VDF, AFIS AND TWR VATRY MODIFIED :\nREAD 129.405MHZ INSTEAD OF 129.400MHZ',
		'FREQUENCES A/A, VDF, AFIS ET TWR VATRY MODIFIEES :\nLIRE 129.405MHZ AU LIEU DE 129.400MHZ',
	);
	const lfok = (): Airport =>
		airport('LFOK', [
			['129.4', 'TWR'],
			['129.4', 'AFIS'],
			['136.38', 'ATIS'],
			['129.4', 'A/A'],
		]);

	for (const [lang, text] of [
		['EN', en],
		['FR', fr],
	] as const) {
		it(`${lang}: every row on the old channel moves, the ATIS stays put`, () => {
			brief(text);
			expect(reading(lfok())).toEqual([
				'TWR 129.405 was 129.400',
				'AFIS 129.405 was 129.400',
				'ATIS 136.38',
				'A/A 129.405 was 129.400',
			]);
			expect(flags(lfok())).toEqual([]);
		});
	}

	it('flags the value when no row publishes what it replaces', () => {
		brief(en);
		expect(flags(airport('LFOK', [['118.5', 'TWR']]))).toEqual(['frequency: 129.405']);
	});

	it('says nothing once the AIP carries the new value', () => {
		// The dataset is republished every AIRAC cycle while a PERM NOTAM stays
		// in force for weeks: the change is on the panel already.
		brief(en);
		const caughtUp = airport('LFOK', [
			['129.405', 'TWR'],
			['129.405', 'A/A'],
		]);
		expect(reading(caughtUp)).toEqual(['TWR 129.405', 'A/A 129.405']);
		expect(flags(caughtUp)).toEqual([]);
	});
});

// -------------------------------------------------------------------- //
// A2706/26 - LFPB. The labelled REPLACES table, and what the two Le      //
// Bourget tower rows do to a label that names the service alone.        //
// -------------------------------------------------------------------- //
describe('A2706/26 LFPB (labelled table)', () => {
	const text = `A2706/26 NOTAMN
Q) LFFF/QCACF/IV/BO/A/000/999/4858N00227E005
A) LFPB B) 2602190000 C) PERM
E) FREQ CHANGED - REF AIP FRANCE AD2 LFPB ADC 01:
ATIS:     120.005MHZ REPLACES 120.000MHZ
DELIVERY: 121.955MHZ REPLACES 121.950MHZ
GND:      121.905MHZ REPLACES 121.900MHZ
TWR:      118.930MHZ REPLACES 118.925MHZ`;

	it('moves each labelled row by the value it replaces', () => {
		brief(text);
		const a = airport('LFPB', [
			['121.95', 'DEL'],
			['120', 'ATIS'],
			['121.9', 'GND'],
			['118.405', 'TWR'],
			['118.925', 'TWR'],
		]);
		expect(reading(a)).toEqual([
			'DEL 121.955 was 121.950',
			'ATIS 120.005 was 120.000',
			'GND 121.905 was 121.900',
			// The aerodrome has two tower channels and only one converts: the
			// stated old value is what tells them apart, which no label could.
			'TWR 118.405',
			'TWR 118.930 was 118.925',
		]);
		expect(flags(a)).toEqual([]);
	});

	it('says nothing once the AIP carries all four', () => {
		brief(text);
		const a = airport('LFPB', [
			['121.955', 'DEL'],
			['120.005', 'ATIS'],
			['121.905', 'GND'],
			['118.405', 'TWR'],
			['118.93', 'TWR'],
		]);
		expect(reading(a).filter((r) => r.includes('was'))).toEqual([]);
		expect(flags(a)).toEqual([]);
	});
});

// -------------------------------------------------------------------- //
// A stated old value names the CHANNEL. Two rows of one aerodrome on one //
// frequency are one transmitter under two service names (LFAT publishes  //
// its tower and its A/A on 118.455), so both move whatever the NOTAM     //
// labels: a sibling left behind would be a frequency nobody answers.     //
// -------------------------------------------------------------------- //
describe('a shared channel moves whole', () => {
	const text = `A0001/26 NOTAMN
Q) LFFF/QCACF/IV/BO/A/000/999/5030N00137E005
A) LFAT B) 2602190000 C) PERM
E) LE TOUQUET TWR : 118.460MHZ AU LIEU DE 118.455MHZ`;

	it('moves every row publishing the value, not only the labelled one', () => {
		brief(text);
		const a = airport('LFAT', [
			['123.13', 'ATIS'],
			['118.455', 'TWR'],
			['121.755', 'GND'],
			['118.455', 'A/A'],
		]);
		expect(reading(a)).toEqual([
			'ATIS 123.13',
			'TWR 118.460 was 118.455',
			'GND 121.755',
			'A/A 118.460 was 118.455',
		]);
		expect(flags(a)).toEqual([]);
	});

	it('leaves a same-service row on another channel alone', () => {
		// LFPB's two tower channels: only the one the pair names converts.
		brief(text.replace('118.460MHZ AU LIEU DE 118.455MHZ', '118.930MHZ AU LIEU DE 118.925MHZ'));
		const a = airport('LFAT', [
			['118.405', 'TWR'],
			['118.925', 'TWR'],
		]);
		expect(reading(a)).toEqual(['TWR 118.405', 'TWR 118.930 was 118.925']);
	});
});

// -------------------------------------------------------------------- //
// The QCACS admission earns overrides, not notices: "installed" says     //
// nothing moved, so a value it states is acted on where it lands on a    //
// row and passed over in silence where it does not.                      //
// -------------------------------------------------------------------- //
describe('installed (QCACS) without a stated old value', () => {
	it('D1407/26 LFCL: converts the tower, the A/A line adding nothing', () => {
		brief(`D1407/26 NOTAMN
Q) LFBB/QCACS/IV/BO/A/000/999/4335N00130E005
A) LFCL B) 2603190800 C) PERM
E) FREQUENCE TWR : 122.705MHZ
ABSENCE ATS, FREQUENCE A/A : 122.705MHZ
REF AD2 LFCL APP 01`);
		const a = airport('LFCL', [
			['122.7', 'TWR'],
			['128.105', 'ATIS'],
		]);
		expect(reading(a)).toEqual(['TWR 122.705 was 122.700', 'ATIS 128.105']);
		expect(flags(a)).toEqual([]);
	});

	it('A2113/23 OITK: a new facility is described, not flagged', () => {
		// A whole AD 2.18 block for an AFIS being installed, whose only
		// frequency is guard. Nothing here says a published value moved.
		brief(`A2113/23 NOTAMN
Q) OIIX/QCACS/IV/BO/AE/000/999/3824N04458E999
A) OITK B) 2307011023 C) PERM
E) REF AIP PAGE AD 2-4 OITK ITEM 2.18,
NEW ATS COMMUNICATION FACILITIES INSTALLED AND OPR
WITH FLW SPECIFICATIONS:
- SERVICE DESIGNATION: AFIS,
- CALL SIGN: KHOY INFORMATION,
- FREQUENCY: 121.500 MHZ,      RMK: EMERGENCY,
- HOURS OF OPERATION: HS,
AMEND AIP ACCORDINGLY.`);
		const a = airport('OITK', [['118.1', 'TWR']]);
		expect(reading(a)).toEqual(['TWR 118.1']);
		expect(flags(a)).toEqual([]);
	});

	it('a CF notice with the same shape still flags its value', () => {
		// The condition is what makes the claim: under "frequency changed" an
		// unplaceable labelled value is a change we could not place, and is said.
		brief(`A0002/26 NOTAMN
Q) LFFF/QCACF/IV/BO/A/000/999/4858N00227E005
A) LFAA B) 2602190000 C) PERM
E) AFIS : 121.505MHZ`);
		expect(flags(airport('LFAA', [['118.5', 'TWR']]))).toEqual(['AFIS: 121.505']);
	});
});

// -------------------------------------------------------------------- //
// What is said when nothing can be placed.                              //
// -------------------------------------------------------------------- //
describe('unplaceable changes', () => {
	const withE = (qCode: string, e: string): string =>
		`A0001/26 NOTAMN
Q) LFFF/${qCode}/IV/BO/A/000/999/4858N00227E005
A) LFAA B) 2602190000 C) PERM
E) ${e}`;
	const field = (): Airport => airport('LFAA', [['118.5', 'TWR']]);

	it('a value-less CF notice on a communications subject flags', () => {
		brief(withE('QCACF', 'FREQUENCIES CHANGED, REFER AIP AD 2.18'));
		expect(flags(field())).toEqual(['frequency change']);
	});

	it('an INSTALLED notice stating no move stays silent', () => {
		// "INSTALLED SDBY FREQ 128.300MHZ": a State announcing a new standby
		// channel has changed no published row, so the condition CS earns no
		// value-less notice the way CF does.
		brief(withE('QCACS', 'INSTALLED SDBY FREQ 128.300MHZ'));
		expect(reading(field())).toEqual(['TWR 118.5']);
		expect(flags(field())).toEqual([]);
	});

	it('a navaid frequency change filed here never reads as a radio notice', () => {
		brief(withE('QNDCF', 'DME FREQ : READ 114.500MHZ INSTEAD OF 114.300MHZ'));
		expect(reading(field())).toEqual(['TWR 118.5']);
		expect(flags(field())).toEqual([]);
	});
});

// -------------------------------------------------------------------- //
// The FIS / SIV path. Its sources are the airspaces a NOTAM NAMES, and   //
// what it does with them had no coverage at all.                        //
// -------------------------------------------------------------------- //
// -------------------------------------------------------------------- //
// A4794/26 - LFBZ. One NOTAM converting a whole field to 8.33 kHz, whose //
// four lines belong to TWO datasets: BIARRITZ INFO is the SIV sector's   //
// row and TOUR / APPROCHE / SOL are the aerodrome's own. Naming the      //
// sector hands the NOTAM to resolveAirspaceRadios, which places by the   //
// stated old value and so touches only the sector; deferring it WHOLE    //
// therefore dropped the other three with no override and no flag.       //
// -------------------------------------------------------------------- //
describe('A4794/26 LFBZ (an aerodrome and its sector in one NOTAM)', () => {
	const en = `A4794/26 NOTAMN
Q) LFBB/QCACF/IV/BO/A/000/999/4328N00122W005
A) LFBZ B) 2609010000 C) PERM
E) - FREQ BIARRITZ TWR : READ 118.705MHZ INSTEAD OF 118.700MHZ.
- FREQ BIARRITZ APP : READ 125.605MHZ INSTEAD OF 125.600MHZ.
- FREQ BIARRITZ INFO : READ 119.180MHZ INSTEAD OF 119.175MHZ.
- FREQ BIARRITZ GND : READ 121.955MHZ INSTEAD OF 121.950MHZ.
REF FRANCE AIP : AD2 LFBZ.AD2.18`;
	const fr = `A4794/26 NOTAMN
Q) LFBB/QCACF/IV/BO/A/000/999/4328N00122W005
A) LFBZ B) 2609010000 C) PERM
E) - FREQ BIARRITZ TOUR : LIRE 118.705MHZ (AU LIEU DE 118.700MHZ).
- FREQ BIARRITZ APPROCHE : LIRE 125.605MHZ (AU LIEU DE 125.600MHZ).
- FREQ BIARRITZ INFO : LIRE 119.180MHZ (AU LIEU DE 119.175MHZ).
- FREQ BIARRITZ SOL : LIRE 121.955MHZ (AU LIEU DE 121.950MHZ).
REF FRANCE AIP : AD2 LFBZ.AD2.18`;
	// What the AIP published before the cycle caught up, the sector's own
	// channel among them: the SIA lists the SIV frequency in AD 2.18 too.
	const lfbz = (): Airport =>
		airport('LFBZ', [
			['119.175', 'FIS'],
			['128.23', 'ATIS'],
			['118.700', 'TWR'],
			['125.600', 'APP'],
			['121.950', 'GND'],
		]);
	const biarritz = (): Airspace => airspace('LFBZFS', [['119.175', 'FIS']]);

	beforeEach(() => {
		link.named = true;
	});
	afterEach(() => {
		link.named = false;
	});

	for (const [lang, text] of [
		['EN', en],
		['FR', fr],
	] as const) {
		it(`${lang}: the aerodrome's own three rows move, and so does the sector`, () => {
			brief(text);
			expect(reading(lfbz())).toEqual([
				'FIS 119.180 was 119.175',
				'ATIS 128.23',
				'TWR 118.705 was 118.700',
				'APP 125.605 was 125.600',
				'GND 121.955 was 121.950',
			]);
			expect(flags(lfbz())).toEqual([]);
			expect(sectorReading(biarritz())).toEqual(['FIS 119.180 was 119.175']);
		});
	}

	it('says nothing here about a pair only the sector publishes', () => {
		// The aerodrome does not carry the SIV row. That pair is placed and
		// said on the sector's own panel, so a second notice here would
		// report a move this aerodrome never published.
		brief(en);
		const noFis = airport('LFBZ', [
			['118.700', 'TWR'],
			['125.600', 'APP'],
			['121.950', 'GND'],
		]);
		expect(reading(noFis)).toEqual([
			'TWR 118.705 was 118.700',
			'APP 125.605 was 125.600',
			'GND 121.955 was 121.950',
		]);
		expect(flags(noFis)).toEqual([]);
	});

	it('still refuses to place a named sector by its LABEL', () => {
		// The hand-over that survives is the stated old value, never the
		// service word: "SEINE INFO" canonicalises to INFO and must not move
		// the aerodrome's own information service.
		link.named = true;
		brief(`W1234/26 NOTAMN
Q) LFFF/QCACF/IV/BO/E/000/999/4840N00230E999
A) LFPM B) 2602170000 C) PERM
E) SEINE INFO : 120.505MHZ`);
		const lfpm = airport('LFPM', [['120.5', 'INFO']]);
		expect(reading(lfpm)).toEqual(['INFO 120.5']);
		expect(flags(lfpm)).toEqual([]);
	});
});

describe('resolveAirspaceRadios', () => {
	beforeEach(() => {
		link.named = true;
	});
	afterEach(() => {
		link.named = false;
	});

	it('C0438/26 EPWW: two sectors exchanging their frequencies', () => {
		// The hardest shape the pair reader has to survive. Applying the pairs
		// in order would put the first sector back on the value the second is
		// vacating; a row one pair has moved is out of the next one's reach.
		brief(`C0438/26 NOTAMN
Q) EPWW/QSECF/IV/BO/E/000/999/5201N01853E241
A) EPWW B) 2605150000 C) PERM
E) REF AIP AIRAC AMDT 05/26 AND AIRAC AMDT 06/26 (IN DISTRIBUTION)
UPDATE INFORMATION ABOUT FREQ FIS WARSZAWA POLNOC I AND FIS WARSZAWA
POLNOC II IN AIP VFR GEN 4.1 PUNKT 1.1.1:
- FIS WARSZAWA POLNOC I: SHOULD BE FREQ 123.975MHZ INSTEAD OF FREQ
118.775MHZ,
- FIS WARSZAWA POLNOC II: SHOULD BE FREQ 118.775MHZ INSTEAD OF FREQ
123.975MHZ.`);
		const a = airspace('EPWW-FIS', [
			['118.775', 'FIS'],
			['123.975', 'FIS'],
		]);
		expect(sectorReading(a)).toEqual([
			'FIS 123.975 was 118.775',
			'FIS 118.775 was 123.975',
		]);
		expect(sectorFlags(a)).toEqual([]);
	});

	it('C2025/26 SEINE: only the sector on the stated value moves', () => {
		const text = `C2025/26 NOTAMN
Q) LFFF/QCACF/IV/BO/A/000/999/4819N00401E005
A) LFQB B) 2605281221 C) PERM
E) FREQ SEINE INFORMATION : LIRE 120.330MHZ (AU LIEU DE 120.325MHZ)
REFERENCE AIP FRANCE AD 2 LFQB ATT 01.`;
		brief(text);
		const a = airspace('SEINE', [
			['127.815', 'FIS'],
			['120.325', 'FIS'],
			['134.3', 'FIS'],
		]);
		expect(sectorReading(a)).toEqual([
			'FIS 127.815',
			'FIS 120.330 was 120.325',
			'FIS 134.3',
		]);
		// A sector not on that frequency is not concerned: no flag, no change.
		brief(text);
		const other = airspace('SEINE', [['127.815', 'FIS']]);
		expect(sectorReading(other)).toEqual(['FIS 127.815']);
		expect(sectorFlags(other)).toEqual([]);
	});

	it('E1868/26 SEINE: a lone value takes a sole radio, and abstains otherwise', () => {
		const text = `E1868/26 NOTAMN
Q) LFFF/QCACF/IV/BO/A/000/999/4839N00237E005
A) LFPM B) 2605281221 C) PERM
E) FREQ SIV SEINE INFORMATION (SIV 4 ET 5) : 120.330MHZ`;
		brief(text);
		expect(sectorReading(airspace('SEINE', [['120.325', 'FIS']]))).toEqual([
			'FIS 120.330 was 120.325',
		]);
		brief(text);
		const twoRows = airspace('SEINE', [
			['120.325', 'FIS'],
			['127.815', 'FIS'],
		]);
		expect(sectorReading(twoRows)).toEqual(['FIS 120.325', 'FIS 127.815']);
		expect(sectorFlags(twoRows)).toEqual(['frequency: 120.330']);
	});

	it('says nothing for an installed notice it cannot place', () => {
		// The aerodrome side is silent for these; this side must be too.
		brief(`A0003/26 NOTAMN
Q) LFFF/QCACS/IV/BO/A/000/999/4839N00237E005
A) LFPM B) 2605281221 C) PERM
E) NEW FIS EQUIPMENT INSTALLED, REFER AIP`);
		const a = airspace('SEINE', [['120.325', 'FIS']]);
		expect(sectorReading(a)).toEqual(['FIS 120.325']);
		expect(sectorFlags(a)).toEqual([]);
	});

	it('a value-less CF notice still says so', () => {
		brief(`A0004/26 NOTAMN
Q) LFFF/QCACF/IV/BO/A/000/999/4839N00237E005
A) LFPM B) 2605281221 C) PERM
E) SEINE INFORMATION FREQUENCIES CHANGED, REFER AIP`);
		expect(sectorFlags(airspace('SEINE', [['120.325', 'FIS']]))).toEqual([
			'frequency change',
		]);
	});
});
