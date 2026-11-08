package com.bloomhub.pocket.screen

import android.accessibilityservice.AccessibilityService
import android.accessibilityservice.GestureDescription
import android.content.Intent
import android.graphics.Path
import android.graphics.Rect
import android.os.Build
import android.view.accessibility.AccessibilityEvent
import android.view.accessibility.AccessibilityNodeInfo

/**
 * 无障碍服务：把当前屏幕序列化成带序号的紧凑文本（供模型阅读），
 * 并执行点击/滑动/输入/返回等动作。单例引用由系统绑定时设置。
 */
class ScreenAccess : AccessibilityService() {

    companion object {
        @Volatile var instance: ScreenAccess? = null
            private set

        val available: Boolean get() = instance != null

        /** 当前前台应用包名（App 用法手册注入用） */
        @Volatile var currentPackage: String = ""
            private set
    }

    // 每次快照的节点缓存：序号 -> 节点（并发安全：agent 线程写、读）
    private val nodeCache = java.util.concurrent.ConcurrentHashMap<Int, AccessibilityNodeInfo>()

    override fun onServiceConnected() {
        super.onServiceConnected()
        instance = this
    }

    override fun onDestroy() {
        instance = null
        super.onDestroy()
    }

    override fun onAccessibilityEvent(event: AccessibilityEvent?) {
        if (event?.eventType == AccessibilityEvent.TYPE_WINDOW_STATE_CHANGED) {
            event.packageName?.let { currentPackage = it.toString() }
        }
    }

    override fun onInterrupt() {}

    // ---------- 读取 ----------

    /** 屏幕快照：紧凑行列表，如 `[12] TextView "设置" @(540,320) click` */
    fun snapshot(maxNodes: Int = 320): String {
        nodeCache.clear()
        val root = rootInActiveWindow ?: return "（无法读取屏幕：当前窗口不可访问）"
        val sb = StringBuilder()
        sb.append("包名: ").append(root.packageName ?: currentPackage).append('\n')
        val counter = intArrayOf(0)
        walk(root, 0, maxNodes, counter, sb)
        return sb.toString()
    }

    private fun walk(node: AccessibilityNodeInfo, depth: Int, maxNodes: Int, counter: IntArray, sb: StringBuilder) {
        if (counter[0] >= maxNodes || depth > 28) return
        val text = listOfNotNull(node.text?.toString(), node.contentDescription?.toString())
            .firstOrNull { it.isNotBlank() }
        val interesting = text != null || node.isClickable || node.isScrollable || node.isEditable ||
            node.viewIdResourceName != null
        if (interesting) {
            val id = counter[0]++
            nodeCache[id] = node
            val r = Rect().also { node.getBoundsInScreen(it) }
            val center = if (r.width() > 2 && r.height() > 2) "@(${r.centerX()},${r.centerY()})" else ""
            val flags = buildString {
                if (node.isClickable) append(" click")
                if (node.isScrollable) append(" scroll")
                if (node.isEditable) append(" edit")
            }
            val type = node.className?.toString()?.substringAfterLast('.') ?: "View"
            val line = if (text != null) "[$id] $type \"$text\" $center$flags"
                       else "[$id] $type $center$flags"
            sb.append(line.trim()).append('\n')
        }
        for (i in 0 until node.childCount) {
            node.getChild(i)?.let { walk(it, depth + 1, maxNodes, counter, sb) }
        }
    }

    // ---------- 操作 ----------

    fun tapNode(id: Int): Boolean {
        val node = nodeCache[id] ?: return tapCachedBounds(id)
        val r = Rect().also { node.getBoundsInScreen(it) }
        if (r.isEmpty) return false
        // 优先语义点击，失败回退手势
        if (node.isClickable && node.performAction(AccessibilityNodeInfo.ACTION_CLICK)) return true
        return gesture(r.centerX().toFloat(), r.centerY().toFloat())
    }

    private fun tapCachedBounds(id: Int): Boolean {
        // 节点已过期：无能为力，让上层重新 read_screen
        return false
    }

    fun gesture(x: Float, y: Float): Boolean {
        val path = Path().apply { moveTo(x, y); lineTo(x, y) }
        val stroke = GestureDescription.StrokeDescription(path, 0, 60)
        return dispatchGesture(GestureDescription.Builder().addStroke(stroke).build(), null, null)
    }

    fun swipe(x1: Float, y1: Float, x2: Float, y2: Float, ms: Long = 300): Boolean {
        val path = Path().apply { moveTo(x1, y1); lineTo(x2, y2) }
        val stroke = GestureDescription.StrokeDescription(path, 0, ms)
        return dispatchGesture(GestureDescription.Builder().addStroke(stroke).build(), null, null)
    }

    fun typeNode(id: Int, text: String): Boolean {
        val node = nodeCache[id] ?: return false
        val args = android.os.Bundle().apply {
            putCharSequence(AccessibilityNodeInfo.ACTION_ARGUMENT_SET_TEXT_CHARSEQUENCE, text)
        }
        return node.performAction(AccessibilityNodeInfo.ACTION_FOCUS, null) &&
            node.performAction(AccessibilityNodeInfo.ACTION_SET_TEXT, args)
    }

    fun scrollNode(id: Int, forward: Boolean = true): Boolean {
        val node = nodeCache[id] ?: return false
        val action = if (forward) AccessibilityNodeInfo.ACTION_SCROLL_FORWARD
                     else AccessibilityNodeInfo.ACTION_SCROLL_BACKWARD
        return node.performAction(action)
    }

    fun back() = performGlobalAction(GLOBAL_ACTION_BACK)
    fun home() = performGlobalAction(GLOBAL_ACTION_HOME)
    fun recents() = performGlobalAction(GLOBAL_ACTION_RECENTS)

    fun openApp(packageName: String): Boolean {
        return try {
            val intent = packageManager.getLaunchIntentForPackage(packageName)
            if (intent != null) {
                intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
                applicationContext.startActivity(intent)
                true
            } else false
        } catch (e: Exception) { false }
    }

    fun screenOn() {
        // 仅点亮屏幕（不解锁锁屏；无锁屏或已解锁场景有效）
        @Suppress("DEPRECATION")
        val pm = getSystemService(POWER_SERVICE) as android.os.PowerManager
        @Suppress("DEPRECATION")
        pm.newWakeLock(android.os.PowerManager.ACQUIRE_CAUSES_WAKEUP or android.os.PowerManager.SCREEN_BRIGHT_WAKE_LOCK, "pocket:screen")
            .acquire(3000)
    }
}
