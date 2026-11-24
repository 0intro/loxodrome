/** The ICAO NOTAM Code's subjects, the second and third letters of a Q-code
 *  (PANS-ABC, Doc 8400), as FAA Order JO 7930.2U Appendix B reproduces them
 *  (6/9/25, unchanged through Change 2 of 30 September 2026), without the
 *  bracketed instructions to the originator such as "(specify runway)". XX
 *  is the subject no code covers (the NOTAM format, NOTAM CODE a), EASA NPA
 *  2016-02 Appendix 2 to Part-AIS).
 *  Canonical English; the French mirror lives in $lib/i18n and is keyed
 *  against these literal keys, so `satisfies` (not a type annotation, which
 *  would erase the keys) keeps the exhaustiveness check real. A code
 *  outside the table decodes as itself. */
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
	AX: 'Significant point',
	AZ: 'Aerodrome traffic zone',
	CA: 'Air/ground facility',
	CB: 'Automatic dependent surveillance (broadcast)',
	CC: 'Automatic dependent surveillance (contract)',
	CD: 'Controller-pilot data link communications',
	CE: 'En route surveillance radar',
	CG: 'Ground controlled approach system (GCA)',
	CL: 'Selective calling system (SELCAL)',
	CM: 'Surface movement radar',
	CP: 'Precision approach radar (PAR)',
	CR: 'Surveillance radar element of precision approach radar system',
	CS: 'Secondary surveillance radar (SSR)',
	CT: 'Terminal area surveillance radar (TAR)',
	FA: 'Aerodrome',
	FB: 'Friction measuring device',
	FC: 'Ceiling measurement equipment',
	FD: 'Docking system',
	FE: 'Oxygen',
	FF: 'Fire fighting and rescue',
	FG: 'Ground movement control',
	FH: 'Helicopter alighting area/platform',
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
	IC: 'Instrument landing system',
	ID: 'DME associated with ILS',
	IG: 'Glide path (ILS)',
	II: 'Inner marker (ILS)',
	IL: 'Localizer (ILS)',
	IM: 'Middle marker (ILS)',
	IN: 'Localizer (not associated with ILS)',
	IO: 'Outer marker (ILS)',
	IS: 'ILS Category I',
	IT: 'ILS Category II',
	IU: 'ILS Category III',
	IW: 'Microwave landing system (MLS)',
	IX: 'Locator, outer (ILS)',
	IY: 'Locator, middle (ILS)',
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
	LK: 'Category II components of approach lighting system',
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
	NC: 'DECCA',
	ND: 'Distance measuring equipment (DME)',
	NF: 'Fan marker',
	NL: 'Locator',
	NM: 'VOR/DME',
	NN: 'TACAN',
	NO: 'OMEGA',
	NT: 'VORTAC',
	NV: 'VOR',
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
	PO: 'Obstacle clearance altitude and height',
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
	WP: 'Parachute jumping exercise, paragliding or hang gliding',
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

/** The ICAO NOTAM Code's conditions, the fourth and fifth letters, from the
 *  same Appendix B, plus TT, the trigger NOTAM's (NOTAM CODE c) of the same
 *  NOTAM format). Same satisfies treatment as Q_SUBJECTS: the literal keys back
 *  the i18n mirror's exhaustiveness. */
export const Q_CONDITIONS = {
	AC: 'withdrawn for maintenance',
	AD: 'available for daylight operation',
	AF: 'flight checked and found reliable',
	AG: 'operating but ground checked only, awaiting flight check',
	AH: 'hours of service are now',
	AK: 'resumed normal operations',
	AL: 'operative (or reoperative) subject to previously published limitations/conditions',
	AM: 'military operations only',
	AN: 'available for night operation',
	AO: 'operational',
	AP: 'available, prior permission required',
	AR: 'available on request',
	AS: 'unserviceable',
	AU: 'not available',
	AW: 'completely withdrawn',
	AX: 'previously promulgated shutdown has been cancelled',
	CA: 'activated',
	CC: 'completed',
	CD: 'deactivated',
	CE: 'erected',
	CF: 'operating frequency(ies) changed to',
	CG: 'downgraded to',
	CH: 'changed',
	CI: 'identification or radio call sign changed to',
	CL: 'realigned',
	CM: 'displaced',
	CN: 'cancelled',
	CO: 'operating',
	CP: 'operating on reduced power',
	CR: 'temporarily replaced by',
	CS: 'installed',
	CT: 'on test, do not use',
	HA: 'braking action is',
	HB: 'friction coefficient is',
	HC: 'covered by compacted snow to depth of',
	HD: 'covered by dry snow to a depth of',
	HE: 'covered by water to a depth of',
	HF: 'totally free of snow and ice',
	HG: 'grass cutting in progress',
	HH: 'hazard due to',
	HI: 'covered by ice',
	HJ: 'launch planned',
	HK: 'bird migration in progress',
	HL: 'snow clearance completed',
	HM: 'marked by',
	HN: 'covered by wet snow or slush to a depth of',
	HO: 'obscured by snow',
	HP: 'snow clearance in progress',
	HQ: 'operation cancelled',
	HR: 'standing water',
	HS: 'sanding in progress',
	HT: 'approach according to signal area only',
	HU: 'launch in progress',
	HV: 'work completed',
	HW: 'work in progress',
	HX: 'concentration of birds',
	HY: 'snow banks exist',
	HZ: 'covered by frozen ruts and ridges',
	LA: 'operating on auxiliary power supply',
	LB: 'reserved for aircraft based therein',
	LC: 'closed',
	LD: 'unsafe',
	LE: 'operating without auxiliary power supply',
	LF: 'interference from',
	LG: 'operating without identification',
	LH: 'unserviceable for aircraft heavier than',
	LI: 'closed to IFR operations',
	LK: 'operating as a fixed light',
	LL: 'usable for length of … and width of …',
	LN: 'closed to all night operations',
	LP: 'prohibited to',
	LR: 'aircraft restricted to runways and taxiways',
	LS: 'subject to interruption',
	LT: 'limited to',
	LV: 'closed to VFR operations',
	LW: 'will take place',
	LX: 'operating but caution advised due to',
	// No RT condition exists: the NOTAM Selection Criteria condition table
	// (AD..XX) carries none, OPADD Ed 4.1 para 2.7.2.8 reserves the trigger
	// condition to TT exclusively, and RT is only the SUBJECT "temporary
	// restricted area". An unknown condition falls back to the raw code.
	// OPADD Ed 4.1 para 2.7.2.8: "The NOTAM Code for a Trigger NOTAM shall
	// always contain 'TT' as 4th and 5th letters"; TT is the exclusive
	// Trigger-NOTAM condition, usable with every subject.
	TT: 'trigger NOTAM',
	XX: 'plain language',
};

/** Q-code subject codes for special-use airspaces that a NOTAM can activate:
 *  restricted (RR / RT), danger (RD), prohibited (RP), airspace reservation
 *  (RA), and military operating area (RM). */
const ACTIVATION_SUBJECTS = new Set([
	'RR', 'RT', 'RD', 'RP', 'RA', 'RM',
]);

/** Q-code condition codes that mean "this airspace is currently active":
 *  CA = activated, CE = erected, LW = will take place, and GA and RA, which
 *  lie outside the ICAO NOTAM Code. CN / CD (cancelled / deactivated) are
 *  excluded. */
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

/** Returns true when the qCode describes a CHANGE of a special-use area
 *  (QRRCH, QRDCH: its hours, limits or conditions changed), whose published
 *  periods it then puts in doubt. */
export function isAmendmentQCode(qCode: string): boolean {
	if (typeof qCode !== 'string' || qCode.length !== 5 || qCode[0] !== 'Q') {
		return false;
	}
	return ACTIVATION_SUBJECTS.has(qCode.slice(1, 3)) && qCode.slice(3, 5) === 'CH';
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
 *  SE = flight information service, and UE, which lies outside the ICAO
 *  NOTAM Code. AFIS (SF / UI) is excluded: it is
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

/** The Q-code subject a fuel-availability NOTAM carries: FU, and only FU.
 *
 *  Exact on the corpus. Of the 2108 NOTAMs in force over metropolitan France
 *  on 2026-09-10, nine non-FU ones mention fuel at all and not one of those
 *  states an unavailability, so nothing is lost by refusing to look outside
 *  the subject.
 *
 *  FJ (Oils) is deliberately NOT here. An oil grade looks like a fuel grade -
 *  "Lubrifiant / Lubricant : 100/120" beside "Fuel : 100/130" - and admitting
 *  the subject would reproduce, at the NOTAM tier, exactly the confusion the
 *  AIP-side clause grammar exists to prevent (docs/fr-fuel.md). */
const FUEL_SUBJECTS = new Set(['FU']);

/** True when the Q-code subject is fuel availability.
 *
 *  Condition-agnostic on purpose, and that is a measurement rather than a
 *  preference: the condition does NOT classify these. QFULT ("limited to")
 *  carries seven outright withdrawals in the current French corpus and QFUAH
 *  ("hours of service") an eighth, so a gate on the unserviceable conditions
 *  would miss 14 of the 24 statements that actually withdraw a grade. The
 *  subject says the NOTAM is about fuel; the TEXT says what it does about it
 *  (serviceStatus, then notam/fuelChange.ts). */
export function isFuelQCode(qCode: string): boolean {
	if (typeof qCode !== 'string' || qCode.length !== 5 || qCode[0] !== 'Q') {
		return false;
	}
	return FUEL_SUBJECTS.has(qCode.slice(1, 3));
}

const RUNWAY_SUBJECTS = new Set(['MR']);

/** True when the Q-code subject is a runway.
 *
 *  Condition-agnostic for the same reason the fuel gate is: the SIA files an
 *  outright closure under QMRLC, but it also writes closures under QMRLT
 *  ("limited to") and QMRXX (plain language), and a condition gate would read
 *  the first and miss the others. The subject says the NOTAM is about a
 *  runway; the TEXT says what it does to it (notam/runwayChange.ts), and that
 *  grammar closes one only when the line closes it outright. */
export function isRunwayQCode(qCode: string): boolean {
	if (typeof qCode !== 'string' || qCode.length !== 5 || qCode[0] !== 'Q') {
		return false;
	}
	return RUNWAY_SUBJECTS.has(qCode.slice(1, 3));
}

const AERODROME_SUBJECTS = new Set(['FA']);

/** True when the Q-code subject is the AERODROME itself (QFA..).
 *
 *  Condition-agnostic, and for a sharper reason than the runway gate's: the
 *  condition here is measurably wrong both ways. Every QFALC in a French
 *  national corpus does state a closure, but so does E4369/26 LFRW ("AD CLSD
 *  DUE TO EVENT EXC FOR THOSE WHO ARE TAKING PART"), filed QFALT, and a
 *  condition gate would simply lose that field. Read the other way round, the
 *  condition proves nothing: QFAXX carries "WORKSHOP 'AIR SERVICES 21'
 *  CLOSED" and a runway closure announced in an aerodrome-scoped trigger
 *  NOTAM, neither of which closes a field.
 *
 *  So the subject says the NOTAM is about the aerodrome and the TEXT says
 *  what it does to it (notam/aerodromeClosure.ts). */
export function isAerodromeQCode(qCode: string): boolean {
	if (typeof qCode !== 'string' || qCode.length !== 5 || qCode[0] !== 'Q') {
		return false;
	}
	return AERODROME_SUBJECTS.has(qCode.slice(1, 3));
}

const DECLARED_DISTANCE_SUBJECTS = new Set(['MD']);

/** True when the Q-code subject is the runway's DECLARED DISTANCES (QMD..).
 *
 *  Condition-agnostic like its siblings: the SIA files these QMDCH and
 *  QMDXX alike, and the text says whether a distance is actually restated. */
export function isDeclaredDistanceQCode(qCode: string): boolean {
	if (typeof qCode !== 'string' || qCode.length !== 5 || qCode[0] !== 'Q') {
		return false;
	}
	return DECLARED_DISTANCE_SUBJECTS.has(qCode.slice(1, 3));
}

/** Q-code condition codes that mean the subject is out of service right now:
 *  the ICAO NOTAM Code's unserviceable (AS), not available (AU), completely
 *  withdrawn (AW), withdrawn for maintenance (AC) and deactivated (CD), and
 *  ten codes outside it. */
const UNSERVICEABLE_CONDITIONS = new Set([
	'AS', 'AU', 'AW', 'AC', 'UI', 'UM', 'UR', 'CD', 'GD', 'CU', 'GS', 'ST', 'IN', 'WA', 'BD',
]);

/** Q-code condition codes that mean the subject is back in / kept in service:
 *  the ICAO NOTAM Code's resumed normal operations (AK), operational (AO),
 *  shutdown cancelled (AX) and operating (CO), and nine codes outside it.
 *  Used to veto a text match so a "back in service" NOTAM that mentions the
 *  prior outage doesn't read as unserviceable. */
const RESTORED_CONDITIONS = new Set([
	'AK', 'AO', 'ER', 'RO', 'TR', 'NN', 'AX', 'RA', 'CO', 'EN', 'NZ', 'BE', 'GE',
]);

/** Q-code condition codes that reassign an operating frequency: CF
 *  (operating frequency(ies) changed to) and ME, which lies outside the ICAO
 *  NOTAM Code. This is the flag the frequency-override feature keys on (see
 *  $lib/notam/freqChange.ts). */
const FREQUENCY_CHANGE_CONDITIONS = new Set(['CF', 'ME']);

/** Q-code SUBJECT + CONDITION pairs that reassign a published frequency
 *  without the condition saying so, as 2nd-to-5th letters. CA is the subject
 *  ICAO defines as "Air/ground facility (specify service and frequency)" and
 *  CS is "installed": the SIA files its 8.33 kHz channel conversions that way
 *  rather than under CF, and states the move in the text
 *  ("QCACS ... NEW FREQUENCIES: - PONTOISE TWR : 121.205MHZ INSTEAD OF
 *  121.200MHZ", E3291/26 LFPT; likewise A1455/26 LFBO, C1108/26 LFLY,
 *  B0631/26 LFMU). A pilot calls on the value we show, so the filing quirk
 *  cannot be the reason it stays stale.
 *
 *  Deliberately a PAIR set and not the bare condition: CS on any other
 *  subject is a real installation of something that is not a voice channel
 *  (QCDCS a CPDLC link, QCSCS a secondary radar, QIGCS a glide path), and
 *  admitting those would let a navaid notice reach the aerodrome radios. */
const FREQUENCY_CHANGE_PAIRS = new Set(['CACS']);

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
 *  decided by the existing links, so this just flags "a frequency moved".
 *
 *  This is the CONDITION test alone. The frequency-override feature gates on
 *  isFrequencyChangeQCode below, which also admits the SIA's QCACS filing;
 *  what stays scoped to the condition is the value-LESS notice, since only a
 *  condition reading "frequency changed" says a published value moved when
 *  the text names none. */
export function isFrequencyChangeCondition(qCode: string): boolean {
	if (typeof qCode !== 'string' || !/^Q[A-Z]{4}$/.test(qCode)) {
		return false;
	}
	return FREQUENCY_CHANGE_CONDITIONS.has(qCode.slice(3, 5));
}

/** True when the Q-code marks a NOTAM that reassigns a published COM
 *  frequency: the explicit conditions above whatever the subject, plus the
 *  narrow subject+condition pairs States file one under instead. The gate the
 *  override feature reads (freqChangeIdents, the two resolvers and the NOTAM
 *  panel's frequency card); the values themselves still come from the text,
 *  so a wider gate can only give the extractors more to read, never invent a
 *  frequency. */
export function isFrequencyChangeQCode(qCode: string): boolean {
	if (typeof qCode !== 'string' || !/^Q[A-Z]{4}$/.test(qCode)) {
		return false;
	}
	return (
		FREQUENCY_CHANGE_CONDITIONS.has(qCode.slice(3, 5)) ||
		FREQUENCY_CHANGE_PAIRS.has(qCode.slice(1, 5))
	);
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
