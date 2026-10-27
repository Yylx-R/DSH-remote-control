package com.dshremote.app.ui.theme

import android.os.Build
import androidx.compose.foundation.isSystemInDarkTheme
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.darkColorScheme
import androidx.compose.material3.lightColorScheme
import androidx.compose.runtime.Composable
import androidx.compose.runtime.SideEffect
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.toArgb
import androidx.compose.ui.platform.LocalView
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.sp
import androidx.compose.material3.Typography
import androidx.compose.material3.Shapes
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.ui.unit.dp
import androidx.core.view.WindowCompat

// 取自 DSH 桌面端的暗色基准：#0F1115 背景 / #2C2C2E 描边 / #F9FAFB 浅色底
private val DshBlue = Color(0xFF4D6BFE)
private val DshBlueDark = Color(0xFF3A55E0)

val DarkColors = darkColorScheme(
    primary = DshBlue,
    onPrimary = Color.White,
    primaryContainer = Color(0xFF22305E),
    onPrimaryContainer = Color(0xFFC9D3FF),
    secondary = Color(0xFF9BA1A6),
    onSecondary = Color(0xFF111318),
    background = Color(0xFF0F1115),
    onBackground = Color(0xFFF2F3F5),
    surface = Color(0xFF15181D),
    onSurface = Color(0xFFF2F3F5),
    surfaceVariant = Color(0xFF1D2127),
    onSurfaceVariant = Color(0xFF9BA1A6),
    outline = Color(0xFF2C2C2E),
    outlineVariant = Color(0xFF23262B),
    error = Color(0xFFFF6B6B),
    onError = Color.White,
    errorContainer = Color(0xFF3A1F20),
    onErrorContainer = Color(0xFFFFD9D7),
    inverseSurface = Color(0xFFF2F3F5),
    inverseOnSurface = Color(0xFF17191E),
    inversePrimary = DshBlueDark,
)

val LightColors = lightColorScheme(
    primary = DshBlue,
    onPrimary = Color.White,
    primaryContainer = Color(0xFFE6EBFF),
    onPrimaryContainer = Color(0xFF1B2C6B),
    secondary = Color(0xFF5F6368),
    onSecondary = Color.White,
    background = Color(0xFFF7F8FA),
    onBackground = Color(0xFF14171A),
    surface = Color(0xFFFFFFFF),
    onSurface = Color(0xFF14171A),
    surfaceVariant = Color(0xFFF0F1F4),
    onSurfaceVariant = Color(0xFF5F6368),
    outline = Color(0xFFE2E4E8),
    outlineVariant = Color(0xFFEDEEF1),
    error = Color(0xFFD93025),
    onError = Color.White,
    errorContainer = Color(0xFFFDE7E6),
    onErrorContainer = Color(0xFF8C1D18),
    inverseSurface = Color(0xFF17191E),
    inverseOnSurface = Color(0xFFF2F3F5),
    inversePrimary = Color(0xFFB9C5FF),
)

private val AppShapes = Shapes(
    extraSmall = RoundedCornerShape(8.dp),
    small = RoundedCornerShape(10.dp),
    medium = RoundedCornerShape(14.dp),
    large = RoundedCornerShape(20.dp),
    extraLarge = RoundedCornerShape(28.dp),
)

private val AppTypography = Typography(
    titleLarge = TextStyle(
        fontFamily = FontFamily.SansSerif,
        fontWeight = FontWeight.SemiBold,
        fontSize = 19.sp,
        lineHeight = 26.sp,
    ),
    titleMedium = TextStyle(
        fontFamily = FontFamily.SansSerif,
        fontWeight = FontWeight.SemiBold,
        fontSize = 16.sp,
        lineHeight = 22.sp,
    ),
    bodyLarge = TextStyle(
        fontFamily = FontFamily.SansSerif,
        fontWeight = FontWeight.Normal,
        fontSize = 16.sp,
        lineHeight = 24.sp,
    ),
    bodyMedium = TextStyle(
        fontFamily = FontFamily.SansSerif,
        fontWeight = FontWeight.Normal,
        fontSize = 14.sp,
        lineHeight = 21.sp,
    ),
    labelMedium = TextStyle(
        fontFamily = FontFamily.SansSerif,
        fontWeight = FontWeight.Medium,
        fontSize = 12.sp,
        lineHeight = 16.sp,
    ),
)

@Composable
fun DshRemoteTheme(
    darkTheme: Boolean = isSystemInDarkTheme(),
    content: @Composable () -> Unit,
) {
    val colors = if (darkTheme) DarkColors else LightColors
    val view = LocalView.current
    if (!view.isInEditMode) {
        SideEffect {
            val window = (view.context as? android.app.Activity)?.window ?: return@SideEffect
            WindowCompat.getInsetsController(window, view).apply {
                isAppearanceLightStatusBars = !darkTheme
                isAppearanceLightNavigationBars = !darkTheme
            }
        }
    }
    MaterialTheme(
        colorScheme = colors,
        shapes = AppShapes,
        typography = AppTypography,
        content = content,
    )
}

@Suppress("unused")
fun Color.toArgbCompat(): Int {
    return if (Build.VERSION.SDK_INT >= 26) toArgb() else toArgb()
}
