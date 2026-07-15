package com.goldenpro.crmgateway.ui.theme

// Accessible light and dark Material color schemes.

import androidx.compose.foundation.isSystemInDarkTheme
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.darkColorScheme
import androidx.compose.material3.lightColorScheme
import androidx.compose.runtime.Composable
import androidx.compose.ui.graphics.Color

private val LightColors = lightColorScheme(
    primary = Navy,
    onPrimary = Color.White,
    primaryContainer = Color(0xFFD5E8FA),
    onPrimaryContainer = NavyDark,
    secondary = TealDark,
    onSecondary = Color.White,
    secondaryContainer = Color(0xFFB7F2DF),
    onSecondaryContainer = Color(0xFF002119),
    tertiary = Color(0xFF765832),
    tertiaryContainer = Color(0xFFFFDDB2),
    background = Cloud,
    onBackground = Ink,
    surface = Color.White,
    onSurface = Ink,
    surfaceVariant = Color(0xFFE0E7EE),
    outline = Color(0xFF71808E),
    error = Color(0xFFBA1A1A),
)

private val DarkColors = darkColorScheme(
    primary = Color(0xFFA6CDF3),
    onPrimary = NavyDark,
    primaryContainer = Navy,
    secondary = Teal,
    onSecondary = Color(0xFF00382D),
    secondaryContainer = Color(0xFF005141),
    tertiary = Gold,
    background = NightBackground,
    surface = NightSurface,
    surfaceVariant = Color(0xFF354A5E),
    outline = Color(0xFF8C9BA8),
)

@Composable
fun BreeXeTheme(
    darkTheme: Boolean = isSystemInDarkTheme(),
    content: @Composable () -> Unit,
) {
    MaterialTheme(
        colorScheme = if (darkTheme) DarkColors else LightColors,
        typography = Typography,
        content = content,
    )
}
