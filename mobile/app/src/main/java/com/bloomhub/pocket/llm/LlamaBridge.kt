package com.bloomhub.pocket.llm

/**
 * llama.cpp JNI 桥。System.loadLibrary 在 Llm.kt 里完成。
 * 模型路径指向应用私有目录里的 GGUF 文件。
 */
object LlamaBridge {
    init {
        System.loadLibrary("pocketllm")
    }

    @JvmStatic external fun nativeLoad(path: String, nCtx: Int, nThreads: Int, temp: Float): Long
    @JvmStatic external fun nativeGenerate(handle: Long, prompt: String, maxTokens: Int): String
    @JvmStatic external fun nativeStop(handle: Long)
    @JvmStatic external fun nativeFree(handle: Long)
}
