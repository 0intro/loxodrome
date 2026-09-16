/* Feature-type label dictionaries. The canonical English tables stay in
 * $lib/data (pure fallbacks for locale-free code paths); this domain
 * re-exports them so the French mirror is key-checked against the same
 * literal keys, and the UI reads t.data everywhere. Airport types are
 * keyed by the OurAirports type codes, runway surfaces by the lowercased
 * canonical labels formatSurface normalises to. */

import { AIRSPACE_CLASS_DESC, AIRSPACE_TYPE_LABELS } from '$lib/data/airspaces';
import { NAVAID_LABELS } from '$lib/data/navaids';
import { OBSTACLE_LABELS } from '$lib/data/obstacles';

export const data = {
	airportTypes: {
		balloonport: 'Balloonport',
		closed: 'Closed',
		heliport: 'Heliport',
		large_airport: 'Large airport',
		medium_airport: 'Medium airport',
		seaplane_base: 'Seaplane base',
		small_airport: 'Small airport',
	},
	airspaceClasses: AIRSPACE_CLASS_DESC,
	airspaceSubtypes: {
		ACC: 'ACC-controlled zone',
		SUR: 'Surveillance area',
		TRVL: 'Restricted travel zone',
		UAC: 'Upper area / control',
		VOL: 'Flight activity area',
	},
	airspaceTypes: AIRSPACE_TYPE_LABELS,
	approachLights: {
		ssals: 'SSALS',
		milovrn: 'Military overrun',
	},
	/** The AIP directory column: the helipad block France publishes in
	 *  AD 1.3-2, and the typed annotations the AIXM publishers carry. */
	facilityDirectory: {
		status: 'Usage',
		subCat: 'Sub-category',
		perfClass: 'Performance class',
		helRef: 'Reference helicopter',
		night: 'Night operations',
		terrace: 'Elevated (rooftop)',
		builtUp: 'Surroundings',
		height: 'Height above ground',
		fato: 'FATO',
		tlof: 'TLOF',
		surface: 'Surface',
		strength: 'Strength',
		// The AIXM publishers' half of the directory column.
		dimensions: 'Dimensions',
		slope: 'Slope',
		arrivalRoutes: 'Arrival routes',
		kind: 'Kind',
		usage: 'Permitted use',
		tlofType: 'TLOF area',
		windIndicator: 'Wind direction indicator',
		landingIndicator: 'Landing direction indicator',
		powerSupply: 'Secondary power supply',
		altimeterCheck: 'Altimeter check location',
		certification: 'Certification',
		remark: 'Remarks',
	},
	/** Coded <Statut> of a helipad. */
	heliportStatus: {
		tpd: 'Public transport on request',
		rst: 'Restricted use',
		adm: 'Reserved for government flights',
	},
	/** Coded <ZoneHabitee>: the environment the pad sits in, which decides
	 *  the performance class a flight must meet. */
	heliportBuiltUp: {
		'hostile habitée': 'Congested hostile',
		'hostile non habitée': 'Non-congested hostile',
		'non hostile': 'Non-hostile',
	},
	/** The SIA's oui / non, for the coded helipad flags. */
	yesNo: {
		oui: 'Yes',
		non: 'No',
	},
	facilityContact: {
		operator: 'Operator',
		web: 'Website',
		phone: 'Telephone',
		fax: 'Fax',
		email: 'Email',
		telex: 'Telex',
		sita: 'SITA',
		afs: 'AFS',
		postal: 'Postal address',
		other: 'Other',
	},
	facilityPassenger: {
		restaurant: 'Restaurant',
		transport: 'Transport',
		hotel: 'Hotels',
		medical: 'Medical',
		bank: 'Bank and post office',
		info: 'Tourist office',
		post: 'Post office',
		other: 'Other',
	},
	facilityServices: {
		fuel: 'Fuel and oil',
		handling: 'Handling',
		fire: 'Rescue and firefighting',
		lighting: 'Lighting',
		hangar: 'Hangar space',
		repair: 'Repair',
		deice: 'De-icing',
		clear: 'Clearing',
		security: 'Security',
		customs: 'Customs and immigration',
		health: 'Health and sanitation',
		other: 'Other',
	},
	lightColours: {
		whi: 'White',
		red: 'Red',
		grn: 'Green',
		blu: 'Blue',
		yel: 'Yellow',
	},
	lightIntensities: {
		lih: 'High',
		lim: 'Medium',
		lil: 'Low',
	},
	lightPositions: {
		edge: 'Edge',
		thr: 'Threshold',
		end: 'End',
		cl: 'Centreline',
		tdz: 'Touchdown zone',
		swycl: 'Stopway centreline',
		swy: 'Stopway',
		other: 'Other',
	},
	lightSides: {
		left: 'left',
		right: 'right',
	},
	natureTypes: {
		NATURE: 'Park or nature reserve',
		SENSITIVE: 'Site with special marking of prohibited low overflying',
		BIRD: 'Bird concentration area',
	},
	navaidTypes: NAVAID_LABELS,
	obstacleTypes: OBSTACLE_LABELS,
	surfaces: {
		asphalt: 'Asphalt',
		bitumen: 'Bitumen',
		concrete: 'Concrete',
		coral: 'Coral',
		dirt: 'Dirt',
		grass: 'Grass',
		gravel: 'Gravel',
		ice: 'Ice',
		macadam: 'Macadam',
		sand: 'Sand',
		snow: 'Snow',
		water: 'Water',
	},
};
