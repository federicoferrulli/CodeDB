package com.codedb.android;

import android.content.Intent;
import android.graphics.Bitmap;
import android.os.SystemClock;
import android.widget.FrameLayout;
import androidx.test.platform.app.InstrumentationRegistry;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicReference;
import org.junit.Test;
import static org.junit.Assert.*;

/** Fotogrammi realmente presentati: un Canvas software non osserva il RenderThread. */
public class AvvioFluiditaTest {
    @Test public void particelleDuranteLavoroUi() throws Exception {
        android.app.Instrumentation test = InstrumentationRegistry.getInstrumentation();
        MainActivity activity = (MainActivity) test.startActivitySync(new Intent(test.getTargetContext(), MainActivity.class)
            .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK));
        AtomicReference<AvvioView> scena = new AtomicReference<>();
        int[] posizione = new int[2], misura = new int[2];
        CountDownLatch occupato = new CountDownLatch(1), libera = new CountDownLatch(1);
        try {
            // L'interfaccia può completarsi sotto la scena di prova senza rimuoverla.
            SystemClock.sleep(12000);
            test.runOnMainSync(() -> {
                FrameLayout root = (FrameLayout) ((android.view.ViewGroup) activity.findViewById(android.R.id.content)).getChildAt(0);
                AvvioView view = new AvvioView(activity, 0xff1b1e25, 0xffe2e8f0, 0xff585aee, () -> {});
                scena.set(view);
                root.addView(view, new FrameLayout.LayoutParams(-1, -1));
            });
            SystemClock.sleep(2000);
            test.runOnMainSync(() -> {
                assertTrue("Nessun dialogo di sistema deve coprire la scena di prova", activity.hasWindowFocus());
                // Il primo figlio contiene soltanto simbolo e marchio, senza orologio di sistema.
                android.view.View centro = scena.get().getChildAt(0);
                centro.getLocationOnScreen(posizione);
                misura[0] = centro.getWidth(); misura[1] = centro.getHeight();
                // Mutante: arresta soltanto le particelle, per verificare la sensibilità della prova.
                if ("true".equals(InstrumentationRegistry.getArguments().getString("fermaParticelle"))) {
                    try {
                        java.lang.reflect.Field nucleo = AvvioView.class.getDeclaredField("nucleo");
                        nucleo.setAccessible(true);
                        Object simbolo = nucleo.get(scena.get());
                        java.lang.reflect.Field particelle = simbolo.getClass().getDeclaredField("particelle");
                        particelle.setAccessible(true);
                        ((android.graphics.drawable.AnimatedVectorDrawable) particelle.get(simbolo)).stop();
                    } catch (ReflectiveOperationException error) { throw new AssertionError(error); }
                }
            });
            activity.runOnUiThread(() -> {
                occupato.countDown();
                try { libera.await(5, TimeUnit.SECONDS); } catch (InterruptedException e) { Thread.currentThread().interrupt(); }
            });
            assertTrue(occupato.await(5, TimeUnit.SECONDS));
            SystemClock.sleep(300);
            Bitmap prima = ritaglio(test, posizione, misura);
            SystemClock.sleep(350);
            Bitmap dopo = ritaglio(test, posizione, misura);
            try (java.io.OutputStream file = new java.io.FileOutputStream(new java.io.File(test.getTargetContext().getExternalFilesDir(null), "splash-sotto-carico.png"))) {
                dopo.compress(Bitmap.CompressFormat.PNG, 100, file);
            }
            try { assertFalse("Le particelle continuano mentre il thread UI prepara la WebView", prima.sameAs(dopo)); }
            finally { prima.recycle(); dopo.recycle(); }
        } finally {
            libera.countDown();
            test.runOnMainSync(() -> {
                if (scena.get() != null) ((android.view.ViewGroup) scena.get().getParent()).removeView(scena.get());
                activity.finish();
            });
        }
    }

    private Bitmap ritaglio(android.app.Instrumentation test, int[] posizione, int[] misura) {
        Bitmap schermo = test.getUiAutomation().takeScreenshot();
        assertNotNull("Acquisizione del fotogramma GPU", schermo);
        Bitmap ritaglio = Bitmap.createBitmap(schermo, posizione[0], posizione[1], misura[0], misura[1]);
        schermo.recycle();
        return ritaglio;
    }
}
