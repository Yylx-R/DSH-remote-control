package com.dshremote.app.ui

import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.Image
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.gestures.detectTransformGestures
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Close
import androidx.compose.material.icons.filled.Fullscreen
import androidx.compose.material.icons.filled.Refresh
import androidx.compose.material.icons.filled.ScreenRotation
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.asImageBitmap
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.dshremote.app.AppViewModel
import com.dshremote.app.UiState
import kotlinx.coroutines.delay

@Composable
fun ScreenViewScreen(vm: AppViewModel, st: UiState) {
    // 自动刷新
    LaunchedEffect(st.shotAuto) {
        while (st.shotAuto) {
            delay(2000)
            if (st.shotAuto) vm.captureScreen()
        }
    }

    // 这一页是「看屏幕」，始终用深色，避免浅色主题下黑底黑字
    com.dshremote.app.ui.theme.DshRemoteTheme(darkTheme = true) {
    Column(
        Modifier
            .fillMaxSize()
            .background(Color(0xFF0B0B0D)),
    ) {
        if (!st.shotFullscreen) {
            DshTopBar(
                title = "电脑画面",
                subtitle = st.shotMeta.ifBlank { "点刷新或打开自动刷新" },
                onBack = vm::back,
                actions = {
                    if (st.shotLoading) {
                        CircularProgressIndicator(
                            modifier = Modifier.size(16.dp).padding(end = 12.dp),
                            strokeWidth = 2.dp,
                            color = MaterialTheme.colorScheme.primary,
                        )
                    } else {
                        IconButton(onClick = { vm.captureScreen() }) {
                            Icon(
                                Icons.Filled.Refresh,
                                contentDescription = "刷新",
                                tint = MaterialTheme.colorScheme.onBackground,
                            )
                        }
                    }
                },
            )
            Toolbar(vm, st)
            ControlBar(vm)
        }

        Box(Modifier.weight(1f).fillMaxWidth()) {
            val bmp = st.shot
            if (bmp == null) {
                Box(Modifier.fillMaxSize(), contentAlignment = Alignment.Center) {
                    Text(
                        if (st.shotLoading) "正在截屏…" else "还没有画面，点右上角刷新",
                        color = Color(0xFF9AA0A6),
                        fontSize = 14.sp,
                    )
                }
            } else {
                var scale by remember { mutableStateOf(1f) }
                var offsetX by remember { mutableStateOf(0f) }
                var offsetY by remember { mutableStateOf(0f) }
                LaunchedEffect(st.shotZoom) { scale = st.shotZoom.toFloat() }
                Box(
                    Modifier
                        .fillMaxSize()
                        .pointerInput(Unit) {
                            detectTransformGestures { _, pan, zoom, _ ->
                                scale = (scale * zoom).coerceIn(1f, 4f)
                                offsetX += pan.x
                                offsetY += pan.y
                            }
                        }
                        .clickable { vm.cycleShotZoom() },
                    contentAlignment = Alignment.Center,
                ) {
                    val bmp2 = bmp
                    val fill = if (st.shotLandscape) bmp2.width.toFloat() / bmp2.height.toFloat() else 1f
                    Image(
                        bitmap = bmp2.asImageBitmap(),
                        contentDescription = "电脑画面",
                        contentScale = ContentScale.Fit,
                        modifier = Modifier
                            .fillMaxSize()
                            .graphicsLayer(
                                scaleX = scale * fill,
                                scaleY = scale * fill,
                                translationX = offsetX,
                                translationY = offsetY,
                                rotationZ = if (st.shotLandscape) -90f else 0f,
                            ),
                    )
                }
            }

            if (st.shotFullscreen) {
                Box(
                    Modifier
                        .align(Alignment.TopEnd)
                        .padding(10.dp)
                        .size(40.dp)
                        .clip(RoundedCornerShape(20.dp))
                        .background(Color(0x99000000))
                        .clickable { vm.toggleShotFullscreen() },
                    contentAlignment = Alignment.Center,
                ) {
                    Icon(Icons.Filled.Close, contentDescription = "退出全屏", tint = Color.White)
                }
            }
        }

        if (!st.shotFullscreen) {
            Row(
                Modifier
                    .fillMaxWidth()
                    .navigationBarsPadding()
                    .padding(horizontal = 12.dp, vertical = 8.dp),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                Text(
                    "缩放 ${st.shotZoom}× · 点画面切换",
                    color = Color(0xFF9AA0A6),
                    fontSize = 12.sp,
                )
                Spacer(Modifier.weight(1f))
                if (st.shotLandscape) {
                    Text("横屏", color = Color(0xFF9AA0A6), fontSize = 12.sp)
                }
            }
        }
    }
    }
}

@Composable
private fun Toolbar(vm: AppViewModel, st: UiState) {
    var targetOpen by remember { mutableStateOf(false) }
    var qualityOpen by remember { mutableStateOf(false) }

    Row(
        Modifier
            .fillMaxWidth()
            .padding(horizontal = 10.dp, vertical = 4.dp),
        horizontalArrangement = Arrangement.spacedBy(8.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Box {
            Chip(
                text = when (st.shotTarget) {
                    "secondary" -> "副屏"
                    "all" -> "全部"
                    else -> "主屏"
                },
                onClick = { targetOpen = true },
            )
            DropdownMenu(expanded = targetOpen, onDismissRequest = { targetOpen = false }) {
                listOf("primary" to "只看主屏", "secondary" to "只看副屏", "all" to "全部屏幕").forEach { (v, label) ->
                    DropdownMenuItem(
                        text = { Text(label) },
                        onClick = { targetOpen = false; vm.setShotTarget(v) },
                    )
                }
            }
        }
        Box {
            Chip(text = st.shotQuality, onClick = { qualityOpen = true })
            DropdownMenu(expanded = qualityOpen, onDismissRequest = { qualityOpen = false }) {
                listOf("清晰", "原画", "流畅").forEach { q ->
                    DropdownMenuItem(
                        text = { Text(q) },
                        onClick = { qualityOpen = false; vm.setShotQuality(q) },
                    )
                }
            }
        }
        IconButton(onClick = vm::toggleShotLandscape, modifier = Modifier.size(34.dp)) {
            Icon(
                Icons.Filled.ScreenRotation,
                contentDescription = "横竖屏",
                tint = if (st.shotLandscape) MaterialTheme.colorScheme.primary else Color(0xFF9AA0A6),
                modifier = Modifier.size(19.dp),
            )
        }
        IconButton(onClick = vm::toggleShotAuto, modifier = Modifier.size(34.dp)) {
            Text(
                "自动",
                fontSize = 12.sp,
                fontWeight = FontWeight.Medium,
                color = if (st.shotAuto) MaterialTheme.colorScheme.primary else Color(0xFF9AA0A6),
            )
        }
        Spacer(Modifier.weight(1f))
        IconButton(onClick = vm::toggleShotFullscreen, modifier = Modifier.size(34.dp)) {
            Icon(
                Icons.Filled.Fullscreen,
                contentDescription = "全屏",
                tint = Color(0xFF9AA0A6),
                modifier = Modifier.size(19.dp),
            )
        }
    }
}

@Composable
private fun ControlBar(vm: AppViewModel) {
    Row(
        Modifier
            .fillMaxWidth()
            .horizontalScroll(rememberScrollState())
            .padding(horizontal = 10.dp, vertical = 2.dp),
        horizontalArrangement = Arrangement.spacedBy(6.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        CtrlButton("切换窗口") { vm.screenControl("alt_tab") }
        CtrlButton("反向切换") { vm.screenControl("alt_tab_back") }
        CtrlButton("开始菜单") { vm.screenControl("win") }
        CtrlButton("显示桌面") { vm.screenControl("win_d") }
        CtrlButton("Esc") { vm.screenControl("esc") }
        CtrlButton("回车") { vm.screenControl("enter") }
        CtrlButton("关闭窗口") { vm.screenControl("alt_f4") }
        CtrlButton("向下") { vm.screenControl("down") }
        CtrlButton("向上") { vm.screenControl("up") }
    }
}

@Composable
private fun CtrlButton(text: String, onClick: () -> Unit) {
    Surface(
        color = MaterialTheme.colorScheme.surfaceVariant.copy(alpha = 0.4f),
        shape = RoundedCornerShape(9.dp),
        modifier = Modifier
            .clip(RoundedCornerShape(9.dp))
            .clickable(onClick = onClick),
    ) {
        Text(
            text,
            modifier = Modifier.padding(horizontal = 10.dp, vertical = 6.dp),
            fontSize = 12.sp,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
        )
    }
}

@Composable
private fun Chip(text: String, onClick: () -> Unit) {
    Surface(
        color = Color(0xFF1C1C1F),
        shape = RoundedCornerShape(9.dp),
        modifier = Modifier
            .clip(RoundedCornerShape(9.dp))
            .clickable(onClick = onClick),
    ) {
        Row(
            Modifier.padding(horizontal = 10.dp, vertical = 6.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Text(text, fontSize = 12.sp, color = Color(0xFFDADCE0))
            Spacer(Modifier.width(3.dp))
            Text("▾", fontSize = 10.sp, color = Color(0xFF9AA0A6))
        }
    }
}
