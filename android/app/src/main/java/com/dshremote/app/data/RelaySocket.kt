package com.dshremote.app.data

import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.put
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.Response
import okhttp3.WebSocket
import okhttp3.WebSocketListener
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.TimeUnit
import kotlinx.coroutines.CompletableDeferred

/**
 * 中继长连接：hello 鉴权 → welcome → msg(frames)。
 * 手机端每条指令是 {t:'msg', id:rid, to:电脑id, kind:'dsh', body:{op,rid,...}}，
 * 电脑端回 {op:'reply', rid, ok, data|error}，订阅类回 {op:'stream', subId, frame|error|done}。
 */
class RelaySocket(private val listener: Listener) {

    interface Listener {
        fun onOpen()
        fun onWelcome(pairs: List<JsonObject>, serverTime: Long?)
        fun onMsg(body: JsonObject)
        fun onKick(reason: String?)
        fun onClosed(code: Int, reason: String)
        fun onFailure(t: Throwable)
        fun onStream(stream: JsonObject)
    }

    private val client = OkHttpClient.Builder()
        .pingInterval(25, TimeUnit.SECONDS)
        .connectTimeout(15, TimeUnit.SECONDS)
        .readTimeout(0, TimeUnit.MILLISECONDS)
        .build()

    private var ws: WebSocket? = null
    private val pending = ConcurrentHashMap<String, CompletableDeferred<JsonObject>>()

    /** 连接代号：只有「当前这一条」socket 的回调才允许改状态，避免旧 socket 的 onClosed 触发新的重连。 */
    @Volatile
    private var gen: Int = 0
    @Volatile
    private var curUrl: String = ""
    @Volatile
    private var curToken: String = ""

    @Volatile
    private var targetId: String = ""

    @Volatile
    var connected: Boolean = false
        private set

    fun setTarget(id: String) {
        targetId = id
    }

    fun connect(serverUrl: String, token: String) {
        // 已经在连着同一个服务器、同一个身份，就不要重复建连（重复建连会被服务器互相踢，表现为「已连接/未连接」反复跳）
        if (ws != null && connected && serverUrl == curUrl && token == curToken) return
        close()
        connected = false
        curUrl = serverUrl
        curToken = token
        gen += 1
        val myGen = gen
        val wsUrl = serverUrl.trim().trimEnd('/').replaceFirst("http://", "ws://").replaceFirst("https://", "wss://") + "/ws"
        val req = Request.Builder().url(wsUrl).build()
        ws = client.newWebSocket(req, object : WebSocketListener() {
            override fun onOpen(webSocket: WebSocket, response: Response) {
                if (myGen != gen) return
                webSocket.send(buildJson("t" to "hello", "token" to token).toString())
                listener.onOpen()
            }

            override fun onMessage(webSocket: WebSocket, text: String) {
                if (myGen != gen) return
                handleFrame(text)
            }

            override fun onClosing(webSocket: WebSocket, code: Int, reason: String) {
                webSocket.close(1000, null)
            }

            override fun onClosed(webSocket: WebSocket, code: Int, reason: String) {
                if (myGen != gen) return
                connected = false
                failAll()
                listener.onClosed(code, reason)
            }

            override fun onFailure(webSocket: WebSocket, t: Throwable, response: Response?) {
                if (myGen != gen) return
                connected = false
                failAll()
                listener.onFailure(ApiException(friendlyNetError(t)))
            }
        })
    }

    private fun handleFrame(text: String) {
        val obj = try {
            J.parseToJsonElement(text) as? JsonObject
        } catch (_: Exception) {
            null
        } ?: return
        when (obj.str("t")) {
            "welcome" -> {
                connected = true
                val pairs = obj.arr("pairs")?.asObjects() ?: emptyList()
                listener.onWelcome(pairs, obj.long("serverTime"))
            }
            "msg" -> {
                val body = obj.obj("body") ?: return
                when (body.str("op")) {
                    "reply" -> {
                        val rid = body.str("rid")
                        if (rid != null) pending.remove(rid)?.complete(body)
                    }
                    "stream" -> listener.onStream(body)
                    else -> listener.onMsg(body)
                }
            }
            "kick" -> listener.onKick(obj.str("reason"))
            "ping" -> ws?.send(buildJson("t" to "pong").toString())
            "pong" -> {}
            "error" -> {
                // 带 id 的错误是对某条请求的回应，直接结束对应的等待，避免界面一直转圈
                val rid = obj.str("id")
                val msg = obj.str("error") ?: "服务器错误"
                if (rid != null) {
                    val d = pending.remove(rid)
                    if (d != null) {
                        d.complete(buildJson("ok" to false, "error" to buildJson("message" to msg)))
                    } else {
                        listener.onMsg(buildJson("op" to "error", "message" to msg))
                    }
                } else {
                    listener.onMsg(buildJson("op" to "error", "message" to msg))
                }
            }
        }
    }

    fun request(op: String, params: JsonObject = JsonObject(emptyMap())): CompletableDeferred<JsonObject> {
        val d = CompletableDeferred<JsonObject>()
        if (targetId.isBlank()) {
            d.completeExceptionally(ApiException("还没有选择执行电脑"))
            return d
        }
        if (!connected) {
            d.completeExceptionally(ApiException("与服务器的连接已断开，请稍后重试"))
            return d
        }
        val rid = "r" + System.nanoTime().toString(36) + (1000..9999).random()
        pending[rid] = d
        val msgBody = kotlinx.serialization.json.buildJsonObject {
            put("op", op)
            put("rid", rid)
            for ((k, v) in params) put(k, v)
        }
        val body = buildJson(
            "t" to "msg",
            "id" to rid,
            "to" to targetId,
            "kind" to "dsh",
            "body" to msgBody,
        )
        val ok = ws?.send(body.toString()) ?: false
        if (!ok) {
            pending.remove(rid)
            d.completeExceptionally(ApiException("未连接到服务器"))
        }
        return d
    }

    private fun failAll() {
        val e = ApiException("连接已断开")
        val keys = pending.keys.toList()
        for (k in keys) pending.remove(k)?.completeExceptionally(e)
    }

    fun close() {
        gen += 1 // 让旧 socket 的回调全部失效
        try {
            ws?.close(1000, "bye")
        } catch (_: Exception) {
        }
        ws = null
        connected = false
    }
}
