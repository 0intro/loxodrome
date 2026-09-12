package fr.loxodrome.app;

import android.app.Activity;
import android.content.ClipData;
import android.content.Intent;
import android.database.Cursor;
import android.net.Uri;
import android.provider.OpenableColumns;
import android.util.Base64;
import androidx.activity.result.ActivityResult;
import androidx.core.content.IntentCompat;
import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.Logger;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.ActivityCallback;
import com.getcapacitor.annotation.CapacitorPlugin;
import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.nio.charset.StandardCharsets;

/**
 * Files handed to the app by Android: ACTION_VIEW ("Open with" from a file
 * manager, the Downloads list, a mail attachment) and ACTION_SEND ("Share to"
 * from Drive, a messenger, anything that sends a document). The manifest says
 * which MIME types we claim; this reads the granted URI and hands the web app
 * the display name and the text, which is all it needs: the KIND is sniffed
 * from the content ($lib/files/detect.ts), because a route workspace and an
 * aircraft data sheet are both .yaml and a content URI rarely carries a
 * meaningful name at all.
 *
 * Reading here rather than in the web layer keeps the URI permission grant
 * where it was granted (this task, this intent) and makes the display name
 * available; a WebView fetch through Capacitor's content bridge would give
 * neither.
 *
 * ONE delivery path, handleOnNewIntent, for both the cold start and an app
 * already running: BridgeActivity.load() feeds the LAUNCH intent through
 * onNewIntent as soon as the bridge exists, so an intent that started the app
 * arrives here too, before the web app has booted. Retained notification is
 * what carries it across that gap (Capacitor holds the event until a listener
 * registers). A second, stash-at-load() path would look like belt and braces
 * and in fact deliver the launch intent twice.
 */
@CapacitorPlugin(name = "OpenFile")
public class OpenFilePlugin extends Plugin {

    /**
     * How much of a file may cross the Capacitor bridge INLINE. The bridge is
     * a JSON channel, so bytes ride it as one base64 string in one message;
     * that is fine for a briefing, a route or an aircraft sheet, and wrong for
     * a whole flight library. Anything larger is copied into the app cache
     * instead and handed over as a PATH, which the web side fetches through
     * Capacitor.convertFileSrc (docs/android.md).
     */
    private static final int INLINE_MAX = 1024 * 1024;

    /**
     * The absolute ceiling, a sanity bound rather than a budget: past this a
     * content URI is not a document this application has any business reading.
     * It used to be 8 MiB and it used to be the real limit, which made a big
     * flights bundle look like a dead button.
     */
    private static final long MAX_BYTES = 256L * 1024 * 1024;

    /** Where a spilled file lands, under the app cache. */
    private static final String INCOMING_DIR = "incoming";

    /** How long a spilled file is kept before the next spill sweeps it. */
    private static final long SPILL_TTL_MS = 10 * 60 * 1000L;

    private static final String EVENT_OPEN = "open";

    @Override
    protected void handleOnNewIntent(Intent intent) {
        super.handleOnNewIntent(intent);
        JSObject file = readIntent(intent);
        if (file != null) {
            notifyListeners(EVENT_OPEN, file, true);
        }
    }

    /**
     * Pick a file, natively. The WebView's own file chooser (an
     * <input type=file>) is not usable on every Android: it hands the page a
     * File the renderer has to read back through the picker's provider, and on
     * a device whose chooser is not the AOSP one that read can come back empty
     * or never arrive at all, leaving the app looking like it ignored the file
     * (measured on a MIUI device, where "Open with" works and the in-app picker
     * does not). So natively the button asks for ACTION_OPEN_DOCUMENT here,
     * reads the granted URI in this process exactly as an incoming intent is
     * read, and delivers it down the SAME event: one pipeline, the one the
     * system's own "Open with" already proves.
     */
    @PluginMethod
    public void pick(PluginCall call) {
        Intent intent = new Intent(Intent.ACTION_OPEN_DOCUMENT);
        intent.addCategory(Intent.CATEGORY_OPENABLE);
        // Android's MIME table knows no yaml or gpx, and a provider types those
        // files application/octet-stream, so any narrower filter would grey out
        // exactly what the user came for.
        intent.setType("*/*");
        startActivityForResult(call, intent, "pickResult");
    }

    /**
     * Pick SEVERAL files, natively: the flights library's batch importer takes
     * traces, route files and a logbook CSV in one go. Same reasoning as
     * pick() above, plus EXTRA_ALLOW_MULTIPLE; the files come back as this
     * call's own RESULT rather than down the `open` event, because the batch
     * importer is their destination and a route file means something
     * different there (a remembered plan) than it does to the dispatcher (the
     * workspace).
     */
    @PluginMethod
    public void pickMany(PluginCall call) {
        Intent intent = new Intent(Intent.ACTION_OPEN_DOCUMENT);
        intent.addCategory(Intent.CATEGORY_OPENABLE);
        intent.putExtra(Intent.EXTRA_ALLOW_MULTIPLE, true);
        intent.setType("*/*");
        startActivityForResult(call, intent, "pickManyResult");
    }

    @ActivityCallback
    private void pickManyResult(PluginCall call, ActivityResult result) {
        if (call == null) {
            return;
        }
        JSArray files = new JSArray();
        Intent data = result.getData();
        if (result.getResultCode() == Activity.RESULT_OK && data != null) {
            ClipData clip = data.getClipData();
            if (clip != null) {
                for (int i = 0; i < clip.getItemCount(); i++) {
                    JSObject one = readOne(clip.getItemAt(i).getUri());
                    if (one != null) {
                        files.put(one);
                    }
                }
            } else if (data.getData() != null) {
                JSObject one = readOne(data.getData());
                if (one != null) {
                    files.put(one);
                }
            }
        }
        // A dismissed picker resolves with nothing, which is not a failure;
        // an unreadable file is simply absent from the batch.
        JSObject ret = new JSObject();
        ret.put("files", files);
        call.resolve(ret);
    }

    private JSObject readOne(Uri uri) {
        return readFile(uri);
    }

    @ActivityCallback
    private void pickResult(PluginCall call, ActivityResult result) {
        if (call == null) {
            return;
        }
        Intent data = result.getData();
        Uri uri = data == null ? null : data.getData();
        if (result.getResultCode() != Activity.RESULT_OK || uri == null) {
            call.resolve(); // dismissed, which is not a failure
            return;
        }
        JSObject picked = readFile(uri);
        if (picked == null) {
            call.reject("the file could not be read");
            return;
        }
        notifyListeners(EVENT_OPEN, picked, true);
        call.resolve();
    }

    private JSObject readIntent(Intent intent) {
        if (intent == null) {
            return null;
        }
        String action = intent.getAction();
        Uri uri = null;
        if (Intent.ACTION_VIEW.equals(action)) {
            uri = intent.getData();
        } else if (Intent.ACTION_SEND.equals(action)) {
            uri = IntentCompat.getParcelableExtra(intent, Intent.EXTRA_STREAM, Uri.class);
            if (uri == null) {
                // Text shared directly rather than as a file: a briefing pasted
                // out of another app arrives this way.
                CharSequence text = intent.getCharSequenceExtra(Intent.EXTRA_TEXT);
                return text == null ? null : file("", text.toString());
            }
        }
        if (uri == null) {
            return null;
        }
        return readFile(uri);
    }

    private JSObject file(String name, String text) {
        JSObject o = new JSObject();
        o.put("name", name);
        o.put("text", text);
        return o;
    }

    /**
     * One file for the web side. A BINARY file (a KMZ is a ZIP) rides as
     * base64 instead of text: this channel is JSON, and decoding those bytes
     * as UTF-8 would replace every invalid sequence beyond recovery. The
     * magic is the test, not the name, because a provider's display name is
     * often absent or an opaque document id.
     */
    private JSObject file(String name, byte[] bytes) {
        if (isZip(bytes)) {
            JSObject o = new JSObject();
            o.put("name", name);
            o.put("text", "");
            o.put("bytes", Base64.encodeToString(bytes, Base64.NO_WRAP));
            return o;
        }
        return file(name, new String(bytes, StandardCharsets.UTF_8));
    }

    /** "PK\x03\x04", the ZIP local-file-header magic. */
    private boolean isZip(byte[] b) {
        return b.length >= 4 && b[0] == 0x50 && b[1] == 0x4b && b[2] == 0x03 && b[3] == 0x04;
    }

    /**
     * One incoming file for the web side, read ONCE: small files arrive as
     * text or base64 exactly as they always did, and anything past INLINE_MAX
     * is spilled to the app cache and handed over as a path. Reading once
     * matters because a content:// stream is not reliably re-openable, so
     * deciding the size first and then reading again would be a second grant
     * the provider need not honour.
     */
    private JSObject readFile(Uri uri) {
        String name = displayName(uri);
        try (InputStream in = getContext().getContentResolver().openInputStream(uri)) {
            if (in == null) {
                return null;
            }
            ByteArrayOutputStream head = new ByteArrayOutputStream();
            byte[] buf = new byte[64 * 1024];
            int read;
            while (head.size() < INLINE_MAX && (read = in.read(buf)) != -1) {
                head.write(buf, 0, read);
            }
            if (head.size() < INLINE_MAX) {
                return file(name, head.toByteArray()); // the whole file
            }
            return spill(uri, name, head, in, buf);
        } catch (IOException | SecurityException | IllegalArgumentException e) {
            // No grant, gone, or unreadable: the app opens as if nothing came.
            Logger.error("Unable to read " + uri, e);
            return null;
        }
    }

    /** Drain the rest of a large file into the app cache and describe it by
     *  path. The partial file is deleted on any failure: a truncated archive
     *  read as a whole one is worse than nothing arriving. */
    private JSObject spill(Uri uri, String name, ByteArrayOutputStream head, InputStream in, byte[] buf)
        throws IOException {
        File dir = new File(getContext().getCacheDir(), INCOMING_DIR);
        if (!dir.isDirectory() && !dir.mkdirs()) {
            Logger.warn("OpenFile", "cannot create " + dir);
            return null;
        }
        sweep(dir);
        File out = new File(dir, System.nanoTime() + "-" + safeName(name));
        long total = head.size();
        try (OutputStream os = new FileOutputStream(out)) {
            head.writeTo(os);
            int read;
            while ((read = in.read(buf)) != -1) {
                total += read;
                if (total > MAX_BYTES) {
                    Logger.warn("OpenFile", "file over " + MAX_BYTES + " bytes, ignored: " + uri);
                    os.close();
                    out.delete();
                    return null;
                }
                os.write(buf, 0, read);
            }
        } catch (IOException e) {
            out.delete();
            throw e;
        }
        JSObject o = new JSObject();
        o.put("name", name);
        o.put("text", "");
        o.put("path", out.getAbsolutePath());
        return o;
    }

    /** Drop spilled files the web side has had every chance to read. The app
     *  cache is reclaimable by the system anyway; this keeps a batch import of
     *  large bundles from leaving several behind for the rest of the session. */
    private void sweep(File dir) {
        File[] old = dir.listFiles();
        if (old == null) {
            return;
        }
        long cutoff = System.currentTimeMillis() - SPILL_TTL_MS;
        for (File f : old) {
            if (f.lastModified() < cutoff) {
                f.delete();
            }
        }
    }

    /** A display name is provider-supplied text; it must not steer the write
     *  out of the directory it was given. */
    private String safeName(String name) {
        String base = name == null ? "" : name.replaceAll("[^A-Za-z0-9._-]", "_");
        return base.isEmpty() ? "file" : base;
    }

    private String displayName(Uri uri) {
        try (
            Cursor c = getContext()
                .getContentResolver()
                .query(uri, new String[] { OpenableColumns.DISPLAY_NAME }, null, null, null)
        ) {
            if (c != null && c.moveToFirst()) {
                String name = c.getString(0);
                if (name != null) {
                    return name;
                }
            }
        } catch (Exception e) {
            // A provider that answers no query still gives a usable last segment.
        }
        String last = uri.getLastPathSegment();
        return last == null ? "" : last;
    }
}
