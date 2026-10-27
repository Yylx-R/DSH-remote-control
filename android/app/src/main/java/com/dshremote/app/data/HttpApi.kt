package com.dshremote.app.data

import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import kotlinx.serialization.json.JsonObject
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import java.util.concurrent.TimeUnit

class ApiException(message: String) : Exception(message)

/** 把 OkHttp 的英文网络异常翻译成用户能看懂的中文提示。 */
fun friendlyNetError(e: Throwable): String = when (e) {
    is java.net.UnknownHostException -> "找不到服务器，请检查网络或服务器地址"
    is java.net.SocketTimeoutException -> "连接超时，请稍后重试"
    is java.net.ConnectException -> "连不上服务器，端口未开放或被拦截"
    is javax.net.ssl.SSLException -> "HTTPS 握手失败，请检查证书或改用 http://"
    else -> e.message?.takeIf { it.isNotBlank() } ?: "网络连接异常（${e.javaClass.simpleName}）"
}

class HttpApi {
    private val client = OkHttpClient.Builder()
        .connectTimeout(15, TimeUnit.SECONDS)
        .readTimeout(30, TimeUnit.SECONDS)
        .writeTimeout(30, TimeUnit.SECONDS)
        .build()

    private val jsonMedia = "application/json; charset=utf-8".toMediaType()

    private suspend fun call(
        url: String,
        method: String,
        token: String? = null,
        body: String? = null,
    ): JsonObject = withContext(Dispatchers.IO) {
        val builder = Request.Builder().url(url)
        if (token != null) builder.header("Authorization", "Bearer $token")
        when (method) {
            "POST" -> builder.post((body ?: "{}").toRequestBody(jsonMedia))
            "DELETE" -> builder.delete()
            else -> builder.get()
        }
        val res = try {
            client.newCall(builder.build()).execute()
        } catch (e: java.io.IOException) {
            throw ApiException(friendlyNetError(e))
        }
        res.use {
            val text = res.body?.string().orEmpty()
            val obj = try {
                J.parseToJsonElement(text).let { it as? JsonObject }
            } catch (_: Exception) {
                null
            }
            if (!res.isSuccessful) {
                val msg = obj?.str("error") ?: "HTTP ${res.code}"
                throw ApiException(msg)
            }
            obj ?: throw ApiException("服务器返回了无法解析的数据")
        }
    }

    private fun base(url: String): String = url.trim().trimEnd('/')

    suspend fun login(
        serverUrl: String,
        handle: String,
        password: String,
        deviceName: String,
        platform: String,
    ): JsonObject = call(
        "${base(serverUrl)}/api/login",
        "POST",
        body = buildJson(
            "handle" to handle,
            "password" to password,
            "device" to buildJson(
                "kind" to "mobile",
                "name" to deviceName,
                "platform" to platform,
            ),
        ).toString(),
    )

    suspend fun me(serverUrl: String, token: String): JsonObject =
        call("${base(serverUrl)}/api/me", "GET", token)

    suspend fun pairClaim(serverUrl: String, token: String, code: String): JsonObject =
        call("${base(serverUrl)}/api/pair/claim", "POST", token, buildJson("code" to code).toString())

    suspend fun pairStatus(serverUrl: String, token: String, code: String): JsonObject =
        call("${base(serverUrl)}/api/pair/status?code=$code", "GET", token)

    suspend fun revokeDevice(serverUrl: String, token: String, deviceId: String): JsonObject =
        call("${base(serverUrl)}/api/devices/$deviceId/revoke", "POST", token)

    /** 上传一个文件到中转服务器，返回 { blobId, size, sha256 }。 */
    suspend fun uploadBlob(
        serverUrl: String,
        token: String,
        bytes: ByteArray,
        mime: String,
        name: String,
    ): JsonObject = withContext(Dispatchers.IO) {
        val media = (mime.ifBlank { "application/octet-stream" }).toMediaType()
        val req = Request.Builder()
            .url("${base(serverUrl)}/api/blob")
            .header("Authorization", "Bearer $token")
            .header("x-name", java.net.URLEncoder.encode(name, "UTF-8"))
            .post(bytes.toRequestBody(media))
            .build()
        val res = try {
            client.newBuilder()
                .writeTimeout(180, TimeUnit.SECONDS)
                .readTimeout(180, TimeUnit.SECONDS)
                .build()
                .newCall(req).execute()
        } catch (e: java.io.IOException) {
            throw ApiException(friendlyNetError(e))
        }
        res.use {
            val text = res.body?.string().orEmpty()
            val obj = try {
                J.parseToJsonElement(text) as? JsonObject
            } catch (_: Exception) {
                null
            }
            if (!res.isSuccessful) {
                throw ApiException(obj?.str("error") ?: "上传失败 HTTP ${res.code}")
            }
            obj ?: throw ApiException("上传返回无法解析")
        }
    }

    /** 从服务器拉取 blob 原始字节（截图等）。 */
    suspend fun downloadBlob(serverUrl: String, token: String, blobId: String): ByteArray =
        withContext(Dispatchers.IO) {
            val req = Request.Builder()
                .url("${base(serverUrl)}/api/blob/${java.net.URLEncoder.encode(blobId, "UTF-8")}")
                .header("Authorization", "Bearer $token")
                .get()
                .build()
            val res = try {
                client.newBuilder()
                    .readTimeout(120, TimeUnit.SECONDS)
                    .build()
                    .newCall(req).execute()
            } catch (e: java.io.IOException) {
                throw ApiException(friendlyNetError(e))
            }
            res.use {
                if (!res.isSuccessful) throw ApiException("下载失败 HTTP ${res.code}")
                res.body?.bytes() ?: throw ApiException("下载内容为空")
            }
        }
}
