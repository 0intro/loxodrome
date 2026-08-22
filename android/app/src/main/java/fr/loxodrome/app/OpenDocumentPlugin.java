package fr.loxodrome.app;

import android.content.ActivityNotFoundException;
import android.content.Intent;
import android.net.Uri;
import androidx.core.content.FileProvider;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import java.io.File;
import java.io.IOException;

/**
 * Opens a stored AIP document (a VAC plate, an AIP supplement) in whichever
 * PDF viewer the phone has.
 *
 * The bytes live inside a downloaded pack in OPFS, which no FileProvider root
 * can reach, so the web side extracts the one document to the app cache first
 * and hands this plugin the resulting file:// URI. The cache is already a
 * declared provider root (res/xml/file_paths.xml), so no manifest path is
 * added here; the &lt;queries&gt; intent in the manifest is needed though,
 * without which resolveActivity answers null on Android 11+ even when a
 * viewer is installed.
 *
 * The path is checked against the app's own cache and files directories
 * before a content URI is granted for it. A plugin that FileProvidered any
 * path it was handed would let a compromised web layer read out arbitrary
 * app-private files through whatever app the user picked.
 */
@CapacitorPlugin(name = "OpenDocument")
public class OpenDocumentPlugin extends Plugin {

    private static final String PDF_MIME = "application/pdf";

    @PluginMethod
    public void view(PluginCall call) {
        String uri = call.getString("uri", "");
        if (uri == null || uri.trim().isEmpty()) {
            call.reject("no uri");
            return;
        }
        String path = Uri.parse(uri).getPath();
        if (path == null) {
            call.reject("bad uri");
            return;
        }
        File file = new File(path);
        if (!isOwnFile(file)) {
            call.reject("path outside the app's own storage");
            return;
        }
        if (!file.isFile()) {
            call.reject("no such document");
            return;
        }

        Uri shared;
        try {
            shared = FileProvider.getUriForFile(
                getContext(),
                getContext().getPackageName() + ".fileprovider",
                file
            );
        } catch (IllegalArgumentException e) {
            call.reject("document is not in a shareable directory");
            return;
        }

        Intent view = new Intent(Intent.ACTION_VIEW);
        view.setDataAndType(shared, PDF_MIME);
        view.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION);
        if (view.resolveActivity(getContext().getPackageManager()) == null) {
            call.reject("no PDF viewer installed");
            return;
        }
        // A chooser rather than the last-used app: a pilot who picked a
        // viewer once should still be able to reach another one.
        Intent chooser = Intent.createChooser(view, null);
        chooser.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION);
        try {
            getActivity().startActivity(chooser);
            call.resolve();
        } catch (ActivityNotFoundException e) {
            call.reject("no PDF viewer installed");
        }
    }

    /** True when the file sits inside this app's own cache or files tree.
     *  Canonical paths, so "../" cannot walk out of them. */
    private boolean isOwnFile(File file) {
        try {
            String target = file.getCanonicalPath();
            for (File root : new File[] { getContext().getCacheDir(), getContext().getFilesDir() }) {
                if (root != null && target.startsWith(root.getCanonicalPath() + File.separator)) {
                    return true;
                }
            }
        } catch (IOException e) {
            return false;
        }
        return false;
    }
}
