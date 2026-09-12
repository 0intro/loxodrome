/**
 * Classify a NOTAM E) section into a coarse obstacle / activity type. Returns
 * one of crane|turbine|metmast|antenna|chimney|powerline|cableway|terrain|
 * trees|balloon|voltige|aeromodelisme|paragliding|glider|parachute|drone|
 * firing|blasting|bird|laser|balisage|ulm, or '' when nothing matches.
 *
 * Order matters: when keywords overlap, the first match wins.
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
	const kind = classifyText(eText);
	if (kind) {
		return kind;
	}
	return QSUBJECT_FALLBACK[qCode ? qCode.slice(1, 3) : ''] ?? '';
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

function classifyText(eText: string | null | undefined): string {
	if (!eText) {
		return '';
	}
	const t = eText.toUpperCase();
	// OBST RIG / OBST SCISSOR LIFT are temporary mechanical equipment in
	// the same family as a crane (drilling rigs, maintenance lifts; both
	// visual hazards from the cockpit are mechanical structures). ENGIN DE
	// LEVAGE / LIFTING EQUIPMENT, ENGIN DE CHANTIER / CONSTRUCTION
	// MACHINERY and NACELLE are the French SIA forms and their own English
	// renderings; the SIA translates an erected NACELLE (aerial work
	// platform) as GONDOLA (P2013/26), so that word joins the family too.
	// FOREUSE / DRILL / DIGGER stay out on purpose.
	if (
		/\b(GRUES?|CRANES?)\b|\bOBST\s+RIGS?\b|\bOBST\s+SCISSOR\s+LIFTS?\b|\bENGINS?\s+DE\s+LEVAGE\b|\bLIFTING\s+EQUIPMENT\b|\bENGINS?\s+DE\s+CHANTIER\b|\bENGINS?\s+BTP\b|\bCONSTRUCTION\s+MACHINERY\b|\bNACELLES?\b|\bGONDOLAS?\b/.test(
			t,
		)
	)
		return 'crane';
	// WIND\s*TURBINE catches both `WIND TURBINE` and `WINDTURBINE` (one-word
	// spelling common in autorouter briefings). Same for WIND\s*FARM and
	// WIND\s*PARK. WINDMILL is the German-origin informal name used in EDLA
	// / EDGG NOTAMs. WINFARM is a real typo seen in `france.txt` P0618/26;
	// the misspelling persists across cycles so it's worth catching.
	// EOLIENS? is the adjective, which is all a PARC EOLIEN names.
	if (
		/\b(EOLIENNES?|EOLIENS?|WIND\s*TURBINES?|WIND\s*FARM|WIND\s*PARK|WINFARM|WINDMILLS?|WTG)\b/.test(
			t,
		)
	)
		return 'turbine';
	// MEA?SURING covers both the standard MEASURING and the French-
	// influenced misspelling MESURING seen in real autorouter briefings.
	// OBST MAST is the generic "obstacle: mast" form ("LIT OBST MAST
	// 3150FT AMSL", "OBST MAST NR 80137 LIGHTING U/S") that doesn't
	// specify what kind of mast; grouping it under metmast keeps the
	// mast-shape icon consistent across all mast variants. OBST
	// ANEMOMETRIC is the French SIA form for a wind-measurement mast.
	// MATS?\s+(NR\s+)?\d is the French numbered-mast citation ("BALISAGE
	// LUMINEUX DU MAT 80137 HORS SERVICE"), the twin of OBST MAST NR texts.
	if (
		/\bMATS?\s+DE\s+MESURE\b|\bMET\s+MAST\b|\bMEASUREMENT\s+MAST\b|\bMEA?SURING\s+MAST\b|\bOBST\s+MAST\b|\bOBST\s+ANEMOMETRIC\b|\bMATS?\s+(?:NR\s+)?\d/.test(
			t,
		)
	)
		return 'metmast';
	// OBST TOWER is the FAA shorthand for an Antenna Structure Registry
	// (ASR) tower, the bulk of US obstacle NOTAMs ("OBST TOWER LGT (ASR
	// 1208783) ... U/S"). OBST RADIO is the French SIA radio-mast form.
	// OBST POLE covers generic vertical poles (FAA "OBST POLE LGT (ASN
	// X) ... U/S"). All three live with antennas/pylons - same broadcast
	// / communication tower family.
	if (
		/\b(ANTENNES?|ANTENNAS?|PYLONES?|PYLONS?)\b|\bOBST\s+TOWER\b|\bOBST\s+RADIO\b|\bOBST\s+POLES?\b/.test(
			t,
		)
	)
		return 'antenna';
	// OBST STACK is the FAA shorthand for a smokestack ("OBST STACK
	// (ASN UNKNOWN) ... NOT LGTD"); SMOKE STACK the SIA's own English
	// ("SMOKE STACK NR 59004 LIGHTS U/S"); same icon as chimney.
	if (/\b(CHEMINEES?|CHIMNEYS?)\b|\bOBST\s+STACK\b|\bSMOKE\s+STACKS?\b/.test(t))
		return 'chimney';
	if (
		/\bLIGNES?\s+(TRES\s+)?HAUTE\s+TENSION\b|\bLIGNES?\s+ELECTRIQUES?\b|\bLIGNES?\s+T?HT\b|\bPOWER\s+LINES?\b/.test(
			t,
		)
	)
		return 'powerline';
	// Cable transport spanning valleys (passenger or material); distinct
	// from powerlines in the data even though both are wires in the sky.
	// CABLE alone is too ambiguous (ground cables, control cables); require
	// the compound form. The French ski-lift family (remontees mecaniques)
	// rides the same icon.
	if (
		/\bCABLEWAYS?\b|\bCABLE\s+CARS?\b|\bTELEPHERIQUES?\b|\bREMONTEES?\s+MECANIQUES?\b|\bTELESIEGES?\b|\bTELECABINES?\b|\bTELESKIS?\b|\bTYROLIENNES?\b|\bZIP\s*LINES?\b/.test(
			t,
		)
	)
		return 'cableway';
	// OBST HILL is the FAA pattern for natural terrain that exceeds the
	// obstacle thresholds ("OBST HILL (ASN UNKNOWN) ... NOT LGTD"); the
	// terrain icon distinguishes them from trees / vegetation.
	if (/\bOBST\s+HILLS?\b|\bOBST\s+TERRAIN\b/.test(t)) return 'terrain';
	// PLANTS (plural only: POWER PLANT must not land here) is the SIA's
	// English for the VEGETAUX texts ("PRESENCE OF PLANTS NEAR ...").
	if (
		/\b(ARBRES?|TREES?|VEGETAL|VEGETAUX|VEGETATION|FOREST|FORETS?|PLANTS)\b/.test(
			t,
		)
	)
		return 'trees';
	// Kite-flying NOTAMs ("ASCENT OF KITES 1NM RADIUS") share the balloon
	// icon: both are light unmanned objects in airspace, same visual cue
	// from the cockpit. UK regulatory boilerplate that lists kites among
	// other items always contains BALLOON earlier, so the existing balloon
	// match already wins for that text. AEROSTAT is the French generic for
	// lighter-than-air craft, MONTGOLFIERE the hot-air balloon.
	if (
		/\bBALLOONS?\b|\bBALLONS?\b|\bKITES?\b|\bAEROSTATS?\b|\bMONTGOLFIERES?\b/.test(
			t,
		)
	)
		return 'balloon';
	// AIRSHOW / AIR DISPLAY map to voltige; they're aerobatic events even
	// when the briefing doesn't spell out AEROBATICS explicitly. The French
	// forms are PRESENTATION / MANIFESTATION AERIENNE and MEETING AERIEN.
	if (
		/\bVOLTIGE\b|\bAEROBATICS?\b|\bAIRSHOWS?\b|\bAIR\s+SHOWS?\b|\bAIR\s+DISPLAYS?\b|\bAERIAL\s+DISPLAYS?\b|\bPRESENTATIONS?\s+AERIENNES?\b|\bMANIFESTATIONS?\s+AERIENNES?\b|\bMEETINGS?\s+AERIENS?\b/.test(
			t,
		)
	)
		return 'voltige';
	// AEROMODEL\w* takes every derivation the corpora show: AEROMODELISME,
	// the English AEROMODELISM / AEROMODELLING, and the clipped AEROMODEL
	// ACT. MODEL ACT\w* is the abbreviated "MODEL ACT NR ..." form.
	if (
		/\bAEROMODEL\w*\b|\bMODEL\s+(?:AIRCRAFT|ACFT|FLYING|ACT\w*)\b/.test(t)
	)
		return 'aeromodelisme';
	// VOL LIBRE is the French umbrella for hang / paragliding.
	if (
		/\b(PARAPENTES?|PARAGLIDERS?|PARAGLIDING|HANG\s+GLIDING|VOL\s+LIBRE)\b/.test(
			t,
		)
	)
		return 'paragliding';
	if (/\b(PLANEURS?|VOL\s+A\s+VOILE|GLIDERS?|GLIDING)\b/.test(t)) return 'glider';
	// Winch sites (ENR 5.5) whose text names no craft: TREUILLAGE NR 957 /
	// WINCHING ACTIVITY NR 957. The French treuillage sites are
	// predominantly vol libre, so the bare forms take the paraglider icon;
	// craft-specific texts (TREUIL PLANEURS, GLIDER WINCH LAUNCH,
	// TREUILLAGE PARAPENTE) hit their own rule above first.
	if (/\bTREUILLAGES?\b|\bTREUILS?\b|\bWINCH(?:ING|ED)?\b/.test(t))
		return 'paragliding';
	// PJE is the US/Canadian standard abbreviation for Parachute Jumping
	// Exercise ("AIRSPACE PJE WI AN AREA DEFINED AS 1NM RADIUS OF X").
	// DROP ZONE and bare WINGSUIT texts are the same activity.
	if (
		/\bPARACHUTE\b|\bPARACHUTING\b|\bPARACHUTAGES?\b|\bPARACHUTISTES?\b|\bSKYDIVING\b|\bPJE\b|\bDROP\s+ZONES?\b|\bWINGSUITS?\b/.test(
			t,
		)
	)
		return 'parachute';
	// UNMANN?ED\s+(?:AI?RCRAFT|ACFT|AERIAL|FLIGHTS?) catches the long form,
	// the SIA abbreviation ("OUT OF SIGHT UNMANNED ACFT FLIGHTS"), the
	// craft-less "UNMANNED FLIGHTS", and the real UNMANED / AICRAFT typos
	// the corpora carry. UAS? covers the bare UA ("ENTRY PROHIBITED FOR ALL
	// ACFT INCLUDING UA"); BVLOS is the beyond-visual-line-of-sight
	// abbreviation. SANS EQUIPAGE stands alone because the French texts
	// split it from AERONEFS ("AERONEFS D'ETAT AVEC ET SANS EQUIPAGE A
	// BORD"); REMOTE CONTROLL?ED likewise carries its corpus typo.
	if (
		/\b(UAS?|UAV|RPAS?|DRONES?|UNMANN?ED\s+(?:STATE\s+)?(?:AI?R?CRAFTS?|ACFT|AERIAL|FLIGHTS?)|REMOTELY\s+PILOTED|REMOTE\s+CONTROLL?ED|BVLOS|SANS\s+EQUIPAGE|TELEPILOTES?)\b/.test(
			t,
		)
	)
		return 'drone';
	// FRNG is the standard NOTAM abbreviation for firing ("DANGER AREA
	// ACTIVATED. FRNG WILL TAKE PLACE INTO THE FLW AREA: ...").
	if (/\bGUNS?\b|\bFIRING\b|\bROCKETS?\b|\bMISSILES?\b|\bTIRS?\b|\bFRNG\b/.test(t))
		return 'firing';
	// FIRE\s*WORKS? allows the singular FIREWORK and the split FIRE WORKS
	// spelling, both seen in real briefings. PYROTECHNIC(S?) is the English
	// form; PYROTECHNIQUE stays for French, joined by the rest of the
	// French demolition vocabulary (a TIR DE MINE still lands on firing
	// above, an ordering the specs pin).
	if (
		/\bBLASTING\b|\bDEMOLITION\b|\bEXPLOSIVES?\b|\bEXPLOSIFS?\b|\bFIRE\s*WORKS?\b|\bFEUX?\s+D'ARTIFICE\b|\bARTIFICES?\b|\bMINAGE\b|\bDEMINAGE\b|\bPYROTECHNICS?\b|\bPYROTECHNIQUES?\b/.test(
			t,
		)
	)
		return 'blasting';
	if (/\bBIRDS?\b|\bWILDLIFE\s+HAZARD\b|\bOISEAUX?\b|\bPERIL\s+AVIAIRE\b/.test(t))
		return 'bird';
	if (/\bLASER\b/.test(t)) return 'laser';
	// BALISAGE/OBSTACLE LIGHT is a fallback: lighting NOTAMs usually also name
	// the obstacle, which an earlier rule will have matched. BALISAGE followed
	// by ':' or '=' is a descriptive attribute, not the subject; skip it.
	// Standalone LIGHTING / LGT(S) / plural LIGHTS and their French twin,
	// plural FEUX (all under the same attribute guard; the plurals keep
	// LIGHT ACFT and FEU/fire out): "TWY P1 LGT U/S", "FLASHING LIGHTS RWY
	// 22 U/S" and "FEUX A ECLATS RWY 22 HORS SERVICE" are the same NOTAMs
	// the French BALISAGE wording has always pinned, so the languages stay
	// symmetric. FL(?:AS|SA)HING carries the corpus typo.
	if (
		/\bBALISAGE\b(?!\s*[:=])|\bPHARE\s+DE\s+DANGER\b|\bOBST(?:ACLE)?\s+(?:LIGHTS?|LGTS?|LIGHTING)\b|\bLIGHTING\b(?!\s*[:=])|\bLGTS?\b(?!\s*[:=])|\bLIGHTS\b(?!\s*[:=])|\bFL(?:AS|SA)HING\s+LIGHTS?\b|\bFEUX\b(?!\s*[:=])|\bFEU\s+A\s+ECLATS\b/.test(
			t,
		)
	)
		return 'balisage';
	// ULM sites and gatherings. Last on purpose: a venue mention
	// ("PARACHUTAGES SUR PLATEFORME ULM ...") must keep its real activity.
	if (/\bULM\b/.test(t)) return 'ulm';
	return '';
}
