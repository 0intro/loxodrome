package fr.loxodrome.app;

import android.content.Intent;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.os.SystemClock;
import android.view.View;
import android.view.ViewGroup;
import android.webkit.RenderProcessGoneDetail;
import android.webkit.WebView;
import androidx.core.graphics.Insets;
import androidx.core.view.ViewCompat;
import androidx.core.view.WindowInsetsCompat;
import com.getcapacitor.BridgeActivity;
import com.getcapacitor.Logger;
import com.getcapacitor.WebViewListener;

public class MainActivity extends BridgeActivity {

    /** A page whose renderer dies again this soon after a rebuild ends the app. */
    private static final long REBUILD_GUARD_MS = 60_000L;

    /** When a dead renderer last rebuilt the page (elapsedRealtime), -1
     *  before any: process-wide, since the rebuild is a new activity. */
    private static long rebuiltAtMs = -1;

    /** Built from saved state, as ResumePlugin answers the page. */
    boolean restored;

    @Override
    public void onCreate(Bundle savedInstanceState) {
        restored = savedInstanceState != null;
        // BridgeActivity hands getIntent() to the plugins on every creation,
        // and a recreated activity, or one relaunched from recents, still
        // holds the VIEW or SEND that first started it: the file it carried
        // would open again. A new one arrives through onNewIntent.
        if (savedInstanceState != null || (getIntent().getFlags() & Intent.FLAG_ACTIVITY_LAUNCHED_FROM_HISTORY) != 0) {
            setIntent(new Intent(Intent.ACTION_MAIN));
        }
        // Local plugins register before super.onCreate builds the bridge.
        registerPlugin(PrintPlugin.class);
        registerPlugin(SendFplPlugin.class);
        registerPlugin(OpenFilePlugin.class);
        registerPlugin(OpenDocumentPlugin.class);
        registerPlugin(NavRecorderPlugin.class);
        registerPlugin(ImmersivePlugin.class);
        registerPlugin(ReminderPlugin.class);
        registerPlugin(ResumePlugin.class);
        super.onCreate(savedInstanceState);
        // The window's content root, the view that fits system windows.
        View root = ((ViewGroup) getWindow().getDecorView()).getChildAt(0);
        ViewCompat.setOnApplyWindowInsetsListener(root, (v, insets) -> ViewCompat.onApplyWindowInsets(v, barsAboveKeyboard(insets)));
        getBridge().addWebViewListener(
            new WebViewListener() {
                @Override
                public boolean onRenderProcessGone(WebView view, RenderProcessGoneDetail detail) {
                    return rebuildPage(view, detail.didCrash());
                }
            }
        );
    }

    /**
     * The WebView's renderer died: the system took its memory while the app
     * sat behind another one, or it crashed (docs/android.md "The renderer's
     * death"). Left unanswered, Chromium kills the whole process, the flight
     * recorder's service with it. The activity is built again instead, a new
     * WebView and a new page in the same process, while the recorder runs on,
     * its seam to the page marked dead until the new page loads its plugin. A
     * second death within REBUILD_GUARD_MS of a rebuild is left to Chromium,
     * so a page that kills its own renderer cannot rebuild without end.
     *
     * The dead WebView is taken out of the window and destroyed at once, as
     * Android asks ("Termination handling API", developer.android.com):
     * recreate() leaves it alive, and the next renderer then counts it,
     * reporting its own death twice, which the guard reads as a second one
     * (measured on the Redmi Note 12 5G).
     */
    private boolean rebuildPage(WebView view, boolean crashed) {
        NavRecorderPlugin.webDied();
        long now = SystemClock.elapsedRealtime();
        if (rebuiltAtMs >= 0 && now - rebuiltAtMs < REBUILD_GUARD_MS) {
            Logger.warn("MainActivity: the renderer died again after a rebuild, ending the app");
            return false;
        }
        rebuiltAtMs = now;
        Logger.warn("MainActivity: the renderer " + (crashed ? "crashed" : "was killed") + ", rebuilding the page");
        ViewGroup parent = (ViewGroup) view.getParent();
        if (parent != null) {
            parent.removeView(view);
        }
        view.destroy();
        new Handler(Looper.getMainLooper()).post(() -> {
            if (!isFinishing() && !isDestroyed()) {
                recreate();
            }
        });
        return true;
    }

    /**
     * The insets less the bottom bar the keyboard covers (docs/android.md
     * "System bars"). With the keyboard up, Capacitor's SystemBars pads the
     * decor by the keyboard's inset, which runs to the screen's bottom edge
     * over the navigation bar, and still hands the content root the bar's
     * inset. Up to Android 14 that root fits system windows and would pad by
     * the bar again, an empty strip the bar's height (130 px on a Redmi Note
     * 12) between the page and the keyboard. From Android 15 the root fits
     * nothing, and the page reads the bar's inset only where the keyboard
     * leaves it showing.
     */
    static WindowInsetsCompat barsAboveKeyboard(WindowInsetsCompat insets) {
        if (!insets.isVisible(WindowInsetsCompat.Type.ime())) {
            return insets;
        }
        Insets bars = insets.getInsets(WindowInsetsCompat.Type.systemBars());
        int bottom = Math.max(0, bars.bottom - insets.getInsets(WindowInsetsCompat.Type.ime()).bottom);
        if (bottom == bars.bottom) {
            return insets;
        }
        return new WindowInsetsCompat.Builder(insets)
            .setInsets(WindowInsetsCompat.Type.systemBars(), Insets.of(bars.left, bars.top, bars.right, bottom))
            .build();
    }
}
