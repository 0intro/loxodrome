package fr.loxodrome.app;

import static org.junit.Assert.assertEquals;

import com.getcapacitor.JSObject;
import com.getcapacitor.PermissionState;
import com.getcapacitor.PluginCall;
import org.junit.Test;

public class ReminderPluginTest {

    private static PluginCall schedule(String options) throws Exception {
        return new PluginCall(null, "Reminder", "1", "schedule", new JSObject(options));
    }

    @Test
    public void atMs() throws Exception {
        String[][] cases = {
            // The RTBA release of 2026-11-22, past the int range.
            { "{\"atMs\":1795368600000,\"title\":\"t\",\"text\":\"x\",\"channel\":\"c\"}", "1795368600000" },
            { "{\"atMs\":1795368600000.5}", "1795368600000" },
            { "{\"title\":\"t\"}", "-1" },
        };
        for (String[] c : cases) {
            assertEquals(c[0], Long.parseLong(c[1]), ReminderPlugin.atMs(schedule(c[0])));
        }
    }

    @Test
    public void permissionText() {
        Object[][] cases = {
            // sdk, state, app notifications on, channel on, read as
            { 34, PermissionState.GRANTED, true, true, "granted" },
            { 34, PermissionState.PROMPT, false, true, "prompt" },
            { 34, PermissionState.PROMPT_WITH_RATIONALE, false, true, "prompt" },
            // Capacitor's DENIED also follows a question dismissed with Back,
            // which Android asks again: a press finds out.
            { 34, PermissionState.DENIED, false, true, "prompt" },
            // The reminder's channel turned off in Android's settings.
            { 34, PermissionState.GRANTED, true, false, "denied" },
            // Before API 33 the app's notification switch decides.
            { 30, PermissionState.PROMPT, true, true, "granted" },
            { 30, PermissionState.PROMPT, false, true, "denied" },
        };
        for (Object[] c : cases) {
            assertEquals(
                c[0] + " " + c[1] + " " + c[2] + " " + c[3],
                c[4],
                ReminderPlugin.permissionText((int) c[0], (PermissionState) c[1], (boolean) c[2], (boolean) c[3])
            );
        }
    }
}
