package fr.loxodrome.app;

import android.os.Bundle;
import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {

    @Override
    public void onCreate(Bundle savedInstanceState) {
        // Local plugins register before super.onCreate builds the bridge.
        registerPlugin(PrintPlugin.class);
        registerPlugin(SendFplPlugin.class);
        registerPlugin(OpenFilePlugin.class);
        registerPlugin(OpenDocumentPlugin.class);
        registerPlugin(NavRecorderPlugin.class);
        super.onCreate(savedInstanceState);
    }
}
