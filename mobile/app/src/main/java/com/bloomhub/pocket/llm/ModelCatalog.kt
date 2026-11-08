package com.bloomhub.pocket.llm

/**
 * 模型目录 + 设备检测 + 推荐。
 * 源统一走 ModelScope（国内直连快）；全部为 GGUF Q4_K_M 量化。
 */
object ModelCatalog {

    data class ModelSpec(
        val id: String,
        val name: String,
        val sizeMb: Int,
        val minRamGb: Int,          // 低于此内存不建议
        val quality: Int,           // 1~5 星（聪明程度）
        val speed: Int,             // 1~5 星（响应速度）
        val desc: String,
        val url: String
    )

    val MODELS = listOf(
        ModelSpec(
            "qwen3-1.7b", "Qwen3 1.7B（推荐）", 1225, 6, 3, 4,
            "速度与智能的平衡点，日常任务最合适",
            "https://modelscope.cn/models/bartowski/Qwen_Qwen3-1.7B-GGUF/resolve/master/Qwen_Qwen3-1.7B-Q4_K_M.gguf"
        ),
        ModelSpec(
            "qwen2.5-1.5b", "Qwen2.5 1.5B（小而快）", 1120, 4, 2, 5,
            "内存紧张或想更快响应时选它",
            "https://modelscope.cn/models/bartowski/Qwen2.5-1.5B-Instruct-GGUF/resolve/master/Qwen2.5-1.5B-Instruct-Q4_K_M.gguf"
        ),
        ModelSpec(
            "qwen2.5-3b", "Qwen2.5 3B（更聪明）", 1980, 10, 4, 3,
            "复杂任务更靠谱，但明显更慢、更吃内存",
            "https://modelscope.cn/models/bartowski/Qwen2.5-3B-Instruct-GGUF/resolve/master/Qwen2.5-3B-Instruct-Q4_K_M.gguf"
        ),
        ModelSpec(
            "qwen3-4b", "Qwen3 4B（最强）", 2530, 12, 5, 2,
            "本机档位上限，任务复杂度优先时选",
            "https://modelscope.cn/models/bartowski/Qwen_Qwen3-4B-GGUF/resolve/master/Qwen_Qwen3-4B-Q4_K_M.gguf"
        )
    )

    /** 按设备内存推荐默认模型 */
    fun recommend(ramGb: Int): ModelSpec = when {
        ramGb >= 12 -> MODELS[2] // 3B：大内存上更聪明的默认更划算
        ramGb >= 8 -> MODELS[0]  // 1.7B
        else -> MODELS[1]        // 1.5B
    }

    fun byId(id: String?): ModelSpec? = MODELS.firstOrNull { it.id == id }
}

/** 读取手机配置 */
object DeviceProfile {
    data class Info(val socName: String, val ramGb: Int, val cores: Int, val model: String)

    fun detect(context: android.content.Context): Info {
        val am = context.getSystemService(android.content.Context.ACTIVITY_SERVICE) as android.app.ActivityManager
        val mi = android.app.ActivityManager.MemoryInfo()
        am.getMemoryInfo(mi)
        val ramGb = (mi.totalMem / (1024.0 * 1024.0 * 1024.0)).toInt()
        val hw = android.os.Build.HARDWARE ?: ""
        val soc = when {
            hw.contains("qcom", true) || (android.os.Build.BOARD ?: "").contains("qcom", true) -> "高通骁龙"
            hw.contains("mt", true) || (android.os.Build.BOARD ?: "").contains("mt", true) -> "联发科"
            hw.contains("exynos", true) -> "三星 Exynos"
            hw.contains("kirin", true) -> "华为麒麟"
            else -> hw.ifBlank { "未知芯片" }
        }
        return Info(soc, ramGb, Runtime.getRuntime().availableProcessors(), "${android.os.Build.BRAND} ${android.os.Build.MODEL}")
    }
}
