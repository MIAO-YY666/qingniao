package com.bloomhub.pocket.agent

import android.content.Context
import com.bloomhub.pocket.llm.Llm
import com.bloomhub.pocket.llm.Msg
import com.bloomhub.pocket.screen.ScreenAccess
import com.bloomhub.pocket.store.ChatStore
import com.bloomhub.pocket.store.MemoryStore
import kotlinx.coroutines.delay
import org.json.JSONObject

/** Agent 执行结果 */
data class TaskResult(val ok: Boolean, val summary: String, val steps: Int)

/**
 * Agent 循环：屏幕状态 → 模型输出动作 JSON → 执行 → 下一轮。
 * 同一时间只跑一个任务（手机资源有限），由 AgentService 串行调度。
 * 已执行动作以短列表回传给模型（小上下文下的工作记忆）。
 */
class AgentLoop(
    private val context: Context,
    private val llm: Llm,
    private val log: (String) -> Unit
) {
    private val manual = AppManual(context)
    private val memory = MemoryStore(context)
    private val chat = ChatStore(context)
    private var pendingContext: String? = null

    suspend fun run(goal: String, qqContext: String? = null, maxSteps: Int = 12): TaskResult {
        if (!ScreenAccess.available) {
            return TaskResult(false, "无障碍服务未开启：设置 → 无障碍 → 青鸟读屏", 0)
        }
        val sa = ScreenAccess.instance!!
        chat.append("task", goal)

        val history = StringBuilder()
        var pkg = ""
        var steps = 0
        for (step in 1..maxSteps) {
            steps = step
            val screen = sa.snapshot(160)
            val curPkg = ScreenAccess.currentPackage.ifBlank { pkgFromScreen(screen) }
            if (curPkg != pkg) {
                pkg = curPkg
                log("当前应用：$pkg")
            }
            val manualText = manual.get(pkg)
            val ownerMem = memory.render("qq-主人")
            val userPrompt = buildString {
                append(Prompt.taskPrompt(goal, qqContext))
                if (history.isNotBlank()) {
                    append("\n\n【已执行动作】\n").append(history.toString().take(600))
                }
                append("\n\n【屏幕】\n").append(truncate(screen, 1200))
            }
            val messages = mutableListOf(
                Msg("system", Prompt.system(manualText, ownerMem)),
                Msg("user", userPrompt)
            )

            var raw = llm.chat(messages, maxTokens = 220, temp = 0.2f)
            if (raw.isBlank()) return TaskResult(false, "模型无输出（本地模型过载或云端网络失败）", step)
            var act = parseAction(raw)
            if (act == null) {
                // 一次纠偏
                val retry = llm.chat(
                    messages + listOf(
                        Msg("assistant", raw.take(300)),
                        Msg("user", "格式错误。只输出一行动作 JSON。")
                    ), maxTokens = 160, temp = 0.0f
                )
                act = parseAction(retry)
            }
            if (act == null) {
                chat.append("error", "无法解析动作: ${raw.take(200)}")
                return TaskResult(false, "模型输出无法解析为动作", step)
            }

            log("第${step}步: ${act.toString().take(140)}")
            history.append(step).append(". ").append(act.toString().take(90)).append('\n')
            pendingContext?.let {
                history.append("  ↳ 结果: ").append(it.replace('\n', ' ').take(500)).append('\n')
                pendingContext = null
            }

            val result = exec(act, sa, goal)
            if (result != null) return result
            delay(800) // 等界面刷新
        }
        chat.append("fail", "步数用尽: $goal")
        return TaskResult(false, "步数用尽仍未完成", steps)
    }

    /** 返回 null 表示继续循环；非 null 表示任务结束 */
    private fun exec(act: JSONObject, sa: ScreenAccess, goal: String): TaskResult? {
        chat.append("action", act.toString().take(140))
        return when (act.optString("action")) {
            "tap" -> { if (!sa.tapNode(act.optInt("id", -1))) log("点击失败：序号过期，下一步先 read_screen"); null }
            "swipe" -> { sa.swipe(act.optDouble("x1", 540.0).toFloat(), act.optDouble("y1", 1500.0).toFloat(), act.optDouble("x2", 540.0).toFloat(), act.optDouble("y2", 500.0).toFloat()); null }
            "type" -> { if (!sa.typeNode(act.optInt("id", -1), act.optString("text"))) log("输入失败：序号过期"); null }
            "scroll" -> { sa.scrollNode(act.optInt("id", -1), act.optBoolean("forward", true)); null }
            "back" -> { sa.back(); null }
            "home" -> { sa.home(); null }
            "recents" -> { sa.recents(); null }
            "open_app" -> { if (!sa.openApp(act.optString("pkg"))) log("打开失败：${act.optString("pkg")} 未安装"); null }
            "read_screen" -> null // 下一轮自然重读
            "web_search" -> {
                val q = act.optString("query")
                val r = if (q.isBlank()) "（空查询）" else WebSearch.search(q)
                pendingContext = "搜索[$q] 结果：\n$r"
                log("搜索完成: $q")
                null
            }
            "screenshot" -> {
                val f = com.bloomhub.pocket.screen.Screenshot.take(context)
                if (f != null) {
                    pendingContext = "截图已保存：${f.name}（下一步可用 send_screenshot 发送）"
                    log("截图: ${f.name}")
                } else {
                    pendingContext = "截图失败：未授权截屏（需在主界面点一次「截屏授权」）"
                    log("截图失败")
                }
                null
            }
            "send_screenshot" -> {
                val f = com.bloomhub.pocket.screen.Screenshot.lastShot(context)
                if (f == null) {
                    pendingContext = "没有可发送的截图，先执行 screenshot"
                    null
                } else {
                    val uri = com.bloomhub.pocket.screen.Screenshot.toGallery(context, f)
                    val ok = uri != null && com.bloomhub.pocket.screen.Screenshot.shareToQq(context, uri)
                    pendingContext = if (ok) "已打开 QQ 分享界面：接下来点目标联系人 → 点发送，然后 done" else "分享失败（QQ 未安装或无法调起）"
                    log("send_screenshot: $ok")
                    null
                }
            }
            "learn" -> {
                val note = act.optString("note")
                if (note.isNotBlank()) {
                    manual.learn(ScreenAccess.currentPackage, note)
                    log("已学习：${note.take(80)}")
                }
                null
            }
            "memorize" -> {
                val who = act.optString("who"); val text = act.optString("text")
                if (who.isNotBlank() && text.isNotBlank()) {
                    memory.add(who, text, "agent")
                    log("已记住关于 $who 的一条印象")
                }
                null
            }
            "recall" -> {
                val m = memory.render(act.optString("who"))
                log(if (m.isBlank()) "（无记忆）" else m)
                chat.append("memory", m)
                null
            }
            "done" -> {
                val s = act.optString("summary", "完成")
                chat.append("done", s)
                com.bloomhub.pocket.screen.Screenshot.cleanup(context)
                TaskResult(true, s, 0)
            }
            "fail" -> {
                val s = act.optString("reason", "失败")
                chat.append("fail", s)
                com.bloomhub.pocket.screen.Screenshot.cleanup(context)
                TaskResult(false, s, 0)
            }
            else -> { log("未知动作 ${act.optString("action")}，忽略"); null }
        }
    }

    private fun pkgFromScreen(screen: String): String =
        screen.lineSequence().firstOrNull { it.startsWith("包名") }?.substringAfter(": ")?.trim() ?: ""

    companion object {
        fun truncate(s: String, max: Int) = if (s.length <= max) s else s.take(max) + "\n…(已截断)"

        /** 从模型输出里抠出第一个 JSON 对象（容忍前后缀噪声与思考段） */
        fun parseAction(raw: String): JSONObject? {
            var text = raw.substringAfter("<|im_start|>assistant").trim()
            // Qwen3 思考段剥除（即使 /no_think 偶发失效也兜得住）
            text = text.replace(Regex("<think>[\\s\\S]*?</think>"), "").replace("</think>", "").trim()
            val start = text.indexOf('{')
            if (start < 0) return null
            var depth = 0
            var inStr = false
            var esc = false
            for (i in start until text.length) {
                val c = text[i]
                if (esc) { esc = false; continue }
                when {
                    c == '\\' && inStr -> esc = true
                    c == '"' -> inStr = !inStr
                    !inStr && c == '{' -> depth++
                    !inStr && c == '}' -> {
                        depth--
                        if (depth == 0) return try {
                            val o = JSONObject(text.substring(start, i + 1))
                            if (o.has("action")) o else null
                        } catch (_: Exception) { null }
                    }
                }
            }
            return null
        }
    }
}
