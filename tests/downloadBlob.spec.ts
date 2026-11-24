/* A file export in the Android shell (ui/dom.ts downloadBlob): the WebView
 * ignores blob: downloads, so the file is written to the app cache and
 * handed to the share sheet. That ran unobserved, so a write the device
 * refused (a full device, a large flights bundle) was an unhandled
 * rejection, no share sheet came up, and the caller read the export as
 * done. The promise now settles with the hand-over and rejects with the
 * failed write; a dismissed share sheet is no failure. */
import { afterEach, describe, expect, it, vi } from 'vitest';

const shell = vi.hoisted(() => ({ fail: false, written: [] as string[], shared: 0, dismiss: false }));

vi.mock('$lib/native/platform', () => ({ isNativeApp: () => true }));
vi.mock('@capacitor/filesystem', () => {
	const write = (op: string) => (o: { path: string }): Promise<{ uri: string }> => {
		if (shell.fail) {
			return Promise.reject(new Error('No space left on device'));
		}
		shell.written.push(`${op} ${o.path}`);
		return Promise.resolve({ uri: `file:///cache/${o.path}` });
	};
	return {
		Directory: { Cache: 'CACHE' },
		Encoding: { UTF8: 'utf8' },
		Filesystem: { writeFile: write('write'), appendFile: write('append') },
	};
});
vi.mock('@capacitor/share', () => ({
	Share: {
		share: (): Promise<void> => {
			shell.shared++;
			return shell.dismiss ? Promise.reject(new Error('Share canceled')) : Promise.resolve();
		},
	},
}));

const { downloadBlob } = await import('$lib/ui/dom');

afterEach(() => {
	shell.fail = false;
	shell.written = [];
	shell.shared = 0;
	shell.dismiss = false;
});

describe('downloadBlob in the Android shell', () => {
	it('settles once the file is written and handed to the share sheet', async () => {
		await expect(downloadBlob('version: 1\n', 'plan.yaml', 'text/yaml')).resolves.toBeUndefined();
		expect(shell.written).toEqual(['write plan.yaml']);
		expect(shell.shared).toBe(1);
	});

	it('rejects with a write the device refused, before any share sheet', async () => {
		shell.fail = true;
		await expect(downloadBlob('version: 1\n', 'plan.yaml', 'text/yaml')).rejects.toThrow('No space left on device');
		await expect(downloadBlob(new Blob(['PK']), 'flights.zip', 'application/zip')).rejects.toThrow(
			'No space left on device',
		);
		expect(shell.shared).toBe(0);
	});

	it('takes a dismissed share sheet as done', async () => {
		shell.dismiss = true;
		await expect(downloadBlob('x', 'a.csv', 'text/csv')).resolves.toBeUndefined();
		expect(shell.shared).toBe(1);
	});
});
