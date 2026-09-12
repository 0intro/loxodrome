/* Miroir français de ../en/navigation.ts. "GPX" et "HTTPS" restent invariants;
 * "GPS" aussi (usage courant).
 *
 * TRACE, jamais "route": l'enregistrement est une trace, et "route" (Doc
 * 8400 TRK) est la direction suivie, que `track` / `trackTip` / `xtk`
 * désignent seuls. C'est la version anglaise qui a été alignée sur
 * celle-ci, où la distinction n'avait jamais glissé. */

import type { Messages } from '../en';

export const navigation = {
	intro:
		'Partagez votre position pour enregistrer une trace, puis rejouez-la sur la carte et dans le profil vertical.',
	position: 'Vol',
	aircraft: 'Aéronef',
	trace: 'Trace',
	replay: 'Rejeu',
	start: 'Démarrer le vol',
	fly: 'Voler',
	stop: 'Arrêter',
	stopFlight: 'Arrêter le vol',
	stopConfirm: 'Arrêter le vol\u202f?',
	continue: 'Reprendre',
	continueTip: 'Reprendre l’enregistrement en conservant la trace actuelle.',
	restart: 'Recommencer',
	restartTip: 'Supprimer la trace actuelle et démarrer un nouvel enregistrement.',
	/* The startup line under Start: a finished flight is not redrawn on
	   the map, it is a row in the flights library. */
	lastFlightFiled: (when: string) => `Dernier vol ${when}, dans la bibliothèque des vols.`,
	recording: 'Enregistrement',
	autoStopEnable: 'Arrêter automatiquement l’enregistrement après l’atterrissage',
	autoStopTip: (min: string) =>
		`Après l’atterrissage, une fois l’aéronef immobile pendant ${min} min, l’enregistrement s’arrête de lui-même et la trace est conservée. Un compte à rebours s’affiche d’abord, avec un bouton pour poursuivre l’enregistrement\u202f; un déplacement le repousse, et un nouveau décollage l’annule. Rien ne s’arme avant un atterrissage\u202f: une attente au point d’arrêt n’interrompt jamais un enregistrement.`,
	autoStopLabel: 'Compte à rebours de l’arrêt automatique',
	autoStopCountdown: (time: string) => `Arrêt de l’enregistrement dans ${time}`,
	autoStopKeep: 'Poursuivre l’enregistrement',
	autoStopKeepTip:
		'Annuler l’arrêt automatique pour cet atterrissage. Un nouveau décollage puis un atterrissage le réarment.',
	autoStopNote: (time: string) => `Enregistrement arrêté automatiquement à ${time}Z.`,
	bgNotifTitle: 'Enregistrement du vol',
	bgNotifText: 'Enregistrement de la trace GPS.',
	bgNote: 'L’enregistrement continue quand l’application est en arrière-plan ou fermée\u202f; arrêtez-le ici ou depuis la notification.',
	/* Son pendant sur le web : la même question, répondue autrement. */
	fgNote:
		'L’enregistrement a besoin de cette page au premier plan : changer d’application ou verrouiller l’appareil interrompt les positions jusqu’à votre retour. L’écran est maintenu allumé pendant ce temps.',
	/* La divulgation exigée par Google Play avant la demande
	   d’autorisation de localisation, montrée une seule fois. */
	locationDisclosure:
		'Loxodrome lit votre position précise pour enregistrer la trace du vol, suivre la route et vous avertir des espaces aériens à venir. L’enregistrement continue écran éteint ou application en arrière-plan, et sa notification reste affichée tant qu’il tourne. Votre position est écrite dans la trace sur cet appareil et n’est jamais transmise.',
	locationAgree: 'J’accepte',
	/* L’offre d’optimisation de batterie ouvre la liste des réglages
	   système, l’exemption en un geste demandant une autorisation que
	   Play réserve aux applications qu’un service de premier plan ne
	   suffit pas à servir. */
	bgBatteryAsk:
		'Certains téléphones interrompent l’enregistrement GPS quand l’écran est éteint ou l’application en arrière-plan. Ouvrir les réglages système de batterie pour lever la restriction sur Loxodrome\u202f?',
	bgBatteryAction: 'Ouvrir les réglages',
	bgBatteryHint: 'L’optimisation de la batterie peut interrompre l’enregistrement en arrière-plan.',
	bgBatteryFix: 'Ouvrir les réglages de batterie',
	aircraftSymbol: 'Symbole aéronef',
	plane: 'Avion',
	helicopter: 'Hélicoptère',
	glider: 'Planeur',
	showTrace: 'Afficher la trace sur la carte',
	follow: 'Suivre l’aéronef',
	followTip:
		'Garde l’aéronef centré sur la carte. Déplacer la carte le suspend\u202f; le bouton sur la carte le réactive.',
	recenter: 'Recentrer sur l’aéronef',
	vector: 'Vecteur de trajectoire',
	vectorTip: 'Position projetée à 2, 3, 5 et 10 min à la vitesse sol actuelle.',
	groundSpeed: 'Vitesse sol',
	track: 'Route',
	trackTip: 'Route magnétique sol.',
	altitude: 'Altitude GPS',
	altitudeTip: (datum: string, sep: string) =>
		`Altitude GNSS au-dessus du niveau moyen de la mer. L’appareil fournit ${datum}, donc ${sep}. Ce n’est pas une indication altimétrique et elle ne doit pas être utilisée comme telle.`,
	altDatumSource: {
		ellipsoid: 'une hauteur au-dessus de l’ellipsoïde WGS84',
		msl: 'une altitude déjà rapportée au niveau moyen de la mer',
	},
	altDatumCorrection: {
		applied: (ft: string) => `la séparation du géoïde de ${ft} ft est appliquée`,
		none: 'aucune correction n’est appliquée',
	},
	altDatumApplied: {
		ellipsoid: 'corrigée du géoïde depuis l’ellipsoïde WGS84',
		msl: 'telle que fournie par l’appareil',
	},
	profileDatum: (datum: string) =>
		`Altitude\u202f: GNSS au-dessus du niveau moyen de la mer (${datum})\u202f; ce n’est pas une indication altimétrique.`,
	profileDatumShort: 'Altitude GNSS (NMM), pas une indication altimétrique',
	elapsed: 'Temps écoulé',
	timeOfDay: 'Heure',
	unlock: 'Déverrouiller',
	accuracy: 'Précision',
	waitingFix: 'En attente d’un point GPS',
	stripLabel: 'Bandeau de vol',
	stripCollapse: 'Réduire le bandeau de vol',
	stripExpand: 'Développer le bandeau de vol',
	stripHide: 'Masquer le bandeau de vol',
	stripShow: 'Afficher le bandeau de vol',
	copyFreq: (unit: string) => `Copier la fréquence ${unit}`,
	gpsDegraded: 'Position dégradée',
	gpsDegradedTip:
		'Le dernier point remonte à plusieurs secondes, ou sa précision est médiocre. Toutes les valeurs en direct sont figées sur ce point.',
	gpsLost: 'Position perdue',
	gpsLostTip:
		'Aucune position reçue depuis plus de 15 secondes. Le symbole aéronef et toutes les valeurs en direct sont figés sur le dernier point, et le vecteur de trajectoire n’est pas tracé.',
	play: 'Lecture',
	toStart: 'Revenir au début',
	toEnd: 'Aller à la fin',
	pause: 'Pause',
	prevEvent: 'Événement précédent',
	nextEvent: 'Événement suivant',
	eventJumpTip:
		'Aller d’un événement enregistré à l’autre : décollage, atterrissage, passage des points, limites d’espace aérien.',
	replaySlider: 'Position du rejeu',
	speed: 'Vitesse',
	traceStart: 'Début de la trace',
	duration: 'Durée',
	distance: 'Distance',
	points: 'Points',
	exportIgcNoTime:
		'Cette trace ne porte aucune heure UTC, que le format IGC exige\u202f: elle sera exportée en GPX.',
	exportTrace: (format: string): string => `Exporter ${format}`,
	exportTraceOwn: 'Exporter la trace',
	igcDatumEllipsoid: 'Hauteur au-dessus de l’ellipsoïde WGS84',
	igcDatumEllipsoidHint:
		'Ce que définit la spécification IGC, et ce qu’écrivent les enregistreurs homologués.',
	igcDatumMsl: 'Altitude au-dessus du niveau moyen de la mer',
	igcDatumMslHint: 'Ce qu’écrivent XCSoar et les autres enregistreurs logiciels.',
	igcDatumQuestion:
		'Ce fichier IGC n’indique pas la référence de ses altitudes. Les deux lectures diffèrent d’environ 150 ft en France.',
	igcDatumTitle: 'Référence des altitudes',
	importFailed: 'Impossible de lire ce fichier de trace.',
	importTrace: 'Importer une trace',
	importTraceTip: 'Relire une trace\u202f: GPX, IGC, KML ou KMZ.',
	replaceConfirm: 'Remplacer la trace actuelle\u202f?',
	replaceConfirmAction: 'Remplacer',
	clear: 'Effacer',
	clearConfirm: 'Supprimer la trace actuelle\u202f?',
	clearConfirmAction: 'Supprimer',
	/* Une seule formulation pour la surface, le bouton de l’onglet qui
	   l’ouvre et la flèche de retour du panneau de détail. */
	profileTitle: 'Profil vertical de la trace',
	profileSwitchAria: 'Profil de la route ou de la trace',
	noTrace: 'Aucune trace enregistrée.',
	contactMap: 'Surligner sur la carte l’espace actuel et le prochain espace à contacter',
	contactCurrent: 'Fréquence actuelle',
	contactNext: 'Fréquence suivante',
	contactNextShort: 'Suivante',
	contactBoundary: 'Prochain changement',
	contactBoundaryTip: 'Distance, temps et heure jusqu’au prochain changement de contact\u202f: une limite d’espace, ou le terrain d’atterrissage.',
	contactNone: 'Aucun organisme à contacter le long de la route.',
	contactNoFix: 'En attente d’une position.',
	contactOverflight: 'Aérodrome survolé',
	overflightFreq: 'Afficher la fréquence de l’aérodrome survolé',
	overflightFreqTip: (nm: string) =>
		`Ajoute au bandeau de vol l’aérodrome le plus proche disposant d’une fréquence publiée à moins de ${nm} NM de l’aéronef, résolu à partir de la position GPS et non de la route prévue. Le départ et la destination de la route en cours ne sont pas répétés.`,
	navlog: 'Log de navigation',
	navlogTip:
		'Note l’heure réelle de passage à chaque point à partir du décollage, révise les estimées à la vitesse sol actuelle et suit la séquence radio du log de navigation, le tout à la position projetée sur la route prévue.',
	bearing: 'Relèvement',
	bearingTip: 'Relèvement magnétique de l’aéronef vers le point actif.',
	xtk: 'Écart latéral',
	xtkTip: 'Distance à la route prévue et côté où se trouve l’aéronef\u202f; la correction se fait de l’autre côté.',
	xtkLeft: 'G',
	xtkRight: 'D',
	onCourse: 'dans l’axe',
	/* Le virage lui-même, que le relèvement et la route ne font que
	   suggérer. Les lettres de côté sont celles de l’écart latéral. */
	steer: 'Virage',
	steerTip:
		'Le virage à effectuer pour se diriger vers le point actif : le relèvement vers ce point moins la route suivie, tous deux magnétiques. Gauche ou droite indique le sens du virage.',
	steerLeft: (deg: string) => `G ${deg}°`,
	steerRight: (deg: string) => `D ${deg}°`,
	steerNone: '0°',
	navlogTakeoff: 'Décollage',
	navlogLanding: 'Atterrissage',
	navlogAirborne: 'Temps en l’air',
	navlogAirborneTip: 'Du décollage à l’atterrissage\u202f: le temps passé en vol.',
	navlogFlightTime: 'Temps de vol (bloc)',
	navlogFlightTimeTip:
		'Du premier mouvement en vue du décollage à l’immobilisation finale (OACI annexe 1, FCL.010). C’est ce temps de vol qui est porté au carnet, pas le temps en l’air.',
	blockOff: 'Bloc départ',
	blockOffTip: 'Premier déplacement du vol (détecté par GPS).',
	blockOn: 'Bloc arrivée',
	blockOnTip: 'Immobilisation finale du vol (détectée par GPS).',
	landingsCount: 'Atterrissages',
	landingsCountTip:
		'Atterrissages complets, arrêts-décollés et, une fois l’enregistrement terminé, posés-décollés détectés (passage lent et bas prolongé sur un aérodrome connu). Déduit du GNSS, à titre indicatif : une remise de gaz tardive peut compter en trop et un terrain absent des données en moins ; vérifiez avant report au carnet de vol.',
	landingsNight: (n: string) => `${n} de nuit`,
	nightTime: 'Temps de nuit',
	nightTimeTip:
		'Temps de vol en nuit aéronautique : coucher du soleil +30 min au lever −30 min (15 min aux latitudes inférieures ou égales à 30 degrés), crépuscule civil au-delà de 60 degrés.',
	maxAltitude: 'Altitude max',
	maxAltitudeTip:
		'Altitude GNSS la plus haute de la trace, rapportée au niveau moyen de la mer. Ce n’est pas une indication altimétrique.',
	exportCsv: 'Exporter le carnet de vol (CSV)',
	exportCsvTip:
		'Une ligne par vol, colonnes AMC1 FCL.050 (en-têtes en anglais, heures UTC, format avion Part-FCL). Prérempli depuis la trace, à vérifier et corriger avant report dans votre carnet de vol.',
	legProgress: 'Progression sur l’étape en cours',
	navlogNext: 'Point suivant',
	navlogEta: 'ETA destination',
	navlogArrived: 'Arrivée',
	/* L’écart au plan, en toutes lettres : un nombre signé demanderait une
	   convention expliquée dans une infobulle, que l’écran tactile embarqué
	   n’affiche jamais. */
	planEarly: (min: string) => `${min} min d’avance`,
	planLate: (min: string) => `${min} min de retard`,
	planOnTime: 'à l’heure',
	planDeltaTip:
		'Temps gagné ou perdu sur le plan depuis le départ : l’heure d’arrivée que tient le log, comparée à la durée prévue pour toute la route. Un départ en retard n’y est pas compté.',
	/* Route, pas etape: une etape est un point vers le suivant partout ailleurs
	   dans l'application, et il s'agit ici de routes entieres d'un plan qui se
	   pose. */
	flownRoute: 'Route en cours',
	flownRouteTip:
		'Un plan composé de plusieurs routes consécutives se vole une route à la fois. La route est détectée à partir de la trace et passe à la suivante à l’arrivée\u202f; épinglez-en une pour la voler quelle que soit la trace.',
	routeFlying: 'en cours',
	routeFlown: 'parcourue',
	routeNotFlown: 'non parcourue',
	routePinned: 'épinglée',
	routePin: 'Voler cette route quelle que soit la trace',
	routeRelease: 'Détecter de nouveau la route à partir de la trace',
	/* Un niveau en dessous : quel segment de cette route la projection lit. */
	flownLeg: 'Segment en cours',
	flownLegTip:
		'Le log projette l’aéronef sur la route prévue pour dire où il se trouve. Lorsqu’il lit le mauvais segment (un demi-tour vers un point précédent, un couloir que la route partage avec elle-même), appuyez sur le segment en cours : la projection s’y recale à partir de maintenant, puis reprend son enchaînement toute seule. Les heures déjà relevées sont conservées.',
	legPin: 'Lire le log sur ce segment à partir de maintenant',
	legRelease: 'Annuler ce recalage',
	legByHand: 'recalé à la main',
	freqAll: (field: string) => `Toutes les fréquences de ${field}`,
	freqShow: 'Afficher toutes les fréquences de cet aérodrome',
	freqHide: 'Masquer les fréquences',
	freqWas: (freq: string) => `Remplace ${freq}, selon un NOTAM en vigueur`,
	contactClosedBy: (p: { unit: string; id: string }) =>
		`${p.unit}\u202f: fermeture par NOTAM ${p.id}, le service publié en dessous répond à la place.`,
	freqFlagged: 'Un changement de fréquence n’a pas pu être rattaché à un service publié',
	planOnly: 'plan, pas position',
	planOnlyTip: (nm: string) =>
		`L’aéronef est à plus de ${nm} NM de cette route, ou ne la vole pas du tout. Les organismes, le compte à rebours et la séquence répondent pour le point le plus proche du plan, pas pour la position réelle de l’aéronef.`,
	/* Le bandeau d’alerte espace aérien (docs/nav-alerts.md). Des constats et
	   l’exigence publiée, jamais d’instructions de manœuvre : l’évaluation
	   est consultative, et " pénétration interdite " se lit comme le statut
	   de la zone, qu’elle soit devant ou que l’aéronef y soit déjà. */
	alertInside: (name: string) => `Dans ${name}`,
	alertAhead: (name: string, min: string) => `${name} dans ${min} min`,
	alertAbeam: (name: string, nm: string) => `${name} à ${nm} NM`,
	alertNear: (name: string) => `${name} à proximité`,
	alertJustBelow: (name: string) => `Juste sous ${name}`,
	alertJustAbove: (name: string) => `Juste au-dessus de ${name}`,
	alertClimbingInto: (name: string) => `En montée vers ${name}`,
	alertDescendingInto: (name: string) => `En descente vers ${name}`,
	alertDoNotEnter: 'pénétration interdite',
	alertCoveredForbidden: (zone: string) => `pénétration interdite (${zone})`,
	alertClearance: 'clairance requise',
	alertContact: (unit: string, freq: string) => `contactez ${unit} ${freq}`,
	alertRadio: 'radio obligatoire',
	alertRadioXpdr: 'radio et transpondeur obligatoires',
	alertTransponder: 'transpondeur obligatoire',
	alertCaution: 'prudence',
	alertPlanned: (unit: string, freq: string) =>
		`prévu\u202f: contactez ${unit} ${freq} avant l’entrée`,
	alertWindow: (from: string, to: string) => `active ${from}-${to}Z`,
	alertAltUnknown: '(altitude inconnue)',
	alertExtentUnknown: '(étendue verticale inconnue)',
	alertAckTip: 'Acquitter cette alerte. Une aggravation alerte de nouveau.',
	alertAckedTip: 'Acquittée',
	alertAckLabel: 'Acquitter',
	alertOpenTip: 'Ouvrir dans le panneau de détail',
	alertPanelOpenTip: 'Ouvrir le panneau des alertes espace aérien',
	alertChipActive: (n: string) => `Alertes espace aérien\u202f: ${n}`,
	alertChipAcked: (n: string) => `acquittées\u202f: ${n}`,
	alertChipAllAcked: 'Toutes les alertes espace aérien sont acquittées',
	alertChipSuspended: 'Alertes espace aérien suspendues',
	alertAckedSection: (n: string) => `Acquittées (${n})`,
	alertAckedNote: 'Alerte de nouveau en cas d’aggravation ; disparaît 5 min après la fin de la condition.',
	alertLifecycleNote: 'Une alerte demeure tant que sa condition persiste et disparaît quand elle cesse.',
	alertPanelEmpty: 'Aucune alerte en cours.',
	alertSuspendedLost: 'Alertes espace aérien suspendues : position perdue',
	alertSuspendedLostTip:
		'Aucune position depuis plus de 15 secondes : une position figée ne doit pas être confrontée à l’espace aérien. L’évaluation reprend au prochain point.',
	alertSuspendedNoFix: 'Alertes espace aérien en attente d’une position',
	alertSuspendedNoFixTip:
		'L’enregistrement n’a pas encore de point GPS : rien n’est évalué. L’évaluation démarre au premier point.',
	alertAirspacesLoading: 'Chargement des données d’espaces aériens',
	alertAirspacesLoadingTip: 'L’évaluation des alertes commence dès que le jeu de données est chargé.',
	alertNoAirspaces: 'Données d’espaces indisponibles : aucune alerte n’est évaluée',
	alertNoAirspacesTip:
		'Le jeu de données des espaces aériens n’a pas été chargé : la position n’est confrontée à aucune zone. Un bandeau d’alertes vide ne signifie pas que l’espace est libre.',
	alertNoBriefing: 'Aucun briefing NOTAM : l’activité réelle des zones activables par NOTAM est inconnue',
	alertNoBriefingTip:
		'Sans briefing, l’application ne peut distinguer une zone inactive d’une zone non listée : toute zone activable par NOTAM (le réseau RTBA au premier chef) est classée en vigilance plutôt que passée sous silence. Les zones temporaires créées par le NOTAM lui-même (ZRT, ZIT, ZDT) ne sont, elles, pas évaluées du tout. Chargez un briefing dans l’onglet NOTAM pour les résoudre.',
	alertsSection: 'Alertes espace aérien',
	alertsTip:
		'Évalue l’espace aérien autour de l’aéronef à partir de la position GNSS\u202f: zones interdites, limites soumises à clairance, zones à équipement obligatoire et dangers, l’activation étant lue sur la trajectoire projetée.',
	alertsEnable: 'Évaluer l’espace aérien autour de l’aéronef',
	alertTierAvoid: 'Zones interdites et réglementées actives',
	alertTierClearance: 'Espaces contrôlés (clairance requise)',
	alertTierEquipment: 'Zones radio et transpondeur (RMZ / TMZ)',
	alertTierCaution: 'Zones dangereuses et d’activité',
	alertBuffer: 'Marge verticale',
	alertBufferTip:
		'Élargit les limites verticales de chaque zone. En palier dans la marge, une note discrète "juste sous / juste au-dessus" sans signal sonore\u202f; une montée ou une descente qui referme l’écart en moins de 2 minutes alerte.',
	alertLookahead: 'Anticipation',
	alertAudio: 'Alertes sonores',
	alertAudioTip:
		'L’armement émet une fois le signal sonore d’avertissement\u202f: le navigateur déverrouille le son sur cet appui, et vous entendez à quoi ressemble un avertissement. Silencieux pendant le rejeu.',
	alertAudioCaution: 'Signal sonore aussi pour les prudences',
	alertTest: 'Écouter le signal sonore d’avertissement',
	alertAdvisory:
		'À titre consultatif\u202f: l’évaluation confronte la position GNSS aux données publiées. Elle ne remplace ni la préparation, ni la carte, ni la surveillance extérieure.',
	errors: {
		denied:
			'L’accès à la position a été refusé. Autorisez-le dans les réglages du navigateur ou du système, puis relancez.',
		unavailable: 'La position n’est pas disponible sur cet appareil.',
		timeout: 'L’obtention d’une position prend plus de temps que d’habitude.',
		insecure: 'La localisation nécessite une connexion sécurisée (HTTPS).',
	},
} satisfies Messages['navigation'];
