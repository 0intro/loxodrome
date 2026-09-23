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
