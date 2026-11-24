package fr.loxodrome.app;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertTrue;

import java.io.BufferedWriter;
import java.io.File;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.OutputStreamWriter;
import java.io.Writer;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.util.ArrayList;
import java.util.List;
import java.util.Locale;
import org.json.JSONObject;
import org.junit.Rule;
import org.junit.Test;
import org.junit.rules.TemporaryFolder;

public class NavJournalTest {

    @Rule
    public TemporaryFolder tmp = new TemporaryFolder();

    private static String page(NavJournal.ReadResult r) {
        List<Long> t = new ArrayList<>();
        for (JSONObject o : r.fixes) {
            t.add(o.optLong("tMs"));
        }
        return t + (r.done ? " done" : " more");
    }

    @Test
    public void readAfterPagesPastTheCursor() throws Exception {
        File f = tmp.newFile("journal.jsonl");
        // The last line is torn, as a kill mid-append leaves it.
        String journal = "{\"tMs\":1000}\n{\"tMs\":2000}\n{\"tMs\":3000}\n{\"tMs\":4000}\n{\"tMs\":50";
        Files.write(f.toPath(), journal.getBytes(StandardCharsets.UTF_8));
        Object[][] cases = {
            { 0L, 2000, "[1000, 2000, 3000, 4000] done" },
            { 0L, 2, "[1000, 2000] more" },
            { 2000L, 2, "[3000, 4000] done" },
            { 4000L, 2, "[] done" },
        };
        for (Object[] c : cases) {
            String got = page(NavJournal.readAfter(f, (long) c[0], (int) c[1]));
            assertEquals("afterMs " + c[0] + " limit " + c[1], c[2], got);
        }
        assertEquals("[] done", page(NavJournal.readAfter(new File(tmp.getRoot(), "absent"), 0L, 2000)));
    }

    @Test
    public void truncateToTailEndsUnderTheGuard() throws Exception {
        // A moving fix as the service writes it, 175 bytes with its newline:
        // the floats it widens to double print up to 17 significant digits.
        String fix =
            "{\"tMs\":%d,\"lat\":48.41693513230927,\"lon\":2.2766250131766905,\"altM\":1184.5360840429873," +
            "\"accM\":4.21999979019165,\"spdMps\":45.29999923706055,\"brgDeg\":123.4000015258789}\n";
        long t0 = 1763380000000L;
        int size = String.format(Locale.ROOT, fix, t0).length();
        int n = 130_000;
        File f = tmp.newFile("journal.jsonl");
        try (Writer w = new BufferedWriter(new OutputStreamWriter(new FileOutputStream(f), StandardCharsets.UTF_8))) {
            for (int i = 0; i < n; i++) {
                w.write(String.format(Locale.ROOT, fix, t0 + i * 1000L));
            }
        }
        assertTrue(f.length() > NavJournal.MAX_BYTES);
        NavJournal.truncateToTail(f);
        assertTrue("kept " + f.length() + " bytes", f.length() <= NavJournal.MAX_BYTES / 2);
        List<String> kept = Files.readAllLines(f.toPath(), StandardCharsets.UTF_8);
        int first = n - kept.size();
        assertEquals(String.format(Locale.ROOT, fix, t0 + (n - 1) * 1000L).trim(), kept.get(kept.size() - 1));
        assertEquals(String.format(Locale.ROOT, fix, t0 + first * 1000L).trim(), kept.get(0));
        // As many of the newest as fit: one more would overrun the budget.
        assertTrue(f.length() + size > NavJournal.MAX_BYTES / 2);
    }

    @Test(expected = IOException.class)
    public void readAfterReportsAnUnreadableJournal() throws Exception {
        File dir = tmp.newFolder("journal.jsonl");
        NavJournal.readAfter(dir, 0L, 2000);
    }
}
