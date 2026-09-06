package fr.loxodrome.app;

import android.Manifest;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.os.Build;
import android.os.PowerManager;
import android.provider.Settings;
import androidx.core.content.ContextCompat;
import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.PermissionState;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.getcapacitor.annotation.Permission;
import com.getcapacitor.annotation.PermissionCallback;
import org.json.JSONException;
import org.json.JSONObject;

/**
 * The web app's handle on the background flight recorder
 * (NavRecorderService + NavJournal; contract in docs/android.md, web side in
 * $lib/native/navRecorder.ts + $lib/state/navRecording.svelte.ts).
 *
 * start() owns the permission ordering: the location grant MUST precede
 * startForegroundService, because starting a location-type foreground
 * service without one throws SecurityException on API 34+. A refused
 * notification permission never blocks the recording (the service still
 * runs; only the drawer card is suppressed), and a location refusal rejects
 * with "denied", the code the web app already localizes.
 *
 * The service reaches the WebView through the static seam below: `instance`
 * is the one plugin instance of the live bridge (volatile, read at each
 * emission, never cached), set at load() and cleared by handleOnDestroy() or
 * by the service's onTaskRemoved (swipe-away can kill the activity without
 * the destroy hook running). Events are emitted with retention OFF: the
 * journal already covers a rebuilt WebView, and a retained flood would
 * replay into it.
 */
@CapacitorPlugin(
    name = "NavRecorder",
    permissions = {
        @Permission(alias = NavRecorderPlugin.ALIAS_LOCATION, strings = { Manifest.permission.ACCESS_FINE_LOCATION }),
        @Permission(alias = NavRecorderPlugin.ALIAS_COARSE, strings = { Manifest.permission.ACCESS_COARSE_LOCATION }),
        @Permission(alias = NavRecorderPlugin.ALIAS_NOTIFICATIONS, strings = { Manifest.permission.POST_NOTIFICATIONS })
    }
)
public class NavRecorderPlugin extends Plugin {

    static final String ALIAS_LOCATION = "location";
    static final String ALIAS_COARSE = "coarseLocation";
    static final String ALIAS_NOTIFICATIONS = "notifications";

    private static final String EVENT_FIX = "fix";
    private static final String EVENT_STOPPED = "stopped";

    private static volatile NavRecorderPlugin instance;

    @Override
    public void load() {
        instance = this;
    }

    @Override
    protected void handleOnDestroy() {
        if (instance == this) {
            instance = null;
        }
        super.handleOnDestroy();
    }

    static boolean isWebAlive() {
        return instance != null;
    }

    static void webDied() {
        instance = null;
        NavRecorderService.noteWebDied();
    }

    static void emitFix(JSONObject fix) {
        NavRecorderPlugin p = instance;
        if (p == null) {
            return;
        }
        try {
            p.notifyListeners(EVENT_FIX, JSObject.fromJSONObject(fix));
        } catch (JSONException e) {
            // Unreachable: the service built the object itself.
        }
    }

    static void emitStopped(String reason) {
        NavRecorderPlugin p = instance;
        if (p == null) {
            return;
        }
        JSObject o = new JSObject();
        o.put("reason", reason);
        p.notifyListeners(EVENT_STOPPED, o);
    }

    // --- Start / stop ----------------------------------------------------

    @PluginMethod
    public void start(PluginCall call) {
        if (!hasLocation()) {
            requestPermissionForAliases(new String[] { ALIAS_LOCATION, ALIAS_COARSE }, call, "locationCallback");
            return;
        }
        maybeAskNotifications(call);
    }

    /** Fine OR coarse: an "approximate only" grant still records (the web
     *  app's accuracy gate judges the fixes), and still satisfies the
     *  location-type foreground service start. */
    private boolean hasLocation() {
        return (
            getPermissionState(ALIAS_LOCATION) == PermissionState.GRANTED ||
            getPermissionState(ALIAS_COARSE) == PermissionState.GRANTED
        );
    }

    @PermissionCallback
    private void locationCallback(PluginCall call) {
        if (!hasLocation()) {
            call.reject("denied");
            return;
        }
        maybeAskNotifications(call);
    }

    private void maybeAskNotifications(PluginCall call) {
        if (Build.VERSION.SDK_INT >= 33 && getPermissionState(ALIAS_NOTIFICATIONS) != PermissionState.GRANTED) {
            requestPermissionForAlias(ALIAS_NOTIFICATIONS, call, "notificationsCallback");
            return;
        }
        startService(call);
    }

    @PermissionCallback
    private void notificationsCallback(PluginCall call) {
        // A refused notification hides the drawer card, never the recording.
        startService(call);
    }

    private void startService(PluginCall call) {
        Context ctx = getContext();
        if (Boolean.TRUE.equals(call.getBoolean("fresh", false))) {
            NavJournal.clear(ctx);
        }
        Intent i = new Intent(ctx, NavRecorderService.class);
        i.setAction(NavRecorderService.ACTION_START);
        i.putExtra(NavRecorderService.EXTRA_TITLE, call.getString("title", "Flight recording"));
        i.putExtra(NavRecorderService.EXTRA_TEXT, call.getString("text", ""));
        i.putExtra(NavRecorderService.EXTRA_STOP_LABEL, call.getString("stopLabel", "Stop"));
        ContextCompat.startForegroundService(ctx, i);
        call.resolve();
    }

    /** The web app's stop. The journal is deliberately NOT cleared here: the
     *  web side drains it first and clears it itself, so a failed drain
     *  leaves the fixes recoverable. */
    @PluginMethod
    public void stop(PluginCall call) {
        Context ctx = getContext();
        ctx.stopService(new Intent(ctx, NavRecorderService.class));
        prefs().edit().putBoolean(NavRecorderService.PREF_RUNNING, false).apply();
        call.resolve();
    }

    // --- Journal ---------------------------------------------------------

    @PluginMethod
    public void drain(PluginCall call) {
        Double after = call.getDouble("afterMs", 0.0);
        Integer limit = call.getInt("limit", 2000);
        NavJournal.ReadResult r = NavJournal.readAfter(
            getContext(),
            after == null ? 0L : (long) after.doubleValue(),
            limit == null || limit < 1 ? 2000 : limit
        );
        JSArray fixes = new JSArray();
        for (JSONObject o : r.fixes) {
            fixes.put(o);
        }
        JSObject out = new JSObject();
        out.put("fixes", fixes);
        out.put("done", r.done);
        call.resolve(out);
    }

    @PluginMethod
    public void clearJournal(PluginCall call) {
        NavJournal.clear(getContext());
        prefs()
            .edit()
            .remove(NavRecorderService.PREF_STOPPED_REASON)
            .remove(NavRecorderService.PREF_STOPPED_AT)
            .apply();
        call.resolve();
    }

    // --- State -----------------------------------------------------------

    @PluginMethod
    public void getState(PluginCall call) {
        SharedPreferences prefs = prefs();
        boolean running = NavRecorderService.isRunning();
        if (!running && prefs.getBoolean(NavRecorderService.PREF_RUNNING, false)) {
            // The process died with the service (force-stop): normalize the
            // flag so nothing later mistakes it for a live recording.
            prefs.edit().putBoolean(NavRecorderService.PREF_RUNNING, false).apply();
        }
        JSObject out = new JSObject();
        out.put("running", running);
        long startedAt = prefs.getLong(NavRecorderService.PREF_STARTED_AT, 0);
        if (startedAt > 0) {
            out.put("startedAtMs", startedAt);
        }
        String reason = prefs.getString(NavRecorderService.PREF_STOPPED_REASON, null);
        if (reason != null) {
            out.put("stoppedReason", reason);
            out.put("stoppedAtMs", prefs.getLong(NavRecorderService.PREF_STOPPED_AT, 0));
        }
        call.resolve(out);
    }

    @PluginMethod
    public void setAutoStop(PluginCall call) {
        boolean enabled = Boolean.TRUE.equals(call.getBoolean("enabled", true));
        prefs().edit().putBoolean(NavRecorderService.PREF_AUTO_STOP, enabled).apply();
        NavRecorderService.applyAutoStop(enabled);
        call.resolve();
    }

    // --- Battery optimization -------------------------------------------

    @PluginMethod
    public void batteryStatus(PluginCall call) {
        PowerManager pm = (PowerManager) getContext().getSystemService(Context.POWER_SERVICE);
        JSObject out = new JSObject();
        out.put("ignoring", pm != null && pm.isIgnoringBatteryOptimizations(getContext().getPackageName()));
        call.resolve(out);
    }

    /** The system's battery-optimisation LIST, not the direct grant dialog.
     *  ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS puts the exemption one tap
     *  away but needs the permission of the same name, which Play restricts to
     *  apps whose core function Doze breaks; a location foreground service is
     *  the sanctioned answer to that, so this app does not qualify and does not
     *  declare it (docs/android.md). This action needs no permission: it opens
     *  the list, the user finds the app and lifts the restriction there, which
     *  is the same outcome one screen further away. */
    @PluginMethod
    public void openBatterySettings(PluginCall call) {
        Intent i = new Intent(Settings.ACTION_IGNORE_BATTERY_OPTIMIZATION_SETTINGS);
        try {
            getActivity().startActivity(i);
            call.resolve();
        } catch (Exception e) {
            call.reject("battery optimization settings unavailable");
        }
    }

    private SharedPreferences prefs() {
        return getContext().getSharedPreferences(NavRecorderService.PREFS, Context.MODE_PRIVATE);
    }
}
