package com.codedb.android;

import android.content.Context;
import android.content.ContextWrapper;
import java.util.concurrent.atomic.AtomicInteger;
import org.junit.Test;
import static org.junit.Assert.*;

public class RipresaRuntimeTest {
    @Test public void unErrorePrimaDiNodePermetteUnAltroAvvio() throws Exception {
        AtomicInteger tentativi = new AtomicInteger();
        Context contesto = new ContextWrapper(null) {
            @Override public Context getApplicationContext() { tentativi.incrementAndGet(); return this; }
        };
        // Sulla JVM manca libnode Android. Il caricamento fallisce prima
        // dell'ingresso nel runtime nativo, come l'estrazione senza spazio.
        Runtime.start(contesto);
        long termine = System.nanoTime() + 5000000000L;
        while (Runtime.error == null && System.nanoTime() < termine) Thread.sleep(5);
        assertNotNull(Runtime.error);
        Runtime.start(contesto);
        assertEquals("Riprova deve rieseguire la preparazione", 2, tentativi.get());
    }
}
