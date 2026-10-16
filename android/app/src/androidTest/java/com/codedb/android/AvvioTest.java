package com.codedb.android;

import android.content.Intent;
import androidx.test.platform.app.InstrumentationRegistry;
import org.junit.Test;
import static org.junit.Assert.*;
import android.webkit.WebView;
import android.view.View;
import android.view.ViewGroup;
import android.widget.FrameLayout;
import android.graphics.Color;
import android.graphics.Bitmap;
import android.graphics.Canvas;
import android.provider.Settings;
import android.graphics.drawable.ColorDrawable;
import android.widget.TextView;
import androidx.core.view.WindowCompat;
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
import java.util.concurrent.atomic.AtomicInteger;

/** Prova sul vero runtime nativo: un semplice test JVM non carica libnode.so. */
public class AvvioTest {
    @Test public void testServerAutonomo() throws Exception {
        android.app.Instrumentation instrumentation = InstrumentationRegistry.getInstrumentation();
        // Il tema dell'app può essere scuro anche quando Android usa quello chiaro.
        instrumentation.getTargetContext().getSharedPreferences("appearance", 0).edit()
            .putInt("background", 0xff123b2c).putInt("foreground", Color.WHITE)
            .putBoolean("automatic", false).commit();
        Intent launch = new Intent(instrumentation.getTargetContext(), MainActivity.class).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
        MainActivity activity = (MainActivity) instrumentation.startActivitySync(launch);
        // Comprende il collegamento della finestra e la transizione dello splash di sistema.
        Thread.sleep(500);
        instrumentation.runOnMainSync(() -> {
            FrameLayout root = (FrameLayout) ((ViewGroup) activity.findViewById(android.R.id.content)).getChildAt(0);
            assertTrue("Lo splash mostra la scena animata nativa", contiene(root, AvvioView.class, null));
            assertTrue("Lo splash mostra il marchio", contiene(root, TextView.class, "CodeDB"));
            assertFalse("La vecchia pagina di avvio è stata sostituita", contiene(root, TextView.class, "Avvio di CodeDB sul telefono…"));
            assertEquals("Lo splash usa subito il tema salvato", 0xff123b2c, ((ColorDrawable) root.getBackground()).getColor());
            assertFalse("Icone chiare già durante lo splash scuro", WindowCompat.getInsetsController(activity.getWindow(), root).isAppearanceLightStatusBars());
            assertFalse("Navigazione chiara già durante lo splash scuro", WindowCompat.getInsetsController(activity.getWindow(), root).isAppearanceLightNavigationBars());
        });
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
        verificaAspettoEGesti(activity, instrumentation);
        instrumentation.runOnMainSync(() -> verificaInset(activity));
        verificaDownload(activity, instrumentation);
        verificaAnimazione(activity, instrumentation);
    }

    private Bitmap fotogramma(View view, android.app.Instrumentation instrumentation) {
        AtomicReference<Bitmap> image = new AtomicReference<>();
        instrumentation.runOnMainSync(() -> {
            Bitmap frame = Bitmap.createBitmap(view.getWidth(), view.getHeight(), Bitmap.Config.ARGB_8888);
            view.draw(new Canvas(frame));
            image.set(frame);
        });
        return image.get();
    }

    private void scalaAnimazioni(android.app.Instrumentation instrumentation, String value) throws Exception {
        String command = value == null ? "settings delete global animator_duration_scale" : "settings put global animator_duration_scale " + value;
        try (android.os.ParcelFileDescriptor result = instrumentation.getUiAutomation().executeShellCommand(command);
             java.io.InputStream stream = new android.os.ParcelFileDescriptor.AutoCloseInputStream(result)) {
            while (stream.read() != -1) { /* Attende il completamento del comando. */ }
        }
        // Un'animazione continua non rende necessariamente inattiva la coda su GPU software.
        // Sincronizza il thread UI senza aspettare che il disegno termini.
        instrumentation.runOnMainSync(() -> {});
        Thread.sleep(100);
    }

    private void verificaAnimazione(MainActivity activity, android.app.Instrumentation instrumentation) throws Exception {
        String scala = Settings.Global.getString(activity.getContentResolver(), Settings.Global.ANIMATOR_DURATION_SCALE);
        AtomicReference<AvvioView> scena = new AtomicReference<>();
        AtomicInteger retries = new AtomicInteger(), completamenti = new AtomicInteger();
        FrameLayout root = (FrameLayout) ((ViewGroup) activity.findViewById(android.R.id.content)).getChildAt(0);
        try {
            scalaAnimazioni(instrumentation, "1");
            instrumentation.runOnMainSync(() -> {
                scena.set(new AvvioView(activity, 0xff1b1e25, 0xffe2e8f0, 0xff585aee, retries::incrementAndGet));
                root.addView(scena.get(), new FrameLayout.LayoutParams(-1, -1));
            });
            Thread.sleep(1200);
            Bitmap prima = fotogramma(scena.get(), instrumentation);
            Thread.sleep(300);
            Bitmap dopo = fotogramma(scena.get(), instrumentation);
            assertFalse("La scena evolve durante il caricamento", prima.sameAs(dopo));
            prima.recycle(); dopo.recycle();

            instrumentation.runOnMainSync(() -> scena.get().setVisibility(View.INVISIBLE));
            prima = fotogramma(scena.get(), instrumentation);
            Thread.sleep(300);
            dopo = fotogramma(scena.get(), instrumentation);
            assertTrue("Una scena nascosta non continua a disegnare", prima.sameAs(dopo));
            prima.recycle(); dopo.recycle();
            instrumentation.runOnMainSync(() -> scena.get().setVisibility(View.VISIBLE));

            scalaAnimazioni(instrumentation, "0");
            prima = fotogramma(scena.get(), instrumentation);
            Thread.sleep(300);
            dopo = fotogramma(scena.get(), instrumentation);
            assertTrue("Riduci animazioni arresta anche le orbite già avviate", prima.sameAs(dopo));
            prima.recycle(); dopo.recycle();
            instrumentation.runOnMainSync(() -> {
                scena.get().completa(completamenti::incrementAndGet);
                scena.get().completa(completamenti::incrementAndGet);
                assertEquals("Senza animazioni l'app appare subito, una sola volta", 1, completamenti.get());
                root.removeView(scena.get());
                scena.set(new AvvioView(activity, 0xff1b1e25, 0xffe2e8f0, 0xff585aee, retries::incrementAndGet));
                root.addView(scena.get(), new FrameLayout.LayoutParams(-1, -1));
            });
            scalaAnimazioni(instrumentation, "1");
            instrumentation.runOnMainSync(() -> scena.get().errore("Impossibile aprire CodeDB. Riprova."));
            prima = fotogramma(scena.get(), instrumentation);
            Thread.sleep(300);
            dopo = fotogramma(scena.get(), instrumentation);
            assertTrue("Un errore ferma l'animazione di attesa", prima.sameAs(dopo));
            prima.recycle(); dopo.recycle();
            instrumentation.runOnMainSync(() -> {
                android.widget.Button button = (android.widget.Button) trova(scena.get(), android.widget.Button.class);
                assertEquals("Il recupero è visibile", View.VISIBLE, button.getVisibility());
                button.performClick();
                assertEquals("Riprova rilancia il caricamento", 1, retries.get());
                assertEquals(View.GONE, button.getVisibility());
            });
            prima = fotogramma(scena.get(), instrumentation);
            Thread.sleep(300);
            dopo = fotogramma(scena.get(), instrumentation);
            assertFalse("Riprova riavvia la scena", prima.sameAs(dopo));
            prima.recycle(); dopo.recycle();
            instrumentation.runOnMainSync(() -> {
                scena.get().completa(completamenti::incrementAndGet);
                scena.get().completa(completamenti::incrementAndGet);
            });
            Thread.sleep(650);
            assertEquals("L'uscita animata termina una sola volta", 2, completamenti.get());
            instrumentation.runOnMainSync(() -> {
                assertEquals("Lo splash lascia visibile l'app", 0, scena.get().getAlpha(), .001);
                root.removeView(scena.get());
                scena.set(new AvvioView(activity, Color.WHITE, 0xff1f2937, 0xff585aee, () -> {}));
                root.addView(scena.get(), new FrameLayout.LayoutParams(-1, -1));
                scena.get().completa(completamenti::incrementAndGet);
                root.removeView(scena.get());
            });
            Thread.sleep(450);
            assertEquals("Una scena rimossa non richiama l'Activity", 2, completamenti.get());
            scalaAnimazioni(instrumentation, "0");
            verificaLayoutSplash(activity, instrumentation);
        } finally {
            instrumentation.runOnMainSync(() -> { if (scena.get() != null) root.removeView(scena.get()); });
            scalaAnimazioni(instrumentation, scala);
        }
    }

    private View trova(View view, Class<?> tipo) {
        if (tipo.isInstance(view)) return view;
        if (view instanceof ViewGroup) for (int i = 0; i < ((ViewGroup) view).getChildCount(); i++) {
            View found = trova(((ViewGroup) view).getChildAt(i), tipo);
            if (found != null) return found;
        }
        return null;
    }

    private void verificaLayoutSplash(MainActivity activity, android.app.Instrumentation instrumentation) {
        instrumentation.runOnMainSync(() -> {
            int[][] casi = {{320, 480, 100}, {640, 320, 100}, {320, 480, 160}};
            for (int[] caso : casi) {
                android.content.res.Configuration config = new android.content.res.Configuration(activity.getResources().getConfiguration());
                config.fontScale = caso[2] / 100f;
                android.content.Context context = activity.createConfigurationContext(config);
                AvvioView view = new AvvioView(context, 0xff1b1e25, 0xffe2e8f0, 0xff585aee, () -> {});
                float density = context.getResources().getDisplayMetrics().density;
                int w = Math.round(caso[0] * density), h = Math.round(caso[1] * density);
                for (boolean errore : new boolean[] { false, true }) {
                    if (errore) view.errore("Il caricamento sta impiegando più del previsto. Riprova ad aprire l'interfaccia.");
                    view.measure(View.MeasureSpec.makeMeasureSpec(w, View.MeasureSpec.EXACTLY), View.MeasureSpec.makeMeasureSpec(h, View.MeasureSpec.EXACTLY));
                    view.layout(0, 0, w, h);
                    controllaTesti(view, view);
                    android.graphics.Rect centro = new android.graphics.Rect(), piede = new android.graphics.Rect();
                    View composition = ((ViewGroup) view.getChildAt(0)).getChildAt(0);
                    composition.getDrawingRect(centro); view.offsetDescendantRectToMyCoords(composition, centro);
                    view.getChildAt(1).getDrawingRect(piede); view.offsetDescendantRectToMyCoords(view.getChildAt(1), piede);
                    assertTrue("Il marchio non si sovrappone allo stato", centro.bottom <= piede.top);
                    assertTrue("La scena resta dentro lo schermo", centro.top >= 0);
                }
            }
        });
    }

    private void controllaTesti(View view, ViewGroup root) {
        if (view.getVisibility() == View.GONE) return;
        if (view instanceof TextView) {
            TextView text = (TextView) view;
            android.graphics.Rect bounds = new android.graphics.Rect();
            text.getDrawingRect(bounds); root.offsetDescendantRectToMyCoords(text, bounds);
            assertTrue("Testo nello schermo: " + text.getText(), bounds.left >= 0 && bounds.right <= root.getWidth() && bounds.top >= 0 && bounds.bottom <= root.getHeight());
            assertTrue("Testo non tagliato: " + text.getText(), text.getLayout().getHeight() <= text.getHeight() - text.getCompoundPaddingTop() - text.getCompoundPaddingBottom());
        }
        if (view instanceof ViewGroup) for (int i = 0; i < ((ViewGroup) view).getChildCount(); i++) controllaTesti(((ViewGroup) view).getChildAt(i), root);
    }

    private boolean contiene(View view, Class<?> tipo, String text) {
        if (tipo.isInstance(view) && (text == null || text.contentEquals(((TextView) view).getText()))) return true;
        if (view instanceof ViewGroup) for (int i = 0; i < ((ViewGroup) view).getChildCount(); i++) {
            if (contiene(((ViewGroup) view).getChildAt(i), tipo, text)) return true;
        }
        return false;
    }

    private String js(MainActivity activity, String script) throws Exception {
        AtomicReference<String> value = new AtomicReference<>();
        CountDownLatch done = new CountDownLatch(1);
        activity.runOnUiThread(() -> {
            FrameLayout root = (FrameLayout) ((ViewGroup) activity.findViewById(android.R.id.content)).getChildAt(0);
            ((WebView) root.getChildAt(0)).evaluateJavascript(script, result -> { value.set(result); done.countDown(); });
        });
        assertTrue("Risposta JavaScript", done.await(30, TimeUnit.SECONDS));
        return value.get();
    }

    private void attendiJs(MainActivity activity, String condition) throws Exception {
        for (int i = 0; i < 120; i++) {
            if ("true".equals(js(activity, condition))) return;
            Thread.sleep(100);
        }
        fail("Condizione WebView non raggiunta: " + condition + "; " + js(activity, "window.__themeError || ''"));
    }

    private void verificaAspettoEGesti(MainActivity activity, android.app.Instrumentation instrumentation) throws Exception {
        attendiJs(activity, "typeof window.__codedbBack === 'function'");
        // Attende il fotogramma che il bridge ha promesso prima di togliere lo splash.
        AtomicReference<Integer> views = new AtomicReference<>();
        for (int i = 0; i < 100; i++) {
            instrumentation.runOnMainSync(() -> {
                FrameLayout root = (FrameLayout) ((ViewGroup) activity.findViewById(android.R.id.content)).getChildAt(0);
                views.set(root.getChildCount());
            });
            if (views.get() == 1) break;
            Thread.sleep(100);
        }
        assertEquals("Lo splash scompare a interfaccia pronta", 1, views.get().intValue());
        for (String theme : new String[] { "dark", "light", "custom" }) {
            js(activity, "window.__themeDone=false; (async()=>{ const t=await import(location.origin+'/js/theme.js');"
                + ("custom".equals(theme) ? "const c=await import(location.origin+'/js/theme-colori.js');localStorage.setItem('codedb:temi',JSON.stringify({custom:{id:'custom',nome:'Bosco',base:'dark',scelte:{...c.scelteIniziali('dark'),bg:'#123b2c'}}}));" : "")
                + "t.scegliTema('" + theme + "');window.__themeDone=true;})().catch(e=>window.__themeError=String(e))");
            attendiJs(activity, "window.__themeDone === true");
            String css = js(activity, "getComputedStyle(document.documentElement).getPropertyValue('--bg-surface').trim()");
            int expected = Color.parseColor(css.replace("\"", ""));
            for (int i = 0; i < 50 && activity.getSharedPreferences("appearance", 0).getInt("background", 0) != expected; i++) Thread.sleep(100);
            assertEquals("Il tema scelto viene ricordato per lo splash successivo", expected, activity.getSharedPreferences("appearance", 0).getInt("background", 0));
            instrumentation.runOnMainSync(() -> {
                FrameLayout root = (FrameLayout) ((ViewGroup) activity.findViewById(android.R.id.content)).getChildAt(0);
                assertEquals("Le aree delle barre hanno il colore dell'app", expected, ((ColorDrawable) root.getBackground()).getColor());
                assertEquals("Icone della status bar leggibili", "light".equals(theme), WindowCompat.getInsetsController(activity.getWindow(), root).isAppearanceLightStatusBars());
                assertEquals("Icone della navigazione leggibili", "light".equals(theme), WindowCompat.getInsetsController(activity.getWindow(), root).isAppearanceLightNavigationBars());
            });
        }
        // Anche l'anteprima aggiorna le barre, ma non cambia il prossimo avvio.
        int saved = activity.getSharedPreferences("appearance", 0).getInt("background", 0);
        js(activity, "CodeDBShell.postMessage(JSON.stringify({op:'theme',background:'#eeeeee',foreground:'#111111',accent:'#585aee',persist:false}));");
        Thread.sleep(200);
        assertEquals("L'anteprima non sostituisce il tema salvato", saved, activity.getSharedPreferences("appearance", 0).getInt("background", 0));
        js(activity, "document.getElementById('onboarding-close').click();");
        attendiJs(activity, "!document.getElementById('onboarding-overlay').dataset.arcDialog");
        js(activity, "document.getElementById('mobile-nav-conns').click();");
        attendiJs(activity, "!!document.querySelector('.arc-navigation-sheet')");
        instrumentation.runOnMainSync(activity::onBackPressed);
        attendiJs(activity, "!document.querySelector('.arc-navigation-sheet')");
        assertFalse("Indietro chiude il pannello senza terminare l'Activity", activity.isFinishing());
        js(activity, "import(location.origin+'/js/theme.js').then(t=>t.scegliTema('auto'));");
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
