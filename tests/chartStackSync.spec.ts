/* A downloaded chart's layer is built by the pack reader, imported on first
 * use (MapView.svelte syncChartStack). Its mount, when the import lands,
 * checked only that no handle existed and the pack was the same: a chart
 * checked and unchecked while the reader loaded found no handle to remove
 * and was mounted anyway, drawn while the Layers tab and the hash said it
 * was off. In a dev session with a pack held and the reader's module held
 * back, a check and an uncheck left one layer on the chart's pane once the
 * module landed. The mount now reads the stack and the source as they are
 * when it lands. Read off the source, the notamMapViewSettle.spec.ts way:
 * the map cannot mount in a spec. */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const src = readFileSync(join(process.cwd(), 'src/lib/components/MapView.svelte'), 'utf8');

describe("the pack chart's late mount", () => {
	it('mounts only what the stack still holds', () => {
		const sync = src.slice(src.indexOf('function syncChartStack(): void {'));
		const at = sync.indexOf('void loadPackChartLayer().then((create) => {');
		expect(at).toBeGreaterThan(0);
		const guard = sync.slice(at, sync.indexOf('const layer = create(', at));
		expect(guard).toContain('!layers.chartStack.includes(id)');
		expect(guard).toContain("(import.meta.env.DEV ? layers.chartSource : 'public') !== source");
		expect(guard).toContain('packFile(id) !== pack');
		expect(guard).toContain('chartLayerHandles.has(id)');
	});
});
