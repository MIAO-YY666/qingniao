package com.bloomhub.pocket

import android.app.Application
import java.io.File
import java.io.PrintWriter
import java.io.StringWriter

/**
 * 全局崩溃捕获：未捕获异常的堆栈写入应用私有目录 crash/last.txt
 * （不再写公共 Download —— 公共目录其他应用可读，会泄露堆栈与运行细节）。
 * 并正常交给系统默认处理（崩溃）。
 * MainActivity 下次启动会把 last.txt 显示在运行日志区，方便定位闪退原因。
 */
class App : Application() {

    companion object {
        @Volatile var lastCrash: String? = null
        const val CRASH_FILE = "crash/last.txt"
    }

    override fun onCreate() {
        super.onCreate()
        val file = File(filesDir, CRASH_FILE)
        if (file.exists()) lastCrash = file.readText().take(4000)

        Thread.setDefaultUncaughtExceptionHandler { t, e ->
            try {
                val sw = StringWriter()
                e.printStackTrace(PrintWriter(sw))
                val text = "time: ${System.currentTimeMillis()}\nthread: ${t.name}\n$sw"
                File(filesDir, "crash").apply { mkdirs() }
                File(filesDir, CRASH_FILE).writeText(text)
            } catch (_: Exception) {
            }
            // 交给系统默认处理（真正崩溃）
            android.os.Process.killProcess(android.os.Process.myPid())
            Runtime.getRuntime().exit(10)
        }
    }
}
