package fr.loxodrome.app;

import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.content.pm.ServiceInfo;
import android.location.Location;
import android.location.LocationListener;
import android.location.LocationManager;
import android.os.Build;
import android.os.IBinder;
import android.os.Looper;
import androidx.core.app.NotificationCompat;
import androidx.core.app.ServiceCompat;
import com.getcapacitor.Logger;
import org.json.JSONException;
import org.json.JSONObject;

/**
 * The background flight recorder: a foreground service of type location that
 * runs EXACTLY while a recording runs (recording is the app's flight mode;
 * there is no separate switch). It owns the GPS on Android: 1 Hz raw
 * GPS_PROVIDER fixes, journalled verbatim through NavJournal and emitted live
 * through NavRecorderPlugin; ALL filtering and unit conversion stay in the
 * web app's single ingest gate ($lib/nav/nativeFix.ts + navRecording).
 *
 * Being a foreground service is what keeps the WHOLE process out of the
 * cached-app freezer, so while the app is merely backgrounded the WebView's
 * JS keeps receiving the live fixes; the journal covers the cases where the
 * WebView is gone (task swiped away, process death + START_STICKY restart,
 * force-stop + later relaunch). Contract: docs/android.md.
 *
 * Two stop flavors: the web app's stop (Context.stopService -> onDestroy)
 * leaves state clean and the JOURNAL IS CLEARED BY JS after its final drain;
 * a native-side stop (the notification's Stop action, or the dead-bridge
 * safety valve) stamps stoppedReason/stoppedAtMs in the prefs and KEEPS the
 * journal, so the next boot reconcile can finish the trace.
 *
 * Notification strings arrive from JS (the app's i18n lives in the web
 * catalogs; there is deliberately no values-fr) and persist in the prefs with
 * startedAtMs, so a null-intent sticky restart rebuilds the same notification
 * and its chronometer.
 */
public class NavRecorderService extends Service implements LocationListener {

    static final String ACTION_START = "fr.loxodrome.app.navrec.START";
    static final String ACTION_STOP = "fr.loxodrome.app.navrec.STOP";

    static final String EXTRA_TITLE = "title";
    static final String EXTRA_TEXT = "text";
    static final String EXTRA_STOP_LABEL = "stopLabel";

    static final String PREFS = "navrec";
    static final String PREF_RUNNING = "running";
    static final String PREF_STARTED_AT = "startedAtMs";
    static final String PREF_TITLE = "title";
    static final String PREF_TEXT = "text";
    static final String PREF_STOP_LABEL = "stopLabel";
    static final String PREF_AUTO_STOP = "autoStopEnabled";
    static final String PREF_STOPPED_REASON = "stoppedReason";
    static final String PREF_STOPPED_AT = "stoppedAtMs";

    private static final String CHANNEL_ID = "nav_recording";
    private static final int NOTIF_ID = 1001;
    private static final long UPDATE_MS = 1000;

    /** The dead-bridge safety valve: with the WebView gone (the JS
     *  landing-gated auto-stop cannot run) and the auto-stop preference on,
     *  no displacement over VALVE_MOVE_M for VALVE_STATIONARY_MS ends the
     *  recording rather than draining the battery on a parked aircraft. The
     *  stationary clock starts when the WebView dies, never before, so a
     *  "keep recording" chosen in the app is not overridden the moment it
     *  closes. */
    private static final float VALVE_MOVE_M = 100f;
    private static final long VALVE_STATIONARY_MS = 15 * 60_000L;

    private static volatile boolean running = false;
    private static volatile NavRecorderService live;

    private LocationManager locationManager;
    private boolean listening = false;
    private boolean foreground = false;
    private volatile boolean autoStopEnabled = true;

    private double anchorLat;
    private double anchorLon;
    private long anchorTMs = 0;

    static boolean isRunning() {
        return running;
    }

    /** Live-update the valve's preference (the pref itself is the truth the
     *  next start reads). */
    static void applyAutoStop(boolean enabled) {
        NavRecorderService s = live;
        if (s != null) {
            s.autoStopEnabled = enabled;
        }
    }

    /** Restart the valve's stationary clock; called when the WebView goes
     *  away (task removed). */
    static void noteWebDied() {
        NavRecorderService s = live;
        if (s != null) {
            s.anchorTMs = 0;
        }
    }

    private SharedPreferences prefs() {
        return getSharedPreferences(PREFS, Context.MODE_PRIVATE);
    }

    @Override
    public void onCreate() {
        super.onCreate();
        live = this;
    }

    @Override
    public IBinder onBind(Intent intent) {
        return null;
    }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        SharedPreferences prefs = prefs();
        String action = intent == null ? null : intent.getAction();
        if (ACTION_START.equals(action)) {
            SharedPreferences.Editor e = prefs.edit();
            e.putString(PREF_TITLE, intent.getStringExtra(EXTRA_TITLE));
            e.putString(PREF_TEXT, intent.getStringExtra(EXTRA_TEXT));
            e.putString(PREF_STOP_LABEL, intent.getStringExtra(EXTRA_STOP_LABEL));
            if (!running) {
                e.putLong(PREF_STARTED_AT, System.currentTimeMillis());
            }
            e.putBoolean(PREF_RUNNING, true);
            e.remove(PREF_STOPPED_REASON).remove(PREF_STOPPED_AT);
            e.apply();
        }
        // Started via startForegroundService, so the notification must go up
        // FIRST in every branch, the stop ones included (a legal sequence).
        ensureForeground(prefs);
        if (ACTION_STOP.equals(action)) {
            stopWithReason("user");
            return START_NOT_STICKY;
        }
        if (action == null && !prefs.getBoolean(PREF_RUNNING, false)) {
            // A sticky restart after the recording had already ended.
            teardown();
            return START_NOT_STICKY;
        }
        autoStopEnabled = prefs.getBoolean(PREF_AUTO_STOP, true);
        startLocation();
        running = true;
        return START_STICKY;
    }

    @Override
    public void onTaskRemoved(Intent rootIntent) {
        // Swipe-away destroys the activity without the plugin's own destroy
        // hook reliably running: flip the seam here so emissions stop and the
        // safety valve arms, and keep recording (stopWithTask=false).
        NavRecorderPlugin.webDied();
        anchorTMs = 0;
        super.onTaskRemoved(rootIntent);
    }

    @Override
    public void onDestroy() {
        // Both stop flavors and a system destroy converge here; a process
        // KILL skips it, which is exactly what the static/pref split in
        // getState() and the sticky restart cover.
        stopLocation();
        running = false;
        live = null;
        prefs().edit().putBoolean(PREF_RUNNING, false).apply();
        super.onDestroy();
    }

    // --- Location --------------------------------------------------------

    private void startLocation() {
        if (listening) {
            return;
        }
        locationManager = (LocationManager) getSystemService(Context.LOCATION_SERVICE);
        if (locationManager == null) {
            return;
        }
        try {
            // Raw GPS on purpose: works in airplane mode and does not jump to
            // wifi/cell positions at altitude. The web app's accuracy gate
            // remains the arbiter of what enters the trace.
            locationManager.requestLocationUpdates(
                LocationManager.GPS_PROVIDER,
                UPDATE_MS,
                0f,
                this,
                Looper.getMainLooper()
            );
            listening = true;
        } catch (SecurityException | IllegalArgumentException e) {
            // Fine location downgraded to approximate, or no GPS hardware.
            try {
                String provider = Build.VERSION.SDK_INT >= 31
                    ? LocationManager.FUSED_PROVIDER
                    : LocationManager.NETWORK_PROVIDER;
                locationManager.requestLocationUpdates(provider, UPDATE_MS, 0f, this, Looper.getMainLooper());
                listening = true;
            } catch (SecurityException | IllegalArgumentException e2) {
                Logger.error("NavRecorder: no usable location provider", e2);
            }
        }
    }

    private void stopLocation() {
        if (listening && locationManager != null) {
            locationManager.removeUpdates(this);
            listening = false;
        }
    }

    @Override
    public void onLocationChanged(Location loc) {
        JSONObject fix = new JSONObject();
        try {
            fix.put("tMs", loc.getTime());
            fix.put("lat", loc.getLatitude());
            fix.put("lon", loc.getLongitude());
            if (loc.hasAltitude()) {
                // Metres above the WGS84 ellipsoid, exactly what the WebView's
                // coords.altitude carries on Android; the web app owns the
                // geoid correction.
                fix.put("altM", loc.getAltitude());
            }
            if (loc.hasAccuracy()) {
                fix.put("accM", (double) loc.getAccuracy());
            }
            if (loc.hasSpeed()) {
                fix.put("spdMps", (double) loc.getSpeed());
            }
            if (loc.hasBearing()) {
                fix.put("brgDeg", (double) loc.getBearing());
            }
        } catch (JSONException e) {
            return;
        }
        NavJournal.append(this, fix);
        NavRecorderPlugin.emitFix(fix);
        safetyValve(loc);
    }

    private void safetyValve(Location loc) {
        if (NavRecorderPlugin.isWebAlive()) {
            anchorTMs = 0;
            return;
        }
        if (!autoStopEnabled) {
            return;
        }
        if (anchorTMs == 0 || distanceM(loc) > VALVE_MOVE_M) {
            anchorLat = loc.getLatitude();
            anchorLon = loc.getLongitude();
            anchorTMs = loc.getTime();
            return;
        }
        if (loc.getTime() - anchorTMs >= VALVE_STATIONARY_MS) {
            stopWithReason("autostop");
        }
    }

    private float distanceM(Location loc) {
        float[] out = new float[1];
        Location.distanceBetween(anchorLat, anchorLon, loc.getLatitude(), loc.getLongitude(), out);
        return out[0];
    }

    // --- Stop flavors ----------------------------------------------------

    /** A NATIVE-side stop: mark why and when, keep the journal for the next
     *  boot reconcile, tell the web app if it is listening. */
    private void stopWithReason(String reason) {
        prefs()
            .edit()
            .putString(PREF_STOPPED_REASON, reason)
            .putLong(PREF_STOPPED_AT, System.currentTimeMillis())
            .apply();
        NavRecorderPlugin.emitStopped(reason);
        teardown();
    }

    private void teardown() {
        stopLocation();
        running = false;
        prefs().edit().putBoolean(PREF_RUNNING, false).apply();
        ServiceCompat.stopForeground(this, ServiceCompat.STOP_FOREGROUND_REMOVE);
        foreground = false;
        stopSelf();
    }

    // --- Notification ----------------------------------------------------

    private void ensureForeground(SharedPreferences prefs) {
        if (foreground) {
            return;
        }
        String title = prefs.getString(PREF_TITLE, "Flight recording");
        if (Build.VERSION.SDK_INT >= 26) {
            NotificationManager nm = (NotificationManager) getSystemService(Context.NOTIFICATION_SERVICE);
            NotificationChannel ch = new NotificationChannel(CHANNEL_ID, title, NotificationManager.IMPORTANCE_LOW);
            ch.setShowBadge(false);
            nm.createNotificationChannel(ch);
        }
        Intent tap = getPackageManager().getLaunchIntentForPackage(getPackageName());
        PendingIntent tapPi = tap == null
            ? null
            : PendingIntent.getActivity(this, 0, tap, PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
        Intent stop = new Intent(this, NavRecorderService.class).setAction(ACTION_STOP);
        // getForegroundService: a stale notification's Stop after a process
        // kill would make getService a background service start, which throws.
        PendingIntent stopPi = Build.VERSION.SDK_INT >= 26
            ? PendingIntent.getForegroundService(this, 1, stop, PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE)
            : PendingIntent.getService(this, 1, stop, PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
        NotificationCompat.Builder b = new NotificationCompat.Builder(this, CHANNEL_ID)
            .setSmallIcon(R.drawable.ic_stat_navrec)
            .setContentTitle(title)
            .setContentText(prefs.getString(PREF_TEXT, ""))
            .setOngoing(true)
            // The chronometer renders elapsed-since-when with no re-notify
            // churn, and startedAtMs from the prefs keeps it true across a
            // sticky restart.
            .setWhen(prefs.getLong(PREF_STARTED_AT, System.currentTimeMillis()))
            .setShowWhen(true)
            .setUsesChronometer(true)
            .setSilent(true)
            .setContentIntent(tapPi)
            .addAction(0, prefs.getString(PREF_STOP_LABEL, "Stop"), stopPi)
            .setCategory(NotificationCompat.CATEGORY_NAVIGATION)
            .setVisibility(NotificationCompat.VISIBILITY_PUBLIC);
        if (Build.VERSION.SDK_INT >= 31) {
            b.setForegroundServiceBehavior(NotificationCompat.FOREGROUND_SERVICE_IMMEDIATE);
        }
        int type = Build.VERSION.SDK_INT >= 29 ? ServiceInfo.FOREGROUND_SERVICE_TYPE_LOCATION : 0;
        ServiceCompat.startForeground(this, NOTIF_ID, b.build(), type);
        foreground = true;
    }

    // --- No wake lock ----------------------------------------------------
    //
    // This service deliberately holds NO partial wake lock, though it used to.
    // Android vitals counts a partial lock held while a foreground service
    // runs, exempting only the ones the system itself takes for the Audio,
    // Location and JobScheduler APIs; two hours in a 24-hour period on more
    // than 5 % of sessions earns a battery warning on the Play listing and
    // removal from the discovery surfaces, and a screen-off recording of a
    // two-hour flight is exactly that shape. The SCREEN lock in
    // ui/wakeLock.ts is a different lock and releases when the page hides,
    // so it does not stand in for this one.
    //
    // Nothing here needs the CPU held awake between fixes: there is no
    // Handler, no postDelayed, no alarm and no executor in this file. The
    // only work is onLocationChanged, and the location subsystem wakes the
    // CPU to deliver it; the safety valve's clock is advanced by arriving
    // fixes rather than by a timer, so it cannot starve while nothing
    // arrives.
    //
    // Measured on the Redmi Note 12 (2026-08-16), real GPS, backgrounded,
    // screen off, reported on battery and forced into deep Doze: 637 fixes
    // in 650 s, 0.98 Hz, median and p95 gap 1.00 s, and a flat 60 fixes per
    // minute either side of one isolated 13 s dropout. No progressive
    // thinning, which is the shape CPU suspend would have produced. Restore
    // the lock, and accept the Play battery metric, only if a device shows
    // that pattern; the procedure is in docs/android.md.
}
