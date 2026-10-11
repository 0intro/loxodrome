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
	vacAtlasLabel: 'Atlas VAC',
	vacAtlasLine: (p: { aerodromes: string; heliports: string }) => `${p.aerodromes} aérodromes, ${p.heliports} hélistations`,
	offlineLabel: 'Hors ligne',
	vacOfflinePack:
		'l’atlas du cycle en vigueur et du suivant, en paquet de documents dans l’application Android',
	supOfflinePacks:
		'les suppléments en vigueur, en français et en anglais, en paquets de documents dans l’application Android',
	aircraftRefresh: 'manuelle, à vérifier avec le manuel de vol de l’aéronef',
	airspacesCount: (n: string) => `${n} espaces aériens`,
	authorHeading: 'Auteur',
	backToAbout: 'Retour à la page À propos',
	chartsHeading: 'Couches de cartes aéronautiques',
	chartEditionYear: (year: string) => `édition ${year}`,
	chartEditionUpdated: (date: string) => `mise à jour du ${date}`,
	chartEditionExcept: (p: { regions: string; edition: string }) => `${p.regions}\u202f: ${p.edition}`,
	siaSymbolsLabel: 'Symboles et pictogrammes d’activité du SIA',
	siaSymbolsEdition: 'légende du 1:500 000 (Légende 2026) et carte au 1:250 000, éditions 2026',
	closeAbout: 'Fermer la fenêtre À propos',
	copyright: '© 2026 David du Colombier. Publié sous',
	dataLabel: 'Données',
	// Les sections de crédits, une par TYPE de données, dans l'ordre où la
	// fenêtre les affiche : c'est ce qu'une source EST qui la classe, non
	// son éditeur ni son mode de livraison. Le mode de livraison est une
	// ligne de la carte elle-même (Récupération / Actualisation), et les
	// requêtes qui quittent l'appareil relèvent de la section Confidentialité.
	aipHeading: 'Information aéronautique (AIP)',
	adChartsHeading: 'Cartes d’aérodrome',
	notamHeading: 'NOTAM',
	weatherHeading: 'Météo',
	aircraftHeading: 'Aéronefs',
	terrainHeading: 'Terrain et altitudes',
	magneticHeading: 'Modèle magnétique',
	daysAgo: (days: number) => `il y a ${days} ${plural(days, 'jour', 'jours')}`,
	designatorModelsAside: (n: string) => `${n} modèles d’aéronefs`,
	designatorsLabel: 'Indicatifs',
	// Le statut de l'application, les limites de ce qu'elle calcule et le
	// devoir qui reste au pilote. La citation est le SERA.2010 b) mot pour
	// mot, la dernière proposition celle du SERA.2010 a) (règlement (UE)
	// 923/2012, texte consolidé EUR-Lex du 1er mai 2025).
	disclaimer1:
		'Loxodrome est une application indépendante, non un service d’information aéronautique, et ne bénéficie d’aucune approbation opérationnelle ni de navigabilité. Elle ',
	disclaimerStrong:
		'ne remplace ni l’AIP, ni le bulletin d’information prévol (PIB), ni la documentation météorologique',
	disclaimer2:
		' des États survolés, qui seuls font foi. Ses données peuvent être périmées ou incomplètes. Ce qu’un NOTAM concerne est lu dans son texte et peut être mal interprété. Les données de l’aéronef sont transcrites des manuels de vol ou saisies par vous. Vérifiez chaque résultat sur le manuel de vol et les documents officiels. Les alertes relief et obstacles sont une aide, et non un TAWS certifié. Selon le SERA.2010, avant d’entreprendre un vol, le pilote commandant de bord "prend connaissance de tous les renseignements disponibles utiles au vol projeté", et il est responsable de la conduite de l’aéronef.',
	disclaimerHeading: 'Responsabilité du commandant de bord',
	editionLabel: 'Édition',
	effectiveAside: (date: string) => `en vigueur le ${date}`,
	faaClass: 'Classe B / C / D / E',
	faaDesignatorsRefresh: 'manuelle, à chaque édition du document',
	fetchedLabel: 'Récupération',
	facilitiesLabel: 'Répertoire des aérodromes',
	heliportsAside: (n: string) => `${n} hélistations`,
	fuelLabel: 'Rubriques carburant',
	fuelAside: (n: string) => `${n} avec carburants identifiés`,
	fuelAipCycle: (date: string) => `AIP ${date}`,
	firsUirs: 'FIR / UIR',
	chartsAside: (n: string) => `${n} aérodromes`,
	chartPages: (n: string) => `${n} pages d’aérodrome`,
	generated: 'Généré',
	generatedToday: 'aujourd’hui',
	headAdCharts: 'France\u202f: cartes d’aérodrome de l’eAIP du SIA',
	// Une carte par éditeur qui indexe ses propres cartes d'aérodrome, toutes
	// dans la section Cartes d'aérodrome : un index de cartes reste une donnée
	// cartographique quel que soit son éditeur, il ne figure donc pas sur la
	// carte AIP de celui-ci.
	headAtAdCharts: 'Autriche\u202f: cartes d’aérodrome Austro Control',
	headBeAdCharts: 'Belgique et Luxembourg\u202f: cartes d’aérodrome skeyes',
	headEaipAdCharts: 'Europe : cartes d’aérodrome des AIP nationales',
	eaipChartsLine: (p: { publisher: string; charts: string; nCharts: number; aerodromes: string; nAerodromes: number; vac: string }) =>
		`${p.publisher}\u202f: ${p.charts} ${p.nCharts > 1 ? 'cartes' : 'carte'}, ${p.aerodromes} ${p.nAerodromes > 1 ? 'aérodromes' : 'aérodrome'}, ${p.vac} avec une VAC`,
	licEaipAdCharts:
		'Liens vers les fichiers de cartes de chaque éditeur. Rien n’est copié.',
	headDeAdCharts: 'Allemagne\u202f: cartes d’aérodrome DFS',
	headUkAdCharts: 'Royaume-Uni\u202f: cartes d’aérodrome NATS',
	headUsAdCharts: 'États-Unis\u202f: cartes d’aérodrome FAA',
	headAircraft: 'Bibliothèque d’aéronefs',
	headFaa: 'États-Unis\u202f: FAA AIS',
	headFaaDesignators: 'Indicatifs de type d’aéronef\u202f: FAA JO 7360.1',
	headFrance: 'France\u202f: SIA AIXM 4.5',
	headFuel: 'France\u202f: carburant des aérodromes du SIA',
	headMetarStations: 'Stations METAR\u202f: NOAA AWC',
	headNoaa: 'Météo en direct\u202f: NOAA Aviation Weather Center',
	headMeteoFrance: 'Modèles de prévision\u202f: AROME, AROME-OM et ARPEGE de Météo-France',
	headEcmwf: 'Modèle de prévision\u202f: IFS du CEPMMT (ECMWF)',
	headOpenMeteo: 'Modèles de prévision\u202f: Open-Meteo',
	headOpera: 'Radar de précipitations\u202f: EUMETNET OPERA',
	headDwdFronts: 'Cartes des fronts\u202f: Deutscher Wetterdienst (DWD)',
	headOurAirports: 'Aérodromes\u202f: OurAirports',
	headOurAirportsSuffix: '+ surcouches AIXM',
	headSofia: 'TEMSI & WINTEM\u202f: Météo-France via SOFIA-Briefing',
	headBelgium: 'Belgique et Luxembourg\u202f: skeyes eAIP',
	headAustria: 'Autriche\u202f: Austro Control KML + AIXM 5.1.1',
	headGermany: 'Allemagne\u202f: DFS AIXM 5.1.1',
	headSlovakia: 'Slovaquie\u202f: eAIP LPS SR',
	headIreland: 'Irlande\u202f: eAIP AirNav Ireland et registres des obstacles de l\u2019IAA',
	headSerbiaMontenegro: 'Serbie et Monténégro\u202f: eAIP SMATSA',
	headKosovo: 'Kosovo\u202f: eAIP KANS',
	headIceland: 'Islande\u202f: eAIP Avians',
	headSpain: 'Espagne\u202f: ENAIRE AIXM 5.1',
	headSupAip: 'France\u202f: SIA SUP AIP',
	headUk: 'Royaume-Uni\u202f: NATS AIXM 5.1',
	headEgm96: 'Géoïde\u202f: EGM96',
	headTerrain: 'Altitude du sol\u202f: une mosaïque constituée pour Loxodrome',
	headVacGeo: 'France\u202f: cartes VAC du SIA sur la carte',
	headWmm: 'Déclinaison magnétique\u202f: WMM2025',
	howToHeading: 'Comment l’utiliser',
	librariesHeading: 'Bibliothèques open source',
	mapDataHeading: 'Fonds de carte',
	basemapOfflineCopy: (date: string) => `copie hors ligne, édition IGN du ${date}`,
	licenseLabel: 'Licence',
	licenseMit: 'licence MIT',
	// Affiché à la place d'un texte de licence dont le module n'a pas pu
	// être chargé, pour que la page dise ce qui s'est passé.
	licenseTextUnavailable: 'Le texte de la licence n\u2019a pas pu être chargé.',
	licAustria: '© Austro Control GmbH, publié avec autorisation',
	licGermany: '© DFS Deutsche Flugsicherung GmbH, GeoNutzV (modifié)',
	licNoaa: 'domaine public du gouvernement des États-Unis',
	licOpenMeteo: ', données météo par',
	licOpenMeteoAfter: '. Modifiées ici\u202f: interpolées entre les niveaux de pression et le long de la route.',
	// Ce que la Licence Ouverte demande au réutilisateur d’indiquer : la
	// source, au moins le nom du concédant, et la date de dernière mise à
	// jour, qui pour une prévision est son réseau. Coupée autour des liens.
	licMeteoFrance: ', Météo-France, données originales issues de ses paquets en données ouvertes',
	licMeteoFranceArome: 'AROME 0,025°',
	licMeteoFranceSep: ',',
	licMeteoFranceAromeOm: 'AROME-OM 0,025°',
	licMeteoFranceAnd: 'et',
	licMeteoFranceArpege: 'ARPEGE 0,1°',
	licMeteoFranceAfter:
		', mises à jour à chaque réseau, le réseau étant nommé à côté de chaque prévision. Modifiées ici\u202f: quantifiées, et interpolées dans le temps, entre les niveaux de pression et le long de la route.',
	// La mention que le CEPMMT demande à un service fondé sur ses données,
	// ses cinq parties dans son ordre (droits, source, licence, exclusion
	// de responsabilité, modifications), coupée autour des deux liens.
	licEcmwf:
		'Ce service est fondé sur des données et produits du Centre européen pour les prévisions météorologiques à moyen terme (CEPMMT, ECMWF en anglais). Source\u202f:',
	licEcmwfMid: '. Ces données du CEPMMT sont publiées sous licence Creative Commons Attribution 4.0 International (',
	licEcmwfAfter:
		'). Le CEPMMT décline toute responsabilité pour toute erreur ou omission dans les données, pour leur disponibilité, et pour toute perte ou tout dommage résultant de leur utilisation. Modifiées ici\u202f: quantifiées, interpolées dans le temps, entre les niveaux de pression et le long de la route, la nébulosité étant déduite de l’humidité relative.',
	licOpera:
		', EUMETNET, qui détient les droits des composites OPERA et les diffuse sous cette licence, comme l’indique sa',
	licOperaDoc: 'documentation Open Radar Data',
	licOperaAfter:
		'. Chaque image nomme son producteur dans ses métadonnées. Modifiés ici\u202f: réduits par le maximum à la résolution de la carte et colorés sur l’échelle de l’application.',
	licDwdFronts: ', Deutscher Wetterdienst, comme l’accordent ses',
	licDwdFrontsDoc: 'mentions légales',
	licDwdFrontsAfter:
		'. Modifiées ici\u202f: les analyses sont réduites à 3000 px de large pour l’impression.',
	licSofia: 'produits aéronautiques Météo-France, via le portail de briefing de la DGAC',
	licEgm96: 'NGA / NASA, domaine public du gouvernement des États-Unis',
	licTerrain:
		'constituée à partir de modèles altimétriques publics, chacun redistribué sous sa propre licence et crédité ci-dessous. Seuls des modèles dont les conditions permettent la rediffusion sont utilisés',
	terrainTiersLabel: 'Sources',
	terrainCreditsMissing: 'Les mentions des modèles d’élévation n’ont pas pu être chargées.',
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
		'Domaine public, OurAirports souhaitant une mention sans l’exiger',
	licAircraft:
		'Valeurs transcrites du manuel de vol de chaque aéronef de club, de ses suppléments et de sa fiche de pesée, et pour chaque type générique du seul manuel de vol de son constructeur, son exemple de pesée tenant lieu de masse à vide. Chaque source reste la propriété de son auteur',
	licUk: '© NATS Limited, pour un usage aéronautique seulement, ce qui est le cas ici',
	licBelgium: 'skeyes n\u2019énonce aucune condition de réutilisation dans son eAIP',
	licSpain:
		'ENAIRE n’énonce aucune condition de réutilisation avec ses jeux de données AIP, et l’avis légal de son site AIP réserve ses bases de données',
	licSlovakia:
		'© LPS SR, š. p. Ses conditions d\u2019utilisation autorisent l\u2019usage de toute partie de l\u2019AIP à des fins d\u2019information ou opérationnelles',
	licIreland:
		'AirNav Ireland et l\u2019Irish Aviation Authority n\u2019énoncent aucune condition de réutilisation pour l\u2019AIP ni pour les registres des obstacles',
	licSerbiaMontenegro:
		'Droits réservés à SMATSA. L’AIP n’énonce aucune condition de réutilisation',
	licKosovo: 'KANS n\u2019énonce aucune condition de réutilisation dans son AIP',
	licIceland: 'Avians réserve son AIP à un usage non commercial, et Loxodrome est non commercial',
	// Les deux services NOTAM, crédités dans la section NOTAM.
	headArNotam: 'NOTAM : EUROCONTROL EAD via autorouter',
	arNotamData: 'NOTAM pour la vue carte, une route planifiée ou un aérodrome, à la demande',
	licAutorouter: 'Agrégé par EUROCONTROL EAD, accessible via autorouter.aero',
	licNetherlands: 'CC BY 4.0, Air Traffic Control the Netherlands',
	licSweden: 'CC BY 4.0, LFV',
	licItaly:
		'OFMA General Users’ License. Données communautaires de l’association open flightmaps, non publiées par l’ENAV. Signaler une erreur sur',
	licSwitzerland:
		'Utilisation libre avec mention de la source (opendata.swiss). Obstacles uniquement\u202f: l’espace aérien suisse est vendu via skybriefing.',
	licFinland:
		'© Fintraffic ANS, libre pour le raffinage et la recherche sans redevance ni accord, les publications elles-mêmes ne pouvant être revendues. Registre des obstacles tenu par Traficom.',
	licRomania:
		'ROMATSA publie les informations de son site pour un usage général et n\u2019énonce aucune condition de réutilisation dans son AIP.',
	licGeorgia:
		'Publié en téléchargement public libre. Sakaeronavigatsia n’énonce aucune condition de réutilisation.',
	headGeorgia: 'Géorgie\u202f: jeu de données AIP de Sakaeronavigatsia',
	headNetherlands: 'Pays-Bas\u202f: données ouvertes LVNL',
	headItaly: 'Italie\u202f: open flightmaps (données communautaires)',
	headSwitzerland: 'Suisse\u202f: registre des obstacles de l’OFAC',
	headRomania: 'Roumanie\u202f: AIP et jeu de données des obstacles de ROMATSA',
	headFinland: 'Finlande\u202f: eAIP et registre des obstacles de Fintraffic ANS',
	headSweden: 'Suède\u202f: LFV Digital AIM',
	headSofiaNotam: 'NOTAM : SIA français via SOFIA-Briefing (DSNA)',
	sofiaNotamData: 'NOTAM pour la route planifiée ou un aérodrome, à la demande',
	licSofiaNotam: 'AIS national français (DGAC / DSNA / SIA), anonyme',
	loadingSources: 'Chargement des sources de données…',
	metaUnavailable: (err: string) =>
		`Métadonnées des sources de données indisponibles (${err}).`,
	navaidsAside: (waypoints: string) => `${waypoints} points de cheminement`,
	nextCycle: 'Cycle suivant',
	overlaysAside: (p: { count: string; publishers: string }) =>
		`+${p.count} via ${p.publishers} surcouches nationales`,
	noaaData: 'METAR, TAF et SIGMET',
	noaaFetched: 'en direct, via le relais',
	obstaclesAside: (p: { lit: string; windTurbines: string }) =>
		`${p.lit} balisés, ${p.windTurbines} éoliennes`,
	mfData:
		'vent, température, hauteur et nébulosité à seize niveaux de pression jusqu’à 300 hPa (douze pour AROME-OM), et en surface vent, rafales, température, et pression au niveau de la mer et à la surface. AROME à 0,025° sur la France et ses voisins jusqu’à 51 h, AROME-OM à 0,025° sur l’outre-mer jusqu’à 48 h, ARPEGE à 0,1° sur l’Europe jusqu’à 102 h.',
	mfFetched:
		'depuis le service de prévision de l’auteur, nwp.loxodrome.fr, qui lit chaque réseau dès que Météo-France le publie',
	ecmwfData:
		'vent, température, hauteur et humidité relative à huit niveaux de pression jusqu’à 300 hPa, et en surface vent, rafales, température, et pression au niveau de la mer et à la surface, sur le monde entier à 0,25° jusqu’à 15 jours',
	ecmwfFetched:
		'depuis le même service, là où les modèles de Météo-France ne vont pas\u202f: hors de leurs domaines, et au-delà de 102 h sur l’Europe ou de 48 h outre-mer',
	omData:
		'les modèles choisis dans l’onglet Météo que le service ne propose pas, UKMO, ICON, GFS, HRRR ou le meilleur modèle d’Open-Meteo, jusqu’à 500 hPa, et les modèles de Météo-France et du CEPMMT quand le service ne peut pas répondre',
	omFetched: 'en direct, directement depuis le navigateur, dans ces seuls cas',
	operaData:
		'le composite CIRRUS de réflectivité maximale des radars au sol européens (1 km, toutes les 5 min), produit par Météo-France, et le composite NIMBUS d’intensité de pluie (2 km, toutes les 15 min), produit par GeoSphere Austria',
	operaFetched:
		'en direct, via le relais, depuis le cache de 24 h d’Open Radar Data\u202f: les tuiles de la vue pour la dernière demi-heure, heure ou les deux dernières heures de la boucle',
	dwdFrontsData:
		'cartes de pression en surface avec les fronts, tracées par les prévisionnistes du DWD\u202f: l’analyse Atlantique Nord-Europe toutes les six heures, et les prévisions jusqu’à quatre jours',
	dwdFrontsFetched:
		'les analyses via le relais depuis le serveur de données ouvertes du DWD, les prévisions directement depuis www.dwd.de',
	privacyAccount:
		'Le compte facultatif synchronise vos plans de vol, vos vols avec leurs traces et les fichiers de trace importés, vos aéronefs et vos informations pilote entre vos appareils, via api.loxodrome.fr, un quatrième worker exploité par l’auteur. Les informations pilote sont un nom et les dates de validité de vos qualifications de classe SEP et MEP et de votre certificat médical. Il conserve votre adresse e-mail, un enregistrement de session par appareil, avec son nom et sa dernière activité, et vos documents, qu’il ne lit jamais. Ils sont dans le stockage européen de Cloudflare, la base de données en Europe de l’Ouest et les fichiers de trace sous juridiction UE. Cloudflare envoie les codes de connexion et vérifie, avec votre adresse IP, le défi Turnstile du formulaire, chargé depuis challenges.cloudflare.com. Une adresse qui demande un code sans jamais devenir un compte n’est conservée que sous forme de hachage.',
	privacyErase:
		'L’écran Compte, aussi à l’adresse loxodrome.fr/?account=, exporte vos données, vous déconnecte ou supprime le compte. La suppression déconnecte aussitôt tous les appareils et efface la copie serveur après un délai de grâce de 7 jours. Vos propres appareils gardent leurs copies. Un plan, un vol ou un aéronef que vous supprimez laisse une trace de suppression, conservée jusqu’à 90 jours pour que vos autres appareils en soient informés. Les données supprimées restent jusqu’à 30 jours chez Cloudflare et jusqu’à deux mois dans les sauvegardes quotidiennes de l’auteur. loxodrome.fr/account-deletion.html décrit les étapes.',
	privacyAccountLog:
		'Cloudflare consigne chaque appel à api.loxodrome.fr pendant 7 jours, où l’auteur peut le lire\u202f: l’adresse appelée, le code de statut, les en-têtes de la requête avec votre adresse IP, le jeton de session masqué, et la localisation approximative qui en est déduite. Le corps des requêtes n’est jamais consigné, ni donc vos documents ni un code de connexion. Le journal propre du service ne consigne que ses échecs et, par leur identifiant interne, les comptes qu’il efface.',
	privacyHeading: 'Confidentialité',
	privacyNotam:
		'NOTAM, quand vous les récupérez, via le relais ci-dessous\u202f: une requête de vue de la carte va à autorouter, une requête de route ou d’aérodrome au service choisi, autorouter ou SOFIA-Briefing de l’AIS français.',
	privacyIntro:
		'Loxodrome ne fait ni traçage ni publicité, ne dépose aucun cookie qui lui soit propre et ne demande aucun compte. Le briefing que vous collez ou ouvrez est lu dans le navigateur, jamais téléversé ni conservé.',
	// Ce qui ne quitte jamais l'appareil, dit avant la liste de ce qui part.
	// docs/android.md renvoie la fiche Play vers cette section comme
	// politique de confidentialité : une autorisation de localisation
	// qu'elle ne mentionne pas y serait un manque.
	privacyPosition:
		'Votre position, donnée par la localisation de l’appareil, est dessinée sur la carte et écrite dans la trace. Aucune requête ne la porte, sauf que le compte facultatif synchronise vos vols enregistrés avec leurs traces. Sous Android, l’enregistrement se poursuit écran éteint dans un service de premier plan, avec sa notification. L’application Android déclare ces autorisations Android et aucune autre\u202f: internet, localisation, service de premier plan, notifications, maintien en éveil et vibration. Les requêtes ci-dessous ne portent jamais votre point GPS, mais elles peuvent dire où vous êtes. Tant que la carte suit l’aéronef, et chaque fois qu’un vol est enregistré ou rejoué, les tuiles de relief sous l’aéronef et devant lui sont téléchargées quoi que montre la carte, chacune jusqu’à 10 km de côté. Sur le web, les fichiers de données des pays autour de lui le sont aussi.',
	privacyStored:
		'Ce que vous construisez reste sur cet appareil\u202f: les routes, les aéronefs, la préparation du vol avec vos informations pilote, les préférences, et la bibliothèque des vols avec ses traces. L’application Android les exclut des sauvegardes Google Drive. Dans l’onglet Réglages, Rétablir les réglages par défaut ne remet que les préférences, et Réinitialiser l’application… efface les données stockées par groupe. Les paquets de cartes, de fonds de carte et de documents téléchargés, le relief épinglé, et les tuiles et fichiers de données en cache survivent à une réinitialisation, chaque paquet ayant sa propre suppression dans Données hors ligne.',
	privacyTiles:
		'Tuiles de carte\u202f: le fond de carte chez son fournisseur (OpenStreetMap, OpenTopoMap, IGN, Google ou Microsoft), les couches de cartes aéronautiques depuis le serveur de cartes ci-dessous, la carte OACI suisse depuis le WMTS fédéral suisse. Les paquets hors ligne des cartes et du fond de carte Plan IGN viennent du serveur de cartes quand vous en demandez un, et l’onglet Couches et Données hors ligne lui demandent les nouvelles éditions.',
	privacyTerrain:
		'Relief\u202f: les tuiles d’altitude du serveur de cartes, pour les routes, les profils, les altitudes minimales et les alertes d’espace aérien, pour l’indication sous le pointeur immobile et pour le relief que vous épinglez hors ligne. Pendant l’enregistrement ou le rejeu d’un vol, aussi la tuile sous l’aéronef et celles devant lui et dans la vue.',
	privacyProxy:
		'Le relais (proxy.loxodrome.fr), le serveur de cartes (charts.loxodrome.fr) et le service de prévision (nwp.loxodrome.fr) sont des workers Cloudflare exploités par l’auteur. Le relais transmet la requête, jamais votre adresse. Le service de prévision lit les réseaux de Météo-France et du CEPMMT dans leurs données ouvertes, à son propre rythme, si bien qu’ils ne reçoivent rien de vous. Chacun voit ce qui lui est demandé et votre adresse IP, que le relais et le service de prévision gardent environ une minute pour limiter le débit des requêtes. Le relais garde en cache les réponses en direct d’une à cinq minutes, les fichiers publiés d’un jour à un an. Il ne consigne que ses propres échecs. Le service de prévision consigne ses échecs et les réseaux qu’il publie, jamais les points d’une requête ni votre adresse. Le serveur de cartes ne tient aucun journal.',
	// Le chargement de la page lui-meme, absent de la liste ci-dessus :
	// sur le web c'est une requete a l'hebergeur comme une autre, et dans
	// la coque Android il n'y a pas de requete du tout.
	privacyHosting:
		'Sur le web, l’application et ses fichiers de données viennent de GitHub Pages à travers Cloudflare, qui voient chaque requête. Chaque adresse de loxodrome.fr demande aux navigateurs qui mettent en œuvre la journalisation des erreurs réseau (Network Error Logging) de signaler à Cloudflare les connexions qui échouent. Un lien qui ouvre un fichier dans l’application (?file=) fait télécharger ce fichier par votre navigateur, où que pointe le lien. L’application Android emporte ses propres fichiers.',
	privacySofia:
		'TEMSI et WINTEM, de SOFIA-Briefing via le relais\u202f: la liste des cartes à l’ouverture de l’onglet Météo ou du menu d’impression, puis toutes les cinq minutes tant que l’onglet est ouvert, les PDF à l’impression. Une carte ouverte depuis l’onglet vient directement d’aviation.meteo.fr.',
	privacyFronts:
		'Cartes des fronts du DWD\u202f: les analyses via le relais, les prévisions directement depuis www.dwd.de, listées toutes les quinze minutes tant que l’onglet Météo est ouvert et récupérées à l’impression. Une carte ouverte depuis l’onglet vient directement du DWD. Aucune de ces requêtes ne porte de position.',
	privacyToggleOff:
		'La bascule Météo en direct, dans l’onglet Réglages, arrête toutes les requêtes météo ci-dessus et aucune des autres\u202f: tuiles de carte, relief, cartes VAC, NOTAM, paquets hors ligne et compte. Rétablir les réglages par défaut et une réinitialisation des réglages la rallument.',
	privacyWeather:
		'METAR, TAF et SIGMET, du NOAA Aviation Weather Center via le relais\u202f: pour les aérodromes que vous ouvrez ou prévoyez, ou les stations alentour, et pour les stations de la vue tant que leur couche est activée. Les SIGMET sont récupérés pour le monde entier, sans position.',
	privacyWindsAloft:
		'Prévisions, du service de prévision ci-dessous\u202f: vents, températures et nuages le long de chaque route de deux points ou plus, sur la vue de la carte tant que les barbules de vent sont affichées, et aux aérodromes de la page Performances. Tant qu’ils servent, le navigateur demande aussi toutes les quinze minutes quels réseaux de modèle le service détient. Il interroge Open-Meteo à la place pour un modèle, un point ou une requête que le service ne sert pas, pour un jour passé de plus d’une semaine, et pendant dix minutes après un échec du service.',
	// Les cartes de la couche VAC : la seule couche de carte lue en partie
	// par le relais NOTAM, qui nomme les aérodromes de la vue.
	privacyVac:
		'Cartes VAC, leur couche activée\u202f: chaque carte de la vue vient d’un paquet téléchargé, sinon du serveur de cartes, sinon du SIA via le relais. Ces requêtes nomment les aérodromes de la vue.',
	privacyRadar:
		'Radar de précipitations, tant qu’il est activé\u202f: le relais est interrogé sur les tuiles de la vue et récupère des images entières dans le cache de données ouvertes d’EUMETNET, qui ne sait donc jamais où vous regardez.',
	refresh: 'Actualisation',
	refreshManual: 'manuelle',
	refreshMonthly: 'mensuelle (le 1er)',
	refreshWeekly: 'hebdomadaire (le jeudi)',
	refreshFuel: 'hebdomadaire (le jeudi), manuelle pour les rubriques AIP',
	reportIssue: 'Signaler un problème',
	// Comment l'utiliser : ce qu'aucun onglet ne dit. Les conditions de
	// lecture de la carte, les portes de la barre d'outils, le menu
	// "qu'y a-t-il ici ?" de la carte, et les deux touches qui marchent
	// partout.
	conditionsHint:
		'La Période et les Niveaux de la barre d’outils fixent quand et à quels niveaux toute la carte est lue\u202f: NOTAM, espaces aériens, zones SUP AIP et SIGMET. La période fixe aussi l’heure des vents en altitude.',
	toolbarHint:
		'La barre d’outils ouvre le log de navigation, le profil vertical, la préparation du vol et la bibliothèque des vols, et son bouton Voler démarre le vol. Sur un téléphone, la barre en bas de l’écran ouvre les pages, et le menu du logo contient le reste.',
	rightClickHint:
		'Un clic droit n’importe où sur la carte, ou un appui prolongé sur un écran tactile, donne tout ce qui se trouve en ce point. Le même menu copie les coordonnées, y ouvre le profil d’altitude et modifie la route, direct compris.',
	searchHint:
		'Ctrl+K recherche les aérodromes, aides de radionavigation, points de cheminement, NOTAM et actions depuis n’importe où. La touche\u202f? liste tous les raccourcis et gestes.',
	runwaysAside: (n: string) => `${n} pistes`,
	sofiaData: 'les PDF des cartes et leur liste',
	sofiaFetched:
		'la liste tant que l’onglet Météo ou le menu d’impression est ouvert, les PDF à l’impression, via le relais',
	sourceLabel: 'Source\u202f:',
	stationCatalogLabel: 'Catalogue des stations',
	stationsAside: (p: { taf: string; countries: string }) =>
		`${p.taf} avec TAF, ${p.countries} pays`,
	stationsCount: (n: string) => `${n} stations`,
	supAside: (p: { active: string; withGeometry: string }) =>
		`${p.active} en vigueur, ${p.withGeometry} avec géométrie`,
	supplementsLabel: 'Suppléments',
	// L'application en quelques phrases : ce qu'elle est, ce qu'elle fait,
	// comment elle tourne. Elle porte le nom de la route qui coupe tous les
	// meridiens sous un angle constant (docs/brand.md), pas celui du briefing
	// NOTAM dont elle est issue, lequel est l'une des phases ci-dessous et
	// non le cadre du reste.
	tagline:
		'Loxodrome est une application de préparation du vol et de navigation en vol pour l’aviation générale. Elle dessine en carte aéronautique les données AIP nationales d’Europe et des États-Unis. Sur cette carte, elle prépare le vol, le briefe et le suit. Libre et open source, elle s’exécute dans un navigateur ou sous Android, et ne demande aucun compte.',
	// Les phases du vol qu'elle sert, puis le compte facultatif.
	vacGeoAside: (p: { aerodromes: string }) => `${p.aerodromes} aérodromes`,
	vacGeoLabel: 'Panneaux positionnés',
	whatItDoesHeading: 'Ce qu’elle fait',
	doesChartLabel: 'Carte et AIP',
	doesChart:
		'\u202f: les espaces aériens, aérodromes, aides de radionavigation, obstacles, réserves naturelles, zones de concentration d’oiseaux, sites sensibles et suppléments d’AIP, tels que chaque éditeur les publie, dessinés selon les conventions cartographiques de l’OACI et du SIA. Les cartes aéronautiques officielles s’empilent par-dessus, et les cartes VAC françaises peuvent se poser en place. Un aérodrome ouvre ses pistes, fréquences, carburants, cartes, sa météo et ses NOTAM, et montre ce que ces NOTAM ferment ou modifient. L’application Android garde les cartes, le fond de carte Plan IGN et les documents AIP pour l’usage hors ligne.',
	doesPrepLabel: 'Préparation du vol',
	doesPrep:
		'\u202f: les routes et leurs dégagements, saisies ou tracées sur la carte, avec altitudes minimales de sécurité, niveaux de croisière et vents prévus sur chaque segment, le log de navigation et le profil vertical. Le bilan carburant et ses escales d’avitaillement, la masse et centrage, et les distances de décollage et d’atterrissage jugées sur les distances déclarées de chaque QFU, d’après les valeurs du manuel de vol de l’aéronef. Tout s’imprime, de la préparation du vol et du dossier de vol au briefing météo et aux cartes de planchette A5. Les routes s’exportent en fichiers Garmin FPL, GPX, KML ou PLN, ou partent vers SendFPL.',
	doesBriefingLabel: 'Briefing',
	doesBriefing:
		'\u202f: les NOTAM, collés ou récupérés pour la vue de la carte, la route ou un aérodrome, chacun lié à ce qu’il concerne sur la carte, les zones qu’il active hachurées et ce qu’il ferme ou modifie marqué. Les METAR, TAF et SIGMET, les vents et températures en altitude, le radar de précipitations, les cartes des fronts du DWD et les cartes TEMSI et WINTEM.',
	doesAccountLabel: 'Compte facultatif',
	doesAccount:
		'\u202f: connectez-vous avec un code reçu par courriel, et vos plans de vol, vos vols, vos aéronefs et vos informations pilote vous suivent d’un appareil à l’autre, ordinateur partagé compris. Sans compte, ils ne quittent jamais l’appareil. Supprimez-le à tout moment depuis l’application.',
	doesFlightLabel: 'En vol',
	doesFlight:
		'\u202f: la carte suit l’aéronef. Le bandeau de vol donne la fréquence en vigueur, le cap à tenir et les heures à venir, et les alertes préviennent de l’espace aérien, du relief et des obstacles devant. Un direct redessine la route depuis la position présente. Le log de navigation note les heures réelles, et le décollage et l’atterrissage sont détectés. Ensuite la trace se rejoue sur la carte, s’exporte en GPX, IGC ou KML, et rejoint la bibliothèque des vols et son carnet de vol.',
	terrainFetched:
		'à la demande depuis le serveur de cartes, mises en cache pour l’usage hors ligne. Météo en direct ne les arrête pas.',
	terrainData:
		'altitude du sol, et sol le plus haut et le plus bas autour de chaque point, pour l’indication sous le curseur, les profils, les altitudes minimales de sécurité, les hauteurs sol, la coloration du relief et les alertes relief',
	egm96Data:
		'hauteur du géoïde au-dessus de l’ellipsoïde WGS 84 sur une grille au degré, embarquée. Elle convertit une hauteur GNSS en altitude au-dessus du niveau moyen de la mer.',
	wmmData:
		'coefficients du World Magnetic Model 2025, embarqués, pour toutes les routes, caps et radiales magnétiques, valides de 2025.0 à 2030.0',
	wmmExpired:
		'Le modèle a expiré fin 2029. Les caps utilisent sa déclinaison de 2030.0 en attendant les coefficients WMM2030.',
	wmmExpiredLabel: 'Validité',
} satisfies Messages['about'];
