/* Miroir français de ../en/viewer.ts (loxodrome.fr/notam).
 * « SOFIA-Briefing », « autorouter » et « Loxodrome » sont des noms de
 * produits, identiques dans les deux catalogues ; « FIR » est invariable
 * (usage officiel OACI et SIA).
 */

import type { Messages } from '../en';

export const viewer = {
	aerodromes: 'Aérodromes',
	fetchBriefing: 'Récupérer le dossier',
	pasteRefused:
		'Le navigateur n’a pas autorisé la page à lire le presse-papiers. Collez plutôt dans la zone : appui long, puis Coller.',
	fetchBriefingTip: 'Demander au service de briefing les NOTAM de ces aérodromes',
	aboutWhat:
		'NOTAM Viewer dessine un dossier NOTAM sur une carte aéronautique. Collez-en un, ouvrez un fichier ou récupérez-en un pour une liste d’aérodromes, et chaque NOTAM apparaît face aux espaces aériens, aérodromes et suppléments AIP qu’il concerne.',
	aboutBaselineBody:
		'Le fond d’aérodromes mondial sous-jacent est OurAirports, domaine public, qui demande d’être crédité sans l’exiger. Les FIR qu’aucune AIP nationale ne publie viennent de pruatlas d’EUROCONTROL, sous GPL-2 ou MIT.',
	aboutSourceHeading: 'Open source',
	aboutSourceBody:
		'NOTAM Viewer est libre et open source, sous licence MIT. Il s’exécute dans votre navigateur, y garde ses réglages et n’a pas de compte. Un dossier que vous collez ou ouvrez ne quitte jamais l’appareil. À l’adresse loxodrome.fr/notam, la page et ses données viennent de GitHub Pages à travers Cloudflare, qui voient chaque requête. À l’adresse notam-viewer.net, elles passent par un worker Cloudflare exploité par l’auteur. Cloudflare conserve chaque requête qu’il reçoit pendant 7 jours, où l’auteur peut la lire\u202f: l’adresse, les en-têtes de la requête avec votre adresse IP, et la localisation approximative qui en est déduite. Les deux adresses demandent aux navigateurs qui mettent en œuvre la journalisation des erreurs réseau (Network Error Logging) de signaler à Cloudflare les connexions qui échouent.',
	aboutAipBody: (p: { publishers: string }) =>
		`Les espaces aériens, aérodromes et suppléments AIP viennent des services d’information aéronautique nationaux de\u202f: ${p.publishers}. Ils sont redessinés selon les conventions cartographiques de l’OACI et du SIA, aux conditions que chaque source énonce ci-dessous. Les pictogrammes d’activité sont ceux du SIA, relevés sur sa légende du 1:500 000 (Légende 2026) et sa carte au 1:250 000, sous Licence Ouverte.`,
	aboutAdChartsBody:
		'Le panneau d’aérodrome renvoie chaque aérodrome vers ses cartes sur le site de son éditeur, au moyen des catalogues ci-dessous. Rien n’est copié.',
	aboutNotamBody:
		'Les NOTAM viennent de SOFIA-Briefing, l’AIS français, ou d’autorouter, qui lit l’EAD d’EUROCONTROL, selon votre choix, pour une liste d’aérodromes ou un aérodrome depuis son panneau. Ils passent par proxy.loxodrome.fr, le relais de l’auteur. Il voit les aérodromes demandés et votre adresse IP, limite le débit par adresse, ne transmet que la requête et ne consigne que ses échecs.',
	aboutWeatherBody:
		'Le panneau d’aérodrome affiche les METAR et TAF du terrain ou des stations voisines, fournis par le NOAA Aviation Weather Center via le même relais. Domaine public du gouvernement des États-Unis. Météo en direct, dans Réglages, les désactive, mais pas le fond de carte ni le relief ci-dessous.',
	aboutTerrainBody:
		'Le profil d’altitude trace le sol d’après une mosaïque altimétrique constituée pour Loxodrome à partir des modèles publics ci-dessous, chacun cité comme sa licence l’exige. Ses tuiles viennent de charts.loxodrome.fr, le serveur de cartes de l’auteur, qui ne tient aucun journal. Seuls des modèles qui permettent la rediffusion sont utilisés.',
	aboutBaseMapHeading: 'Fond de carte',
	aboutBaseMapBody:
		'La carte est dessinée à partir de l’un de ces services de tuiles, choisi dans Couches de la carte et appelé directement par votre navigateur, sous ses propres conditions.',
	aboutLibrariesBody: 'Chaque ligne ouvre sa notice de licence.',
	aboutLicenseMissing: 'Cette notice n’a pas pu être chargée.',
	sourceLegend: 'Source du dossier',
	nightDimTip: 'Luminosité du fond de carte dans le thème nuit. La symbologie garde son contraste.',
	barLoad: 'Charger',
	restoreConfirm:
		'Rétablir les réglages par défaut de ce visualiseur\u202f? Les langues et le thème, les couches de la carte, les marqueurs et filtres NOTAM, l’anticipation et la bande de niveaux, la source du dossier, la météo en direct, les profils verticaux, l’atténuation de nuit et la disposition des panneaux reprennent leur valeur par défaut. Le dossier chargé est conservé.',
	restoreShared:
		'Loxodrome, sur le même site, lit aussi ces réglages, sauf les couches de la carte\u202f: ils y sont rétablis également.',
	siblingBadge: 'Loxodrome \u2197',
	siblingBadgeTip:
		'Loxodrome\u202f: préparation du vol et navigation. Ouvre un nouvel onglet.',
	siblingBody:
		'Ce visualiseur est la partie NOTAM de Loxodrome, l’application de préparation du vol et de navigation en vol bâtie sur le même code source. Loxodrome y ajoute les routes, les logs de navigation, le bilan carburant, la masse et centrage, les distances de décollage et d’atterrissage, la météo et une carte qui suit l’aéronef, dans un navigateur ou sous Android.',
	siblingLink: 'Ouvrir Loxodrome',
	unknownIdents: (p: { words: string }) =>
		`Ne sont pas des codes OACI d’aérodrome, donc ignorés\u202f: ${p.words}.`,
} satisfies Messages['viewer'];
