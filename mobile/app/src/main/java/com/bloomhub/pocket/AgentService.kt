package com.bloomhub.pocket

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.os.Build
import android.os.Handler
import android.os.IBinder
import android.os.Looper
import android.os.PowerManager
import android.util.Log
import com.bloomhub.pocket.agent.AgentLoop
import com.bloomhub.pocket.llm.CloudLlm
import com.bloomhub.pocket.llm.Llm
import com.bloomhub.pocket.llm.LocalLlm
import com.bloomhub.pocket.screen.ScreenAccess
import com.bloomhub.pocket.screen.Screenshot
import com.bloomhub.pocket.store.ChatStore
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.launch
import kotlinx.coroutines.cancel
import java.util.concurrent.LinkedBlockingQueue

/**
 * 前台服务：持有 LLM 与 Agent 循环，串行处理任务队列。
 * 任务来源：MainActivity 手动下发、QqListener 通知触发。
 */
class AgentService : Service() {

    companion object {
        @Volatile var running = false
            private set
        @Volatile var statusText = "未启动"
        private var llm: Llm? = null
        private val queue = LinkedBlockingQueue<Task>()
        private val mainHandler = Handler(Looper.getMainLooper())
        private var chatStore: ChatStore? = null

        /** 任务入队；qqContext 为触发任务的消息背景（可空） */
        fun enqueue(goal: String, qqContext: String? = null) {
            queue.add(Task(goal, qqContext))
            statusText = "队列中：${queue.size} 个任务"
        }

        /** 清空待执行队列（正在执行的任务不受影响）；返回清掉的数量 */
        fun clearQueue(): Int {
            val drained = ArrayList<Task>()
            queue.drainTo(drained)
            if (drained.isNotEmpty()) statusText = "已清空队列（${drained.size} 个任务）"
            return drained.size
        }

        fun setLlm(newLlm: Llm) {
            llm?.unload()
            llm = newLlm
            statusText = "模型就绪（${if (newLlm is LocalLlm) "本地" else "云端"}）"
        }

        fun hasLlm() = llm != null

        /**
         * 确保有可用模型：进程重启后静态 llm 会丢，这里从磁盘懒加载。
         * 所有任务入口（QQ 通知/ADB/主界面）都先调它。
         * 加锁：多个入口并发调用时避免重复加载同一份 GGUF（浪费 1GB+ 内存）。
         */
        @Synchronized
        fun ensureLlm(context: android.content.Context): Llm? {
            if (llm != null) return llm
            val f = java.io.File(context.filesDir, "models/model.gguf")
            if (!f.exists()) return null
            return try {
                val l = LocalLlm(f.absolutePath)
                setLlm(l)
                l
            } catch (e: Exception) {
                android.util.Log.e("AgentService", "model reload failed", e)
                null
            }
        }

        fun logToUi(line: String) {
            chatStore?.append("log", line)
        }

        data class Task(val goal: String, val qqContext: String?)
    }

    private lateinit var wakeLock: PowerManager.WakeLock
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Default)

    override fun onCreate() {
        super.onCreate()
        chatStore = ChatStore(this)
        wakeLock = (getSystemService(POWER_SERVICE) as PowerManager)
            .newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "pocket:agent")
        // Android 14(API 34) 起：manifest 声明了 foregroundServiceType 的服务必须显式传类型，
        // 两参 startForeground 会抛 MissingForegroundServiceTypeException 直接崩。
        if (Build.VERSION.SDK_INT >= 34) {
            startForeground(1, buildNotification(), ServiceInfo.FOREGROUND_SERVICE_TYPE_SPECIAL_USE)
        } else {
            startForeground(1, buildNotification())
        }
        running = true
        statusText = "待命（${if (llm == null) "未加载模型" else "模型就绪"}）"
        scope.launch { loop() }
        Log.i("AgentService", "started")
    }

    private suspend fun loop() {
        while (true) {
            val task = try { queue.take() } catch (e: InterruptedException) { break }
            val current = ensureLlm(this)
            if (current == null) {
                statusText = "未加载模型，任务被跳过"
                logToUi("跳过任务（未加载模型）：${task.goal}")
                continue
            }
            statusText = "执行中：${task.goal.take(30)}"
            logToUi("▶ ${task.goal}")
            wakeLock.acquire(10 * 60 * 1000L)
            try {
                val agent = AgentLoop(this, current) { line ->
                    logToUi(line)
                    statusText = "执行中：${line.take(40)}"
                }
                val r = agent.run(task.goal, task.qqContext)
                statusText = if (r.ok) "完成：${r.summary.take(40)}" else "失败：${r.summary.take(40)}"
                logToUi(if (r.ok) "✔ ${r.summary}" else "✘ ${r.summary}")
            } catch (e: Exception) {
                statusText = "异常：${e.message?.take(40)}"
                logToUi("异常：${e.message}")
                Log.e("AgentService", "task failed", e)
            } finally {
                wakeLock.release()
            }
        }
    }

    private fun buildNotification(): Notification {
        val nm = getSystemService(NOTIFICATION_SERVICE) as NotificationManager
        nm.createNotificationChannel(
            NotificationChannel("pocket", getString(R.string.notif_channel), NotificationManager.IMPORTANCE_LOW)
        )
        val pi = PendingIntent.getActivity(
            this, 0, Intent(this, MainActivity::class.java),
            PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT
        )
        return Notification.Builder(this, "pocket")
            .setContentTitle(getString(R.string.notif_title))
            .setContentText(statusText)
            .setSmallIcon(android.R.drawable.ic_menu_compass)
            .setContentIntent(pi)
            .setOngoing(true)
            .build()
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        // 截屏授权结果：Android 14 要求「先有 mediaProjection 类型前台服务，再 createVirtualDisplay」，
        // 所以授权回调统一转交到这里：先升级 FGS 类型，再取 MediaProjection。
        val projCode = intent?.getIntExtra("projectionResultCode", 0) ?: 0
        @Suppress("DEPRECATION")
        val projData: Intent? = intent?.getParcelableExtra("projectionData")
        if (projCode == android.app.Activity.RESULT_OK && projData != null) {
            if (Build.VERSION.SDK_INT >= 34) {
                try {
                    startForeground(
                        1, buildNotification(),
                        ServiceInfo.FOREGROUND_SERVICE_TYPE_SPECIAL_USE or ServiceInfo.FOREGROUND_SERVICE_TYPE_MEDIA_PROJECTION
                    )
                } catch (e: Exception) {
                    // 激活 mediaProjection 类型失败时退回 specialUse，至少服务不崩
                    Log.w("AgentService", "激活 mediaProjection FGS 类型失败，退回 specialUse", e)
                    startForeground(1, buildNotification(), ServiceInfo.FOREGROUND_SERVICE_TYPE_SPECIAL_USE)
                }
            }
            val ok = Screenshot.init(this, projCode, projData)
            logToUi(if (ok) "截屏就绪 ✓（任务内可反复截屏）" else "截屏初始化失败：未取得 MediaProjection")
        }

        // ADB/向导触发的下载：由前台服务盯完成并自动配置（广播接收器 10 秒就会被回收，盯不了）
        intent?.getStringExtra("importPath")?.let { p ->
            scope.launch {
                try {
                    val r = com.bloomhub.pocket.llm.ModelSetup.importFrom(this@AgentService, p)
                    logToUi("ADB 导入：$r")
                } catch (_: Exception) {}
            }
        }
        if (intent?.getBooleanExtra("watchDownload", false) == true) {
            scope.launch {
                try { com.bloomhub.pocket.llm.ModelSetup.awaitAndFinalize(this@AgentService) } catch (_: Exception) {}
            }
        }
        return START_STICKY
    }

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onDestroy() {
        running = false
        if (wakeLock.isHeld) wakeLock.release()
        scope.cancel()
        super.onDestroy()
    }
}
