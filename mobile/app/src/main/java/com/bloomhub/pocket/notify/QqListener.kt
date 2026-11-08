package com.bloomhub.pocket.notify

import android.service.notification.NotificationListenerService
import android.service.notification.StatusBarNotification
import com.bloomhub.pocket.AgentService

/**
 * QQ 新消息监听：主人（可配置昵称/QQ号）发来消息时，
 * 点亮屏幕并把「回复任务」塞进 Agent 队列。
 * 锁屏状态下无法操作屏幕——需要手机无锁屏或已解锁（本机无敏感资料的设定下通常可接受）。
 */
class QqListener : NotificationListenerService() {

    /** 冷启动兜底：服务没跑就拉起（否则任务只入队没人执行） */
    private fun startAgentService() {
        if (!AgentService.running) {
            try {
                applicationContext.startForegroundService(android.content.Intent(applicationContext, AgentService::class.java))
            } catch (e: Exception) {
                // 后台启动受限时忽略：下次打开 App 会补跑队列
            }
        }
    }

    /**
     * 尽力从通知里解析发送者 QQ 号（people / 会话标识）；解析不到返回 null。
     * 有 uin 就按号校验，没有才退化成昵称精确匹配 —— 昵称可重名，不作为首选。
     */
    private fun senderUin(sbn: StatusBarNotification): Long? {
        return try {
            val people = sbn.notification.extras
                .getParcelableArray(android.app.Notification.EXTRA_PEOPLE)
            for (p in people ?: emptyArray()) {
                val s = when (p) {
                    is android.app.Person -> p.key ?: p.uri?.toString()
                    else -> p.toString()
                } ?: continue
                val m = Regex("\\d{5,12}").find(s) ?: continue
                return m.value.toLongOrNull()
            }
            null
        } catch (_: Exception) { null }
    }

    companion object {
        const val QQ_PKG = "com.tencent.mobileqq"
        /** 任务来源昵称：改成你的名字/你信任的人（精确匹配） */
        val ownerNames = setOf("主人")
        /** 任务来源 QQ 号：能从通知解析出 uin 时强校验 */
        val ownerQqs = setOf(10000L, 10001L)
        private val seen = LinkedHashMap<String, Boolean>()
    }

    override fun onNotificationPosted(sbn: StatusBarNotification?) {
        val n = sbn?.notification ?: return
        if (sbn.packageName != QQ_PKG) return
        val extras = n.extras
        val title = extras.getCharSequence("android.title")?.toString() ?: return
        val text = (
            extras.getCharSequence("android.text")
                ?: extras.getCharSequence("android.bigText")
            )?.toString() ?: return
        // 去重（QQ 通知会重复发）；FIFO 淘汰最旧的，避免整体清空后短时间内重复触发
        val key = "$title|$text"
        synchronized(seen) {
            if (seen.put(key, true) != null) return
            if (seen.size > 400) {
                val it = seen.entries.iterator()
                it.next(); it.remove()
            }
        }
        // 来源校验：解析到 uin 按号判（强），否则昵称必须完全相等（防「包含」冒充）
        val uin = senderUin(sbn)
        val fromOwner = if (uin != null) ownerQqs.contains(uin) else ownerNames.contains(title)
        if (!fromOwner) return

        startAgentService()
        if (text.contains("[图片]") || text.contains("[动画表情]")) {
            // v1 无视觉；提示收到但暂不能看
            AgentService.enqueue("QQ 收到来自 $title 的媒体消息（青鸟暂看不了图片），回复一句并说明", "来自 $title 的消息：$text")
            return
        }
        AgentService.enqueue("处理 $title 发来的 QQ 消息", "他刚发来的消息：$text")
    }
}
