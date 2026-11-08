// llama-jni.cpp —— llama.cpp 的极简 Android JNI 封装（bloom-hub mobile）
// 只做三件事：加载 GGUF、同步生成（可中断）、释放。
// 提示词（含 ChatML 模板）由 Kotlin 侧拼好整串传入，native 不做模板处理。
// 生成流程：清 KV → 分批 prefill（每批 ≤ n_batch）→ 逐 token 生成。
//   注意：llama_decode 单批 token 数超过 n_batch 会 GGML_ASSERT 直接 abort，
//   而 agent 读屏后的 prompt 很容易上万 token，必须分批喂。
#include <jni.h>
#include <android/log.h>
#include <atomic>
#include <string>
#include <vector>
#include <algorithm>

#include "llama.h"

#define LOG_TAG "pocket-llm"
#define LOGI(...) __android_log_print(ANDROID_LOG_INFO, LOG_TAG, __VA_ARGS__)
#define LOGW(...) __android_log_print(ANDROID_LOG_WARN, LOG_TAG, __VA_ARGS__)
#define LOGE(...) __android_log_print(ANDROID_LOG_ERROR, LOG_TAG, __VA_ARGS__)

namespace {

struct Handle {
    llama_model *model = nullptr;
    llama_context *ctx = nullptr;
    llama_sampler *sampler = nullptr;
    const llama_vocab *vocab = nullptr; // 新版 API：tokenizer 系列都传 vocab
    std::atomic<bool> stop{false};
};

std::string toUtf8(JNIEnv *env, jstring s) {
    if (!s) return {};
    const char *c = env->GetStringUTFChars(s, nullptr);
    std::string out(c ? c : "");
    if (c) env->ReleaseStringUTFChars(s, c);
    return out;
}

// NewStringUTF 只接受 Modified UTF-8：模型输出里的 4 字节序列（emoji 等）会直接
// abort（"input is not valid Modified UTF-8"）。统一走字节数组 + 平台默认编码
// （Android 上即 UTF-8）构造 java.lang.String。
jstring toJavaString(JNIEnv *env, const std::string &s) {
    jbyteArray bytes = env->NewByteArray((jsize) s.size());
    if (bytes == nullptr) return nullptr;
    env->SetByteArrayRegion(bytes, 0, (jsize) s.size(),
                            reinterpret_cast<const jbyte *>(s.data()));
    jclass stringClass = env->FindClass("java/lang/String");
    jmethodID ctor = env->GetMethodID(stringClass, "<init>", "([B)V");
    jstring out = (jstring) env->NewObject(stringClass, ctor, bytes);
    env->DeleteLocalRef(stringClass);
    env->DeleteLocalRef(bytes);
    return out;
}

} // namespace

extern "C" {

JNIEXPORT jlong JNICALL
Java_com_bloomhub_pocket_llm_LlamaBridge_nativeLoad(
        JNIEnv *env, jobject, jstring jPath, jint nCtx, jint nThreads, jfloat temp) {
    const std::string path = toUtf8(env, jPath);
    if (path.empty()) return 0;

    llama_model_params mp = llama_model_default_params();
    auto *h = new Handle();
    h->model = llama_model_load_from_file(path.c_str(), mp);
    if (!h->model) { LOGE("load model failed: %s", path.c_str()); delete h; return 0; }
    h->vocab = llama_model_get_vocab(h->model);

    llama_context_params cp = llama_context_default_params();
    cp.n_ctx = (uint32_t) nCtx;
    // 显式固定 batch 尺寸：prefill 分批的上限由此决定（默认 2048 / ubatch 512）。
    // 写死是为了不随 llama.cpp 默认值变化而改变分批行为。
    cp.n_batch = 2048;
    cp.n_ubatch = 512;
    cp.n_threads = (uint32_t) nThreads;
    cp.n_threads_batch = (uint32_t) nThreads;
    h->ctx = llama_init_from_model(h->model, cp);
    if (!h->ctx) { LOGE("init ctx failed"); llama_model_free(h->model); delete h; return 0; }

    llama_sampler_chain_params sp = llama_sampler_chain_default_params();
    h->sampler = llama_sampler_chain_init(sp);
    llama_sampler_chain_add(h->sampler, llama_sampler_init_temp(temp));
    llama_sampler_chain_add(h->sampler, llama_sampler_init_top_p(0.9f, 1));
    llama_sampler_chain_add(h->sampler, llama_sampler_init_dist(0));

    LOGI("model loaded: %s (ctx=%d threads=%d)", path.c_str(), (int) nCtx, (int) nThreads);
    return (jlong) (intptr_t) h;
}

JNIEXPORT void JNICALL
Java_com_bloomhub_pocket_llm_LlamaBridge_nativeStop(JNIEnv *, jobject, jlong jHandle) {
    if (jHandle == 0) return;
    ((Handle *) (intptr_t) jHandle)->stop.store(true);
}

// 同步生成：prompt 已含完整 ChatML；返回生成的文本（不含 prompt）。
JNIEXPORT jstring JNICALL
Java_com_bloomhub_pocket_llm_LlamaBridge_nativeGenerate(
        JNIEnv *env, jobject, jlong jHandle, jstring jPrompt, jint maxTokens) {
    if (jHandle == 0) return env->NewStringUTF("");
    auto *h = (Handle *) (intptr_t) jHandle;
    const std::string prompt = toUtf8(env, jPrompt);
    h->stop.store(false);

    std::vector<llama_token> tokens(prompt.size() / 2 + 16);
    int n = llama_tokenize(h->vocab, prompt.c_str(), prompt.size(), tokens.data(),
                           (int) tokens.size(), false, true);
    if (n < 0) {
        tokens.resize((size_t) (-n));
        n = llama_tokenize(h->vocab, prompt.c_str(), prompt.size(), tokens.data(),
                           (int) tokens.size(), false, true);
        if (n < 0) { LOGE("tokenize failed"); return env->NewStringUTF(""); }
    }
    tokens.resize((size_t) n);

    // ── prompt 超长保护 ────────────────────────────────────────────────
    // agent 每轮会把「无障碍读屏结果」整段塞进 prompt，几千到上万 token 很常见。
    // 超过 n_ctx 时直接 decode 同样是 abort，所以先裁：保留开头（system/人设）
    // 与结尾（最新观察），丢掉中间的历史。
    const int n_ctx = (int) llama_n_ctx(h->ctx);
    const int n_batch = std::max(1, (int) llama_n_batch(h->ctx));
    const int reserve = 16; // 至少给生成留一点位置
    if (n > n_ctx - reserve) {
        const int keepHead = std::min(512, n / 4);
        const int keepTail = std::max(0, n_ctx - reserve - keepHead);
        std::vector<llama_token> cut;
        cut.reserve((size_t) (keepHead + keepTail));
        cut.insert(cut.end(), tokens.begin(), tokens.begin() + keepHead);
        cut.insert(cut.end(), tokens.end() - keepTail, tokens.end());
        tokens.swap(cut);
        n = (int) tokens.size();
        LOGW("prompt 超长已截断：保留 head %d + tail %d = %d tokens（n_ctx=%d）",
             keepHead, keepTail, n, n_ctx);
    }
    int room = n_ctx - n - 4;
    if (maxTokens > room) maxTokens = room;
    if (maxTokens <= 0) {
        LOGE("ctx 不足：prompt %d / n_ctx %d", n, n_ctx);
        return toJavaString(env, "");
    }

    std::string out;
    std::vector<char> piece(64);

    // 每次调用都从头喂完整提示词：先清空 KV，否则上一轮的残留会把上下文撑爆
    llama_memory_clear(llama_get_memory(h->ctx), true);

    // ── 分批 prefill ───────────────────────────────────────────────────
    // 关键修复（2026-10-27 闪退）：llama_decode 要求单批 token 数 ≤ n_batch（默认 2048）。
    // 旧实现把整个 prompt 当成一个 batch 一次喂入，切屏读到长 UI 树后 prompt 超过 2048，
    // llama_context::decode 内部断言失败 → ggml_abort → SIGABRT，表现为「一切屏就闪退」。
    int fed = 0;
    for (int off = 0; off < n; off += n_batch) {
        const int cnt = std::min(n_batch, n - off);
        llama_batch batch = llama_batch_get_one(tokens.data() + off, cnt);
        if (llama_decode(h->ctx, batch) != 0) {
            LOGE("prefill decode 失败（%d/%d）", off + cnt, n);
            return toJavaString(env, "");
        }
        fed += cnt;
        if (h->stop.load()) break;
    }

    // ── 逐 token 生成 ──────────────────────────────────────────────────
    for (int i = 0; i < maxTokens && !h->stop.load(); i++) {
        llama_token new_token = llama_sampler_sample(h->sampler, h->ctx, -1);
        if (llama_vocab_is_eog(h->vocab, new_token)) break;

        int len = llama_token_to_piece(h->vocab, new_token, piece.data(), (int) piece.size(), 0, true);
        if (len > 0) out.append(piece.data(), (size_t) len);

        llama_batch batch = llama_batch_get_one(&new_token, 1);
        if (llama_decode(h->ctx, batch) != 0) { LOGE("生成 decode 失败（第 %d 步）", i); break; }
        fed++;
    }
    LOGI("生成完成：%d 字符（prefill+生成共喂 %d tokens，prompt %d tokens）", (int) out.size(), fed, n);
    return toJavaString(env, out);
}

JNIEXPORT void JNICALL
Java_com_bloomhub_pocket_llm_LlamaBridge_nativeFree(JNIEnv *, jobject, jlong jHandle) {
    if (jHandle == 0) return;
    auto *h = (Handle *) (intptr_t) jHandle;
    if (h->sampler) llama_sampler_free(h->sampler);
    if (h->ctx) llama_free(h->ctx);
    if (h->model) llama_model_free(h->model);
    delete h;
}

} // extern "C"
