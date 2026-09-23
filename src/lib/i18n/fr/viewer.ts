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
		'Un dossier NOTAM sur une carte aéronautique. Collez-en un, ouvrez un fichier ou récupérez-en un pour une liste d’aérodromes, et voyez chaque NOTAM face aux espaces aériens, aérodromes et suppléments AIP qu’il concerne.',
	aboutBaselineBody:
		'Le fond d\u2019aérodromes mondial sous-jacent est OurAirports\u202f: domaine public, OurAirports demande le crédit sans l\u2019exiger. Les limites de FIR, là où aucune AIP nationale n\u2019en publie, viennent de pruatlas d\u2019EUROCONTROL, sous GPL-2 ou MIT.',
	aboutSourceHeading: 'Open source',
	aboutSourceBody:
		'Libre et open source sous licence MIT, bâti sur le même code source que Loxodrome. Tout s’exécute dans votre navigateur\u202f: aucun compte, rien n’est téléversé, et aucun dossier que vous chargez ne quitte l’appareil, sauf par la requête qui l’a récupéré. Consultée à l’adresse notam-viewer.net, la page passe par un worker Cloudflare exploité par l’auteur, et chaque requête qu’il reçoit est conservée 7 jours dans le journal des requêtes de Cloudflare, que l’auteur peut consulter\u202f: l’adresse demandée, les en-têtes de la requête, dont votre adresse IP, et la localisation approximative que Cloudflare déduit de cette adresse.',
	aboutAipBody: (p: { publishers: string }) =>
		`Les espaces aériens, aérodromes et suppléments AIP sont publiés par les services d’information aéronautique nationaux de\u202f: ${p.publishers}, et redessinés ici selon les conventions cartographiques OACI et SIA, aux conditions que chaque source énonce, listées ci-dessous. Chaque jeu de données porte le cycle AIRAC annoncé par son éditeur.`,
	aboutAdChartsBody:
		'Le panneau d’aérodrome renvoie chaque terrain vers ses cartes chez leur propre éditeur, au moyen des catalogues ci-dessous\u202f: ils ne conservent que l’emplacement où chaque éditeur publie ses cartes, qui s’ouvrent sur son site.',
	aboutNotamBody:
		'Les NOTAM proviennent de SOFIA-Briefing, l’AIS français, ou d’autorouter, selon votre choix. Un dossier collé ou ouvert vient de là où vous l’avez pris. Ils transitent par un relais qui ne leur ajoute rien.',
	aboutWeatherBody:
		'Le panneau d’aérodrome affiche le METAR et le TAF du terrain, fournis par le NOAA Aviation Weather Center via le même relais que les dossiers. Domaine public du gouvernement des États-Unis. Le panneau Réglages permet de le désactiver. Le fond de carte et la mosaïque altimétrique ci-dessous sont chargés à mesure de leur affichage, et ce réglage ne les concerne pas.',
	aboutTerrainBody:
		'Le profil d’altitude trace le sol à la verticale du point considéré, lu dans une mosaïque altimétrique constituée pour Loxodrome à partir des modèles publics ci-dessous. Chacun est redistribué sous sa propre licence, citée ici comme cette licence l’exige. Aucun modèle dont les conditions interdisent la rediffusion n’est utilisé.',
	aboutBaseMapHeading: 'Fond de carte',
	aboutBaseMapBody:
		'La carte sous les NOTAM provient de l’un de ces services de tuiles, selon le choix fait dans le menu Couches. Chacun est appelé directement par votre navigateur et relève de ses propres conditions.',
	aboutLibrariesBody: 'Touchez une ligne pour lire sa notice.',
	aboutLicenseMissing: 'Cette notice n’a pas pu être chargée.',
	sourceLegend: 'Source du dossier',
	nightDimTip: 'Luminosité du fond de carte dans le thème nuit. La symbologie garde son contraste.',
	barLoad: 'Charger',
	siblingBadge: 'Loxodrome \u2197',
	siblingBadgeTip:
		'Loxodrome\u202f: préparation du vol et navigation. Ouvre un nouvel onglet.',
	siblingBody:
		'Ce visualiseur est la partie NOTAM de Loxodrome, l’application de préparation du vol et de navigation dont il est issu. La même carte et le même dossier, plus les routes et les logs de navigation, le bilan carburant, la masse et centrage, les distances de décollage et d’atterrissage, la météo, et une carte qui suit le GPS en vol. Libre et open source, elle s’exécute dans le navigateur et ne demande aucun compte.',
	siblingLink: 'Ouvrir Loxodrome',
	unknownIdents: (p: { words: string }) =>
		`Ne sont pas des codes OACI d’aérodrome, donc ignorés\u202f: ${p.words}.`,
} satisfies Messages['viewer'];
