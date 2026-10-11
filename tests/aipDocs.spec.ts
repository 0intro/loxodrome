// Offline AIP document packs (docs/offline-maps.md): the pack reader over a
// fixture written by the GO writer (internal/docpack, regenerate with
// `go test ./internal/docpack -run TestFixture -update`), and the entry-name
// rules the panels and cmd/aipdocs/enumerate.go have to agree on.
//
// Reading a fixture the other language produced is the point: a reader
// pinned against its own writer proves only that it is self-consistent, and
// the two halves of this format live in different languages.

import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { docBlob, docCount, hasDoc, readDocPack, DOC_PACK_MAGIC } from '../src/lib/offline/docPack';
import { supDocName, vacDocName, vacDocNameFor, vacSections } from '../src/lib/offline/docNames';
import { currentAiracString, nextAiracString } from '../src/lib/data/airac';

const fixture = readFileSync(fileURLToPath(new URL('./fixtures/mini-docs.pack', import.meta.url)));

function packFile(bytes: Uint8Array = fixture): File {
	return new File([bytes as unknown as BlobPart], 'mini-docs.pack');
}

describe('readDocPack', () => {
	it('reads a pack the Go writer produced', async () => {
		const pack = await readDocPack(packFile());
		expect(pack).not.toBeNull();
		expect(pack!.index.set).toBe('fr-vac');
		expect(pack!.index.cycle).toBe('06_AUG_2026');
		expect(pack!.index.effective).toBe('2026-08-06');
		// Documents the SIA did not publish are recorded, not hidden: a plate
		// absent from the pack is one the panel must not claim to hold.
		expect(pack!.index.missing).toEqual(['AD-2.LFZZ.pdf']);
		expect(docCount(pack!)).toBe(2);
	});

	it('slices each document back byte-exact', async () => {
		const pack = await readDocPack(packFile());
		expect(hasDoc(pack!, 'AD-2.LFPN.pdf')).toBe(true);
		expect(hasDoc(pack!, 'AD-2.LFZZ.pdf')).toBe(false);

		const blob = docBlob(pack!, 'AD-2.LFPN.pdf');
		expect(blob).not.toBeNull();
		expect(blob!.type).toBe('application/pdf');
		const text = await blob!.text();
		expect(text.startsWith('%PDF')).toBe(true);
		expect(text.trimEnd().endsWith('%%EOF')).toBe(true);
		expect(text).toContain('mini plate LFPN');

		// The second entry starts where the first ends, so an offset error
		// would show up as the wrong plate rather than as a parse failure.
		const hel = await docBlob(pack!, 'AD-3.LF075.pdf')!.text();
		expect(hel).toContain('mini helistation plate');
	});

	it('reads no document the pack does not carry', async () => {
		const pack = await readDocPack(packFile());
		expect(docBlob(pack!, 'AD-2.LFPG.pdf')).toBeNull();
	});

	it('rejects anything that is not a readable pack', async () => {
		expect(await readDocPack(packFile(new Uint8Array()))).toBeNull();
		expect(await readDocPack(packFile(new Uint8Array([1, 2, 3])))).toBeNull();
		const wrongMagic = new Uint8Array(fixture);
		wrongMagic[0] = 0x58;
		expect(await readDocPack(packFile(wrongMagic))).toBeNull();
		// Truncated mid-index: a half-written download must read as "no pack",
		// never as a pack with garbage offsets.
		expect(await readDocPack(packFile(fixture.subarray(0, 40)))).toBeNull();
	});

	it('refuses an entry pointing past the end of the file', async () => {
		// A pack truncated after its index parses, but its entries no longer
		// fit: slicing anyway would hand the panel a fragment of a chart.
		const head = fixture.subarray(0, fixture.length - 20);
		const pack = await readDocPack(packFile(head));
		expect(pack).not.toBeNull();
		expect(docBlob(pack!, 'AD-3.LF075.pdf')).toBeNull();
	});

	it('states the magic the Go writer writes', () => {
		expect(DOC_PACK_MAGIC).toBe('LOXDOCS1');
		expect(fixture.subarray(0, 8).toString()).toBe(DOC_PACK_MAGIC);
	});
});

describe('vac entry names', () => {
	it('maps a membership token to its Atlas VAC sections', () => {
		expect(vacSections('ad')).toEqual([2]);
		expect(vacSections('hel')).toEqual([3]);
		// "both" is a plate in each product, which is why the plate count
		// exceeds the number of idents that have any membership at all.
		expect(vacSections('both')).toEqual([2, 3]);
		expect(vacSections(null)).toEqual([]);
	});

	it('names a plate the way cmd/aipdocs packs it', () => {
		expect(vacDocName('LFPN', 2)).toBe('AD-2.LFPN.pdf');
		expect(vacDocName('lf075', 3)).toBe('AD-3.LF075.pdf');
	});

	it('offers the product matching the row it came from', () => {
		expect(vacDocNameFor('LFPO', 'both', false)).toBe('AD-2.LFPO.pdf');
		expect(vacDocNameFor('LFPO', 'both', true)).toBe('AD-3.LFPO.pdf');
		// A membership of one product answers with that product whatever the
		// row's kind, since it is the only plate published.
		expect(vacDocNameFor('LF075', 'hel', false)).toBe('AD-3.LF075.pdf');
		expect(vacDocNameFor('LFAC', 'ad', true)).toBe('AD-2.LFAC.pdf');
		expect(vacDocNameFor('LFXX', null, false)).toBeNull();
	});

	it('names the plate the fixture actually carries', async () => {
		const pack = await readDocPack(packFile());
		expect(hasDoc(pack!, vacDocName('LFPN', 2))).toBe(true);
		expect(hasDoc(pack!, vacDocNameFor('LF075', 'hel', true)!)).toBe(true);
	});
});

describe('supDocName', () => {
	const both = { urlPdf: 'https://x/l/f/lf_sup_2026_177_fr.pdf', urlPdfEn: 'https://x/l/f/lf_sup_2026_177_en.pdf' };
	const frOnly = { urlPdf: 'https://x/l/f/lf_sup_2026_009_fr.pdf', urlPdfEn: '' };

	it('takes the wanted language', () => {
		expect(supDocName(both, 'fr')).toBe('lf_sup_2026_177_fr.pdf');
		expect(supDocName(both, 'en')).toBe('lf_sup_2026_177_en.pdf');
	});

	it('falls back rather than dropping a supplement in force', () => {
		// Seven metropolitan supplements have no English translation, and the
		// English pack carries their French PDF for exactly this reason.
		expect(supDocName(frOnly, 'en')).toBe('lf_sup_2026_009_fr.pdf');
	});

	it('has no name for a row with no PDF at all', () => {
		expect(supDocName({ urlPdf: '', urlPdfEn: '' }, 'fr')).toBeNull();
	});
});

describe('nextAiracString', () => {
	it('names the cycle after the current one', () => {
		const t = Date.UTC(2026, 7, 16);
		expect(currentAiracString(t)).toBe('06_AUG_2026');
		expect(nextAiracString(t)).toBe('03_SEP_2026');
	});

	it('is the current cycle one period later', () => {
		const t = Date.UTC(2026, 7, 16);
		const cycle = 28 * 24 * 3600 * 1000;
		expect(nextAiracString(t)).toBe(currentAiracString(t + cycle));
	});
});
