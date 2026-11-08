package com.bloomhub.pocket.llm

import android.util.Log
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import org.json.JSONObject
import java.io.BufferedReader
import java.io.InputStreamReader
import java.net.HttpURLConnection
import java.net.URL

/** 一条对话消息（ChatML） */
data class Msg(val role: String, val content: String)

interface Llm {
    /** 阻塞式对话补全；messages 含 system/user/assistant 历史 */
    suspend fun chat(messages: List<Msg>, maxTokens: Int = 512, temp: Float = 0.2f): String
    fun unload()
    val loaded: Boolean
}

/**
 * 本地 GGUF 推理（llama.cpp，骁龙 8+ Gen 1 上 1.5B~3B Q4 可用）。
 * 上下文给 4096：屏幕序列化约 1~2K token，加上历史与动作输出足够。
 */
class LocalLlm(path: String, nCtx: Int = 8192, nThreads: Int = 6) : Llm {
    private var handle: Long = 0
    // 生成与释放互斥：换模型时 unload 不能 free 掉 nativeGenerate 正在用的 handle（use-after-free → SIGSEGV）
    private val genLock = Any()

    init {
        handle = LlamaBridge.nativeLoad(path, nCtx, nThreads, 0.2f)
        if (handle == 0L) throw IllegalStateException("模型加载失败：$path")
    }

    override val loaded: Boolean get() = handle != 0L

    override suspend fun chat(messages: List<Msg>, maxTokens: Int, temp: Float): String =
        withContext(Dispatchers.Default) {
            val prompt = buildChatPrompt(messages)
            synchronized(genLock) {
                if (handle == 0L) return@withContext ""
                LlamaBridge.nativeGenerate(handle, prompt, maxTokens)
            }
        }

    fun stop() = synchronized(genLock) { if (handle != 0L) LlamaBridge.nativeStop(handle) }

    override fun unload() {
        if (handle != 0L) {
            // 先置停止标志（nativeStop 只 store 原子变量，可与生成并发），让持锁的生成尽快返回
            LlamaBridge.nativeStop(handle)
            synchronized(genLock) {
                if (handle != 0L) {
                    LlamaBridge.nativeFree(handle)
                    handle = 0
                }
            }
        }
    }

    companion object {
        /** ChatML（Qwen2.5 / Qwen3 均为该模板） */
        fun buildChatPrompt(messages: List<Msg>): String = buildString {
            for (m in messages) {
                append("<|im_start|>").append(m.role).append('\n')
                    .append(m.content.trim()).append("<|im_end|>\n")
            }
            append("<|im_start|>assistant\n")
        }
    }
}

/**
 * 云端模式（可选）：DeepSeek 官方 API，与 PC 侧同一把 key。
 * 家里 WiFi 下追求质量时用；默认仍是本地优先。
 */
class CloudLlm(
    private val baseUrl: String,
    private val apiKey: String,
    private val model: String = "deepseek-chat"
) : Llm {
    override val loaded: Boolean get() = apiKey.isNotBlank()

    override suspend fun chat(messages: List<Msg>, maxTokens: Int, temp: Float): String =
        withContext(Dispatchers.IO) {
            if (apiKey.isBlank()) return@withContext ""
            try {
                val conn = URL("${baseUrl.trimEnd('/')}/chat/completions").openConnection() as HttpURLConnection
                conn.requestMethod = "POST"
                conn.connectTimeout = 15000
                conn.readTimeout = 120000
                conn.doOutput = true
                conn.setRequestProperty("Content-Type", "application/json")
                conn.setRequestProperty("Authorization", "Bearer $apiKey")
                val body = JSONObject().apply {
                    put("model", model)
                    put("messages", org.json.JSONArray().apply {
                        for (m in messages) put(JSONObject().put("role", m.role).put("content", m.content))
                    })
                    put("max_tokens", maxTokens)
                    put("temperature", temp.toDouble())
                    put("stream", false)
                }
                conn.outputStream.use { it.write(body.toString().toByteArray(Charsets.UTF_8)) }
                val code = conn.responseCode
                val text = conn.inputStream.bufferedReader(Charsets.UTF_8).use(BufferedReader::readText)
                if (code != 200) {
                    Log.e("CloudLlm", "HTTP $code: ${text.take(200)}")
                    return@withContext ""
                }
                JSONObject(text)
                    .getJSONArray("choices").getJSONObject(0)
                    .getJSONObject("message").getString("content")
            } catch (e: Exception) {
                Log.e("CloudLlm", "chat failed: ${e.message}")
                ""
            }
        }

    override fun unload() {}
}
