#include <jni.h>
#include <node.h>
#include <cstdlib>
#include <string>
#include <vector>

extern "C" JNIEXPORT jint JNICALL
Java_com_codedb_android_Runtime_startNode(JNIEnv* env, jclass, jobjectArray values, jstring temporary) {
    const char* tmp = env->GetStringUTFChars(temporary, nullptr);
    setenv("TMPDIR", tmp, 1);
    env->ReleaseStringUTFChars(temporary, tmp);
    std::vector<std::string> strings;
    size_t size = 0;
    for (int i = 0; i < env->GetArrayLength(values); ++i) {
        auto value = (jstring) env->GetObjectArrayElement(values, i);
        const char* chars = env->GetStringUTFChars(value, nullptr);
        strings.emplace_back(chars);
        size += strings.back().size() + 1;
        env->ReleaseStringUTFChars(value, chars);
        env->DeleteLocalRef(value);
    }
    // Node richiede argv in memoria contigua per inizializzare il titolo del processo.
    std::vector<char> buffer(size);
    std::vector<char*> argv;
    char* next = buffer.data();
    for (const auto& value : strings) {
        argv.push_back(next);
        value.copy(next, value.size());
        next[value.size()] = '\0';
        next += value.size() + 1;
    }
    return node::Start(static_cast<int>(argv.size()), argv.data());
}
