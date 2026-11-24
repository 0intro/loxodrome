package fr.loxodrome.app;

import android.Manifest;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.os.Build;
import androidx.core.app.NotificationCompat;
import androidx.core.app.NotificationManagerCompat;
import androidx.core.content.ContextCompat;

/**
 * Posts the briefing reminder ReminderPlugin set (docs/android.md, "The
 * briefing reminder"). The alarm's broadcast starts the process when it is
 * gone, so the notification comes with the app running or killed. A tap
 * opens the app, whose automatic fetch then brings the day's RTBA activity.
 */
public class ReminderReceiver extends BroadcastReceiver {

    static final String CHANNEL_ID = "briefing_reminder";
    /** Beside the recording's 1001. */
    static final int NOTIF_ID = 1002;
    static final String EXTRA_TITLE = "title";
    static final String EXTRA_TEXT = "text";
    static final String EXTRA_CHANNEL = "channel";

    /** The alarm's intent. Extras take no part in matching a PendingIntent,
     *  so the bare intent finds the one set, to cancel it. */
    static Intent intent(Context ctx) {
        return new Intent(ctx, ReminderReceiver.class);
    }

    /** Creating a channel that exists renames it and keeps what the pilot
     *  set for it in Android's settings. */
    static void createChannel(Context ctx, String name) {
        if (Build.VERSION.SDK_INT < 26) {
            return;
        }
        NotificationManager nm = ctx.getSystemService(NotificationManager.class);
        nm.createNotificationChannel(new NotificationChannel(CHANNEL_ID, name, NotificationManager.IMPORTANCE_DEFAULT));
    }

    /** Whether the pilot left the reminder's channel on, true until the
     *  first schedule creates it. */
    static boolean channelOn(Context ctx) {
        if (Build.VERSION.SDK_INT < 26) {
            return true;
        }
        NotificationChannel ch = ctx.getSystemService(NotificationManager.class).getNotificationChannel(CHANNEL_ID);
        return ch == null || ch.getImportance() != NotificationManager.IMPORTANCE_NONE;
    }

    @Override
    public void onReceive(Context ctx, Intent intent) {
        String title = intent.getStringExtra(EXTRA_TITLE);
        String text = intent.getStringExtra(EXTRA_TEXT);
        if (title == null || text == null) {
            return;
        }
        if (
            Build.VERSION.SDK_INT >= 33 &&
            ContextCompat.checkSelfPermission(ctx, Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED
        ) {
            return;
        }
        String channel = intent.getStringExtra(EXTRA_CHANNEL);
        createChannel(ctx, channel == null ? title : channel);
        Intent tap = ctx.getPackageManager().getLaunchIntentForPackage(ctx.getPackageName());
        PendingIntent tapPi = tap == null
            ? null
            : PendingIntent.getActivity(ctx, 2, tap, PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
        NotificationCompat.Builder b = new NotificationCompat.Builder(ctx, CHANNEL_ID)
            .setSmallIcon(R.drawable.ic_stat_navrec)
            .setContentTitle(title)
            .setContentText(text)
            .setStyle(new NotificationCompat.BigTextStyle().bigText(text))
            .setContentIntent(tapPi)
            .setAutoCancel(true)
            .setCategory(NotificationCompat.CATEGORY_REMINDER)
            .setPriority(NotificationCompat.PRIORITY_DEFAULT);
        NotificationManagerCompat.from(ctx).notify(NOTIF_ID, b.build());
    }
}
