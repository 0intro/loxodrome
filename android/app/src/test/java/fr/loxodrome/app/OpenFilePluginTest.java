package fr.loxodrome.app;

import static org.junit.Assert.assertEquals;

import java.nio.charset.StandardCharsets;
import org.junit.Test;

public class OpenFilePluginTest {

    @Test
    public void textCarriesOnlyUtf8() {
        byte[] latin1 = "<trkpt><name>Étampes</name></trkpt>".getBytes(StandardCharsets.ISO_8859_1);
        byte[] zip = "PK\u0003\u0004doc.kml".getBytes(StandardCharsets.US_ASCII);
        Object[][] cases = {
            { "routes:\n", "routes:\n" },
            { "<trkpt><name>Étampes</name></trkpt>".getBytes(StandardCharsets.UTF_8), "<trkpt><name>Étampes</name></trkpt>" },
            // A BOM stays, so the web side's re-encoding gives back the same bytes.
            { "﻿<gpx>".getBytes(StandardCharsets.UTF_8), "﻿<gpx>" },
            { new byte[0], "" },
            { latin1, null },
            { zip, null },
        };
        for (Object[] c : cases) {
            byte[] in = c[0] instanceof String ? ((String) c[0]).getBytes(StandardCharsets.UTF_8) : (byte[]) c[0];
            assertEquals(new String(in, StandardCharsets.ISO_8859_1), c[1], OpenFilePlugin.text(in));
        }
    }
}
