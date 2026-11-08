package com.bloomhub.pocket.agent

import android.content.Context
import java.io.File

/**
 * App 用法手册：每个 App 一个 Markdown 文件（files/manuals/<包名>.md）。
 * Agent 每次操作成功后用 learn 动作沉淀经验，下次操作同 App 自动注入提示词。
 * 手册是纯文本，可手动编辑或删除重来。
 */
class AppManual(context: Context) {
    private val dir: File = File(context.filesDir, "manuals").apply { mkdirs() }

    private fun fileFor(pkg: String) = File(dir, pkg.replace(Regex("[^\\w.]+"), "_") + ".md")

    fun get(pkg: String, maxChars: Int = 1500): String? {
        if (pkg.isBlank()) return null
        val f = fileFor(pkg)
        if (!f.exists()) return null
        val text = f.readText().trim()
        if (text.isBlank()) return null
        return if (text.length <= maxChars) text else text.take(maxChars) + "\n…(更早的经验已截断)"
    }

    /** 追加一条经验（同文本去重；保留最近 40 条） */
    fun learn(pkg: String, note: String) {
        if (pkg.isBlank() || note.isBlank()) return
        val f = fileFor(pkg)
        val existing = if (f.exists()) f.readText().trimIndent() else "# $pkg 用法手册\n"
        if (existing.contains(note.trim())) return
        val lines = existing.lines().toMutableList()
        lines.add("- ${note.trim()}")
        // 保留开头标题 + 最近 40 条
        val head = lines.takeWhile { it.startsWith("#") || it.isBlank() }
        val body = lines.drop(head.size).takeLast(40)
        f.writeText((head + body).joinToString("\n") + "\n")
    }

    fun reset(pkg: String) { fileFor(pkg).delete() }
}
