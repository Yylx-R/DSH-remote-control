package com.dshremote.app.ui

import android.content.Context
import android.net.Uri
import android.widget.Toast
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.animation.AnimatedVisibility
import androidx.compose.animation.core.RepeatMode
import androidx.compose.animation.core.animateFloat
import androidx.compose.animation.core.infiniteRepeatable
import androidx.compose.animation.core.rememberInfiniteTransition
import androidx.compose.animation.core.tween
import androidx.compose.animation.expandVertically
import androidx.compose.animation.shrinkVertically
import androidx.compose.foundation.Image
import androidx.compose.foundation.ExperimentalFoundationApi
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.combinedClickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.layout.WindowInsetsSides
import androidx.compose.foundation.layout.ime
import androidx.compose.foundation.layout.navigationBars
import androidx.compose.foundation.layout.only
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.union
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.windowInsetsPadding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.LazyRow
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.lazy.itemsIndexed
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.BasicTextField
import androidx.compose.foundation.text.KeyboardActions
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.text.selection.SelectionContainer
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.Send
import androidx.compose.material.icons.filled.Add
import androidx.compose.material.icons.filled.Close
import androidx.compose.material.icons.outlined.AttachFile
import androidx.compose.material.icons.outlined.ChatBubbleOutline
import androidx.compose.material.icons.outlined.PhotoCamera
import androidx.compose.material.icons.outlined.PhotoLibrary
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.draw.rotate
import androidx.compose.ui.focus.onFocusChanged
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.graphics.asImageBitmap
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalClipboardManager
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.platform.LocalFocusManager
import androidx.compose.ui.platform.LocalSoftwareKeyboardController
import androidx.compose.ui.text.AnnotatedString
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.core.content.FileProvider
import com.dshremote.app.AppViewModel
import com.dshremote.app.UiState
import com.dshremote.app.data.ChatMessage
import com.dshremote.app.data.StagedAttachment
import java.io.File

@Composable
fun ChatScreen(vm: AppViewModel, st: UiState) {
    val listState = rememberLazyListState()
    var input by rememberSaveable { mutableStateOf("") }
    var panel by remember { mutableStateOf(false) }
    var cameraOpen by remember { mutableStateOf(false) }
    val ctx = LocalContext.current
    val clipboard = LocalClipboardManager.current
    val copyText: (String) -> Unit = { s ->
        if (s.isNotBlank()) {
            clipboard.setText(AnnotatedString(s))
            Toast.makeText(ctx, "已复制", Toast.LENGTH_SHORT).show()
        }
    }
    val keyboard = LocalSoftwareKeyboardController.current
    val focus = LocalFocusManager.current
    val last = st.messages.lastOrNull()
    val lastLen = last?.text?.length ?: 0

    val gallery = rememberLauncherForActivityResult(ActivityResultContracts.GetContent()) { u ->
        u?.let { vm.addAttachment(it) }
    }
    val files = rememberLauncherForActivityResult(ActivityResultContracts.OpenDocument()) { u ->
        u?.let { vm.addAttachment(it) }
    }

    // 新消息 / 流式增长：跟着最新一条走
    LaunchedEffect(st.messages.size, lastLen) {
        if (st.messages.isNotEmpty()) listState.scrollToItem(st.messages.lastIndex)
    }

    // 键盘弹出：把最后一条顶到键盘上方（微信的行为）；用户正翻历史时不打扰
    val imeBottom = WindowInsets.ime.getBottom(LocalDensity.current)
    LaunchedEffect(imeBottom > 0) {
        if (imeBottom > 0 && st.messages.isNotEmpty()) {
            val lastVisible = listState.layoutInfo.visibleItemsInfo.lastOrNull()?.index ?: -1
            if (lastVisible >= st.messages.lastIndex - 2) {
                listState.animateScrollToItem(st.messages.lastIndex)
            }
        }
    }

    Box(Modifier.fillMaxSize()) {
        Column(
            Modifier
                .fillMaxSize()
                .windowInsetsPadding(
                    WindowInsets.navigationBars.union(WindowInsets.ime).only(WindowInsetsSides.Bottom),
                ),
        ) {
        DshTopBar(
            title = st.currentSession?.title?.ifBlank { "会话" } ?: "会话",
            subtitle = st.currentSession?.cwd,
            onBack = vm::back,
            actions = {
                if (st.streaming) {
                    CircularProgressIndicator(
                        modifier = Modifier.size(16.dp).padding(end = 14.dp),
                        strokeWidth = 2.dp,
                        color = MaterialTheme.colorScheme.primary,
                    )
                } else {
                    Box(Modifier.padding(end = 16.dp)) { Dot(st.connected) }
                }
            },
        )

        if (st.agentRunning) {
            Row(
                Modifier
                    .fillMaxWidth()
                    .padding(horizontal = 14.dp, vertical = 6.dp),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                CircularProgressIndicator(
                    modifier = Modifier.size(12.dp),
                    strokeWidth = 1.5.dp,
                    color = MaterialTheme.colorScheme.primary,
                )
                Spacer(Modifier.width(8.dp))
                Text(
                    "电脑正在执行…",
                    fontSize = 12.sp,
                    color = MaterialTheme.colorScheme.primary,
                )
            }
        }

        Box(Modifier.weight(1f)) {
            LazyColumn(
                state = listState,
                modifier = Modifier.fillMaxSize(),
                contentPadding = PaddingValues(horizontal = 14.dp, vertical = 12.dp),
                verticalArrangement = Arrangement.spacedBy(10.dp),
            ) {
                if (st.messages.isEmpty()) {
                    item {
                        EmptyHint(
                            "还没有消息",
                            "在下面输入框里说一句话，\nDSH 会在电脑上执行，并把过程实时传回来。",
                        )
                    }
                }
                itemsIndexed(st.messages) { index, m ->
                    MessageRow(m, streaming = st.streaming && index == st.messages.lastIndex, onCopy = copyText)
                }
            }
        }

        if (st.staged.isNotEmpty()) {
            StagedRow(st.staged, onRemove = vm::removeStaged)
        }

        InputBar(
            st = st,
            text = input,
            onTextChange = { input = it },
            panelOpen = panel,
            onTogglePanel = {
                panel = !panel
                if (panel) {
                    focus.clearFocus()
                    keyboard?.hide()
                }
            },
            onFocusInput = { panel = false },
            onSend = {
                val t = input.trim()
                if (t.isNotEmpty() || st.staged.isNotEmpty()) {
                    input = ""
                    panel = false
                    vm.send(t)
                }
            },
            onStop = vm::stopRun,
            onRefresh = { st.currentSession?.let { vm.openSession(it) } },
            onNewSession = {
                panel = false
                vm.newSession()
            },
            onGallery = { panel = false; gallery.launch("image/*") },
            onCamera = {
                panel = false
                cameraOpen = true
            },
            onFile = { panel = false; files.launch(arrayOf("*/*")) },
            onOpenFiles = {
                panel = false
                vm.openFiles()
            },
        )
        }

        if (cameraOpen) {
            CameraCaptureOverlay(
                onClose = { cameraOpen = false },
                onCaptured = { uri ->
                    cameraOpen = false
                    vm.addAttachment(uri)
                },
            )
        }
    }
}

@Composable
private fun StagedRow(staged: List<StagedAttachment>, onRemove: (String) -> Unit) {
    Surface(color = MaterialTheme.colorScheme.background) {
        Column {
            HorizontalDivider(color = MaterialTheme.colorScheme.outlineVariant.copy(alpha = 0.5f))
            LazyRow(
                contentPadding = PaddingValues(horizontal = 12.dp, vertical = 8.dp),
                horizontalArrangement = Arrangement.spacedBy(8.dp),
            ) {
                items(staged, key = { it.id }) { a ->
                    Box(Modifier.size(62.dp)) {
                        Box(
                            Modifier
                                .size(62.dp)
                                .clip(RoundedCornerShape(12.dp))
                                .background(MaterialTheme.colorScheme.surfaceVariant),
                            contentAlignment = Alignment.Center,
                        ) {
                            if (a.thumb != null) {
                                Image(
                                    bitmap = a.thumb.asImageBitmap(),
                                    contentDescription = a.name,
                                    contentScale = ContentScale.Crop,
                                    modifier = Modifier.fillMaxSize(),
                                )
                            } else {
                                Text(
                                    a.name.substringAfterLast('.').uppercase().take(4).ifBlank { "FILE" },
                                    fontSize = 11.sp,
                                    fontWeight = FontWeight.Medium,
                                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                                )
                            }
                        }
                        Box(
                            Modifier
                                .align(Alignment.TopEnd)
                                .size(18.dp)
                                .clip(CircleShape)
                                .background(Color(0xCC000000))
                                .clickable { onRemove(a.id) },
                            contentAlignment = Alignment.Center,
                        ) {
                            Icon(
                                Icons.Filled.Close,
                                contentDescription = "移除",
                                tint = Color.White,
                                modifier = Modifier.size(11.dp),
                            )
                        }
                    }
                }
            }
        }
    }
}

@OptIn(ExperimentalFoundationApi::class)
@Composable
private fun MessageRow(m: ChatMessage, streaming: Boolean, onCopy: (String) -> Unit) {
    // 长按气泡：整条复制（文字区域内的长按仍由 SelectionContainer 负责选择）
    val longPressCopy = Modifier.combinedClickable(
        onClick = {},
        onLongClick = { onCopy(m.text) },
    )
    when (m.role) {
        "user" -> Row(
            modifier = Modifier.fillMaxWidth(),
            horizontalArrangement = Arrangement.End,
        ) {
            Surface(
                color = MaterialTheme.colorScheme.primary,
                shape = RoundedCornerShape(topStart = 16.dp, topEnd = 16.dp, bottomStart = 16.dp, bottomEnd = 4.dp),
                modifier = Modifier.widthIn160().then(longPressCopy),
            ) {
                Column(Modifier.padding(horizontal = 14.dp, vertical = 10.dp)) {
                    if (m.attachNames.isNotEmpty()) {
                        Row(verticalAlignment = Alignment.CenterVertically) {
                            Icon(
                                Icons.Outlined.AttachFile,
                                contentDescription = null,
                                tint = Color.White.copy(alpha = 0.85f),
                                modifier = Modifier.size(13.dp),
                            )
                            Spacer(Modifier.width(4.dp))
                            Text(
                                m.attachNames.joinToString("、"),
                                style = MaterialTheme.typography.labelMedium,
                                color = Color.White.copy(alpha = 0.85f),
                                maxLines = 2,
                            )
                        }
                        if (m.text.isNotBlank()) Spacer(Modifier.size(4.dp))
                    }
                    if (m.text.isNotBlank()) {
                        SelectionContainer {
                            Text(
                                m.text,
                                style = MaterialTheme.typography.bodyLarge,
                                color = Color.White,
                            )
                        }
                    }
                }
            }
        }

        "assistant" -> Row(Modifier.fillMaxWidth()) {
            Surface(
                color = MaterialTheme.colorScheme.surface,
                shape = RoundedCornerShape(topStart = 4.dp, topEnd = 16.dp, bottomStart = 16.dp, bottomEnd = 16.dp),
                modifier = Modifier.widthIn160().then(longPressCopy),
            ) {
                Row(
                    Modifier.padding(horizontal = 14.dp, vertical = 10.dp),
                    verticalAlignment = Alignment.Bottom,
                ) {
                    val scheme = MaterialTheme.colorScheme
                    SelectionContainer {
                        Text(
                            if (m.text.isEmpty()) AnnotatedStringOf("…") else markdownAnnotated(
                                m.text,
                                scheme.onSurface,
                                scheme.onSurfaceVariant,
                                scheme.surfaceVariant,
                            ),
                            style = MaterialTheme.typography.bodyLarge,
                        )
                    }
                    if (streaming || m.streaming) Cursor()
                }
            }
        }

        else -> Row(Modifier.fillMaxWidth()) {
            Surface(
                color = MaterialTheme.colorScheme.surfaceVariant.copy(alpha = 0.7f),
                shape = RoundedCornerShape(8.dp),
                modifier = longPressCopy,
            ) {
                Text(
                    "🛠 调用工具 「${m.name.orEmpty().ifBlank { "tool" }}」",
                    modifier = Modifier.padding(horizontal = 10.dp, vertical = 5.dp),
                    style = MaterialTheme.typography.labelMedium,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
            }
        }
    }
}

private fun AnnotatedStringOf(s: String) = androidx.compose.ui.text.AnnotatedString(s)

private fun Modifier.widthIn160(): Modifier = this.then(Modifier.fillMaxWidth(0.82f))

@Composable
private fun Cursor() {
    val transition = rememberInfiniteTransition(label = "cursor")
    val alpha by transition.animateFloat(
        initialValue = 1f,
        targetValue = 0.15f,
        animationSpec = infiniteRepeatable(tween(520), RepeatMode.Reverse),
        label = "alpha",
    )
    Text("▍", color = MaterialTheme.colorScheme.primary.copy(alpha = alpha), fontSize = 16.sp)
}

@Composable
private fun InputBar(
    st: UiState,
    text: String,
    onTextChange: (String) -> Unit,
    panelOpen: Boolean,
    onTogglePanel: () -> Unit,
    onFocusInput: () -> Unit,
    onSend: () -> Unit,
    onStop: () -> Unit,
    onRefresh: () -> Unit,
    onNewSession: () -> Unit,
    onGallery: () -> Unit,
    onCamera: () -> Unit,
    onFile: () -> Unit,
    onOpenFiles: () -> Unit,
) {
    val canSend = text.isNotBlank() || st.staged.isNotEmpty()
    Surface(color = MaterialTheme.colorScheme.background) {
        Column {
            HorizontalDivider(color = MaterialTheme.colorScheme.outlineVariant)
            Row(
                modifier = Modifier
                    .fillMaxWidth()
                    .padding(horizontal = 10.dp, vertical = 8.dp),
                verticalAlignment = Alignment.Bottom,
            ) {
                ActionCircle(
                    background = MaterialTheme.colorScheme.surfaceVariant,
                    onClick = onTogglePanel,
                ) {
                    Icon(
                        Icons.Filled.Add,
                        contentDescription = "更多",
                        tint = MaterialTheme.colorScheme.onSurfaceVariant,
                        modifier = Modifier
                            .size(21.dp)
                            .rotate(if (panelOpen) 45f else 0f),
                    )
                }
                Spacer(Modifier.width(9.dp))
                Surface(
                    modifier = Modifier.weight(1f),
                    color = MaterialTheme.colorScheme.surfaceVariant,
                    shape = RoundedCornerShape(22.dp),
                ) {
                    BasicTextField(
                        value = text,
                        onValueChange = onTextChange,
                        maxLines = 5,
                        keyboardOptions = KeyboardOptions(imeAction = ImeAction.Send),
                        keyboardActions = KeyboardActions(onSend = { onSend() }),
                        textStyle = MaterialTheme.typography.bodyLarge.copy(color = MaterialTheme.colorScheme.onSurface),
                        cursorBrush = SolidColor(MaterialTheme.colorScheme.primary),
                        modifier = Modifier
                            .fillMaxWidth()
                            .heightIn(min = 42.dp)
                            .onFocusChanged { if (it.isFocused) onFocusInput() }
                            .padding(horizontal = 15.dp, vertical = 10.dp),
                        decorationBox = { inner ->
                            Box {
                                if (text.isEmpty()) {
                                    Text(
                                        "发消息…",
                                        style = MaterialTheme.typography.bodyLarge,
                                        color = MaterialTheme.colorScheme.onSurfaceVariant.copy(alpha = 0.75f),
                                    )
                                }
                                inner()
                            }
                        },
                    )
                }
                if (canSend || st.streaming) {
                    Spacer(Modifier.width(9.dp))
                    if (canSend) {
                        ActionCircle(
                            background = MaterialTheme.colorScheme.primary,
                            onClick = onSend,
                        ) {
                            Icon(
                                Icons.AutoMirrored.Filled.Send,
                                contentDescription = "发送",
                                tint = Color.White,
                                modifier = Modifier.size(19.dp),
                            )
                        }
                    } else {
                        ActionCircle(
                            background = MaterialTheme.colorScheme.surfaceVariant,
                            onClick = onStop,
                        ) {
                            Box(
                                Modifier
                                    .size(13.dp)
                                    .clip(RoundedCornerShape(3.dp))
                                    .background(MaterialTheme.colorScheme.onSurface)
                            )
                        }
                    }
                }
            }

            AnimatedVisibility(
                visible = panelOpen,
                enter = expandVertically(),
                exit = shrinkVertically(),
            ) {
                Column(Modifier.padding(start = 10.dp, end = 10.dp, bottom = 12.dp)) {
                    Row(
                        Modifier.fillMaxWidth(),
                        horizontalArrangement = Arrangement.SpaceEvenly,
                    ) {
                        PanelAction("相册", Icons.Outlined.PhotoLibrary, onGallery)
                        PanelAction("拍照", Icons.Outlined.PhotoCamera, onCamera)
                        PanelAction("文件", Icons.Outlined.AttachFile, onFile)
                        PanelAction("新会话", Icons.Outlined.ChatBubbleOutline, onNewSession)
                    }
                    Spacer(Modifier.size(6.dp))
                    Row(
                        Modifier.fillMaxWidth(),
                        horizontalArrangement = Arrangement.spacedBy(8.dp),
                    ) {
                        QuickChip("刷新会话") { onRefresh() }
                        QuickChip("交付物") { onOpenFiles() }
                        if (st.streaming) QuickChip("停止任务", danger = true) { onStop() }
                    }
                }
            }
        }
    }
}

@Composable
private fun PanelAction(label: String, icon: ImageVector, onClick: () -> Unit) {
    Column(
        horizontalAlignment = Alignment.CenterHorizontally,
        modifier = Modifier
            .clip(RoundedCornerShape(14.dp))
            .clickable(onClick = onClick)
            .padding(horizontal = 14.dp, vertical = 8.dp),
    ) {
        Box(
            Modifier
                .size(52.dp)
                .clip(RoundedCornerShape(16.dp))
                .background(MaterialTheme.colorScheme.surfaceVariant),
            contentAlignment = Alignment.Center,
        ) {
            Icon(
                icon,
                contentDescription = label,
                tint = MaterialTheme.colorScheme.onSurface,
                modifier = Modifier.size(23.dp),
            )
        }
        Spacer(Modifier.size(6.dp))
        Text(
            label,
            fontSize = 12.sp,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
        )
    }
}

@Composable
private fun ActionCircle(background: Color, onClick: () -> Unit, content: @Composable () -> Unit) {
    Box(
        modifier = Modifier
            .size(42.dp)
            .clip(CircleShape)
            .background(background)
            .clickable(onClick = onClick),
        contentAlignment = Alignment.Center,
    ) { content() }
}

@Composable
private fun QuickChip(label: String, danger: Boolean = false, onClick: () -> Unit) {
    Surface(
        color = MaterialTheme.colorScheme.surfaceVariant.copy(alpha = 0.7f),
        shape = RoundedCornerShape(999.dp),
        modifier = Modifier.clip(RoundedCornerShape(999.dp)).clickable(onClick = onClick),
    ) {
        Row(Modifier.padding(horizontal = 14.dp, vertical = 8.dp), verticalAlignment = Alignment.CenterVertically) {
            if (danger) {
                Icon(
                    Icons.Filled.Close,
                    contentDescription = null,
                    tint = MaterialTheme.colorScheme.error,
                    modifier = Modifier.size(14.dp),
                )
                Spacer(Modifier.width(4.dp))
            }
            Text(
                label,
                fontSize = 13.sp,
                color = if (danger) MaterialTheme.colorScheme.error else MaterialTheme.colorScheme.onSurface,
                fontWeight = FontWeight.Medium,
            )
        }
    }
}
