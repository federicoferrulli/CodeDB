package com.codedb.android;

import android.content.Context;
import android.net.ConnectivityManager;
import android.net.LinkProperties;
import org.json.JSONArray;
import org.json.JSONObject;
import java.io.*;
import java.nio.charset.StandardCharsets;
import java.security.SecureRandom;
import java.util.zip.ZipEntry;
import java.util.zip.ZipInputStream;

/** Un solo Node per processo; ruotare o riaprire l'Activity non avvia un secondo server. */
final class Runtime {
    static volatile String url;
    static volatile String error;
    static String secret;
    private static boolean started;
    private static native int startNode(String[] args, String temporary);

    static synchronized void start(Context context) {
        if (started) return;
        started = true;
        Context app = context.getApplicationContext();
        byte[] random = new byte[32];
        new SecureRandom().nextBytes(random);
        StringBuilder hex = new StringBuilder();
        for (byte value : random) hex.append(String.format("%02x", value & 255));
        secret = hex.toString();
        new Thread(() -> {
            try {
                System.loadLibrary("node");
                System.loadLibrary("codedb");
                long update = app.getPackageManager().getPackageInfo(app.getPackageName(), 0).lastUpdateTime;
                File code = new File(app.getFilesDir(), "runtime-" + update);
                File marker = new File(code, ".complete");
                if (!marker.isFile()) {
                    code.mkdirs();
                    try (ZipInputStream zip = new ZipInputStream(app.getAssets().open("runtime.zip"))) {
                        ZipEntry entry;
                        while ((entry = zip.getNextEntry()) != null) {
                            File target = new File(code, entry.getName());
                            if (!target.getCanonicalPath().startsWith(code.getCanonicalPath() + File.separator)) {
                                throw new IOException("Percorso non valido nel runtime.");
                            }
                            if (entry.isDirectory()) { target.mkdirs(); continue; }
                            target.getParentFile().mkdirs();
                            try (OutputStream out = new FileOutputStream(target)) { copy(zip, out); }
                        }
                    }
                    marker.createNewFile();
                }
                // Elimina solo i sorgenti delle installazioni precedenti, mai files/data.
                File[] previous = app.getFilesDir().listFiles((parent, name) -> name.startsWith("runtime-"));
                if (previous != null) for (File old : previous) {
                    if (!old.equals(code)) removeCode(old, app.getFilesDir());
                }
                File ready = new File(app.getCacheDir(), "server-ready.json");
                if (ready.exists() && !ready.delete()) throw new IOException("Impossibile azzerare lo stato del server.");
                JSONArray dns = new JSONArray();
                ConnectivityManager cm = (ConnectivityManager) app.getSystemService(Context.CONNECTIVITY_SERVICE);
                LinkProperties links = cm.getLinkProperties(cm.getActiveNetwork());
                if (links != null) for (java.net.InetAddress address : links.getDnsServers()) dns.put(address.getHostAddress());
                String[] args = { "node", new File(code, "mobile.cjs").getAbsolutePath(),
                    new File(app.getFilesDir(), "data").getAbsolutePath(), ready.getAbsolutePath(), secret, dns.toString() };
                new Thread(() -> {
                    try {
                        int status = startNode(args, app.getCacheDir().getAbsolutePath());
                        error = "Il server CodeDB si è fermato (codice " + status + "). Chiudi e riapri l'app.";
                    } catch (Throwable failure) { error = "Avvio Node.js non riuscito: " + failure.getMessage(); }
                }, "CodeDB-Node").start();
                for (int i = 0; i < 600 && error == null; i++) {
                    if (ready.isFile()) {
                        JSONObject state = new JSONObject(read(ready));
                        if (state.has("error")) error = state.getString("error");
                        else url = state.getString("url");
                        return;
                    }
                    Thread.sleep(100);
                }
                if (error == null) error = "Il server non si è avviato entro un minuto. Chiudi e riapri l'app.";
            } catch (Throwable failure) { error = "Avvio CodeDB non riuscito: " + failure.getMessage(); }
        }, "CodeDB-Avvio").start();
    }

    static void copy(InputStream in, OutputStream out) throws IOException {
        byte[] buffer = new byte[65536];
        int count;
        while ((count = in.read(buffer)) != -1) out.write(buffer, 0, count);
    }
    private static void removeCode(File file, File root) throws IOException {
        if (!file.getCanonicalPath().startsWith(root.getCanonicalPath() + File.separator)) {
            throw new IOException("Percorso dei vecchi sorgenti non valido.");
        }
        File[] children = file.listFiles();
        if (children != null) for (File child : children) removeCode(child, root);
        if (!file.delete()) throw new IOException("Impossibile rimuovere i vecchi sorgenti CodeDB.");
    }
    static String read(File file) throws IOException {
        try (InputStream in = new FileInputStream(file); ByteArrayOutputStream out = new ByteArrayOutputStream()) {
            copy(in, out);
            return out.toString(StandardCharsets.UTF_8.name());
        }
    }
}
