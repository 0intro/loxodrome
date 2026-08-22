/* User-facing operational error messages (fetch guidance, filter
 * validation). Wire-level diagnostics (HTTP statuses, upstream err.message,
 * file-format parse errors) stay English by policy (docs/i18n.md rule 10)
 * and never come through here. */

export const errors = {
	autorouterRateLimit: 'Too many NOTAM requests right now. Wait a few seconds and try again.',
	corridorEmpty: 'No aerodromes or FIRs within the corridor; widen the radius or extend the route.',
	datasetLoading: (p: { file: string; bbox: string }) =>
		`${p.file} not loaded; datasets must finish loading before a fetch. (viewport ${p.bbox})`,
	filterFloorAboveCeiling: '"Floor" must be at or below "ceiling".',
	filterFloorCeilingNumbers: 'Floor and ceiling must be numbers.',
	filterFromAfterTo: '"From" must be on or before "to".',
	filterInvalidDateTime: 'Invalid date or time.',
	filterPickBothDates: 'Pick a from and a to date.',
	filterPickFromDate: 'Pick a "from" date.',
	filterPickToDate: 'Pick a "to" date.',
	mapNotReady: 'Map not ready yet. Wait a moment and retry.',
	needTwoWaypoints: 'Add at least two waypoints to fetch NOTAMs for a route.',
	openMeteoRateLimit: (min: number) =>
		`Open-Meteo rate limit reached, retrying in ${min} min.`,
	proxyBusy: (sec: number) => `The service is busy right now, retry in ${sec}s.`,
	proxyNotConfigured: 'Configure the proxy URL first.',
	/** Why one route of a briefing did not land, keyed by SofiaFailureCode
	 *  (docs/sofia-briefing.md, "When a route is skipped"). The wire line
	 *  behind each stays English on the tooltip. */
	sofiaCause: {
		busy: 'The service is busy right now.',
		cancelled: 'Stopped before this route was fetched.',
		malformed: 'SOFIA-Briefing returned an answer this version cannot read.',
		noAerodrome: 'SOFIA-Briefing only briefs a route between aerodromes; this one has none.',
		notDeployed: 'The proxy does not serve SOFIA briefings yet.',
		proxy: 'The proxy returned an error.',
		refused: 'SOFIA-Briefing rejected the request.',
		timeout: 'The request timed out.',
		unreachable: 'The proxy could not be reached.',
		upstream: 'SOFIA-Briefing did not answer.',
	},
	viewportEmpty: (p: { bbox: string; airports: number; airspaces: number }) =>
		`No aerodromes or FIRs in this view; pan/zoom to a region with airports. (viewport ${p.bbox}; ${p.airports} airports / ${p.airspaces} airspaces loaded)`,
	viewportTooLarge: (p: { hDeg: string; wDeg: string; maxDeg: number }) =>
		`Viewport too large (${p.hDeg}° × ${p.wDeg}°). Max ${p.maxDeg}° on a side. Zoom in to a region.`,
};
