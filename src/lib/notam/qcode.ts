/** ICAO Doc 8126 § 5.1 subject codes (second and third letters of the Q-code).
 *  Canonical English; the French mirror lives in $lib/i18n and is keyed
 *  against these literal keys, so `satisfies` (not a type annotation, which
 *  would erase the keys) keeps the exhaustiveness check real. */
export const Q_SUBJECTS = {
	AA: 'Minimum altitude',
	AC: 'Class B, C, D or E surface area',
	AD: 'Air defence identification zone',
	AE: 'Control area',
	AF: 'Flight information region',
	AH: 'Upper control area',
	AL: 'Minimum usable flight level',
	AN: 'Area navigation route',
	AO: 'Oceanic control area',
	AP: 'Reporting point',
	AR: 'ATS route',
	AT: 'Terminal control area',
	AU: 'Upper flight information region',
	AV: 'Upper advisory area',
	AX: 'Intersection',
	AZ: 'Aerodrome traffic zone',
	BU: 'Bird/wildlife hazard',
	CA: 'Air/ground facility',
	CB: 'Automatic dependent surveillance (broadcast)',
	CC: 'Automatic dependent surveillance (contract)',
	CD: 'Controller-pilot data link communications',
	CE: 'En route surveillance radar',
	CG: 'Ground controlled approach system',
	CL: 'Selective calling system',
	CM: 'Surface movement radar',
	CP: 'Precision approach radar',
	CR: 'Surveillance radar',
	CS: 'Secondary surveillance radar',
	CT: 'Terminal area surveillance radar',
	EB: 'Obstacle lights',
	FA: 'Aerodrome',
	FB: 'Friction measuring device',
	FC: 'Ceiling measurement equipment',
	FD: 'Docking system',
	FE: 'Oxygen',
	FF: 'Firefighting and rescue',
	FG: 'Ground movement control',
	FH: 'Helicopter alighting area or platform',
	FI: 'Aircraft de-icing',
	FJ: 'Oils',
	FL: 'Landing direction indicator',
	FM: 'Meteorological service',
	FO: 'Fog dispersal system',
	FP: 'Heliport',
	FS: 'Snow removal equipment',
	FT: 'Transmissometer',
	FU: 'Fuel availability',
	FW: 'Wind direction indicator',
	FZ: 'Customs/immigration',
	GA: 'GNSS airfield-specific operations',
	GW: 'GNSS area-wide operations',
	IA: 'DME',
	IC: 'Locator',
	ID: 'DME associated with ILS',
	IG: 'Glide path',
	II: 'Inner marker',
	IJ: 'NDB associated with ILS',
	IK: 'Inner approach surveillance',
	IL: 'Instrument landing system (ILS)',
	IM: 'Middle marker',
	IN: 'Localizer',
	IO: 'ILS Category I',
	IS: 'ILS Category II',
	IT: 'ILS Category III',
	IU: 'Microwave landing system (MLS)',
	IW: 'MLS Category I',
	IX: 'Locator, outer',
	IY: 'Locator, middle',
	LA: 'Approach lighting system',
	LB: 'Aerodrome beacon',
	LC: 'Runway centre line lights',
	LD: 'Landing direction indicator lights',
	LE: 'Runway edge lights',
	LF: 'Sequenced flashing lights',
	LG: 'Pilot-controlled lighting',
	LH: 'High intensity runway lights',
	LI: 'Runway end identifier lights',
	LJ: 'Runway alignment indicator lights',
	LK: 'Category II lighting system',
	LL: 'Low intensity runway lights',
	LM: 'Medium intensity runway lights',
	LP: 'Precision approach path indicator',
	LR: 'All landing area lighting facilities',
	LS: 'Stopway lights',
	LT: 'Threshold lights',
	LU: 'Helicopter approach path indicator',
	LV: 'Visual approach slope indicator system',
	LW: 'Heliport lighting',
	LX: 'Taxiway centre line lights',
	LY: 'Taxiway edge lights',
	LZ: 'Runway touchdown zone lights',
	MA: 'Movement area',
	MB: 'Bearing strength',
	MC: 'Clearway',
	MD: 'Declared distances',
	MG: 'Taxiing guidance system',
	MH: 'Runway arresting gear',
	MK: 'Parking area',
	MM: 'Daylight markings',
	MN: 'Apron',
	MO: 'Stopbar',
	MP: 'Aircraft stands',
	MR: 'Runway',
	MS: 'Stopway',
	MT: 'Threshold',
	MU: 'Runway turning bay',
	MW: 'Strip/shoulder',
	MX: 'Taxiway(s)',
	MY: 'Rapid exit taxiway',
	NA: 'All radio navigation facilities',
	NB: 'Non-directional radio beacon',
	ND: 'Distance measuring equipment',
	NF: 'Fan marker',
	NL: 'Locator',
	NM: 'VOR/DME',
	NN: 'TACAN',
	NO: 'OMEGA',
	NT: 'VORTAC',
	NV: 'VOR',
	NX: 'Direction finding station',
	OA: 'Aeronautical information service',
	OB: 'Obstacle',
	OE: 'Aircraft entry requirements',
	OL: 'Obstacle lights',
	OR: 'Rescue coordination centre',
	PA: 'Standard instrument arrival',
	PB: 'Standard VFR arrival',
	PC: 'Contingency procedures',
	PD: 'Standard instrument departure',
	PE: 'Standard VFR departure',
	PF: 'Flow control procedure',
	PH: 'Holding procedure',
	PI: 'Instrument approach procedure',
	PK: 'VFR approach procedure',
	PL: 'Flight plan processing',
	PM: 'Aerodrome operating minima',
	PN: 'Noise operating restriction',
	PO: 'Obstacle clearance altitude or height',
	PP: 'Obstacle clearance limit',
	PR: 'Radio failure procedure',
	PT: 'Transition altitude or transition level',
	PU: 'Missed approach procedure',
	PX: 'Minimum holding altitude',
	PZ: 'ADIZ procedure',
	RA: 'Airspace reservation',
	RD: 'Danger area',
	RM: 'Military operating area',
	RO: 'Overflying of',
	RP: 'Prohibited area',
	RR: 'Restricted area',
	RT: 'Temporary restricted area',
	SA: 'Automatic terminal information service',
	SB: 'ATS reporting office',
	SC: 'Area control centre',
	SE: 'Flight information service',
	SF: 'Aerodrome flight information service',
	SL: 'Flow control centre',
	SO: 'Oceanic area control centre',
	SP: 'Approach control service',
	SS: 'Flight service station',
	ST: 'Aerodrome control tower',
	SU: 'Upper area control centre',
	SV: 'VOLMET broadcast',
	SY: 'Upper advisory service',
	UA: 'Air traffic control centre',
	UB: 'ATS reporting office',
	UE: 'Flight information service',
	UI: 'AFIS',
	UO: 'Approach control',
	UR: 'Aerodrome control tower',
	WA: 'Air display',
	WB: 'Aerobatics',
	WC: 'Captive balloon or kite',
	WD: 'Demolition of explosives',
	WE: 'Exercises',
	WF: 'Air refuelling',
	WG: 'Glider flying',
	WH: 'Blasting',
	WJ: 'Banner/target towing',
	WL: 'Ascent of free balloon',
	WM: 'Missile, gun or rocket firing',
	WP: 'Parachute jumping exercise',
	WR: 'Radioactive materials or toxic chemicals',
	WS: 'Burning or blowing gas',
	WT: 'Mass movement of aircraft',
	WU: 'Unmanned aircraft',
	WV: 'Formation flight',
	WW: 'Significant volcanic activity',
	WY: 'Aerial survey',
	WZ: 'Model flying',
	XX: 'Other',
} satisfies Record<string, string>;

/** ICAO Doc 8126 § 5.2 condition codes (fourth and fifth letters of the
 *  Q-code). Same satisfies treatment as Q_SUBJECTS: the literal keys back
 *  the i18n mirror's exhaustiveness. */
export const Q_CONDITIONS = {
	AC: 'withdrawn for maintenance',
	AD: 'available for daylight operation',
	AF: 'flight checked and found reliable',
	AG: 'operating but ground checked only',
	AH: 'hours of service now',
	AK: 'resumed normal operations',
	AL: 'operative subject to previously published limitations',
	AM: 'military operations only',
	AN: 'available for night operation',
	AO: 'operational',
	AP: 'available, prior permission required',
	AR: 'available on request',
	AS: 'unserviceable',
	AU: 'not available',
	AW: 'completely withdrawn',
	AX: 'previously promulgated shutdown cancelled',
	BD: 'beacon decommissioned',
	BE: 'beacon established',
	CA: 'activated',
	CC: 'completed',
	CD: 'deactivated',
	CE: 'erected, exists',
	CF: 'operating frequency changed',
	CG: 'downgraded',
	CH: 'changed',
	CI: 'identification or radio call sign changed',
	CK: 'operating on reduced power',
	CL: 'operating on test, do not use',
	CM: 'displaced',
	CN: 'cancelled',
	CO: 'operating',
	CP: 'operating as a fixed obstacle',
	CR: 'temporarily replaced',
	CS: 'installed',
	CT: 'on test, do not use',
	CU: 'discontinued',
	CY: 'reclassified',
	DC: 'distance changed',
	DI: 'dimensions increased',
	DR: 'reduced',
	EI: 'initial operating capability',
	EL: 'limited',
	EN: 'now usable on radio',
	ER: 'restored',
	ES: 'reserved for further operations',
	GA: 'activated',
	GD: 'deactivated',
	GE: 'established',
	GS: 'suspended',
	HG: 'hijacked',
	HU: 'unsafe',
	HV: 'work completed',
	HW: 'hazard warning',
	HX: 'no specific working hours',
	IA: 'identification temporarily withdrawn',
	IE: 'identification of',
	IN: 'inoperative',
	IQ: 'inoperative for daylight only',
	IS: 'inoperative for night use',
	JO: 'jettisoned',
	KY: 'key/access',
	LA: 'limited to',
	LB: 'reserved for',
	LC: 'closed',
	LE: 'operating without auxiliary power',
	LF: 'reduced interference',
	LG: 'operating without identification',
	LH: 'operating without monitoring',
	LI: 'closed to IFR',
	LL: 'usable for limited periods',
	LN: 'available for',
	LO: 'operating',
	LP: 'prohibited',
	LQ: 'closed to VFR',
	LR: 'restricted',
	LS: 'subject to interruption',
	LT: 'limited to specific bearings',
	LW: 'restricted area created',
	MB: 'identification or call sign changed',
	ME: 'frequency changed',
	MI: 'modified as follows',
	MP: 'power changed',
	MS: 'schedule of operating modified',
	NA: 'new operations now scheduled',
	NC: 'new course',
	ND: 'new distance',
	NE: 'reorganised facilities',
	NH: 'new hours of service',
	NI: 'now identified as',
	NN: 'now available',
	NO: 'operating on standby',
	NT: 'test transmissions',
	NZ: 'newly commissioned',
	PA: 'prohibited to aircraft',
	PE: 'permission required',
	PM: 'parts missing',
	PO: 'prohibited operating',
	PP: 'prohibited, permission required',
	PT: 'time of operation changed',
	QU: 'questionable',
	RA: 'reactivated',
	RE: 'released',
	RI: 'replaced by',
	RK: 'remarked',
	RM: 'removed',
	RO: 'reopened',
	RQ: 'reissued',
	RR: 'refer',
	// No RT condition exists: the NOTAM Selection Criteria condition table
	// (AD..XX) carries none, OPADD Ed 4.1 para 2.7.2.8 reserves the trigger
	// condition to TT exclusively, and RT is only the SUBJECT "temporary
	// restricted area". An unknown condition falls back to the raw code.
	RY: 'newly published',
	SA: 'safety advisory',
	SE: 'available subject to prior conditions',
	SI: 'special instructions',
	SQ: 'state of equipment',
	ST: 'suspended',
	TA: 'aircraft caught by arresting gear',
	TE: 'temporarily extended',
	TI: 'item of equipment',
	TL: 'limited maintenance work in progress',
	TO: 'transferred to',
	TR: 'resumed',
	TS: 'schedule of operations',
	// OPADD Ed 4.1 para 2.7.2.8: "The NOTAM Code for a Trigger NOTAM shall
	// always contain 'TT' as 4th and 5th letters"; TT is the exclusive
	// Trigger-NOTAM condition, usable with every subject.
	TT: 'trigger NOTAM',
	UI: 'out of service for operational reasons',
	UM: 'out of service for maintenance',
	UR: 'out of service for repair',
	VA: 'information available',
	VI: 'verified',
	WA: 'withdrawn',
	WK: 'work in progress',
	XX: 'plain language',
};

/** Q-code subject codes for special-use airspaces that a NOTAM can activate:
 *  restricted (RR / RT), danger (RD), prohibited (RP), airspace reservation
 *  (RA), and military operating area (RM). */
const ACTIVATION_SUBJECTS = new Set([
	'RR', 'RT', 'RD', 'RP', 'RA', 'RM',
]);

/** Q-code condition codes that mean "this airspace is currently active":
 *  CA / GA = activated, CE = erected, exists, LW = restricted area created,
 *  RA = reactivated. CN / CD / GD (cancelled / deactivated) are excluded. */
const ACTIVATION_CONDITIONS = new Set([
	'CA', 'CE', 'LW', 'GA', 'RA',
]);

/** Returns true when the qCode describes the activation of a special-use
 *  airspace; the precondition for the activation-link feature in
 *  notamLinks.svelte.ts. */
export function isActivationQCode(qCode: string): boolean {
	if (typeof qCode !== 'string' || qCode.length !== 5 || qCode[0] !== 'Q') {
		return false;
	}
	const subject = qCode.slice(1, 3);
	const condition = qCode.slice(3, 5);
	return ACTIVATION_SUBJECTS.has(subject) && ACTIVATION_CONDITIONS.has(condition);
}

/** Maps a Q-code airspace-organisation subject to the Airspace.type a NOTAM
 *  naming such an airspace must be scoped to (so a "SEINE" TMA NOTAM cannot
 *  match the same-named SIV / TMZ rows): AT = terminal control area (TMA),
 *  AE = control area (CTA), AC = class B/C/D/E surface area (CTR). ATZ (AZ) is
 *  omitted: the FR / UK / ES datasets carry no rows of ICAO type AZ (Spain
 *  files ATZ under type CTR). */
const AIRSPACE_SUBJECT_TYPE: Record<string, string> = {
	AT: 'TMA',
	AE: 'CTA',
	AC: 'CTR',
};

/** The Airspace.type a Q-code concerns when it is about an organisation
 *  airspace (TMA / CTA / CTR), or '' otherwise. Condition-agnostic: a NOTAM
 *  about a named TMA AFFECTS that TMA whether it sets its hours, deactivates,
 *  changes or limits it; this is the "affecting" relationship, distinct from
 *  the restricted-area activation in isActivationQCode. Drives the name-based
 *  affecting link in notamLinks.svelte.ts (its FIS sibling for SIV rows is
 *  isFlightInfoServiceQCode below). */
export function controlAirspaceType(qCode: string): string {
	if (typeof qCode !== 'string' || qCode.length !== 5 || qCode[0] !== 'Q') {
		return '';
	}
	return AIRSPACE_SUBJECT_TYPE[qCode.slice(1, 3)] ?? '';
}

/** Q-code subjects whose NOTAMs can concern a Flight Information Sector (SIV):
 *  CA = air/ground facility (how SIA files FIS frequency NOTAMs, e.g. QCACF),
 *  SE / UE = flight information service. AFIS (SF / UI) is excluded: it is
 *  aerodrome-bound and covered by the airport, not a SIV. These funnel to the
 *  by-name SIV affecting link in notamLinks.svelte.ts, which additionally
 *  requires an FIS callsign next to the sector name, so the generic CA subject
 *  cannot match a same-named SIV from an aerodrome-radio NOTAM. */
const FIS_SUBJECTS = new Set(['CA', 'SE', 'UE']);

/** True when the Q-code subject is one a Flight Information Sector NOTAM uses.
 *  Condition-agnostic, like controlAirspaceType: a NOTAM about the FIS affects
 *  the sector whether it changes its frequency, withdraws it or sets hours.
 *  Disjoint from controlAirspaceType's subjects, so the two never both fire. */
export function isFlightInfoServiceQCode(qCode: string): boolean {
	if (typeof qCode !== 'string' || qCode.length !== 5 || qCode[0] !== 'Q') {
		return false;
	}
	return FIS_SUBJECTS.has(qCode.slice(1, 3));
}

/** Q-code condition codes that mean the subject is out of service right now:
 *  unserviceable / not available / withdrawn / out of service for ops,
 *  maintenance or repair / deactivated / discontinued / suspended /
 *  inoperative / beacon decommissioned. All present in Q_CONDITIONS above. */
const UNSERVICEABLE_CONDITIONS = new Set([
	'AS', 'AU', 'AW', 'AC', 'UI', 'UM', 'UR', 'CD', 'GD', 'CU', 'GS', 'ST', 'IN', 'WA', 'BD',
]);

/** Q-code condition codes that mean the subject is back in / kept in service:
 *  resumed / operational / restored / reopened / now available / reactivated /
 *  shutdown cancelled / newly commissioned / beacon (re)established. Used to
 *  veto a text match so a "back in service" NOTAM that mentions the prior
 *  outage doesn't read as unserviceable. */
const RESTORED_CONDITIONS = new Set([
	'AK', 'AO', 'ER', 'RO', 'TR', 'NN', 'AX', 'RA', 'CO', 'EN', 'NZ', 'BE', 'GE',
]);

/** Q-code condition codes that reassign an operating frequency: CF (operating
 *  frequency changed) and ME (frequency changed). Both present in Q_CONDITIONS
 *  above; this is the flag the frequency-override feature keys on (see
 *  $lib/notam/freqChange.ts). */
const FREQUENCY_CHANGE_CONDITIONS = new Set(['CF', 'ME']);

/** True when the Q-code's condition (4th + 5th letters) marks the subject
 *  unserviceable / out of service. */
export function isUnserviceableCondition(qCode: string): boolean {
	if (typeof qCode !== 'string' || !/^Q[A-Z]{4}$/.test(qCode)) {
		return false;
	}
	return UNSERVICEABLE_CONDITIONS.has(qCode.slice(3, 5));
}

/** True when the Q-code's condition marks the subject restored / operational. */
export function isRestoredCondition(qCode: string): boolean {
	if (typeof qCode !== 'string' || !/^Q[A-Z]{4}$/.test(qCode)) {
		return false;
	}
	return RESTORED_CONDITIONS.has(qCode.slice(3, 5));
}

/** True when the Q-code's condition (4th + 5th letters) marks a frequency
 *  change (CF / ME). Condition-only, like the un/serviceable predicates: the
 *  subject (air/ground facility QCA, navaid, ...) and the affected feature are
 *  decided by the existing links, so this just flags "a frequency moved". */
export function isFrequencyChangeCondition(qCode: string): boolean {
	if (typeof qCode !== 'string' || !/^Q[A-Z]{4}$/.test(qCode)) {
		return false;
	}
	return FREQUENCY_CHANGE_CONDITIONS.has(qCode.slice(3, 5));
}

/**
 * Decode a 5-letter ICAO Q-code over caller-supplied decode tables into a
 * human-readable phrase "<subject>, <condition>". Returns '' for invalid
 * input or when neither half is known; falls back to the raw 2-letter half
 * when only one matches. The i18n layer passes the French mirrors through
 * here so the fallback behaviour cannot drift between languages.
 */
export function decodeQCodeWith(
	subjects: Record<string, string>,
	conditions: Record<string, string>,
	code: string,
): string {
	if (typeof code !== 'string' || !/^Q[A-Z]{4}$/.test(code)) {
		return '';
	}
	const subject = subjects[code.substring(1, 3)];
	const condition = conditions[code.substring(3, 5)];
	if (!subject && !condition) {
		return '';
	}
	return `${subject || code.substring(1, 3)}, ${condition || code.substring(3, 5)}`;
}

/** decodeQCodeWith over the canonical English tables. */
export function decodeQCode(code: string): string {
	return decodeQCodeWith(Q_SUBJECTS, Q_CONDITIONS, code);
}

/** FIR-briefing display-group keys, in panel order. The headings live in the
 *  i18n catalogs (t.notam.firGroups, keyed by this union). */
export type FirGroupKey =
	| 'restrictions'
	| 'warnings'
	| 'organisation'
	| 'obstacles'
	| 'navcom'
	| 'procedures'
	| 'services'
	| 'other';

/** A FIR-briefing display group, in panel order. */
export interface FirSubjectGroup {
	key: FirGroupKey;
	order: number;
}

const FIR_SUBJECT_GROUPS: Record<FirGroupKey, FirSubjectGroup> = {
	restrictions: { key: 'restrictions', order: 0 },
	warnings: { key: 'warnings', order: 1 },
	organisation: { key: 'organisation', order: 2 },
	obstacles: { key: 'obstacles', order: 3 },
	navcom: { key: 'navcom', order: 4 },
	procedures: { key: 'procedures', order: 5 },
	services: { key: 'services', order: 6 },
	other: { key: 'other', order: 7 },
};

/** The display group a FIR briefing files this Q-code under, by subject
 *  family: restrictions (R*), navigation warnings (W*), airspace
 *  organisation (A*), obstacles (OB / OL), navaids & communications
 *  (C* / G* / I* / N*), procedures (P*), services & facilities
 *  (F* / L* / M* / O* / S*); anything else (XX, unparsed) files under
 *  Other. Ordered by what an en-route briefing reader scans for first. */
export function firSubjectGroup(qCode: string): FirSubjectGroup {
	const subject = /^Q[A-Z]{4}$/.test(qCode) ? qCode.slice(1, 3) : '';
	if (subject === 'OB' || subject === 'OL') {
		return FIR_SUBJECT_GROUPS.obstacles;
	}
	switch (subject[0]) {
		case 'R':
			return FIR_SUBJECT_GROUPS.restrictions;
		case 'W':
			return FIR_SUBJECT_GROUPS.warnings;
		case 'A':
			return FIR_SUBJECT_GROUPS.organisation;
		case 'C':
		case 'G':
		case 'I':
		case 'N':
			return FIR_SUBJECT_GROUPS.navcom;
		case 'P':
			return FIR_SUBJECT_GROUPS.procedures;
		case 'F':
		case 'L':
		case 'M':
		case 'O':
		case 'S':
			return FIR_SUBJECT_GROUPS.services;
		default:
			return FIR_SUBJECT_GROUPS.other;
	}
}

/**
 * Group items by their ICAO Q-code subject family (firSubjectGroup), returning
 * the non-empty families in briefing order (restrictions first, then warnings,
 * airspace organisation, obstacles, navaids & communications, procedures,
 * services, other). Insertion order is preserved inside each family, so a
 * caller's existing order (e.g. parse order) is retained within a category and
 * only the cross-family order changes. Generic over the item so this stays in
 * the pure NOTAM core; callers pass a qCode accessor.
 */
export function groupNotamsBySubject<T>(
	items: T[],
	qCodeOf: (item: T) => string,
): { group: FirSubjectGroup; items: T[] }[] {
	const m = new Map<string, { group: FirSubjectGroup; items: T[] }>();
	for (const it of items) {
		const g = firSubjectGroup(qCodeOf(it));
		let entry = m.get(g.key);
		if (!entry) {
			entry = { group: g, items: [] };
			m.set(g.key, entry);
		}
		entry.items.push(it);
	}
	return [...m.values()].sort((a, b) => a.group.order - b.group.order);
}

/**
 * The items of groupNotamsBySubject flattened back into one list: sorted by
 * ICAO subject family in briefing order, parse order kept within a family.
 * For lists shown as a single group (no per-family sub-headings), e.g. the
 * collapsible "Referenced by position" / geometric lists and the short
 * "Activated by" lists.
 */
export function sortNotamsBySubject<T>(items: T[], qCodeOf: (item: T) => string): T[] {
	return groupNotamsBySubject(items, qCodeOf).flatMap((g) => g.items);
}
