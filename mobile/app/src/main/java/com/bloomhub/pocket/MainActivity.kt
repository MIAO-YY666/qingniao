package com.bloomhub.pocket

import android.Manifest
import android.app.Activity
import android.content.Intent
import android.content.pm.PackageManager
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.provider.Settings
import android.widget.Button
import android.widget.EditText
import android.widget.TextView
import android.widget.Toast
import androidx.appcompat.app.AppCompatActivity
import androidx.core.app.ActivityCompat
import com.bloomhub.pocket.llm.CloudLlm
import com.bloomhub.pocket.llm.LocalLlm
import com.bloomhub.pocket.llm.Msg
import com.bloomhub.pocket.notify.QqListener
import com.bloomhub.pocket.screen.ScreenAccess
import com.bloomhub.pocket.store.ChatStore
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import java.io.File

class MainActivity : AppCompatActivity() {

    private val handler = Handler(Looper.getMainLooper())
    private lateinit var chatStore: ChatStore
    private var modelFile: File? = null

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContentView(R.layout.activity_main)
        chatStore = ChatStore(this)
        // 日志区需要可滚动 + 允许程序滚到底（见 refreshStatus）
        findViewById<TextView>(R.id.logText).movementMethod = android.text.method.ScrollingMovementMethod()

        findViewById<Button>(R.id.btnA11y).setOnClickListener {
            startActivity(Intent(Settings.ACTION_ACCESSIBILITY_SETTINGS))
        }
        findViewById<Button>(R.id.btnNotif).setOnClickListener {
            startActivity(Intent(Settings.ACTION_NOTIFICATION_LISTENER_SETTINGS))
        }
        findViewById<Button>(R.id.btnShot).setOnClickListener {
            com.bloomhub.pocket.screen.Screenshot.requestPermission(this)
        }
        findViewById<Button>(R.id.btnBattery).setOnClickListener {
            @Suppress("BatteryLife")
            startActivity(Intent(Settings.ACTION_IGNORE_BATTERY_OPTIMIZATION_SETTINGS))
        }

        findViewById<Button>(R.id.btnWizard).setOnClickListener {
            startActivity(Intent(this, SetupActivity::class.java))
        }
        findViewById<Button>(R.id.btnImportModel).setOnClickListener { importModel() }
        findViewById<Button>(R.id.btnCloud).setOnClickListener { useCloud() }
        findViewById<Button>(R.id.btnStart).setOnClickListener { startService() }
        findViewById<Button>(R.id.btnRun).setOnClickListener { runTask() }
        // 清空排队任务：避免任务堆积时只能 force-stop（那会连带杀掉无障碍服务，MIUI 不自动恢复）
        findViewById<Button>(R.id.btnClearQueue).setOnClickListener {
            val n = AgentService.clearQueue()
            Toast.makeText(
                this,
                if (n == 0) "队列本来就是空的" else "已清空 $n 个排队任务（执行中的不受影响）",
                Toast.LENGTH_SHORT
            ).show()
        }

        if (Build.VERSION.SDK_INT >= 33 &&
            checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED
        ) {
            ActivityCompat.requestPermissions(this, arrayOf(Manifest.permission.POST_NOTIFICATIONS), 1)
        }

        // 记住上次导入的模型
        val prev = File(filesDir, "models/model.gguf")
        if (prev.exists()) modelFile = prev

        // 首次启动：未完成新手向导就自动进入
        if (!getSharedPreferences("pocket", MODE_PRIVATE).getBoolean("setupDone", false)) {
            startActivity(Intent(this, SetupActivity::class.java))
        }

        // 上次崩溃原因直接展示（闪退自诊断）
        App.lastCrash?.let {
            chatStore.append("crash", it)
            Toast.makeText(this, "检测到上次崩溃日志，已显示在运行日志区", Toast.LENGTH_LONG).show()
        }

        // ADB 调试入口：am start -n com.bloomhub.pocket/.MainActivity -e goal "打开设置看看"
        // 为什么走 Activity 而不是广播：AdbSetupReceiver 已设为 exported=false，
        // 而 adb shell 属于 shell uid，发非导出组件的广播会被系统直接 SKIPPED，
        // 所以调试派任务改由 Activity 的 intent 承接，既不重新开放导出组件，也方便复现。
        handleAdbGoal(intent)

        refreshStatus()
        handler.post(object : Runnable {
            override fun run() {
                refreshStatus()
                handler.postDelayed(this, 2000)
            }
        })
    }

    /** 承接 adb 派发的调试任务（见 onCreate 注释） */
    private fun handleAdbGoal(intent: Intent?) {
        // 自检入口：am start -n com.bloomhub.pocket/.MainActivity -e selftest 200
        // 用 repeat 段中文把 prompt 撑到几千 token，直接打 native prefill。
        // 旧实现（整段 prompt 一个 batch）在这里必 ggml_abort → SIGABRT；分批后应正常输出。
        intent?.getStringExtra("selftest")?.toIntOrNull()?.let { runSelfTest(it.coerceIn(1, 2000)) }

        val goal = intent?.getStringExtra("goal")?.trim().orEmpty()
        if (goal.isEmpty()) return
        // 调试入口故意跳过「无障碍/模型」前置检查：缺什么就让任务自己报错，
        // 这样能观察到真实失败点，而不是被 Toast 拦在半路。
        if (!AgentService.running) {
            try {
                startForegroundService(Intent(this, AgentService::class.java))
            } catch (e: Exception) {
                chatStore.append("log", "ADB 派任务：服务启动失败 ${e.message}")
            }
        }
        AgentService.enqueue(goal)
        chatStore.append("task", "ADB 任务：$goal")
        Toast.makeText(this, "已派发：$goal", Toast.LENGTH_SHORT).show()
    }

    /** 长 prompt 自检（验证 native 分批 prefill） */
    private fun runSelfTest(repeat: Int) {
        Toast.makeText(this, "自检开始：约 ${repeat * 34} 字 prompt", Toast.LENGTH_SHORT).show()
        Thread {
            try {
                val llm = AgentService.ensureLlm(this) ?: throw IllegalStateException("模型未加载")
                val filler = "这是一段用于压力测试的中文材料，目的是把提示词撑得很长，用来验证分批 prefill 是否正常工作。".repeat(repeat)
                val prompt = "请只回复两个字：收到。不要复述下面的材料。\n\n【材料】\n$filler"
                val t0 = System.currentTimeMillis()
                val out = kotlinx.coroutines.runBlocking {
                    llm.chat(listOf(Msg("user", prompt)), maxTokens = 32, temp = 0.2f)
                }
                val ms = System.currentTimeMillis() - t0
                runOnUiThread {
                    chatStore.append("log", "自检完成：prompt ${filler.length} 字，耗时 ${ms}ms，输出「${out.trim()}」")
                    Toast.makeText(this, "自检通过（${ms}ms）", Toast.LENGTH_LONG).show()
                }
            } catch (e: Throwable) {
                runOnUiThread {
                    chatStore.append("log", "自检异常：${e.message}")
                    Toast.makeText(this, "自检失败：${e.message}", Toast.LENGTH_LONG).show()
                }
            }
        }.start()
    }

    override fun onNewIntent(intent: Intent?) {
        super.onNewIntent(intent)
        handleAdbGoal(intent)
    }

    private fun refreshStatus() {
        val tv = findViewById<TextView>(R.id.statusText)
        val a11y = if (ScreenAccess.available) "✓" else "✗"
        val llm = if (AgentService.hasLlm()) "✓" else "✗"
        tv.text = "无障碍:$a11y  模型:$llm  服务:${if (AgentService.running) "运行中" else "未启动"}\n${AgentService.statusText}"
        val log = findViewById<TextView>(R.id.logText)
        val text = chatStore.tail(120).joinToString("\n").ifBlank { "（尚无日志）" }
        // 只有内容变化才重设文本：否则每 2 秒重置一次会把用户的手动滚动位置顶回去。
        // 重设后必须滚到底部，否则最新进展在可视区之外，看起来像「没反应」。
        if (log.text.toString() != text) {
            log.text = text
            log.post {
                val layout = log.layout ?: return@post
                val bottom = layout.getLineTop(layout.lineCount)
                if (bottom > log.height) log.scrollTo(0, bottom - log.height)
            }
        }
    }

    /** SAF 选 .gguf → 复制到应用目录（llama.cpp 需要真实路径） */
    private fun importModel() {
        val intent = Intent(Intent.ACTION_OPEN_DOCUMENT).apply {
            addCategory(Intent.CATEGORY_OPENABLE)
            type = "*/*"
        }
        startActivityForResult(intent, 1001)
    }

    override fun onActivityResult(requestCode: Int, resultCode: Int, data: Intent?) {
        super.onActivityResult(requestCode, resultCode, data)
        if (requestCode == 2001) {
            if (resultCode == Activity.RESULT_OK && data != null) {
                // Android 14：必须先有 mediaProjection 类型前台服务再取投影，
                // 统一转交 AgentService（先升级 FGS 类型，再 Screenshot.init）
                startForegroundService(
                    Intent(this, AgentService::class.java)
                        .putExtra("projectionResultCode", resultCode)
                        .putExtra("projectionData", data)
                )
                Toast.makeText(this, "截屏授权成功 ✓", Toast.LENGTH_SHORT).show()
            } else {
                Toast.makeText(this, "截屏授权失败", Toast.LENGTH_SHORT).show()
            }
            return
        }
        if (requestCode == 1001 && resultCode == Activity.RESULT_OK) {
            val uri: Uri = data?.data ?: return
            Toast.makeText(this, "开始复制模型到应用目录（1~3GB，请稍候）", Toast.LENGTH_LONG).show()
            CoroutineScope(Dispatchers.IO).launch {
                try {
                    val dir = File(filesDir, "models").apply { mkdirs() }
                    val out = File(dir, "model.gguf")
                    contentResolver.openInputStream(uri)!!.use { input ->
                        out.outputStream().use { input.copyTo(it) }
                    }
                    withContext(Dispatchers.Main) { toastAndLoad(out) }
                } catch (e: Exception) {
                    withContext(Dispatchers.Main) {
                        Toast.makeText(this@MainActivity, "复制失败：${e.message}", Toast.LENGTH_LONG).show()
                    }
                }
            }
        }
    }

    private fun toastAndLoad(f: File) {
        modelFile = f
        try {
            AgentService.setLlm(LocalLlm(f.absolutePath, nCtx = 8192, nThreads = 6))
            Toast.makeText(this, "本地模型已加载 ✓", Toast.LENGTH_SHORT).show()
        } catch (e: Exception) {
            Toast.makeText(this, "加载失败：${e.message}", Toast.LENGTH_LONG).show()
        }
    }

    private fun useCloud() {
        val base = findViewById<EditText>(R.id.edCloudBase).text.toString().trim()
        val key = findViewById<EditText>(R.id.edCloudKey).text.toString().trim()
        if (base.isBlank() || key.isBlank()) {
            Toast.makeText(this, "云端模式需要 Base 和 Key 都填写", Toast.LENGTH_SHORT).show()
            return
        }
        getSharedPreferences("pocket", MODE_PRIVATE).edit()
            .putString("cloudBase", base).putString("cloudKey", key).apply()
        AgentService.setLlm(CloudLlm(base, key))
        Toast.makeText(this, "已切换云端模式（${base}）", Toast.LENGTH_SHORT).show()
    }

    private fun startService() {
        if (!ScreenAccess.available) {
            Toast.makeText(this, "先开启无障碍权限（青鸟读屏）", Toast.LENGTH_LONG).show()
            return
        }
        if (AgentService.ensureLlm(this) == null) {
            Toast.makeText(this, "先导入模型或配置云端", Toast.LENGTH_LONG).show()
            return
        }
        startForegroundService(Intent(this, AgentService::class.java))
        Toast.makeText(this, "青鸟已启动，在通知栏常驻", Toast.LENGTH_SHORT).show()
    }

    private fun runTask() {
        val goal = findViewById<EditText>(R.id.edTask).text.toString().trim()
        if (goal.isBlank()) return
        if (!AgentService.running) startService()
        AgentService.enqueue(goal)
        findViewById<EditText>(R.id.edTask).setText("")
    }

    override fun onDestroy() {
        super.onDestroy()
        handler.removeCallbacksAndMessages(null)
    }
}
