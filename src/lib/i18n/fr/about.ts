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
	// devoir qui reste au pilote, dans les termes mêmes du règlement
	// (SERA.2010 b, règlement (UE) 923/2012). Remplace une phrase qui disait
	// "à des fins de conscience de la situation uniquement", laquelle
	// sous-estimait l'application et contredisait la description au-dessus.
	disclaimer1:
		'Loxodrome n’est pas un service d’information aéronautique et ne bénéficie d’aucune approbation opérationnelle ni de navigabilité. L’application ',
	disclaimerStrong:
		'ne remplace ni l’AIP, ni le bulletin d’information prévol (PIB), ni la documentation météorologique',
	disclaimer2:
		' des États survolés, qui seuls font foi. Les jeux de données sont publiés par cycle AIRAC ou au rythme propre à chaque éditeur et peuvent être périmés ou incomplets, les positions des NOTAM et les modifications qu’ils apportent sont lues dans du texte libre, et les données de l’aéronef sont transcrites de son manuel de vol et de sa fiche de pesée : tout résultat calculé ici, bilan carburant, masse et centrage, distances, altitudes minimales et alertes espace aérien, relief et obstacles, est une aide à vérifier sur le manuel de vol et sur les documents officiels. Les alertes relief et obstacles sont une aide à la conscience de la situation uniquement, et non un système certifié d’avertissement et d’alarme d’impact (TAWS). Avant d’entreprendre un vol, le pilote commandant de bord prend connaissance de tous les renseignements disponibles utiles au vol projeté, selon les termes du SERA.2010 b), et reste responsable de la conduite du vol.',
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
		'Liens vers les fichiers de cartes de chaque éditeur, qui restent les siens. Rien n’est copié, si bien qu’un État dont les données attendent son accord est lié tout de même.',
	headDeAdCharts: 'Allemagne\u202f: cartes d’aérodrome DFS',
	headUkAdCharts: 'Royaume-Uni\u202f: cartes d’aérodrome NATS',
	headUsAdCharts: 'États-Unis\u202f: cartes d’aérodrome FAA',
	headAircraft: 'Bibliothèque d’aéronefs (manuels de vol et fiches de pesée)',
	headFaa: 'États-Unis\u202f: FAA AIS',
	headFaaDesignators: 'Indicatifs de type d’aéronef\u202f: FAA JO 7360.1',
	headFrance: 'France\u202f: SIA AIXM 4.5',
	headFuel: 'France\u202f: carburant des aérodromes du SIA',
	headMetarStations: 'Stations METAR\u202f: NOAA AWC',
	headNoaa: 'Météo en direct\u202f: NOAA Aviation Weather Center',
	headOpenMeteo: 'Vents en altitude\u202f: Open-Meteo',
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
	headSerbiaMontenegro: 'Serbie et Monténégro\u202f: eAIP SMATSA Serbia and Montenegro',
	headKosovo: 'Kosovo\u202f: eAIP KANS Kosovo',
	headIceland: 'Islande\u202f: eAIP Avians',
	headSpain: 'Espagne\u202f: ENAIRE AIXM 5.1',
	headSupAip: 'France\u202f: SIA SUP AIP',
	headUk: 'Royaume-Uni\u202f: NATS AIXM 5.1',
	headEgm96: 'Géoïde\u202f: EGM96',
	headTerrain: 'Altitude du sol\u202f: une mosaïque constituée pour cette application',
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
	licOpera:
		', EUMETNET détenant les droits de propriété des composites OPERA et les diffusant sous cette licence, comme l’indique sa',
	licOperaDoc: 'documentation Open Radar Data',
	licOperaAfter:
		'. Chaque image porte la licence et son producteur dans ses propres métadonnées. Modifiés ici\u202f: réduits à la résolution de la carte par le maximum et colorés sur l’échelle de l’application.',
	licDwdFronts:
		', le Deutscher Wetterdienst autorisant la réutilisation de ses contenus web et de ses données ouvertes sous cette licence, comme l’indiquent ses',
	licDwdFrontsDoc: 'mentions légales',
	licDwdFrontsAfter: '. Modifiées ici\u202f: les analyses sont réduites à 3000 px de large pour l’impression.',
	licSofia: 'produits aéronautiques Météo-France, via le portail de briefing de la DGAC',
	licEgm96: 'NGA / NASA, domaine public du gouvernement des États-Unis',
	licTerrain:
		'constituée à partir de modèles altimétriques publics, chacun redistribué sous sa propre licence et intégralement crédité ci-dessous. Aucun modèle dont les conditions interdisent la rediffusion n’est utilisé',
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
		'Valeurs transcrites du manuel de vol de chaque aéronef, de ses suppléments et de sa fiche de pesée, qui restent la propriété de leurs auteurs',
	licUk: '© NATS Limited. NATS réserve ses jeux de données à un usage aéronautique, ce qui est le cas ici',
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
		'OFMA General Users\u2019 License. Données maintenues par la communauté open flightmaps, non publiées par l’ENAV. Signaler une erreur sur',
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
	noaaData: 'METAR, TAF et avis SIGMET (le flux OPMET mondial)',
	noaaFetched: 'en direct, par aérodrome ou pour les stations alentour, les stations de la vue de la carte et l’ensemble mondial des avis',
	noaaFetchedAside:
		'(panneaux d’aérodrome et de station, pages et impressions de la préparation du vol, briefing météo imprimé, couches des stations METAR et des SIGMET, onglet Météo, désactivé via la bascule Météo en direct)',
	obstaclesAside: (p: { lit: string; windTurbines: string }) =>
		`${p.lit} balisés, ${p.windTurbines} éoliennes`,
	omData:
		'prévisions aux niveaux de pression, vent, température, hauteur et nébulosité, et en surface, vent, rafales, température et pression au niveau moyen de la mer, des modèles AROME et ARPEGE (Météo-France), UKMO (Met Office), ICON (DWD), GFS et HRRR (NOAA) et ECMWF IFS, ou du meilleur modèle choisi par Open-Meteo',
	omFetched: 'en direct, pour les segments de chaque route de deux points dès qu’elle les a, et pour la vue de la carte tant que les barbules de vent sont affichées',
	omFetchedAside: '(log de navigation, bilan carburant, profil vertical et bandeau de vol, et couches de vent des onglets Météo et Couches, désactivé via la bascule Météo en direct ou, pour une route, via les Vents prévus de l’onglet Route)',
	operaData:
		'le composite CIRRUS de réflectivité maximale de plus de 160 radars au sol européens (grille de 1 km, une image toutes les 5 min), produit par Météo-France, et le composite d’intensité de pluie instantanée NIMBUS (grille de 2 km, une image toutes les 15 min), produit par GeoSphere Austria',
	operaFetched:
		'en direct depuis le cache de 24 h du service Open Radar Data, les tuiles de la vue de la carte pour la dernière demi-heure, heure ou les deux dernières heures de la boucle',
	operaFetchedAside:
		'(couche de carte et onglet Météo, désactivé via la bascule Météo en direct, information complémentaire de conscience de la situation hors du briefing réglementaire)',
	dwdFrontsData:
		'cartes de pression en surface avec les fronts tracés par les prévisionnistes du DWD\u202f: l’analyse Atlantique Nord-Europe toutes les six heures et les prévisions jusqu’à quatre jours',
	dwdFrontsFetched:
		'la liste tant que l’onglet Météo est ouvert et les cartes au moment de l’impression, les analyses depuis le serveur de données ouvertes du DWD par le relais et les prévisions directement depuis www.dwd.de',
	dwdFrontsFetchedAside:
		'(section de l’onglet Météo et annexe météo imprimée, désactivé via la bascule Météo en direct, rien n’est stocké par l’application)',
	privacyAccount:
		'Un compte, si vous en créez un, synchronise vos plans de vol, vos vols, vos avions et vos informations pilote (un nom et les dates de validité de votre qualification SEP et de votre certificat médical) entre vos appareils via api.loxodrome.fr, un troisième worker Cloudflare exploité par l’auteur. Il conserve votre adresse e-mail, des enregistrements de session par appareil (un nom d’appareil et sa dernière activité) et vos documents en contenu opaque qu’il n’analyse jamais, dans le stockage européen de Cloudflare (la base de données en Europe de l’Ouest, les fichiers de trace sous juridiction UE). Les codes de connexion arrivent à votre adresse par le service d’e-mail de Cloudflare, le formulaire de connexion charge Cloudflare Turnstile depuis challenges.cloudflare.com contre les robots, et une adresse qui demande un code sans jamais devenir un compte n’est conservée que sous forme de hachage. Tout est en libre-service derrière le bouton Compte de la barre d’outils, aussi accessible via loxodrome.fr/?account=\u202f: exporter une copie de vos données, se déconnecter, ou supprimer le compte, ce qui efface la copie serveur après un délai de grâce de 7 jours, tous les appareils étant déconnectés aussitôt. Un plan ou un vol que vous supprimez laisse une trace de suppression, conservée jusqu’à 90 jours pour que vos autres appareils en soient informés. L’historique propre de la base de données, conservé 30 jours chez Cloudflare pour une restauration à un instant donné, et les sauvegardes quotidiennes du service, conservées jusqu’à deux mois sur l’ordinateur de l’auteur, contiennent les mêmes données, si bien que les données effacées disparaissent de la dernière d’entre elles dans les deux mois. Les étapes sont aussi décrites sur loxodrome.fr/account-deletion.html. Supprimer le compte ne touche jamais les copies présentes sur vos appareils. Chaque appel à api.loxodrome.fr est conservé 7 jours dans le journal des requêtes de Cloudflare, que l’auteur peut consulter\u202f: l’adresse appelée et le code de statut de la réponse, les en-têtes de la requête, dont votre adresse IP (Cloudflare masque le jeton de session), et la localisation approximative que Cloudflare déduit de cette adresse. Le corps de la requête n’est jamais consigné, ni vos documents ni un code de connexion, et les lignes de journal propres au service ne consignent que ses échecs et, par leur identifiant interne, les comptes qu’il efface.',
	privacyAutorouter:
		'à la demande, la récupération autorouter envoie une requête de route, de vue de la carte ou d’aérodrome, via le relais ci-dessous, au service public',
	privacyHeading: 'Confidentialité',
	privacyIntro:
		'Il n’y a ni traçage ni publicité, et l’application ne dépose aucun cookie qui lui soit propre. Le briefing que vous collez ou ouvrez est analysé dans votre navigateur et n’est jamais téléversé. Le compte est entièrement facultatif et tout fonctionne sans. L’application effectue en revanche les requêtes réseau ci-dessous : les deux premières d’elles-mêmes pendant que vous utilisez la carte, les vents prévus dès qu’une route compte deux points, et les autres lorsque vous ouvrez la surface qui les montre, activez leur couche ou les demandez.',
	// Ce qui ne quitte jamais l'appareil, dit avant la liste de ce qui part.
	// docs/android.md renvoie la fiche Play vers cette section comme
	// politique de confidentialité : une autorisation de localisation
	// qu'elle ne mentionne pas y serait un manque.
	privacyPosition:
		'Votre position est donnée par la localisation de l’appareil, son GPS s’il en a un, dessinée sur la carte et écrite dans la trace. Aucune requête ne la porte, sauf qu’un compte, si vous vous y connectez, synchronise vos vols enregistrés avec leurs traces (voir plus bas). Sous Android, l’enregistrement se poursuit dans un service de premier plan, avec la notification qui l’accompagne, écran éteint si besoin. L’application déclare les autorisations d’accès à internet, de localisation, de service de premier plan, de notification, de maintien en éveil et de vibration, et aucune autre. Les requêtes ci-dessous portent des coordonnées de carte, de route, d’aérodrome ou de tuile de relief, pas votre point GPS, mais elles peuvent dire où vous êtes : tant que la carte suit l’aéronef, et chaque fois qu’un vol est enregistré ou rejoué, puisque les tuiles de relief sous l’aéronef et devant lui sont alors téléchargées, de quelques kilomètres de côté, quoi que montre la carte, et que, sur le web, les fichiers de données des pays autour de l’aéronef sont aussi chargés.',
	privacyStored:
		'Ce que vous construisez reste sur cet appareil : les routes, les aéronefs, la préparation du vol avec vos informations pilote, les préférences, et la bibliothèque des vols avec ses traces. L’onglet Réglages remet les préférences à leur valeur par défaut avec "Rétablir les réglages par défaut", sans rien effacer d’autre, et efface ce qui est stocké par groupe avec "Réinitialiser l’application…". Les paquets de cartes, de fonds de carte et de documents téléchargés, le relief épinglé pour un plan et les tuiles et fichiers de données en cache y survivent à dessein, chaque paquet ayant sa propre suppression dans le gestionnaire des données hors ligne, ouvert depuis l’onglet Couches.',
	privacyTiles:
		'les tuiles de la carte, récupérées tant que la carte est affichée : les fonds de carte directement chez leurs fournisseurs (OpenStreetMap, OpenTopoMap, IGN, Google ou Microsoft, selon celui choisi), les cartes aéronautiques depuis le serveur de cartes ci-dessous, sauf la carte OACI suisse, qui vient directement du WMTS fédéral suisse. Le paquet hors ligne d’une carte et le paquet hors ligne du fond de carte Plan IGN depuis le serveur de cartes sont téléchargés quand vous en demandez un, et ouvrir l’onglet Couches ou le gestionnaire des données hors ligne demande au serveur si un paquet a une nouvelle édition',
	privacyTerrain:
		'les tuiles d’altitude du sol, depuis le serveur de cartes ci-dessous : dès qu’une route compte deux points, pour son profil du sol, ses altitudes minimales et ses niveaux de croisière, dès qu’un profil de trace, un profil d’altitude (ouvert depuis un panneau d’espace aérien ou de NOTAM, ou depuis le menu contextuel de la carte) ou une alerte d’espace aérien a besoin de la hauteur du terrain sous et autour de votre trace ou du point, par couloir entier lorsque vous épinglez le terrain d’un plan pour l’usage hors ligne, la tuile sous le pointeur dès qu’il s’arrête sur la carte, et, pendant l’enregistrement ou le rejeu d’un vol, la tuile sous l’aéronef pour sa hauteur au-dessus du sol, les tuiles de la vue de la carte pour la couche Relief et celles de la trajectoire à venir pour les alertes relief',
	privacyProxy:
		'Deux Workers Cloudflare exploités par l’auteur répondent aux requêtes ci-dessus qui ne vont pas directement chez un fournisseur. proxy.loxodrome.fr, le relais, transmet les requêtes NOTAM, météo, radar et d’analyses du DWD ainsi que les cartes VAC, aucun de ces services n’envoyant les en-têtes CORS dont un navigateur a besoin pour lire la réponse, et charts.loxodrome.fr, le serveur de cartes, sert les tuiles de cartes, les tuiles d’altitude du sol et les paquets hors ligne que l’auteur constitue à partir des fichiers des éditeurs. Chacun voit ce qui lui est demandé, la requête de route, les indicateurs d’aérodrome ou les coordonnées des tuiles, ainsi que votre adresse IP. Le relais applique une limitation de débit par adresse IP et garde ses réponses dans le cache de Cloudflare, environ une minute pour une requête NOTAM ou météo, et d’un jour à un an pour un fichier publié, image radar, analyse du DWD ou carte VAC. Le journal du relais ne consigne que ses propres échecs, la route, le code de statut et le texte d’erreur amont d’une requête en échec ou une défaillance de son cache, jamais le corps de la requête ni l’adresse dont elle provient, et le serveur de cartes ne tient aucun journal. Aucun compte ni identifiant n’y est associé.',
	// Le chargement de la page lui-meme, absent de la liste ci-dessus :
	// sur le web c'est une requete a l'hebergeur comme une autre, et dans
	// la coque Android il n'y a pas de requete du tout.
	privacyHosting:
		'L’application elle-même est servie en fichiers statiques par GitHub Pages à travers le réseau de Cloudflare, qui voient tous deux, comme n’importe quel hébergeur, la page et les fichiers qu’elle charge : son code, et les fichiers de données que la carte lit pays par pays pour la zone affichée, celle du plan et celle de l’aéronef. Chaque adresse de loxodrome.fr, le site, le relais, le serveur de cartes et le service de compte, demande aux navigateurs qui mettent en œuvre la journalisation des erreurs réseau (Network Error Logging), dont ceux fondés sur Chromium, de signaler à Cloudflare une connexion qui échoue. Un lien qui ouvre un fichier dans l’application (?file=) fait télécharger ce fichier par votre navigateur, où que pointe le lien. L’application Android emporte ses fichiers avec elle et n’en demande aucun.',
	// La seconde source de NOTAM de route, à côté d'autorouter. Elle
	// envoie la route planifiée à l'AIS français par le même relais, d'où
	// sa propre ligne plutôt qu'une incise sur celle d'autorouter.
	privacySofiaNotam:
		'à la demande, le briefing SOFIA envoie la route planifiée, ou l’aérodrome dont un panneau d’aérodrome demande les NOTAM, via le relais ci-dessous, à l’AIS français',
	privacySofia:
		'ouvrir l’onglet Météo ou le menu d’impression de la préparation du vol demande au service français SOFIA-Briefing, via le relais ci-dessous, son catalogue TEMSI et WINTEM, puis de nouveau toutes les cinq minutes tant que l’onglet reste ouvert, et imprimer l’annexe météo le redemande et tire les PDF des cartes par le même relais. Une carte ouverte depuis l’onglet vient directement d’aviation.meteo.fr, chez Météo-France',
	privacyFronts:
		'ouvrir l’onglet Météo demande au relais ci-dessous quelles analyses de surface du DWD sont publiées, et demande à www.dwd.de, directement depuis votre navigateur et sans passer par le relais, quelles cartes prévues le sont, puis de nouveau toutes les quinze minutes tant que l’onglet reste ouvert. Imprimer l’annexe météo récupère l’analyse par le relais, qui la lit sur le serveur de données ouvertes du DWD, et les cartes prévues directement à www.dwd.de. Aucune de ces requêtes n’envoie de position',
	privacyToggleOff:
		'La bascule "Météo en direct" de l’onglet Réglages arrête les requêtes météo, c’est-à-dire les METAR et TAF, les avis SIGMET, les vents en altitude, le radar de précipitations, les cartes des fronts du DWD et le catalogue TEMSI / WINTEM. Elle n’arrête pas les requêtes qui ne sont pas météo, les tuiles de la carte, le terrain, les cartes VAC, les NOTAM, les paquets hors ligne et le compte, et "Rétablir les réglages par défaut" ou une réinitialisation des réglages la rallume.',
	privacyWeather:
		'avec la météo en direct activée, le panneau d’un aérodrome demande au NOAA Aviation Weather Center, via le relais ci-dessous, ses METAR et TAF, ou ceux des stations alentour s’il n’en a pas. Les pages de la préparation du vol, leurs impressions et le briefing météo imprimé interrogent le même service sur les aérodromes du vol et les stations alentour, la couche des stations, une fois activée, sur les observations de la vue de la carte, et l’onglet Météo, la couche SIGMET et un panneau SIGMET sur l’ensemble mondial des avis SIGMET, sans envoi de position',
	privacyWindsAloft:
		'les vents, températures et nuages prévus, avec la météo en direct activée, depuis Open-Meteo, demandés directement depuis votre navigateur, sans passer par le relais : pour les segments de chaque route de deux points dès qu’elle les a, les Vents prévus de l’onglet Route étant activés, le long de ces segments tant que le profil vertical dessine ses nuages ou qu’un dossier s’imprime, et pour la vue de la carte tant que les barbules de vent sont affichées. Tant que l’un d’eux est utilisé, le navigateur demande aussi à Open-Meteo toutes les quinze minutes quels réseaux de modèle il détient. Les requêtes vont à api.open-meteo.com, ou à historical-forecast-api.open-meteo.com pour un jour passé de plus de 88 jours',
	// Les cartes de la couche VAC : la seule couche de carte lue en partie
	// par le relais NOTAM, qui nomme les aérodromes de la vue.
	privacyVac:
		'activer la couche des cartes VAC (France, onglet Couches) lit la carte VAC du SIA de chaque aérodrome de la vue de la carte\u202f: dans un paquet de documents téléchargé s’il y en a un, sinon par lectures partielles du paquet publié depuis le serveur de cartes ci-dessous, et à défaut carte par carte par le relais ci-dessous, qui la demande au SIA, si bien que ces requêtes nomment les aérodromes de la vue',
	privacyRadar:
		'tant que le radar de précipitations est activé (onglet Météo ou Couches), le relais ci-dessous est interrogé sur les images du composite couvrant la vue de la carte, quelques tuiles à la fois, et le relais, qui récupère chaque image une seule fois par site de Cloudflare dans le cache de données ouvertes d’EUMETNET, ne sait de ce que vous regardez que ces tuiles',
	refresh: 'Actualisation',
	refreshManual: 'manuelle',
	refreshMonthly: 'mensuelle (le 1er)',
	refreshWeekly: 'hebdomadaire (le jeudi)',
	reportIssue: 'Signaler un problème',
	// Ce que la liste des onglets ne peut pas dire, parce que cela
	// n'appartient à aucun onglet : les conditions de lecture de la carte,
	// les portes de la barre d'outils, la requête "qu'y a-t-il ici ?" de la
	// carte elle-même, et les deux touches qui marchent partout.
	conditionsHint:
		'La période et la bande de niveaux, dans la barre d’outils, sont les conditions de lecture de toute la carte : NOTAM, espaces aériens, zones SUP AIP et SIGMET à la fois. La période fixe aussi l’heure à laquelle les vents en altitude sont dessinés.',
	toolbarHint:
		'La barre d’outils ouvre ce qui n’appartient à aucun onglet, le log de navigation, le profil vertical, la préparation du vol et la bibliothèque des vols, et son bouton Voler démarre le vol. Sur un téléphone, la barre en bas de l’écran mène aux onglets sous forme de pages, et le menu derrière le logo aux réglages et au compte.',
	rightClickHint:
		'Un clic droit n’importe où sur la carte, ou un appui prolongé sur un écran tactile, donne tout ce qui se trouve sous le curseur : NOTAM, espaces aériens, zones SUP AIP, SIGMET, aérodromes, aides de radionavigation, obstacles, stations METAR, l’écho radar et les cartes d’aérodrome posées là. Le même menu copie les coordonnées, ouvre le profil d’altitude en ce point et modifie la route : ajouter, insérer ou retirer un point, activer un segment, ou faire un direct vers ce point.',
	searchHint:
		'Ctrl+K recherche les aérodromes, les aides de radionavigation, les points de cheminement et les NOTAM depuis n’importe où, ainsi que les actions elles-mêmes. La touche ? liste tous les raccourcis et gestes.',
	runwaysAside: (n: string) => `${n} pistes`,
	sofiaData: 'cartes PDF du temps significatif et des vents/températures',
	sofiaFetched: 'le catalogue tant que l’onglet Météo ou le menu d’impression est ouvert, les PDF au moment de l’impression',
	sofiaFetchedAside:
		'(onglet Météo, dossier de vol et briefing météo imprimé, désactivé via la bascule Météo en direct. Une carte ouverte depuis l’onglet se télécharge directement depuis aviation.meteo.fr, et une impression relaie les PDF par le proxy, sans aucun cache)',
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
		' ou récupéré pour la vue de la carte ou la route auprès du service choisi, puis lisez-le, filtrez-le et imprimez-le.',
	tabAirportsDesc:
		' : recherchez un aérodrome par indicateur, nom ou ville, filtrez les aérodromes français par les carburants qu’ils vendent, et ouvrez sa fiche AIP, ses cartes, sa météo et ses NOTAM.',
	tabRouteDesc:
		' : construisez les routes, saisies ou sur la carte, réglez leurs niveaux de croisière et leurs options de planification, et chargez-les, enregistrez-les, exportez-les ou envoyez-les vers SendFPL.',
	tabAircraftDesc:
		' : choisissez l’aéronef avec lequel la préparation calcule, modifiez sa fiche, ajoutez ou importez la vôtre, et exportez-la.',
	tabWeatherDesc:
		' : METAR, TAF et SIGMET, les vents en altitude, le radar de précipitations, les cartes des fronts du DWD, les cartes TEMSI et WINTEM, et le briefing météo imprimé.',
	tabNavigationDesc:
		' : enregistrez le vol, réglez les alertes espace aérien, relief et obstacles et le bandeau de vol, et importez ou exportez la trace et le carnet de vol.',
	tabLayersDesc:
		' : le fond de carte, les cartes aéronautiques, toutes les surcouches et les éditeurs qui les publient, et les données hors ligne.',
	tabSettingsDesc:
		' : marqueurs NOTAM, langues, données en direct, position, apparence, interface, et, en bas de l’onglet, le rétablissement des réglages par défaut et la réinitialisation.',
	// L'application en quelques phrases : ce qu'elle est, ce qu'elle fait,
	// comment elle tourne. Elle porte le nom de la route qui coupe tous les
	// meridiens sous un angle constant (docs/brand.md), pas celui du briefing
	// NOTAM dont elle est issue, lequel est l'une des phases ci-dessous et
	// non le cadre du reste.
	tagline:
		'Loxodrome est une application de préparation du vol et de navigation en vol pour l’aviation générale, bâtie sur les AIP nationales d’Europe et des États-Unis. Elle les dessine en carte aéronautique, prépare le vol jusqu’au bilan carburant, à la masse et centrage et aux distances de décollage et d’atterrissage, le briefe, puis le suit dans le poste de pilotage. Libre et open source, elle s’exécute entièrement sur votre appareil, dans le navigateur ou en application Android, s’installe pour un usage hors ligne et ne demande aucun compte. Un compte facultatif peut synchroniser vos plans de vol, vos vols, vos aéronefs et vos informations pilote entre vos appareils.',
	// Les phases du vol qu'elle sert, chacune nommant ce qu'elle porte
	// vraiment, puis le compte facultatif. C'est la description ; la liste
	// des onglets est la visite guidee.
	vacGeoAside: (p: { aerodromes: string }) => `${p.aerodromes} aérodromes`,
	vacGeoLabel: 'Panneaux positionnés',
	whatItDoesHeading: 'Ce qu’elle fait',
	doesChartLabel: 'Carte et AIP',
	doesChart:
		' : les espaces aériens, aérodromes, aides de radionavigation, obstacles, sites protégés et suppléments d’AIP publiés par chaque éditeur, dessinés selon les conventions cartographiques de l’OACI et du SIA et datés du cycle annoncé par chaque éditeur, sur un fond mondial d’aérodromes. Les cartes aéronautiques officielles s’empilent par-dessus, les cartes VAC françaises peuvent se poser en place sur la carte, et l’application Android garde les cartes, le fond de carte Plan IGN et les documents AIP pour l’usage hors ligne. Un aérodrome ouvre ce que son AIP publie, ses pistes, fréquences, carburants, fiche de répertoire et cartes, avec sa météo et ses NOTAM, et montre ce que ces NOTAM ferment ou modifient.',
	doesPrepLabel: 'Préparation du vol',
	doesPrep:
		' : les routes et leurs dégagements, saisies ou tracées sur la carte, les niveaux de croisière réglés sur le terrain et l’altitude de transition, les vents prévus segment par segment, le log de navigation et le profil vertical avec ses nuages, son isotherme 0 °C et ses bandes NOTAM. Puis le bilan carburant et ses escales d’avitaillement, la masse et centrage, et les distances de décollage et d’atterrissage jugées sur les distances déclarées de chaque QFU, calculés d’après le manuel de vol et la fiche de pesée de l’aéronef. Le tout s’imprime en dossier de vol avec son annexe météo ou en cartes de planchette A5, et une route s’exporte en fichier Garmin FPL, GPX, KML ou PLN, ou part vers SendFPL.',
	doesBriefingLabel: 'Briefing',
	doesBriefing:
		' : les NOTAM, collés ou récupérés pour la vue de la carte, le couloir de la route ou un aérodrome, liés dans les deux sens aux aérodromes, espaces aériens, aides de radionavigation, obstacles et suppléments d’AIP qu’ils concernent, hachurant les zones qu’ils activent et marquant les fréquences, carburants, pistes, distances déclarées et aérodromes qu’ils modifient ou ferment. Les METAR, TAF et SIGMET, les vents et températures en altitude, le radar de précipitations, les cartes des fronts du Deutscher Wetterdienst et les cartes TEMSI et WINTEM. Un briefing météo s’imprime à part.',
	doesAccountLabel: 'Compte facultatif',
	doesAccount:
		' : connectez-vous par un code reçu par courriel. Vos plans de vol, vos vols avec leurs traces, vos fiches d’aéronef et vos informations pilote vous suivent entre vos appareils et l’ordinateur du club. Entièrement facultatif : tout fonctionne sans compte, et rien de tout cela ne quitte l’appareil tant que vous ne vous connectez pas. Supprimez-le à tout moment depuis l’application.',
	doesFlightLabel: 'En vol',
	doesFlight:
		' : la carte suit le GPS, le bandeau de vol donne la fréquence en vigueur, le cap à tenir et les heures à venir, le log de navigation note les heures de passage réelles, et les alertes préviennent de l’action que chaque espace aérien impose, et du relief et des obstacles devant, le sol étant coloré selon l’altitude de l’aéronef. Un direct redessine la route depuis la position présente. Ensuite le rejeu sur la carte, la trace en GPX, IGC ou KML, et la bibliothèque des vols avec son export de carnet de vol.',
	terrainFetched:
		'à la demande, depuis le même serveur de cartes que les tuiles de cartes et les paquets hors ligne, mises en cache pour l’usage hors ligne et non concernées par la bascule Météo en direct',
	terrainData:
		'altitude du sol, ainsi que le sol le plus haut et le plus bas autour de chaque point, échantillonnés sur des tuiles d’altitude (l’indication sous le curseur, le profil du sol de la route, le profil de la trace, le sol sous un profil d’altitude, les altitudes minimales de sécurité, la hauteur au-dessus du sol pour les alertes d’espace aérien, la coloration du relief et les alertes relief en vol et en rejeu, et le dossier imprimé)',
	egm96Data:
		'ondulation du géoïde EGM96 sur une grille au degré, embarquée (la séparation qui ramène une altitude GNSS au niveau moyen de la mer)',
	wmmData:
		'coefficients du World Magnetic Model 2025, embarqués (routes et caps magnétiques de la route, du log de navigation, des niveaux de croisière et du bandeau de vol, radiales VOR et composantes de vent sur la piste), valides de 2025.0 à 2030.0',
	wmmExpired:
		'Validité du modèle échue le 31 décembre 2029. Les caps utilisent la déclinaison figée à 2030.0 en attendant les coefficients WMM2030.',
	wmmExpiredLabel: 'Validité',
} satisfies Messages['about'];
