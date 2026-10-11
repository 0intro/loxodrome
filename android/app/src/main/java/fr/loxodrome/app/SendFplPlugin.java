package fr.loxodrome.app;

import android.content.ActivityNotFoundException;
import android.content.Intent;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

/**
 * Hand a route to SendFPL (app.sendfpl), which uploads it to a Garmin
 * navigator over Connext. SendFPL claims ACTION_SEND / text/plain and puts the
 * shared text in its route box, where the pilot reviews it before uploading;
 * setting the package makes this button open SendFPL itself instead of a sheet
 * listing every app that takes text.
 *
 * A rejection here is not an error the user has to read: the web side
 * ($lib/native/sendfpl.ts) falls back to the ordinary share sheet, which
 * SendFPL claims too. The manifest's <queries> entry is what makes the package
 * visible; without it Android 11+ hides SendFPL and the explicit intent throws
 * even when it is installed.
 */
@CapacitorPlugin(name = "SendFpl")
public class SendFplPlugin extends Plugin {

    private static final String SENDFPL_PACKAGE = "app.sendfpl";

    @PluginMethod
    public void send(PluginCall call) {
        String route = call.getString("route", "");
        if (route == null || route.trim().isEmpty()) {
            call.reject("empty route");
            return;
        }
        Intent intent = new Intent(Intent.ACTION_SEND);
        intent.setType("text/plain");
        intent.setPackage(SENDFPL_PACKAGE);
        intent.putExtra(Intent.EXTRA_TEXT, route);
        if (intent.resolveActivity(getContext().getPackageManager()) == null) {
            call.reject("SendFPL is not installed");
            return;
        }
        try {
            getActivity().startActivity(intent);
            call.resolve();
        } catch (ActivityNotFoundException e) {
            call.reject("SendFPL is not installed");
        }
    }
}
