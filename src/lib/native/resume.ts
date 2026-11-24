/* Whether the Android shell built this page from saved state
 * (ResumePlugin.java, docs/android.md "Coming back where the pilot was"):
 * after the WebView's renderer died, or after Android ended the process
 * behind another app and the pilot came back to it. A launch from the icon
 * answers false. Dynamic-imported behind isNativeApp() like every plugin,
 * the handle parked in a module `let` (never resolved through a promise: a
 * Capacitor handle is a Proxy that answers `.then`, docs/android.md). An
 * older shell without the plugin rejects, and that reads as a fresh start. */
interface ResumePlugin {
	restored(): Promise<{ restored: boolean }>;
}

let plugin: ResumePlugin | null = null;

export async function shellRestored(): Promise<boolean> {
	try {
		if (!plugin) {
			const { registerPlugin } = await import('@capacitor/core');
			plugin = registerPlugin<ResumePlugin>('Resume');
		}
		return (await plugin.restored()).restored === true;
	} catch {
		return false;
	}
}
