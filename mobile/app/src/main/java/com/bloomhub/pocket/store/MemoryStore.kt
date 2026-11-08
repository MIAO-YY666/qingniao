package com.bloomhub.pocket.store

import android.content.Context
import org.json.JSONArray
import org.json.JSONObject
import java.io.File

/**
 * 人向记忆 —— 与 PC 端 bloom-hub/services/memory.js 完全同构的文件格式：
 *   people/<key>.json = { key, identities[], displayName, impressions[{at,text,source}] }
 * 把手机上的 people 目录的 json 文件 拷到 PC 的 bloom-hub/memory/people/ 即可互通（反之亦然）。
 */
class MemoryStore(context: Context) {
    private val dir: File = File(context.filesDir, "memory/people").apply { mkdirs() }

    // Unicode 字母/数字保留（中文昵称不再坍缩成同一个文件），与 PC 端 memory.js 规则一致
    private fun fileFor(key: String) = File(dir, key.replace(Regex("[^\\p{L}\\p{N}._-]+"), "_") + ".json")

    fun add(who: String, text: String, source: String) {
        if (who.isBlank() || text.isBlank()) return
        val key = who.trim()
        val p = read(key) ?: JSONObject().apply {
            put("key", key)
            put("identities", JSONArray().put(key))
            put("displayName", key)
            put("impressions", JSONArray())
            put("createdAt", System.currentTimeMillis())
        }
        // 去重
        val arr = p.optJSONArray("impressions") ?: JSONArray()
        for (i in 0 until arr.length()) {
            if (arr.getJSONObject(i).optString("text") == text) return
        }
        arr.put(JSONObject().put("at", System.currentTimeMillis()).put("text", text.take(500)).put("source", source))
        if (arr.length() > 60) {
            val trimmed = JSONArray()
            for (i in arr.length() - 60 until arr.length()) trimmed.put(arr.get(i))
            p.put("impressions", trimmed)
        } else p.put("impressions", arr)
        p.put("updatedAt", System.currentTimeMillis())
        fileFor(key).writeText(p.toString())
    }

    fun read(key: String): JSONObject? {
        val f = fileFor(key)
        if (!f.exists()) {
            // 兜底：按 displayName 全目录搜一次
            for (g in dir.listFiles { f -> f.extension == "json" } ?: return null) {
                try {
                    val p = JSONObject(g.readText())
                    val ids = p.optJSONArray("identities") ?: continue
                    for (i in 0 until ids.length()) if (ids.getString(i) == key) return p
                } catch (_: Exception) {}
            }
            return null
        }
        return try { JSONObject(f.readText()) } catch (_: Exception) { null }
    }

    /** 渲染注入提示词用的紧凑文本 */
    fun render(key: String, max: Int = 5): String {
        val p = read(key) ?: return ""
        val arr = p.optJSONArray("impressions") ?: return ""
        if (arr.length() == 0) return ""
        val sb = StringBuilder("【关于${p.optString("displayName", key)}】\n")
        val from = maxOf(0, arr.length() - max)
        for (i in from until arr.length()) {
            sb.append("- ").append(arr.getJSONObject(i).optString("text")).append('\n')
        }
        return sb.toString().take(700)
    }

    fun link(a: String, b: String) {
        val pa = read(a) ?: return
        val pb = read(b)
        if (pb != null) {
            // 合并 impressions
            val ia = pa.optJSONArray("impressions") ?: JSONArray()
            val ib = pb.optJSONArray("impressions") ?: JSONArray()
            for (i in 0 until ib.length()) ia.put(ib.get(i))
            pa.put("impressions", ia)
            val ids = pa.optJSONArray("identities") ?: JSONArray()
            val idb = pb.optJSONArray("identities") ?: JSONArray()
            for (i in 0 until idb.length()) ids.put(idb.get(i))
            pa.put("identities", ids)
            fileFor(b).delete()
        } else {
            val ids = pa.optJSONArray("identities") ?: JSONArray()
            ids.put(b)
            pa.put("identities", ids)
        }
        pa.put("updatedAt", System.currentTimeMillis())
        fileFor(pa.optString("key")).writeText(pa.toString())
    }
}

/** 任务/动作流水：files/tasks.jsonl，UI 日志页读它 */
class ChatStore(context: Context) {
    private val file: File = File(context.filesDir, "tasks.jsonl")
    private var appends = 0

    fun append(kind: String, text: String) {
        try {
            file.appendText(
                JSONObject().put("ts", System.currentTimeMillis()).put("kind", kind).put("text", text).toString() + "\n"
            )
            // 每 200 次追加截断一次：流水只留最近 400 条，避免文件无限增长拖慢 UI 读取
            if (++appends % 200 == 0) {
                val lines = file.readLines()
                if (lines.size > 600) file.writeText(lines.takeLast(400).joinToString("\n", postfix = "\n"))
            }
        } catch (_: Exception) {}
    }

    fun tail(n: Int = 200): List<String> =
        if (!file.exists()) emptyList()
        else file.readLines().takeLast(n)
}
