/* Miroir français de ../en/about.ts. "En vigueur" suit le vocabulaire AIRAC
 * (une publication prend effet, elle n'est pas "active"); les suppléments
 * SUP AIP sont donc aussi "en vigueur". Invariants: noms de jeux de données,
 * d'éditeurs et de produits (SIA, NATS, ENAIRE, FAA, OurAirports,
 * EUROCONTROL, pruatlas, AIXM, AIRAC), noms de licences (MIT, CC BY 4.0),
 * URL, et le texte de la licence MIT (lang="en"). */

import type { Messages } from '../en';
import { plural } from './plural';

export const about = {
	activeInDays: (days: number) =>
		`en vigueur dans ${days} ${plural(days, 'jour', 'jours')}`,
	activeNow: 'en vigueur',
	activeSoon: 'en vigueur dans moins d’un jour',
	adChartsAside: (p: { aerodromes: string }) => `${p.aerodromes} aérodromes IFR`,
	adChartsLabel: 'Liens de cartes',
	aircraftRefresh: 'manuelle\u202f; à vérifier avec le manuel de vol de l’aéronef',
	airspacesCount: (n: string) => `${n} espaces aériens`,
	authorHeading: 'Auteur',
	backToAbout: 'Retour à la page À propos',
	chartsHeading: 'Cartes aéronautiques',
	closeAbout: 'Fermer la fenêtre À propos',
	copyright: '© 2026 David du Colombier. Publié sous',
	dataLabel: 'Données',
	// Les cartes de sources se répartissent en trois sections. Un jeu de
	// données annonce un cycle et compte ses lignes ; un service en direct
	// dit ce qu'il fournit et quand il est interrogé ; un modèle embarqué
	// répond sans aucun accès au réseau.
	dataSetsHeading: 'Jeux de données',
	liveServicesHeading: 'Services en direct',
	bundledModelsHeading: 'Modèles embarqués',
	daysAgo: (days: number) => `il y a ${days} ${plural(days, 'jour', 'jours')}`,
	designatorModelsAside: (n: string) => `${n} modèles d’aéronefs`,
	designatorsLabel: 'Indicatifs',
	// Le statut de l'application, les limites de ce qu'elle calcule et le
	// devoir qui reste au pilote, dans les termes mêmes du règlement
	// (SERA.2010 b, règlement (UE) 923/2012). Remplace une phrase qui disait
	// "à des fins de conscience de la situation uniquement", laquelle
	// sous-estimait l'application et contredisait la description au-dessus.
	disclaimer1:
		'Loxodrome n’est pas un service d’information aéronautique et ne bénéficie d’aucune approbation opérationnelle ni de navigabilité. Il ',
	disclaimerStrong:
		'ne remplace ni l’AIP, ni le bulletin d’information prévol (PIB), ni la documentation météorologique',
	disclaimer2:
		' des États survolés, qui seuls font foi. Les jeux de données sont publiés par cycle AIRAC ou au rythme propre à chaque éditeur et peuvent être périmés ou incomplets, les positions des NOTAM sont lues dans du texte libre et les données de l’aéronef sont transcrites de son manuel de vol\u202f: tout résultat calculé ici, bilan carburant, masse et centrage, distances, altitudes minimales et alertes espace aérien, est une aide à vérifier sur le manuel de vol et sur les documents officiels. Avant d’entreprendre un vol, le pilote commandant de bord prend connaissance de tous les renseignements disponibles utiles au vol projeté, selon les termes du SERA.2010 b), et reste responsable de la conduite du vol.',
	disclaimerHeading: 'Responsabilité du commandant de bord',
	editionLabel: 'Édition',
	effectiveAside: (date: string) => `en vigueur le ${date}`,
	faaClass: 'Classe B / C / D / E',
	faaDesignatorsRefresh: 'manuelle, à chaque édition du document',
	fetchedLabel: 'Récupération',
	facilitiesLabel: 'Répertoire des aérodromes',
	heliportsAside: (n: string) => `${n} hélistations`,
	firsUirs: 'FIR / UIR',
	chartsAside: (n: string) => `${n} aérodromes`,
	chartPages: (n: string) => `${n} pages d’aérodrome`,
	generated: 'Généré',
	generatedToday: 'aujourd’hui',
	headAdCharts: 'France\u202f: cartes d’aérodrome de l’eAIP du SIA',
	headAircraft: 'Bibliothèque d’aéronefs (données des manuels de vol)',
	headFaa: 'FAA\u202f: Boundary / Special-Use / Class Airspace',
	headFaaDesignators: 'Indicatifs de type d’aéronef\u202f: FAA JO 7360.1',
	headFrance: 'France\u202f: SIA AIXM 4.5',
	headMetarStations: 'Stations METAR\u202f: NOAA AWC',
	headNoaa: 'Météo en direct\u202f: NOAA Aviation Weather Center',
	headOpenMeteo: 'Vents en altitude\u202f: Open-Meteo',
	headOurAirports: 'Aérodromes\u202f: OurAirports',
	headOurAirportsSuffix: '+ surcouches AIXM',
	headSofia: 'TEMSI & WINTEM\u202f: Météo-France via SOFIA-Briefing',
	headBelgium: 'Belgique et Luxembourg\u202f: skeyes eAIP',
	headAustria: 'Autriche\u202f: Austro Control KML + AIXM 5.1.1',
	headGermany: 'Allemagne\u202f: DFS AIXM 5.1.1',
	headSlovakia: 'Slovaquie\u202f: eAIP LPS SR',
	headIreland: 'Irlande\u202f: eAIP AirNav Ireland',
	headSerbiaMontenegro: 'Serbie et Monténégro\u202f: eAIP SMATSA Serbia and Montenegro',
	headKosovo: 'Kosovo\u202f: eAIP KANS Kosovo',
	headSpain: 'Espagne\u202f: ENAIRE AIXM 5.1',
	headSupAip: 'France\u202f: SIA SUP AIP',
	headUk: 'Royaume-Uni\u202f: NATS AIXM 5.1',
	headEgm96: 'Géoïde\u202f: EGM96',
	headTerrain: 'Altitude du sol\u202f: Terrain Tiles',
	headVacGeo: 'France\u202f: cartes VAC du SIA sur la carte',
	headWmm: 'Déclinaison magnétique\u202f: WMM2025',
	howToHeading: 'Comment l’utiliser',
	librariesHeading: 'Bibliothèques open source',
	mapDataHeading: 'Fond cartographique',
	licenseLabel: 'Licence',
	licenseMit: 'licence MIT',
	// Affiché à la place d'un texte de licence dont le module n'a pas pu
	// être chargé, pour que la page dise ce qui s'est passé.
	licenseTextUnavailable: 'Le texte de la licence n\u2019a pas pu être chargé.',
	licAustria: '© Austro Control GmbH, publié avec autorisation',
	licGermany: '© DFS Deutsche Flugsicherung GmbH, GeoNutzV (modifié)',
	licNoaa: 'domaine public du gouvernement des États-Unis',
	licOpenMeteo: 'données météo par',
	licSofia: 'produits aéronautiques Météo-France, via le portail de briefing de la DGAC',
	licEgm96: 'NGA / NASA, domaine public du gouvernement des États-Unis',
	licTerrain:
		'AWS Open Data, agrégeant les modèles d’altitude publics des agences nationales (SRTM, 3DEP, GMTED2010, ETOPO1, ArcticDEM, EU-DEM et autres)\u202f; attribution selon la liste de sources du jeu de données',
	licWmm: 'NOAA NCEI / BGS, domaine public du gouvernement des États-Unis',
	// Chaque licence ci-dessous a été lue à la source de l'éditeur, avec
	// l'URL et la date dans docs/aip-sources.md. Lorsqu'un éditeur
	// n'accorde rien, la ligne le dit plutôt que de laisser croire à une
	// autorisation que personne n'a donnée ; lorsqu'un éditeur interdit la
	// rediffusion, les données ne sont pas ici du tout (cmd/eaip Consent,
	// docs/eaip-states.md).
	// La carte porte elle-même la mention exigée par la Licence Ouverte :
	// elle nomme le SIA, renvoie à son site et affiche le cycle.
	licFrance: 'Licence Ouverte, avec mention du SIA et de la date de l\u2019édition',
	licPruatlas: 'GPL-2 ou MIT, © EUROCONTROL',
	licOurAirports:
		'Domaine public\u202f; OurAirports souhaite une mention sans l\u2019exiger',
	licAircraft:
		'Valeurs transcrites du manuel de vol de chaque aéronef, qui reste la propriété de son éditeur',
	licUk: '© NATS Limited\u202f; l\u2019AIS britannique n\u2019énonce aucune condition de réutilisation',
	licBelgium: 'skeyes n\u2019énonce aucune condition de réutilisation dans son eAIP',
	licSpain:
		'ENAIRE n\u2019énonce aucune condition de réutilisation avec ses jeux de données AIP',
	licSlovakia:
		'LPS SR renvoie sa politique de droits au droit slovaque et européen et n\u2019énonce aucune condition de réutilisation',
	licIreland:
		'AirNav Ireland n\u2019énonce aucune condition de réutilisation dans son AIP',
	licSerbiaMontenegro:
		'Droits réservés à SMATSA\u202f; l\u2019AIP n\u2019énonce aucune condition de réutilisation',
	licKosovo: 'KANS n\u2019énonce aucune condition de réutilisation dans son AIP',
	// Sources de récupération des NOTAM de route, citées dans les cartes Sources de données.
	headArNotam: 'NOTAM de route via EUROCONTROL EAD (autorouter)',
	arNotamData: 'NOTAM pour la vue carte ou une route planifiée, à la demande',
	licAutorouter: 'Agrégé par EUROCONTROL EAD, accessible via autorouter.aero',
	licNetherlands: 'CC BY 4.0, Air Traffic Control the Netherlands',
	licItaly:
		'OFMA General Users\u2019 License. Données maintenues par la communauté open flightmaps, non publiées par l’ENAV. Signaler une erreur sur',
	licSwitzerland:
		'Utilisation libre avec mention de la source (opendata.swiss). Obstacles uniquement\u202f: l’espace aérien suisse est vendu via skybriefing.',
	licFinland:
		'© Fintraffic ANS, libre pour le raffinage et la recherche. Obstacles uniquement\u202f: l’AIP finlandaise est publiée en PDF. Registre des obstacles tenu par Traficom.',
	licGeorgia:
		'Publié en téléchargement public libre\u202f; Sakaeronavigatsia n’énonce aucune condition de réutilisation.',
	headGeorgia: 'Jeu de données AIP géorgien (Sakaeronavigatsia)',
	headNetherlands: 'Données ouvertes LVNL (Pays-Bas)',
	headItaly: 'Italie via open flightmaps (données communautaires)',
	headSwitzerland: 'Registre suisse des obstacles (OFAC)',
	headFinland: 'Registre finlandais des obstacles (Fintraffic ANS)',
	headSofiaNotam: 'NOTAM de route du SIA français (DSNA)',
	sofiaNotamData: 'NOTAM de route pour la route planifiée, à la demande',
	licSofiaNotam: 'AIS national français (DGAC / DSNA / SIA), anonyme',
	loadingSources: 'Chargement des sources de données…',
	metaUnavailable: (err: string) =>
		`Métadonnées des sources de données indisponibles (${err}).`,
	navaidsAside: (waypoints: string) => `${waypoints} points de cheminement`,
	nextCycle: 'Cycle suivant',
	overlaysAside: (p: { count: string; publishers: string }) =>
		`+${p.count} via ${p.publishers} surcouches nationales`,
	noaaData: 'METAR, TAF et avis SIGMET (le flux OPMET mondial)',
	noaaFetched: 'en direct, par aérodrome et pour l’ensemble mondial des avis',
	noaaFetchedAside:
		'(panneau aérodrome, performances de la préparation du vol, onglet Météo\u202f; désactivé via la bascule Météo en direct)',
	obstaclesAside: (p: { lit: string; windTurbines: string }) =>
		`${p.lit} balisés, ${p.windTurbines} éoliennes`,
	omData:
		'prévisions de vent et de température par niveaux de pression (Météo-France AROME / ARPEGE, UKMO, ICON, GFS, ECMWF)',
	omFetched: 'en direct, pour la vue de la carte et les segments de la route',
	omFetchedAside: '(onglet Météo\u202f; désactivé via la bascule Météo en direct)',
	privacyAutorouter:
		'à la demande, la récupération autorouter envoie une requête de route ou de vue de la carte, via le relais ci-dessous, au service public',
	privacyHeading: 'Confidentialité',
	privacyIntro:
		'Il n’y a ni compte, ni traçage, ni publicité, et l’application ne dépose aucun cookie qui lui soit propre. Le briefing que vous collez ou ouvrez est analysé dans votre navigateur et n’est jamais téléversé. L’application effectue en revanche les requêtes réseau ci-dessous\u202f: les deux premières d’elles-mêmes pendant que vous utilisez la carte, les autres uniquement lorsque vous les demandez.',
	// Ce qui ne quitte jamais l'appareil, dit avant la liste de ce qui part.
	// docs/android.md renvoie la fiche Play vers cette section comme
	// politique de confidentialité : une autorisation de localisation
	// qu'elle ne mentionne pas y serait un manque.
	privacyPosition:
		'Votre position est lue sur le GPS de l’appareil, dessinée sur la carte et écrite dans la trace\u202f; elle n’est jamais transmise. Sous Android, l’enregistrement se poursuit dans un service de premier plan, avec la notification qui l’accompagne, écran éteint si besoin\u202f; l’application déclare les autorisations d’accès à internet, de localisation, de service de premier plan, de notification et de maintien en éveil, et aucune autre. Les requêtes ci-dessous portent des coordonnées de carte, de route ou d’aérodrome, pas votre point GPS, mais tant que la carte suit l’aéronef elles disent bien où vous êtes.',
	privacyStored:
		'Ce que vous construisez reste dans ce navigateur\u202f: les routes, les aéronefs, les préférences, et la bibliothèque des vols avec ses traces. L’onglet Réglages les efface par groupe avec "Réinitialiser l’application…"\u202f; les paquets de cartes téléchargés et les tuiles en cache y survivent à dessein, chaque paquet ayant sa propre suppression dans l’onglet Couches.',
	privacyTiles:
		'les tuiles de la carte, récupérées tant que la carte est affichée\u202f: les fonds de carte directement chez leurs fournisseurs, les cartes aéronautiques et leurs paquets hors ligne depuis le relais de cartes ci-dessous, sauf la carte OACI suisse, qui vient directement du WMTS fédéral suisse',
	privacyTerrain:
		'les tuiles d’altitude du sol, récupérées dès qu’un profil de route, un couloir d’altitude minimale ou une alerte d’espace aérien a besoin de la hauteur du terrain sous un point, et par couloir entier lorsque vous épinglez le terrain d’un plan pour l’usage hors ligne, via le relais ci-dessous\u202f; aucune préférence ne les désactive',
	privacyProxy:
		'Deux Workers Cloudflare exploités par l’auteur se placent devant ces services, aucun d’eux n’envoyant les en-têtes CORS dont un navigateur a besoin pour lire la réponse\u202f: notam-proxy.alcyon.workers.dev relaie les requêtes NOTAM, météo et terrain, et oaci-tiles.alcyon.workers.dev sert les tuiles de cartes et les paquets hors ligne. Chacun voit ce que le service verrait lui-même, la requête de route, les indicateurs d’aérodrome ou les coordonnées des tuiles, ainsi que votre adresse IP. Ils appliquent une limitation de débit par adresse IP et mettent brièvement les réponses en cache\u202f; leurs journaux ne consignent que la route, le code de statut et le texte d’erreur amont d’une requête en échec, jamais le corps de la requête ni l’adresse dont elle provient. Aucun compte ni identifiant n’y est associé.',
	// Le chargement de la page lui-meme, absent de la liste ci-dessus :
	// sur le web c'est une requete a l'hebergeur comme une autre, et dans
	// la coque Android il n'y a pas de requete du tout.
	privacyHosting:
		'L’application elle-même est servie en fichiers statiques par GitHub Pages, qui voit la requête de page comme n’importe quel hébergeur\u202f; l’application Android emporte ses fichiers avec elle et n’en demande aucun.',
	// La seconde source de NOTAM de route, à côté d'autorouter. Elle
	// envoie la route planifiée à l'AIS français par le même relais, d'où
	// sa propre ligne plutôt qu'une incise sur celle d'autorouter.
	privacySofiaNotam:
		'à la demande, le briefing de route SOFIA envoie la route planifiée, via le relais ci-dessous, à l’AIS français',
	privacySofia:
		'ouvrir la section TEMSI & WINTEM de l’onglet Météo demande son catalogue de cartes au service français SOFIA-Briefing, via le relais ci-dessous, et imprimer l’annexe météo tire les PDF des cartes par le même relais',
	privacyToggleOff:
		'La bascule "Météo en direct" de l’onglet Réglages arrête les requêtes météo, c’est-à-dire les METAR et TAF, les avis SIGMET, les vents en altitude et le catalogue TEMSI / WINTEM. Elle n’affecte ni les tuiles de la carte ni le terrain, dont la carte et le profil de route ont besoin pour fonctionner.',
	privacyWeather:
		'ouvrir un panneau d’aérodrome ou la page de performances de la préparation du vol avec la météo en direct activée demande au NOAA Aviation Weather Center, via le relais ci-dessous, les METAR et TAF de cet aérodrome\u202f; l’onglet Météo demande au même service l’ensemble mondial des avis SIGMET, sans envoi de position, et, dès que vous activez la couche des stations, les observations de la vue de la carte',
	privacyWindsAloft:
		'activer les vents en altitude (onglet Météo) envoie les coordonnées de la vue de la carte et des segments de la route directement depuis votre navigateur, sans passer par le relais, à',
	refresh: 'Actualisation',
	refreshManual: 'manuelle',
	refreshMonthly: 'mensuelle (le 1er)',
	refreshWeekly: 'hebdomadaire (le jeudi)',
	reportIssue: 'Signaler un problème',
	// Les trois choses que la liste des onglets ne peut pas dire, parce
	// qu'elles n'appartiennent à aucun onglet : les conditions de lecture de
	// la carte, la requête "qu'y a-t-il ici ?" de la carte elle-même, et les
	// deux touches qui marchent partout.
	conditionsHint:
		'La période et la bande de niveaux, dans la barre d’outils, sont les conditions de lecture de toute la carte\u202f: NOTAM, espaces aériens, zones SUP AIP et SIGMET à la fois.',
	rightClickHint:
		'Un clic droit n’importe où sur la carte donne tout ce qui se trouve sous le curseur\u202f: NOTAM, espaces aériens, zones SUP AIP, SIGMET, aérodromes, aides de radionavigation, obstacles et stations METAR, ainsi que le profil d’altitude en ce point.',
	searchHint:
		'Ctrl+K recherche les aérodromes, les aides de radionavigation, les points de cheminement et les NOTAM depuis n’importe où, ainsi que les actions elles-mêmes\u202f; la touche\u202f? liste tous les raccourcis et gestes.',
	runwaysAside: (n: string) => `${n} pistes`,
	sofiaData: 'cartes PDF du temps significatif et des vents/températures',
	sofiaFetched: 'catalogue à la demande',
	sofiaFetchedAside:
		'(onglet Météo\u202f; les PDF se téléchargent directement depuis aviation.meteo.fr, et le dossier de vol imprimé les relaie via le proxy au moment de l’impression, sans aucun cache)',
	sourceLabel: 'Source\u202f:',
	stationCatalogLabel: 'Catalogue des stations',
	stationsAside: (p: { taf: string; countries: string }) =>
		`${p.taf} avec TAF, ${p.countries} pays`,
	stationsCount: (n: string) => `${n} stations`,
	supAside: (p: { active: string; withGeometry: string }) =>
		`${p.active} en vigueur, ${p.withGeometry} avec géométrie`,
	supplementsLabel: 'Suppléments',
	// Une ligne par onglet du rail, dans son ordre, qui dit OU se trouve
	// chaque chose. Ce que fait l'application, c'est le bloc does* ci-dessus ;
	// ces lignes sont la visite guidee, donc une proposition chacune.
	tabNotamsDesc1: '\u202f: chargez un briefing, collé, depuis un fichier ',
	tabNotamsDesc2:
		' ou récupéré pour la vue de la carte ou la route, puis lisez-le, filtrez-le et imprimez-le.',
	tabAirportsDesc:
		'\u202f: recherchez un aérodrome par indicateur, nom ou ville, et ouvrez sa fiche AIP, ses cartes et sa météo.',
	tabRouteDesc:
		'\u202f: construisez les routes, réglez leurs niveaux de croisière, et ouvrez le log de navigation, le profil vertical et la préparation du vol.',
	tabAircraftDesc:
		'\u202f: choisissez l’aéronef avec lequel la préparation calcule\u202f; modifiez sa fiche ou ajoutez la vôtre.',
	tabWeatherDesc:
		'\u202f: METAR, TAF et SIGMET, les vents en altitude, et les cartes TEMSI et WINTEM.',
	tabNavigationDesc:
		'\u202f: enregistrez le vol, rejouez-le, réglez les alertes espace aérien, et importez ou exportez la trace.',
	tabLayersDesc:
		'\u202f: le fond de carte, les cartes aéronautiques, toutes les surcouches et les éditeurs qui les publient.',
	tabSettingsDesc:
		'\u202f: marqueurs NOTAM, langues des contenus, données en direct, position, apparence, et la réinitialisation.',
	// L'application en trois phrases : ce qu'elle est, ce qu'elle fait,
	// comment elle tourne. Elle porte le nom de la route qui coupe tous les
	// meridiens sous un angle constant (docs/brand.md), pas celui du briefing
	// NOTAM dont elle est issue, lequel est l'une des quatre choses
	// ci-dessous et non le cadre du reste.
	tagline:
		'Loxodrome est une application de préparation du vol et de navigation pour l’aviation générale, bâtie sur les AIP nationales d’Europe et des États-Unis. Elle les dessine en carte aéronautique, prépare le vol jusqu’au bilan carburant, à la masse et centrage et aux distances de décollage et d’atterrissage, le briefe, puis le suit en vol. Libre et open source, elle s’exécute entièrement dans votre navigateur, s’installe sur l’appareil pour un usage hors ligne et ne demande aucun compte.',
	// Les quatre phases du vol qu'elle sert, chacune nommant ce qu'elle
	// porte vraiment. C'est la description ; la liste des onglets est la
	// visite guidee.
	vacGeoAside: (p: { aerodromes: string }) => `${p.aerodromes} aérodromes`,
	vacGeoLabel: 'Panneaux positionnés',
	whatItDoesHeading: 'Ce qu’elle fait',
	doesChartLabel: 'Carte et AIP',
	doesChart:
		'\u202f: les espaces aériens, aérodromes, aides de radionavigation, obstacles, sites protégés et suppléments d’AIP publiés par chaque éditeur, dessinés selon les conventions cartographiques de l’OACI et du SIA et datés du cycle annoncé par chaque éditeur, sur un fond mondial d’aérodromes\u202f; les cartes VFR officielles s’empilent par-dessus, et un aérodrome ouvre ce que son AIP publie\u202f: pistes, fréquences, fiche de répertoire et cartes.',
	doesPrepLabel: 'Préparation du vol',
	doesPrep:
		'\u202f: les routes et leurs dégagements, les niveaux de croisière réglés sur le terrain et l’altitude de transition, les vents prévus segment par segment, le log de navigation et le profil vertical\u202f; puis le bilan carburant, la masse et centrage et les distances de décollage et d’atterrissage, calculés d’après les données du manuel de vol de l’aéronef et imprimés en dossier de vol ou en cartes de planchette A5.',
	doesBriefingLabel: 'Briefing',
	doesBriefing:
		'\u202f: les NOTAM, collés ou récupérés pour la vue de la carte ou le couloir de la route, liés dans les deux sens aux aérodromes, espaces aériens, aides de radionavigation et obstacles qu’ils concernent et hachurant les zones qu’ils activent\u202f; les METAR, TAF et SIGMET\u202f; les vents et températures en altitude\u202f; les cartes TEMSI et WINTEM.',
	doesFlightLabel: 'En vol',
	doesFlight:
		'\u202f: la carte suit le GPS, le log de navigation note les heures de passage réelles, la chaîne de contact donne la fréquence en vigueur, et les alertes espace aérien préviennent selon l’action que chaque zone impose\u202f; ensuite le rejeu, la trace en GPX, IGC ou KML, et la bibliothèque des vols.',
	terrainFetched:
		'à la demande, via le relais notam-proxy (le dépôt de tuiles n’envoie pas d’en-tête CORS)\u202f; mises en cache hors ligne, et non concernées par la bascule Météo en direct',
	terrainData:
		'altitude du sol échantillonnée sur des tuiles terrain-RGB (profil du sol de la route, altitudes minimales de sécurité, hauteur au-dessus du sol pour les alertes d’espace aérien et le dossier imprimé)',
	egm96Data:
		'ondulation du géoïde EGM96 sur une grille au degré, embarquée (la séparation qui ramène une altitude GNSS au niveau moyen de la mer)',
	wmmData:
		'coefficients du World Magnetic Model 2025, embarqués (routes et caps magnétiques du log de navigation)\u202f; valides de 2025.0 à 2030.0',
	wmmExpired:
		'Validité du modèle échue le 31 décembre 2029\u202f; les caps utilisent la déclinaison figée à 2030.0 en attendant les coefficients WMM2030.',
	wmmExpiredLabel: 'Validité',
} satisfies Messages['about'];
