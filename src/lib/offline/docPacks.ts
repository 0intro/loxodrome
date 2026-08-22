/* The AIP document packs that exist, and which document set each holds.
 *
 * A pack is one archive on the same Cloudflare Worker route the offline
 * chart packs use (`<worker>/<id>/archive`: GET streams, HEAD gives size and
 * ETag, a single Range resumes), so a document pack is a new object id on a
 * route that already works rather than any new plumbing.
 *
 * The Atlas VAC carries BOTH AIRAC slots, mirroring the datasets: its plate
 * URLs rotate every 28 days, so a pack is valid for exactly one cycle, and
 * the SIA publishes the next cycle's plates about a month ahead. The AIP
 * supplements have no slot at all; the SIA serves them from stable URLs, so
 * that set changes when a supplement is published or lapses.
 *
 * Locale-free and label-free by the layer-module rule: the UI maps an id to
 * its catalog key. */

const WORKER = 'https://oaci-tiles.alcyon.workers.dev';

export type DocPackId = 'fr-vac' | 'fr-vac-next' | 'fr-sup-fr' | 'fr-sup-en';

/** Which body of documents a pack holds, independent of its AIRAC slot. */
export type DocSet = 'vac' | 'sup';

export interface DocPackDef {
	id: DocPackId;
	set: DocSet;
	/** Which AIRAC slot a cycle-stamped set's pack is; null for a set with
	 *  no slot, whose contents do not rotate with the cycle. */
	slot: 'current' | 'next' | null;
	/** Language a single-language set was cut in. */
	lang: 'fr' | 'en' | null;
	archive: string;
}

export const DOC_PACKS: readonly DocPackDef[] = [
	{ id: 'fr-vac', set: 'vac', slot: 'current', lang: null, archive: `${WORKER}/fr-vac/archive` },
	{
		id: 'fr-vac-next',
		set: 'vac',
		slot: 'next',
		lang: null,
		archive: `${WORKER}/fr-vac-next/archive`,
	},
	{ id: 'fr-sup-fr', set: 'sup', slot: null, lang: 'fr', archive: `${WORKER}/fr-sup-fr/archive` },
	{ id: 'fr-sup-en', set: 'sup', slot: null, lang: 'en', archive: `${WORKER}/fr-sup-en/archive` },
] as const;

const BY_ID = new Map<DocPackId, DocPackDef>(DOC_PACKS.map((d) => [d.id, d]));

export function docPackDef(id: DocPackId): DocPackDef | undefined {
	return BY_ID.get(id);
}

/** The supplement pack for one resolved language. */
export function supPackId(lang: 'fr' | 'en'): DocPackId {
	return lang === 'en' ? 'fr-sup-en' : 'fr-sup-fr';
}
