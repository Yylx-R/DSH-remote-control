package com.dshremote.app.data

import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import okhttp3.OkHttpClient
import okhttp3.Request
import java.util.concurrent.TimeUnit

data class AppUpdate(
    val versionName: String,
    val versionCode: Int,
    val url: String,
    val size: Long,
    val sha256: String,
    val notes: String,
)

/**
 * 检查更新：从自己的中转服务器读 /app/latest.json，和本机 versionCode 比较。
 * 服务器上的目录结构：
 *   public/app/latest.json
 *   public/dsh-console-app-<version>.apk
 */
object UpdateChecker {

    private val client: OkHttpClient = OkHttpClient.Builder()
        .connectTimeout(10, TimeUnit.SECONDS)
        .readTimeout(20, TimeUnit.SECONDS)
        .build()

    fun fetch(serverUrl: String): AppUpdate? {
        val base = serverUrl.trim().trimEnd('/')
        if (base.isEmpty()) return null
        val req = Request.Builder().url("$base/app/latest.json").get().build()
        client.newCall(req).execute().use { res ->
            if (!res.isSuccessful) return null
            val text = res.body?.string() ?: return null
            val o = runCatching { Json.parseToJsonElement(text) as JsonObject }.getOrNull() ?: return null
            val code = o.str("versionCode")?.toIntOrNull() ?: return null
            val rawUrl = o.str("url") ?: return null
            val abs = if (rawUrl.startsWith("http://") || rawUrl.startsWith("https://")) {
                rawUrl
            } else {
                "$base/${rawUrl.trimStart('/')}"
            }
            return AppUpdate(
                versionName = o.str("versionName") ?: code.toString(),
                versionCode = code,
                url = abs,
                size = o.str("size")?.toLongOrNull() ?: 0L,
                sha256 = o.str("sha256").orEmpty().lowercase(),
                notes = o.str("notes").orEmpty(),
            )
        }
    }

    /** 下载 APK 到 cacheDir/update/，返回本地文件。 */
    fun download(update: AppUpdate, targetDir: java.io.File): java.io.File {
        targetDir.mkdirs()
        val out = java.io.File(targetDir, "dsh-console-${update.versionCode}.apk")
        if (out.exists() && out.length() == update.size && update.size > 0) {
            if (update.sha256.isEmpty() || sha256(out) == update.sha256) return out
            out.delete() // 缓存文件与服务器发布的不一致，重新下载
        }
        val req = Request.Builder().url(update.url).get().build()
        client.newCall(req).execute().use { res ->
            if (!res.isSuccessful) throw IllegalStateException("下载失败 HTTP ${res.code}")
            val body = res.body ?: throw IllegalStateException("下载失败：响应为空")
            out.outputStream().use { os -> body.byteStream().copyTo(os) }
        }
        if (update.size > 0 && out.length() != update.size) {
            out.delete()
            throw IllegalStateException("下载不完整（${out.length()}/${update.size}）")
        }
        if (update.sha256.isNotEmpty() && sha256(out) != update.sha256) {
            out.delete()
            throw IllegalStateException("安装包校验失败（sha256 不一致），请重试")
        }
        return out
    }

    private fun sha256(f: java.io.File): String {
        val md = java.security.MessageDigest.getInstance("SHA-256")
        f.inputStream().use { ins ->
            val buf = ByteArray(64 * 1024)
            while (true) {
                val n = ins.read(buf)
                if (n <= 0) break
                md.update(buf, 0, n)
            }
        }
        return md.digest().joinToString("") { "%02x".format(it) }
    }
}
