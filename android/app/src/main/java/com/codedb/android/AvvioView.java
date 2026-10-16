package com.codedb.android;

import android.animation.Animator;
import android.animation.AnimatorListenerAdapter;
import android.animation.ValueAnimator;
import android.content.Context;
import android.content.res.ColorStateList;
import android.database.ContentObserver;
import android.graphics.Canvas;
import android.graphics.Color;
import android.graphics.LinearGradient;
import android.graphics.Paint;
import android.graphics.Path;
import android.graphics.RadialGradient;
import android.graphics.RectF;
import android.graphics.Shader;
import android.graphics.Typeface;
import android.os.Handler;
import android.os.Looper;
import android.os.SystemClock;
import android.provider.Settings;
import android.text.SpannableString;
import android.text.Spanned;
import android.text.style.ForegroundColorSpan;
import android.view.Gravity;
import android.view.View;
import android.view.animation.LinearInterpolator;
import android.view.animation.PathInterpolator;
import android.widget.Button;
import android.widget.FrameLayout;
import android.widget.LinearLayout;
import android.widget.TextView;
import androidx.core.graphics.ColorUtils;

/** Un'unica scena nativa: i livelli del database si compongono, poi lasciano spazio all'app. */
final class AvvioView extends LinearLayout {
    private final NucleoView nucleo;
    private final LinearLayout composizione, parole, piede;
    private final FrameLayout centro;
    private final TextView titolo, sottotitolo, stato;
    private final Button riprova;
    private final ContentObserver preferenze;
    private ValueAnimator clock, uscita;
    private Runnable completamento;
    private long inizio;
    private float tempo, scalaAnimazioni = 1;
    private boolean collegato, errore, concluso;
    private int ultimoLato;
    private boolean compatto;

    AvvioView(Context context, int sfondo, int testo, int accento, Runnable retry) {
        super(context);
        setOrientation(VERTICAL);
        setClickable(true);
        setPadding(dp(24), dp(16), dp(24), dp(24));
        centro = new FrameLayout(context);
        addView(centro, new LayoutParams(-1, 0, 1));
        composizione = new LinearLayout(context);
        composizione.setGravity(Gravity.CENTER);
        composizione.setOrientation(VERTICAL);
        centro.addView(composizione, new FrameLayout.LayoutParams(-1, -2, Gravity.CENTER));

        nucleo = new NucleoView(context);
        nucleo.setImportantForAccessibility(IMPORTANT_FOR_ACCESSIBILITY_NO);
        composizione.addView(nucleo, new LayoutParams(dp(300), dp(300)));
        parole = new LinearLayout(context);
        parole.setOrientation(VERTICAL);
        parole.setGravity(Gravity.CENTER);
        composizione.addView(parole, new LayoutParams(-1, -2));
        titolo = new TextView(context);
        titolo.setText("CodeDB");
        titolo.setTextSize(44);
        titolo.setTypeface(Typeface.create("sans-serif-medium", Typeface.NORMAL));
        titolo.setLetterSpacing(-.045f);
        titolo.setGravity(Gravity.CENTER);
        parole.addView(titolo, new LayoutParams(-1, -2));
        sottotitolo = new TextView(context);
        sottotitolo.setText("Dai forma ai tuoi dati.");
        sottotitolo.setTextSize(15);
        sottotitolo.setLetterSpacing(.015f);
        sottotitolo.setGravity(Gravity.CENTER);
        sottotitolo.setPadding(0, dp(9), 0, dp(12));
        parole.addView(sottotitolo, new LayoutParams(-1, -2));

        piede = new LinearLayout(context);
        piede.setOrientation(VERTICAL);
        piede.setGravity(Gravity.CENTER);
        piede.setPadding(0, dp(12), 0, 0);
        addView(piede, new LayoutParams(-1, -2));
        stato = new TextView(context);
        stato.setTextSize(13);
        stato.setGravity(Gravity.CENTER);
        stato.setLineSpacing(dp(3), 1);
        stato.setAccessibilityLiveRegion(ACCESSIBILITY_LIVE_REGION_POLITE);
        piede.addView(stato, new LayoutParams(-1, -2));
        riprova = new Button(context);
        riprova.setText("Riprova");
        riprova.setAllCaps(false);
        riprova.setMinHeight(dp(48));
        riprova.setVisibility(GONE);
        LayoutParams pulsante = new LayoutParams(-2, -2);
        pulsante.topMargin = dp(12);
        piede.addView(riprova, pulsante);
        riprova.setOnClickListener(view -> {
            caricamento("Preparazione del tuo spazio…");
            retry.run();
        });
        preferenze = new ContentObserver(new Handler(Looper.getMainLooper())) {
            @Override public void onChange(boolean selfChange) { aggiornaMovimento(); }
        };
        palette(sfondo, testo, accento);
        caricamento("Preparazione del tuo spazio…");
    }

    private int dp(float value) { return Math.round(value * getResources().getDisplayMetrics().density); }
    private static float limita(float n) { return Math.max(0, Math.min(1, n)); }
    private static float arrivo(float n) { float t = 1 - limita(n); return 1 - t * t * t; }

    void palette(int sfondo, int testo, int accento) {
        setBackgroundColor(sfondo);
        nucleo.palette(sfondo, testo, accento);
        // Il nome resta leggibile anche con un accento personalizzato molto chiaro.
        int evidenza = accento;
        for (int i = 1; i <= 10 && ColorUtils.calculateContrast(evidenza, sfondo) < 4.5; i++) {
            evidenza = ColorUtils.blendARGB(accento, testo, i / 10f);
        }
        SpannableString nome = new SpannableString("CodeDB");
        nome.setSpan(new ForegroundColorSpan(evidenza), 4, 6, Spanned.SPAN_EXCLUSIVE_EXCLUSIVE);
        titolo.setText(nome);
        titolo.setTextColor(testo);
        sottotitolo.setTextColor(ColorUtils.blendARGB(sfondo, testo, .72f));
        stato.setTextColor(ColorUtils.blendARGB(sfondo, testo, .78f));
        riprova.setBackgroundTintList(ColorStateList.valueOf(accento));
        riprova.setTextColor(ColorUtils.calculateContrast(Color.WHITE, accento) > ColorUtils.calculateContrast(Color.BLACK, accento) ? Color.WHITE : Color.BLACK);
    }

    void caricamento(String messaggio) {
        if (concluso) return;
        errore = false;
        stato.setText(messaggio);
        riprova.setVisibility(GONE);
        aggiornaMovimento();
    }

    void errore(String messaggio) {
        if (concluso) return;
        errore = true;
        stato.setText(messaggio);
        riprova.setVisibility(VISIBLE);
        aggiornaMovimento();
    }

    void completa(Runnable azione) {
        if (concluso) return;
        concluso = true;
        completamento = azione;
        fermaClock();
        stato.setText("Il tuo spazio è pronto.");
        riprova.setVisibility(GONE);
        if (scalaAnimazioni == 0 || !collegato) { termina(); return; }
        // Nessuna durata minima di attesa: l'uscita parte al primo fotogramma dell'app.
        uscita = ValueAnimator.ofFloat(0, 1);
        uscita.setDuration(360);
        uscita.setInterpolator(new PathInterpolator(.4f, 0, 1, 1));
        uscita.addUpdateListener(animator -> {
            float t = (float) animator.getAnimatedValue();
            setAlpha(1 - t);
            composizione.setScaleX(1 + .035f * t);
            composizione.setScaleY(1 + .035f * t);
            composizione.setTranslationY(-dp(10) * t);
        });
        uscita.addListener(new AnimatorListenerAdapter() {
            @Override public void onAnimationEnd(Animator animation) { termina(); }
        });
        uscita.start();
    }

    private void termina() {
        Runnable azione = completamento;
        completamento = null;
        if (azione != null) azione.run();
    }

    private void fermaClock() {
        if (clock != null) { clock.cancel(); clock = null; }
    }

    private void aggiornaMovimento() {
        scalaAnimazioni = Settings.Global.getFloat(getContext().getContentResolver(), Settings.Global.ANIMATOR_DURATION_SCALE, 1);
        fermaClock();
        if (concluso) {
            if (scalaAnimazioni == 0 && uscita != null) uscita.end();
            return;
        }
        if (scalaAnimazioni == 0 || errore) {
            fotogramma(1500, false);
            return;
        }
        if (!collegato || getWindowVisibility() != VISIBLE || !isShown()) return;
        inizio = SystemClock.uptimeMillis() - (long) (tempo * scalaAnimazioni);
        clock = ValueAnimator.ofFloat(0, 1);
        clock.setDuration(5600);
        clock.setRepeatCount(ValueAnimator.INFINITE);
        clock.setInterpolator(new LinearInterpolator());
        clock.addUpdateListener(animator -> fotogramma((SystemClock.uptimeMillis() - inizio) / scalaAnimazioni, true));
        clock.start();
    }

    private void fotogramma(float ms, boolean movimento) {
        tempo = ms;
        nucleo.tempo = movimento ? ms : 1500;
        nucleo.movimento = movimento;
        nucleo.invalidate();
        float entrata = arrivo((ms - 300) / 650);
        parole.setAlpha(entrata);
        parole.setTranslationY(dp(13) * (1 - entrata));
    }

    @Override protected void onAttachedToWindow() {
        super.onAttachedToWindow();
        collegato = true;
        getContext().getContentResolver().registerContentObserver(Settings.Global.getUriFor(Settings.Global.ANIMATOR_DURATION_SCALE), false, preferenze);
        aggiornaMovimento();
    }

    @Override protected void onDetachedFromWindow() {
        collegato = false;
        fermaClock();
        getContext().getContentResolver().unregisterContentObserver(preferenze);
        completamento = null;
        if (uscita != null) { uscita.cancel(); uscita = null; }
        super.onDetachedFromWindow();
    }

    @Override protected void onWindowVisibilityChanged(int visibility) {
        super.onWindowVisibilityChanged(visibility);
        if (nucleo != null) aggiornaMovimento();
    }

    @Override protected void onVisibilityChanged(View changedView, int visibility) {
        super.onVisibilityChanged(changedView, visibility);
        if (nucleo != null) aggiornaMovimento();
    }

    @Override protected void onMeasure(int widthSpec, int heightSpec) {
        int w = MeasureSpec.getSize(widthSpec) - getPaddingLeft() - getPaddingRight();
        int h = MeasureSpec.getSize(heightSpec) - getPaddingTop() - getPaddingBottom();
        boolean stretto = h < dp(500) && w > dp(440);
        composizione.setOrientation(stretto ? HORIZONTAL : VERTICAL);
        titolo.setTextSize(stretto ? 36 : 44);
        // Riserva prima lo spazio ai testi: font grandi ed errori non si sovrappongono al marchio.
        piede.measure(MeasureSpec.makeMeasureSpec(w, MeasureSpec.EXACTLY), MeasureSpec.makeMeasureSpec(h, MeasureSpec.AT_MOST));
        parole.measure(MeasureSpec.makeMeasureSpec(stretto ? w / 2 : w, MeasureSpec.EXACTLY), MeasureSpec.makeMeasureSpec(0, MeasureSpec.UNSPECIFIED));
        int disponibile = Math.max(0, h - piede.getMeasuredHeight() - (stretto ? 0 : parole.getMeasuredHeight()));
        int lato = Math.min(disponibile, Math.min(dp(stretto ? 230 : 320), Math.min(stretto ? w / 2 : w, (int) (h * (stretto ? .62f : .48f)))));
        if (ultimoLato != lato || compatto != stretto) {
            ultimoLato = lato;
            compatto = stretto;
            LayoutParams simbolo = (LayoutParams) nucleo.getLayoutParams();
            simbolo.width = simbolo.height = lato;
            nucleo.setLayoutParams(simbolo);
            LayoutParams testo = (LayoutParams) parole.getLayoutParams();
            testo.width = stretto ? 0 : -1;
            testo.weight = stretto ? 1 : 0;
            parole.setLayoutParams(testo);
        }
        super.onMeasure(widthSpec, heightSpec);
    }

    /** Coordinate normalizzate: geometria e shader riusati, nessuna allocazione per fotogramma. */
    private static final class NucleoView extends View {
        private final Paint p = new Paint(Paint.ANTI_ALIAS_FLAG);
        private final Path fianco = new Path();
        private final RectF ellisse = new RectF(-69, -19, 69, 19);
        private final RectF orbita = new RectF(-137, -53, 137, 53);
        private LinearGradient metallo, bordo;
        private RadialGradient alone;
        private int accento, luce, segno, sfondo;
        private float tempo;
        private boolean movimento = true;

        NucleoView(Context context) {
            super(context);
            fianco.moveTo(-69, 0);
            fianco.cubicTo(-69, 25, 69, 25, 69, 0);
            fianco.lineTo(69, 23);
            fianco.cubicTo(69, 48, -69, 48, -69, 23);
            fianco.close();
            p.setStrokeCap(Paint.Cap.ROUND);
        }

        void palette(int bg, int fg, int accent) {
            sfondo = bg;
            accento = accent;
            luce = ColorUtils.blendARGB(accent, 0xff62e6eb, .72f);
            segno = ColorUtils.blendARGB(bg, fg, .22f);
            metallo = new LinearGradient(-70, 0, 70, 35,
                new int[] { ColorUtils.blendARGB(bg, accent, .42f), ColorUtils.blendARGB(bg, fg, .08f), ColorUtils.blendARGB(bg, accent, .22f) },
                null, Shader.TileMode.CLAMP);
            bordo = new LinearGradient(-69, -20, 69, 35, new int[] { luce, accent, luce }, null, Shader.TileMode.CLAMP);
            alone = new RadialGradient(0, 0, 148, new int[] { ColorUtils.setAlphaComponent(accent, 46), ColorUtils.setAlphaComponent(accent, 12), Color.TRANSPARENT },
                new float[] { 0, .55f, 1 }, Shader.TileMode.CLAMP);
            invalidate();
        }

        private void tratto(int color, float width, int alpha) {
            p.setShader(null); p.setStyle(Paint.Style.STROKE); p.setColor(color); p.setStrokeWidth(width); p.setAlpha(alpha);
        }

        @Override protected void onDraw(Canvas c) {
            super.onDraw(c);
            float scala = Math.min(getWidth(), getHeight()) / 320f;
            c.save();
            c.translate(getWidth() / 2f, getHeight() / 2f - 5 * scala);
            c.scale(scala, scala);
            float ingresso = arrivo(tempo / 1100);
            float respiro = movimento ? (float) Math.sin(tempo / 1700) : 0;
            p.setStyle(Paint.Style.FILL); p.setAlpha(255); p.setShader(alone);
            c.drawCircle(0, 0, 145 + 3 * respiro, p);
            p.setShader(null); p.setColor(segno); p.setAlpha(75);
            for (int x = -140; x <= 140; x += 20) for (int y = -120; y <= 120; y += 20) {
                if (x * x + y * y > 10200 && x * x + y * y < 20500) c.drawCircle(x, y, .65f, p);
            }
            disegnaOrbita(c, false, ingresso);
            c.save();
            c.translate(0, respiro * 1.5f);
            // Dal basso verso l'alto: ogni livello trova il proprio posto.
            for (int i = 2; i >= 0; i--) {
                float t = arrivo((tempo - (2 - i) * 95) / 850);
                c.save();
                c.translate((1 - t) * (i - 1) * 13, -46 + i * 32 + (1 - t) * (24 + i * 14));
                c.scale(.94f + .06f * t, .94f + .06f * t);
                int alpha = (int) (255 * (.12f + .88f * t));
                p.setStyle(Paint.Style.FILL); p.setShader(metallo); p.setAlpha(alpha);
                c.drawPath(fianco, p);
                p.setShader(null); p.setColor(ColorUtils.blendARGB(sfondo, accento, .17f)); p.setAlpha(alpha);
                c.drawOval(ellisse, p);
                p.setStyle(Paint.Style.STROKE); p.setStrokeWidth(1.5f); p.setShader(bordo); p.setAlpha(alpha);
                c.drawOval(ellisse, p);
                c.drawPath(fianco, p);
                tratto(luce, .65f, (int) (alpha * .4f));
                c.drawArc(ellisse, 192, 115, false, p);
                // Piccoli segmenti di dati sul bordo, con un solo segnale in movimento.
                for (int j = 0; j < 4; j++) {
                    float attivo = movimento ? .5f + .5f * (float) Math.sin(tempo / 650 - i * .8 - j * .6) : .8f;
                    tratto(j == 0 ? luce : accento, 2.2f, (int) (alpha * (.25f + .55f * attivo)));
                    c.drawLine(30 + j * 6, 22 - j * 1.3f, 31 + j * 6, 22 - j * 1.3f, p);
                }
                c.restore();
            }
            c.restore();
            disegnaOrbita(c, true, ingresso);
            // Un secondo percorso incompleto dà profondità senza affollare il simbolo.
            c.save(); c.rotate(31);
            tratto(accento, .8f, (int) (32 * ingresso));
            c.drawArc(orbita, 215, 80, false, p);
            c.restore();
            c.restore();
        }

        private void disegnaOrbita(Canvas c, boolean davanti, float ingresso) {
            c.save(); c.rotate(-24);
            tratto(segno, .85f, (int) ((davanti ? 100 : 60) * ingresso));
            c.drawArc(orbita, davanti ? 0 : 180, 180, false, p);
            for (int i = 0; i < 3; i++) {
                float angle = (movimento ? tempo / 5600 * 360 : 32) + i * 120;
                angle %= 360;
                if ((angle < 180) != davanti) continue;
                tratto(i == 1 ? accento : luce, 1.8f, (int) (115 * ingresso));
                c.drawArc(orbita, angle - 19, 17, false, p);
                float rad = (float) Math.toRadians(angle);
                float x = (float) Math.cos(rad) * 137, y = (float) Math.sin(rad) * 53;
                p.setStyle(Paint.Style.FILL); p.setColor(i == 1 ? accento : luce); p.setAlpha((int) (35 * ingresso));
                c.drawCircle(x, y, 7, p);
                p.setAlpha((int) (255 * ingresso));
                c.drawCircle(x, y, 2.5f, p);
                p.setColor(Color.WHITE); p.setAlpha((int) (215 * ingresso));
                c.drawCircle(x, y, 1, p);
            }
            c.restore();
        }
    }
}
