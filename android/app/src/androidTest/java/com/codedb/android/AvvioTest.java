package com.codedb.android;

import android.content.Intent;
import androidx.test.platform.app.InstrumentationRegistry;
import org.junit.Test;
import static org.junit.Assert.*;
import android.webkit.WebView;
import android.view.View;
import android.view.ViewGroup;
import android.widget.FrameLayout;
import androidx.core.graphics.Insets;
import androidx.core.view.ViewCompat;
import androidx.core.view.WindowInsetsCompat;
import java.net.HttpURLConnection;
import java.net.URL;
import java.io.ByteArrayOutputStream;
import java.io.OutputStream;
import java.io.IOException;
import java.lang.reflect.Field;
import android.os.Looper;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicReference;

/** Prova sul vero runtime nativo: un semplice test JVM non carica libnode.so. */
public class AvvioTest {
    @Test public void testServerAutonomo() throws Exception {
        android.app.Instrumentation instrumentation = InstrumentationRegistry.getInstrumentation();
        Intent launch = new Intent(instrumentation.getTargetContext(), MainActivity.class).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
        MainActivity activity = (MainActivity) instrumentation.startActivitySync(launch);
        for (int i = 0; i < 1200 && Runtime.url == null && Runtime.error == null; i++) Thread.sleep(100);
        assertNull(Runtime.error);
        assertNotNull("Il server incorporato non è partito", Runtime.url);
        HttpURLConnection denied = (HttpURLConnection) new URL(Runtime.url + "/handshake-check").openConnection();
        denied.setConnectTimeout(5000); denied.setReadTimeout(5000);
        assertEquals("Le altre app non devono accedere al server", 403, denied.getResponseCode());
        denied.disconnect();
        HttpURLConnection allowed = (HttpURLConnection) new URL(Runtime.url + "/handshake-check").openConnection();
        allowed.setRequestProperty("Cookie", "codedb_mobile=" + Runtime.secret);
        assertEquals(200, allowed.getResponseCode());
        allowed.disconnect();
        // Verifica anche il cookie WebView e Socket.IO, non soltanto il server HTTP.
        AtomicReference<String> result = new AtomicReference<>();
        for (int attempt = 0; attempt < 120; attempt++) {
            CountDownLatch latch = new CountDownLatch(1);
            activity.runOnUiThread(() -> {
                FrameLayout content = (FrameLayout) ((ViewGroup) activity.findViewById(android.R.id.content)).getChildAt(0);
                if (!(content.getChildAt(0) instanceof WebView)) { latch.countDown(); return; }
                ((WebView) content.getChildAt(0)).evaluateJavascript("(() => { if (!window.io) return 'attesa'; if (!window.__testSocket) { window.__testSocket=io(); window.__testSocket.on('connect',()=>window.__testConnected=true); } return window.__testConnected === true; })()", value -> { result.set(value); latch.countDown(); });
            });
            // Il primo caricamento del renderer con GPU software può superare
            // cinque secondi; resta un timeout finito anche sui runner CI.
            assertTrue("La WebView deve rispondere", latch.await(30, TimeUnit.SECONDS));
            if ("true".equals(result.get())) break;
            Thread.sleep(500);
        }
        assertEquals("Socket.IO deve collegarsi dalla WebView", "true", result.get());
        instrumentation.runOnMainSync(() -> verificaInset(activity));
        verificaDownload(activity, instrumentation);
    }

    private void verificaDownload(MainActivity activity, android.app.Instrumentation instrumentation) throws Exception {
        CountDownLatch entered = new CountDownLatch(1), release = new CountDownLatch(1), closed = new CountDownLatch(1);
        AtomicReference<Boolean> writeOnUi = new AtomicReference<>(), closeOnUi = new AtomicReference<>();
        ByteArrayOutputStream bytes = new ByteArrayOutputStream();
        OutputStream slow = new OutputStream() {
            @Override public void write(int b) { bytes.write(b); }
            @Override public void write(byte[] b, int off, int len) throws IOException {
                writeOnUi.set(Looper.myLooper() == Looper.getMainLooper());
                entered.countDown();
                try { if (!release.await(10, TimeUnit.SECONDS)) throw new IOException("Provider di prova non sbloccato"); }
                catch (InterruptedException error) { Thread.currentThread().interrupt(); throw new IOException(error); }
                bytes.write(b, off, len);
            }
            @Override public void close() { closeOnUi.set(Looper.myLooper() == Looper.getMainLooper()); closed.countDown(); }
        };
        Field output = MainActivity.class.getDeclaredField("download");
        output.setAccessible(true);
        AtomicReference<WebView> browser = new AtomicReference<>();
        instrumentation.runOnMainSync(() -> {
            try { output.set(activity, slow); } catch (IllegalAccessException error) { throw new AssertionError(error); }
            FrameLayout root = (FrameLayout) ((ViewGroup) activity.findViewById(android.R.id.content)).getChildAt(0);
            browser.set((WebView) root.getChildAt(0));
            browser.get().evaluateJavascript("CodeDBFiles.onmessage=e=>window.__fileReply=e.data; CodeDBFiles.postMessage(JSON.stringify({op:'chunk',data:'AAH/'}));", null);
        });
        try {
            assertTrue("Il bridge deve iniziare la scrittura", entered.await(30, TimeUnit.SECONDS));
            CountDownLatch heartbeat = new CountDownLatch(1);
            activity.runOnUiThread(heartbeat::countDown);
            assertTrue("La UI risponde mentre il provider è bloccato", heartbeat.await(2, TimeUnit.SECONDS));
            assertEquals(Boolean.FALSE, writeOnUi.get());
        } finally { release.countDown(); }
        // Il messaggio successivo può arrivare subito: l'executor conserva
        // l'ordine e chiude soltanto dopo aver scritto tutti i byte.
        instrumentation.runOnMainSync(() -> browser.get().evaluateJavascript("CodeDBFiles.postMessage(JSON.stringify({op:'end'}));", null));
        assertTrue("Il file viene chiuso", closed.await(30, TimeUnit.SECONDS));
        assertEquals(Boolean.FALSE, closeOnUi.get());
        assertArrayEquals(new byte[] {0, 1, (byte) 255}, bytes.toByteArray());
    }

    private void verificaInset(MainActivity activity) {
        FrameLayout root = (FrameLayout) ((ViewGroup) activity.findViewById(android.R.id.content)).getChildAt(0);
        WebView web = (WebView) root.getChildAt(0);
        View probe = new View(activity);
        AtomicReference<Insets> inoltrati = new AtomicReference<>();
        int bars = WindowInsetsCompat.Type.systemBars();
        int cutout = WindowInsetsCompat.Type.displayCutout();
        int ime = WindowInsetsCompat.Type.ime();
        ViewCompat.setOnApplyWindowInsetsListener(probe, (v, insets) -> {
            inoltrati.set(insets.getInsets(bars | cutout | ime));
            return insets;
        });
        root.addView(probe, new FrameLayout.LayoutParams(0, 0));
        try {
            // Verticale/orizzontale, navigazione a gesti/tre tasti, tastiera
            // aperta e richiusa: i valori sono pixel, come gli inset del sistema.
            int[][] casi = {{0, 60, 24, 0}, {80, 24, 48, 0}, {0, 60, 24, 300}, {0, 60, 24, 0}};
            for (int[] c : casi) {
                WindowInsetsCompat insets = new WindowInsetsCompat.Builder()
                    .setInsets(bars, Insets.of(0, 24, 0, c[2]))
                    .setInsets(cutout, Insets.of(c[0], c[1], 0, 0))
                    .setInsets(ime, Insets.of(0, 0, 0, c[3])).build();
                ViewCompat.dispatchApplyWindowInsets(root, insets);
                root.measure(View.MeasureSpec.makeMeasureSpec(900, View.MeasureSpec.EXACTLY),
                    View.MeasureSpec.makeMeasureSpec(700, View.MeasureSpec.EXACTLY));
                root.layout(0, 0, 900, 700);
                assertEquals("Notch laterale rispettato", c[0], web.getLeft());
                assertEquals("Notch superiore rispettato", c[1], web.getTop());
                assertEquals("Tastiera e barra non si sommano", 700 - Math.max(c[2], c[3]), web.getBottom());
                assertEquals("Nessun doppio inset nella WebView", Insets.NONE, inoltrati.get());
            }
        } finally {
            root.removeView(probe);
            root.requestLayout();
            ViewCompat.requestApplyInsets(root);
        }
    }
}
