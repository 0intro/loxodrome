/* Miroir français de ../en/route.ts. "NOTAM" est invariable au pluriel, tout
 * comme FIR; les abréviations OACI Doc 8400 (ETE, TAS, W/V, FL, QDR, QDM),
 * VFR / IFR, les unités (ft, NM, kt) et les noms de produits (Open-Meteo,
 * SOFIA-Briefing, autorouter, YAML) restent invariants. Vocabulaire: leg =
 * segment, waypoint = point (compact) / point de cheminement (prose). */

import type { Messages } from '../en';
import { plural } from './plural';

/* Le niveau vient de fmtLevel / levelLabel: "FL 065" au-dessus de l'altitude
 * de transition, "3500 ft" en dessous; la préposition s'accorde à la forme
 * ("au FL 065", "à 3500 ft"). */
const auNiveau = (level: string): string => (level.startsWith('FL') ? `au ${level}` : `à ${level}`);

export const route = {
	actionsMenu: 'Actions sur les routes',
	actionsMenuUnstored: 'Actions sur les routes, modifications non mémorisées du plan de vol',
	activeWord: 'ACTIVE',
	addFieldPlaceholder: 'Indicateurs ou coordonnées, p. ex. LFPL N48,8200/E2,62000 LFQB',
	addRoute: 'Ajouter une route',
	airspacesOnRouteOnly: 'Afficher uniquement les espaces traversés par la route',
	airspacesOnRouteOnlyTip:
		'Afficher uniquement les espaces aériens traversés par l’une des routes à son altitude planifiée, en masquant tous les autres et en ignorant les commutateurs de catégorie d’espaces.',
	alternateRoute: 'Route de dégagement',
	alternateRouteTip:
		'Marquer cette route comme dégagement (déroutement) de la route de navigation précédente\u202f; le bilan carburant la compte dans les réserves de cette navigation (ordonner les routes en navigation, dégagement, navigation, ...).',
	applyAll: 'Tout appliquer',
	bandActivatedBy: 'Activé par NOTAM',
	clearAllRoutes: 'Vider toutes les routes',
	clearAllRoutesConfirm:
		'Supprimer toutes les routes\u202f? Il ne restera qu’une route vide, et l’annulation les rétablit.',
	clearAllRoutesAction: 'Tout effacer',
	clearAllRoutesTip: 'Supprimer toutes les routes et repartir d’une route vide',
	clearRoute: 'Vider la route active',
	clearRouteTip: 'Supprimer tous les points de la route active',
	clearWindAria: 'Effacer le forçage du vent',
	clearWindTip: 'Effacer le forçage (retour au vent prévu ou global)',
	closeRoute: 'Fermer la route',
	clouds: 'Nuages',
	cloudsTip:
		'Afficher la couverture nuageuse prévue en couches grises par segment (FEW à OVC), approchée en amont à partir de l’humidité relative du modèle à chaque niveau de pression',
	corridor: 'Couloir',
	corridorTip:
		'Demi-largeur du couloir (NM de chaque côté) utilisée à la fois pour récupérer les NOTAM de route ci-dessous et par le filtre Afficher uniquement les NOTAM de la route.',
	couldNotFind: (list: string) => `Introuvable\u202f: ${list}`,
	coverageWithin: (p: { a: number; f: number; nm: number }) =>
		`${p.a} ${plural(p.a, 'aérodrome', 'aérodromes')} + ${p.f} FIR à moins de ${p.nm} NM de la route active.`,
	crossesForbidden: 'La route traverse un espace aérien interdit ou actif',
	crossesForbiddenShort: 'Pénétration interdite',
	crossesLabel: 'Traverse',
	crossingsOpenAria: 'Ouvrir la liste des espaces traversés',
	cruise: 'Croisière',
	cruiseTip:
		'Une seule valeur, partagée avec la vitesse de croisière de l’aéronef sélectionné (onglet Aéronefs). Vide, la vitesse de l’aéronef s’applique, affichée en grisé. Sans aucune valeur, les colonnes ETE sont omises.',
	cruisingLevelAdvisory: 'Avis de niveau de croisière',
	ctxAirspaces: (n: number) => `Espaces aériens (${n})`,
	ctxClassG: 'Classe G (non cartographié)',
	ctxNoAirspace: 'Aucun espace aérien ici',
	ctxNotams: (n: number) => `NOTAM (${n})`,
	customPoint: 'Point personnalisé',
	datasetsLoading: 'Jeux de données en cours de chargement…',
	defaultAlt: 'Alt. défaut',
	editOnMap: 'Édition sur la carte',
	exportFpl: 'FPL, plan de vol Garmin',
	exportFplTip: 'Lu par ForeFlight, Garmin Pilot et les GPS Garmin de bord',
	exportGpx: 'GPX, route et points',
	exportGpxTip: 'Lu par la plupart des logiciels de navigation et de cartographie',
	exportKml: 'KML, Google Earth',
	exportKmlTip: 'La route trac\u00e9e dans l\u2019espace, pour Google Earth',
	exportPlan: 'Exporter tout le plan\u2026',
	exportPlanTip:
		'\u00c9crire tous les trajets, encha\u00een\u00e9s en une seule route, dans un fichier pour une autre application',
	exportPlanTitle: 'Exporter le plan',
	exportPln: 'PLN, simulateur de vol',
	exportPlnTip: 'Lu par Flight Simulator et Prepar3D',
	exportRoute: 'Exporter la route\u2026',
	exportRouteTip: '\u00c9crire la route active dans un fichier pour une autre application',
	exportRouteTitle: 'Exporter la route',
	extentUnknownShort: '\u00e9tendue non publi\u00e9e',
	fallback: 'repli',
	fasterLevels: (min: number) =>
		`Niveaux plus rapides disponibles, -${min} min au total (temps de croisière seul).`,
	fetchCoversAll: (n: number) => `La récupération couvre les ${n} routes.`,
	fetchTipReady: 'Récupérer les NOTAM d’aérodrome et en route dans chaque couloir de route',
	fetching: 'Récupération…',
	fetchingProgress: (p: { done: number; total: number }) =>
		`Récupération ${p.done} sur ${p.total}…`,
	fitAria: 'Ajuster',
	fitTip: 'Ajuster à la fenêtre',
	flightParams: 'Paramètres de vol',
	flightPreparation: 'Préparation du vol',
	flightRules: 'Règles de vol',
	forecastWinds: 'Vents prévus',
	forecastWindsTip:
		'Chaque segment est calculé avec le vent Open-Meteo prévu à sa propre altitude et à son heure estimée de survol (onglet Météo). Les champs Vent ci-dessus restent le repli là où aucune prévision ne se résout, et chaque segment peut être forcé depuis sa puce W/V.',
	freezingLevel: 'Isotherme 0 °C',
	freezingLevelTip: 'Afficher l’isotherme 0 °C prévue en ligne tiretée sur le profil',
	getNotamsMany: 'Récupérer les NOTAM des routes',
	getNotamsOne: 'Récupérer les NOTAM de la route',
	hintEditOff:
		'Activez pour cliquer sur la carte, ou saisissez ci-dessous des indicateurs ou des coordonnées (p. ex. N48492E002372 ou N48,8200/E2,62000) pour construire la route.',
	hintEditOn:
		'Cliquez sur la carte pour ajouter un point, glissez pour le déplacer, cliquez sur la ligne pour insérer. Un clic près d’un aérodrome ou d’une aide de radionavigation s’y accroche.',
	kindAirport: 'Aérodrome',
	kindNavaid: 'Aide de radionavigation',
	legAltAria: (n: number) => `Altitude du segment ${n}`,
	legAltTip: 'Altitude du segment (ft)',
	legFlTip: 'Niveau de vol du segment',
	legWindAria: 'Vent du segment',
	liveWeatherOffNote:
		'Les vents prévus et la TAS corrigée par la température nécessitent la météo en direct\u202f; activez-la dans l’onglet Météo.',
	loadRoutes: 'Charger des routes',
	loadTip: 'Charger un plan depuis un fichier YAML, FPL, GPX, KML ou PLN',
	loadedFirstN: (n: number) => `Seules les ${n} premières routes ont été chargées.`,
	loadingDatasets: 'Chargement des jeux de données…',
	magneticTrackTip: 'Route magnétique',
	minAlt: 'Couloir alt. min',
	minAltAria: 'Demi-largeur du couloir d’altitude minimale (NM de chaque côté)',
	minAltDanger: 'Surligner le relief au-dessus de la route',
	minAltDangerTip:
		'Surligne les portions du couloir d’altitude minimale (largeur ci-dessus) où l’altitude minimale de sécurité du relief ou des obstacles, marge selon les règles de vol comprise (500 ft en VFR, 1000 ft en IFR, 2000 ft en IFR en zone montagneuse), dépasse l’altitude de segment planifiée de la route active\u202f: exactement là où voler au niveau planifié enfreint le plancher de franchissement.',
	minAltTip:
		'Distance à la route (NM) dans laquelle le relief et les obstacles sont pris en compte pour l’altitude minimale de sécurité de chaque segment\u202f: de part et d’autre de celle-ci, et autour de chaque point tournant',
	moveDown: 'Descendre',
	moveUp: 'Monter',
	terrainDownload: 'Télécharger le relief pour ce plan',
	terrainDownloading: 'Téléchargement du relief',
	terrainErrors: {
		download: 'Téléchargement du relief incomplet. Vérifiez la connexion et réessayez.',
		unsupported: 'Le stockage hors ligne n’est pas pris en charge par ce navigateur.',
	},
	terrainPinned: (tiles: number, size: string, date: string) =>
		`Relief hors ligne\u202f: ${tiles} tuiles, ${size}, ${date}`,
	terrainRedownload: 'Mettre à jour',
	terrainRemove: 'Supprimer',
	terrainTip:
		'Enregistre les tuiles d’altitude de chaque couloir de ce plan, pour que les altitudes minimales, le profil vertical et les alertes relief restent disponibles hors ligne',
	msaTip:
		'Altitude minimale de sécurité par segment\u202f: sol ou obstacle le plus haut dans le couloir d’altitude minimale plus la marge selon les règles de vol (500 ft en VFR, 1000 ft en IFR, 2000 ft en IFR en zone montagneuse), arrondie aux 100 ft supérieurs (colonne MSA du log de navigation)',
	navigationLog: 'Log de navigation',
	newRoute: 'Nouvelle route',
	nextRoute: 'Route suivante',
	noCorridorYet: 'La route active n’a pas encore de couloir.',
	noFasterLevel: 'Aucun niveau plus rapide',
	noMatch: (q: string) => `Aucun aérodrome ni aide de radionavigation ne correspond à “${q}”.`,
	noWaypoints: 'Aucun point pour l’instant.',
	noWindPlanned: 'Aucun vent planifié',
	notams: 'NOTAM',
	notamsForRoute: 'NOTAM de la route',
	notamsOnRouteOnly: 'Afficher uniquement les NOTAM de la route',
	notamsOnRouteOnlyTip:
		'Afficher uniquement les NOTAM situés dans le couloir d’une route (largeur du couloir ci-dessus)\u202f: zones, positions et rayons sont testés contre la trajectoire, les NOTAM à l’échelle d’une FIR gardés pour les FIR traversées. S’applique à la carte et à toutes les listes, quel que soit le briefing chargé, récupéré ou collé.',
	notamsTip:
		'Dessiner en bandes hachurées orange les zones NOTAM traversées par la trajectoire (restrictions, avertissements, obstacles) entre leurs limites publiées, et hachurer les espaces aériens activés par NOTAM dans la fenêtre d’évaluation',
	obstacles: 'Obstacles',
	obstaclesTip:
		'Afficher les obstacles situés dans le couloir d’altitude minimale (la largeur du log de nav) à leur altitude sommitale publiée',
	onlyClosest: (max: number) => `Seuls les ${max} aérodromes les plus proches seront interrogés.`,
	openPlans: 'Plans enregistrés',
	placedApprox: (list: string) => `Placés approximativement\u202f: ${list}.`,
	planningOptions: 'Options de planification',
	prevRoute: 'Route précédente',
	print: 'Imprimer',
	profileAddWaypoints: 'Ajoutez au moins deux points pour tracer un profil vertical.',
	profileEteTip: 'Durée totale estimée en route, corrigée du vent là où les vents se résolvent',
	profileGestureHint: 'Pincer pour zoomer · glisser pour déplacer',
	readoutGround: 'Sol',
	readoutHint: 'Clic droit ou appui long\u202f: espaces aériens',
	readoutLevel: 'Niveau',
	redo: 'Rétablir',
	redoTip: 'Rétablir (Ctrl+Y)',
	remove: 'Supprimer',
	renameAria: 'Nom de la route',
	resetAutoAlt: 'Revenir à l’altitude automatique',
	restoreFailed: 'Votre plan de vol enregistré n’a pas pu être restauré\u202f: les données aérodromes et radiobalises ne se sont pas chargées.',
	restoreLossy: 'Votre plan de vol enregistré est revenu incomplet\u202f: certains points n’ont pas encore pu être résolus.',
	restoreParse: 'Votre plan de vol enregistré n’a pas pu être lu.',
	restoreRescued: 'Votre plan de vol précédent a été conservé dans le catalogue de plans de vol, dans la surface Vols.',
	restoreRetry: 'Le restaurer',
	restoreRetryTip: 'Réessayer de restaurer le plan de vol enregistré',
	restoreSheltered: 'Votre plan de vol précédent a été mis de côté. Il sera conservé dans le catalogue de plans de vol au prochain démarrage.',
	routeProfileAria: 'Profil vertical de la route',
	routesAria: 'Routes',
	saveRoutes: 'Enregistrer les routes',
	saveTip: 'Télécharger toutes les routes dans un fichier YAML',
	saving: 'Enregistrement…',
	// MÉMORISER, jamais « enregistrer »: le catalogue n'est ni le GPS qui
	// enregistre une trace, ni le téléchargement d'un fichier de routes, et
	// la version anglaise sépare Store de Save et de Recording.
	storePlan: 'Mémoriser le plan de vol',
	storePlanTip:
		'Réécrit le plan de vol actif sur son entrée du catalogue de plans de vol (surface Vols, vue Plans). Grisé quand rien n’a changé depuis l’activation du plan, et quand l’espace de travail n’est pas un plan du catalogue\u202f: activez-en un, ou utilisez Mémoriser comme nouveau plan de vol.',
	storePlanAs: 'Mémoriser comme nouveau plan de vol',
	storePlanAsTip:
		'Ajoute le plan de vol actif au catalogue de plans de vol sous le nom de sa chaîne d’aérodromes',
	storedNotice: 'Plan de vol mémorisé au catalogue.',
	storedAsNotice: 'Mémorisé comme nouveau plan de vol au catalogue.',
	storeConflictConfirm:
		'Le plan mémorisé a changé dans le catalogue depuis son activation. Le remplacer par le plan de vol actif\u202f?',
	storeConflictAction: 'Remplacer',
	storeLossyConfirm:
		'Cette copie a perdu des points lors de son activation (les données ont changé). Le mémoriser malgré tout, en remplaçant l’original plus complet\u202f?',
	storeLossyAction: 'Mémoriser',
	scrollLeft: 'Faire défiler les routes vers la gauche',
	scrollRight: 'Faire défiler les routes vers la droite',
	semicircular: 'Niveaux de croisière semi-circulaires',
	semicircularTip:
		'Cale les altitudes automatiques des segments sur les niveaux de croisière semi-circulaires selon la route magnétique de chaque segment, à plus de 3000 ft au-dessus de la surface en VFR, dès le plus bas niveau utilisable en IFR (SERA appendice 3). Les segments réglés manuellement sont signalés, jamais réécrits.',
	sendFpl: 'Envoyer cette route vers SendFPL',
	sendFplCopied: 'Route copiée dans le presse-papiers, prête à coller dans SendFPL.',
	sendFplCopy: 'Copier cette route pour SendFPL',
	sendFplCopyTip:
		'Copier la route dans le presse-papiers, prête à coller dans la zone de route de SendFPL',
	sendFplFailed: 'Transmission de la route impossible.',
	sendFplPlan: 'Envoyer tout le plan vers SendFPL',
	sendFplPlanCopy: 'Copier tout le plan pour SendFPL',
	sendFplPlanCopyTip:
		'Copier toutes les étapes enchaînées en une seule route, dégagements exclus, prête à coller dans la zone de route de SendFPL',
	sendFplPlanTip:
		'Ouvrir SendFPL avec toutes les étapes enchaînées en une seule route, dégagements exclus, pour la charger dans le GPS',
	sendFplTip: 'Ouvrir SendFPL avec la route active, pour la charger dans le GPS',
	sizing: 'Dimensionnement…',
	skippedMore: (n: number) => `et ${n} ${n > 1 ? 'autres' : 'autre'}`,
	skippedUnresolved: (list: string) => `Ignorés (non résolus)\u202f: ${list}.`,
	sliderAltBottomAria: 'Bas de la fenêtre d’altitude (ft)',
	sliderAltTopAria: 'Haut de la fenêtre d’altitude (ft)',
	sliderDistEndAria: 'Fin de la fenêtre de distance (NM)',
	sliderDistStartAria: 'Début de la fenêtre de distance (NM)',
	sofiaCorridor: (p: { nm: number }) =>
		`SOFIA-Briefing balaie ${p.nm} NM de chaque côté de la route.`,
	sofiaFetchTip: 'Récupérer les NOTAM de route directement depuis SOFIA-Briefing, le service du SIA français (sans compte)',
	sofiaFetchedAt: (p: { n: number; time: string }) =>
		`${p.n} NOTAM ${plural(p.n, 'récupéré', 'récupérés')} depuis SOFIA à ${p.time}.`,
	sourceAria: 'Source des NOTAM',
	stopFetch: 'Arrêter',
	stopFetchTip: 'Arrêter le briefing\u202f; les routes déjà récupérées sont conservées',
	sourceAutorouter: 'autorouter',
	sourceAutorouterHint: 'Eurocontrol EAD',
	sourceSofia: 'SOFIA',
	sourceSofiaHint: 'SIA français (DSNA)',
	suggestionApplyAria: (p: { level: string; min: number }) =>
		`Régler le segment ${auNiveau(p.level)}, gain de ${p.min} minutes`,
	suggestionTip: (p: { bestEte: number; bestLevel: string; curEte: number; curLevel: string }) =>
		`Niveau le plus rapide pour ce segment selon le vent prévu, temps de croisière seul (montée non comptée)\u202f: ETE ${p.bestEte} min ${auNiveau(p.bestLevel)} au lieu de ${p.curEte} min ${auNiveau(p.curLevel)}.\nCliquer pour appliquer (le segment garde ensuite ce niveau jusqu’à réinitialisation).`,
	summaryCruise: (p: { dur: string; kt: number }) => `${p.dur} à ${p.kt} kt`,
	summaryTotal: (nm: string) => `Total ${nm} NM`,
	switchRoute: 'Changer de route',
	taTipAip: (ident: string) =>
		`Automatique\u202f: la plus basse altitude de transition AIP parmi les aérodromes de la route (${ident}).`,
	taTipBase:
		'Altitude de transition (ft), les altitudes de segment au-dessus s’affichent et se saisissent en niveaux de vol.',
	taTipBlanket: (region: string) => `Automatique\u202f: altitude de transition générale ${region}.`,
	taTipDefault:
		'Automatique\u202f: 5000 ft par défaut (aucune altitude de transition d’aérodrome sur les routes).',
	taTipManual: 'Réglage manuel, vider le champ pour utiliser la valeur AIP.',
	tabTip: 'Double-clic pour renommer, glisser pour réordonner, clic molette pour fermer',
	tempTas: 'TAS corrigée par la température',
	tempTasTip:
		'Corrige la TAS de croisière selon la température prévue au niveau de chaque segment (environ 2 % par 10 °C d’écart à l’ISA). Désactivé, la vitesse de croisière saisie s’applique à chaque segment.',
	terrainLoading: 'Chargement du relief…',
	terrainTint: 'Proximité du relief',
	terrainTintTip: 'Relief en rouge quand la hauteur de survol est inférieure à 500 ft AGL',
	terrainUnavailable: 'Relief indisponible',
	traceGestureHint: 'Pincer pour zoomer · glisser à deux doigts pour déplacer',
	transition: 'Transition',
	twoWaypointsHint: 'Ajoutez au moins deux points.',
	undo: 'Annuler',
	undoTip: 'Annuler (Ctrl+Z)',
	unknownAircraft: (key: string) =>
		`L’aéronef ${key} n’est pas dans votre flotte\u202f; importez-le dans l’onglet Aéronefs.`,
	verticalProfile: 'Profil vertical',
	vfrTip:
		'Règles de vol VFR/IFR. Pilote aussi le filtre Règles de vol des NOTAM (VFR masque les NOTAM uniquement IFR, IFR masque les NOTAM uniquement VFR)\u202f; modifiable dans les filtres de l’onglet NOTAM.',
	warnNoLevelFits: 'Aucun niveau de croisière semi-circulaire ne convient à ce segment',
	warnNotSemicircular: (p: { track: string; fix: string }) =>
		`Niveau non conforme à la règle semi-circulaire pour une route magnétique de ${p.track}, cliquer pour appliquer ${p.fix}`,
	warnTransitionLayer: (p: { ta: string; tl: string }) =>
		`Dans la couche de transition, entre l’altitude de transition ${p.ta} ft et le niveau de transition ${p.tl}`,
	waypointNameAria: 'Nom du point',
	wind: 'Vent',
	windBarbs: 'Barbules',
	windBarbsTip: 'Afficher le vent de chaque segment en barbule (orientation en plan, nord en haut)',
	windChipTip: 'Cliquer pour saisir un vent manuel sur ce segment',
	windDirAria: 'Direction du vent du segment (degrés vrais)',
	windDirGlobalAria: 'Direction du vent (degrés vrais)',
	windSpeedAria: 'Vitesse du vent du segment (nœuds)',
	windSpeedGlobalAria: 'Vitesse du vent (nœuds)',
	windTip: 'Vent avec lequel la route est planifiée (° vrais, kt)',
	windTipFallback:
		'Vent de repli (° vrais, kt), utilisé seulement là où aucune prévision ne se résout et sur les segments non forcés',
	wpNumTip: 'Glisser pour réordonner, cliquer pour centrer la carte',
} satisfies Messages['route'];
