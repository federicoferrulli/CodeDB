package com.codedb.android;

import android.app.Activity;
import android.app.AlertDialog;
import android.content.Intent;
import android.net.Uri;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.util.Base64;
import android.webkit.*;
import android.widget.TextView;
import android.widget.FrameLayout;
import androidx.core.graphics.Insets;
import androidx.core.view.ViewCompat;
import androidx.core.view.WindowCompat;
import androidx.core.view.WindowInsetsCompat;
import androidx.webkit.JavaScriptReplyProxy;
import androidx.webkit.WebViewCompat;
import androidx.webkit.WebViewFeature;
import org.json.JSONObject;
import java.io.*;
import java.nio.charset.StandardCharsets;
import java.util.Collections;
import java.util.concurrent.Callable;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.function.Consumer;

public class MainActivity extends Activity {
    private final Handler handler = new Handler(Looper.getMainLooper());
    private WebView web;
    private ValueCallback<Uri[]> chooser;
    private OutputStream download;
    private final ExecutorService fileExecutor = Executors.newSingleThreadExecutor();
    private boolean saving;
    private JavaScriptReplyProxy saveReply;
    private TextView status;
    private FrameLayout content;
    private boolean destroyed;

    @Override public void onCreate(Bundle state) {
        super.onCreate(state);
        WindowCompat.setDecorFitsSystemWindows(getWindow(), false);
        content = new FrameLayout(this);
        // Il contenitore restringe anche le WebView precedenti al supporto CSS
        // degli inset. L'unione prende il massimo, senza sommare tastiera e barra.
        ViewCompat.setOnApplyWindowInsetsListener(content, (view, insets) -> {
            int types = WindowInsetsCompat.Type.systemBars() | WindowInsetsCompat.Type.displayCutout()
                | WindowInsetsCompat.Type.ime();
            Insets safe = insets.getInsets(types);
            view.setPadding(safe.left, safe.top, safe.right, safe.bottom);
            // Propaga anche gli zeri: chiudere la tastiera non lascia margini
            // nella WebView, e il CSS non applica una seconda volta gli inset.
            return new WindowInsetsCompat.Builder(insets).setInsets(types, Insets.NONE).build();
        });
        status = new TextView(this);
        status.setText("Avvio di CodeDB sul telefono…");
        status.setTextSize(18);
        status.setPadding(24, 64, 24, 24);
        content.addView(status, new FrameLayout.LayoutParams(-1, -1));
        setContentView(content);
        Runtime.start(this);
        waitForServer();
    }

    private void waitForServer() {
        if (destroyed) return;
        if (Runtime.error != null) { status.setText(Runtime.error); return; }
        if (Runtime.url == null) { handler.postDelayed(this::waitForServer, 100); return; }
        try { open(); }
        catch (Exception failure) { status.setText("Impossibile aprire CodeDB: " + failure.getMessage()); }
    }

    private boolean local(Uri uri) {
        Uri expected = Uri.parse(Runtime.url);
        return "http".equals(uri.getScheme()) && "127.0.0.1".equals(uri.getHost()) && uri.getPort() == expected.getPort();
    }

    private void open() throws IOException {
        if (!WebViewFeature.isFeatureSupported(WebViewFeature.WEB_MESSAGE_LISTENER)
            || !WebViewFeature.isFeatureSupported(WebViewFeature.DOCUMENT_START_SCRIPT)) {
            throw new IOException("Aggiorna Android System WebView per usare CodeDB e salvare i file.");
        }
        web = new WebView(this);
        web.getSettings().setJavaScriptEnabled(true);
        web.getSettings().setDomStorageEnabled(true);
        web.getSettings().setAllowFileAccess(false);
        // I documenti scelti dall'utente arrivano come URI content:// dal selettore Android.
        web.getSettings().setAllowContentAccess(true);
        web.getSettings().setMixedContentMode(WebSettings.MIXED_CONTENT_NEVER_ALLOW);
        web.getSettings().setSupportMultipleWindows(true);
        web.getSettings().setBuiltInZoomControls(true);
        web.getSettings().setDisplayZoomControls(false);
        WebView.setWebContentsDebuggingEnabled(BuildConfig.DEBUG);
        web.setWebViewClient(new WebViewClient() {
            @Override public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
                if (local(request.getUrl())) return false;
                if (request.isForMainFrame()) external(request.getUrl());
                return true;
            }
            @Override public void onReceivedError(WebView view, WebResourceRequest request, WebResourceError error) {
                if (request.isForMainFrame()) new AlertDialog.Builder(MainActivity.this)
                    .setMessage("Connessione a CodeDB interrotta: " + error.getDescription())
                    .setPositiveButton("Riprova", (dialog, which) -> web.reload()).show();
            }
        });
        web.setWebChromeClient(new WebChromeClient() {
            @Override public boolean onShowFileChooser(WebView view, ValueCallback<Uri[]> callback, FileChooserParams params) {
                if (chooser != null) chooser.onReceiveValue(null);
                chooser = callback;
                Intent intent = new Intent(Intent.ACTION_OPEN_DOCUMENT).addCategory(Intent.CATEGORY_OPENABLE).setType("*/*");
                intent.putExtra(Intent.EXTRA_ALLOW_MULTIPLE, params.getMode() == FileChooserParams.MODE_OPEN_MULTIPLE);
                try { startActivityForResult(intent, 1); }
                catch (android.content.ActivityNotFoundException error) { chooser.onReceiveValue(null); chooser = null; }
                return true;
            }
            @Override public boolean onCreateWindow(WebView view, boolean dialog, boolean gesture, android.os.Message result) {
                if (!gesture) return false;
                WebView popup = new WebView(MainActivity.this);
                popup.setWebViewClient(new WebViewClient() {
                    @Override public boolean shouldOverrideUrlLoading(WebView v, WebResourceRequest request) {
                        external(request.getUrl()); popup.destroy(); return true;
                    }
                });
                ((WebView.WebViewTransport) result.obj).setWebView(popup);
                result.sendToTarget();
                return true;
            }
        });
        WebViewCompat.addWebMessageListener(web, "CodeDBFiles", Collections.singleton(Runtime.url),
            (view, message, origin, mainFrame, reply) -> {
                if (destroyed || !mainFrame || !local(origin)) return;
                try {
                    String raw = message.getData();
                    if (raw == null || raw.length() > 50000) throw new IOException("Messaggio file troppo grande.");
                    JSONObject command = new JSONObject(raw);
                    switch (command.getString("op")) {
                        case "start":
                            if (saving) throw new IOException("Un salvataggio è già in corso.");
                            saving = true;
                            saveReply = reply;
                            Intent intent = new Intent(Intent.ACTION_CREATE_DOCUMENT).addCategory(Intent.CATEGORY_OPENABLE);
                            String mime = command.optString("mime", "application/octet-stream").split(";")[0];
                            intent.setType(mime.contains("/") ? mime : "application/octet-stream");
                            intent.putExtra(Intent.EXTRA_TITLE, command.optString("name", "esportazione").replaceAll("[/\\\\]", "_"));
                            startActivityForResult(intent, 2);
                            break;
                        case "chunk":
                            String bytes = command.getString("data");
                            eseguiFile(() -> {
                                if (download == null) throw new IOException("Nessun file aperto.");
                                download.write(Base64.decode(bytes, Base64.DEFAULT));
                                return null;
                            }, reply::postMessage, false);
                            break;
                        case "end":
                            eseguiFile(() -> {
                                if (download == null) throw new IOException("Nessun file aperto.");
                                download.close(); download = null;
                                return null;
                            }, reply::postMessage, true);
                            break;
                        case "abort":
                            saveReply = null;
                            eseguiFile(() -> { closeDownload(); return null; }, reply::postMessage, true);
                            break;
                        default: throw new IOException("Operazione file sconosciuta.");
                    }
                } catch (Exception error) {
                    saveReply = null;
                    eseguiFile(() -> { closeDownload(); return null; }, ignored -> reply.postMessage("Errore: " + error.getMessage()), true);
                }
            });
        try (InputStream in = getAssets().open("download.js"); ByteArrayOutputStream out = new ByteArrayOutputStream()) {
            Runtime.copy(in, out);
            WebViewCompat.addDocumentStartJavaScript(web, out.toString(StandardCharsets.UTF_8.name()), Collections.singleton(Runtime.url));
        }
        web.setDownloadListener((url, agent, disposition, mime, length) -> {
            if (local(Uri.parse(url)) || url.startsWith("blob:" + Runtime.url + "/") || url.startsWith("data:")) {
                String name = URLUtil.guessFileName(url, disposition, mime);
                web.evaluateJavascript("window.__codedbDownload(" + JSONObject.quote(url) + "," + JSONObject.quote(name) + ")", null);
            } else external(Uri.parse(url));
        });
        CookieManager.getInstance().setAcceptCookie(true);
        CookieManager.getInstance().setAcceptThirdPartyCookies(web, false);
        CookieManager.getInstance().setCookie(Runtime.url, "codedb_mobile=" + Runtime.secret + "; Path=/; HttpOnly; SameSite=Strict", accepted -> {
            if (destroyed) return;
            if (!accepted) { status.setText("Impossibile inizializzare l'accesso privato a CodeDB."); return; }
            content.removeAllViews();
            content.addView(web, new FrameLayout.LayoutParams(-1, -1));
            ViewCompat.requestApplyInsets(content);
            web.loadUrl(Runtime.url);
        });
    }

    private void external(Uri uri) {
        if (!"https".equals(uri.getScheme()) && !"http".equals(uri.getScheme())) return;
        try { startActivity(new Intent(Intent.ACTION_VIEW, uri)); }
        catch (android.content.ActivityNotFoundException ignored) {
            new AlertDialog.Builder(this).setMessage("Nessun browser disponibile per aprire il collegamento.").setPositiveButton("OK", null).show();
        }
    }
    @Override protected void onActivityResult(int request, int result, Intent data) {
        super.onActivityResult(request, result, data);
        if (request == 1 && chooser != null) {
            Uri[] files = null;
            if (result == RESULT_OK && data != null) {
                if (data.getClipData() != null) {
                    files = new Uri[data.getClipData().getItemCount()];
                    for (int i = 0; i < files.length; i++) files[i] = data.getClipData().getItemAt(i).getUri();
                } else if (data.getData() != null) files = new Uri[] { data.getData() };
            }
            chooser.onReceiveValue(files); chooser = null;
        }
        if (request == 2 && saveReply != null) {
            JavaScriptReplyProxy reply = saveReply; saveReply = null;
            if (result != RESULT_OK || data == null || data.getData() == null) { saving = false; reply.postMessage("annullato"); return; }
            Uri uri = data.getData();
            eseguiFile(() -> {
                download = getContentResolver().openOutputStream(uri, "wt");
                if (download == null) throw new IOException("Impossibile aprire il file.");
                return null;
            }, reply::postMessage, false);
        }
    }
    // Il provider SAF può essere remoto: tutti gli accessi al file sono
    // ordinati sul worker, incluse apertura, annullamento e chiusura.
    private void eseguiFile(Callable<Void> action, Consumer<String> reply, boolean finished) {
        fileExecutor.execute(() -> {
            String outcome = "ok";
            boolean done = finished;
            try { action.call(); }
            catch (Exception error) { closeDownload(); outcome = "Errore: " + error.getMessage(); done = true; }
            final String result = outcome;
            final boolean terminal = done;
            handler.post(() -> {
                if (destroyed) return;
                if (terminal) saving = false;
                reply.accept(result);
            });
        });
    }
    private void closeDownload() {
        if (download != null) try { download.close(); } catch (IOException ignored) { }
        download = null;
    }
    @Override public void onBackPressed() {
        if (web != null && web.canGoBack()) web.goBack(); else moveTaskToBack(true);
    }
    @Override protected void onDestroy() {
        destroyed = true;
        handler.removeCallbacksAndMessages(null);
        if (chooser != null) chooser.onReceiveValue(null);
        fileExecutor.execute(this::closeDownload);
        fileExecutor.shutdown();
        if (web != null) web.destroy();
        super.onDestroy();
    }
}
