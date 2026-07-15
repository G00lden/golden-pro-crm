package com.goldenpro.crmgateway

// Read-only health checks and sanitized support report.

import android.Manifest
import android.content.Context
import android.content.pm.PackageManager
import android.net.ConnectivityManager
import android.net.NetworkCapabilities
import android.os.Build
import android.os.PowerManager
import androidx.core.content.ContextCompat
import java.net.URI
import java.text.DateFormat
import java.util.Date

data class GatewayDiagnostics(
    val permissionsGranted: Boolean,
    val networkAvailable: Boolean,
    val batteryUnrestricted: Boolean,
    val configured: Boolean,
    val pendingEvents: Int,
    val lastSuccessAt: Long,
    val phonePermissionGranted: Boolean = false,
)

object GatewayDiagnosticsReader {
    val requiredPermissions = buildList {
        add(Manifest.permission.READ_PHONE_STATE)
        add(Manifest.permission.READ_CALL_LOG)
        add(Manifest.permission.READ_CONTACTS)
        add(Manifest.permission.WRITE_CONTACTS)
        if (Build.VERSION.SDK_INT >= 33) add(Manifest.permission.POST_NOTIFICATIONS)
    }.toTypedArray()

    fun read(context: Context): GatewayDiagnostics {
        val connectivity = context.getSystemService(ConnectivityManager::class.java)
        val network = connectivity.activeNetwork
        val capabilities = connectivity.getNetworkCapabilities(network)
        val power = context.getSystemService(PowerManager::class.java)
        val phonePermissionGranted = ContextCompat.checkSelfPermission(
            context,
            Manifest.permission.READ_PHONE_STATE,
        ) == PackageManager.PERMISSION_GRANTED
        return GatewayDiagnostics(
            permissionsGranted = requiredPermissions.all {
                ContextCompat.checkSelfPermission(context, it) == PackageManager.PERMISSION_GRANTED
            },
            networkAvailable = capabilities?.hasCapability(NetworkCapabilities.NET_CAPABILITY_INTERNET) == true,
            batteryUnrestricted = power.isIgnoringBatteryOptimizations(context.packageName),
            configured = GatewayConfigValidator.firstError(GatewayPreferences.config(context)) == null,
            pendingEvents = GatewayQueue.size(context),
            lastSuccessAt = GatewayPreferences.runtime(context).lastSuccessAt,
            phonePermissionGranted = phonePermissionGranted,
        )
    }

    fun report(context: Context): String {
        val diagnostic = read(context)
        val config = GatewayPreferences.config(context)
        val registration = GatewayPreferences.registration(context)
        val host = runCatching { URI(config.serverUrl).host }.getOrNull().orEmpty().ifBlank { "غير مضبوط" }
        val lastSuccess = if (diagnostic.lastSuccessAt > 0) {
            DateFormat.getDateTimeInstance().format(Date(diagnostic.lastSuccessAt))
        } else "لا يوجد"
        return buildString {
            appendLine("تقرير BreeXe Connect")
            appendLine("الإصدار: ${BuildConfig.VERSION_NAME} (${BuildConfig.VERSION_CODE})")
            appendLine("الجهاز: ${Build.MANUFACTURER} ${Build.MODEL} / Android ${Build.VERSION.RELEASE}")
            appendLine("خادم CRM: $host")
            appendLine("معرّف الربط: ${registration.deviceId.ifBlank { "غير مرتبط" }}")
            appendLine("الأذونات: ${if (diagnostic.permissionsGranted) "مكتملة" else "ناقصة"}")
            appendLine("الشبكة: ${if (diagnostic.networkAvailable) "متاحة" else "غير متاحة"}")
            appendLine("تقييد البطارية: ${if (diagnostic.batteryUnrestricted) "غير مقيّد" else "قد يكون مقيّدًا"}")
            appendLine("أحداث معلقة: ${diagnostic.pendingEvents}")
            appendLine("آخر نجاح: $lastSuccess")
            append("لا يحتوي هذا التقرير على التوكن أو أرقام العملاء.")
        }
    }
}
