package fr.loxodrome.app;

import static org.junit.Assert.assertEquals;

import com.getcapacitor.JSObject;
import com.getcapacitor.PluginCall;
import org.junit.Test;

public class NavRecorderPluginTest {

    /** A drain call as the bridge builds it: the options the web app
     *  serialised, parsed into the call's data. */
    private static PluginCall drain(String options) throws Exception {
        return new PluginCall(null, "NavRecorder", "1", "drain", new JSObject(options));
    }

    @Test
    public void afterMs() throws Exception {
        String[][] cases = {
            // A trace tail in epoch milliseconds, past the int range.
            { "{\"afterMs\":1763380000000,\"limit\":2000}", "1763380000000" },
            // An empty trace drains from the start.
            { "{\"afterMs\":0,\"limit\":2000}", "0" },
            { "{\"afterMs\":1763380000000.5,\"limit\":2000}", "1763380000000" },
            { "{\"limit\":2000}", "0" },
        };
        for (String[] c : cases) {
            assertEquals(c[0], Long.parseLong(c[1]), NavRecorderPlugin.afterMs(drain(c[0])));
        }
    }
}
