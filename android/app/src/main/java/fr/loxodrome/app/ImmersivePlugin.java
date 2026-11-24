package fr.loxodrome.app;

import android.view.Window;
import androidx.core.view.WindowCompat;
import androidx.core.view.WindowInsetsCompat;
import androidx.core.view.WindowInsetsControllerCompat;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

/**
 * Immersive mode while a recording runs (docs/android.md "Adaptations"):
 * the web side's ui/flightScreen.ts hides the system bars when a flight
 * starts on the phone and shows them again when it stops. Hidden bars come
 * back transiently on a swipe from the edge (BEHAVIOR_SHOW_TRANSIENT_BARS_BY_
 * SWIPE), the Android convention for full-screen content, and hide again by
 * themselves. Capacitor keeps the WebView between the bars, so hiding them
 * grows the viewport; nothing else about the window changes.
 */
@CapacitorPlugin(name = "Immersive")
public class ImmersivePlugin extends Plugin {

    @PluginMethod
    public void hide(PluginCall call) {
        apply(true, call);
    }

    @PluginMethod
    public void show(PluginCall call) {
        apply(false, call);
    }

    private void apply(boolean hide, PluginCall call) {
        getActivity()
            .runOnUiThread(
                () -> {
                    Window window = getActivity().getWindow();
                    WindowInsetsControllerCompat controller = WindowCompat.getInsetsController(window, window.getDecorView());
                    if (hide) {
                        controller.setSystemBarsBehavior(WindowInsetsControllerCompat.BEHAVIOR_SHOW_TRANSIENT_BARS_BY_SWIPE);
                        controller.hide(WindowInsetsCompat.Type.systemBars());
                    } else {
                        controller.show(WindowInsetsCompat.Type.systemBars());
                    }
                    call.resolve();
                }
            );
    }
}
