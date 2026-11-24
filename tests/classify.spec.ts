import { describe, it, expect } from 'vitest';
import { classifyObstacle } from '$lib/notam';

// Unit tests for obstacle type classifier

describe('classifyObstacle', () => {
	it('should classify French keywords', () => {
		expect(classifyObstacle('GRUE MOBILE ERIGEE')).toBe('crane');
		expect(classifyObstacle('PARC DES 2 NOUES DE 2 EOLIENNES A FAUX-FRESNAY')).toBe('turbine');
		expect(classifyObstacle('BALISAGE OBST MAT DE MESURE NR 14049')).toBe('metmast');
		expect(classifyObstacle('ANTENNE GSM SUR LE TOIT')).toBe('antenna');
		expect(classifyObstacle('PYLONE TELECOM')).toBe('antenna');
		expect(classifyObstacle('CHEMINEE D USINE')).toBe('chimney');
		expect(classifyObstacle('LIGNE TRES HAUTE TENSION RELIANT CORDEMAIS')).toBe('powerline');
		expect(classifyObstacle('LIGNE HAUTE TENSION')).toBe('powerline');
		expect(classifyObstacle('OBSTACLES VEGETAUX A PROXIMITE')).toBe('trees');
		expect(classifyObstacle('ARBRES EN BORDURE DE PISTE')).toBe('trees');
		expect(classifyObstacle('VOLTIGE AERIENNE')).toBe('voltige');
		expect(classifyObstacle('ACTIVITE D AEROMODELISME')).toBe('aeromodelisme');
		expect(classifyObstacle('TREUILLAGE PARAPENTE')).toBe('paragliding');
		expect(classifyObstacle('LARGAGE PARACHUTISTES SECTEUR CHATEL')).toBe('parachute');
		expect(classifyObstacle('PARACHUTAGE')).toBe('parachute');
		expect(classifyObstacle('VOL A VOILE')).toBe('glider');
		expect(classifyObstacle('PLANEURS')).toBe('glider');
		expect(classifyObstacle('ACTIVITE D AERONEFS SANS EQUIPAGE A BORD')).toBe('drone');
		expect(classifyObstacle('DRONE OPERATIONS')).toBe('drone');
		expect(classifyObstacle('TIRS DE MINE')).toBe('firing');
		expect(classifyObstacle('OISEAUX SUR LA PISTE')).toBe('bird');
		expect(classifyObstacle('PYROTECHNIQUE')).toBe('blasting');
		// French plurals classify like their singulars (bilingual coherence).
		expect(classifyObstacle('LACHER DE BALLONS')).toBe('balloon');
		expect(classifyObstacle('SPECTACLES PYROTECHNIQUES')).toBe('blasting');
		expect(classifyObstacle('LASER')).toBe('laser');
		expect(classifyObstacle('BALISAGE LUMINEUX HORS SERVICE')).toBe('balisage');
		expect(classifyObstacle('PHARE DE DANGER U/S')).toBe('balisage');
		// "BALISAGE :" / "BALISAGE =" is an attribute line on an obstacle
		// NOTAM (e.g. P0876/26 drill rig), not a lighting NOTAM subject.
		expect(classifyObstacle('FOREUSE\nBALISAGE : JOUR ET NUIT')).toBe('');
		expect(classifyObstacle('BALISAGE=JOUR ET NUIT')).toBe('');
	});

	it('should classify English keywords', () => {
		expect(classifyObstacle('TEMPORARY CRANE ERECTED')).toBe('crane');
		// FAA OBST RIG / OBST SCISSOR LIFT - temporary mechanical equipment.
		expect(classifyObstacle('OBST RIG (ASN UNKNOWN) NOT LGTD')).toBe('crane');
		expect(classifyObstacle('OBST SCISSOR LIFT 60FT AGL NOT LGTD')).toBe('crane');
		expect(classifyObstacle('WIND TURBINE BLADE')).toBe('turbine');
		// One-word spellings seen in real autorouter briefings (P0618/26
		// "WINFARM 3 WINDTURBINES AT 'BOISSY LA RIVIERE'").
		expect(classifyObstacle('WINDTURBINE OPR AT BOISSY')).toBe('turbine');
		expect(classifyObstacle('3 WINDTURBINES ERECTED')).toBe('turbine');
		expect(classifyObstacle('WINDFARM 3 WINDTURBINES')).toBe('turbine');
		expect(classifyObstacle('WINFARM TYPO')).toBe('turbine');
		expect(classifyObstacle('WIND PARK BLADE TIP HGT')).toBe('turbine');
		// German EDLA / EDGG NOTAMs use WINDMILL for what is functionally a
		// wind turbine ("WINDMILL PSN 3NM NE ARP ARNSBERG-MENDEN").
		expect(classifyObstacle('WINDMILL PSN 3NM NE ARP')).toBe('turbine');
		expect(classifyObstacle('WTG ARRAY')).toBe('turbine');
		expect(classifyObstacle('WIND FARM')).toBe('turbine');
		expect(classifyObstacle('MET MAST INSTALLED')).toBe('metmast');
		expect(classifyObstacle('MEASUREMENT MAST')).toBe('metmast');
		expect(classifyObstacle('MEASURING MAST AT CHEVRU')).toBe('metmast');
		expect(classifyObstacle('WIND MEASURING MAST OPR')).toBe('metmast');
		// French-influenced misspelling seen in real autorouter briefings.
		expect(classifyObstacle('WIND MESURING MAST')).toBe('metmast');
		// Generic obstacle-mast form ("LIT OBST MAST 3150FT AMSL").
		expect(classifyObstacle('OBST MAST NR 80137 LIGHTING U/S')).toBe('metmast');
		expect(classifyObstacle('LIT OBST MAST 3150FT AMSL')).toBe('metmast');
		// A bare mast is the same generic mast, and a radio mast an antenna.
		expect(classifyObstacle("OBST : MAST AT 'ILLOIS'")).toBe('metmast');
		expect(classifyObstacle("MAST OPR AT 'CHAMARANDES CHOIGNES'")).toBe('metmast');
		expect(
			classifyObstacle("MAST NR 02170 LIGHTING U/S ('MAISSEMY' VILLAGE)"),
		).toBe('metmast');
		expect(classifyObstacle('OBST (MEASURING MAT) - RDL307/9.20NM LFSS ARP')).toBe(
			'metmast',
		);
		expect(classifyObstacle("RADIO MAST OPR AT 'PARIS ORLY' AD")).toBe('antenna');
		expect(classifyObstacle('TV MAST 51M ERECTED')).toBe('antenna');
		expect(classifyObstacle('TEMPORARY COMMUNICATION MAST ERECTED')).toBe('antenna');
		// A mast that names its radio, navaid or network is an antenna.
		expect(classifyObstacle('NDB MAST OBSTRUCTION LIGHT U/S')).toBe('antenna');
		expect(classifyObstacle('EXTENDED RANGE VHF MAST AT PSN 052548.96N')).toBe('antenna');
		expect(classifyObstacle('ERECTED WI AD AREA: 1. RADAR MAST, ALT 372.35M')).toBe('antenna');
		expect(classifyObstacle('TEMPORARY MOBILE PHONE MAST ERECTED')).toBe('antenna');
		expect(classifyObstacle('MESAION RHODES TRANSMISSION MAST OBST LGT U/S.')).toBe('antenna');
		expect(classifyObstacle('LGT UK29460081F RTM BILSDALE MAST SINGLE U/S')).toBe('antenna');
		expect(classifyObstacle('UK0171A245F RTM RTM WINTER HILL MAST SINGLE U/S')).toBe('antenna');
		// A power line's mast is the power line, and a drilling mast stays
		// bare with the drills.
		expect(classifyObstacle('OBST TYPE: 10 HIGH-VOLTAGE LINE MASTS')).toBe('powerline');
		expect(classifyObstacle('OBST LGT HIGH-TENSION LINE MAST LUEHESAND')).toBe('powerline');
		expect(classifyObstacle('500M OR MORE CONSIDERING PWR LINE MASTS')).toBe('powerline');
		expect(classifyObstacle('OBST ERECTED (DRILING MAST): PSN:314501.85N')).toBe('');
		expect(classifyObstacle('DAY AND NIGHT MARKED TYPE:DRILLING MAST PSN')).toBe('');
		// SX-MAT is the registration of an aircraft.
		expect(classifyObstacle('AIR MEDITERRANEAN: SX-MAM, SX-MAT')).toBe('');
		// French SIA wind-measurement mast.
		expect(classifyObstacle('OBST ANEMOMETRIC MAST AT X')).toBe('metmast');
		expect(classifyObstacle('ANTENNA MAST')).toBe('antenna');
		// FAA Antenna Structure Registry tower NOTAMs.
		expect(classifyObstacle('OBST TOWER LGT (ASR 1208783) U/S')).toBe('antenna');
		// French SIA radio-mast form; FAA generic pole form.
		expect(classifyObstacle('OBST RADIO MAST HGT 200FT')).toBe('antenna');
		expect(classifyObstacle('OBST POLE LGT (ASN X) U/S')).toBe('antenna');
		expect(classifyObstacle('CHIMNEY STACK')).toBe('chimney');
		// FAA shorthand for an industrial smokestack.
		expect(classifyObstacle('OBST STACK (ASN UNKNOWN) NOT LGTD')).toBe('chimney');
		expect(classifyObstacle('POWER LINE')).toBe('powerline');
		// Cableways are Alpine-country cable transport spanning valleys;
		// distinct from powerlines in the source data (LOVV / LSAS / LIPP).
		expect(classifyObstacle('CABLEWAY FOR MATERIAL TRANSPORT')).toBe('cableway');
		expect(classifyObstacle('CABLEWAYS IDENT 45505')).toBe('cableway');
		expect(classifyObstacle('CABLE CAR LINE ERECTED')).toBe('cableway');
		expect(classifyObstacle('TELEPHERIQUE DE CHAMONIX')).toBe('cableway');
		// FAA natural-terrain obstacle ("OBST HILL (ASN UNKNOWN) 763FT NOT LGTD").
		expect(classifyObstacle('OBST HILL 763FT NOT LGTD')).toBe('terrain');
		expect(classifyObstacle('OBST TERRAIN UNKNOWN ELEV')).toBe('terrain');
		expect(classifyObstacle('TREE OBSTACLE')).toBe('trees');
		expect(classifyObstacle('TREES NEAR RUNWAY')).toBe('trees');
		expect(classifyObstacle('VEGETATION')).toBe('trees');
		expect(classifyObstacle('CAPTIVE BALLOON')).toBe('balloon');
		expect(classifyObstacle('TETHERED BALLOON')).toBe('balloon');
		// Kite-flying NOTAMs share the balloon icon (light unmanned objects).
		expect(classifyObstacle('ASCENT OF KITES 1NM RADIUS')).toBe('balloon');
		expect(classifyObstacle('KITE FLYING ACTIVITY')).toBe('balloon');
		expect(classifyObstacle('AEROBATIC FLIGHT')).toBe('voltige');
		expect(classifyObstacle('AEROBATICS')).toBe('voltige');
		// AIRSHOW / AIR DISPLAY are aerobatic events even when AEROBATICS
		// itself isn't spelled out in the briefing.
		expect(classifyObstacle('AIRSHOW AT LE BOURGET')).toBe('voltige');
		expect(classifyObstacle('AIR SHOW')).toBe('voltige');
		expect(classifyObstacle('AIR DISPLAY OVER MURTEN')).toBe('voltige');
		expect(classifyObstacle('AERIAL DISPLAY')).toBe('voltige');
		expect(classifyObstacle('MODEL AIRCRAFT')).toBe('aeromodelisme');
		expect(classifyObstacle('MODEL FLYING')).toBe('aeromodelisme');
		expect(classifyObstacle('PARAGLIDER LAUNCH')).toBe('paragliding');
		expect(classifyObstacle('PARAGLIDING ACTIVITY')).toBe('paragliding');
		expect(classifyObstacle('HANG GLIDING')).toBe('paragliding');
		expect(classifyObstacle('PARACHUTE JUMPING')).toBe('parachute');
		expect(classifyObstacle('SKYDIVING')).toBe('parachute');
		// PJE: US/Canadian abbreviation for Parachute Jumping Exercise.
		expect(classifyObstacle('AIRSPACE PJE WI AN AREA DEFINED AS 1NM RADIUS')).toBe('parachute');
		expect(classifyObstacle('GLIDER ACTIVITY')).toBe('glider');
		expect(classifyObstacle('GLIDING COMPETITION')).toBe('glider');
		expect(classifyObstacle('UNMANNED AIRCRAFT OPERATIONS')).toBe('drone');
		// SIA abbreviated form (ACFT instead of AIRCRAFT).
		expect(classifyObstacle('OUT OF SIGHT UNMANNED ACFT FLIGHTS')).toBe('drone');
		expect(classifyObstacle('REMOTELY PILOTED AIRCRAFT')).toBe('drone');
		expect(classifyObstacle('UAS FLIGHTS')).toBe('drone');
		expect(classifyObstacle('RPAS')).toBe('drone');
		expect(classifyObstacle('GUN FIRING')).toBe('firing');
		expect(classifyObstacle('ROCKET LAUNCH')).toBe('firing');
		expect(classifyObstacle('MISSILE TEST')).toBe('firing');
		// FRNG: standard NOTAM abbreviation for firing.
		expect(classifyObstacle('DANGER AREA ACTIVATED. FRNG WILL TAKE PLACE')).toBe('firing');
		expect(classifyObstacle('BLASTING OPERATIONS')).toBe('blasting');
		expect(classifyObstacle('DEMOLITION')).toBe('blasting');
		expect(classifyObstacle('EXPLOSIVES')).toBe('blasting');
		expect(classifyObstacle('FIREWORKS DISPLAY')).toBe('blasting');
		// Singular and English-form pyrotechnic both seen in briefings.
		expect(classifyObstacle('FIREWORK DISPLAY')).toBe('blasting');
		expect(classifyObstacle('PYROTECHNIC ACTIVITY')).toBe('blasting');
		expect(classifyObstacle('PYROTECHNICS')).toBe('blasting');
		expect(classifyObstacle('BIRD HAZARD')).toBe('bird');
		expect(classifyObstacle('BIRD ACTIVITY')).toBe('bird');
		expect(classifyObstacle('WILDLIFE HAZARD')).toBe('bird');
		expect(classifyObstacle('LASER ACTIVITY')).toBe('laser');
		expect(classifyObstacle('LASER BEAM')).toBe('laser');
		expect(classifyObstacle('OBST LGT U/S')).toBe('balisage');
		expect(classifyObstacle('OBSTACLE LIGHT UNSERVICEABLE')).toBe('balisage');
	});

	it('should be case-insensitive', () => {
		expect(classifyObstacle('grue mobile')).toBe('crane');
		expect(classifyObstacle('Eolienne')).toBe('turbine');
	});

	it('should return empty string when no keyword matches', () => {
		expect(classifyObstacle('')).toBe('');
		expect(classifyObstacle(null)).toBe('');
		expect(classifyObstacle('PARC NATIONAL DES CEVENNES')).toBe('');
	});

	it('should respect word boundaries', () => {
		// Should not match "GRIN" inside "PEREGRIN" via "GRUE"
		expect(classifyObstacle('PEREGRINE FALCON OPERATIONS')).toBe('');
		// "CRANES" plural should match
		expect(classifyObstacle('TWO CRANES ERECTED')).toBe('crane');
	});

	it('should pick the first match when multiple keywords appear', () => {
		// CRANE comes before ANTENNA in the rule order
		expect(classifyObstacle('CRANE NEAR ANTENNA')).toBe('crane');
		// EOLIENNE checked before MAT
		expect(classifyObstacle('EOLIENNE ON MAT DE MESURE')).toBe('turbine');
		// CRANE outranks the new cableway rule
		expect(classifyObstacle('CRANE ABOVE CABLEWAY')).toBe('crane');
		// Powerline still beats cableway when both keywords are present
		// (rule order is powerline, then cableway)
		expect(classifyObstacle('POWER LINE CROSSES CABLEWAY')).toBe('powerline');
	});
});

/* The France-corpus vocabulary: every phrase below is a real E) opening from
 * the world briefings or the SOFIA sweep (tests/classifyAudit.spec.ts holds
 * the corpus-wide cross-check against the Q-line subjects). */
describe('classifyObstacle France corpus vocabulary', () => {
	it('classifies the French forms', () => {
		expect(classifyObstacle('2 PYLONES ERIGES A PROXIMITE')).toBe('antenna');
		expect(classifyObstacle('CHEMINEES NR 59004')).toBe('chimney');
		expect(classifyObstacle('2 MATS DE MESURE ERIGES')).toBe('metmast');
		expect(classifyObstacle('OBST : MAT A ILLOIS')).toBe('metmast');
		expect(classifyObstacle('MAT RADIO SUR AERODROME PARIS ORLY')).toBe('antenna');
		expect(
			classifyObstacle('BALISAGE LUMINEUX DU MAT 80137 HORS SERVICE'),
		).toBe('metmast');
		expect(classifyObstacle('SURVOL DES FORETS DOMANIALES')).toBe('trees');
		expect(classifyObstacle('LIGNES ELECTRIQUES TRAVERSANT LA VALLEE')).toBe(
			'powerline',
		);
		expect(classifyObstacle('PARC EOLIEN E5310')).toBe('turbine');
		expect(classifyObstacle('ACTIVITE ENGIN DE LEVAGE SUR AD')).toBe('crane');
		expect(classifyObstacle('ENGIN BTP A CHATELLERAULT')).toBe('crane');
		expect(classifyObstacle('OBST : 2 NACELLES ERIGEES')).toBe('crane');
		expect(classifyObstacle('PRESENCE OISEAU SUR PISTE')).toBe('bird');
		expect(classifyObstacle('PERIL AVIAIRE RENFORCE')).toBe('bird');
		expect(classifyObstacle('AERONEF D ETAT TELEPILOTE HORS VUE')).toBe('drone');
		expect(
			classifyObstacle("AERONEFS D'ETAT AVEC ET SANS EQUIPAGE A BORD"),
		).toBe('drone');
		expect(classifyObstacle('LACHER DE MONTGOLFIERES')).toBe('balloon');
		expect(classifyObstacle('AEROSTAT CAPTIF GONFLE A L HELIUM')).toBe('balloon');
		expect(classifyObstacle("TYROLIENNE STATION 'CROIX DE BAUZON'")).toBe(
			'cableway',
		);
		expect(classifyObstacle('TELESIEGE DES MARMOTTES')).toBe('cableway');
		expect(classifyObstacle('REMONTEES MECANIQUES EN EXPLOITATION')).toBe(
			'cableway',
		);
		expect(classifyObstacle('FEUX A ECLATS PISTE 24 HORS SERVICE')).toBe(
			'balisage',
		);
		expect(classifyObstacle('FEUX ECLATS RWY 09 ET RWY 27 HORS SERVICE')).toBe(
			'balisage',
		);
		expect(classifyObstacle('TRAVAUX DE MINAGE EN CARRIERE')).toBe('blasting');
		expect(classifyObstacle("FEU D'ARTIFICE A SAINT-RAPHAEL")).toBe('blasting');
		expect(classifyObstacle('PRESENTATIONS AERIENNES ET ACTIVITES ASSOCIEES')).toBe(
			'voltige',
		);
		expect(classifyObstacle('MANIFESTATION AERIENNE DE CHOLET')).toBe('voltige');
		expect(classifyObstacle("ACTIVITE DE TREUILLAGE NR 957 'MEYENHEIM'")).toBe(
			'paragliding',
		);
		expect(classifyObstacle('ACTIVITE TREUILLAGE VOL LIBRE A BALANZAC')).toBe(
			'paragliding',
		);
		// Craft-specific winching keeps its own craft (glider before winch).
		expect(classifyObstacle('TREUIL PLANEURS SUR AD')).toBe('glider');
		expect(
			classifyObstacle(
				"NOTAM TRIGGER - AMDT AIP AIRAC PERM 12/26 WEF 26 NOV 2026. MODIFICATION AEM 9179 'SARRIAC BIGORRE'",
			),
		).toBe('aeromodelisme');
	});

	it('classifies the English forms and the corpus typos', () => {
		expect(classifyObstacle('AEROMODELISM ACTIVITY AT GARDOUCH')).toBe(
			'aeromodelisme',
		);
		expect(classifyObstacle("MODEL ACT NR 9497 'PAREMPUYRE' CHANGED")).toBe(
			'aeromodelisme',
		);
		expect(classifyObstacle('SEVERAL PIECES OF LIFTING EQUIPMENT OPR')).toBe(
			'crane',
		);
		expect(classifyObstacle('OBST : CONSTRUCTION MACHINERY')).toBe('crane');
		expect(classifyObstacle("OBST : 2 GONDOLAS OPR AT 'LE MANS'")).toBe('crane');
		expect(classifyObstacle('SMOKE STACK NR 59004 LIGHTS U/S')).toBe('chimney');
		expect(classifyObstacle("PRESENCE OF PLANTS NEAR 'CASTRES'")).toBe('trees');
		expect(classifyObstacle('DROP ZONE ACTIVE')).toBe('parachute');
		expect(classifyObstacle("WINGSUITS OVER 'MONT BLANC' AREA")).toBe(
			'parachute',
		);
		// Craft-specific winching first, the bare winch forms then take the
		// paraglider icon (the dominant ENR 5.5 use).
		expect(classifyObstacle("WINCH GLIDING ACTIVITY AT 'SAINT SAVINIEN'")).toBe(
			'glider',
		);
		expect(classifyObstacle("WINCHING ACTIVITY NR 957 'MEYENHEIM'")).toBe(
			'paragliding',
		);
		expect(classifyObstacle("FREE FLT WINCHING ACT AT 'OLERON'")).toBe(
			'paragliding',
		);
		expect(classifyObstacle('IN AND OUT OF SIGHT UNMANNED FLIGHTS')).toBe(
			'drone',
		);
		expect(classifyObstacle('UNMANED ACFT FLIGHT OUT OF SIGHT')).toBe('drone');
		expect(classifyObstacle('UNMANNED AICRAFT FLYING OUT OF SIGHT')).toBe(
			'drone',
		);
		expect(classifyObstacle('UNMANNED STATE AIRCRAFT IN THE SOUTH')).toBe(
			'drone',
		);
		expect(classifyObstacle('REMOTE CONTROLED UNMANNED STATE ACFT')).toBe(
			'drone',
		);
		expect(classifyObstacle('FOR UA BVLOS OPERATIONS')).toBe('drone');
		expect(classifyObstacle('ENTRY PROHIBITED FOR ALL ACFT INCLUDING UA')).toBe(
			'drone',
		);
		expect(classifyObstacle("FIRE WORKS AT SEA WI 'PORTICCIO' BAY")).toBe(
			'blasting',
		);
		expect(classifyObstacle('SEQUENCED FLASHING LIGHTS RWY 26 U/S')).toBe(
			'balisage',
		);
		expect(classifyObstacle('SEQUENCED FLSAHING LIGHTS DTHR 14 U/S')).toBe(
			'balisage',
		);
		expect(classifyObstacle('TWY P1 LGT U/S')).toBe('balisage');
		expect(classifyObstacle("ZIP LINE OPR AT 'CROIX DE BAUZON' STATION")).toBe(
			'cableway',
		);
	});

	it('keeps the plural-only light words and the ULM boundary strict', () => {
		// LIGHT ACFT is a light aircraft, FEU a fire; only the plurals and
		// the guarded forms mean lighting.
		expect(classifyObstacle('LIGHT ACFT ONLY')).toBe('');
		expect(classifyObstacle('FEU DETECTE PROCHE DU SEUIL')).toBe('');
		expect(classifyObstacle('DRILL ERECTED\nLIGHTING : DAY AND NIGHT')).toBe('');
		// ULMM is an airport ident, MULMO a waypoint; \bULM\b only.
		expect(classifyObstacle('ULMM AD CLSD')).toBe('');
	});

	it('classifies ULM last, so venue mentions keep their activity', () => {
		expect(classifyObstacle("RASSEMBLEMENT D'ULM DANS UN RAYON DE 80NM")).toBe(
			'ulm',
		);
		expect(
			classifyObstacle('PARACHUTAGES SUR PLATEFORME ULM DE CHANEINS (01)'),
		).toBe('parachute');
		expect(classifyObstacle('ACTIVITE AEROMODELISME SUR PLATEFORME ULM')).toBe(
			'aeromodelisme',
		);
	});

	it('falls back to the trusted Q-line subjects when the text says nothing', () => {
		expect(classifyObstacle('AREA ACTIVATED', 'QWPLW')).toBe('parachute');
		expect(classifyObstacle('AREA ACTIVATED', 'QWBLW')).toBe('voltige');
		expect(classifyObstacle('AREA ACTIVATED', 'QWLLW')).toBe('balloon');
		expect(classifyObstacle('AREA ACTIVATED', 'QWMLW')).toBe('firing');
		expect(
			classifyObstacle("EMISSION OF 'SKYTRACERS' TYPE LIGHT BEAM", 'QWOLW'),
		).toBe('laser');
		// The deviant subjects stay text-only: France files model flying
		// under WU and fireworks under WZ, so neither can be trusted blind.
		expect(classifyObstacle('AREA ACTIVATED', 'QWULW')).toBe('');
		expect(classifyObstacle('AREA ACTIVATED', 'QWZLW')).toBe('');
		// The text always wins over the subject.
		expect(classifyObstacle('VOLTIGE NR 6815', 'QWPLW')).toBe('voltige');
		// No Q-code, no fallback.
		expect(classifyObstacle('AREA ACTIVATED')).toBe('');
	});
});

describe('classifyObstacle, the November bilingual pairs', () => {
	// Pairs of the world briefing of 2026-11-22 whose two halves read
	// different kinds, and gaps of its residue (tests/classifyAudit.spec.ts).
	it('reads the obstacle forms in both languages', () => {
		// P3390/26: a tower crane is a crane, an FAA tower an antenna.
		expect(classifyObstacle('OBST TOWER CRANE OPR AT X')).toBe('crane');
		expect(classifyObstacle('OBST TOWER LGT (ASR 1208783) U/S')).toBe('antenna');
		// P3929/26 and P3935/26, whose French halves say GRUE MOBILE.
		expect(classifyObstacle('OBST : MOBILE CRAEN OPR AT CHARTRES DE BRETAGNE')).toBe('crane');
		expect(classifyObstacle("MOBILECRANE OPR NEAR 'LILLE MARCQ EN BAROEUL' AERODROME")).toBe('crane');
		// P4292/26 and P4165/26, the machines of a building site.
		expect(classifyObstacle('WORKING MACHINE OPR AT MERIGNAC')).toBe('crane');
		expect(classifyObstacle('OBST : BUILDING MACHINE RDL138/4.34NM ARP HLP')).toBe('crane');
		expect(classifyObstacle('OBST : ENGIN TRAVAUX PUBLIC RDL138/4.34NM ARP HELISTATION')).toBe('crane');
		// P3528/26, the English of ENGIN BTP.
		expect(classifyObstacle('OBST : CONSTRUCTION EQUIPMENT OPR, LGT DAY NGT')).toBe('crane');
		// P3813/26, the typo WINDTURBIN.
		expect(classifyObstacle('OBSTACLE LIGHTS OF WINDTURBIN 3 U/S')).toBe('turbine');
		// P3827/26 and P4339/26: the plural, and the woods in both languages.
		expect(classifyObstacle('OBSTACLES: MASSIF DE VEGETATIONS (RDL020/0.3NM THR 20)')).toBe('trees');
		expect(classifyObstacle('OBSTACLES INTERFERING PROTECTION AREAS: 1/ WOODED AREAS')).toBe('trees');
		expect(classifyObstacle('OBSTACLES PERCANT LES SERVITUDES: 1/ ZONE BOISEE')).toBe('trees');
		// C0334/26 and LOWW-B0285/26: the masts of a power line.
		expect(classifyObstacle('OBST : 3 HIGH TENSION MASTS ERECTED')).toBe('powerline');
		expect(classifyObstacle("OBSTACLE LIGHTS OF MAST 'M137' OF TRANSMISSION LINE U/S")).toBe('powerline');
		// KHSV-A0239/26: sandhill cranes are birds.
		expect(classifyObstacle('BIRD ACT SAND HILL CRANES')).toBe('bird');
	});

	it('reads the lighting forms in both languages', () => {
		// A6635/26 and C3918/26, whose English halves say LIGHTING.
		expect(classifyObstacle('ECLAIRAGE DU PARKING HORS SERVICE')).toBe('balisage');
		// D6392/26, the plural of "AUTRES BALISAGES".
		expect(classifyObstacle('AUTRES BALISAGES MODIFIES')).toBe('balisage');
		// H0404/26, the typo LIGTHING.
		expect(classifyObstacle('APRON LIGTHING U/S')).toBe('balisage');
		// M1341/26 of the June pair, where the French says BALISAGE.
		expect(classifyObstacle('LINE 2 OF THE CLOSED STOPOVER PARKING (RED AND WHITE BEACONING)')).toBe('balisage');
		// P4197/26: a rock with no lighting draws no lighting pin, in French
		// as in English.
		expect(classifyObstacle("PRESENCE OBSTACLE 'ROCHER DE VITROLLES'\n-BALISAGE NIL")).toBe('');
		expect(classifyObstacle("OBST : 'ROCHER DE VITROLLES'\n-LIGHTING : NIL")).toBe('');
	});

	it('reads the activity forms in both languages', () => {
		// R1313/26, whose English half says GLIDING.
		expect(classifyObstacle('ACTIVITES VELIVOLES')).toBe('glider');
		// R2487/26 and R3504/26, the English of SANS EQUIPAGE and TELEPILOTE.
		expect(classifyObstacle('UNMMANNED AIRCRAFT FLIGHTS')).toBe('drone');
		expect(classifyObstacle('FLIGHTS OF AIRCRAFT WITH A REMOTE PILOT')).toBe('drone');
		// R2989/26: the shooting comes first, as the French TIR does.
		expect(classifyObstacle('SMALL CALIBER SHOOTING EXERCISES. ENTRY PROHIBITED EXC UA')).toBe('firing');
		// W2369/26, the typo MODDEL FLYING, whose French half says AEM.
		expect(classifyObstacle('MODIFICATION MODDEL FLYING ACTIVITY NR 9179')).toBe('aeromodelisme');
		// A3315/26 of the June pair, whose English half says BIRD ACTIVITY.
		expect(classifyObstacle('ACTIVITE AVIAIRE')).toBe('bird');
	});
});
