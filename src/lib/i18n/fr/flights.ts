/* Miroir français de ../en/flights.ts.
 *
 * Trois verbes distincts, à ne pas confondre : ENREGISTRER, c'est le GPS
 * qui enregistre une trace ; CLASSER, c'est ajouter un vol à la
 * bibliothèque ; MÉMORISER, c'est écrire un plan de vol au catalogue. La
 * version anglaise les sépare aussi (Recording / add / Store), et les
 * confondre était le principal défaut de lecture de cette surface. */

import type { Messages } from '../en';

export const flights = {
	title: 'Vols',
	datumBatchNote: (count: number): string =>
		`S’applique à tous les fichiers de cet import qui ne l’indiquent pas (${count}).`,
	empty: 'Aucun vol classé pour l’instant. Un enregistrement arrêté ou une trace importée comportant un décollage est classé ici automatiquement.',
	loading: 'Chargement des vols…',
	colDate: 'Date',
	colDeparture: 'Départ',
	colArrival: 'Arrivée',
	colTotal: 'Total',
	colTotalTip: 'De cale à cale (temps de vol FCL.010), tel que la trace GPS le montre.',
	colLandings: 'LDG',
	colLandingsTip:
		'Atterrissages du vol, nombre de nuit entre parenthèses\u202f: l’atterrissage final plus les posés-décollés détectés en route.',
	colNight: 'Nuit',
	colRoute: 'Route',
	touchedTip: 'Posé ici',
	sameOuting: 'Même trace que le vol au-dessus',
	inFlight: 'En vol',
	inFlightTip:
		'Enregistrement en cours. Le vol sera classé ici à la fin de l’enregistrement.',
	recordingChip: 'Enregistrement',
	recordingChipTip: 'Enregistrement en cours, pas encore en vol.',
	scopeLabel: 'Période',
	scopeAll: 'Tous les vols',
	scopeAllShort: 'tous les vols',
	totalsLabel: (scope: string): string => `Totaux, ${scope}`,
	load: 'Ouvrir en rejeu',
	unloadTrace: 'Retirer la trace chargée du rejeu',
	unloadTraceWithPlan: 'Retirer la trace et son plan de l’espace de travail',
	openWithPlan: 'Ouvrir en rejeu avec son plan',
	openWithPlanFailed: (detail: string): string =>
		`Le plan du vol n’a pas pu être chargé\u202f: ${detail}`,
	loadBusy: 'Arrêtez d’abord l’enregistrement',
	pointsMissing: 'La trace de ce vol n’est plus sur cet équipement.',
	deleteRow: 'Supprimer',
	deleteConfirm: 'Supprimer ce vol\u202f? Sa trace est retirée de cet équipement.',
	deleteConfirmAction: 'Supprimer',
	addTrace: 'Ajouter la trace chargée à la bibliothèque',
	addTraceTip:
		'Ajoute la trace chargée à la bibliothèque des vols. Imports et enregistrements arrêtés s’y classent d’eux-mêmes\u202f; utilisez ceci s’il en manque un.',
	addTraceDone: 'Trace ajoutée à la bibliothèque.',
	addTraceNoFlight: 'Aucun vol à ajouter\u202f: cette trace ne comporte aucun décollage détecté.',
	archiveFailed: (detail: string): string =>
		`Le vol n’a pas pu être stocké sur cet équipement\u202f: ${detail}. La trace reste chargée\u202f: libérez de l’espace puis ajoutez-la de nouveau pour la conserver.`,
	exportMenu: 'Exporter et imprimer',
	exportBundle: 'Tout exporter (ZIP)',
	exportBundleTip:
		'Toute la bibliothèque en un seul fichier\u202f: chaque trace dans son propre format, le carnet CSV, les plans de vol mémorisés et vos propres avions. Ouvrez-le sur un autre appareil pour tout y retrouver.',
	exportTracesZip: (format: string): string => `Exporter toutes les traces (ZIP, ${format})`,
	exportTracesZipTip: (format: string): string =>
		`Chaque trace de la bibliothèque en fichier ${format}, dans une archive ZIP.`,
	exportTracesZipOwn: 'Exporter toutes les traces (ZIP)',
	exportTracesZipTipOwn:
		'Chaque trace de la bibliothèque dans une archive ZIP. Chacune garde son propre format\u202f: une trace importée est exportée telle qu’elle est arrivée, une trace enregistrée dans le format indiqué dans les Réglages.',
	exportPlansZip: 'Exporter tous les plans (ZIP)',
	exportPlansZipTip: 'Chaque fichier de routes mémorisé, dans une archive ZIP.',
	exportCsvAll: 'Exporter tout en CSV carnet',
	exportCsvAllTip:
		'Tous les vols de la bibliothèque en lignes au format AMC1 FCL.050, du plus ancien au plus récent (en-têtes en anglais, heures UTC). Vérifiez et corrigez avant report au carnet de vol.',
	exportFailed: (detail: string): string => `L’export a échoué\u202f: ${detail}`,
	exportNothing: 'Rien à exporter dans cette vue.',
	importAll: 'Importer des vols…',
	importAllTip:
		'Sélectionnez traces GPX, fichiers de routes et CSV carnet, ensemble ou dans n’importe quel ordre\u202f: chaque trace comportant un décollage est classée, appariée automatiquement au plan qu’elle a suivi\u202f; les fichiers de routes sont mémorisés pour les imports suivants et les lignes du carnet complètent les vols sans trace.',
	importProgress: (done: string, total: string): string => `Import en cours… ${done}/${total}`,
	importNoTakeoff: (file: string): string => `${file}\u202f: aucun décollage détecté, non classé`,
	importNoClock: (file: string): string => `${file}\u202f: aucune heure dans ce fichier, non classé`,
	importInvalid: (file: string, detail: string): string => `${file}\u202f: ${detail}`,
	importStoreFailed: (file: string, detail: string): string =>
		`${file}\u202f: n’a pas pu être stocké sur cet équipement\u202f: ${detail}`,
	importDatumDeclined: (file: string): string =>
		`${file}\u202f: rien classé, la référence des altitudes n’a pas été indiquée`,
	importUnsupported: (file: string): string =>
		`${file}\u202f: ni trace, ni fichier de routes, ni CSV carnet`,
	importAircraftAdded: (n: string, kept: string): string =>
		Number(kept) > 0
			? `${n} avion${Number(n) > 1 ? 's ajoutés' : ' ajouté'} à votre flotte\u202f; ${kept} que vous aviez déjà ${Number(kept) > 1 ? 'ont' : 'a'} été conservé${Number(kept) > 1 ? 's' : ''}.`
			: `${n} avion${Number(n) > 1 ? 's ajoutés' : ' ajouté'} à votre flotte.`,
	importAircraftKept: (n: string): string =>
		`${n} avion${Number(n) > 1 ? 's étaient déjà' : ' était déjà'} dans votre flotte et ${Number(n) > 1 ? 'ont' : 'a'} été conservé${Number(n) > 1 ? 's' : ''}.`,
	importAircraftNotSaved: (n: string): string =>
		`${n} avion${Number(n) > 1 ? 's n’ont' : ' n’a'} pas pu être enregistré${Number(n) > 1 ? 's' : ''}\u202f: ce navigateur a refusé le stockage, ${Number(n) > 1 ? 'ils seront perdus' : 'il sera perdu'} au prochain rechargement.`,
	importPlansSaved: (count: string): string =>
		`Fichiers de routes mémorisés pour l’appariement\u202f: ${count} (listés dans la vue Plans)`,
	importPlanUnusable: (file: string): string =>
		`${file}\u202f: aucune route exploitable dans ce fichier`,
	importLogbook: (file: string, added: string, total: string): string =>
		`${file}\u202f: ${added} vols du carnet sur ${total} ajoutés\u202f; le reste est déjà couvert ou illisible`,
	viewsAria: 'Vues de la bibliothèque des vols',
	viewFlights: 'Vols',
	viewPlans: 'Plans',
	plansLoading: 'Chargement des plans mémorisés…',
	plansEmpty:
		'Le catalogue de plans de vol est vide. Les fichiers de routes choisis dans l’importateur sont conservés ici et confrontés à chaque trace importée.',
	colPlan: 'Plan',
	colPlanTip:
		'Le nom donné à ce plan, au-dessus de la route telle que l’appariement lit le fichier aujourd’hui, sur les données actuelles.',
	planRename: 'Renommer le plan',
	planNameLabel: 'Nom du plan',
	colPlanSaved: 'Mémorisé',
	colPlanUsed: 'Vols',
	colPlanUsedTip:
		'Vols dont la trace correspond actuellement à ce plan. Le lien est dynamique\u202f: il se recalcule sur le catalogue à chaque modification d’un plan.',
	planParseFailed: (detail: string): string => `Illisible\u202f: ${detail}`,
	planNoRoutes: 'Aucune route exploitable sur les données actuelles.',
	planDropped: (idents: string): string => `Non résolus\u202f: ${idents}`,
	planActivate: 'Activer le plan de vol',
	planActivateTip:
		'Copie ce plan dans l’espace de travail comme plan de vol actif. La copie du catalogue reste intacte, le plan de vol actif courant est remplacé.',
	activateOverDirtyConfirm:
		'Le plan de vol actif comporte des modifications non mémorisées\u202f; elles seront perdues. Activer ce plan\u202f?',
	activateAction: 'Activer',
	planActiveDirtyTip:
		'Le plan de vol actif, avec des modifications non mémorisées. Mémorisez-le ici ou depuis le menu d’actions des routes.',
	planActiveLossyTip:
		'Cette copie a perdu des points lors de son activation, elle diffère donc du plan mémorisé. La mémoriser remplace l’original plus complet.',
	planDeactivate: 'Retirer le plan de vol actif',
	planDeactivateTip:
		'Retire ce plan de l’espace de travail. L’entrée du catalogue est conservée\u202f; une étape d’annulation restaure l’espace de travail.',
	deactivateDirtyConfirm:
		'Le plan de vol actif comporte des modifications non mémorisées\u202f; elles seront perdues. Le retirer de l’espace de travail\u202f?',
	deactivateAction: 'Retirer',
	planStoreRow: 'Mémoriser le plan de vol',
	storeFailed: (detail: string): string => `Échec de la mémorisation\u202f: ${detail}`,
	plansLoadFailed: (detail: string): string => `Le plan n’a pas pu être chargé\u202f: ${detail}`,
	plansDownload: 'Télécharger le fichier',
	plansDelete: 'Supprimer le plan de vol',
	plansDeleteConfirm:
		'Supprimer ce plan de vol\u202f? Les vols qui y sont liés se détachent (le lien est dynamique)\u202f; leurs traces restent dans la bibliothèque.',
} satisfies Messages['flights'];
