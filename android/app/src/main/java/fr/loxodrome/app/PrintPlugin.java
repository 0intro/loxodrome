package fr.loxodrome.app;

import android.content.Context;
import android.os.Handler;
import android.os.Looper;
import android.print.PrintAttributes;
import android.print.PrintDocumentAdapter;
import android.print.PrintJob;
import android.print.PrintManager;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

/**
 * window.print() is a no-op inside an Android WebView, so the web side's
 * printPage() ($lib/ui/print.ts) calls this instead: the WebView's own print
 * adapter is handed to the Android print framework (system dialog with Save
 * as PDF), which renders the page with its @media print CSS applied.
 *
 * The sheet, however, does NOT come from that CSS. On Android the media is
 * whatever PrintAttributes says, and an empty one leaves the framework to
 * pick its own default (ISO A4 portrait here). Chromium still lays the page
 * out at the size `@page` asks for and then SCALES that box onto the media it
 * was given, so every landscape flow used to land on a portrait sheet at
 * ~71%, filling the top 41% and spilling onto a second sheet (measured on the
 * Redmi, 2026-08-16). The web side therefore states the orientation and it
 * rides here as a print attribute.
 *
 * Both orientations pin A4, because that is the size every one of the app's
 * `@page` rules names, the static `@page { size: a4 portrait }` in
 * NavLogModal and FlightPrepModal included. Leaving portrait to the
 * framework's own default only looked right on an A4 device; on a Letter
 * default it would have laid out A4 and been scaled, exactly as landscape
 * was. These are the job's INITIAL attributes, so the print dialog still
 * lets the user pick another paper.
 *
 * The call resolves when the print JOB ends (completed, cancelled or failed),
 * not when the dialog opens: the page keeps its print-claim classes applied
 * until then, so a paper-size change re-rendering the adapter still sees the
 * print state (see printPage's synthetic afterprint).
 */
@CapacitorPlugin(name = "Print")
public class PrintPlugin extends Plugin {

    private static final long POLL_MS = 500;

    @PluginMethod
    public void print(PluginCall call) {
        String name = call.getString("name", "Loxodrome");
        final String jobName = (name == null || name.isEmpty()) ? "Loxodrome" : name;
        final boolean landscape = Boolean.TRUE.equals(call.getBoolean("landscape", false));
        getActivity()
            .runOnUiThread(
                () -> {
                    PrintManager manager = (PrintManager) getActivity().getSystemService(Context.PRINT_SERVICE);
                    if (manager == null) {
                        call.reject("print service unavailable");
                        return;
                    }
                    PrintAttributes.Builder attributes = new PrintAttributes.Builder();
                    attributes.setMediaSize(
                        landscape
                            ? PrintAttributes.MediaSize.ISO_A4.asLandscape()
                            : PrintAttributes.MediaSize.ISO_A4.asPortrait()
                    );
                    PrintDocumentAdapter adapter = getBridge().getWebView().createPrintDocumentAdapter(jobName);
                    PrintJob job = manager.print(jobName, adapter, attributes.build());
                    watch(job, call);
                }
            );
    }

    private void watch(PrintJob job, PluginCall call) {
        Handler handler = new Handler(Looper.getMainLooper());
        Runnable poll = new Runnable() {
            @Override
            public void run() {
                if (job.isCompleted() || job.isCancelled() || job.isFailed()) {
                    call.resolve();
                } else {
                    handler.postDelayed(this, POLL_MS);
                }
            }
        };
        handler.postDelayed(poll, POLL_MS);
    }
}
