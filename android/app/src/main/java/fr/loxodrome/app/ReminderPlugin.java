package fr.loxodrome.app;

import android.Manifest;
import android.annotation.SuppressLint;
import android.app.AlarmManager;
import android.app.PendingIntent;
import android.content.Context;
import android.os.Build;
import androidx.core.app.NotificationManagerCompat;
import com.getcapacitor.JSObject;
import com.getcapacitor.PermissionState;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.getcapacitor.annotation.Permission;
import com.getcapacitor.annotation.PermissionCallback;

/**
 * The briefing reminder (contract in docs/android.md, "The briefing
 * reminder", web side in $lib/native/reminder.ts +
 * $lib/state/briefingReminder.svelte.ts): ONE notification at an instant,
 * which the web app sets at the RTBA release while the NOTAM briefing
 * predates it, and takes back once the reason is gone. A schedule replaces
 * the one before.
 *
 * The alarm is allowed while idle and fires at its instant or later: from
 * Android 12 inexact (setAndAllowWhileIdle), which Android delivers within
 * the hour outside Doze and battery saver, and below it exact, since an
 * inexact alarm there has no stated bound and an exact one needs no
 * permission. POST_NOTIFICATIONS is the one permission it needs. A reboot
 * or a force stop drops it, and the app sets it again at its next start.
 * ReminderReceiver posts the notification with the app running or killed.
 */
@CapacitorPlugin(
    name = "Reminder",
    permissions = {
        @Permission(alias = ReminderPlugin.ALIAS_NOTIFICATIONS, strings = { Manifest.permission.POST_NOTIFICATIONS })
    }
)
public class ReminderPlugin extends Plugin {

    static final String ALIAS_NOTIFICATIONS = "notifications";

    /** The instant asked, in epoch milliseconds, -1 when absent. The bridge's
     *  org.json makes a 13-digit integer a Long, which getDouble and getInt
     *  answer with their default, so it reads through optLong. */
    static long atMs(PluginCall call) {
        return call.getData().optLong("atMs", -1L);
    }

    /** What the web app reads of the permission: "granted", "prompt" while
     *  the runtime permission (from API 33) is not granted, or "denied",
     *  which a channel the pilot turned off also reads as. Capacitor keeps
     *  DENIED once a request ends with no rationale to show, which a
     *  question dismissed with Back also does, and Android asks that one
     *  again: only a request tells, Android answering at once once the
     *  pilot has refused twice. Below API 33 the app's notification switch
     *  alone decides. */
    static String permissionText(int sdk, PermissionState state, boolean enabled, boolean channelOn) {
        if (!channelOn) {
            return "denied";
        }
        if (sdk < 33 || state == PermissionState.GRANTED) {
            return enabled ? "granted" : "denied";
        }
        return "prompt";
    }

    @PluginMethod
    public void schedule(PluginCall call) {
        long at = atMs(call);
        String title = call.getString("title");
        String text = call.getString("text");
        String channel = call.getString("channel");
        if (at < 0 || title == null || text == null || channel == null) {
            call.reject("schedule: atMs, title, text and channel are required");
            return;
        }
        Context ctx = getContext();
        ReminderReceiver.createChannel(ctx, channel);
        PendingIntent pi = PendingIntent.getBroadcast(
            ctx,
            0,
            ReminderReceiver.intent(ctx)
                .putExtra(ReminderReceiver.EXTRA_TITLE, title)
                .putExtra(ReminderReceiver.EXTRA_TEXT, text)
                .putExtra(ReminderReceiver.EXTRA_CHANNEL, channel),
            PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE
        );
        AlarmManager am = (AlarmManager) ctx.getSystemService(Context.ALARM_SERVICE);
        if (Build.VERSION.SDK_INT < 31) {
            setExactBeforeS(am, at, pi);
        } else {
            am.setAndAllowWhileIdle(AlarmManager.RTC_WAKEUP, at, pi);
        }
        call.resolve();
    }

    /** The exact alarm below Android 12, the only versions it is set on.
     *  SCHEDULE_EXACT_ALARM exists from Android 12: lint reads the call
     *  without the version its caller checks. */
    @SuppressLint("MissingPermission")
    private static void setExactBeforeS(AlarmManager am, long at, PendingIntent pi) {
        am.setExactAndAllowWhileIdle(AlarmManager.RTC_WAKEUP, at, pi);
    }

    /** Takes the alarm back, and the notification if it is up. */
    @PluginMethod
    public void cancel(PluginCall call) {
        Context ctx = getContext();
        PendingIntent pi = PendingIntent.getBroadcast(
            ctx,
            0,
            ReminderReceiver.intent(ctx),
            PendingIntent.FLAG_NO_CREATE | PendingIntent.FLAG_IMMUTABLE
        );
        if (pi != null) {
            ((AlarmManager) ctx.getSystemService(Context.ALARM_SERVICE)).cancel(pi);
            pi.cancel();
        }
        NotificationManagerCompat.from(ctx).cancel(ReminderReceiver.NOTIF_ID);
        call.resolve();
    }

    @PluginMethod
    public void permission(PluginCall call) {
        resolvePermission(call);
    }

    /** The system's question from API 33, while the permission is not
     *  granted. Android answers at once, with no question, once the pilot
     *  has refused twice. */
    @PluginMethod
    public void requestPermission(PluginCall call) {
        if (Build.VERSION.SDK_INT >= 33 && getPermissionState(ALIAS_NOTIFICATIONS) != PermissionState.GRANTED) {
            requestPermissionForAlias(ALIAS_NOTIFICATIONS, call, "permissionCallback");
            return;
        }
        resolvePermission(call);
    }

    @PermissionCallback
    private void permissionCallback(PluginCall call) {
        resolvePermission(call);
    }

    private void resolvePermission(PluginCall call) {
        Context ctx = getContext();
        JSObject out = new JSObject();
        out.put(
            "state",
            permissionText(
                Build.VERSION.SDK_INT,
                getPermissionState(ALIAS_NOTIFICATIONS),
                NotificationManagerCompat.from(ctx).areNotificationsEnabled(),
                ReminderReceiver.channelOn(ctx)
            )
        );
        call.resolve(out);
    }
}
