package com.dshremote.app.ui

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.dshremote.app.AppViewModel
import com.dshremote.app.UiState
import com.dshremote.app.data.DeviceInfo

@Composable
fun SettingsScreen(vm: AppViewModel, st: UiState) {
    var confirmLogout by remember { mutableStateOf(false) }
    var revokeTarget by remember { mutableStateOf<DeviceInfo?>(null) }

    Column(Modifier.fillMaxSize()) {
        DshTopBar(title = "设置", onBack = vm::back)
        Column(
            Modifier
                .weight(1f)
                .verticalScroll(rememberScrollState())
                .padding(bottom = 32.dp),
        ) {
            SectionLabel("账号")
            CardGroup {
                InfoRow("账号", st.handle.ifBlank { "-" })
                InfoRow("服务器", st.serverUrl)
                InfoRow("本机名称", st.deviceName.ifBlank { "-" })
                InfoRow("连接状态", if (st.connected) "已连接" else "未连接")
            }

            SectionLabel("外观")
            CardGroup {
                Row(
                    Modifier.padding(14.dp).fillMaxWidth(),
                    horizontalArrangement = Arrangement.spacedBy(8.dp),
                ) {
                    for (item in listOf("system" to "跟随系统", "light" to "浅色", "dark" to "深色")) {
                        ThemeOption(
                            label = item.second,
                            selected = st.themeMode == item.first,
                            modifier = Modifier.weight(1f),
                        ) { vm.setThemeMode(item.first) }
                    }
                }
            }

            SectionLabel("已登录设备")
            CardGroup {
                if (st.devices.isEmpty()) {
                    Text(
                        "没有数据",
                        modifier = Modifier.padding(16.dp),
                        style = MaterialTheme.typography.bodyMedium,
                        color = MaterialTheme.colorScheme.outline,
                    )
                }
                for (d in st.devices) {
                    DeviceRow(
                        device = d,
                        self = d.name == st.deviceName,
                        onRevoke = { revokeTarget = d },
                    )
                }
            }

            SectionLabel("关于")
            CardGroup {
                InfoRow("版本", st.appVersion.ifBlank { "-" })
                Row(
                    Modifier.padding(horizontal = 14.dp, vertical = 10.dp).fillMaxWidth(),
                    verticalAlignment = Alignment.CenterVertically,
                ) {
                    Column(Modifier.weight(1f)) {
                        Text("应用更新", style = MaterialTheme.typography.bodyMedium)
                        Text(
                            st.updateStatus.ifBlank { "从服务器检查最新安装包" },
                            style = MaterialTheme.typography.labelMedium,
                            color = MaterialTheme.colorScheme.outline,
                            lineHeight = 16.sp,
                        )
                    }
                    if (st.update != null) {
                        TextButton(onClick = { vm.downloadUpdate() }, enabled = !st.updateDownloading) {
                            Text(if (st.updateDownloading) "下载中…" else "安装 ${st.update.versionName}")
                        }
                    } else {
                        TextButton(onClick = { vm.checkUpdate(false) }, enabled = !st.updateChecking) {
                            Text(if (st.updateChecking) "检查中…" else "检查更新")
                        }
                    }
                }
                InfoRow("协议", "DSH Console v0.2")
                Text(
                    "手机通过你自己的中继服务器连接家里的电脑。会话、消息和文件都只经过这台服务器，不会上传到第三方。",
                    modifier = Modifier.padding(14.dp),
                    style = MaterialTheme.typography.labelMedium,
                    color = MaterialTheme.colorScheme.outline,
                    lineHeight = 17.sp,
                )
            }

            Spacer(Modifier.height(10.dp))
            Box(Modifier.padding(horizontal = 18.dp)) {
                Surface(
                    color = MaterialTheme.colorScheme.errorContainer.copy(alpha = 0.5f),
                    shape = RoundedCornerShape(14.dp),
                    modifier = Modifier
                        .fillMaxWidth()
                        .clip(RoundedCornerShape(14.dp))
                        .clickable { confirmLogout = true },
                ) {
                    Text(
                        "退出登录",
                        modifier = Modifier.padding(vertical = 14.dp).fillMaxWidth(),
                        textAlign = androidx.compose.ui.text.style.TextAlign.Center,
                        color = MaterialTheme.colorScheme.error,
                        fontWeight = FontWeight.Medium,
                    )
                }
            }
        }
    }

    if (confirmLogout) {
        AlertDialog(
            onDismissRequest = { confirmLogout = false },
            title = { Text("退出登录") },
            text = { Text("退出后需要重新输入账号密码，本机的登录状态会被清除。") },
            confirmButton = {
                TextButton(onClick = {
                    confirmLogout = false
                    vm.logout()
                }) { Text("退出") }
            },
            dismissButton = { TextButton(onClick = { confirmLogout = false }) { Text("取消") } },
        )
    }

    revokeTarget?.let { d ->
        AlertDialog(
            onDismissRequest = { revokeTarget = null },
            title = { Text("撤销设备") },
            text = { Text("撤销「${d.name}」后，这台设备需要重新登录才能使用。") },
            confirmButton = {
                TextButton(onClick = {
                    vm.revokeDevice(d.id)
                    revokeTarget = null
                }) { Text("撤销") }
            },
            dismissButton = { TextButton(onClick = { revokeTarget = null }) { Text("取消") } },
        )
    }
}

@Composable
private fun ThemeOption(
    label: String,
    selected: Boolean,
    modifier: Modifier = Modifier,
    onClick: () -> Unit,
) {
    val bg = if (selected) MaterialTheme.colorScheme.primary.copy(alpha = 0.16f)
    else MaterialTheme.colorScheme.surfaceVariant.copy(alpha = 0.35f)
    val fg = if (selected) MaterialTheme.colorScheme.primary else MaterialTheme.colorScheme.onSurfaceVariant
    Surface(
        color = bg,
        shape = RoundedCornerShape(10.dp),
        modifier = modifier.clip(RoundedCornerShape(10.dp)).clickable(onClick = onClick),
    ) {
        Text(
            label,
            modifier = Modifier.padding(vertical = 10.dp).fillMaxWidth(),
            textAlign = androidx.compose.ui.text.style.TextAlign.Center,
            fontSize = 13.sp,
            color = fg,
            fontWeight = if (selected) FontWeight.Medium else FontWeight.Normal,
        )
    }
}

@Composable
private fun CardGroup(content: @Composable () -> Unit) {
    Surface(
        color = MaterialTheme.colorScheme.surface,
        shape = RoundedCornerShape(14.dp),
        modifier = Modifier
            .fillMaxWidth()
            .padding(horizontal = 16.dp),
    ) {
        Column { content() }
    }
}

@Composable
private fun InfoRow(label: String, value: String) {
    Row(
        modifier = Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 13.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Text(
            label,
            style = MaterialTheme.typography.bodyMedium,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
            modifier = Modifier.width(88.dp),
        )
        Text(
            value,
            style = MaterialTheme.typography.bodyMedium,
            color = MaterialTheme.colorScheme.onSurface,
        )
    }
    Box(
        Modifier
            .padding(start = 16.dp)
            .height(0.5.dp)
            .fillMaxWidth()
            .background(MaterialTheme.colorScheme.outlineVariant.copy(alpha = 0.7f)),
    )
}

@Composable
private fun DeviceRow(device: DeviceInfo, self: Boolean, onRevoke: () -> Unit) {
    Row(
        modifier = Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 13.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Column(Modifier.weight(1f)) {
            Row(verticalAlignment = Alignment.CenterVertically) {
                Text(
                    device.name,
                    style = MaterialTheme.typography.bodyMedium,
                    color = MaterialTheme.colorScheme.onSurface,
                )
                if (self) {
                    Spacer(Modifier.width(6.dp))
                    Text("本机", fontSize = 11.sp, color = MaterialTheme.colorScheme.primary)
                }
            }
            Text(
                "${device.kind} · ${if (device.online) "在线" else "离线"}",
                style = MaterialTheme.typography.labelMedium,
                color = MaterialTheme.colorScheme.outline,
            )
        }
        if (!self) {
            Text(
                "撤销",
                color = MaterialTheme.colorScheme.error,
                style = MaterialTheme.typography.bodyMedium,
                modifier = Modifier
                    .clip(RoundedCornerShape(8.dp))
                    .clickable(onClick = onRevoke)
                    .padding(horizontal = 8.dp, vertical = 4.dp),
            )
        }
    }
    Box(
        Modifier
            .padding(start = 16.dp)
            .height(0.5.dp)
            .fillMaxWidth()
            .background(MaterialTheme.colorScheme.outlineVariant.copy(alpha = 0.7f)),
    )
}
