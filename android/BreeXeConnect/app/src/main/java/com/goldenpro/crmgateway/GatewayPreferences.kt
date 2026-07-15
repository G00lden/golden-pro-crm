package com.goldenpro.crmgateway

// Persisted configuration and runtime status; credentials stay in GatewaySecretStore.

import android.content.Context
import android.os.Build
import androidx.core.content.edit

data class GatewayConfig(
    val serverUrl: String,
    val token: String,
    val companyNumber: String,
    val deviceName: String,
)

data class GatewayRuntime(
    val status: String,
    val lastError: String,
    val lastAttemptAt: Long,
    val lastSuccessAt: Long,
)

data class GatewayRegistration(
    val deviceId: String,
    val pairedAt: Long,
)

data class MobilePolicy(
    val version: Int,
    val workSimKey: String,
    val assignedUserName: String,
    val branchId: String,
    val managementMode: String,
)

data class MobileDashboardSummary(
    val tasks: Int,
    val overdueTasks: Int,
    val callsToday: Int,
    val pendingCalls: Int,
)

data class PendingCallResult(
    val callSid: String,
    val phone: String,
    val disposition: String,
    val occurredAt: Long,
)

object GatewayPreferences {
    private const val PREFS = "crm_gateway"
    private const val SERVER_URL = "server_url"
    private const val TOKEN = "gateway_token"
    private const val COMPANY_NUMBER = "company_number"
    private const val DEVICE_NAME = "device_name"
    private const val DEVICE_ID = "device_id"
    private const val PAIRED_AT = "paired_at"
    private const val STATUS = "status"
    private const val LAST_ERROR = "last_error"
    private const val LAST_ATTEMPT = "last_attempt"
    private const val LAST_SUCCESS = "last_success"
    private const val POLICY_VERSION = "mobile_policy_version"
    private const val WORK_SIM_KEY = "mobile_work_sim_key"
    private const val ASSIGNED_USER_NAME = "mobile_assigned_user_name"
    private const val BRANCH_ID = "mobile_branch_id"
    private const val MANAGEMENT_MODE = "mobile_management_mode"
    private const val DASHBOARD_TASKS = "mobile_dashboard_tasks"
    private const val DASHBOARD_OVERDUE = "mobile_dashboard_overdue"
    private const val DASHBOARD_CALLS = "mobile_dashboard_calls"
    private const val DASHBOARD_PENDING_CALLS = "mobile_dashboard_pending_calls"
    private const val PENDING_CALL_SID = "pending_call_sid"
    private const val PENDING_CALL_PHONE = "pending_call_phone"
    private const val PENDING_CALL_DISPOSITION = "pending_call_disposition"
    private const val PENDING_CALL_AT = "pending_call_at"

    fun config(context: Context): GatewayConfig {
        val prefs = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
        val legacyToken = prefs.getString(TOKEN, "").orEmpty()
        var protectedToken = GatewaySecretStore.read(context)
        if (protectedToken.isBlank() && legacyToken.isNotBlank() && GatewaySecretStore.write(context, legacyToken)) {
            protectedToken = legacyToken
            prefs.edit { remove(TOKEN) }
        }
        return GatewayConfig(
            serverUrl = prefs.getString(SERVER_URL, BuildConfig.DEFAULT_GATEWAY_URL).orEmpty(),
            token = protectedToken.ifBlank { legacyToken },
            companyNumber = prefs.getString(COMPANY_NUMBER, "").orEmpty(),
            deviceName = prefs.getString(DEVICE_NAME, Build.MODEL).orEmpty(),
        )
    }

    fun saveConfig(context: Context, config: GatewayConfig) {
        val protected = GatewaySecretStore.write(context, config.token.trim())
        context.getSharedPreferences(PREFS, Context.MODE_PRIVATE).edit {
            putString(SERVER_URL, config.serverUrl.trim().trimEnd('/'))
            putString(COMPANY_NUMBER, config.companyNumber.trim())
            putString(DEVICE_NAME, config.deviceName.trim())
            if (protected) remove(TOKEN) else putString(TOKEN, config.token.trim())
        }
    }

    fun savePairing(context: Context, config: GatewayConfig, deviceId: String) {
        saveConfig(context, config)
        context.getSharedPreferences(PREFS, Context.MODE_PRIVATE).edit {
            putString(DEVICE_ID, deviceId)
            putLong(PAIRED_AT, System.currentTimeMillis())
        }
        GatewayActivityLog.add(context, "paired", "تم ربط الجوال بالـ CRM", config.deviceName)
    }

    fun registration(context: Context): GatewayRegistration {
        val prefs = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
        return GatewayRegistration(
            deviceId = prefs.getString(DEVICE_ID, "").orEmpty(),
            pairedAt = prefs.getLong(PAIRED_AT, 0L),
        )
    }

    fun mobilePolicy(context: Context): MobilePolicy {
        val prefs = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
        return MobilePolicy(
            version = prefs.getInt(POLICY_VERSION, 0),
            workSimKey = prefs.getString(WORK_SIM_KEY, "").orEmpty(),
            assignedUserName = prefs.getString(ASSIGNED_USER_NAME, "").orEmpty(),
            branchId = prefs.getString(BRANCH_ID, "").orEmpty(),
            managementMode = prefs.getString(MANAGEMENT_MODE, "byod").orEmpty(),
        )
    }

    fun saveMobilePolicy(context: Context, policy: MobilePolicy) {
        context.getSharedPreferences(PREFS, Context.MODE_PRIVATE).edit(commit = true) {
            putInt(POLICY_VERSION, policy.version)
            putString(WORK_SIM_KEY, policy.workSimKey)
            putString(ASSIGNED_USER_NAME, policy.assignedUserName)
            putString(BRANCH_ID, policy.branchId)
            putString(MANAGEMENT_MODE, policy.managementMode)
        }
    }

    fun mobileDashboard(context: Context): MobileDashboardSummary {
        val prefs = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
        return MobileDashboardSummary(
            tasks = prefs.getInt(DASHBOARD_TASKS, 0),
            overdueTasks = prefs.getInt(DASHBOARD_OVERDUE, 0),
            callsToday = prefs.getInt(DASHBOARD_CALLS, 0),
            pendingCalls = prefs.getInt(DASHBOARD_PENDING_CALLS, 0),
        )
    }

    fun saveMobileDashboard(context: Context, summary: MobileDashboardSummary) {
        context.getSharedPreferences(PREFS, Context.MODE_PRIVATE).edit(commit = true) {
            putInt(DASHBOARD_TASKS, summary.tasks)
            putInt(DASHBOARD_OVERDUE, summary.overdueTasks)
            putInt(DASHBOARD_CALLS, summary.callsToday)
            putInt(DASHBOARD_PENDING_CALLS, summary.pendingCalls)
        }
    }

    fun pendingCall(context: Context): PendingCallResult? {
        val prefs = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
        val callSid = prefs.getString(PENDING_CALL_SID, "").orEmpty()
        if (callSid.isBlank()) return null
        return PendingCallResult(callSid, prefs.getString(PENDING_CALL_PHONE, "").orEmpty(), prefs.getString(PENDING_CALL_DISPOSITION, "").orEmpty(), prefs.getLong(PENDING_CALL_AT, 0))
    }

    fun savePendingCall(context: Context, call: PendingCallResult?) {
        context.getSharedPreferences(PREFS, Context.MODE_PRIVATE).edit(commit = true) {
            if (call == null) {
                remove(PENDING_CALL_SID); remove(PENDING_CALL_PHONE); remove(PENDING_CALL_DISPOSITION); remove(PENDING_CALL_AT)
            } else {
                putString(PENDING_CALL_SID, call.callSid)
                putString(PENDING_CALL_PHONE, call.phone)
                putString(PENDING_CALL_DISPOSITION, call.disposition)
                putLong(PENDING_CALL_AT, call.occurredAt)
            }
        }
    }

    fun clearPairing(context: Context) {
        GatewaySecretStore.write(context, "")
        context.getSharedPreferences(PREFS, Context.MODE_PRIVATE).edit {
            remove(TOKEN)
            remove(DEVICE_ID)
            remove(PAIRED_AT)
            putString(STATUS, "تم فصل الربط المحلي. الأحداث المحفوظة لم تُحذف.")
            putString(LAST_ERROR, "")
        }
        GatewayActivityLog.add(context, "warning", "تم فصل ربط الجوال", "يمكن ربطه مجددًا دون فقد الطابور")
    }

    fun runtime(context: Context): GatewayRuntime {
        val prefs = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
        return GatewayRuntime(
            status = prefs.getString(STATUS, "").orEmpty(),
            lastError = prefs.getString(LAST_ERROR, "").orEmpty(),
            lastAttemptAt = prefs.getLong(LAST_ATTEMPT, 0L),
            lastSuccessAt = prefs.getLong(LAST_SUCCESS, 0L),
        )
    }

    fun markSending(context: Context) = updateRuntime(
        context,
        "جاري فحص الخادم وإرسال الأحداث…",
        "",
        success = false,
        attempted = true,
    )

    fun markSuccess(context: Context, message: String = "الاتصال بالـ CRM يعمل بنجاح.") =
        updateRuntime(context, message, "", success = true, attempted = true)

    fun markError(context: Context, error: String) {
        val previous = runtime(context).lastError
        val safeError = error.take(500)
        updateRuntime(context, "توقف إرسال الأحداث إلى الـ CRM مؤقتًا.", safeError, success = false, attempted = true)
        if (safeError.isNotBlank() && safeError != previous) {
            GatewayActivityLog.add(context, "error", "تعذر الاتصال بالـ CRM", safeError)
        }
    }

    fun markConfigurationError(context: Context, error: String) =
        updateRuntime(context, "إعداد الاتصال غير مكتمل.", error.take(500), success = false, attempted = false)

    fun markConfigured(context: Context) =
        updateRuntime(context, "تم حفظ الإعداد. اختبر الاتصال للتأكد.", "", success = false, attempted = false)

    private fun updateRuntime(
        context: Context,
        status: String,
        error: String,
        success: Boolean,
        attempted: Boolean,
    ) {
        context.getSharedPreferences(PREFS, Context.MODE_PRIVATE).edit {
            putString(STATUS, status)
            putString(LAST_ERROR, error)
            if (attempted) putLong(LAST_ATTEMPT, System.currentTimeMillis())
            if (success) putLong(LAST_SUCCESS, System.currentTimeMillis())
        }
    }
}
