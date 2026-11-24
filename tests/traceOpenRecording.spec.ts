/* A trace file never opens over a running recording (state/openFile.svelte.ts
 * openTrace / applyTrace). The import replaces the live trace, and in the
 * Android shell the stop it implied handed the flight's archive to a native
 * finalize that the import's generation bump then abandoned: the recorded
 * flight was lost. The dispatcher refuses at the door, and again after its
 * questions, since a cold start through "Open with" can resume a recording
 * while the altitude question is open. */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { memoryStorage } from './helpers/storage';

// The dispatcher reaches Leaflet through the map fit; nothing here draws.
vi.mock('leaflet', () => ({ default: {} }));

const GPX = `<?xml version="1.0" encoding="UTF-8"?>
<gpx version="1.1" creator="spec" xmlns="http://www.topografix.com/GPX/1/1"><trk><trkseg>
<trkpt lat="48.85" lon="2.35"><ele>100</ele><time>2026-09-01T12:00:00Z</time></trkpt>
<trkpt lat="48.86" lon="2.35"><ele>120</ele><time>2026-09-01T12:00:10Z</time></trkpt>
</trkseg></trk></gpx>`;

/** An IGC file that states no altitude reference, so the dispatcher asks. */
const IGC = ['AXXX001', 'HFDTE010926', 'B1200004851000N00221000EA0050000600', 'B1200104851600N00221000EA0050000620', ''].join(
	'\n',
);

const bytes = (text: string): Uint8Array => new TextEncoder().encode(text);

beforeEach(() => {
	vi.resetModules();
	vi.stubGlobal('localStorage', memoryStorage());
	vi.stubGlobal(
		'fetch',
		vi.fn(() => Promise.resolve(new Response('{}', { status: 404 }))),
	);
});

afterEach(() => {
	vi.unstubAllGlobals();
});

async function load() {
	const nav = await import('$lib/state/navRecording.svelte');
	const open = await import('$lib/state/openFile.svelte');
	return { ...nav, ...open };
}

const recorded = [
	{ lat: 48.6, lon: 2.4, timeMs: Date.parse('2026-09-01T10:00:00Z'), altFt: 1500, speedKt: 95 },
	{ lat: 48.61, lon: 2.42, timeMs: Date.parse('2026-09-01T10:00:10Z'), altFt: 1500, speedKt: 95 },
];

describe('a trace file during a recording', () => {
	it('is refused at the door, the recording untouched', { timeout: 30_000 }, async () => {
		const m = await load();
		m.nav.points = recorded.map((p) => ({ ...p }));
		m.nav.recording = true;
		await m.openIncomingBytes('lesson.gpx', bytes(GPX));
		expect(m.openFile.failure).toEqual({ name: 'lesson.gpx', reason: 'recording', detail: '' });
		expect(m.openFile.pendingTrace).toBeNull();
		expect(m.nav.recording).toBe(true);
		expect(m.nav.points.map((p) => p.timeMs)).toEqual(recorded.map((p) => p.timeMs));
	});

	it('is refused when the recording starts under its altitude question', { timeout: 30_000 }, async () => {
		const m = await load();
		const done = m.openIncomingBytes('lesson.igc', bytes(IGC));
		await vi.waitFor(() => {
			expect(m.openFile.askingDatum).toBe(true);
		});
		// The boot reconcile resumes the shell's recording meanwhile.
		m.nav.points = recorded.map((p) => ({ ...p }));
		m.nav.recording = true;
		m.answerTraceDatum('msl');
		await done;
		expect(m.openFile.failure).toEqual({ name: 'lesson.igc', reason: 'recording', detail: '' });
		expect(m.nav.points.map((p) => p.timeMs)).toEqual(recorded.map((p) => p.timeMs));
	});

	it('opens as before once the flight is stopped', { timeout: 30_000 }, async () => {
		const m = await load();
		await m.openIncomingBytes('lesson.gpx', bytes(GPX));
		expect(m.openFile.failure).toBeNull();
		expect(m.nav.points).toHaveLength(2);
		expect(m.nav.points[0].timeMs).toBe(Date.parse('2026-09-01T12:00:00Z'));
	});
});
