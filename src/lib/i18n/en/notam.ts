/* NOTAM presentation strings: validity-status badges, the FIR-briefing
 * group headings, and the NOTAM detail panel's own sections (Activates,
 * Coordinates, reference links, ...). The pure core ($lib/notam,
 * $lib/format/datetime) returns the keys; these records render them. */

import type { NotamStatus } from '$lib/format/datetime';
import type { FirGroupKey } from '$lib/notam/qcode';
import type { SofiaSubjectKey } from '$lib/notam/sofiaSubject';
import { plural } from './plural';

export const notam = {
	activates: 'Activates',
	activatesSupZones: 'Activates SUP AIP zones',
	affectedAirspaces: 'Affected airspaces',
	affectedNavaids: 'Affected navaids',
	affectedObstacles: 'Affected obstacles',
	areaN: (n: number) => `Area ${n}`,
	arpChipTip: 'Position anchored to this aerodrome’s reference point; open it',
	centerAreaTip: 'Center the map on this area',
	centerCoordinateTip: 'Center the map on this coordinate',
	coordinates: 'Coordinates',
	description: 'Description',
	emptyNoPosition: 'No NOTAM with a position was found.',
	fgBandLabel: 'NOTAM F/G altitude band',
	fields: {
		fir: 'FIR',
		qCode: 'Q-code',
	},
	firGroups: {
		navcom: 'Navaids & communications',
		obstacles: 'Obstacles',
		organisation: 'Airspace organisation',
		other: 'Other',
		procedures: 'Air traffic procedures',
		restrictions: 'Airspace restrictions',
		services: 'Services & facilities',
		warnings: 'Navigation warnings',
	} satisfies Record<FirGroupKey, string>,
	freqChange: 'Frequency change',
	// The NOTAMs-tab "print all NOTAMs" button and the SOFIA-style print bulletin.
	pib: {
		print: 'Print',
		printTip: 'Print all NOTAMs as a SOFIA-Briefing-style bulletin',
		title: 'NOTAM briefing',
		generated: (d: string) => `Generated ${d} UTC`,
		count: (n: number) => `${n} ${plural(n, 'NOTAM', 'NOTAMs')}`,
		from: 'FROM',
		to: 'TO',
	},
	/** The one wording for "this briefing is short of N routes", shared by
	 *  the head chip, the fetch view's gap list (which introduces one, hence
	 *  `list`) and the printed bulletin. */
	routesNotCovered: (p: { missing: number; total: number; list?: boolean }) =>
		`${p.missing} of ${p.total} route${p.total === 1 ? '' : 's'} not covered${p.list ? ':' : ''}`,
	gapChipTip: 'This briefing does not cover every route; open the fetch view for which and why',
	hideQRadius: (nm: number) => `Hide Q-line radius (${nm} NM) on map`,
	inAirspaces: 'In airspaces',
	kindArea: 'Area',
	kindPosition: 'Position',
	listTitle: 'Parsed NOTAMs',
	location: 'Location',
	menuTitle: (n: number) => `NOTAMs (${n})`,
	moreVertices: (n: number) => `+${n} more ${plural(n, 'vertex', 'vertices')}`,
	notInBriefing: 'not in this briefing',
	openActivationTip: 'Open the activation NOTAM',
	openFrameworkTip: 'Open the triggered framework NOTAM',
	openReferencedTip: 'Open the referenced NOTAM',
	openReferencingTip: 'Open the referencing NOTAM',
	openReplacedTip: 'Open the replaced NOTAM',
	profileDescription: 'Altitude profile of the airspaces this NOTAM crosses',
	qlineBandLabel: 'NOTAM Q-line altitude band',
	radiusLabel: (r: string) => `radius ${r}`,
	rawNotam: 'Raw NOTAM',
	referencedAerodromes: 'Referenced aerodromes',
	referencedSups: 'Referenced AIP SUPs',
	references: 'References',
	replaces: 'Replaces',
	schedule: 'Schedule',
	scope: {
		A: 'Aerodrome',
		AE: 'Aerodrome & en-route',
		AEW: 'Aerodrome, en-route & warning',
		AW: 'Aerodrome & nav warning',
		E: 'En-route',
		EW: 'En-route & nav warning',
		K: 'Checklist',
		W: 'Nav warning',
	},
	searchPlaceholder: 'Search NOTAM id or text…',
	showQRadius: (nm: number) => `Show Q-line radius (${nm} NM) on map`,
	showSupAreaTip: 'Show this supplement’s area on the map',
	showSupZoneTip: 'Show this SUP AIP zone on the map',
	// SOFIA-Briefing fine subject sub-headings, printed inside each aerodrome /
	// FIR block (the standard ICAO/OPADD PIB grouping; the FR wording mirrors
	// SOFIA, the EN wording uses the ICAO/PANS-AIM category names). See
	// $lib/notam/sofiaSubject.
	sofiaGroups: {
		adFacilities: 'FACILITIES AND SERVICES',
		adManoeuvring: 'MOVEMENT AND LANDING AREA',
		adApron: 'APRON',
		adLighting: 'LIGHTING FACILITIES',
		adNavaids: 'LANDING AIDS, RADIO NAVIGATION AND GNSS',
		adAirspaceAts: 'AIRSPACE ORGANISATION AND AIR TRAFFIC SERVICES',
		adProcedures: 'PROCEDURES',
		adMeteo: 'METEOROLOGY AND EQUIPMENT',
		enrAirspaceProc: 'AIRSPACE ORGANISATION AND PROCEDURES',
		enrAtsVolmet: 'AIR TRAFFIC SERVICES AND VOLMET',
		enrCom: 'COMMUNICATION AND SURVEILLANCE FACILITIES',
		enrNavaids: 'GNSS - RADIO NAVIGATION AIDS',
		enrRestrictions: 'AIRSPACE RESTRICTIONS',
		warnings: 'WARNINGS',
		obstacles: 'OBSTACLES',
		other: 'OTHER INFORMATION',
	} satisfies Record<SofiaSubjectKey, string>,
	status: {
		active: 'Active now',
		expired: 'Expired',
		future: 'Not yet active',
		permanent: 'Permanent',
	} satisfies Record<NotamStatus, string>,
	supLinkTip: 'Open this AIP SUP PDF (English) on the SIA portal',
	traffic: {
		I: 'IFR',
		IV: 'IFR & VFR',
		V: 'VFR',
	},
	triggerTip: 'This NOTAM activates a restricted area or an AIP SUP framework',
	triggeredBy: 'Triggered by',
	triggers: 'Triggers',
	verticalLimits: 'Vertical limits',
};
