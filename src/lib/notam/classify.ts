/**
 * Classify a NOTAM E) section into a coarse obstacle / activity type. Returns
 * one of crane|turbine|metmast|antenna|chimney|powerline|cableway|terrain|
 * trees|balloon|voltige|aeromodelisme|paragliding|glider|parachute|drone|
 * firing|blasting|bird|laser|balisage|ulm, or '' when nothing matches.
 *
 * Two tiers, and WITHIN a tier the EARLIEST match in the text wins, not the
 * first rule in the file. A NOTAM says what it is about in its opening line
 * and spends the rest on context, so picking by rule order reads the context
 * instead: "TEMPO RESTRICTED AREA (ZRT) ... - UA FLIGHTS ..." came out as
 * model flying because clause 6 ends "MODEL FLYING ACTIVITY NR 8268
 * SUSPENDED WHEN ZRT ACT", and "DO NOT FLY UNDER OVERHEAD POWER LINES ...
 * PSN PYLONE NORD" came out as an antenna (R2307/26, W1907/26, 2026-09).
 *
 * The tiers are the obstacle kinds and the activity kinds. When the text
 * names one of each, the Q-code SUBJECT arbitrates: a W-series NOTAM is a
 * navigation warning about something HAPPENING, and the obstacle its text
 * names is where it happens (a drone over a power line, W1933/26; a captive
 * balloon beside a wind farm, M3252/26), so the activity wins. Anything else
 * keeps the obstacle, which is what an obstacle-light NOTAM naming its mast
 * needs. `balisage` and `ulm` stay pure fallbacks below both tiers: a
 * lighting NOTAM usually names the obstacle that is lit, and that is the
 * icon it should carry.
 *
 * When the text names nothing, the optional Q-code's subject letters decide,
 * but only for the subjects France files faithfully (QSUBJECT_FALLBACK
 * below): the world corpora show France using WU mostly for model flying
 * rather than drones, WZ for fireworks, WG for winching and WA never, so
 * those stay text-only (the evidence lives in tests/classifyAudit.spec.ts).
 */
export function classifyObstacle(
	eText: string | null | undefined,
	qCode?: string,
): string {
	const t = eText ? eText.toUpperCase() : '';
	const obstacle = declaredObstacle(t);
	const activity = earliest(t, ACTIVITY_RULES);
	if (obstacle && activity) {
		// Both named: the subject says which one the NOTAM is about.
		return (qCode ?? '').slice(1, 2) === 'W' ? activity.kind : obstacle.kind;
	}
	const one = obstacle ?? activity ?? earliest(t, FALLBACK_RULES);
	if (one) {
		return one.kind;
	}
	return QSUBJECT_FALLBACK[qCode ? qCode.slice(1, 3) : ''] ?? '';
}

/** One classification rule: the kind it names and the pattern that finds it. */
interface Rule {
	kind: string;
	re: RegExp;
}

/** The obstacle the text DECLARES, which is not always the first one it
 *  names. `OBST` is the SIA's and the FAA's own label for it, so a match
 *  after that marker outranks anything before it: P1151/26 opens with the
 *  windturbine being built and then says "OBST : CRANE ON SHIP", and the
 *  crane is the obstacle. Falls back to the whole text when nothing follows
 *  the marker, and when there is no marker at all. */
function declaredObstacle(t: string): { kind: string; at: number } | null {
	const marker = /\bOBST(?:ACLE)?S?\b/.exec(t);
	if (marker) {
		const after = earliest(t.slice(marker.index), OBSTACLE_RULES);
		if (after) {
			return { kind: after.kind, at: after.at + marker.index };
		}
	}
	return earliest(t, OBSTACLE_RULES);
}

/** The rule whose pattern matches EARLIEST in `t`; ties go to the rule listed
 *  first, which is the order the rule tables below are written in. */
function earliest(t: string, rules: readonly Rule[]): { kind: string; at: number } | null {
	let best: { kind: string; at: number } | null = null;
	for (const r of rules) {
		const m = r.re.exec(t);
		if (m && (best === null || m.index < best.at)) {
			best = { kind: r.kind, at: m.index };
		}
	}
	return best;
}

/** The Q-line subjects trusted to name the activity when the E) text does
 *  not. Deliberately absent: WU (mostly model flying in France), WZ
 *  (fireworks), WG (winching), WA (unused), WE / WT / WV (heterogeneous). */
const QSUBJECT_FALLBACK: Record<string, string> = {
	WP: 'parachute',
	WB: 'voltige',
	WC: 'balloon',
	WL: 'balloon',
	WM: 'firing',
	WD: 'blasting',
	WH: 'blasting',
	BU: 'bird',
	OL: 'balisage',
	// Not ICAO: France files laser / light-beam emissions under WO
	// ("SKYTRACERS TYPE LIGHT BEAM" texts never say LASER).
	WO: 'laser',
};

/** Things STANDING there: what a NOTAM about an obstacle is about.
 *  Earliest match in the text wins, so a power line named in the warning
 *  beats the pylons named among its positions (W1907/26). */
const OBSTACLE_RULES: readonly Rule[] = [
	// OBST RIG / OBST SCISSOR LIFT are temporary mechanical equipment in
	// the same family as a crane (drilling rigs, maintenance lifts; both
	// visual hazards from the cockpit are mechanical structures). ENGIN DE
	// LEVAGE / LIFTING EQUIPMENT, ENGIN DE CHANTIER / CONSTRUCTION
	// MACHINERY and NACELLE are the French SIA forms and their own English
	// renderings; the SIA translates an erected NACELLE (aerial work
	// platform) as GONDOLA (P2013/26), so that word joins the family too.
	// The machines of a building site are the same family in each
	// language: ENGIN TRAVAUX PUBLIC / BUILDING MACHINE (P4165/26), ENGIN BTP
	// / CONSTRUCTION EQUIPMENT (P3528/26), ENGIN DE CHANTIER / WORKING
	// MACHINE (P4292/26). CRAEN and MOBILECRANE are the corpus's typos of a
	// GRUE MOBILE (P3929/26, P3935/26), and SAND HILL CRANES are birds
	// (KHSV-A0239/26). FOREUSE / DRILL / DIGGER stay out on purpose.
	{ kind: 'crane', re: /\b(GRUES?|(?<!\bSAND\s?HILL\s)CRANES?|CANES?|CRAENS?|MOBILECRANES?)\b|\bOBST\s+RIGS?\b|\bOBST\s+SCISSOR\s+LIFTS?\b|\bENGINS?\s+DE\s+LEVAGE\b|\bLIFTING\s+EQUIPMENT\b|\bENGINS?\s+DE\s+CHANTIER\b|\bENGINS?\s+BTP\b|\bENGINS?\s+(?:DE\s+)?TRAVAUX\s+PUBLICS?\b|\bCONSTRUCTION\s+(?:MACHINERY|EQUIPMENTS?)\b|\bBUILDING\s+MACHINES?\b|\bWORK(?:ING)?\s+MACHINES?\b|\bNACELLES?\b|\bGONDOLAS?\b/ },
	// WIND\s*TURBINE catches both `WIND TURBINE` and `WINDTURBINE` (one-word
	// spelling common in autorouter briefings). Same for WIND\s*FARM and
	// WIND\s*PARK. WINDMILL is the German-origin informal name used in EDLA
	// / EDGG NOTAMs. WINFARM is a real typo seen in `france.txt` P0618/26;
	// the misspelling persists across cycles so it's worth catching.
	// EOLIENS? is the adjective, which is all a PARC EOLIEN names.
	{ kind: 'turbine', re: /\b(EOLIENNES?|EOLIENS?|WIND\s*TURBINE?S?|WINTURBINES?|WIND\s*FARM|WIND\s*PARK|WINFARM|WINDMILLS?|WTG)\b/ },
	// MEA?SURING covers both the standard MEASURING and the French-
	// influenced misspelling MESURING seen in real autorouter briefings.
	// OBST MAST is the generic "obstacle: mast" form ("LIT OBST MAST
	// 3150FT AMSL", "OBST MAST NR 80137 LIGHTING U/S") that doesn't
	// specify what kind of mast; grouping it under metmast keeps the
	// mast-shape icon consistent across all mast variants. OBST
	// ANEMOMETRIC is the French SIA form for a wind-measurement mast.
	// A bare MAST or MAT is that generic mast too, in either language:
	// "OBST : MAST AT 'ILLOIS'" and "OBST : MAT A ILLOIS" (P2951/26), the
	// numbered "MAST NR 02170 LIGHTING U/S" and "BALISAGE MAT NR 02170"
	// (P4045/26), and the French MAT DE MESURE. The lookarounds leave MAT
	// RADIO to the antenna rule, keep out SX-MAT, an aircraft
	// registration, and leave a DRILLING MAST (DRILING MAST, A3310/26)
	// bare with the drills.
	{ kind: 'metmast', re: /\bMET\s+MAST\b|\bMEASUREMENT\s+MAST\b|\bME(?:A?SURING|SAURING)\s+MAST\b|\bOBST\s+MAST\b|\bOBST\s+ANEMOMETRIC\b|(?<!\bDRILL?(?:ING)?\s+)\bMASTS?\b(?!\s+(?:'[^']*'\s+)?OF\s+(?:A\s+)?(?:TRANSMISSION|POWER)\s+LINES?\b)|(?<!-)\bMATS?\b(?!\s+RADIO\b)/ },
	// OBST TOWER is the FAA shorthand for an Antenna Structure Registry
	// (ASR) tower, the bulk of US obstacle NOTAMs ("OBST TOWER LGT (ASR
	// 1208783) ... U/S"), and an OBST TOWER CRANE is a crane (P3390/26). OBST RADIO is the French SIA radio-mast form,
	// and a mast named after its radio, navaid or network is the same
	// mast: RADIO, RDO, TV, COMMUNICATION, TELECOM, NDB, VOR, VHF, RADAR,
	// PHONE or TRANSMISSION MAST, the French MAT RADIO (P2309/26), and
	// the UK's "RTM BILSDALE MAST", a television mast (N0876/26).
	// OBST POLE covers generic vertical poles (FAA "OBST POLE LGT (ASN
	// X) ... U/S"). All three live with antennas/pylons - same broadcast
	// / communication tower family.
	{ kind: 'antenna', re: /\b(ANTENNES?|ANTENNAS?|PYLONES?|PYLONS?)\b|\bOBST\s+TOWER\b(?!\s+CRANES?\b)|\bOBST\s+RADIO\b|\bOBST\s+POLES?\b|\b(?:RADIO|RDO|TV|COMMUNICATIONS?|TELECOM\w*|NDB|VOR|VHF|RADAR|PHONE|TRANSMI\w*)\s+MASTS?\b|\bRTM\s+(?:RTM\s+)?(?:[A-Z]+\s+){1,2}MASTS?\b|\bMATS?\s+RADIO\b/ },
	// OBST STACK is the FAA shorthand for a smokestack ("OBST STACK
	// (ASN UNKNOWN) ... NOT LGTD"); SMOKE STACK the SIA's own English
	// ("SMOKE STACK NR 59004 LIGHTS U/S"); same icon as chimney.
	{ kind: 'chimney', re: /\b(CHEMINEES?|CHIMNEYS?)\b|\bOBST\s+STACK\b|\bSMOKE\s+STACKS?\b/ },
	// HIGH-VOLTAGE and HIGH-TENSION take the hyphen some texts write, and
	// PWR LINE the abbreviation, each before the MAST of a pylon
	// (D2182/26, F1441/26, URMM-A1616/26). A HIGH TENSION MAST is one too
	// (C0334/26), and so is a "MAST 'M137' OF TRANSMISSION LINE"
	// (LOWW-B0285/26), which the metmast rule leaves to this one.
	{ kind: 'powerline', re: /\bLIGNES?\s+(TRES\s+)?HAUTE\s+TENSION\b|\bLIGNES?\s+ELECTRIQUES?\b|\bLIGNES?\s+T?HT\b|\bPOWER\s+LINES?\b|\bPWR\s+LINES?\b|\bTRANSMISSION\s+LINES?\b|\bHIGH[\s-]+(?:VOLTAGE|TENSION)\s+(?:LINES?|MASTS?)\b|\bHV\s+LINES?\b/ },
	// Cable transport spanning valleys (passenger or material); distinct
	// from powerlines in the data even though both are wires in the sky.
	// CABLE alone is too ambiguous (ground cables, control cables); require
	// the compound form. The French ski-lift family (remontees mecaniques)
	// rides the same icon.
	{ kind: 'cableway', re: /\bCABLEWAYS?\b|\bCABLE\s+CARS?\b|\bTELEPHERIQUES?\b|\bREMONTEES?\s+MECANIQUES?\b|\bTELESIEGES?\b|\bTELECABINES?\b|\bTELESKIS?\b|\bTYROLIENNES?\b|\bZIP\s*LINES?\b/ },
	// OBST HILL is the FAA pattern for natural terrain that exceeds the
	// obstacle thresholds ("OBST HILL (ASN UNKNOWN) ... NOT LGTD"); the
	// terrain icon distinguishes them from trees / vegetation.
	{ kind: 'terrain', re: /\bOBST\s+HILLS?\b|\bOBST\s+TERRAIN\b/ },
	// PLANTS (plural only: POWER PLANT must not land here) is the SIA's
	// English for the VEGETAUX texts ("PRESENCE OF PLANTS NEAR ..."), and
	// WOODED / BOISEE the two halves of a wooded area (P4339/26). Bare BOIS
	// would read the place names ("ST GATIEN DES BOIS").
	{ kind: 'trees', re: /\b(ARBRES?|TREES?|VEGETAL|VEGETAUX|VEGETATIONS?|FOREST|FORETS?|PLANTS|WOODED|BOISEES?)\b/ },
];

/** Things HAPPENING: what a navigation warning is about. */
const ACTIVITY_RULES: readonly Rule[] = [
	// Kite-flying NOTAMs ("ASCENT OF KITES 1NM RADIUS") share the balloon
	// icon: both are light unmanned objects in airspace, same visual cue
	// from the cockpit. UK regulatory boilerplate that lists kites among
	// other items always contains BALLOON earlier, so the existing balloon
	// match already wins for that text. AEROSTAT is the French generic for
	// lighter-than-air craft, MONTGOLFIERE the hot-air balloon.
	{ kind: 'balloon', re: /\bBALLOONS?\b|\bBALLONS?\b|\bKITES?\b|\bAEROSTATS?\b|\bMONTGOLFIERES?\b/ },
	// AIRSHOW / AIR DISPLAY map to voltige; they're aerobatic events even
	// when the briefing doesn't spell out AEROBATICS explicitly. The French
	// forms are PRESENTATION / MANIFESTATION AERIENNE and MEETING AERIEN.
	{ kind: 'voltige', re: /\bVOLTIGE\b|\bAEROBATICS?\b|\bAIRSHOWS?\b|\bAIR\s+SHOWS?\b|\bAIR\s+DISPLAYS?\b|\bAERIAL\s+DISPLAYS?\b|\bAIR\s+EVENTS?\b|\bPRESENTATIONS?\s+AERIENNES?\b|\bMANIFESTATIONS?\s+AERIENNES?\b|\bMEETINGS?\s+AERIENS?\b/ },
	// AEROMODEL\w* takes every derivation the corpora show: AEROMODELISME,
	// the English AEROMODELISM / AEROMODELLING, and the clipped AEROMODEL
	// ACT. MODEL ACT\w* is the abbreviated "MODEL ACT NR ..." form. AEM
	// is the SIA's own abbreviation, which its AIP amendment triggers write
	// in French ("MODIFICATION AEM 9179 'SARRIAC BIGORRE'", W2369/26) and
	// its English texts gloss ("MODEL FLYING ACTIVITY (AEM)"). MODD?ELL?
	// carries the typo MODDEL (W2369/26).
	// A craft noun before the model phrase QUALIFIES it: "LARGE GLIDERS
	// MODEL FLYING ACT" (W1849/26) is model flying, not gliding, so the
	// pattern takes the noun with it and starts where the craft rule would.
	{ kind: 'aeromodelisme', re: /\bAEROMODEL\w*\b|\bAEM\b|\b(?:(?:LARGE\s+|SMALL\s+)?(?:GLIDERS?|PLANEURS?|ULM|DRONES?|AVIONS?|ACFT|AIRCRAFT|HELICOPTERES?)\s+)?MODD?ELL?\s+(?:AIRCRAFT|ACFT|FLY(?:ING)?|ACT\w*)\b/ },
	// VOL LIBRE is the French umbrella for hang / paragliding.
	// A winch word before the craft QUALIFIES it, the way a model phrase
	// does: "TREUIL PARAPENTE" is paragliding, and taking the winch word
	// with the craft is what keeps it ahead of the bare-winch rule below
	// now that the earliest match in the text wins.
	{ kind: 'paragliding', re: /\b(?:(?:TREUILS?|TREUILLAGES?|WINCH(?:ING|ED)?)\s+)?(PARAPENTES?|PARAGLIDERS?|PARAGLIDING|HANG\s+GLIDING|VOL\s+LIBRE)\b/ },
	// VELIVOLE is the French adjective of gliding, "ACTIVITES VELIVOLES"
	// where the English says GLIDING (R1313/26).
	{ kind: 'glider', re: /\b(?:(?:TREUILS?|TREUILLAGES?|WINCH(?:ING|ED)?)\s+)?(PLANEURS?|VOL\s+A\s+VOILE|VELIVOLES?|GLIDERS?|GLIDING)\b/ },
	// Winch sites (ENR 5.5) whose text names no craft: TREUILLAGE NR 957 /
	// WINCHING ACTIVITY NR 957. The French treuillage sites are
	// predominantly vol libre, so the bare forms take the paraglider icon;
	// craft-specific texts (TREUIL PLANEURS, GLIDER WINCH LAUNCH,
	// TREUILLAGE PARAPENTE) hit their own rule above first.
	{ kind: 'paragliding', re: /\bTREUILLAGES?\b|\bTREUILS?\b|\bWINCH(?:ING|ED)?\b/ },
	// PJE is the US/Canadian standard abbreviation for Parachute Jumping
	// Exercise ("AIRSPACE PJE WI AN AREA DEFINED AS 1NM RADIUS OF X").
	// DROP ZONE and bare WINGSUIT texts are the same activity.
	{ kind: 'parachute', re: /\bPARACHUTE\b|\bPARACHUTING\b|\bPARACHUTAGES?\b|\bPARACHUTISTES?\b|\bSKYDIVING\b|\bPJE\b|\bDROP\s+ZONES?\b|\bWINGSUITS?\b/ },
	// UNMANN?ED\s+(?:AI?RCRAFT|ACFT|AERIAL|FLIGHTS?) catches the long form,
	// the SIA abbreviation ("OUT OF SIGHT UNMANNED ACFT FLIGHTS"), the
	// craft-less "UNMANNED FLIGHTS", and the real UNMANED / UNMMANNED /
	// AICRAFT typos the corpora carry (R2487/26). UAS? covers the bare UA ("ENTRY PROHIBITED FOR ALL
	// ACFT INCLUDING UA"); BVLOS is the beyond-visual-line-of-sight
	// abbreviation. SANS EQUIPAGE stands alone because the French texts
	// split it from AERONEFS ("AERONEFS D'ETAT AVEC ET SANS EQUIPAGE A
	// BORD"); REMOTE CONTROLL?ED likewise carries its corpus typo. REMOTE
	// PILOT is the English of TELEPILOTE (R3504/26).
	{ kind: 'drone', re: /\b(UAS?|UAV|RPAS?|DRONES?|UNM?MANN?ED(?:\s+[A-Z-]+){0,2}\s+(?:AI?R?CRAFTS?|ACFT|AERIAL|FLIGHTS?)|REMOTELY\s+PILOTED|REMOTE\s+PILOTS?|REMOTE\s+CONTROLL?ED|BVLOS|SANS\s+EQUIPAGE|TELEPILOTES?)\b/ },
	// FRNG is the standard NOTAM abbreviation for firing ("DANGER AREA
	// ACTIVATED. FRNG WILL TAKE PLACE INTO THE FLW AREA: ..."), and SHOOTING
	// the English of TIR ("SMALL CALIBER SHOOTING", R2989/26).
	{ kind: 'firing', re: /\bGUNS?\b|\bFIRING\b|\bSHOOTING\b|\bROCKETS?\b|\bMISSILES?\b|\bTIRS?\b|\bFRNG\b/ },
	// FIRE\s*WORKS? allows the singular FIREWORK and the split FIRE WORKS
	// spelling, both seen in real briefings. PYROTECHNIC(S?) is the English
	// form; PYROTECHNIQUE stays for French, joined by the rest of the
	// French demolition vocabulary (a TIR DE MINE still lands on firing
	// above, an ordering the specs pin).
	{ kind: 'blasting', re: /\bBLASTING\b|\bDEMOLITION\b|\bEXPLOSIVES?\b|\bEXPLOSIFS?\b|\bFIRE\s*WORKS?\b|\bFEUX?\s+D'ARTIFICE\b|\bARTIFICES?\b|\bMINAGE\b|\bDEMINAGE\b|\bPYROTECHNICS?\b|\bPYROTECHNIQUES?\b/ },
	// AVIAIRE is the French adjective of birds: PERIL AVIAIRE, and the
	// ACTIVITE AVIAIRE of a BIRD ACTIVITY (A3315/26).
	{ kind: 'bird', re: /\bBIRDS?\b|\bWILDLIFE\s+HAZARD\b|\bOISEAUX?\b|\bAVIAIRES?\b/ },
	{ kind: 'laser', re: /\bLASER\b/ },
];

/** Neither tier matched. `balisage` is a fallback because a lighting
 *  NOTAM usually names the obstacle that is lit, and that obstacle is the
 *  icon it should carry; `ulm` because a venue mention ("PARACHUTAGES SUR
 *  PLATEFORME ULM") must keep its real activity. */
const FALLBACK_RULES: readonly Rule[] = [
	// BALISAGE/OBSTACLE LIGHT is a fallback: lighting NOTAMs usually also name
	// the obstacle, which an earlier rule will have matched. BALISAGE followed
	// by ':' or '=' is a descriptive attribute, not the subject; skip it.
	// Standalone LIGHTING / LGT(S) / plural LIGHTS and their French twin,
	// plural FEUX (all under the same attribute guard; the plurals keep
	// LIGHT ACFT and FEU/fire out): "TWY P1 LGT U/S", "FLASHING LIGHTS RWY
	// 22 U/S" and "FEUX A ECLATS RWY 22 HORS SERVICE" are the same NOTAMs
	// the French BALISAGE wording has always pinned, so the languages stay
	// symmetric. FL(?:AS|SA)HING carries the corpus typo, and LIGTHING
	// another (H0404/26). ECLAIRAGE is the French of LIGHTING (A6635/26),
	// and a lighting word followed by NIL says there is none: "BALISAGE
	// NIL" on an unlit rock (P4197/26) reads as the English "LIGHTING :
	// NIL" does, as nothing.
	{ kind: 'balisage', re: /\bBALISAGES?\b(?!\s*(?:[:=]|NIL\b))|\bBEACONING\b(?!\s*(?:[:=]|NIL\b))|\bPHARE\s+DE\s+DANGER\b|\bOBST(?:ACLE)?\s+(?:LIGHTS?|LGTS?|LIGHTING)\b|\bLIG(?:HT|TH)ING\b(?!\s*(?:[:=]|NIL\b))|\bLGTS?\b(?!\s*(?:[:=]|NIL\b))|\bLIGHTS\b(?!\s*(?:[:=]|NIL\b))|\bFL(?:AS|SA)HING\s+LIGHTS?\b|\bECLAIRAGES?\b(?!\s*(?:[:=]|NIL\b))|\bFEUX\b(?!\s*(?:[:=]|NIL\b))|\bFEU\s+A\s+ECLATS\b/ },
	// ULM sites and gatherings. Last on purpose: a venue mention
	// ("PARACHUTAGES SUR PLATEFORME ULM ...") must keep its real activity.
	{ kind: 'ulm', re: /\bULM\b|\bMICRO\s?LIGHTS?\b|\bULTRA[\s-]?LIGHTS?\b/ },
];
