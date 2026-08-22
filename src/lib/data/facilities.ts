/* Loader and types for the aerodrome-facilities dataset
 * (public/data/fr-aerodrome-facilities.json). cmd/fr emits one record per ident
 * from the SIA AIXM 4.5 AD-2 entities (Ahp header + Ahs / Pfy / Aha):
 * situation / ARP / operating-hours header strings plus category-tagged
 * handling services, passenger facilities and operator contacts; plus, for the
 * ~275 helipads, the AD 1.3-2 directory the proprietary XML publishes and the
 * AIXM does not (see the `directory` column). The AD 2 prose is bilingual
 * "French\\English" and the helipad prose French only; AirportDetail renders
 * both through formatAipRemark, which splits the first and passes the second
 * through. FR-only; lazy-loaded when an airport detail panel opens (see
 * ensureAerodromeFacilities). */

/** One category-tagged facility entry. */
export interface FacilityItem {
	/** Language-neutral category code (fuel / fire / restaurant / phone / ...),
	 *  labelled per section via t.data.facility{Services,Passenger,Contact}. */
	cat: string;
	/** Bilingual description (services / passenger) or raw value (contact). */
	text: string;
}

/** One aerodrome's AD-2 directory content. */
export interface AerodromeFacilities {
	ident: string;
	/** Situation (AD 2.2), bilingual; '' when absent. */
	site: string;
	/** ARP reference-point description (AD 2.2), bilingual; '' when absent. */
	arp: string;
	/** Operating-hours remark (AD 2.3), bilingual; '' when absent. */
	hours: string;
	/** RFFS category token ("7" aeroplane / "H1" helicopter), or ''. */
	fireCat: string;
	/** Handling and emergency services (AD 2.4 / 2.6 / 2.7). */
	services: FacilityItem[];
	/** Passenger facilities (AD 2.5). */
	passenger: FacilityItem[];
	/** Operator contact (AD 2.2), and the helipad operator (AD 1.3-2). */
	contact: FacilityItem[];
	/** The AIP directory items with no column of their own. For France, the
	 *  helipad block of AD 1.3-2 (status / performance class / night /
	 *  rooftop / FATO / TLOF / surface / strength / remark); for the AIXM
	 *  publishers, the typed annotations their AD 2 carries (usage rules,
	 *  wind indicator, power supply). A few carry CODES the panel labels
	 *  (`TPD`, `oui`, `hostile habitée`); the rest is AIP free text shown
	 *  verbatim, like the prose beside it. */
	directory: FacilityItem[];
}

// Positional row layout, matching facilitiesOutputFields in cmd/fr/facilities.go.
type ItemRow = readonly [cat: string, text: string];
type FacilitiesRow = readonly [
	ident: string,
	site: string,
	arp: string,
	hours: string,
	fireCat: string,
	services: readonly ItemRow[],
	passenger: readonly ItemRow[],
	contact: readonly ItemRow[],
	directory?: readonly ItemRow[],
];

interface RawFacilities {
	fields: string[];
	itemFields?: string[];
	rows: readonly FacilitiesRow[];
}

function rowToItem(r: ItemRow): FacilityItem {
	return { cat: r[0], text: r[1] };
}

function rowToFacilities(r: FacilitiesRow): AerodromeFacilities {
	return {
		ident: r[0],
		site: r[1],
		arp: r[2],
		hours: r[3],
		fireCat: r[4],
		services: r[5].map(rowToItem),
		passenger: r[6].map(rowToItem),
		contact: r[7].map(rowToItem),
		directory: (r[8] ?? []).map(rowToItem),
	};
}

/** Default URL; the caller may override to fetch the pre-release
 *  fr-aerodrome-facilities.next.json once it becomes active. */
export const FR_FACILITIES_URL = '/data/fr-aerodrome-facilities.json';

/** Pre-release facilities URL (cmd/fr -target auto / next). */
export const FR_FACILITIES_NEXT_URL = '/data/fr-aerodrome-facilities.next.json';

/** The other publishers' facilities datasets (internal/aixm5build for the
 *  AIXM 5.1 three, cmd/be's AD 2 / AD 3 page scrape for Belgium). Same
 *  schema, so one loader serves them all; only Belgium and Germany publish
 *  a pre-release slot. */
export const BE_FACILITIES_URL = '/data/be-aerodrome-facilities.json';
export const BE_FACILITIES_NEXT_URL = '/data/be-aerodrome-facilities.next.json';
export const DE_FACILITIES_URL = '/data/de-aerodrome-facilities.json';
export const DE_FACILITIES_NEXT_URL = '/data/de-aerodrome-facilities.next.json';
export const UK_FACILITIES_URL = '/data/uk-aerodrome-facilities.json';
export const ES_FACILITIES_URL = '/data/es-aerodrome-facilities.json';
export const GE_FACILITIES_URL = '/data/ge-aerodrome-facilities.json';

/** Load the AD-2 facilities artefact. Fail-soft: an HTTP error OR a non-JSON
 *  200 (Vite dev's SPA fallback) returns [] so the airport panel still renders
 *  the rest of its sections. */
export async function loadFacilities(
	url: string = FR_FACILITIES_URL,
): Promise<AerodromeFacilities[]> {
	const res = await fetch(url);
	if (!res.ok) {
		console.warn(`${url}: HTTP ${res.status}`);
		return [];
	}
	const ct = res.headers.get('content-type') ?? '';
	if (!ct.includes('json')) {
		console.warn(`${url}: not JSON (got ${ct || 'no content-type'})`);
		return [];
	}
	const data = (await res.json()) as RawFacilities;
	return data.rows.map(rowToFacilities);
}
