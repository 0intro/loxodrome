/* Miroir français de ../en/display.ts. "Objet" est le mot des SUP AIP du SIA
 * pour le sujet du supplément; la ligne Q et les codes FR / EN restent
 * invariants. */

import type { Messages } from '../en';

export const display = {
	affectedAirspaces: 'Afficher les espaces concernés par le NOTAM sélectionné',
	affectedAirspacesTip:
		'Activé\u202f: quand un NOTAM sélectionné cite des espaces aériens, ils sont mis en évidence sur la carte à la place de son cercle de rayon ligne Q. Le cercle reste affichable par NOTAM depuis le panneau de détail.',
	aipRemarkLang: 'Langue des remarques AIP',
	aipRemarkLangTip:
		'Langue des remarques en texte libre de l’AIP du SIA dans les panneaux espace et obstacle, quand une remarque est publiée en anglais et en français. Auto suit la langue de l’application. Une remarque monolingue est affichée telle que publiée.',
	cursorCoords: 'Afficher les coordonnées du curseur sur la carte',
	gpsAltAuto: 'Auto',
	gpsAltDatum: 'Référence de l’altitude GPS',
	gpsAltDatumTip:
		'Ce à partir de quoi cet appareil mesure son altitude GNSS. Auto suit la plateforme\u202f: les appareils Apple fournissent une altitude au-dessus du niveau moyen de la mer, les autres une hauteur au-dessus de l’ellipsoïde WGS84, que la séparation du géoïde corrige alors (environ 150 ft sur la France). Fixez-la si l’altitude affichée ne correspond pas à l’altitude du terrain au sol.',
	gpsAltEllipsoid: 'Ellipsoïde',
	gpsAltEllipsoidTip:
		'L’appareil fournit une hauteur au-dessus de l’ellipsoïde WGS84 (valeur par défaut du W3C).',
	gpsAltMsl: 'NMM',
	gpsAltMslTip:
		'L’appareil fournit déjà une altitude au-dessus du niveau moyen de la mer (plateformes Apple).',
	hideAirportNotamMarkers: 'Masquer les marqueurs des NOTAM d’aérodrome',
	hideAirportNotamMarkersTip:
		'Activé\u202f: masque les marqueurs bleus ligne Q (de repli) des NOTAM d’aérodrome\u202f; leurs marqueurs de position rouges, cercles et zones restent, et ils demeurent accessibles via l’anneau de repérage de l’aérodrome et le panneau de détail. S’applique quand les aérodromes sont affichés (onglet Couches).',
	langAuto: 'Auto',
	liveWeather: 'Météo en direct (METAR et TAF)',
	liveWeatherTip:
		'Récupère les METAR et TAF courants (NOAA Aviation Weather Center) pour la section Météo du panneau aérodrome et les valeurs par défaut de performance de la préparation du vol. Désactivé\u202f: aucune récupération météo n’a lieu\u202f; le choix est mémorisé entre les sessions.',
	nightDim: 'Atténuation de nuit',
	nightDimTip:
		'Luminosité du fond de carte dans le thème nuit\u202f; la symbologie garde son contraste. En enregistrement, le passage du crépuscule civil bascule de lui-même en thème nuit, et l’aube ou l’arrêt de l’enregistrement le rétablit.',
	notamMarkersLegend: 'Marqueurs NOTAM',
	profileAllAirspaces: 'Les profils verticaux montrent tous les espaces',
	profileAllAirspacesTip:
		'Désactivé\u202f: ne trace que les espaces actuellement affichés sur la carte (onglet Couches)',
	qlineMarkers: 'Afficher les marqueurs de position de la ligne Q',
	qlineRadius: 'Afficher le cercle de rayon des positions ligne Q sélectionnées',
	reset: 'Réinitialiser l’application…',
	resetConfirm: 'Effacer et recharger',
	resetFinePrint:
		'Les caches hors ligne (tuiles de carte, données aéronautiques) sont conservés\u202f: les cartes déjà téléchargées survivent à la réinitialisation.',
	resetGroupAircraft: 'Mes avions et informations pilote',
	resetGroupBriefing: 'Briefing, routes et traces',
	resetGroupFlights: 'Vols classés (bibliothèque des vols)',
	resetGroupSettings: 'Réglages et préférences',
	resetIntro:
		'Efface les données sélectionnées stockées sur cet appareil, puis recharge l’application.',
	resetTitle: 'Réinitialiser l’application',
	sectionAppearance: 'Apparence',
	sectionLanguages: 'Langues du contenu',
	sectionPosition: 'Position',
	sectionLiveData: 'Données en direct',
	showInAirspaces: 'Afficher les listes géométriques "Dans les espaces"',
	showInAirspacesTip:
		'Listes fondées sur la position\u202f: les espaces aériens contenant un NOTAM (panneau NOTAM) et les NOTAM situés dans un espace (panneau espace). Les liens explicites par nom, désignateur ou activation restent toujours affichés.',
	sofiaLang: 'Langue des NOTAM SOFIA',
	sofiaLangTip:
		'Langue du texte des NOTAM téléchargés depuis SOFIA-Briefing, quand une forme anglaise et une forme française sont fournies. Auto suit la langue de l’application.',
	supaipLang: 'Langue des SUP AIP',
	supaipLangTip:
		'Langue de l’objet des SUP AIP affiché dans le panneau de détail et les vignettes NOTAM (quand une version anglaise existe). Français sélectionne la langue de publication du supplément, soit l’espagnol pour un supplément espagnol. Auto suit la langue de l’application. Les deux éditions restent proposées.',
	title: 'Réglages',
	traceExportFormat: 'Format des traces enregistrées',
	traceExportFormatTip:
		'Le fichier écrit pour une trace ENREGISTRÉE par cette application, depuis l’onglet Navigation, une ligne de vol ou l’ensemble de la bibliothèque.',
	traceExportImported: 'Une trace importée est exportée telle qu’elle est arrivée.',
	traceConvertImported: 'Convertir les traces importées dans ce format',
	traceConvertImportedTip:
		'Réécrire les traces importées dans le format ci-dessus au lieu de restituer le fichier d’origine. Désactivé par défaut\u202f: cette application n’enregistre pas tout ce qu’un autre enregistreur a écrit, et le fichier réécrit ne serait donc plus celui qui a été importé.',
	traceExportGpxTip: 'Format de trace universel, lu par tous les outils de cartographie et de carnet.',
	traceExportIgcTip:
		'Format vol à voile et OLC. Écrit comme un enregistreur non homologué, sans enregistrement de sécurité\u202f: bon pour un débriefing, jamais pour un insigne ou un record.',
	traceExportKmlTip:
		'Google Earth\u202f: le vol se rejoue sur la frise temporelle, avec son profil d’altitude.',
	typeIcons: 'Icônes de type d’obstacle sur les marqueurs',
} satisfies Messages['display'];
