/* The flights library ("Flights" surface): a logbook-LOOK aid for filing
 * the pilot's real logbook, never the logbook itself, which is why the
 * pilot-declared carnet columns are absent (docs/flights-library.md).
 *
 * Vocabulary note: nothing here is "filed". ICAO reserves that word for a
 * flight plan submitted to ATS units ("Filed flight plan (FPL or eFPL)",
 * Annex 2), and this surface holds flights already flown, in an app that
 * also carries a flight plan catalog and a SendFPL hand-off. A trace is
 * ADDED to the library; the French mirror says « classer », which has no
 * such reading. */

export const flights = {
	title: 'Flights',
	datumBatchNote: (count: number): string =>
		`Applies to every file in this import that does not state it (${count}).`,
	empty: 'No flights recorded yet. A stopped recording, or an imported trace with a takeoff, is added here automatically.',
	loading: 'Loading the flights…',
	colDate: 'Date',
	colDeparture: 'Departure',
	colArrival: 'Arrival',
	colTotal: 'Total',
	colTotalTip: 'Block to block (FCL.010 flight time), as the GPS trace shows it.',
	colLandings: 'LDG',
	colLandingsTip:
		'Landings of the flight, night count in parentheses: the landing that ended it plus the touch-and-goes detected along the way.',
	colNight: 'Night',
	colRoute: 'Route',
	touchedTip: 'Touched down here',
	sameOuting: 'Same trace as the flight above',
	inFlight: 'In flight',
	inFlightTip: 'Recording underway. The flight is added here when the recording completes.',
	recordingChip: 'Recording',
	recordingChipTip: 'Recording underway, not yet airborne.',
	scopeLabel: 'Period',
	scopeAll: 'All flights',
	scopeAllShort: 'all flights',
	totalsLabel: (scope: string): string => `Totals, ${scope}`,
	load: 'Open in replay',
	unloadTrace: 'Clear the loaded trace from replay',
	unloadTraceWithPlan: 'Clear the trace and its plan from the workspace',
	openWithPlan: 'Open in replay with its plan',
	openWithPlanFailed: (detail: string): string => `The flight's plan could not be loaded: ${detail}`,
	loadBusy: 'Stop the recording first',
	pointsMissing: 'The trace of this flight is no longer on this device.',
	deleteRow: 'Delete',
	deleteConfirm: 'Delete this flight? Its trace is removed from this device.',
	deleteConfirmAction: 'Delete',
	addTrace: 'Add the loaded trace to the library',
	addTraceTip:
		'Add the loaded trace to the flights library. Imports and stopped recordings are added on their own; use this if one is missing.',
	addTraceDone: 'Trace added to the library.',
	addTraceNoFlight: 'No flight to add: this trace holds no detected takeoff.',
	archiveFailed: (detail: string): string =>
		`The flight could not be stored on this device: ${detail}. The trace is still loaded, so freeing space and adding it again will keep it.`,
	exportMenu: 'Export and print',
	exportBundle: 'Export everything (ZIP)',
	exportBundleTip:
		'The whole library in one file: every trace in its own format, the logbook CSV, the remembered flight plans and your own aircraft. Open it on another device to bring it all across.',
	exportTracesZip: (format: string): string => `Export all traces (ZIP, ${format})`,
	exportTracesZipTip: (format: string): string =>
		`Every trace in the library as its own ${format} file, in one ZIP archive.`,
	exportTracesZipOwn: 'Export all traces (ZIP)',
	exportTracesZipTipOwn:
		'Every trace in the library in one ZIP archive. Each keeps its own format: an imported trace is exported exactly as it arrived, a recorded one in the format the Settings tab names.',
	exportPlansZip: 'Export all plans (ZIP)',
	exportPlansZipTip: 'Every remembered route file, in one ZIP archive.',
	exportCsvAll: 'Export all as logbook CSV',
	exportCsvAllTip:
		'Every flight in the library as AMC1 FCL.050-shaped rows, oldest first (English headers, UTC times). Review and amend before your logbook.',
	exportNothing: 'Nothing to export in this view.',
	exportFailed: (detail: string): string => `The export failed: ${detail}`,
	importAll: 'Import flights…',
	importAllTip:
		'Pick GPX traces, route files and logbook CSVs together or in any order: every trace with a takeoff is added, each matched automatically to the plan it flew; route files are remembered for later imports, and logbook rows fill in the flights no trace covers.',
	importProgress: (done: string, total: string): string => `Importing… ${done}/${total}`,
	importNoTakeoff: (file: string): string => `${file}: no takeoff detected, not added`,
	importNoClock: (file: string): string => `${file}: no times in this file, not added`,
	importInvalid: (file: string, detail: string): string => `${file}: ${detail}`,
	importStoreFailed: (file: string, detail: string): string =>
		`${file}: could not be stored on this device: ${detail}`,
	importDatumDeclined: (file: string): string =>
		`${file}: added nothing, the altitude reference was not answered`,
	importUnsupported: (file: string): string =>
		`${file}: not a trace, a route file or a logbook CSV`,
	importAircraftAdded: (n: string, kept: string): string =>
		Number(kept) > 0
			? `${n} aircraft added to your fleet; ${kept} you already had were left as they are.`
			: `${n} aircraft added to your fleet.`,
	importAircraftKept: (n: string): string =>
		`${n} aircraft were already in your fleet and were left as they are.`,
	importAircraftNotSaved: (n: string): string =>
		`${n} aircraft could not be saved: this browser refused the storage, so they will be gone on the next reload.`,
	importPlansSaved: (count: string): string =>
		`Route files remembered for matching: ${count} (listed in the Plans view)`,
	importPlanUnusable: (file: string): string => `${file}: no usable route in this file`,
	importLogbook: (file: string, added: string, total: string): string =>
		`${file}: ${added} of ${total} logbook flights added; the rest are already covered or unreadable`,
	viewsAria: 'Flights library views',
	viewFlights: 'Flights',
	viewPlans: 'Plans',
	plansLoading: 'Loading the remembered plans…',
	plansEmpty:
		'The flight plan catalog is empty. Route files picked in the importer are kept here and matched against every imported trace.',
	colPlan: 'Plan',
	colPlanTip:
		'The name you gave this plan, over the route as the matcher reads the file today, against current data.',
	planRename: 'Rename plan',
	planNameLabel: 'Plan name',
	colPlanSaved: 'Stored',
	colPlanUsed: 'Flights',
	colPlanUsedTip:
		'Flights whose trace currently matches this plan. The link is dynamic: it recomputes against the catalog whenever a plan changes.',
	planParseFailed: (detail: string): string => `Unreadable: ${detail}`,
	planNoRoutes: 'No usable route against current data.',
	planDropped: (idents: string): string => `Unresolved: ${idents}`,
	planActivate: 'Activate flight plan',
	planActivateTip:
		'Copy this plan into the route workspace as the active flight plan. The stored copy stays intact; the current active flight plan is replaced.',
	activateOverDirtyConfirm:
		'The active flight plan has unstored changes; they will be lost. Activate this plan?',
	activateAction: 'Activate',
	planActiveDirtyTip:
		'The active flight plan, with unstored changes. Store it from here or from the route actions menu.',
	planActiveLossyTip:
		'This copy lost waypoints when it was activated, so it differs from the stored plan. Storing it replaces the fuller original.',
	planDeactivate: 'Clear the active flight plan',
	planDeactivateTip:
		'Remove this plan from the route workspace. The stored entry is kept; one undo step can bring the workspace back.',
	deactivateDirtyConfirm:
		'The active flight plan has unstored changes; they will be lost. Clear it from the workspace?',
	deactivateAction: 'Clear',
	planStoreRow: 'Store flight plan',
	storeFailed: (detail: string): string => `Store failed: ${detail}`,
	plansLoadFailed: (detail: string): string => `The plan could not be loaded: ${detail}`,
	plansDownload: 'Download the file',
	plansDelete: 'Delete flight plan',
	plansDeleteConfirm:
		'Delete this flight plan? Flights currently linked to it detach (the link is dynamic); their traces stay in the library.',
};
