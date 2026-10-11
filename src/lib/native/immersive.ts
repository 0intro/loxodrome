/* The Android shell's immersive mode (ImmersivePlugin.java): the system
 * bars hidden while a recording runs, shown again at the stop
 * (ui/flightScreen.ts is the one caller). Dynamic-imported behind
 * isNativeApp() like every plugin, the handle parked in a module `let`
 * (never resolved through a promise: a Capacitor handle is a Proxy that
 * answers `.then`, docs/android.md). An older shell without the plugin
 * rejects and the bars simply stay. */
interface ImmersivePlugin {
	hide(): Promise<void>;
	show(): Promise<void>;
}

let plugin: ImmersivePlugin | null = null;

export async function setImmersive(on: boolean): Promise<void> {
	try {
		if (!plugin) {
			const { registerPlugin } = await import('@capacitor/core');
			plugin = registerPlugin<ImmersivePlugin>('Immersive');
		}
		await (on ? plugin.hide() : plugin.show());
	} catch {
		/* no plugin in this shell, or the activity is gone: the bars stay */
	}
}
