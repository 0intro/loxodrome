/* Is this archive one file or many?
 *
 * Two ZIP containers arrive at the same doors, and telling them apart is the
 * whole job of this module:
 *
 *  - a KMZ, which IS one trace (a .kml plus the images it references);
 *  - a flights bundle, which is a whole library (docs/flights-library.md).
 *
 * The test is neither the extension nor a manifest inside: it is HOW MANY
 * MEMBERS THIS APPLICATION RECOGNISES. A KMZ yields exactly one, a bundle
 * yields several. That is what lets the bundle carry no format of its own,
 * and it is also what keeps a bundle whose traces happen to be KML - the
 * one case a "does it contain a .kml?" test would get wrong - from being
 * read as a single Google Earth file.
 *
 * A member the sniffer does not recognise is dropped without a word: a KMZ's
 * images are the everyday case, and an archive is a container rather than a
 * pick, so its contents are not a list of things the user asked for.
 *
 * Pure (no Svelte, no I/O), over the container reader and the sniffer. */

import { detectFileKind, type FileKind } from './detect';
import { isZipBytes, zipEntries } from './kmz';

/** One file for an importer: the text it sniffs by, the BYTES it must file
 *  from, and the stamp a bundle member carries. */
export interface IncomingItem {
	name: string;
	text: string;
	bytes?: Uint8Array | undefined;
	mtimeMs?: number | undefined;
}

/** THE one place a classified container becomes import items, so the doors
 *  cannot disagree about what rides along. They did: the openFile dispatcher
 *  built this list itself and carried only `{name, text}`, so a bundle
 *  arriving by "Open with" filed every trace from a RE-ENCODING of its
 *  decoded text - which loses a BOM and turns any non-UTF-8 byte into U+FFFD
 *  - while the same bundle picked in the surface kept its bytes. Measured on
 *  a Latin-1 IGC: identical off the desktop picker, corrupt off the phone's
 *  intent. */
export function itemsOf(name: string, incoming: Incoming): IncomingItem[] {
	switch (incoming.kind) {
		case 'bundle':
			return incoming.members.map((m) => ({
				name: m.name,
				text: m.text,
				bytes: m.bytes,
				mtimeMs: m.mtimeMs,
			}));
		case 'single':
			return [{ name: incoming.name, text: incoming.text, bytes: incoming.bytes }];
		case 'empty':
			return [{ name, text: '' }];
	}
}

export interface ArchiveMember {
	name: string;
	text: string;
	/** The member's own bytes; `text` is a lossy decoding of them (ZipMember). */
	bytes: Uint8Array;
	/** The member's stored timestamp (ZipMember). */
	mtimeMs: number;
	kind: FileKind;
}

/** Is this member a trace? Only a trace can be what an archive is PACKAGING
 *  (that is what a KMZ is); an archive holding one plan is a library with one
 *  plan in it, and treating it as a loose route file would load it straight
 *  into the workspace and replace what the pilot is flying. */
function isTraceMember(m: ArchiveMember): boolean {
	return m.kind === 'gpx' || m.kind === 'igc' || m.kind === 'kml';
}

/** Every member of an archive this application can read, in directory order.
 *  Empty for an archive holding nothing it recognises. Throws only when the
 *  bytes are not a readable archive at all. */
export async function readArchive(bytes: Uint8Array): Promise<ArchiveMember[]> {
	const out: ArchiveMember[] = [];
	for (const m of await zipEntries(bytes)) {
		const kind = detectFileKind(m.name, m.text);
		if (kind !== null) {
			out.push({ name: m.name, text: m.text, bytes: m.bytes, mtimeMs: m.mtimeMs, kind });
		}
	}
	return out;
}

/** What one incoming file turns out to be. `single` covers a plain file and
 *  a KMZ alike, so a caller that only ever handles one document needs no
 *  container branch of its own. */
export type Incoming =
	| { kind: 'single'; name: string; text: string; bytes: Uint8Array }
	| { kind: 'bundle'; members: ArchiveMember[] }
	/** An archive we could open and found nothing readable in. */
	| { kind: 'empty' };

/** Classify incoming bytes. Non-archive bytes are decoded as text and
 *  reported `single`, exactly as before containers existed. */
export async function readIncoming(name: string, bytes: Uint8Array): Promise<Incoming> {
	if (!isZipBytes(bytes)) {
		return { kind: 'single', name, text: new TextDecoder().decode(bytes), bytes };
	}
	const members = await readArchive(bytes);
	if (members.length === 0) {
		return { kind: 'empty' };
	}
	const only = members[0];
	if (members.length === 1 && isTraceMember(only)) {
		// A KMZ: the archive is packaging around ONE trace, not content of its
		// own. The OUTER name is what is passed on: Google Earth always writes
		// `doc.kml`, so three tours saved as Vol_LFQB.kmz, Vol_Etampes.kmz and
		// Vol_Chartres.kmz would otherwise all be filed, exported and reported
		// as "doc.kml", and the name the user gave the file is not recoverable
		// from anywhere else.
		return { kind: 'single', name: name || only.name, text: only.text, bytes: only.bytes };
	}
	return { kind: 'bundle', members };
}
