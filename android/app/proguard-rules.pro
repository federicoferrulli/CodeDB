# Regole R8/ProGuard per CodeDB Android: preserva il ponte JNI nativo verso libcodedb.so.
-keepclassmembers class com.codedb.android.Runtime {
    private static native int startNode(java.lang.String[], java.lang.String);
}
