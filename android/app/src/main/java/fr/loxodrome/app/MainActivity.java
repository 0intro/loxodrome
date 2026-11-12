package fr.loxodrome.app;

import android.os.Bundle;
import android.view.View;
import android.view.ViewGroup;
import androidx.core.graphics.Insets;
import androidx.core.view.ViewCompat;
import androidx.core.view.WindowInsetsCompat;
import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {

    @Override
    public void onCreate(Bundle savedInstanceState) {
        // Local plugins register before super.onCreate builds the bridge.
        registerPlugin(PrintPlugin.class);
        registerPlugin(SendFplPlugin.class);
        registerPlugin(OpenFilePlugin.class);
        registerPlugin(OpenDocumentPlugin.class);
        registerPlugin(NavRecorderPlugin.class);
        registerPlugin(ImmersivePlugin.class);
        super.onCreate(savedInstanceState);
        // The window's content root, the view that fits system windows.
        View root = ((ViewGroup) getWindow().getDecorView()).getChildAt(0);
        ViewCompat.setOnApplyWindowInsetsListener(root, (v, insets) -> ViewCompat.onApplyWindowInsets(v, barsAboveKeyboard(insets)));
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
