package com.dshremote.app.ui

import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.AnnotatedString
import androidx.compose.ui.text.SpanStyle
import androidx.compose.ui.text.buildAnnotatedString
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.withStyle
import androidx.compose.ui.unit.sp

/**
 * 轻量 markdown 渲染（对齐 PWA 的 markdown-lite）：
 * 标题 / 粗体 / 斜体 / 行内代码 / 代码块 / 列表 / 引用 / 链接。
 * 不做完整语法，只保证聊天里常见写法不显示成原始符号。
 */
fun markdownAnnotated(
    text: String,
    onSurface: Color,
    onSurfaceVariant: Color,
    codeBg: Color,
): AnnotatedString = buildAnnotatedString {
    val lines = text.split('\n')
    var inCode = false
    var first = true
    for (raw in lines) {
        val line = raw.trimEnd()
        if (!first) append('\n')
        first = false

        val fence = line.trimStart()
        if (fence.startsWith("```")) {
            inCode = !inCode
            continue
        }
        if (inCode) {
            withStyle(SpanStyle(fontFamily = FontFamily.Monospace, background = codeBg, color = onSurface)) {
                append(line)
            }
            continue
        }

        // 标题
        val heading = Regex("^(#{1,4})\\s+(.*)$").find(line)
        if (heading != null) {
            val size = when (heading.groupValues[1].length) {
                1 -> 19.sp
                2 -> 18.sp
                3 -> 17.sp
                else -> 16.sp
            }
            withStyle(SpanStyle(fontWeight = FontWeight.Bold, fontSize = size, color = onSurface)) {
                appendInline(heading.groupValues[2], onSurface, onSurfaceVariant, codeBg)
            }
            continue
        }

        // 引用
        if (line.trimStart().startsWith(">")) {
            withStyle(SpanStyle(color = onSurfaceVariant)) {
                appendInline(line.trimStart().removePrefix(">").trimStart(), onSurface, onSurfaceVariant, codeBg)
            }
            continue
        }

        // 列表
        val bullet = Regex("^(\\s*)[-*+]\\s+(.*)$").find(line)
        if (bullet != null) {
            append("• ")
            appendInline(bullet.groupValues[2], onSurface, onSurfaceVariant, codeBg)
            continue
        }
        val numbered = Regex("^(\\s*)(\\d+)\\.\\s+(.*)$").find(line)
        if (numbered != null) {
            append("${numbered.groupValues[2]}. ")
            appendInline(numbered.groupValues[3], onSurface, onSurfaceVariant, codeBg)
            continue
        }

        // 分隔线
        if (Regex("^\\s*([-*_])\\1{2,}\\s*$").containsMatchIn(line)) {
            withStyle(SpanStyle(color = onSurfaceVariant)) { append("────────") }
            continue
        }

        appendInline(line, onSurface, onSurfaceVariant, codeBg)
    }
}

private fun AnnotatedString.Builder.appendInline(
    s: String,
    onSurface: Color,
    onSurfaceVariant: Color,
    codeBg: Color,
) {
    var i = 0
    while (i < s.length) {
        when {
            s.startsWith("**", i) -> {
                val end = s.indexOf("**", i + 2)
                if (end > i) {
                    withStyle(SpanStyle(fontWeight = FontWeight.Bold, color = onSurface)) {
                        append(s.substring(i + 2, end))
                    }
                    i = end + 2
                } else {
                    append("**"); i += 2
                }
            }
            s[i] == '`' -> {
                val end = s.indexOf('`', i + 1)
                if (end > i) {
                    withStyle(
                        SpanStyle(
                            fontFamily = FontFamily.Monospace,
                            background = codeBg,
                            color = onSurface,
                        )
                    ) { append(s.substring(i + 1, end)) }
                    i = end + 1
                } else {
                    append('`'); i += 1
                }
            }
            s.startsWith("[", i) -> {
                val close = s.indexOf("](", i)
                val paren = if (close > 0) s.indexOf(')', close + 2) else -1
                if (close > 0 && paren > 0) {
                    append(s.substring(i + 1, close))
                    i = paren + 1
                } else {
                    append('['); i += 1
                }
            }
            s[i] == '*' && i + 1 < s.length && s[i + 1] != '*' -> {
                val end = s.indexOf('*', i + 1)
                if (end > i + 1) {
                    withStyle(SpanStyle(fontStyle = FontStyle.Italic, color = onSurfaceVariant)) {
                        append(s.substring(i + 1, end))
                    }
                    i = end + 1
                } else {
                    append('*'); i += 1
                }
            }
            else -> {
                append(s[i]); i += 1
            }
        }
    }
}
