/* Miroir français de ../en/offline.ts : le gestionnaire hors ligne
 * (docs/offline-maps.md). Vocabulaire SIA / OACI ; les noms de produits
 * cartographiques, le cycle AIRAC et les unités de formatPackBytes (GB / MB)
 * restent invariants. */

import type { Messages } from '../en';

import { plural } from './plural';

export const offline = {
	// La surface, et les portes d’entrée
	title: 'Données hors ligne',
	manage: 'Gérer les données hors ligne',
	heldSummary: (p: { packs: number; size: string }) =>
		`${p.packs} ${plural(p.packs, 'téléchargement enregistré', 'téléchargements enregistrés')}, ${p.size}`,
	nothingHeld: 'Aucun téléchargement',
	webOnly:
		'Les téléchargements se font dans l’application Android, seule à pouvoir garantir que les fichiers seront encore là sur le terrain. Une copie déjà téléchargée reste utilisable ici.',
	heldChip: 'Hors ligne',
	heldChipTip: (date: string) => `Tracée depuis la copie hors ligne du ${date}`,

	// La file d’attente
	queueTotal: (p: { jobs: number; size: string }) =>
		`${p.jobs} ${plural(p.jobs, 'téléchargement en attente', 'téléchargements en attente')}, ${p.size} restants.`,
	queueTotalUnknown: (p: { jobs: number; size: string; unknown: number }) =>
		`${p.jobs} ${plural(p.jobs, 'téléchargement en attente', 'téléchargements en attente')}, ${p.size} restants et ${p.unknown} de taille inconnue.`,
	queueTotalUnknownOnly: (jobs: number) =>
		`${jobs} ${plural(jobs, 'téléchargement en attente', 'téléchargements en attente')}, taille totale inconnue.`,
	queueOverflow: (free: string) =>
		`La file d’attente ne tient pas\u202f: ${free} libres seulement sur cet appareil.`,
	queued: 'En attente',
	queuedAt: (n: number) => `En attente, ${n} devant`,
	removeFromQueue: 'Retirer',
	stopAll: 'Arrêter tous les téléchargements',
	stopAllConfirm:
		'Arrêter tous les téléchargements et vider la file d’attente\u202f? Ce qui est déjà téléchargé est conservé, et un téléchargement suspendu reprendra où il s’est arrêté.',
	wakeNote:
		'Gardez l’écran allumé\u202f: un téléchargement est suspendu lorsque l’écran est éteint.',

	// Actions et états d’une ligne
	download: 'Télécharger',
	update: 'Mettre à jour',
	delete: 'Supprimer',
	discard: 'Abandonner',
	retry: 'Réessayer',
	pause: 'Suspendre',
	resume: 'Reprendre',
	downloading: 'Téléchargement',
	held: (p: { date: string; size: string }) => `Copie hors ligne du ${p.date}, ${p.size}`,
	paused: (p: { pct: number; done: string; total: string }) =>
		`Suspendu à ${p.pct}\u202f%, ${p.done} sur ${p.total} conservés`,
	figures: (p: { pct: number; done: string; total: string }) =>
		`${p.pct}\u202f%, ${p.done} sur ${p.total}`,
	progressAria: (name: string) => `Téléchargement de ${name}`,
	updateAvailable: 'Nouvelle édition disponible',
	updatesAvailable: (n: number) =>
		`${n} ${plural(n, 'mise à jour disponible', 'mises à jour disponibles')}`,
	updateAll: (p: { n: number; size: string }) => `Tout mettre à jour (${p.n}, ${p.size})`,
	deleteConfirm: (p: { name: string; size: string }) =>
		`Supprimer la copie hors ligne de ${p.name} (${p.size})\u202f? Elle pourra être téléchargée de nouveau.`,
	discardConfirm: (p: { name: string; size: string }) =>
		`Abandonner les ${p.size} déjà téléchargés de ${p.name}\u202f? Le téléchargement reprendrait depuis le début.`,
	errors: {
		download: 'Échec du téléchargement. Vérifiez la connexion et réessayez.',
		quota: 'Espace de stockage insuffisant sur cet appareil.',
		unpublished: 'Pas encore publié sur le serveur.',
		unsupported: 'Le stockage hors ligne n’est pas pris en charge par ce navigateur.',
	},

	// Cartes aéronautiques
	chartsLegend: 'Cartes aéronautiques',
	chartsNote:
		'Une carte téléchargée est tracée depuis cet appareil et ne nécessite aucune connexion.',

	// Documents AIP
	docsLegend: 'Documents AIP',
	docsVac: 'Cartes VAC',
	docsVacNote:
		'Cartes d’atterrissage à vue de tous les aérodromes et hélistations français.',
	docsSup: 'Suppléments AIP en vigueur',
	docsSupLang: (lang: string) => `en ${lang}`,
	docsNextCycle: (cycle: string) => `Cycle AIRAC suivant, ${cycle}`,
	docsStored: (p: { files: number; size: string; date: string }) =>
		`${p.files} documents, ${p.size}, ${p.date}`,
	docsStale: (cycle: string) => `Cycle AIRAC ${cycle}, périmé`,
	docsMissing: (n: number) =>
		`${n} ${plural(n, 'document non publié', 'documents non publiés')} par le SIA`,

	// Relief
	terrainLegend: 'Relief de ce plan',
	terrainSubject: 'Couloirs des routes',
	terrainScope: (p: { routes: number; radius: number; tiles: number; size: string }) =>
		`${p.routes} ${plural(p.routes, 'route', 'routes')}, couloir de ${p.radius}\u202fNM, ${p.tiles} tuiles, environ ${p.size}`,
	terrainDownload: 'Télécharger le relief pour ce plan',
	terrainPinnedLine: (p: { tiles: number; size: string; date: string }) =>
		`Relief hors ligne\u202f: ${p.tiles} tuiles, ${p.size}, ${p.date}`,
	terrainTip:
		'Enregistrer les tuiles d’altitude de tous les couloirs de ce plan, afin que les altitudes minimales, le profil vertical et les alertes de relief continuent de fonctionner hors ligne',
	terrainNoRoute:
		'Préparez une route d’au moins deux points de report pour enregistrer son relief.',
	terrainRemoveConfirm:
		'Supprimer le relief enregistré pour ce plan\u202f? Les altitudes minimales, le profil vertical et les alertes de relief nécessiteraient de nouveau une connexion.',

	// Stockage
	storageLegend: 'Stockage',
	storageUsed: (size: string) => `Utilisé par Loxodrome\u202f: ${size}`,
	storageFree: (size: string) => `Libre sur cet appareil\u202f: ${size}`,
	storageUnknown: 'Ce navigateur ne communique pas l’espace de stockage utilisé.',
	storageCharts: 'Cartes aéronautiques',
	storageDocs: 'Documents AIP',
	storageTerrain: 'Relief',
	storageTiles: 'Tuiles de carte en cache',
	storageTilesNote:
		'Ce que vous avez consulté reste disponible hors ligne\u202f; effacé automatiquement quand le cache est plein.',
	clear: 'Vider',
	clearTilesConfirm:
		'Vider les tuiles de carte en cache\u202f? Les téléchargements ne sont pas affectés.',
} satisfies Messages['offline'];
