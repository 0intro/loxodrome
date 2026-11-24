package fr.loxodrome.app;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

/**
 * Whether the activity was built from saved state (docs/android.md "Coming
 * back where the pilot was"): after the WebView's renderer died and
 * MainActivity rebuilt it, or after Android ended the process behind
 * another app and the pilot came back to the task. A launch from the icon
 * is a fresh start. The page asks once at boot, through native/resume.ts,
 * and comes back where the pilot was (state/resume.svelte.ts).
 */
@CapacitorPlugin(name = "Resume")
public class ResumePlugin extends Plugin {

    @PluginMethod
    public void restored(PluginCall call) {
        JSObject ret = new JSObject();
        ret.put("restored", getActivity() instanceof MainActivity && ((MainActivity) getActivity()).restored);
        call.resolve(ret);
    }
}
