package com.bloomhub.pocket.llm

import android.app.DownloadManager
import android.content.Context
import android.database.Cursor
import android.os.Environment
import com.bloomhub.pocket.AgentService
import com.bloomhub.pocket.store.ChatStore
import java.io.File

/**
 * 模型下载/导入/自动配置的共用逻辑（向导 UI 与 ADB 接收器都走这里）。
 * 下载走系统 DownloadManager（通知进度、断点续传），完成后自动搬入内部目录并加载。
 */
object ModelSetup {

    sealed class State {
        object Idle : State()
        data class Running(val sofarMb: Int, val totalMb: Int) : State()
        data class Done(val ok: Boolean, val message: String) : State()
    }

    private fun prefs(ctx: Context) = ctx.getSharedPreferences("pocket", Context.MODE_PRIVATE)
    fun downloadId(ctx: Context) = prefs(ctx).getLong("modelDownloadId", -1)

    /** 发起下载；返回是否成功入队 */
    fun enqueue(ctx: Context, spec: ModelCatalog.ModelSpec): Boolean {
        return try {
            val part = File(ctx.getExternalFilesDir(Environment.DIRECTORY_DOWNLOADS), "model.gguf.part")
            part.delete()
            val dm = ctx.getSystemService(Context.DOWNLOAD_SERVICE) as DownloadManager
            val req = DownloadManager.Request(android.net.Uri.parse(spec.url)).apply {
                setTitle("青鸟的模型：${spec.name}")
                setDescription("下载完成自动配置，不用管它")
                setDestinationInExternalFilesDir(ctx, Environment.DIRECTORY_DOWNLOADS, "model.gguf.part")
                setNotificationVisibility(DownloadManager.Request.VISIBILITY_VISIBLE_NOTIFY_COMPLETED)
                setAllowedOverMetered(true)
            }
            val id = dm.enqueue(req)
            prefs(ctx).edit()
                .putLong("modelDownloadId", id)
                .putString("pendingModelName", spec.name)
                .apply()
            ChatStore(ctx).append("download", "开始下载 ${spec.name}（${spec.sizeMb}MB，通知栏可看进度）")
            true
        } catch (e: Exception) {
            ChatStore(ctx).append("download", "入队失败：${e.message}")
            false
        }
    }

    /**
     * 轮询一次：进行中返回 Running；完成则自动搬入+加载+标记向导完成，返回 Done。
     */
    fun pollAndFinalize(ctx: Context): State {
        val id = downloadId(ctx)
        if (id <= 0) return State.Idle
        val dm = ctx.getSystemService(Context.DOWNLOAD_SERVICE) as DownloadManager
        val c: Cursor = dm.query(DownloadManager.Query().setFilterById(id)) ?: return State.Idle
        try {
            if (!c.moveToFirst()) return State.Idle
            return when (c.getInt(c.getColumnIndexOrThrow(DownloadManager.COLUMN_STATUS))) {
                DownloadManager.STATUS_SUCCESSFUL -> {
                    val part = File(ctx.getExternalFilesDir(Environment.DIRECTORY_DOWNLOADS), "model.gguf.part")
                    if (!part.exists() || part.length() < 50L * 1024 * 1024) {
                        prefs(ctx).edit().putLong("modelDownloadId", -1).apply()
                        State.Done(false, "下载完成但文件异常（<50MB），请重试")
                    } else {
                        val msg = finalizeFile(ctx, part)
                        State.Done(msg.startsWith("✓"), msg)
                    }
                }
                DownloadManager.STATUS_RUNNING, DownloadManager.STATUS_PAUSED -> {
                    val sofar = c.getInt(c.getColumnIndexOrThrow(DownloadManager.COLUMN_BYTES_DOWNLOADED_SO_FAR))
                    val total = c.getInt(c.getColumnIndexOrThrow(DownloadManager.COLUMN_TOTAL_SIZE_BYTES))
                    State.Running(sofar / 1048576, if (total > 0) total / 1048576 else 0)
                }
                DownloadManager.STATUS_FAILED -> {
                    val reason = c.getInt(c.getColumnIndexOrThrow(DownloadManager.COLUMN_REASON))
                    prefs(ctx).edit().putLong("modelDownloadId", -1).apply()
                    State.Done(false, "下载失败（原因码 $reason），可重试；多次失败请电脑下载后导入")
                }
                else -> State.Idle
            }
        } finally {
            c.close()
        }
    }

    /** 从任意路径导入模型文件并加载（adb / 手动导入共用） */
    fun importFrom(ctx: Context, srcPath: String): String {
        val src = File(srcPath)
        if (!src.exists() || src.length() < 50L * 1024 * 1024) {
            return "导入失败：文件不存在或太小（${srcPath}）"
        }
        return finalizeFile(ctx, src)
    }

    /** 搬入内部 models/ 并加载；成功同时标记新手向导完成 */
    private fun finalizeFile(ctx: Context, src: File): String {
        return try {
            val target = File(ctx.filesDir, "models/model.gguf")
            target.parentFile?.mkdirs()
            target.delete()
            if (src.absolutePath != target.absolutePath) {
                src.copyTo(target, overwrite = true)
                src.delete()
            }
            AgentService.setLlm(LocalLlm(target.absolutePath))
            prefs(ctx).edit()
                .putLong("modelDownloadId", -1)
                .putBoolean("setupDone", true)
                .apply()
            ChatStore(ctx).append("download", "✓ 模型就绪（${target.length() / 1048576}MB），已自动配置")
            "✓ 模型就绪（${target.length() / 1048576}MB，自动配置完成）"
        } catch (e: Exception) {
            ChatStore(ctx).append("download", "加载失败：${e.message}")
            "✗ 下载完成但加载失败：${e.message}"
        }
    }

    /** 后台守护：ADB 触发下载时用（无 UI 轮询，直到完成） */
    suspend fun awaitAndFinalize(ctx: Context) {
        while (true) {
            when (val s = pollAndFinalize(ctx)) {
                is State.Done -> return
                is State.Running -> kotlinx.coroutines.delay(5000)
                else -> return
            }
        }
    }
}
