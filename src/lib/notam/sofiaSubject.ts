/* SOFIA-Briefing subject categories: the fine NOTAM subject grouping the French
 * DSNA/SIA SOFIA PIB prints as sub-headings inside each aerodrome / FIR block
 * (INSTALLATIONS ET SERVICES, BALISAGE, AIRE DE MANOEUVRE, ...). The grouping is
 * the ICAO/OPADD PIB subject grouping and is CONTEXT-DEPENDENT: an aerodrome
 * block and an en-route block use different category names for the same Q-code
 * 2nd letter (e.g. QA -> "ORGANISATION ... ET SERVICES DE LA CIRCULATION
 * AERIENNE" at an aerodrome, "ORGANISATION ... ET PROCEDURES" en-route).
 *
 * Pure and locale-free (returns a key; $lib/i18n maps key -> heading). The rule
 * below was reverse-engineered from a real SOFIA route PIB and is pinned against
 * every (Q-code, printed heading) pair extracted from it in
 * tests/notamSofiaSubject.spec.ts (fixture tests/fixtures/sofiaSubject.json).
 */

/** Whether a NOTAM's owner block is an aerodrome or the en-route / FIR tier;
 *  selects which SOFIA category set applies. */
export type SofiaScope = 'aerodrome' | 'enroute';

/** One SOFIA subject category. Keys prefixed `ad*` are aerodrome-context, `enr*`
 *  en-route-context, and the three plain keys appear in both. Each maps to one
 *  printed heading via `t.notam.sofiaGroups`. */
export type SofiaSubjectKey =
	// aerodrome context
	| 'adFacilities' // INSTALLATIONS ET SERVICES
	| 'adManoeuvring' // AIRE DE MANOEUVRE
	| 'adApron' // AIRE DE TRAFIC
	| 'adLighting' // BALISAGE
	| 'adNavaids' // AIDES A L'ATTERRISSAGE, INSTALLATIONS RADIONAVIGATION ET GNSS
	| 'adAirspaceAts' // ORGANISATION DE L'ESPACE AERIEN ET SERVICES DE LA CIRCULATION AERIENNE
	| 'adProcedures' // PROCEDURES
	| 'adMeteo' // METEOROLOGIE ET EQUIPEMENTS
	// en-route context
	| 'enrAirspaceProc' // ORGANISATION DE L'ESPACE AERIEN ET PROCEDURES
	| 'enrAtsVolmet' // SERVICES DE LA CIRCULATION AERIENNE ET VOLMET
	| 'enrCom' // INSTALLATIONS DE COMMUNICATION ET DE SURVEILLANCE
	| 'enrNavaids' // GNSS - INSTALLATIONS DE RADIONAVIGATION
	| 'enrRestrictions' // RESTRICTIONS DE L'ESPACE AERIEN
	// both contexts
	| 'warnings' // AVERTISSEMENTS
	| 'obstacles' // OBSTACLES
	| 'other'; // AUTRES INFORMATIONS

/** SOFIA's sub-heading order within each block, per context. */
export const SOFIA_SUBJECT_ORDER: Record<SofiaScope, readonly SofiaSubjectKey[]> = {
	aerodrome: [
		'adFacilities',
		'adManoeuvring',
		'adApron',
		'adLighting',
		'adNavaids',
		'adAirspaceAts',
		'adProcedures',
		'adMeteo',
		'obstacles',
		'warnings',
		'other',
	],
	// The document's own en-route order (subject then FIR).
	enroute: [
		'enrAirspaceProc',
		'enrAtsVolmet',
		'enrCom',
		'enrNavaids',
		'enrRestrictions',
		'warnings',
		'obstacles',
		'other',
	],
};

// QM 3rd letters that are the traffic area (apron / stands); every other QM is
// the manoeuvring area (runway / taxiway / stopway / strip).
const APRON_THIRD = new Set(['K', 'N', 'O', 'P']);

function aerodromeKey(s2: string, s3: string): SofiaSubjectKey {
	switch (s2) {
		case 'F':
			return s3 === 'T' ? 'adMeteo' : 'adFacilities'; // QFT* = RVR / transmissometer
		case 'L':
			return 'adLighting';
		case 'M':
			return APRON_THIRD.has(s3) ? 'adApron' : 'adManoeuvring';
		case 'I':
		case 'N':
		case 'G':
			return 'adNavaids';
		case 'A':
		case 'C':
		case 'S':
		case 'R':
			return 'adAirspaceAts';
		case 'P':
			return 'adProcedures';
		case 'O':
			return s3 === 'B' || s3 === 'L' ? 'obstacles' : 'other';
		case 'W':
			return 'warnings';
		default:
			return 'other';
	}
}

function enrouteKey(s2: string, s3: string): SofiaSubjectKey {
	switch (s2) {
		case 'A':
		case 'P':
			return 'enrAirspaceProc';
		case 'S':
			return 'enrAtsVolmet';
		case 'C':
			return 'enrCom';
		case 'N':
		case 'G':
		case 'I':
			return 'enrNavaids';
		case 'R':
			return 'enrRestrictions';
		case 'W':
			return 'warnings';
		case 'O':
			if (s3 === 'B' || s3 === 'L') {
				return 'obstacles';
			}
			return s3 === 'E' ? 'enrAirspaceProc' : 'other';
		default:
			return 'other';
	}
}

/** The SOFIA subject category for a NOTAM, from its ICAO Q-code and the owner
 *  scope. Unknown / malformed Q-codes fall to 'other'. */
export function sofiaSubjectCategory(qCode: string, scope: SofiaScope): SofiaSubjectKey {
	if (!/^Q[A-Z]{4}$/.test(qCode)) {
		return 'other';
	}
	const s2 = qCode.charAt(1);
	const s3 = qCode.charAt(2);
	return scope === 'aerodrome' ? aerodromeKey(s2, s3) : enrouteKey(s2, s3);
}
