package com.dshremote.app

import android.app.Application
import android.content.Intent
import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.net.Uri
import android.os.Build
import androidx.lifecycle.AndroidViewModel
import androidx.lifecycle.viewModelScope
import com.dshremote.app.data.ApiException
import com.dshremote.app.data.AppUpdate
import com.dshremote.app.data.ChatMessage
import com.dshremote.app.data.DeviceInfo
import com.dshremote.app.data.HttpApi
import com.dshremote.app.data.J
import com.dshremote.app.data.PairInfo
import com.dshremote.app.data.RelaySocket
import com.dshremote.app.data.SessionInfo
import com.dshremote.app.data.StagedAttachment
import com.dshremote.app.data.UpdateChecker
import com.dshremote.app.data.asObjects
import com.dshremote.app.data.arr
import com.dshremote.app.data.bool
import com.dshremote.app.data.buildJson
import com.dshremote.app.data.long
import com.dshremote.app.data.obj
import com.dshremote.app.data.parseDevice
import com.dshremote.app.data.parsePair
import com.dshremote.app.data.parseRecord
import com.dshremote.app.data.parseSession
import com.dshremote.app.data.str
import com.dshremote.app.data.list
import kotlinx.coroutines.Job
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch
import kotlinx.coroutines.withTimeoutOrNull
import java.io.File
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonArray

const val DEFAULT_SERVER = ""

enum class Screen { Login, Devices, Sessions, Chat, Settings, ScreenView }

data class UiState(
    val screen: Screen = Screen.Login,
    val serverUrl: String = DEFAULT_SERVER,
    val handle: String = "",
    val password: String = "",
    val deviceName: String = "",
    val token: String? = null,
    val pairs: List<PairInfo> = emptyList(),
    val devices: List<DeviceInfo> = emptyList(),
    val target: PairInfo? = null,
    val sessions: List<SessionInfo> = emptyList(),
    val currentSession: SessionInfo? = null,
    val messages: List<ChatMessage> = emptyList(),
    val streaming: Boolean = false,
    val connected: Boolean = false,
    val busy: Boolean = false,
    val loginError: String? = null,
    val toast: String? = null,
    val kicked: Boolean = false,
    val pairCode: String = "",
    val pairStatus: String = "",
    val pairing: Boolean = false,
    val refreshingSessions: Boolean = false,
    // 待发送附件
    val staged: List<com.dshremote.app.data.StagedAttachment> = emptyList(),
    // 电脑画面
    val shot: android.graphics.Bitmap? = null,
    val shotMeta: String = "",
    val shotLoading: Boolean = false,
    val shotAuto: Boolean = false,
    val shotLandscape: Boolean = false,
    val shotZoom: Int = 1,
    val shotTarget: String = "primary",
    val shotQuality: String = "清晰",
    val shotFullscreen: Boolean = false,
    val screenReturn: Screen = Screen.Devices,
    // 外观：system / light / dark
    val themeMode: String = "system",
    // 电脑是否正在执行（回合进行中）
    val agentRunning: Boolean = false,
    // 应用版本 / 更新
    val appVersion: String = "",
    val update: AppUpdate? = null,
    val updateChecking: Boolean = false,
    val updateDownloading: Boolean = false,
    val updateStatus: String = "",
    // 交付物：电脑会话目录里的文件
    val filesOpen: Boolean = false,
    val filesLoading: Boolean = false,
    val filesCwd: String = "",
    val files: List<RemoteFile> = emptyList(),
    val filesBusy: String? = null,
)

/** 电脑上可下发的文件 */
data class RemoteFile(
    val path: String,
    val name: String,
    val size: Long,
    val mtime: Long,
)

class AppViewModel(app: Application) : AndroidViewModel(app) {

    private val prefs = app.getSharedPreferences("dsh_remote", android.content.Context.MODE_PRIVATE)
    private val api = HttpApi()

    private val _state = MutableStateFlow(UiState())
    val state: StateFlow<UiState> = _state.asStateFlow()

    private val socket: RelaySocket by lazy {
        RelaySocket(object : RelaySocket.Listener {
            override fun onOpen() {
                _state.update { it.copy(connected = true, kicked = false) }
            }

            override fun onWelcome(pairs: List<JsonObject>, serverTime: Long?) {
                val list = pairs.map(::parsePair)
                _state.update { st ->
                    val target = st.target?.let { t -> list.firstOrNull { it.peerId == t.peerId } }
                        ?: list.firstOrNull { it.peerKind == "desktop" }
                    st.copy(pairs = list, connected = true, target = target)
                }
                _state.value.target?.let { socket.setTarget(it.peerId) }
            }

            override fun onMsg(body: JsonObject) {
                if (body.str("op") == "error") {
                    _state.update { it.copy(toast = "服务器错误：${body.str("message") ?: ""}") }
                }
            }

            override fun onKick(reason: String?) {
                // 被服务器顶掉通常是「同一个设备开了两条连接」，稍等重连即可，不要永久放弃
                _state.update {
                    it.copy(connected = false, toast = "连接被顶替，正在重连…")
                }
                scheduleReconnect()
            }

            override fun onClosed(code: Int, reason: String) {
                _state.update { it.copy(connected = false) }
                scheduleReconnect()
            }

            override fun onFailure(t: Throwable) {
                _state.update { it.copy(connected = false) }
                scheduleReconnect()
            }

            override fun onStream(stream: JsonObject) = handleStream(stream)
        })
    }

    private var reconnectJob: Job? = null
    private var reconnectAttempt = 0

    @Volatile
    private var followSubId: String? = null

    /** 最近一次收到会话事件的时刻（用于「电脑正在执行」提示） */
    @Volatile
    private var lastActivity = 0L

    private fun touchActivity() {
        lastActivity = System.currentTimeMillis()
        if (!_state.value.agentRunning) _state.update { it.copy(agentRunning = true) }
    }

    init {
        val base = prefs.getString("base", null) ?: DEFAULT_SERVER
        val token = prefs.getString("token", null)
        val handle = prefs.getString("handle", "") ?: ""
        val deviceName = prefs.getString("deviceName", android.os.Build.MODEL) ?: android.os.Build.MODEL
        val themeMode = prefs.getString("themeMode", "system") ?: "system"
        _state.update {
            it.copy(
                serverUrl = base, handle = handle, token = token, deviceName = deviceName,
                themeMode = themeMode, appVersion = BuildConfig.VERSION_NAME,
            )
        }
        if (token != null) {
            connectSocket()
            viewModelScope.launch {
                loadMe()
                if (_state.value.screen == Screen.Login) _state.update { it.copy(screen = Screen.Devices) }
            }
            // 启动时静默检查一次更新
            checkUpdate(silent = true)
            // 在线状态轮询：电脑上下线时及时更新「在线/离线」角标
            viewModelScope.launch {
                while (true) {
                    kotlinx.coroutines.delay(10_000)
                    if (_state.value.token != null && _state.value.screen != Screen.Chat) {
                        runCatching { loadMe() }
                    }
                }
            }
        }
        // 「电脑正在执行」提示：3 秒没有新事件就认为这一回合结束了
        viewModelScope.launch {
            while (true) {
                kotlinx.coroutines.delay(1_000)
                val st = _state.value
                if (st.agentRunning && System.currentTimeMillis() - lastActivity > 3_000) {
                    _state.update { it.copy(agentRunning = false) }
                }
            }
        }
    }

    // ---------- 表单 ----------
    fun setServer(v: String) = _state.update { it.copy(serverUrl = v) }
    fun setHandle(v: String) = _state.update { it.copy(handle = v) }
    fun setPassword(v: String) = _state.update { it.copy(password = v) }
    fun setDeviceName(v: String) = _state.update { it.copy(deviceName = v) }
    fun setPairCode(v: String) = _state.update { it.copy(pairCode = v.uppercase()) }
    fun clearToast() = _state.update { it.copy(toast = null) }
    fun clearLoginError() = _state.update { it.copy(loginError = null) }
    fun openSettings() = _state.update { it.copy(screen = Screen.Settings) }

    // ---------- 检查更新 ----------
    fun checkUpdate(silent: Boolean = false) {
        val st = _state.value
        if (st.updateChecking) return
        _state.update {
            it.copy(updateChecking = true, updateStatus = if (silent) it.updateStatus else "正在检查…")
        }
        viewModelScope.launch {
            val res = runCatching { withContext(Dispatchers.IO) { UpdateChecker.fetch(st.serverUrl) } }
            val upd = res.getOrNull()
            val newer = upd != null && upd.versionCode > BuildConfig.VERSION_CODE
            _state.update {
                it.copy(
                    updateChecking = false,
                    update = if (newer) upd else null,
                    updateStatus = when {
                        res.isFailure -> "检查失败：${res.exceptionOrNull()?.message ?: "网络异常"}"
                        upd == null -> "服务器上还没有发布版本"
                        newer -> "发现新版本 ${upd.versionName}"
                        else -> "已是最新版本（${BuildConfig.VERSION_NAME}）"
                    },
                    toast = if (silent && newer) "发现新版本 ${upd.versionName}，可在设置里更新" else it.toast,
                )
            }
        }
    }

    fun downloadUpdate() {
        val st = _state.value
        val upd = st.update ?: return
        if (st.updateDownloading) return
        _state.update { it.copy(updateDownloading = true, updateStatus = "正在下载 ${upd.versionName}…") }
        viewModelScope.launch {
            runCatching {
                withContext(Dispatchers.IO) {
                    UpdateChecker.download(upd, java.io.File(getApplication<Application>().cacheDir, "update"))
                }
            }.onSuccess { file ->
                _state.update { it.copy(updateDownloading = false, updateStatus = "下载完成，准备安装") }
                installApk(file)
            }.onFailure { e ->
                _state.update { it.copy(updateDownloading = false, updateStatus = "下载失败：${e.message}") }
            }
        }
    }

    private fun installApk(file: java.io.File) {
        try {
            val ctx = getApplication<Application>()
            val pm = ctx.packageManager
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O && !pm.canRequestPackageInstalls()) {
                _state.update {
                    it.copy(updateStatus = "需要先允许「安装未知应用」，已打开设置页；允许后回来再点一次安装")
                }
                val open = android.content.Intent(
                    android.provider.Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES,
                    android.net.Uri.parse("package:${ctx.packageName}"),
                ).addFlags(android.content.Intent.FLAG_ACTIVITY_NEW_TASK)
                runCatching { ctx.startActivity(open) }
                return
            }
            val uri = androidx.core.content.FileProvider.getUriForFile(ctx, "${ctx.packageName}.fileprovider", file)
            val intent = android.content.Intent(android.content.Intent.ACTION_VIEW).apply {
                setDataAndType(uri, "application/vnd.android.package-archive")
                addFlags(android.content.Intent.FLAG_GRANT_READ_URI_PERMISSION)
                addFlags(android.content.Intent.FLAG_ACTIVITY_NEW_TASK)
            }
            ctx.startActivity(intent)
        } catch (e: Exception) {
            _state.update { it.copy(updateStatus = "无法启动安装：${e.message}（请允许「安装未知应用」）") }
        }
    }

    // ---------- 登录 ----------
    fun login() {
        val st = _state.value
        if (st.busy) return
        if (st.serverUrl.isBlank()) {
            _state.update { it.copy(loginError = "请填写服务器地址（你自己的中转服务器）") }
            return
        }
        if (st.handle.isBlank() || st.password.isBlank()) {
            _state.update { it.copy(loginError = "请填写账号和密码") }
            return
        }
        if (!st.serverUrl.trim().startsWith("http")) {
            _state.update { it.copy(loginError = "服务器地址要以 http:// 或 https:// 开头") }
            return
        }
        viewModelScope.launch {
            _state.update { it.copy(busy = true, loginError = null) }
            try {
                val res = api.login(
                    st.serverUrl, st.handle.trim(), st.password,
                    st.deviceName.ifBlank { "我的手机" },
                    "android ${Build.VERSION.RELEASE}",
                )
                val token = res.str("token") ?: throw ApiException("登录失败：服务器未返回 token")
                prefs.edit()
                    .putString("base", st.serverUrl.trim().trimEnd('/'))
                    .putString("token", token)
                    .putString("handle", res.obj("user")?.str("handle") ?: st.handle)
                    .apply()
                _state.update {
                    it.copy(token = token, screen = Screen.Devices, busy = false, password = "")
                }
                connectSocket()
                loadMe()
            } catch (e: Exception) {
                _state.update { it.copy(busy = false, loginError = e.message ?: "登录失败") }
            }
        }
    }

    fun logout() {
        prefs.edit().remove("token").remove("handle").apply()
        viewModelScope.launch {
            try {
                ask("sessions.unfollow", buildJson("subId" to (followSubId ?: "")))
            } catch (_: Exception) {
            }
        }
        followSubId = null
        reconnectJob?.cancel()
        socket.close()
        _state.update {
            UiState(serverUrl = it.serverUrl, handle = "", screen = Screen.Login, deviceName = it.deviceName)
        }
    }

    // ---------- 连接 ----------
    private fun connectSocket() {
        val st = _state.value
        if (st.token == null) return
        socket.connect(st.serverUrl, st.token)
        reconnectAttempt = 0
    }

    fun ensureConnected() {
        val st = _state.value
        if (st.token != null && !st.kicked && !st.connected) {
            connectSocket()
            refreshDevices()
        }
    }

    private fun scheduleReconnect() {
        val st = _state.value
        if (st.token == null || st.kicked) return
        reconnectJob?.cancel()
        val delayMs = minOf(15_000L, 1_000L * (1 shl minOf(reconnectAttempt++, 4)))
        reconnectJob = viewModelScope.launch {
            delay(delayMs)
            if (_state.value.token != null && !_state.value.kicked) connectSocket()
        }
    }

    private suspend fun loadMe() {
        val st = _state.value
        val token = st.token ?: return
        try {
            val me = api.me(st.serverUrl, token)
            val devices = me.list("devices").map(::parseDevice)
            val pairs = me.list("pairs").map(::parsePair)
            _state.update { s ->
                val target = s.target?.let { t -> pairs.firstOrNull { it.peerId == t.peerId } }
                    ?: pairs.firstOrNull { it.peerKind == "desktop" }
                s.copy(devices = devices, pairs = pairs, target = target)
            }
            _state.value.target?.let { socket.setTarget(it.peerId) }
        } catch (e: Exception) {
            _state.update { it.copy(toast = e.message ?: "获取账号信息失败") }
        }
    }

    fun refreshDevices() {
        viewModelScope.launch { loadMe() }
    }

    // ---------- 指令 ----------
    private suspend fun ask(
        op: String,
        params: JsonObject = JsonObject(emptyMap()),
        timeoutMs: Long = 60_000,
    ): JsonObject {
        val d = socket.request(op, params)
        val reply = withTimeoutOrNull(timeoutMs) { d.await() }
            ?: throw ApiException("电脑没有响应（超时）")
        if (reply.bool("ok") == true) return reply.obj("data") ?: JsonObject(emptyMap())
        throw ApiException(reply.obj("error")?.str("message") ?: "执行失败")
    }

    // ---------- 设备 / 会话 ----------
    fun selectTarget(p: PairInfo) {
        socket.setTarget(p.peerId)
        _state.update { it.copy(target = p, screen = Screen.Sessions, sessions = emptyList()) }
        refreshSessions()
    }

    fun refreshSessions() {
        if (_state.value.refreshingSessions) return
        viewModelScope.launch {
            _state.update { it.copy(refreshingSessions = true) }
            try {
                // 进会话页时顺带刷新一次配对状态，避免顶栏显示过期的在线状态
                runCatching { loadMe() }
                val res = ask("sessions.list")
                _state.update {
                    val fresh = it.pairs.firstOrNull { p -> p.peerId == it.target?.peerId }
                    val target = if (fresh != null) it.target?.copy(peerOnline = fresh.peerOnline, peerName = fresh.peerName) else it.target
                    it.copy(
                        sessions = res.list("items").map(::parseSession),
                        refreshingSessions = false,
                        target = target,
                    )
                }
            } catch (e: Exception) {
                _state.update { it.copy(refreshingSessions = false, toast = e.message) }
            }
        }
    }

    fun newSession() {
        viewModelScope.launch {
            try {
                val res = ask("sessions.create")
                val id = res.str("sessionId")
                val list = try {
                    ask("sessions.list").list("items").map(::parseSession)
                } catch (_: Exception) {
                    emptyList()
                }
                _state.update { it.copy(sessions = list) }
                val created = list.firstOrNull { it.sessionId == id }
                    ?: SessionInfo(id ?: "", "新会话", running = false, blank = true, cwd = null, updatedAt = System.currentTimeMillis())
                openSession(created)
            } catch (e: Exception) {
                _state.update { it.copy(toast = e.message) }
            }
        }
    }

    fun openSession(s: SessionInfo) {
        viewModelScope.launch {
            unsubscribe()
            _state.update {
                it.copy(
                    screen = Screen.Chat, currentSession = s,
                    messages = emptyList(), streaming = s.running,
                )
            }
            try {
                val snap = ask("sessions.snapshot", buildJson("sessionId" to s.sessionId, "maxMessages" to 60))
                val msgs = snap.list("records").mapNotNull(::parseRecord)
                _state.update { st -> st.copy(messages = mergeSnapshot(st.messages, msgs)) }
            } catch (e: Exception) {
                _state.update { it.copy(toast = "历史消息加载失败：${e.message}") }
            }
            try {
                val sub = ask("sessions.follow", buildJson("sessionId" to s.sessionId))
                followSubId = sub.str("subId")
            } catch (e: Exception) {
                _state.update { it.copy(toast = "订阅会话失败：${e.message}") }
            }
        }
    }

    private fun mergeSnapshot(local: List<ChatMessage>, snap: List<ChatMessage>): List<ChatMessage> {
        // follow 的首帧 snapshot 窗口比 sessions.snapshot 小得多，直接用会把历史冲掉。
        if (snap.size >= local.size) return snap
        val out = local.toMutableList()
        for (m in snap) {
            if (out.takeLast(8).none { it.role == m.role && it.text == m.text }) out.add(m)
        }
        return out
    }

    fun leaveChat() {
        viewModelScope.launch { unsubscribe() }
        _state.update { it.copy(screen = Screen.Sessions, currentSession = null, messages = emptyList(), streaming = false) }
    }

    private suspend fun unsubscribe() {
        val sub = followSubId ?: return
        followSubId = null
        try {
            ask("sessions.unfollow", buildJson("subId" to sub), 10_000)
        } catch (_: Exception) {
        }
    }

    fun send(text: String) {
        val st = _state.value
        val current = st.currentSession
        android.util.Log.d("DshRemote", "send() 被调用：session=${current?.sessionId} target=${st.target?.peerId} text=${text.take(20)}")
        if (current == null) return
        if (st.target == null) {
            _state.update { it.copy(toast = "还没有选择执行电脑，请回到设备页选一台") }
            return
        }
        val t = text.trim()
        val staged = st.staged
        if (t.isEmpty() && staged.isEmpty()) return
        val names = staged.map { it.name }
        _state.update {
            it.copy(
                messages = it.messages + ChatMessage("user", t, attachNames = names),
                streaming = true,
                staged = emptyList(),
            )
        }
        viewModelScope.launch {
            try {
                val token = st.token ?: throw ApiException("未登录")
                val uploaded = staged.map { a ->
                    val r = api.uploadBlob(st.serverUrl, token, a.bytes, a.mime, a.name)
                    val id = r.str("blobId") ?: throw ApiException("上传附件失败：${a.name}")
                    buildJson("blobId" to id, "name" to a.name)
                }
                val res = ask(
                    "sessions.prompt",
                    buildJson(
                        "sessionId" to current.sessionId,
                        "text" to t,
                        "cwd" to (current.cwd ?: ""),
                        "attachments" to JsonArray(uploaded),
                    ),
                    120_000,
                )
                if (res.bool("accepted") == false) throw ApiException("电脑没有接受这条消息")
            } catch (e: Exception) {
                _state.update { it.copy(streaming = false, toast = e.message) }
            }
        }
    }

    // ---------- 附件 ----------
    private var stagedSeq = 0

    fun addAttachment(uri: Uri) {
        val app = getApplication<Application>()
        viewModelScope.launch {
            try {
                val cr = app.contentResolver
                val mime = cr.getType(uri) ?: "application/octet-stream"
                var name = "文件"
                runCatching {
                    cr.query(uri, null, null, null, null)?.use { c ->
                        val i = c.getColumnIndex(android.provider.OpenableColumns.DISPLAY_NAME)
                        if (i >= 0 && c.moveToFirst()) name = c.getString(i) ?: name
                    }
                }
                val bytes = cr.openInputStream(uri)?.use { it.readBytes() }
                    ?: throw ApiException("读取文件失败")
                if (bytes.size > MAX_ATTACH_BYTES) throw ApiException("单个附件不能超过 50MB")
                val thumb = if (mime.startsWith("image/")) decodeThumb(bytes, 220) else null
                _state.update {
                    it.copy(staged = it.staged + StagedAttachment("s${stagedSeq++}", name, mime, bytes, thumb))
                }
            } catch (e: Exception) {
                _state.update { it.copy(toast = e.message ?: "添加附件失败") }
            }
        }
    }

    fun addAttachmentBitmap(bmp: Bitmap) {
        viewModelScope.launch {
            try {
                val out = java.io.ByteArrayOutputStream()
                bmp.compress(Bitmap.CompressFormat.JPEG, 90, out)
                val bytes = out.toByteArray()
                if (bytes.size > MAX_ATTACH_BYTES) throw ApiException("照片太大")
                val name = "拍照_" + java.text.SimpleDateFormat("HHmmss", java.util.Locale.US).format(java.util.Date()) + ".jpg"
                _state.update {
                    it.copy(staged = it.staged + StagedAttachment("s${stagedSeq++}", name, "image/jpeg", bytes, decodeThumb(bytes, 220)))
                }
            } catch (e: Exception) {
                _state.update { it.copy(toast = e.message ?: "添加照片失败") }
            }
        }
    }

    fun removeStaged(id: String) = _state.update { st -> st.copy(staged = st.staged.filterNot { it.id == id }) }

    private fun decodeThumb(bytes: ByteArray, maxSide: Int): Bitmap? = runCatching {
        val opts = BitmapFactory.Options().apply { inJustDecodeBounds = true }
        BitmapFactory.decodeByteArray(bytes, 0, bytes.size, opts)
        var sample = 1
        while (opts.outWidth / sample > maxSide * 2 || opts.outHeight / sample > maxSide * 2) sample *= 2
        BitmapFactory.decodeByteArray(
            bytes, 0, bytes.size,
            BitmapFactory.Options().apply { inSampleSize = sample },
        )
    }.getOrNull()

    // ---------- 电脑画面 ----------
    fun openScreenView() {
        _state.update { it.copy(screenReturn = it.screen, screen = Screen.ScreenView, shot = null) }
        captureScreen()
    }

    fun closeScreenView() = _state.update { it.copy(screen = it.screenReturn, shotFullscreen = false, shotAuto = false) }

    fun captureScreen() {
        val st = _state.value
        if (st.shotLoading) return
        viewModelScope.launch {
            _state.update { it.copy(shotLoading = true) }
            try {
                val token = st.token ?: throw ApiException("未登录")
                val maxWidth = when (st.shotQuality) {
                    "原画" -> 3840
                    "流畅" -> 1280
                    else -> 1920
                }
                val res = ask(
                    "screen.capture",
                    buildJson("maxWidth" to maxWidth, "quality" to 88, "target" to st.shotTarget),
                    60_000,
                )
                val blobId = res.str("blobId") ?: throw ApiException("截图失败")
                val bytes = api.downloadBlob(st.serverUrl, token, blobId)
                val bmp = BitmapFactory.decodeByteArray(bytes, 0, bytes.size)
                    ?: throw ApiException("截图解码失败")
                _state.update {
                    it.copy(
                        shot = bmp,
                        shotLoading = false,
                        shotMeta = "${res.long("width")}×${res.long("height")} · ${bytes.size / 1024}KB",
                    )
                }
            } catch (e: Exception) {
                _state.update { it.copy(shotLoading = false, toast = e.message) }
            }
        }
    }

    fun setShotTarget(v: String) = _state.update { it.copy(shotTarget = v) }
    fun setShotQuality(v: String) = _state.update { it.copy(shotQuality = v) }
    fun toggleShotLandscape() = _state.update { it.copy(shotLandscape = !it.shotLandscape) }
    fun cycleShotZoom() = _state.update { it.copy(shotZoom = if (it.shotZoom >= 3) 1 else it.shotZoom + 1) }
    fun toggleShotAuto() = _state.update { it.copy(shotAuto = !it.shotAuto) }
    fun toggleShotFullscreen() = _state.update { it.copy(shotFullscreen = !it.shotFullscreen) }

    // ── 交付物：浏览并取回电脑会话目录里的文件 ──

    fun openFiles() {
        _state.update { it.copy(filesOpen = true) }
        refreshFiles()
    }

    fun closeFiles() = _state.update { it.copy(filesOpen = false, filesBusy = null) }

    fun refreshFiles() {
        val st = _state.value
        val session = st.currentSession ?: return
        if (st.filesLoading) return
        viewModelScope.launch {
            _state.update { it.copy(filesLoading = true) }
            try {
                val res = ask("files.list", buildJson("sessionId" to session.sessionId), 30_000)
                val list = (res["items"] as? JsonArray)?.mapNotNull { el ->
                    val o = el as? JsonObject ?: return@mapNotNull null
                    RemoteFile(
                        path = o.str("path") ?: return@mapNotNull null,
                        name = o.str("name") ?: "",
                        size = o.long("size") ?: 0L,
                        mtime = o.long("mtime") ?: 0L,
                    )
                } ?: emptyList()
                _state.update { it.copy(files = list, filesLoading = false, filesCwd = res.str("cwd") ?: "") }
            } catch (e: Exception) {
                _state.update { it.copy(filesLoading = false, toast = e.message) }
            }
        }
    }

    fun downloadFile(f: RemoteFile) {
        val st = _state.value
        val session = st.currentSession ?: return
        if (st.filesBusy != null) return
        viewModelScope.launch {
            _state.update { it.copy(filesBusy = f.path) }
            try {
                val token = st.token ?: throw ApiException("未登录")
                val res = ask("files.send", buildJson("sessionId" to session.sessionId, "path" to f.path), 180_000)
                val blobId = res.str("blobId") ?: throw ApiException("取回失败")
                val bytes = api.downloadBlob(st.serverUrl, token, blobId)
                val dir = File(getApplication<Application>().filesDir, "deliveries").apply { mkdirs() }
                val out = File(dir, f.name)
                out.writeBytes(bytes)
                _state.update { it.copy(filesBusy = null, toast = "已保存 ${f.name}（${bytes.size / 1024}KB）") }
                openLocalFile(out, res.str("mime") ?: "application/octet-stream")
            } catch (e: Exception) {
                _state.update { it.copy(filesBusy = null, toast = e.message) }
            }
        }
    }

    private fun openLocalFile(file: File, mime: String) {
        runCatching {
            val ctx = getApplication<Application>()
            val uri = androidx.core.content.FileProvider.getUriForFile(ctx, "${ctx.packageName}.fileprovider", file)
            val intent = Intent(Intent.ACTION_VIEW).apply {
                setDataAndType(uri, mime)
                addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION or Intent.FLAG_ACTIVITY_NEW_TASK)
            }
            ctx.startActivity(intent)
        }.onFailure { e ->
            _state.update { it.copy(toast = "已保存到 ${file.parent}，但没有应用能打开：${e.message}") }
        }
    }

    /** 外观：system / light / dark */
    fun setThemeMode(v: String) {
        val mode = if (v == "light" || v == "dark") v else "system"
        prefs.edit().putString("themeMode", mode).apply()
        _state.update { it.copy(themeMode = mode) }
    }

    /**
     * 远程按键（Alt+Tab、Win、显示桌面等）。切换类动作完成后自动重新截屏，
     * 让用户马上看到操作结果。
     */
    fun screenControl(action: String) {
        viewModelScope.launch {
            try {
                ask("screen.control", buildJson("action" to action), 15_000)
                if (action == "alt_tab" || action == "alt_tab_back" || action == "win_d" || action == "win" || action == "esc") {
                    kotlinx.coroutines.delay(400)
                    captureScreen()
                }
            } catch (e: Exception) {
                _state.update { it.copy(toast = e.message) }
            }
        }
    }

    companion object {
        const val MAX_ATTACH_BYTES = 50 * 1024 * 1024
    }

    fun stopRun() {
        val current = _state.value.currentSession ?: return
        viewModelScope.launch {
            try {
                ask("sessions.cancel", buildJson("sessionId" to current.sessionId), 20_000)
                _state.update { it.copy(toast = "已请求停止") }
            } catch (e: Exception) {
                _state.update { it.copy(toast = e.message) }
            }
        }
    }

    fun back() {
        when (_state.value.screen) {
            Screen.Chat -> leaveChat()
            Screen.Sessions -> _state.update { it.copy(screen = Screen.Devices, target = null) }
            Screen.Settings -> _state.update { it.copy(screen = Screen.Devices) }
            Screen.ScreenView -> closeScreenView()
            else -> Unit
        }
    }

    // ---------- 配对 ----------
    fun claimPair() {
        val st = _state.value
        val code = st.pairCode.trim()
        if (code.length != 8) {
            _state.update { it.copy(pairStatus = "配对码是 8 位") }
            return
        }
        if (st.pairing) return
        val token = st.token ?: return
        viewModelScope.launch {
            _state.update { it.copy(pairing = true, pairStatus = "正在提交配对码…") }
            try {
                val res = api.pairClaim(st.serverUrl, token, code)
                val desktopName = res.obj("desktop")?.str("name") ?: "电脑"
                _state.update { it.copy(pairStatus = "已提交，等待「$desktopName」确认…") }
                var waited = 0
                while (waited < 300_000) {
                    delay(1_500)
                    waited += 1_500
                    val status = try {
                        api.pairStatus(st.serverUrl, token, code)
                    } catch (e: ApiException) {
                        throw e
                    } catch (_: Exception) {
                        continue
                    }
                    when (status.str("state")) {
                        "confirmed" -> {
                            _state.update {
                                it.copy(pairing = false, pairStatus = "配对成功", pairCode = "")
                            }
                            loadMe()
                            _state.update { it.copy(screen = Screen.Devices) }
                            return@launch
                        }
                        "cancelled" -> {
                            _state.update {
                                it.copy(pairing = false, pairStatus = "电脑拒绝了配对请求", pairCode = "")
                            }
                            return@launch
                        }
                        "expired" -> {
                            _state.update {
                                it.copy(pairing = false, pairStatus = "配对码已过期，请在电脑上重新生成", pairCode = "")
                            }
                            return@launch
                        }
                    }
                }
                _state.update { it.copy(pairing = false, pairStatus = "等待超时，请重新生成配对码") }
            } catch (e: Exception) {
                val msg = e.message.orEmpty()
                val text = when {
                    msg.contains("pair/invalid") -> "配对码无效或已过期，请在电脑上重新生成"
                    msg.contains("pair/self") -> "不能配对生成配对码的这台电脑"
                    msg.contains("401") -> "登录已过期，请重新登录"
                    else -> msg.ifBlank { "配对失败" }
                }
                _state.update { it.copy(pairing = false, pairStatus = text, pairCode = "") }
            }
        }
    }

    fun revokeDevice(id: String) {
        val st = _state.value
        val token = st.token ?: return
        viewModelScope.launch {
            try {
                api.revokeDevice(st.serverUrl, token, id)
                _state.update { it.copy(toast = "已撤销该设备") }
                loadMe()
            } catch (e: Exception) {
                _state.update { it.copy(toast = e.message) }
            }
        }
    }

    // ---------- 流 ----------
    private fun handleStream(stream: JsonObject) {
        val subId = stream.str("subId") ?: return
        if (subId != followSubId) return
        touchActivity()
        if (stream.bool("done") == true) {
            _state.update { st ->
                val msgs = st.messages.map { if (it.streaming) it.copy(streaming = false) else it }
                st.copy(streaming = false, messages = msgs)
            }
            return
        }
        stream.str("error")?.let {
            _state.update { st -> st.copy(streaming = false, toast = "会话流出错：$it") }
            return
        }
        val frame = stream.obj("frame") ?: return
        when (frame.str("type")) {
            "snapshot" -> {
                val records = frame.arr("records")?.asObjects() ?: emptyList()
                val msgs = records.mapNotNull(::parseRecord)
                _state.update { st -> st.copy(messages = mergeSnapshot(st.messages, msgs)) }
            }
            "event" -> frame.obj("event")?.let(::handleEvent)
            "assistant-stream" -> {
                val chunk = frame.obj("frame") ?: return
                if (chunk.str("type") == "text-delta") {
                    appendDelta(chunk.str("text").orEmpty())
                }
            }
        }
    }

    private fun handleEvent(ev: JsonObject) {
        val type = ev.str("type") ?: return
        val data = ev.obj("data")
        val message = data?.obj("message") ?: data
        when (type) {
            "user/message" -> {
                val text = contentText(message) ?: return
                if (com.dshremote.app.data.isInjected(text)) return
                _state.update { st ->
                    val last = st.messages.lastOrNull()
                    if (last?.role == "user" && last.text == text) st
                    else st.copy(messages = st.messages + ChatMessage("user", text))
                }
            }
            "assistant/message" -> {
                val text = contentText(message) ?: ""
                _state.update { st ->
                    val msgs = st.messages.toMutableList()
                    val last = msgs.lastOrNull()
                    if (last != null && last.role == "assistant" && last.streaming) {
                        msgs[msgs.lastIndex] = last.copy(text = text.ifBlank { last.text }, streaming = false)
                    } else {
                        msgs.add(ChatMessage("assistant", text, streaming = false))
                    }
                    st.copy(messages = msgs, streaming = false)
                }
            }
            "tool/call" -> {
                // 工具调用不在手机端展开（与 PWA 一致），避免刷屏
            }
        }
    }

    private fun contentText(message: JsonObject?): String? {
        if (message == null) return null
        val content = message["content"] ?: return message.str("text")
        val arr = content as? kotlinx.serialization.json.JsonArray ?: return message.str("text")
        val sb = StringBuilder()
        for (part in arr) {
            val o = part as? JsonObject ?: continue
            if (o.str("type") == "text") sb.append(o.str("text").orEmpty())
        }
        return sb.toString()
    }

    private fun appendDelta(delta: String) {
        if (delta.isEmpty()) return
        _state.update { st ->
            val msgs = st.messages.toMutableList()
            val last = msgs.lastOrNull()
            if (last != null && last.role == "assistant" && last.streaming) {
                msgs[msgs.lastIndex] = last.copy(text = last.text + delta, streaming = true)
            } else {
                msgs.add(ChatMessage("assistant", delta, streaming = true))
            }
            st.copy(messages = msgs, streaming = true)
        }
    }
}
