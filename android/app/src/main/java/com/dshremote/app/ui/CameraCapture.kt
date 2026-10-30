package com.dshremote.app.ui

import android.Manifest
import android.content.Context
import android.content.pm.PackageManager
import android.net.Uri
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.camera.core.CameraSelector
import androidx.camera.core.ImageCapture
import androidx.camera.core.ImageCaptureException
import androidx.camera.core.Preview
import androidx.camera.lifecycle.ProcessCameraProvider
import androidx.camera.view.PreviewView
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.statusBarsPadding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalLifecycleOwner
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.compose.ui.viewinterop.AndroidView
import androidx.core.content.ContextCompat
import androidx.core.content.FileProvider
import java.io.File
import java.util.concurrent.Executors
import kotlin.coroutines.resume
import kotlinx.coroutines.suspendCancellableCoroutine

// 应用内相机：预览 + 快门 + 前后摄切换，拍完直接回传 Uri 给聊天页当待发送附件
@Composable
fun CameraCaptureOverlay(onClose: () -> Unit, onCaptured: (Uri) -> Unit) {
    val ctx = LocalContext.current
    var granted by remember {
        mutableStateOf(
            ContextCompat.checkSelfPermission(ctx, Manifest.permission.CAMERA) == PackageManager.PERMISSION_GRANTED,
        )
    }
    val ask = rememberLauncherForActivityResult(ActivityResultContracts.RequestPermission()) { ok ->
        granted = ok
    }
    LaunchedEffect(Unit) {
        if (!granted) ask.launch(Manifest.permission.CAMERA)
    }

    Box(Modifier.fillMaxSize().background(Color.Black)) {
        if (granted) {
            CameraBody(onClose = onClose, onCaptured = onCaptured)
        } else {
            Column(
                Modifier.fillMaxSize().padding(32.dp),
                verticalArrangement = Arrangement.Center,
                horizontalAlignment = Alignment.CenterHorizontally,
            ) {
                Text("需要相机权限才能拍照", color = Color.White, fontSize = 16.sp)
                Spacer(Modifier.height(16.dp))
                Surface(
                    color = MaterialTheme.colorScheme.primary,
                    shape = MaterialTheme.shapes.medium,
                    modifier = Modifier.clickable { ask.launch(Manifest.permission.CAMERA) },
                ) {
                    Text(
                        "授予权限",
                        color = Color.White,
                        modifier = Modifier.padding(horizontal = 20.dp, vertical = 10.dp),
                    )
                }
                Spacer(Modifier.height(12.dp))
                Text("取消", color = Color.White.copy(alpha = 0.7f), modifier = Modifier.clickable { onClose() })
            }
        }

        // 关闭
        Surface(
            color = Color.Black.copy(alpha = 0.45f),
            shape = CircleShape,
            modifier = Modifier.statusBarsPadding().padding(12.dp).size(36.dp).clickable { onClose() },
        ) {
            Box(contentAlignment = Alignment.Center) { Text("✕", color = Color.White, fontSize = 16.sp) }
        }
    }
}

@Composable
private fun CameraBody(onClose: () -> Unit, onCaptured: (Uri) -> Unit) {
    val ctx = LocalContext.current
    val lifecycle = LocalLifecycleOwner.current
    val executor = remember { Executors.newSingleThreadExecutor() }
    var lens by remember { mutableStateOf(CameraSelector.LENS_FACING_BACK) }
    var hasFront by remember { mutableStateOf(true) }
    var busy by remember { mutableStateOf(false) }
    var error by remember { mutableStateOf<String?>(null) }

    val imageCapture = remember {
        ImageCapture.Builder()
            .setCaptureMode(ImageCapture.CAPTURE_MODE_MINIMIZE_LATENCY)
            .build()
    }
    val previewView = remember {
        PreviewView(ctx).apply {
            scaleType = PreviewView.ScaleType.FILL_CENTER
            implementationMode = PreviewView.ImplementationMode.COMPATIBLE
        }
    }

    DisposableEffect(Unit) { onDispose { executor.shutdown() } }

    LaunchedEffect(lens) {
        try {
            val provider = cameraProvider(ctx)
            hasFront = runCatching {
                provider.hasCamera(CameraSelector.DEFAULT_FRONT_CAMERA)
            }.getOrDefault(false)
            provider.unbindAll()
            val preview = Preview.Builder().build().also { it.surfaceProvider = previewView.surfaceProvider }
            provider.bindToLifecycle(lifecycle, CameraSelector.Builder().requireLensFacing(lens).build(), preview, imageCapture)
            error = null
        } catch (e: Exception) {
            error = "相机不可用：${e.message ?: e.javaClass.simpleName}"
        }
    }

    Box(Modifier.fillMaxSize()) {
        AndroidView(factory = { previewView }, modifier = Modifier.fillMaxSize())

        error?.let {
            Text(it, color = Color.White, modifier = Modifier.align(Alignment.Center).padding(24.dp))
        }

        // 底部操作条
        Row(
            Modifier
                .align(Alignment.BottomCenter)
                .fillMaxWidth()
                .navigationBarsPadding()
                .padding(bottom = 24.dp, start = 24.dp, end = 24.dp),
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.SpaceBetween,
        ) {
            // 切换前后摄
            Surface(
                color = Color.White.copy(alpha = 0.16f),
                shape = CircleShape,
                modifier = Modifier.size(48.dp).clickable(enabled = hasFront && !busy) {
                    lens = if (lens == CameraSelector.LENS_FACING_BACK) {
                        CameraSelector.LENS_FACING_FRONT
                    } else {
                        CameraSelector.LENS_FACING_BACK
                    }
                },
            ) {
                Box(contentAlignment = Alignment.Center) {
                    Text(if (lens == CameraSelector.LENS_FACING_BACK) "⇄" else "↺", color = Color.White, fontSize = 20.sp)
                }
            }

            // 快门
            Box(
                Modifier
                    .size(72.dp)
                    .clip(CircleShape)
                    .border(4.dp, Color.White, CircleShape)
                    .background(if (busy) Color.Gray else Color.White)
                    .clickable(enabled = !busy) {
                        busy = true
                        takePhoto(ctx, imageCapture, onCaptured) { msg ->
                            busy = false
                            error = msg
                        }
                    },
            )

            // 占位，保持快门居中
            Spacer(Modifier.width(48.dp).height(48.dp))
        }

        if (busy) {
            Text(
                "处理中…",
                color = Color.White,
                modifier = Modifier.align(Alignment.Center).background(Color.Black.copy(alpha = 0.5f)).padding(12.dp),
            )
        }
    }
}

private suspend fun cameraProvider(ctx: Context): ProcessCameraProvider = suspendCancellableCoroutine { cont ->
    val future = ProcessCameraProvider.getInstance(ctx)
    future.addListener(
        {
            try {
                cont.resume(future.get())
            } catch (e: Exception) {
                cont.cancel(e)
            }
        },
        ContextCompat.getMainExecutor(ctx),
    )
}

private fun takePhoto(
    ctx: Context,
    imageCapture: ImageCapture,
    onCaptured: (Uri) -> Unit,
    onError: (String) -> Unit,
) {
    val dir = File(ctx.cacheDir, "camera").apply { mkdirs() }
    val file = File(dir, "shot_${System.currentTimeMillis()}.jpg")
    val opts = ImageCapture.OutputFileOptions.Builder(file).build()
    imageCapture.takePicture(
        opts,
        ContextCompat.getMainExecutor(ctx),
        object : ImageCapture.OnImageSavedCallback {
            override fun onImageSaved(output: ImageCapture.OutputFileResults) {
                try {
                    val uri = FileProvider.getUriForFile(ctx, ctx.packageName + ".fileprovider", file)
                    onCaptured(uri)
                } catch (e: Exception) {
                    onError("照片处理失败：${e.message}")
                }
            }

            override fun onError(e: ImageCaptureException) {
                onError("拍照失败：${e.message}")
            }
        },
    )
}
