package com.bloomhub.pocket.agent

import java.io.BufferedReader
import java.net.HttpURLConnection
import java.net.URL
import java.net.URLEncoder

/**
 * 联网搜索（Bing 中国优先，百度兜底），纯 HttpURLConnection，无第三方依赖。
 * 返回 top N 条 "标题 — 摘要" 文本，供 Agent 注入上下文。
 */
object WebSearch {

    fun search(query: String, count: Int = 5): String {
        val q = URLEncoder.encode(query, "UTF-8")
        val bing = try { fetch("https://cn.bing.com/search?q=$q&count=$count", ::parseBing) } catch (e: Exception) { "" }
        if (bing.isNotBlank()) return bing
        val baidu = try { fetch("https://www.baidu.com/s?wd=$q", ::parseBaidu) } catch (e: Exception) { "" }
        return baidu.ifBlank { "（搜索失败：网络不可用或被拦截）" }
    }

    private fun fetch(url: String, parser: (String) -> List<String>): String {
        val conn = URL(url).openConnection() as HttpURLConnection
        conn.connectTimeout = 8000
        conn.readTimeout = 12000
        conn.setRequestProperty(
            "User-Agent",
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36"
        )
        conn.setRequestProperty("Accept-Language", "zh-CN,zh;q=0.9")
        if (conn.responseCode != 200) return ""
        val html = conn.inputStream.bufferedReader(Charsets.UTF_8).use(BufferedReader::readText)
        val results = parser(html)
        return results.joinToString("\n")
    }

    private fun stripTags(s: String): String =
        s.replace(Regex("<[^>]+>"), "").replace("&nbsp;", " ")
            .replace("&amp;", "&").replace("&quot;", "\"").replace("&#39;", "'").trim()

    /** Bing：<li class="b_algo"> 内的 <h2><a>标题</a></h2> 与 <p>摘要</p> */
    private fun parseBing(html: String): List<String> {
        val out = ArrayList<String>()
        val liRe = Regex("<li class=\"b_algo\"[\\s\\S]*?</li>")
        for (m in liRe.findAll(html)) {
            val block = m.value
            val title = Regex("<h2[^>]*><a[^>]*>([\\s\\S]*?)</a>").find(block)?.groupValues?.get(1) ?: continue
            val snippet = Regex("<p[^>]*>([\\s\\S]*?)</p>").find(block)?.groupValues?.get(1) ?: ""
            val t = stripTags(title)
            if (t.isNotBlank()) out.add("- $t — ${stripTags(snippet).take(140)}")
            if (out.size >= 5) break
        }
        return out
    }

    /** 百度兜底：<h3 class="c-title"> 或旧版 <h3 class="t"> */
    private fun parseBaidu(html: String): List<String> {
        val out = ArrayList<String>()
        val h3Re = Regex("<h3[^>]*class=\"[^\"]*title[^\"]*\"[^>]*>([\\s\\S]*?)</h3>")
        for (m in h3Re.findAll(html)) {
            val t = stripTags(m.groupValues[1])
            if (t.isNotBlank() && t.length > 4) out.add("- $t")
            if (out.size >= 6) break
        }
        return out
    }
}
