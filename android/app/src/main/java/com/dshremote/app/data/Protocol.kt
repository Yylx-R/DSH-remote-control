package com.dshremote.app.data

import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.put

val J: Json = Json {
    ignoreUnknownKeys = true
    isLenient = true
    explicitNulls = false
    encodeDefaults = true
}

fun JsonObject.str(key: String): String? =
    this[key]?.takeIf { it !is JsonNull }?.jsonPrimitive?.contentOrNull

fun JsonObject.bool(key: String): Boolean? =
    this[key]?.takeIf { it !is JsonNull }?.jsonPrimitive?.contentOrNull?.toBooleanStrictOrNull()

fun JsonObject.long(key: String): Long? =
    this[key]?.takeIf { it !is JsonNull }?.jsonPrimitive?.contentOrNull?.toLongOrNull()

fun JsonObject.obj(key: String): JsonObject? =
    this[key]?.takeIf { it is JsonObject }?.jsonObject

fun JsonObject.arr(key: String): JsonArray? =
    this[key]?.takeIf { it is JsonArray } as? JsonArray

fun JsonObject.list(key: String): List<JsonObject> =
    arr(key)?.mapNotNull { it as? JsonObject } ?: emptyList()

fun JsonArray?.asObjects(): List<JsonObject> =
    this?.mapNotNull { it as? JsonObject } ?: emptyList()

fun buildJson(vararg pairs: Pair<String, Any?>): JsonObject = buildJsonObject {
    for ((k, v) in pairs) {
        when (v) {
            null -> put(k, JsonNull)
            is Boolean -> put(k, v)
            is Int -> put(k, v)
            is Long -> put(k, v)
            is Double -> put(k, v)
            is String -> put(k, v)
            is JsonElement -> put(k, v)
            else -> put(k, v.toString())
        }
    }
}

data class DeviceInfo(
    val id: String,
    val kind: String,
    val name: String,
    val platform: String,
    val online: Boolean,
    val lastSeenAt: Long,
)

data class PairInfo(
    val pairId: String,
    val peerId: String,
    val peerKind: String,
    val peerName: String,
    val peerPlatform: String,
    val peerOnline: Boolean,
)

data class SessionInfo(
    val sessionId: String,
    val title: String,
    val running: Boolean,
    val blank: Boolean,
    val cwd: String?,
    val updatedAt: Long,
)

data class ChatMessage(
    val role: String,
    val text: String,
    val name: String? = null,
    val streaming: Boolean = false,
    val attachNames: List<String> = emptyList(),
)

/** 待发送的附件（已读进内存，发送时再上传到中转服务器）。 */
class StagedAttachment(
    val id: String,
    val name: String,
    val mime: String,
    val bytes: ByteArray,
    val thumb: android.graphics.Bitmap? = null,
)

fun parseDevice(o: JsonObject): DeviceInfo = DeviceInfo(
    id = o.str("id").orEmpty(),
    kind = o.str("kind").orEmpty(),
    name = o.str("name").orEmpty(),
    platform = o.str("platform").orEmpty(),
    online = o.bool("online") ?: false,
    lastSeenAt = o.long("lastSeenAt") ?: 0L,
)

fun parsePair(o: JsonObject): PairInfo {
    // /api/me 返回 {pairId, pairedAt, peer:{...}}；WS welcome 直接返回设备行 {id, kind, name, platform}
    val peer = o.obj("peer")
    if (peer != null) {
        return PairInfo(
            pairId = o.str("pairId").orEmpty(),
            peerId = peer.str("id").orEmpty(),
            peerKind = peer.str("kind").orEmpty(),
            peerName = peer.str("name").orEmpty(),
            peerPlatform = peer.str("platform").orEmpty(),
            peerOnline = peer.bool("online") ?: false,
        )
    }
    val id = o.str("id").orEmpty()
    return PairInfo(
        pairId = "dev:$id",
        peerId = id,
        peerKind = o.str("kind").orEmpty(),
        peerName = o.str("name").orEmpty(),
        peerPlatform = o.str("platform").orEmpty(),
        peerOnline = o.bool("online") ?: false,
    )
}

fun parseSession(o: JsonObject): SessionInfo = SessionInfo(
    sessionId = o.str("sessionId").orEmpty(),
    title = o.str("title") ?: "未命名会话",
    running = o.bool("running") ?: false,
    blank = o.bool("blank") ?: false,
    cwd = o.str("cwd"),
    updatedAt = o.long("updatedAt") ?: 0L,
)

// 电脑端已经归一化：{ role, text, name? }
fun parseRecord(o: JsonObject): ChatMessage? {
    val role = o.str("role") ?: return null
    if (role != "user" && role != "assistant") return null
    val text = stripAttachmentLines(o.str("text").orEmpty())
    if (role == "user" && isInjected(text)) return null
    return ChatMessage(role = role, text = text, name = o.str("name"))
}

/** 去掉电脑端为附件追加的「[手机上传附件] 名 → 路径」行。 */
fun stripAttachmentLines(text: String): String =
    text.split('\n').filterNot { it.trim().startsWith("[手机上传附件]") }.joinToString("\n").trim()

private val INJECTED = listOf(
    Regex("^Current runtime context\\."),
    Regex("^<system-reminder>"),
    Regex("^Time sampled (while|at) preparing"),
    Regex("^Current DSH file policy"),
    Regex("^Approval policy: "),
)

fun isInjected(text: String): Boolean {
    val t = text.trim()
    if (t.isEmpty()) return false
    return INJECTED.any { it.containsMatchIn(t) }
}
