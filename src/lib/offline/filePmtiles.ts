/* A pmtiles Source over a local File (the OPFS archive): every read is a
 * slice, so serving tiles never loads the multi-GB archive into memory.
 * The library caches the parsed header + directories per PMTiles instance,
 * leaving tile-data reads as the only recurring slices. */

import { PMTiles, type RangeResponse, type Source } from 'pmtiles';

class FileSource implements Source {
	constructor(
		private readonly file: File,
		private readonly key: string,
	) {}

	getKey(): string {
		return this.key;
	}

	async getBytes(offset: number, length: number): Promise<RangeResponse> {
		const data = await this.file.slice(offset, offset + length).arrayBuffer();
		return { data };
	}
}

export function pmtilesFromFile(file: File, key: string): PMTiles {
	return new PMTiles(new FileSource(file, key));
}

/** What a base-map pack's map and its manager row need from the archive. */
export interface ArchiveInfo {
	minZoom: number;
	maxZoom: number;
	/** The metadata's `version`, the date IGN's tiles were harvested: the
	 *  "date de dernière mise à jour" the Licence Ouverte asks a reuse to
	 *  state. Null when the archive carries none. */
	edition: string | null;
}

/** Per File, so a new edition (a new File) is read afresh. */
const infos = new WeakMap<File, Promise<ArchiveInfo>>();

/** The header's zooms and the metadata's edition, read once per File. */
export function archiveInfo(file: File, key: string): Promise<ArchiveInfo> {
	let p = infos.get(file);
	if (!p) {
		const pm = pmtilesFromFile(file, key);
		p = Promise.all([pm.getHeader(), pm.getMetadata().catch(() => null)]).then(([h, meta]) => {
			const v = (meta as { version?: unknown } | null)?.version;
			return {
				minZoom: h.minZoom,
				maxZoom: h.maxZoom,
				edition: typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v) ? v : null,
			};
		});
		infos.set(file, p);
		// A failed read is not remembered: the next ask tries again.
		p.catch(() => infos.delete(file));
	}
	return p;
}
