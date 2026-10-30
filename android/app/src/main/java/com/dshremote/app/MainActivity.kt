package com.dshremote.app

import android.os.Bundle
import android.widget.Toast
import androidx.activity.ComponentActivity
import androidx.activity.compose.BackHandler
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import androidx.compose.foundation.isSystemInDarkTheme
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.LifecycleEventObserver
import androidx.lifecycle.compose.LocalLifecycleOwner
import androidx.lifecycle.viewmodel.compose.viewModel
import com.dshremote.app.ui.ChatScreen
import com.dshremote.app.ui.DevicesScreen
import com.dshremote.app.ui.FilesSheet
import com.dshremote.app.ui.LoginScreen
import com.dshremote.app.ui.ScreenViewScreen
import com.dshremote.app.ui.SessionsScreen
import com.dshremote.app.ui.SettingsScreen
import com.dshremote.app.ui.theme.DshRemoteTheme

class MainActivity : ComponentActivity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        enableEdgeToEdge()
        super.onCreate(savedInstanceState)
        setContent { AppRoot() }
    }
}

@Composable
private fun AppRoot(vm: AppViewModel = viewModel()) {
    val st by vm.state.collectAsState()
    val ctx = LocalContext.current

    // 外观：跟随系统 / 强制浅色 / 强制深色
    val darkTheme = when (st.themeMode) {
        "light" -> false
        "dark" -> true
        else -> isSystemInDarkTheme()
    }

    DshRemoteTheme(darkTheme = darkTheme) {
        Surface(
            modifier = Modifier.fillMaxSize(),
            color = MaterialTheme.colorScheme.background,
        ) {
            LaunchedEffect(st.toast) {
                val t = st.toast
                if (t != null) {
                    Toast.makeText(ctx, t, Toast.LENGTH_SHORT).show()
                    vm.clearToast()
                }
            }

            val lifecycleOwner = LocalLifecycleOwner.current
            DisposableEffect(lifecycleOwner) {
                val observer = LifecycleEventObserver { _, event ->
                    if (event == Lifecycle.Event.ON_RESUME) vm.ensureConnected()
                }
                lifecycleOwner.lifecycle.addObserver(observer)
                onDispose { lifecycleOwner.lifecycle.removeObserver(observer) }
            }

            BackHandler(enabled = st.screen != Screen.Login && st.screen != Screen.Devices) {
                vm.back()
            }

            Box(Modifier.fillMaxSize()) {
                when (st.screen) {
                    Screen.Login -> LoginScreen(vm, st)
                    Screen.Devices -> DevicesScreen(vm, st)
                    Screen.Sessions -> SessionsScreen(vm, st)
                    Screen.Chat -> ChatScreen(vm, st)
                    Screen.Settings -> SettingsScreen(vm, st)
                    Screen.ScreenView -> ScreenViewScreen(vm, st)
                }
                FilesSheet(vm, st)
            }
        }
    }
}
