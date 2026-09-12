/* Unit tests for the name-based AFFECTING link: a NOTAM about an organisation
 * airspace (TMA / CTA / CTR) that names it in free text ("HORAIRES TMA SEINE :
 * 0500-2000") with no structured code and only the coarse Q-line position. The
 * match feeds the geometric "affecting" relationship (notamsForAirspace /
 * airspacesForNotam), NOT activatesAirspaces: the airspace is permanent, the
 * NOTAM merely concerns it. The predicate notamNamesAirspace is pure, so these
 * run without the data store, like extractAirspaceIds / airspacesOver. */

import { describe, it, expect } from 'vitest';
import { parseNotams } from '$lib/notam';
import { controlAirspaceType } from '$lib/notam/qcode';
import type { Notam } from '$lib/notam/types';
import type { Airspace } from '$lib/data/airspaces';
import type { Publisher } from '$lib/state/layers.svelte';
import {
	notamNamesAirspace,
	airspaceNameToken,
	nameTokenInText,
	typeAdjacentNameInText,
} from '$lib/state/notamLinks.svelte';

function mk(id: string, type: string, name: string, source: Publisher = 'fr'): Airspace {
	return { id, key: `${id}|${name}`, type, name, source } as unknown as Airspace;
}

// A single-NOTAM briefing block. The E) text carries no coordinates, so the
// only position is the Q-line fallback and parseNotams yields one Notam with a
// parsed qualifier (qCode + fir), which is all the matcher reads.
function notam(qCode: string, fir: string, eText: string): Notam {
	const text = [
		'LFFA-F0564/26',
		`A) ${fir}`,
		`Q) ${fir} / ${qCode} / IV / NBO / E / 000/115 / 4757N00228E102`,
		'B) 2604010000 C) 3801190314',
		`E) ${eText}`,
	].join('\n');
	return parseNotams(text)[0];
}

// The SEINE terminal area: 11 TMA slices the dataset splits a single named
// area into (LFPM1..LFPM10 plus the LFPM7.2 sub-slice), and the same-named
// SIV / TMZ rows a type-blind match would wrongly include.
const seineTmas: Airspace[] = [];
for (let i = 1; i <= 10; i++) {
	seineTmas.push(mk(`LFPM${i}`, 'TMA', `SEINE ${i}`));
}
seineTmas.push(mk('LFPM7.2', 'TMA', 'SEINE 7.2'));
const seineTmaIds = seineTmas.map((a) => a.id).sort();

const dataset: Airspace[] = [
	...seineTmas,
	// Same-name collisions of other types (must be excluded by type scope).
	mk('LFPMFS1', 'SIV', 'SEINE 1'),
	mk('LFPMFS2', 'SIV', 'SEINE 2'),
	mk('LFSTMZ004', 'TMZ', 'SEINE'),
	// Beauvais: a CTR and a TMA share the base name.
	mk('LFOB-CTR', 'CTR', 'BEAUVAIS'),
	mk('LFOB-TMA', 'TMA', 'BEAUVAIS'),
	// False-positive magnets (blocklisted word / too short).
	mk('LF-NORD', 'TMA', 'NORD'),
	mk('LFAIX', 'CTR', 'AIX'),
	// Foreign rows that share / resemble French names (excluded by country).
	mk('EG-SEINE', 'TMA', 'SEINE', 'uk'),
	mk('EGLON14', 'TMA', 'LONDON TMA 14', 'uk'),
];

// Airspace ids a NOTAM affects by name, against the synthetic dataset.
function named(qCode: string, fir: string, eText: string): string[] {
	const n = notam(qCode, fir, eText);
	return dataset.filter((a) => notamNamesAirspace(n, a)).map((a) => a.id).sort();
}

describe('controlAirspaceType', () => {
	it('maps the organisation-airspace subjects to a dataset type', () => {
		expect(controlAirspaceType('QATCA')).toBe('TMA');
		expect(controlAirspaceType('QAECA')).toBe('CTA');
		expect(controlAirspaceType('QACCA')).toBe('CTR');
	});

	it('is condition-agnostic: a NOTAM affects its TMA whatever the condition', () => {
		// "affecting", not "activation": hours / deactivate / change / limit all
		// concern the named TMA.
		expect(controlAirspaceType('QATCD')).toBe('TMA'); // deactivated
		expect(controlAirspaceType('QATCH')).toBe('TMA'); // changed
		expect(controlAirspaceType('QATXX')).toBe('TMA'); // plain language
		expect(controlAirspaceType('QATLT')).toBe('TMA'); // limitation
	});

	it('returns "" for non-organisation subjects and malformed input', () => {
		expect(controlAirspaceType('QAZCA')).toBe(''); // ATZ, out of scope v1
		expect(controlAirspaceType('QRRCA')).toBe(''); // restricted (code path)
		expect(controlAirspaceType('QOBCE')).toBe(''); // obstacle
		expect(controlAirspaceType('')).toBe('');
		expect(controlAirspaceType('QATC')).toBe('');
		expect(controlAirspaceType('XATCA')).toBe('');
	});
});

describe('airspaceNameToken', () => {
	it('reduces a French slice name to its bare base', () => {
		expect(airspaceNameToken(mk('a', 'TMA', 'SEINE 1'))).toBe('SEINE');
		expect(airspaceNameToken(mk('a', 'TMA', 'SEINE 10'))).toBe('SEINE');
		expect(airspaceNameToken(mk('a', 'TMA', 'SEINE 7.2'))).toBe('SEINE');
		expect(airspaceNameToken(mk('a', 'CTA', 'AQUITAINE NE'))).toBe('AQUITAINE');
		expect(airspaceNameToken(mk('a', 'CTA', 'AQUITAINE 1-2'))).toBe('AQUITAINE');
		expect(airspaceNameToken(mk('a', 'CTR', 'PARIS H'))).toBe('PARIS');
		expect(airspaceNameToken(mk('a', 'CTR', 'DINARD 01'))).toBe('DINARD');
		expect(airspaceNameToken(mk('a', 'CTR', 'BEAUVAIS'))).toBe('BEAUVAIS');
	});

	it('keeps the embedded type word for UK / Spain names', () => {
		expect(airspaceNameToken(mk('a', 'TMA', 'LONDON TMA 14', 'uk'))).toBe('LONDON TMA');
		expect(airspaceNameToken(mk('a', 'TMA', 'TMA MADRID', 'es'))).toBe('TMA MADRID');
		expect(airspaceNameToken(mk('a', 'CTA', 'CTA PAMPLONA AREA 1', 'es'))).toBe('CTA PAMPLONA');
	});

	it('drops names too risky to match (short / numeric / filler word)', () => {
		expect(airspaceNameToken(mk('a', 'CTR', 'AIX'))).toBeNull();
		expect(airspaceNameToken(mk('a', 'TMA', 'NORD'))).toBeNull();
		expect(airspaceNameToken(mk('a', 'TMA', '1'))).toBeNull();
	});
});

describe('nameTokenInText', () => {
	it('matches a whole word, including multi-word tokens', () => {
		expect(nameTokenInText('SEINE', 'HORAIRES TMA SEINE : 0500-2000')).toBe(true);
		expect(nameTokenInText('LONDON TMA', 'LONDON TMA 14 ACTIVATED')).toBe(true);
	});

	it('does not match a substring of a longer word', () => {
		expect(nameTokenInText('SEINE', 'SEINER TMA ACTIVATED')).toBe(false);
		expect(nameTokenInText('PARIS', 'COMPARISON OF LEVELS')).toBe(false);
	});
});

describe('notamNamesAirspace', () => {
	it('affects every same-name TMA slice, not the SIV / TMZ namesakes', () => {
		const ids = named('QATCA', 'LFFF', 'HORAIRES TMA SEINE : 0500-2000');
		expect(ids).toEqual(seineTmaIds);
		expect(ids).not.toContain('LFPMFS1'); // SIV
		expect(ids).not.toContain('LFSTMZ004'); // TMZ
		expect(ids).not.toContain('EG-SEINE'); // foreign
	});

	it('still affects the airspace for a non-activation condition', () => {
		// A deactivation / change NOTAM concerns the airspace too; it is an
		// affecting NOTAM, not an activation. (This is the key difference from
		// the restricted-area "Activated by" path.)
		expect(named('QATCD', 'LFFF', 'TMA SEINE DEACTIVATED')).toEqual(seineTmaIds);
		expect(named('QATXX', 'LFFF', 'TMA SEINE HOURS CHANGED')).toEqual(seineTmaIds);
	});

	it('affects nothing when the E) text names no carried airspace', () => {
		expect(named('QATCA', 'LFFF', 'HORAIRES ATS: LUN-VEN 0700-2030')).toEqual([]);
	});

	it('scopes the match to the NOTAM country (FIR)', () => {
		// A French SEINE NOTAM must not reach the UK "SEINE" row...
		const fr = notam('QATCA', 'LFFF', 'HORAIRES TMA SEINE : 0500-2000');
		expect(dataset.filter((a) => notamNamesAirspace(fr, a)).every((a) => a.source === 'fr')).toBe(true);
		// ...and a UK NOTAM hits only the UK row, never a French one.
		expect(named('QATCA', 'EGTT', 'LONDON TMA 14 ACTIVATED')).toEqual(['EGLON14']);
	});

	it('scopes by subject to the matching type when text names several', () => {
		// QACCA = CTR. Text mentions both "CTR" and "TMA BEAUVAIS"; only the CTR
		// row is affected, never the same-name TMA.
		expect(named('QACCA', 'LFFF', "HORAIRES ACTIVATION CTR, TMA BEAUVAIS ET CTL D'AD"))
			.toEqual(['LFOB-CTR']);
	});

	it('never matches a blocklisted or too-short name even when present', () => {
		expect(named('QATCA', 'LFFF', 'HORAIRES TMA NORD : 0500-2000')).toEqual([]);
		expect(named('QACCA', 'LFFF', 'CTR AIX ACTIVE')).toEqual([]);
	});

	it('does not fire for restricted-area subjects (those use the code path)', () => {
		const n = notam('QRRCA', 'LFFF', 'ZONE REGLEMENTEE SEINE ACTIVE');
		expect(dataset.some((a) => notamNamesAirspace(n, a))).toBe(false);
	});
});

describe('typeAdjacentNameInText (the widened, any-subject form)', () => {
	it('matches direct, article, and conjunction-hop adjacency', () => {
		expect(typeAdjacentNameInText('TMA', 'LORIENT', 'CTR ET TMA LORIENT')).toBe(true);
		expect(typeAdjacentNameInText('CTR', 'LORIENT', 'CTR ET TMA LORIENT')).toBe(true);
		expect(typeAdjacentNameInText('CTR', 'BIARRITZ', 'CTR DE BIARRITZ')).toBe(true);
		expect(
			typeAdjacentNameInText('CTR', 'MELUN', 'IDENTIQUES A CELLES DE LA CTR MELUN'),
		).toBe(true);
	});

	it('rejects names without their type word adjacent', () => {
		expect(typeAdjacentNameInText('TMA', 'LORIENT', 'LORIENT APP HORS SERVICE')).toBe(false);
		expect(typeAdjacentNameInText('CTR', 'LORIENT', 'TMA LORIENT SEULEMENT')).toBe(false);
	});
});

describe('the widened (typed) name link', () => {
	const lorient = [mk('LFRH-CTR', 'CTR', 'LORIENT'), mk('LFRH1', 'TMA', 'LORIENT 1')];

	it('links a radar-service NOTAM through the type-word adjacency', () => {
		const n = notam('QCTCS', 'LFRR', 'GUIDAGE RADAR NON ASSURE DANS LA CTR ET TMA LORIENT');
		expect(
			lorient.filter((a) => notamNamesAirspace(n, a)).map((a) => a.id).sort(),
		).toEqual(['LFRH-CTR', 'LFRH1']);
	});

	it('links a ZRT NOTAM to its host CTR, never the same-name TMA', () => {
		const n = notam('QRTCA', 'LFBB', "CREATION D'UNE ZRT 'CEREBOS' DANS LA CTR BIARRITZ");
		const rows = [mk('LFBZ-CTR', 'CTR', 'BIARRITZ'), mk('LFBZ-TMA', 'TMA', 'BIARRITZ')];
		expect(rows.filter((a) => notamNamesAirspace(n, a)).map((a) => a.id)).toEqual([
			'LFBZ-CTR',
		]);
	});

	it('accepts the comparison-clause reference (documented choice)', () => {
		const n = notam(
			'QAZCH',
			'LFFF',
			'RMZ MELUN MODIFIEE : LIMITES IDENTIQUES A CELLES DE LA CTR MELUN',
		);
		const rows = [mk('LFPM-CTR', 'CTR', 'MELUN')];
		expect(rows.filter((a) => notamNamesAirspace(n, a)).map((a) => a.id)).toEqual([
			'LFPM-CTR',
		]);
	});

	it('a bare name without the type word never matches under a foreign subject', () => {
		const n = notam('QCTCS', 'LFRR', 'PANNE RADAR SECTEUR LORIENT');
		expect(lorient.some((a) => notamNamesAirspace(n, a))).toBe(false);
	});

	it('strictOnly rejects every typed match (the freq-override guard)', () => {
		const n = notam('QCTCS', 'LFRR', 'GUIDAGE RADAR NON ASSURE DANS LA CTR ET TMA LORIENT');
		expect(lorient.some((a) => notamNamesAirspace(n, a, true))).toBe(false);
		// ...while the subject-gated path passes strictOnly untouched.
		const gated = notam('QATCA', 'LFFF', 'HORAIRES TMA SEINE : 0500-2000');
		expect(
			dataset.filter((a) => notamNamesAirspace(gated, a, true)).length,
		).toBeGreaterThan(0);
	});

	it('stays publisher-scoped', () => {
		const n = notam('QCTCS', 'EGTT', 'RADAR SERVICE NOT AVBL IN CTR LORIENT');
		expect(lorient.some((a) => notamNamesAirspace(n, a))).toBe(false);
	});
});
