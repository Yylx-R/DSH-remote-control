package com.dshremote.app.ui

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.lazy.itemsIndexed
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Refresh
import androidx.compose.material.icons.filled.Settings
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.dshremote.app.AppViewModel
import com.dshremote.app.UiState
import com.dshremote.app.data.PairInfo

@Composable
fun DevicesScreen(vm: AppViewModel, st: UiState) {
    var showPair by rememberSaveable { mutableStateOf(false) }

    LaunchedEffect(st.pairStatus) {
        if (st.pairStatus.startsWith("配对成功")) showPair = false
    }

    Column(Modifier.fillMaxSize()) {
        DshTopBar(
            title = "DSH Console",
            subtitle = st.handle.ifBlank { "未登录" } + " · " + if (st.connected) "已连接" else "未连接",
            actions = {
                IconButton(onClick = vm::refreshDevices) {
                    Icon(
                        Icons.Filled.Refresh,
                        contentDescription = "刷新",
                        tint = MaterialTheme.colorScheme.onSurfaceVariant,
                    )
                }
                IconButton(onClick = vm::openSettings) {
                    Icon(
                        Icons.Filled.Settings,
                        contentDescription = "设置",
                        tint = MaterialTheme.colorScheme.onSurfaceVariant,
                    )
                }
            },
        )

        if (!st.connected) {
            Row(
                modifier = Modifier
                    .fillMaxWidth()
                    .background(MaterialTheme.colorScheme.surfaceVariant.copy(alpha = 0.6f))
                    .padding(horizontal = 18.dp, vertical = 8.dp),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                CircularProgressIndicator(
                    modifier = Modifier.size(12.dp),
                    strokeWidth = 1.5.dp,
                    color = MaterialTheme.colorScheme.primary,
                )
                Spacer(Modifier.width(8.dp))
                Text(
                    "正在连接中继服务器…",
                    style = MaterialTheme.typography.labelMedium,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
            }
        }

        LazyColumn(
            modifier = Modifier.weight(1f),
            contentPadding = androidx.compose.foundation.layout.PaddingValues(bottom = 24.dp),
        ) {
            item { SectionLabel("我的电脑") }
            if (st.pairs.none { it.peerKind == "desktop" }) {
                item {
                    EmptyHint(
                        "还没有配对的电脑",
                        "在电脑上打开 DSH Console插件生成 8 位配对码，\n然后在这里输入配对码完成配对。",
                    )
                }
            }
            itemsIndexed(st.pairs.filter { it.peerKind == "desktop" }, key = { _, it -> it.pairId }) { idx, it ->
                Column {
                    DesktopRow(it, onScreen = { vm.openScreenView() }) { vm.selectTarget(it) }
                    if (idx < st.pairs.count { p -> p.peerKind == "desktop" } - 1) {
                        HorizontalDivider(
                            modifier = Modifier.padding(start = 76.dp, end = 20.dp),
                            color = MaterialTheme.colorScheme.outlineVariant.copy(alpha = 0.35f),
                        )
                    }
                }
            }
            item {
                Spacer(Modifier.height(16.dp))
                Box(Modifier.padding(horizontal = 18.dp)) {
                    PairButton { showPair = true }
                }
            }
            if (st.pairs.isNotEmpty()) {
                item { SectionLabel("其他设备") }
                items(st.pairs.filter { it.peerKind != "desktop" }, key = { it.pairId }) {
                    DesktopRow(it, enabled = false) {}
                }
            }
        }
    }

    if (showPair) {
        AlertDialog(
            onDismissRequest = { if (!st.pairing) showPair = false },
            title = { Text("输入配对码") },
            text = {
                Column {
                    Text(
                        "在电脑上生成 8 位配对码，输入后需要在电脑上确认。",
                        style = MaterialTheme.typography.bodyMedium,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                    )
                    Spacer(Modifier.height(14.dp))
                    DshField(
                        value = st.pairCode,
                        onValueChange = vm::setPairCode,
                        label = "配对码",
                        placeholder = "例如 A1B2C3D4",
                        singleLine = true,
                    )
                    if (st.pairStatus.isNotBlank()) {
                        Spacer(Modifier.height(10.dp))
                        Text(
                            st.pairStatus,
                            style = MaterialTheme.typography.bodyMedium,
                            color = if (st.pairStatus.startsWith("配对成功")) Color(0xFF4ADE80)
                            else MaterialTheme.colorScheme.onSurfaceVariant,
                        )
                    }
                }
            },
            confirmButton = {
                TextButton(
                    onClick = { vm.claimPair() },
                    enabled = !st.pairing && st.pairCode.trim().length == 8,
                ) {
                    Text(if (st.pairing) "等待确认…" else "提交配对")
                }
            },
            dismissButton = {
                TextButton(onClick = { showPair = false }, enabled = !st.pairing) { Text("取消") }
            },
        )
    }
}

@Composable
private fun DesktopRow(
    p: PairInfo,
    enabled: Boolean = true,
    onScreen: (() -> Unit)? = null,
    onClick: () -> Unit,
) {
    Surface(
        color = Color.Transparent,
        modifier = Modifier
            .fillMaxWidth()
            .padding(horizontal = 12.dp, vertical = 2.dp)
            .clip(RoundedCornerShape(14.dp))
            .clickable(enabled = enabled, onClick = onClick)
            .padding(horizontal = 10.dp, vertical = 12.dp),
    ) {
        Row(verticalAlignment = Alignment.CenterVertically) {
            Box(
                modifier = Modifier
                    .size(42.dp)
                    .clip(RoundedCornerShape(12.dp))
                    .background(MaterialTheme.colorScheme.surfaceVariant),
                contentAlignment = Alignment.Center,
            ) {
                Text("💻", fontSize = 18.sp)
            }
            Spacer(Modifier.width(12.dp))
            Column(Modifier.weight(1f)) {
                Text(
                    p.peerName.ifBlank { p.peerId },
                    style = MaterialTheme.typography.bodyLarge,
                    fontWeight = FontWeight.Medium,
                    color = if (enabled) MaterialTheme.colorScheme.onBackground
                    else MaterialTheme.colorScheme.onSurfaceVariant,
                )
                Text(
                    p.peerPlatform ?: "desktop",
                    style = MaterialTheme.typography.labelMedium,
                    color = MaterialTheme.colorScheme.outline,
                )
            }
            if (enabled) {
                if (onScreen != null) {
                    IconButton(onClick = onScreen, modifier = Modifier.size(34.dp)) {
                        Text("🖥", fontSize = 15.sp)
                    }
                }
                StatusBadge(if (p.peerOnline) "在线" else "离线", p.peerOnline)
                Spacer(Modifier.width(2.dp))
                Text("›", fontSize = 20.sp, color = MaterialTheme.colorScheme.outline)
            } else {
                Dot(p.peerOnline)
            }
        }
    }
}

@Composable
private fun PairButton(onClick: () -> Unit) {
    Surface(
        color = MaterialTheme.colorScheme.surfaceVariant.copy(alpha = 0.5f),
        shape = RoundedCornerShape(14.dp),
        modifier = Modifier
            .fillMaxWidth()
            .clip(RoundedCornerShape(14.dp))
            .clickable(onClick = onClick),
    ) {
        Row(
            Modifier.padding(vertical = 14.dp),
            horizontalArrangement = androidx.compose.foundation.layout.Arrangement.Center,
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Text("+", color = MaterialTheme.colorScheme.primary, fontSize = 18.sp, fontWeight = FontWeight.Bold)
            Spacer(Modifier.width(8.dp))
            Text(
                "输入配对码，配对新的电脑",
                color = MaterialTheme.colorScheme.primary,
                style = MaterialTheme.typography.bodyMedium,
                fontWeight = FontWeight.Medium,
            )
        }
    }
}

@Composable
private fun Circle() {
    Box(Modifier.size(6.dp).clip(CircleShape))
}
