package fr.loxodrome.app;

import android.content.Context;
import com.getcapacitor.Logger;
import java.io.BufferedReader;
import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStreamReader;
import java.io.OutputStreamWriter;
import java.io.Writer;
import java.nio.charset.StandardCharsets;
import java.util.ArrayDeque;
import java.util.ArrayList;
import java.util.Deque;
import java.util.List;
import org.json.JSONException;
import org.json.JSONObject;

/**
 * The recording journal: one JSON line per GPS fix, appended by
 * NavRecorderService and drained by the web app through NavRecorderPlugin.
 *
 * The journal is the SOURCE OF TRUTH for a running recording; the plugin's
 * live "fix" events are only the low-latency path while the WebView exists.
 * The web app drains it (everything after the last fix it holds) on boot, on
 * return to the foreground and on stop, and CLEARS it once a stop has been
 * drained; the native side never clears it on its own stops, which is what
 * makes "service not running + journal non-empty" unambiguously mean a
 * native-side stop the web app has not yet seen (docs/android.md).
 *
 * A fix is ~90 bytes, so 1 Hz writes ~330 KB per flight hour; the size guard
 * only exists for pathology (a recorder left running for days), and drops the
 * OLDEST lines, keeping the live end of the trace.
 */
final class NavJournal {

    /** One lock for everything: appends are 1 Hz and reads are rare. */
    private static final Object LOCK = new Object();

    private static final String DIR = "navrec";
    private static final String FILE = "journal.jsonl";

    private static final long MAX_BYTES = 16L * 1024 * 1024;
    private static final int KEEP_LINES = 120_000;

    private NavJournal() {}

    static class ReadResult {

        final List<JSONObject> fixes;
        /** Whether the read reached the end of the journal. */
        final boolean done;

        ReadResult(List<JSONObject> fixes, boolean done) {
            this.fixes = fixes;
            this.done = done;
        }
    }

    private static File file(Context ctx) {
        File dir = new File(ctx.getFilesDir(), DIR);
        //noinspection ResultOfMethodCallIgnored
        dir.mkdirs();
        return new File(dir, FILE);
    }

    static void append(Context ctx, JSONObject fix) {
        synchronized (LOCK) {
            File f = file(ctx);
            if (f.length() > MAX_BYTES) {
                truncateToTail(f);
            }
            try (Writer w = new OutputStreamWriter(new FileOutputStream(f, true), StandardCharsets.UTF_8)) {
                w.write(fix.toString());
                w.write('\n');
            } catch (IOException e) {
                // Best-effort: the live event path still delivers this fix.
                Logger.error("NavJournal append failed", e);
            }
        }
    }

    /** The journal fixes with tMs strictly after afterMs, oldest first, at
     *  most limit of them. Each drain call rescans from the start; at 1 Hz
     *  volumes that is a few hundred KB per call, not worth an index. */
    static ReadResult readAfter(Context ctx, long afterMs, int limit) {
        List<JSONObject> out = new ArrayList<>();
        boolean done = true;
        synchronized (LOCK) {
            File f = file(ctx);
            if (!f.exists()) {
                return new ReadResult(out, true);
            }
            try (
                BufferedReader r = new BufferedReader(
                    new InputStreamReader(new FileInputStream(f), StandardCharsets.UTF_8)
                )
            ) {
                String line;
                while ((line = r.readLine()) != null) {
                    JSONObject o = parse(line);
                    if (o == null || o.optLong("tMs") <= afterMs) {
                        continue;
                    }
                    if (out.size() >= limit) {
                        done = false;
                        break;
                    }
                    out.add(o);
                }
            } catch (IOException e) {
                Logger.error("NavJournal read failed", e);
            }
        }
        return new ReadResult(out, done);
    }

    static void clear(Context ctx) {
        synchronized (LOCK) {
            //noinspection ResultOfMethodCallIgnored
            file(ctx).delete();
        }
    }

    /** A torn line from a kill mid-append parses null and is dropped. */
    private static JSONObject parse(String line) {
        try {
            return new JSONObject(line);
        } catch (JSONException e) {
            return null;
        }
    }

    /** Rewrite the file keeping the last KEEP_LINES lines (LOCK held). */
    private static void truncateToTail(File f) {
        Deque<String> tail = new ArrayDeque<>(KEEP_LINES);
        try (
            BufferedReader r = new BufferedReader(
                new InputStreamReader(new FileInputStream(f), StandardCharsets.UTF_8)
            )
        ) {
            String line;
            while ((line = r.readLine()) != null) {
                if (tail.size() >= KEEP_LINES) {
                    tail.removeFirst();
                }
                tail.addLast(line);
            }
        } catch (IOException e) {
            Logger.error("NavJournal truncate read failed", e);
            return;
        }
        File tmp = new File(f.getParentFile(), FILE + ".tmp");
        try (Writer w = new OutputStreamWriter(new FileOutputStream(tmp), StandardCharsets.UTF_8)) {
            for (String line : tail) {
                w.write(line);
                w.write('\n');
            }
        } catch (IOException e) {
            Logger.error("NavJournal truncate write failed", e);
            //noinspection ResultOfMethodCallIgnored
            tmp.delete();
            return;
        }
        if (!tmp.renameTo(f)) {
            //noinspection ResultOfMethodCallIgnored
            tmp.delete();
        }
    }
}
