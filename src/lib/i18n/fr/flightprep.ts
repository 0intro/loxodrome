/* Miroir français de ../en/flightprep.ts. Vocabulaire du classeur du club:
 * Overview = Dossier (le nom de l'onglet du classeur), Fuel plan = Bilan
 * carburant, burn-off = délestage, wind allowance = majoration vent,
 * alternate = dégagement, refuelling = avitaillement, CG envelope =
 * domaine de centrage, POH = manuel de vol. Les libellés des cases à
 * cocher gardent les intitulés français du classeur; ETA / ETD / QNH /
 * TORA / TODA / LDA / PA / ISA et les unités restent invariants. */

import type { DossierCheckId } from '$lib/aircraft/dossier';
import type { NomogramClampToken } from '$lib/aircraft/performanceChart';
import type { Messages } from '../en';
import { plural } from './plural';

export const flightprep = {
	aboardNothing: (aboard: string) => `${aboard} L à bord, rien à ajouter`,
	aboardOnly: (aboard: string) => `${aboard} L à bord`,
	aboardUplift: (p: { aboard: string; uplift: string }) => `${p.aboard} L à bord + ${p.uplift} L avitaillés`,
	aboutLitres: (litres: string) => `≈ ${litres}`,
	accelerateStop: 'Accélération-arrêt',
	accessNoHoursLower: 'sans horaires fixes',
	accessOnRequestLower: 'sur demande',
	accessShortNoHours: 'Sans horaires fixes (AIP)',
	accessShortOnRequest: 'Sur demande (AIP)',
	addAerodrome: 'Ajouter un aérodrome',
	adjustLoading: 'Ajustez le chargement avant le vol.',
	aircraft: 'Immat',
	aircraftChipTip: (name: string) => `${name}. À changer dans l’onglet Aéronefs`,
	airportDeparture: 'Aérodrome Départ',
	airportN: (n: number) => `Aérodrome ${n}`,
	altEtaTip:
		'Heure estimée d’arrivée au dégagement\u202f: ETA destination + temps de dégagement + sa procédure + sa majoration vent',
	altFt: 'Alt (ft)',
	altWindTip:
		'Minutes supplémentaires pour rejoindre le dégagement contre le vent (jamais créditées en gain)',
	alternate: 'Dégagement',
	alternateN: (n: number) => `Dégagement AD ${n}`,
	alternateProcedure: 'Procédure au dégagement',
	alternateTime: 'Temps de dégagement',
	alternateWindAllowance: 'Majoration vent au dégagement',
	alternates: 'Dégagements',
	anchorsInterpTip: 'Interpolé entre les points d’ancrage, borné au-delà du dernier',
	// Un en-tête de ligne ne nomme pas un champ situé dans une cellule : chaque
	// cellule modifiable dit à quelle ligne et à quelle colonne elle appartient.
	ariaFuelCell: (p: { row: string; trip: string }) => `${p.row}, ${p.trip}`,
	ariaPerfCell: (p: { row: string; icao: string }) => `${p.row}, ${p.icao}`,
	armM: 'Bras (m)',
	arrivalProcedure: 'Procédure d’arrivée',
	asdRowTip: 'Distance accélération-arrêt du manuel de vol\u202f: accélérer jusqu’à sa vitesse, puis s’arrêter (vent et surface appliqués, sans majoration de sécurité)',
	burnOff: 'Délestage',
	burnOffTip:
		'Ce que la navigation consomme\u202f: roulage, en route, procédure d’arrivée, majoration vent et réserve de route',
	carriedOver: (litres: string) => `${litres} L reportés`,
	colL: 'L',
	colMin: 'min',
	compareAllPlans: (n: number) => `Comparer les ${n} plans d’avitaillement`,
	contingency: 'Réserve de route',
	contingencyTip:
		'Minutes pour ce que la navigation peut rencontrer en route\u202f: performances, évitements, météo, ATC, attente. Consommées avec la navigation',
	customLitresAria: (at: string) => `Litres au décollage à ${at}`,
	ddFromNotam: (id: string) => `Distance déclarée modifiée par le NOTAM ${id}`,
	ddContestedTip: (id: string) =>
		`Le NOTAM ${id} modifie les distances déclarées de cet aérodrome sous une forme illisible. La valeur affichée est celle de l’AIP et peut être trop longue. Consultez le NOTAM.`,
	ddContestedShort: 'contestée',
	asdaFromToraTip: 'ASDA non publiée\u202f: la TORA est retenue, l’ASDA n’étant jamais plus courte',
	asdaTip: 'Distance utilisable pour l’accélération-arrêt (publiée)',
	assumedDistanceTip:
		'Distance déclarée non publiée\u202f: longueur physique de piste utilisée',
	assumedVerdictTip:
		'Verdict calculé sur une distance déclarée supposée (longueur physique de piste)',
	axisDistanceM: 'distance (m)',
	axisMassKg: 'masse (kg)',
	axisTempC: 'température (°C)',
	axisWindKt: 'vent (kt, arrière < 0 < face)',
	beyondChart: (list: string) => `Hors de l’abaque\u202f: ${list} (tracé borné, valeurs exactes).`,
	burnNote: (p: { litres: string; kg: string }) => `Délestage ${p.litres} L = ${p.kg} kg.`,
	burnOffRow: 'Délestage',
	cgEnvelope: 'Domaine de centrage',
	cgNoFuelDry: (n: number) =>
		`Aucun carburant au décollage\u202f: les réservoirs sont à sec en navigation ${n}.`,
	cgNoFuelUnknown: 'Carburant au décollage inconnu\u202f: aucun chargement à tracer.',
	cgTripHeading: (p: { n: number; route: string }) =>
		`Domaine de centrage, navigation ${p.n}, ${p.route}`,
	checkD15Lda: (p: { d: number; avail: number; pct: number }) =>
		`Distance d’atterrissage +${p.pct} % ${p.d} m, hors de la LDA (${p.avail} m)`,
	checkAsdAsda: (p: { d: number; avail: number; pct: number }) =>
		`Distance accélération-arrêt +${p.pct} % ${p.d} m, hors de l’ASDA (${p.avail} m)`,
	checkD15Asda: (p: { d: number; avail: number; pct: number }) =>
		`Passage des 15 m +${p.pct} % ${p.d} m, hors de l’ASDA (${p.avail} m)`,
	checkD15Toda: (p: { d: number; avail: number; pct: number }) =>
		`Passage des 15 m +${p.pct} % ${p.d} m, hors de la TODA (${p.avail} m)`,
	checkD15Tora: (p: { d: number; avail: number }) =>
		`Passage des 15 m (manuel de vol) ${p.d} m, hors de la TORA (${p.avail} m)`,
	checkRollTora: (p: { d: number; avail: number; pct: number }) =>
		`Roulement +${p.pct} % ${p.d} m, hors de la TORA (${p.avail} m)`,
	chartAria: 'Abaque',
	chartCredit: 'Source Météo-France, via SOFIA-Briefing (DGAC)',
	chartOnly: 'Abaque seul\u202f: aucun aérodrome ni masse résolus pour l’instant, donc pas de tracé de lecture.',
	chartValid: (when: string) => `Valable ${when}`,
	chartDownloadFailed: (p: { chart: string; valid: string }) =>
		`${p.chart} valable ${p.valid}\u202f: carte non récupérée.`,
	chartExtrapolated: (p: { next: string; at: string }) =>
		`Dernière carte publiée\u202f: extrapolez le déplacement des fronts et des centres d’action à l’heure du vol. La carte de ${p.next} est publiée vers ${p.at}.`,
	chartsCatalogFailed: (p: { chart: string; cause: string }) =>
		`${p.chart}\u202f: catalogue indisponible. ${p.cause}`,
	chartsChecking: 'Vérification des cartes TEMSI et WINTEM…',
	chartsLater: (p: { chart: string; valid: string; at: string | null }) =>
		`${p.chart} valable ${p.valid}, pour la fin du vol\u202f: ${p.at ? `publication prévue vers ${p.at}` : 'publication à venir'}.`,
	chartsMissing: (p: { chart: string; valid: string; at: string | null }) =>
		`${p.chart} valable ${p.valid}\u202f: ${p.at ? `publication prévue vers ${p.at}, pas encore au catalogue` : 'pas au catalogue'}.`,
	chartsNone: (chart: string) => `${chart}\u202f: SOFIA ne liste aucune carte.`,
	chartsNotYetPublished: (p: { chart: string; valid: string | null; at: string | null }) =>
		`${p.chart}${p.valid ? ` valable ${p.valid}` : ''}\u202f: ${p.at ? `publication prévue vers ${p.at}` : 'publication à venir'}.`,
	chartsPrintedNow: (list: string) => `Cartes imprimées maintenant\u202f: ${list}.`,
	chartsUndated: (chart: string) => `${chart}\u202f: dates de carte illisibles, aucune sélection.`,
	checks: {
		charts_complement: 'Complément aux cartes aéronautiques',
		charts_current: 'Cartes\u202f: Vérifier la mise à jour',
		charts_regional: 'Cartes régionales (Région parisienne, Lyon ...)',
		charts_vac: 'Cartes VAC',
		doc_airworthiness: 'CDN/CEN',
		doc_flight_manual: 'Manuel de vol',
		doc_insurance: 'Assurance',
		doc_journey_log: 'Carnet de route',
		doc_mass_balance: 'Masse et centrage',
		doc_noise: 'Certificat acoustique',
		doc_radio: 'LSA',
		doc_registration: 'CDI',
		pax_recency: 'Emport de PAX\u202f: 3 déc et att < 90 jours (FCL.060)',
		r_feasible: 'Réalisable',
		r_legal: 'Règlementaire',
		r_reasonable: 'Raisonnable',
		type_recency: 'Club\u202f: Dernier vol sur type < 3 mois',
		wx_fronts: 'Carte des fronts',
		wx_metar_taf_sigmet: 'METAR / TAF / SIGMET',
		wx_temsi: 'TEMSI',
		wx_winterm: 'WINTEM',
	} satisfies Record<DossierCheckId, string>,
	clampTokens: {
		mass: 'masse',
		'pressure altitude': 'altitude-pression',
		temperature: 'température',
		wind: 'vent',
	} satisfies Record<NomogramClampToken, string>,
	day: 'jour',
	discretionaryMargin: 'Marge CDB',
	declaredSufficient: 'Distances déclarées suffisantes\u202f?',
	declaredSufficientFlaps: (flaps: number) => `Distances déclarées suffisantes, volets ${flaps}°\u202f?`,
	declaredSufficientLandingTip: (pct: number) =>
		`Oui si la distance d’atterrissage depuis 15 m +${pct} % tient dans la LDA. L’égalité ne suffit pas.`,
	declaredSufficientTakeoffTip: (pct: number) =>
		`Oui si le passage des 15 m du manuel de vol tient dans la TORA, ce passage +${pct} % dans la TODA et dans l’ASDA, et le roulement +${pct} % dans la TORA. L’égalité ne suffit pas.`,
	discretionaryTip: 'Carburant discrétionnaire à l’appréciation du pilote',
	durationHm: (p: { h: number; m: number }) =>
		p.h === 0 ? `${p.m} min` : p.m === 0 ? `${p.h} h` : `${p.h} h ${p.m} min`,
	distAway: (dist: string) => `, à ${dist}`,
	dryPavedNote:
		'Valeur piste revêtue sèche. Les facteurs de surface et la majoration de +30 % sont des lignes de la table.',
	elevationFt: 'Altitude (ft)',
	enRoute: 'En route',
	enRouteTip: 'Temps sans vent du décollage à l’atterrissage à la vitesse de croisière',
	enduranceLimit: 'Limite d’autonomie (UTC)',
	enduranceLimitTip:
		'Heure d’atterrissage la plus tardive préservant la réserve finale (l’autonomie du plan de vol OACI, moins la réserve finale)',
	etaHeader: 'Heure ARRIVÉE (UTC)',
	etaTip: 'Heure estimée d’arrivée\u202f: le départ plus les minutes de délestage de la navigation (roulage, en route, procédure, vent et réserve de route)',
	etdHeader: 'Heure DÉPART (UTC)',
	etdTip: 'Heure estimée de départ',
	expiresBeforeTip: 'Expire avant la date du vol',
	extrapolatedTip: (list: string) => `Extrapolé\u202f: ${list}. À traiter avec une marge accrue.`,
	finalReserve: 'Réserve finale',
	finalReserveTip:
		'30 min en VFR de jour, 45 min en VFR de nuit et en IFR (AMC1 NCO.OP.125(b)). Vide = valeur jour/nuit dérivée',
	fittedRateLandingTip:
		'D’après le taux par nœud ajusté de la valeur de référence à l’atterrissage (passage des 15 m), appliqué en continu. Le roulement a son propre taux.',
	fittedRateTakeoffTip:
		'D’après le taux par nœud ajusté de la valeur du décollage normal (passage des 15 m), appliqué en continu. Le roulement a son propre taux.',
	fixNone: 'Aucun changement seul n’y suffit\u202f: réduisez le chargement ou ajoutez une escale.',
	fixOr: ', ou ',
	fixRaise: (p: { at: string; litres: number }) => `décollez de ${p.at} avec au moins ${p.litres} L`,
	fixRaiseThen: (p: { at: string; litres: number }) =>
		`décollez de ${p.at} avec au moins ${p.litres} L, puis avitaillez plus loin`,
	fixRefuelAt: (at: string) => `avitaillez à ${at}`,
	fixRefuelAtMax: (at: string) => `avitaillez à ${at} au maximum dans les limites`,
	fixRefuelAtMinimum: (at: string) => `avitaillez à ${at} au minimum`,
	fixThenFurther: ', puis avitaillez plus loin',
	flagAltitude: 'sous la première altitude du manuel',
	flagMass: 'masse hors des colonnes du manuel',
	flagTemp: 'température au-delà d’ISA +/- 20',
	flaplessCorrection: (pct: number) => `Atterrissage sans volets\u202f: ajouter ${pct} %.`,
	flaplessFeasible: 'Sans volets réalisable\u202f?',
	flaplessFeasibleTip: (factor: number) =>
		`Distance x ${factor} (valeur du manuel de vol, sans majoration de sécurité) encore dans la LDA`,
	flightDate: 'Date du vol (UTC)',
	flightDatePastTip: 'Cette date est déjà passée\u202f: les vents prévus, le soleil et les cartes seraient lus pour un vol déjà effectué. Effacée, elle vaut aujourd’hui.',
	flightDateTip:
		'Détermine les heures de coucher du soleil, les contrôles de validité, les vents prévus et la période Vol de la barre d’outils. Effacée, elle vaut aujourd’hui.',
	flightPast: (when: string) =>
		`Le vol prévu (${when}) est passé\u202f: vérifiez la date du vol et l’heure de départ.`,
	foldStated: 'Contient des minutes saisies',
	fromMetar: (p: { id: string; dist: string; age: string }) =>
		`d’après le METAR ${p.id}${p.dist}, ${p.age}`,
	fromForecast: (p: { valid: string; source: string }) => `d’après la prévision pour ${p.valid} (${p.source})`,
	fuelAtTakeoff: 'Carburant au décollage',
	fuelAtTakeoffFrom: (at: string) => `Carburant au décollage à ${at}`,
	fuelBasisCruiseDefault: (kt: number) => `Croisière ${kt} kt par défaut, aucun aéronef choisi.`,
	fuelBasisCruiseOwn: (p: { kt: number; lph: string | null }) =>
		`Croisière ${p.kt} kt${p.lph !== null ? `, ${p.lph} L/h` : ''}\u202f: les valeurs propres au plan.`,
	fuelBasisCruiseSheet: (p: { name: string | null; kt: number; lph: string | null; plane: string }) =>
		`Croisière ${p.name !== null ? `${p.name}, ` : ''}${p.kt} kt${p.lph !== null ? `, ${p.lph} L/h` : ''}, selon la fiche ${p.plane}.`,
	fuelBasisForecast: (source: string | null) =>
		`Majoration vent d’après les vents prévus${source !== null ? ` (${source})` : ''}.`,
	fuelBasisForecastLess: (min: number) => `Avec la prévision, ${min} min de moins.`,
	fuelBasisForecastMore: (min: number) => `Avec la prévision, ${min} min de plus.`,
	fuelBasisForecastSame: 'Avec la prévision, à peu près la même durée.',
	fuelBasisManual: (wv: string) => `Majoration vent d’après un vent manuel ${wv}, non la prévision.`,
	fuelBasisMissedManual: (p: { legs: number; wind: string }) =>
		`Pas de prévision pour ${p.legs} ${plural(p.legs, 'segment', 'segments')}\u202f: vent manuel ${p.wind}.`,
	fuelBasisMissedStill: (legs: number) =>
		`Pas de prévision pour ${legs} ${plural(legs, 'segment', 'segments')}\u202f: calcul sans vent.`,
	fuelBasisNoWind: 'Aucun vent connu\u202f: les navigations sont calculées sans vent.',
	fuelBasisOwnLegs: (n: number) => `${n} ${plural(n, 'segment a son propre vent', 'segments ont leur propre vent')}.`,
	fuelDry: (n: number) => `NON, à sec en navigation ${n}`,
	fuelNoMargin: (litres: string) => `NON (${litres} L)`,
	fuelNote: (p: { litres: string; grade: string; density: number; kg: string }) =>
		`Carburant ${p.litres} L de ${p.grade} x ${p.density} kg/L = ${p.kg} kg.`,
	fuelRefusedTip: 'Carburant pris là où l’AIP ou un NOTAM dit qu’il n’est pas disponible pour cet avion',
	fuelShortOne: (p: { start: string; need: string }) =>
		`Carburant INSUFFISANT\u202f: ${p.start} L au décollage pour ${p.need} L requis.`,
	fuelSufficientOne: (p: { start: string; need: string }) =>
		`Carburant suffisant\u202f: ${p.start} L au décollage pour ${p.need} L requis.`,
	fuelTableCaption:
		'Carburant de chaque navigation\u202f: délestage, réserve requise à l’atterrissage, carburant au décollage et ce qui reste',
	fuelYesMargin: (litres: string) => `Oui (${litres} L)`,
	genericAircraft: 'Type générique',
	genericMbNote: 'Fiche générique. La masse à vide et le bras de levier sont l’exemple du manuel de vol, pas la pesée d’un aéronef.',
	grass: 'Herbe',
	grassAssumed: 'oui (supposé)',
	grassCorrection: (pct: number) => `Piste sèche en herbe = +${pct} %.`,
	grassMixed: 'oui (mixte)',
	grassMixedTip: 'Revêtement mixte, en partie revêtu et en partie non revêtu\u202f: la majoration herbe est appliquée',
	grassUnknownTip:
		'Revêtement non publié ou illisible\u202f: la piste est supposée non revêtue et la majoration herbe est appliquée',
	groundRoll: 'Roulement',
	groundTime: 'Temps au sol',
	groundTimeTip:
		'Moteur arrêté, décale les ETD suivants et la limite d’autonomie. Saisir h:mm, ou des minutes.',
	headwindCalmTip: 'Vent de face 0 kt, calme supposé (pas de METAR en direct).',
	headwindInfluenceAsd: 'Influence du vent de face, accélération-arrêt',
	headwindInfluenceLanding: 'Influence du vent de face (atterrissage)',
	headwindInfluenceTakeoff: 'Influence du vent de face (décollage)',
	headwindKt: 'Vent de face (kt)',
	headwindMetarTip: (p: { kt: number; prov: string }) => `Vent de face ${p.kt} kt ${p.prov}.`,
	headwindRowTip: 'Composante de face le long de la piste',
	headwindZeroTip: 'Vent de face 0 kt, puisqu’un vent arrière est saisi pour cette piste.',
	hhmmPlaceholder: 'hh:mm',
	landing: 'Atterrissage',
	landingPerfHeading: 'Performances à l’atterrissage',
	ldaTip: 'Distance utilisable à l’atterrissage (publiée)',
	lineAboardAboveMax: (p: { at: string; aboard: string; max: string }) =>
		`${p.at}\u202f: environ ${p.aboard} L déjà à bord, au-delà des ${p.max} L que les limites permettent là\u202f: retirez du carburant ou allégez le chargement.`,
	lineAboardUnknown: (at: string) =>
		`${at}\u202f: pas d’avitaillement, et le carburant à bord n’est pas connu\u202f: le carburant au décollage est inconnu.`,
	lineAboveMax: (p: { who: string; kg: string; max: number }) =>
		`${p.who}\u202f: ${p.kg} kg, au-delà du maximum de ${p.max} kg.`,
	lineAboveUsable: (p: { at: string; asked: string; usable: number }) =>
		`${p.at}\u202f: ${p.asked} L demandés, les ${p.usable} L utilisables chargés.`,
	lineAvgasPassengers: 'Pas d’avitaillement en AVGAS pendant que des passagers embarquent, sont à bord ou débarquent (NCO.OP.145).',
	lineCgOut: (p: { who: string; arm: string }) => `${p.who}\u202f: centrage ${p.arm} m, hors de l’enveloppe.`,
	lineDry: (who: string) =>
		`${who}\u202f: carburant INSUFFISANT, les réservoirs sont à sec avant l’atterrissage.`,
	lineMaxWithin: (p: { at: string; litres: number }) => `Maximum dans les limites à ${p.at}\u202f: ${p.litres} L.`,
	lineNoConsumption: 'Cet avion ne déclare pas de consommation\u202f: le carburant ne peut pas être évalué.',
	lineNoDefuel: (p: { at: string; onBoard: string; asked: string }) =>
		`${p.at}\u202f: ${p.onBoard} L déjà à bord, plus que les ${p.asked} L demandés\u202f: rien n’est vidangé.`,
	lineOnBoardImpossible: (at: string) =>
		`${at}\u202f: le carnet de route consomme plus de carburant qu’il n’en met dans les réservoirs, un avitaillement y manque\u202f: le carburant à bord est inconnu.`,
	lineOnBoardIncomplete: (at: string) =>
		`${at}\u202f: le relevé du carnet de route est incomplet, le carburant à bord est inconnu.`,
	lineOnBoardLog: (p: { at: string; litres: string; day: string }) =>
		`${p.at}\u202f: environ ${p.litres} L à bord (carnet de route relevé le ${p.day}).`,
	lineOnBoardMeasured: (p: { at: string; litres: string; day: string }) =>
		`${p.at}\u202f: ${p.litres} L à bord (mesurés le ${p.day}).`,
	lineOnBoardOther: (p: { at: string; reg: string }) =>
		`${p.at}\u202f: le carburant à bord a été relevé pour ${p.reg}, pas pour cet avion, il est donc inconnu.`,
	lineOnBoardOverflow: (litres: string) =>
		`Le carnet de route ajoute ${litres} L de plus que les réservoirs n’en contiennent.`,
	lineOnBoardStale: (flight: string) =>
		`Pas relevé le jour du vol (${flight})\u202f: l’avion a pu voler ou être avitaillé depuis.`,
	lineRefusedTick: (p: { at: string; reason: string }) =>
		`${p.at}\u202f: avitaillement prévu, mais ${p.reason}. Organisez-le avant de compter dessus.`,
	lineShort: (p: { who: string; landing: string; reserve: string }) =>
		`${p.who}\u202f: carburant INSUFFISANT, ${p.landing} L à l’atterrissage pour une réserve de ${p.reserve} L.`,
	lineStationOver: (p: { station: string; kg: string; max: number }) =>
		`${p.station}\u202f: ${p.kg} kg, au-delà de son maximum de ${p.max} kg.`,
	lineTouchdownOver: (p: { who: string; kg: string; max: number }) =>
		`${p.who}\u202f: ${p.kg} kg au toucher des roues, au-delà de la masse maximale à l’atterrissage de ${p.max} kg.`,
	lineUnavailableMax: (at: string) =>
		`${at}\u202f: carburant au décollage inconnu, aucune quantité ne respecte les limites.`,
	lineUnavailableMinimum: (at: string) => `${at}\u202f: carburant au décollage inconnu, la consommation est inconnue.`,
	lineUnavailableTabs: (at: string) =>
		`${at}\u202f: carburant au décollage inconnu, la fiche ne donne pas de quantité aux indicateurs.`,
	lineZeroFuelOut: (p: { who: string; arm: string }) =>
		`${p.who}\u202f: centrage ${p.arm} m, hors de l’enveloppe quel que soit le carburant.`,
	lineZeroFuelOver: (p: { who: string; kg: string; max: number }) =>
		`${p.who}\u202f: ${p.kg} kg, au-delà de la masse maximale sans carburant de ${p.max} kg.`,
	manualRowTip:
		'Valeur du manuel de vol\u202f: vent et surface appliqués, sans majoration de sécurité (la distance sans facteurs du règlement)',
	marginRowTip: (factor: number) =>
		`Distance requise\u202f: valeur du manuel de vol x${factor} (majoration de sécurité), celle que lit le verdict`,
	massKg: 'Masse (kg)',
	massRowTipMax: 'Maximum du manuel de vol, pas encore de chargement',
	massTipAlternate: ', dont c’est le dégagement',
	massTipHeaviestFrom: (at: string) => `, la plus lourde au départ de ${at}`,
	massTipHeaviestLanding: (n: number) =>
		`Masse au décollage la plus lourde du plan (navigation ${n})\u202f: aucune navigation n’atterrit ici`,
	massTipHeaviestTakeoff: (n: number) =>
		`Masse au décollage la plus lourde du plan (navigation ${n})\u202f: aucune navigation ne décolle d’ici`,
	massTipLanding: ', à laquelle son atterrissage est évalué, par prudence',
	massTipTrip: (p: { n: number; route: string }) => `Masse au décollage de la navigation ${p.n} (${p.route})`,
	maxLandingLine: 'Atterrissage maxi',
	maxLoad: 'Emport maximal',
	maxLoadOf: (p: { load: string; usable: number }) =>
		`(emport maximal ${p.load} L sur ${p.usable} L utilisables).`,
	maxNoneCell: 'aucun',
	maxZeroFuelLine: 'Sans carburant maxi',
	medicalValidity: 'Médical validité',
	mepValidity: 'MEP validité',
	metarTaf: 'METAR et TAF',
	metarUnavailable: 'METAR indisponible',
	metricAria: 'Grandeur',
	minEndurance: (min: number) => `${min} min d’autonomie`,
	minimumAtTakeoff: 'Minimum au décollage',
	minimumAtTakeoffTip:
		'Le délestage plus la réserve requise\u202f: le carburant minimum au décollage pour cette seule navigation',
	modeCustom: 'Personnalisé',
	modeFull: (litres: number | string) => `Pleins complets (${litres} L)`,
	modeMax: 'Maximum dans les limites',
	modeMaxL: (litres: number) => `Maximum dans les limites (${litres} L)`,
	modeMaxNone: 'Maximum dans les limites (aucun)',
	modeMinimumL: (litres: number) => `Minimum (${litres} L)`,
	modeNone: 'Pas d’avitaillement',
	modeTabs: (litres: number | string) => `Aux indicateurs de remplissage (${litres} L)`,
	modeTabsTip: 'Chaque réservoir rempli jusqu’au bas de l’indicateur du col de remplissage',
	momentKgM: 'Moment (kg.m)',
	night: 'nuit',
	no: 'Non',
	noAircraft: 'Aucun aéronef',
	noCaps: 'NON',
	noConsumption: (reg: string) =>
		`${reg} n’a pas de consommation renseignée, les litres sont masqués.`,
	noFeasible: (litres: number) =>
		`Aucune stratégie réalisable avec ce réservoir (${litres} L utilisables).`,
	noLower: 'non',
	noMbSheet: (reg: string) =>
		`${reg} n’a pas de fiche de masse et centrage, importez un YAML d’aéronef complet pour utiliser cette page.`,
	noPerfSheet: (reg: string) =>
		`${reg} n’a pas de fiche de performances, importez un YAML d’aéronef complet pour utiliser cette page.`,
	noRefuelling: 'Sans avitaillement',
	noRoutePlanned: 'Aucune route planifiée',
	noTripBurnTip:
		'Pas encore de temps de navigation (planifiez une route), tout le carburant supposé consommé',
	nomogramAria: 'Abaque de performances avec le tracé de lecture actuel',
	none: 'aucun',
	notamNote1: 'Les NOTAM et les SUP AIP sont consultables la veille pour le lendemain.',
	notamNote2:
		'Ils sont consultables au travers de SOFIA-Briefing, ou en récupérant les NOTAM du couloir de la route (onglet Route).',
	notamNote3: 'Rajouter les SUP AIP et les zones AZBA sur le profil vertical.',
	oeiCheck1500: (pct: string) => `À 1500 ft\u202f: ${pct} %, sous 0.75 %`,
	oeiCheck400: (rate: number) => `À 400 ft\u202f: ${rate} ft/min, pas au-dessus de 0`,
	oeiClimbCellTip: (p: { rate: number; tas: number; pct: string }) =>
		`${p.rate} ft/min à ${p.tas} kt de vitesse propre, une pente de ${p.pct} %`,
	oeiClimbRow: 'Un moteur en panne, 1500 ft (%)',
	oeiClimbRowTip: 'Pente de montée brute un moteur en panne à 1500 ft au-dessus de l’aérodrome, à la vitesse du trait bleu (Vyse), d’après la montée un moteur en panne du manuel de vol',
	oeiSufficient: 'Montée un moteur en panne suffisante\u202f?',
	oeiSufficientLandingTip: 'CAT.POL.A.340\u202f: un moteur en panne, une pente de montée d’au moins 0.75 % à 1500 ft au-dessus de l’aire d’atterrissage. En deçà, une panne moteur se prépare comme sur un monomoteur (CAT.POL.A.300(b)).',
	oeiSufficientTakeoffTip: 'CAT.POL.A.340\u202f: un moteur en panne, une pente de montée positive à 400 ft au-dessus de l’aire de décollage et d’au moins 0.75 % à 1500 ft. En deçà, une panne moteur se prépare comme sur un monomoteur (CAT.POL.A.300(b)).',
	openMbSheet: (p: { n: number; route: string }) => `Navigation ${p.n}, ${p.route}, sur la page Masse et centrage`,
	onBoardAboveTank: (usable: number) =>
		`Une valeur dépasse les ${usable} L que contiennent les réservoirs\u202f: vérifiez-la.`,
	onBoardAddFlight: 'Ajouter un vol',
	onBoardAddedAria: (n: number) => `Vol ${n}, litres ajoutés avant lui`,
	onBoardAddedBefore: 'Ajouté avant',
	onBoardButton: 'Carburant à bord…',
	onBoardCheck: 'Vérifiez le carburant dans les réservoirs avant le vol.',
	onBoardClear: 'Effacer',
	onBoardConsumption: 'Consommation',
	onBoardConsumptionTip:
		'Le temps de vol est décompté à cette consommation. Vide, celle de la fiche de l’avion, avec laquelle le bilan carburant est calculé',
	onBoardDone: 'Terminé',
	onBoardFlightTime: 'Temps de vol (bloc)',
	onBoardFlightTimeTip:
		'Le temps de vol porté au carnet de route, du premier mouvement en vue du décollage à l’arrêt final (FCL.010), roulage compris',
	onBoardFlights: 'Vols depuis',
	onBoardHoursAria: (n: number) => `Vol ${n}, heures`,
	onBoardLastFull: (litres: number) => `Pleins complets (${litres} L)`,
	onBoardLastLitres: 'Quantité',
	onBoardLastLitresAria: 'Litres laissés par le dernier avitaillement',
	onBoardLastRefuel: 'Dernier avitaillement',
	onBoardLastTabs: (litres: number | string) => `Aux indicateurs de remplissage (${litres} L)`,
	onBoardLead: 'D’après le carnet de route de l’avion depuis son dernier avitaillement, ou mesuré à l’avion.',
	onBoardMeasured: 'Mesuré à l’avion (réglette ou jauges)',
	onBoardMeasuredAria: 'Litres mesurés à bord',
	onBoardMeasuredNote: 'Remplace l’estimation du carnet de route.',
	onBoardMinutesAria: (n: number) => `Vol ${n}, minutes`,
	onBoardNoAnchor: 'Indiquez le dernier avitaillement porté au carnet de route.',
	onBoardNoConsumption:
		'Cet avion n’indique pas de consommation\u202f: saisissez-en une pour décompter le temps de vol.',
	onBoardNoLitres: 'Indiquez les litres laissés par le dernier avitaillement.',
	onBoardNoTabs:
		'La fiche de cet avion n’indique pas de quantité aux indicateurs de remplissage\u202f: indiquez les litres.',
	onBoardOther: (p: { reg: string; current: string }) =>
		`Ce relevé concerne ${p.reg}, pas ${p.current}\u202f: effacez-le pour relever le carnet de route de cet avion.`,
	onBoardOverflow: (litres: string) =>
		`Le carnet de route ajoute ${litres} L de plus que les réservoirs n’en contiennent\u202f: comptés pleins à ce moment.`,
	onBoardReadOn: (day: string) => `Relevé le ${day}`,
	onBoardRemoveFlight: (n: number) => `Retirer le vol ${n}`,
	onBoardResultEstimate: (p: { flown: string; n: number; burnt: string; lph: string; added: string | null; litres: string }) =>
		`${p.flown} en ${p.n} ${plural(p.n, 'vol', 'vols')}, environ ${p.burnt} L à ${p.lph} L/h${p.added ? `, ${p.added} L ajoutés` : ''}\u202f: environ ${p.litres} L à bord.`,
	onBoardResultImpossible: (p: { flown: string; burnt: string; available: string }) =>
		`Le carnet de route consomme ${p.burnt} L en ${p.flown}, plus que les ${p.available} L qu’il met dans les réservoirs\u202f: un avitaillement y manque.`,
	onBoardResultMeasured: (litres: string) => `${litres} L mesurés à bord.`,
	onBoardResultNoFlight: (p: { added: string | null; litres: string }) =>
		`Aucun vol depuis${p.added ? `, ${p.added} L ajoutés` : ''}\u202f: ${p.litres} L à bord.`,
	onBoardResultUnknown:
		'Indiquez le dernier avitaillement et les vols depuis, ou une quantité mesurée à l’avion.',
	onBoardSourceImpossible: 'Carnet de route\u202f: avitaillement manquant',
	onBoardSourceIncomplete: 'Carnet de route incomplet',
	onBoardSourceLog: (day: string) => `Carnet de route, ${day}`,
	onBoardSourceMeasured: (day: string) => `Mesuré, ${day}`,
	onBoardSourceOther: (reg: string) => `Relevé pour ${reg}`,
	onBoardStale: (p: { read: string; flight: string }) =>
		`Relevé le ${p.read}, pas le jour du vol (${p.flight})\u202f: l’avion a pu voler ou être avitaillé depuis.`,
	onBoardTitle: 'Carburant à bord avant avitaillement',
	onBoardTotal: (p: { flown: string; n: number }) => `Total ${p.flown}, ${p.n} ${plural(p.n, 'vol', 'vols')}`,
	orphansIgnored: (n: number) =>
		`${n} ${plural(n, 'route de dégagement sans navigation précédente est ignorée', 'routes de dégagement sans navigation précédente sont ignorées')}. Ordonnez les routes en navigation, dégagement, navigation, ...`,
	over15m: 'Passage des 15 m (50 ft)',
	overReserve: 'Au-delà de la réserve',
	overReserveTip:
		'Le carburant à l’atterrissage au-delà de la réserve requise, en litres et en temps à la consommation de croisière',
	overviewShortTrip: (who: string) => `${who}\u202f: carburant INSUFFISANT. Voir la page Bilan carburant.`,
	paAboveTip: 'Altitude-pression au-dessus de la table du manuel de vol',
	pageFuel: 'Bilan carburant',
	pageMb: 'Masse et centrage',
	pageOverview: 'Dossier',
	pagePerf: 'Performances',
	pagesAria: 'Pages',
	pathAerodromeAria: 'Aérodrome du tracé de lecture',
	pilot: 'Pilote',
	planNothingAdded: 'pas d’avitaillement',
	planRouteFuel:
		'Planifiez une route d’au moins deux points et définissez une vitesse de croisière (onglet Route) pour construire le bilan carburant. Marquez les routes de déroutement comme dégagements pour les inclure dans les réserves.',
	planRouteTimeline:
		'Planifiez une route d’au moins deux points et définissez une vitesse de croisière (onglet Route) pour construire la chronologie.',
	planRoutesGrid:
		'Planifiez des routes avec des aérodromes en points tournants (ou ajoutez un aérodrome ci-dessous) pour remplir la grille.',
	pohAccelerateStop: 'Accélération-arrêt (m)',
	pohCharts: (p: { type: string; lb: number }) =>
		`Abaques du manuel de vol (${p.type}, référence ${p.lb} lb)`,
	pohDistances: (p: { type: string; max: number; min: number }) =>
		`Distances du manuel de vol (${p.type}, ${p.max} / ${p.min} kg)`,
	pohOeiClimb: 'Montée un moteur en panne (ft/min)',
	pointLanding: (kg: number) => `Atterrissage ${kg} kg`,
	pointTakeoff: (kg: number) => `Décollage ${kg} kg`,
	polarDay: 'jour polaire',
	polarNight: 'nuit polaire',
	potentialTip:
		'Temps de vol restant avant la prochaine visite d’entretien (le Potentiel du classeur). Saisir h:mm, ou des minutes.',
	precipReported: 'précipitations signalées',
	pressureAltFt: 'Altitude-pression (ft)',
	printDossier: 'Imprimer le dossier de vol',
	printDossierTip:
		'Imprimer le dossier de vol (les quatre pages plus le log de nav, les fréquences et le profil vertical de chaque route)',
	printPage: 'Imprimer cette page',
	printPrep: 'Imprimer la préparation du vol',
	printPrepTip: 'Imprimer la préparation du vol (les quatre pages, A4 paysage)',
	progressAria: 'Avancement de la préparation de l’impression',
	progressCharts: 'Téléchargement des cartes TEMSI / WINTEM',
	progressDatasets: 'Chargement des données de référence',
	progressIssueDatasets: 'Certaines données de référence n’ont pas pu être chargées.',
	progressIssueMsa:
		'Altitudes minimales de sécurité indisponibles pour au moins une route (cases MSA vides).',
	progressIssueTerrain: 'Profil du terrain indisponible pour au moins un trajet.',
	progressIssueWind: 'Vents prévus indisponibles, le vent manuel s’applique.',
	progressIssueWindBlank: 'Vents prévus indisponibles et aucun vent manuel (cases MH et ETE/W vides).',
	progressIssuePerfForecast: (icao: string) =>
		`${icao}, pas de prévision à l’heure prévue du décollage ou de l’atterrissage, la page Performances utilise un METAR plus ancien ou des estimations`,
	progressMsa: 'Calcul des altitudes minimales de sécurité',
	progressPages: 'Mise en page des feuilles',
	progressPrintAnyway: 'Imprimer quand même',
	progressRetry: 'Réessayer',
	progressReviewNote: 'Imprimez quand même, ou réessayez quand les données seront disponibles.',
	progressReviewTitle: 'Des données manquent',
	progressTerrain: 'Chargement du profil du terrain',
	procCellTitle: (p: { icao: string; proc: string }) => `${p.icao}\u202f: ${p.proc}`,
	procFlapsOnly: (flaps: number) => `Volets ${flaps}°`,
	procNone: 'Aucune ne convient',
	procNoneShort: 'Aucune',
	procNormal: (flaps: number | null) => (flaps == null ? 'Normale' : `Normale (volets ${flaps}°)`),
	procShortField: (flaps: number | null) => (flaps == null ? 'Terrain court' : `Terrain court (volets ${flaps}°)`),
	procShortFieldOnlyTip: (flaps: number | null) =>
		`Le manuel de vol ne donne que le décollage court. L’appliquer${flaps == null ? '' : `, volets ${flaps}°`}, avec ses propres vitesses d’envol et de passage des 15 m et la liste de vérification correspondante.`,
	procShortFieldTip: (flaps: number | null) =>
		`Le décollage normal ne tient pas dans les distances déclarées. Appliquer le décollage court du manuel de vol${flaps == null ? '' : `, volets ${flaps}°`}, avec ses propres vitesses d’envol et de passage des 15 m et la liste de vérification correspondante.`,
	progressTitleDossier: 'Préparation du dossier de vol',
	progressTitlePrep: 'Préparation de l’impression',
	progressTitleWx: 'Préparation du briefing météo',
	progressWind: 'Récupération des vents prévus',
	progressWx: 'Téléchargement des METAR et TAF',
	qnhDefaultTip: 'Le QNH d’une colonne là où ni un METAR ni une prévision n’en donne, aussi celui du niveau de transition. Une valeur saisie dans une colonne le remplace.',
	qnhDefaultLabel: 'QNH sans observation',
	qnhDossierTip: (qnh: number) => `QNH ${qnh} hPa, valeur par défaut faute d’observation (ni METAR ni prévision en direct).`,
	qnhMetarTip: (p: { qnh: number; prov: string }) => `QNH ${p.qnh} hPa ${p.prov}.`,
	qnhStandardTip: (qnh: number) => `QNH ${qnh} hPa, standard (ni METAR ni prévision en direct).`,
	recommendationLead: 'Recommandation\u202f:',
	refreshAllTip: 'Actualiser tous les METAR maintenant',
	fuelNotServed: (p: { icao: string; grades: string }) =>
		`${p.icao} ne publie pas ${p.grades}`,
	fuelNotamNoneAt: (p: { icao: string; notam: string }) =>
		`NOTAM ${p.notam} retire tout le carburant à ${p.icao}`,
	fuelNotamGradeAt: (p: { icao: string; notam: string; grades: string }) =>
		`NOTAM ${p.notam} retire ${p.grades} à ${p.icao}`,
	alternateFuelNote:
		'Le déroutement est effectué avec le carburant emporté à la dernière escale, le plan reste donc valable. Un aéronef qui se déroute se pose avec sa réserve finale, et ces terrains de dégagement ne pourraient pas le réavitailler à une arrivée imprévue.',
	fuelNoneAt: (icao: string) => `${icao} ne publie aucun carburant`,
	refuelDemotedAboard: (p: { at: string; aboard: string; max: number }) =>
		`environ ${p.aboard} L sont déjà à bord à ${p.at}, au-delà des ${p.max} L que les limites permettent\u202f: retirez du carburant ou allégez le chargement.`,
	refuelDemotedLimits: (p: { from: string; maxL: number }) =>
		`avec ses quantités une navigation sort des limites de masse et de centrage (au plus ${p.maxL} L au départ de ${p.from}).`,
	refuelDemotedMassMax: (p: { at: string; kg: string; max: number; from: string; maxL: number }) =>
		`son décollage de ${p.at} pèse ${p.kg} kg, au-delà du maximum de ${p.max} kg (au plus ${p.maxL} L au départ de ${p.from}).`,
	refuelGradeLead: 'Vérifier l’avitaillement\u202f:',
	fuelBasedAt: (icao: string) => `${icao} réserve son carburant aux aéronefs basés`,
	fuelOnRequestAt: (icao: string) => `${icao} délivre le carburant sur demande`,
	fuelNoHoursAt: (icao: string) => `${icao} ne publie pas d’horaire pour son carburant`,
	refuelCautionLead: 'À organiser à l’avance\u202f:',
	refuelDemotedLead: 'Le minimum d’avitaillements\u202f:',
	refuelDemotedJoin: ', mais',
	refuelListLead: 'Avitaillements\u202f:',
	refuelNoneServed:
		'Aucune stratégie ne se ravitaille uniquement là où il y a du carburant. Ce vol est effectué avec le carburant emporté, ou l’escale est organisée à l’avance.',
	refuelNoneWithinLimits:
		'Aucune stratégie ne respecte les limites de masse et de centrage avec ses quantités et ce chargement\u202f: réduisez le chargement.',
	refuelNoneWithinLimitsAboard: (p: { at: string; aboard: string; max: number }) =>
		`Aucune stratégie ne respecte les limites de masse et de centrage\u202f: environ ${p.aboard} L sont déjà à bord à ${p.at}, au-delà des ${p.max} L que les limites permettent. Retirez du carburant ou allégez le chargement.`,
	refuelPayloadOut: 'Une limite qu’aucune quantité de carburant ne corrige est dépassée\u202f: voir la page Masse et centrage.',
	refuelStrategyBlockedTip:
		'Cette stratégie se ravitaille là où le carburant n’est pas disponible pour cet aéronef',
	refuelAt: (stops: string) => `Avitaillement à ${stops}`,
	refuelPlanHeading: 'Plan d’avitaillement',
	refuelPlanNote:
		'Minimum strict à embarquer à chaque décollage\u202f: assez à chaque atterrissage à venir pour dérouter en préservant la réserve, jusqu’au prochain avitaillement.',
	refuelStrategyOverLimitsTip: 'Avec ces quantités, une navigation sort des limites de masse et de centrage',
	refusalShortBased: 'Avions basés seulement (AIP)',
	refusalShortGrade: (grades: string) => `Pas de ${grades} (AIP)`,
	refusalShortNone: 'Pas de carburant (AIP)',
	refusalShortNotamAll: (notam: string) => `Pas de carburant, NOTAM ${notam}`,
	refusalShortNotamGrade: (p: { grades: string; notam: string }) => `Pas de ${p.grades}, NOTAM ${p.notam}`,
	removeAerodromeTip: 'Retirer cet aérodrome',
	removeIcaoAria: (icao: string) => `Retirer ${icao}`,
	requiredAsdRow: (pct: number) => `Requise (+${pct} %)`,
	reserveKept: (p: { min: number; dayNight: string }) =>
		`${p.min} min de réserve finale préservée (vol de ${p.dayNight}).`,
	resetLiveWx: 'Rétablir la météo en direct',
	resetLiveWxTip:
		'Effacer les QNH, températures et vents saisis pour rétablir les valeurs de la météo en direct',
	requiredD15Row: (pct: number) => `Requise (+${pct} %)`,
	requiredRollRow: (pct: number) => `Requis (+${pct} %)`,
	retrievedStamp: (time: string) =>
		`Récupéré à ${time}, vérifiez les mises à jour avant le départ.`,
	rollMass: (massKg: number) => `Roulement ${massKg}`,
	rowEmpty: 'Avion vide',
	rowEnduranceTip: 'Le carburant au décollage à la consommation de croisière\u202f: la case 19 E/ du plan de vol OACI',
	rowFuel: 'Essence',
	rowFuelAtLanding: 'Carburant à l’atterrissage',
	rowFuelAtTakeoff: 'Carburant au décollage (L)',
	rowFuelSufficient: 'Carburant suffisant\u202f?',
	rowMaxWithin: 'Maximum dans les limites',
	rowMaxWithinTip:
		'Le maximum de carburant à ce décollage gardant chaque navigation jusqu’au prochain avitaillement dans les limites de masse et de centrage, arrondi au litre inférieur',
	rowMb: 'Masse et centrage',
	rowMbTip:
		'Dans les limites au décollage, à l’atterrissage et sans carburant. Ouvre la feuille de cette navigation sur la page Masse et centrage',
	rowNeeded: 'Nécessaire jusqu’au prochain avitaillement',
	rowNeededTip:
		'Le minimum de carburant à ce décollage pour chaque navigation jusqu’au prochain avitaillement, chaque atterrissage gardant son dégagement et sa réserve, arrondi au litre supérieur',
	rowOnArrival: 'À bord avant avitaillement',
	rowRefuel: 'Avitaillement avant décollage',
	rowRefuelTip:
		'Le carburant fixé à ce décollage. Pas d’avitaillement décolle avec ce que contiennent les réservoirs\u202f: au départ tel que relevé au carnet de route (le bouton dessous), à une escale tel que la navigation précédente le laisse. Pas d’avitaillement en AVGAS pendant que des passagers embarquent, sont à bord ou débarquent (NCO.OP.145).',
	rowReserve: 'Réserve requise',
	rowReserveTip:
		'Ce que la navigation doit avoir à l’atterrissage\u202f: le déroutement vers le dégagement, sa procédure et sa majoration vent, la marge CDB et la réserve finale',
	rowTouchdownTip:
		'La masse à l’atterrissage plus toute l’allocation de roulage, consommée après le toucher, et la réserve de route, que le vol peut ne pas utiliser\u202f: ce que limite la masse maximale à l’atterrissage',
	rowUplift: 'Quantité avitaillée',
	rowUpliftTip:
		'Le carburant ajouté à ce décollage, en litres entiers arrondis selon la cible. Ce qui est à bord est une estimation (le carnet de route au départ, ce que la navigation précédente laisse à une escale)\u202f: le carburant au décollage est ce que les jauges doivent indiquer',
	rowWithinLimits: 'Dans les limites\u202f?',
	runwayQfu: 'Piste (QFU)',
	runwayClosedOption: (id: string) => `${id} (fermée)`,
	runwayClosedTitle: 'Fermée par NOTAM',
	rwyAutoTip: 'auto\u202f: piste la plus au vent, choisissez pour remplacer',
	rwyPickLostTip: 'la piste choisie n’est plus publiée, piste la plus au vent à la place, choisissez de nouveau pour remplacer',
	seaLevel: 'Niveau de la mer',
	secAdmin: 'A) Vol projeté / administratif',
	secCharts: 'D) Cartes',
	secNotam: 'C) NOTAM et SUP AIP',
	secWeather: 'B) Météo',
	selectAircraftNote: 'Sélectionnez un aéronef (onglet Aéronefs).',
	selectAircraftTip: 'Sélectionnez un aéronef dans l’onglet Aéronefs',
	selectForLitres:
		'Sélectionnez un aéronef (onglet Aéronefs) pour convertir les minutes en litres et vérifier le réservoir.',
	selectForMb: 'Sélectionnez un aéronef (onglet Aéronefs) pour calculer la masse et le centrage.',
	selectForPerf:
		'Sélectionnez un aéronef (onglet Aéronefs) pour calculer les performances de piste.',
	sepValidity: 'SEP validité',
	setEtd: 'Renseignez l’ETD pour calculer la chronologie et la limite d’autonomie.',
	sheetMax: (litres: string) => `maximum dans les limites ${litres} L`,
	sheetMaxNone: 'aucune quantité ne respecte les limites',
	sheetNeeded: (litres: string) => `nécessaire ${litres} L`,
	sheetsNavAria: 'Navigations',
	stationCarriedTip: (kg: number) => `${kg} kg, reportés de la navigation précédente`,
	stationMax: (kg: number) => `(maxi ${kg} kg)`,
	softFieldNote: (p: { flaps: number; icaos: string }) =>
		`Piste non revêtue (${p.icaos})\u202f: le décollage sur terrain mou du manuel de vol peut imposer les volets ${p.flaps}° quelle que soit la longueur.`,
	stopModeFull: 'Pleins complets',
	stopModeMax: 'Maximum',
	stopModeMinimum: 'Minimum',
	stopModeTabs: 'Aux indicateurs',
	stopN: (n: number) => `escale ${n}`,
	strategy: 'Stratégie',
	subjLanding: (at: string) => `atterrissage à ${at}`,
	subjTakeoff: (at: string) => `décollage à ${at}`,
	subjTrip: (p: { n: number; what: string }) => `Navigation ${p.n}, ${p.what}`,
	subjZeroFuel: 'sans carburant',
	sunrise: 'Lever du soleil (UTC)',
	sunriseTip: 'Lever du soleil NOAA à l’aérodrome à la date du vol',
	sunset: 'Coucher du soleil (UTC)',
	sunsetTip: 'Coucher du soleil NOAA à l’aérodrome à la date du vol',
	tailwindCalmTip: 'Vent arrière 0 kt, calme supposé (pas de METAR en direct).',
	tailwindInfluence: (pct: number) =>
		`Influence du vent arrière\u202f: rajouter ${pct} % de distance par tranche de 2 kt.`,
	tailwindKt: 'Vent arrière (kt)',
	tailwindMetarTip: (p: { kt: number; prov: string }) => `Vent arrière ${p.kt} kt ${p.prov}.`,
	tailwindRowTip: 'Composante arrière le long de la piste',
	tailwindZeroTip: 'Vent arrière 0 kt, puisqu’un vent de face est saisi pour cette piste.',
	takeLitresAt: (p: { litres: number; at: string }) => `Emporter ${p.litres} L à ${p.at}`,
	takeLitresAtTip: 'Règle ce décollage sur le maximum dans les limites',
	takeoff: 'Décollage',
	takeoffPerfHeading: 'Performances au décollage',
	takeoffProcedure: 'Procédure de décollage',
	takeoffProcedureTip: 'Le décollage normal dès que ses distances suffisent, sinon le décollage court',
	tankLitres: (litres: string) => `(${litres} L)`,
	tankOrderTip: 'Le carburant remplit les réservoirs dans l’ordre de la fiche et se consomme dans l’ordre inverse.',
	taxi: 'Roulage',
	taxiTip: 'Par défaut 10 min par navigation\u202f: 5 au départ + 5 à destination',
	tempIsaTip: (temp: number) =>
		`Température ${temp} °C, ISA à l’altitude-pression (ni METAR ni prévision en direct).`,
	tempMetarTip: (p: { temp: number; prov: string }) => `Température ${p.temp} °C ${p.prov}.`,
	temperatureC: 'Température (°C)',
	threeRs: 'Règle des 3 R\u202f: le vol semble-t-il',
	timeToCheck: 'Potentiel (h:mm)',
	title: 'Préparation du vol',
	todaTip: 'Distance utilisable au décollage (publiée)',
	toraTip: 'Distance de roulement utilisable au décollage (publiée)',
	touchdownRow: 'Toucher des roues',
	tripBurnTip: (min: number) =>
		`Délestage\u202f: ${min} min à la consommation de croisière, vent et réserve de route compris`,
	tripCaption: (p: { n: number; route: string }) => `Navigation ${p.n}, ${p.route}`,
	tripChipAria: (p: { n: number; route: string; verdict: string }) =>
		`Navigation ${p.n}, ${p.route}, dans les limites\u202f: ${p.verdict}`,
	tripN: (n: number) => `Navigation ${n}`,
	trips: 'Trajets',
	twinSpeeds: (p: { vmc: number; vyse: number }) =>
		`Un moteur en panne\u202f: Vmc ${p.vmc} kt (trait rouge), Vyse ${p.vyse} kt (trait bleu), vitesses conventionnelles.`,
	type: 'Type',
	typeToOverrideHint: ' Saisissez pour remplacer, effacez pour rétablir la valeur automatique.',
	unknownChipTip: (key: string) =>
		`${key} n’est pas dans votre flotte. Importez-le dans l’onglet Aéronefs`,
	unknownIdent: (icao: string) => `${icao}\u202f: indicateur d’aérodrome inconnu`,
	unpavedTip: 'Appliqué sauf si la piste est connue comme revêtue',
	upliftShort: (litres: string) => `+${litres} L`,
	useThisPlan: 'Utiliser ce plan',
	useThisPlanTip:
		'Avitaille à ces escales (au minimum là où aucun avitaillement n’est encore prévu) et nulle part ailleurs. Le départ garde son carburant sauf s’il dépasse une limite de masse ou de centrage, il prend alors le maximum dans les limites. Un départ sans avitaillement prend le minimum, qui n’ajoute rien quand ce qui est à bord le couvre.',
	verdictDotSr: 'Un verdict de cette page est NON.',
	vertProfile: 'Profil vertical',
	wet: 'Mouillée',
	wetCorrection: (pct: number) => `Piste mouillée = +${pct} %.`,
	windAllowance: 'Majoration vent',
	windMultiplyBy: (p: { kt: number; factor: string }) => `${p.kt} kt multiplier par ${p.factor}`,
	windowAboveOnArrival: (p: { at: string; aboard: string; max: string }) =>
		`${p.at}\u202f: ${p.aboard} L arrivent, au-delà des ${p.max} L que les limites permettent là. Rien à ajouter.`,
	windowAtMost: (litres: string) => `au plus ${litres} L`,
	windowBeyondTank: (p: { at: string; needed: string; usable: string }) =>
		`${p.at}\u202f: ${p.needed} L nécessaires jusqu’au prochain avitaillement, plus que les ${p.usable} L que contiennent les réservoirs\u202f: avitaillez plus loin.`,
	windowEmpty: (p: { at: string; needed: string; max: string }) =>
		`${p.at}\u202f: ${p.needed} L nécessaires jusqu’au prochain avitaillement, plus que les ${p.max} L que permettent les limites\u202f: réduisez le chargement ou avitaillez plus loin.`,
	windowLine: (p: { at: string; litres: string; plan: string }) =>
		`${p.at}\u202f: décoller avec ${p.litres}. Votre plan\u202f: ${p.plan}.`,
	windowLineUplift: (p: { at: string; litres: string; uplift: string; plan: string }) =>
		`${p.at}\u202f: décoller avec ${p.litres} (${p.uplift}). Votre plan\u202f: ${p.plan}.`,
	windowLitres: (p: { lo: string; hi: string }) => `${p.lo} à ${p.hi} L`,
	windowLitresOne: (litres: string) => `${litres} L`,
	windowUplift: (p: { lo: string; hi: string; grade: string }) => `environ +${p.lo} à +${p.hi} L ${p.grade}`,
	windowUpliftOne: (p: { n: string; grade: string }) => `environ +${p.n} L ${p.grade}`,
	windowUpliftUpTo: (p: { hi: string; grade: string }) => `rien à ajouter, au plus +${p.hi} L ${p.grade}`,
	withinEnvelope: 'Dans l’enveloppe au décollage, à l’atterrissage et sans carburant.',
	withinUsable: 'Dans le carburant utilisable\u202f?',
	withoutRefuelling: (p: { litres: string; time: string; usable: number }) =>
		`Sans avitaillement\u202f: ${p.litres} L (${p.time}), plus que les ${p.usable} L que contiennent les réservoirs.`,
	wxAndLegs: (n: number) => `${n} ${plural(n, 'segment', 'segments')} à vent manuel`,
	wxBriefingOn: 'La météo est consultable sur',
	wxChangeWind: 'Modifier',
	wxChangeWindTip: 'Régler le vent du plan dans l’onglet Route (Paramètres de vol)',
	wxEstimatedHead: 'Estimé\u202f: QNH par défaut, température ISA, vent calme',
	wxEstimatedNote:
		'estimé\u202f: QNH par défaut, température ISA, vent calme',
	wxFetching: (head: string) => `${head}, récupération du METAR...`,
	wxForecastHead: (p: { day: string; source: string | null }) =>
		p.source ? `Prévision pour le ${p.day} (${p.source})` : `Prévision pour le ${p.day}`,
	wxForecastPending: 'récupération de la prévision...',
	wxFreezingAtOrBelow: (p: { ft: string; first: boolean }) =>
		`${p.first ? 'Isotherme' : 'isotherme'} 0 °C à ${p.ft} ou plus bas`,
	wxFreezingDownTo: (p: { ft: string; first: boolean }) =>
		`${p.first ? 'Isotherme' : 'isotherme'} 0 °C au plus bas à ${p.ft}`,
	wxIsa: (dev: string) => `ISA ${dev}`,
	wxLegWithout: (leg: number) => `Segment ${leg} sans prévision`,
	wxLegend:
		'Le texte gris de chaque champ est la valeur météo en direct\u202f: le METAR, ou la prévision pour un décollage ou un atterrissage à plus de deux heures de lui (ambre quand ni l’un ni l’autre n’est disponible). Saisissez pour remplacer, effacez pour rétablir.',
	wxLevelAt: (p: { level: string; fl: boolean }) => (p.fl ? ` au ${p.level}` : ` à ${p.level}`),
	wxLevelRange: (p: { low: string; lowFl: boolean; high: string; highFl: boolean }) =>
		`, ${p.lowFl ? 'du' : 'de'} ${p.low} ${p.highFl ? 'au' : 'à'} ${p.high}`,
	wxMean: (p: { wind: string; levels: string }) => `Vent moyen prévu ${p.wind}${p.levels}`,
	wxMeanLight: (levels: string) => `Vent prévu faible et variable${levels}`,
	wxMeanVaries: (levels: string) => `Vent prévu variable${levels}`,
	wxMissedManual: (wv: string) => `, vent manuel ${wv}`,
	wxMissedStillAir: ', calcul sans vent',
	wxNoWind: 'Aucun vent connu\u202f: calcul sans vent',
	wxQnhDefault: 'par défaut, ni METAR ni prévision',
	wxQnhForecast: (at: string) => `prévision pour ${at}`,
	wxQnhHead: 'QNH au départ',
	wxQnhMetar: (p: { id: string; at: string }) => `METAR ${p.id} ${p.at}`,
	wxQnhStandard: 'standard, ni METAR ni prévision',
	wxQnhTyped: 'saisi sur la page Performances',
	wxLegsWithoutCount: (n: number) => `${n} ${plural(n, 'segment', 'segments')} sans prévision`,
	wxLine: (p: { head: string; values: string }) => `${p.head}\u202f: ${p.values}`,
	wxLineHead: (p: { icao: string; phase: 'takeoff' | 'landing' | null; at: string | null }) =>
		[p.icao, p.phase === 'takeoff' ? 'décollage' : p.phase === 'landing' ? 'atterrissage' : null, p.at]
			.filter(Boolean)
			.join(' '),
	wxLiveOffNote:
		'Météo en direct désactivée\u202f: QNH par défaut, température ISA, vent calme.',
	wxMetarHead: 'METAR',
	wxMetarTooOld: (p: { head: string; id: string; at: string; age: string }) =>
		`${p.head}, METAR ${p.id} trop ancien (${p.at}, ${p.age})`,
	wxNoForecast: 'aucune prévision',
	wxNoForecastAt: (at: readonly string[]) => `aucune prévision pour ${at.join(' et ')}`,
	wxNoStation: (head: string) => `${head}, aucune station METAR à moins de 50 NM`,
	wxNote1: 'Faire la synthèse des points clefs de la situation du jour et des menaces météo.',
	wxNote2: 'Rajouter le plafond sur le profil vertical',
	wxRefreshFailedNote: 'échec de l’actualisation',
	wxStationAway: (p: { id: string; dist: string }) => `${p.id} à ${p.dist}`,
	wxTypedNote: 'valeurs saisies utilisées',
	wxUnavailable: (head: string) => `${head}, météo indisponible`,
	wxWindForecast: 'Vents prévus',
	wxWindHead: 'Vent du plan',
	wxUsedHeading: 'Météo utilisée',
	yes: 'Oui',
	yesLower: 'oui',
	yourPlan: 'Votre plan',
	yourPlanOverLimits: 'Votre plan, hors des limites',
	yourPlanShort: 'Votre plan, carburant insuffisant',
	zeroFuel: 'Sans carburant',
	zeroFuelTip: 'Tout le carburant consommé, le point le plus bas du trajet du centrage',
} satisfies Messages['flightprep'];
