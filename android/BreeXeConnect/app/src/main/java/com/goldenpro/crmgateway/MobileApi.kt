package com.goldenpro.crmgateway

import android.Manifest
import android.content.Context
import android.content.pm.PackageManager
import android.net.ConnectivityManager
import android.os.BatteryManager
import androidx.core.content.ContextCompat
import org.json.JSONArray
import org.json.JSONObject
import java.io.IOException
import java.net.HttpURLConnection
import java.net.URL

sealed interface MobileApiResult<out T> {
    data class Success<T>(val value: T) : MobileApiResult<T>
    data class Retry(val message: String) : MobileApiResult<Nothing>
    data class Failure(val message: String) : MobileApiResult<Nothing>
}

object MobileApi {
    fun syncProfile(context: Context): MobileApiResult<Unit> {
        val sims = JSONArray().apply {
            WorkSimManager.activeSims(context).forEach { sim ->
                put(JSONObject()
                    .put("simKey", sim.simKey)
                    .put("slotIndex", sim.slotIndex)
                    .put("carrierName", sim.carrierName)
                    .put("displayName", sim.displayName)
                    .put("phoneSuffix", sim.phoneSuffix))
            }
        }
        val permissions = JSONObject()
        listOf(
            Manifest.permission.READ_PHONE_STATE,
            Manifest.permission.READ_CALL_LOG,
            Manifest.permission.READ_CONTACTS,
            Manifest.permission.WRITE_CONTACTS,
        ).forEach { permission -> permissions.put(permission.substringAfterLast('.'), ContextCompat.checkSelfPermission(context, permission) == PackageManager.PERMISSION_GRANTED) }
        val fcmToken = context.getSharedPreferences("breexe_push", Context.MODE_PRIVATE).getString("token", "").orEmpty()
        val body = JSONObject()
            .put("appVersion", BuildConfig.VERSION_NAME)
            .put("platformVersion", android.os.Build.VERSION.RELEASE)
            .put("manufacturer", android.os.Build.MANUFACTURER)
            .put("model", android.os.Build.MODEL)
            .put("batteryPercent", batteryPercent(context))
            .put("networkType", networkType(context))
            .put("permissions", permissions)
            .put("health", JSONObject()
                .put("queueSize", GatewayQueue.size(context))
                .put("callerScreening", CallerScreeningRole.isHeld(context)))
            .put("sims", sims)
        if (fcmToken.isNotBlank()) body.put("fcmToken", fcmToken)
        return request(context, "/api/mobile/v1/profile", "POST", body).mapUnit()
    }

    fun fetchPolicy(context: Context): MobileApiResult<MobilePolicy> {
        return when (val result = request(context, "/api/mobile/v1/policy", "GET", null)) {
            is MobileApiResult.Success -> MobileApiResult.Success(savePolicy(context, result.value))
            is MobileApiResult.Retry -> result
            is MobileApiResult.Failure -> result
        }
    }

    fun selectWorkSim(context: Context, simKey: String): MobileApiResult<MobilePolicy> {
        val body = JSONObject().put("workSimKey", simKey)
        return when (val result = request(context, "/api/mobile/v1/work-sim", "PUT", body)) {
            is MobileApiResult.Success -> {
                val policyJson = result.value.optJSONObject("policy") ?: result.value
                MobileApiResult.Success(savePolicy(context, policyJson))
            }
            is MobileApiResult.Retry -> result
            is MobileApiResult.Failure -> result
        }
    }

    private fun savePolicy(context: Context, json: JSONObject): MobilePolicy {
        val policy = MobilePolicy(
            version = json.optInt("policyVersion"),
            workSimKey = json.optString("workSimKey"),
            assignedUserName = json.optString("assignedUserName"),
            branchId = json.optString("branchId"),
            managementMode = json.optString("managementMode", "byod"),
        )
        GatewayPreferences.saveMobilePolicy(context, policy)
        return policy
    }

    fun sendEvents(context: Context, events: List<GatewayEvent>): MobileApiResult<Unit> {
        if (events.isEmpty()) return MobileApiResult.Success(Unit)
        val body = JSONObject().put("events", JSONArray().apply { events.forEach { put(it.toMobileEnvelope()) } })
        return request(context, "/api/mobile/v1/events/batch", "POST", body).mapUnit()
    }

    fun fetchCommands(context: Context): MobileApiResult<List<MobileCommandEntity>> {
        return when (val result = request(context, "/api/mobile/v1/commands?limit=20", "GET", null)) {
            is MobileApiResult.Success -> {
                val array = result.value.optJSONArray("commands") ?: JSONArray()
                val commands = buildList {
                    for (index in 0 until array.length()) {
                        val item = array.optJSONObject(index) ?: continue
                        add(MobileCommandEntity(
                            id = item.optString("id"),
                            type = item.optString("command_type"),
                            payload = item.optJSONObject("payload")?.toString() ?: "{}",
                            status = item.optString("status", "delivered"),
                            expiresAt = item.optString("expires_at"),
                            createdAt = item.optString("created_at"),
                        ))
                    }
                }.filter { it.id.isNotBlank() && it.type.isNotBlank() }
                val dao = MobileDatabase.get(context).mobileDao()
                dao.saveCommands(commands)
                dao.pruneCommands(GatewayTimestamp.now())
                commands.forEach { MobileNotifications.showCommand(context, it) }
                MobileApiResult.Success(commands)
            }
            is MobileApiResult.Retry -> result
            is MobileApiResult.Failure -> result
        }
    }

    fun acknowledgeCommand(context: Context, commandId: String, status: String, result: JSONObject = JSONObject()): MobileApiResult<Unit> {
        val body = JSONObject().put("status", status).put("result", result)
        val response = request(context, "/api/mobile/v1/commands/${java.net.URLEncoder.encode(commandId, "UTF-8")}/ack", "POST", body)
        if (response is MobileApiResult.Success) MobileDatabase.get(context).mobileDao().updateCommand(commandId, status)
        return response.mapUnit()
    }

    fun syncCallerCache(context: Context): MobileApiResult<Unit> {
        return when (val result = request(context, "/api/mobile/v1/customer-cache?limit=1000", "GET", null)) {
            is MobileApiResult.Success -> {
                val array = result.value.optJSONArray("customers") ?: JSONArray()
                val callers = buildList {
                    for (index in 0 until array.length()) {
                        val item = array.optJSONObject(index) ?: continue
                        val phone = GatewayRepository.normalizePhone(item.optString("phone"))
                        if (phone.isBlank()) continue
                        add(CallerCacheEntity(
                            phone = phone,
                            name = item.optString("name"),
                            company = item.optString("city"),
                            ownerName = item.optString("assigned_to"),
                            lastDeal = item.optString("latest_deal"),
                            overdue = item.optBoolean("has_overdue_task"),
                            updatedAt = System.currentTimeMillis(),
                        ))
                    }
                }
                val dao = MobileDatabase.get(context).mobileDao()
                dao.clearCallers()
                if (callers.isNotEmpty()) dao.saveCallers(callers)
                MobileApiResult.Success(Unit)
            }
            is MobileApiResult.Retry -> result
            is MobileApiResult.Failure -> result
        }
    }

    fun syncDashboard(context: Context): MobileApiResult<MobileDashboardSummary> {
        return when (val result = request(context, "/api/mobile/v1/dashboard", "GET", null)) {
            is MobileApiResult.Success -> {
                val tasks = result.value.optJSONArray("tasks") ?: JSONArray()
                var overdue = 0
                val now = GatewayTimestamp.now()
                for (index in 0 until tasks.length()) {
                    val due = tasks.optJSONObject(index)?.optString("due_date").orEmpty()
                    if (due.isNotBlank() && due < now) overdue += 1
                }
                val calls = result.value.optJSONObject("calls") ?: JSONObject()
                val summary = MobileDashboardSummary(tasks.length(), overdue, calls.optInt("total"), calls.optInt("pending"))
                GatewayPreferences.saveMobileDashboard(context, summary)
                MobileApiResult.Success(summary)
            }
            is MobileApiResult.Retry -> result
            is MobileApiResult.Failure -> result
        }
    }

    private fun request(context: Context, path: String, method: String, body: JSONObject?): MobileApiResult<JSONObject> {
        val config = GatewayPreferences.config(context)
        if (config.serverUrl.isBlank() || config.token.isBlank()) return MobileApiResult.Failure("ربط CRM غير مكتمل.")
        return try {
            val connection = (URL("${config.serverUrl.trimEnd('/')}$path").openConnection() as HttpURLConnection).apply {
                requestMethod = method
                connectTimeout = 15_000
                readTimeout = 20_000
                useCaches = false
                setRequestProperty("Accept", "application/json")
                setRequestProperty("x-mobile-token", config.token)
                setRequestProperty("User-Agent", "BreeXeConnect/${BuildConfig.VERSION_NAME}")
                if (body != null) {
                    doOutput = true
                    setRequestProperty("Content-Type", "application/json; charset=utf-8")
                }
            }
            try {
                if (body != null) connection.outputStream.use { it.write(body.toString().toByteArray()) }
                val code = connection.responseCode
                val stream = if (code in 200..299) connection.inputStream else connection.errorStream
                val raw = stream?.bufferedReader()?.use { it.readText() }.orEmpty()
                val json = runCatching { JSONObject(raw.ifBlank { "{}" }) }.getOrDefault(JSONObject())
                when {
                    code in 200..299 -> MobileApiResult.Success(json)
                    code in listOf(408, 425, 429) || code >= 500 -> MobileApiResult.Retry(json.optString("error", "CRM غير متاح مؤقتًا (HTTP $code)."))
                    else -> MobileApiResult.Failure(json.optString("error", "رفض CRM الطلب (HTTP $code)."))
                }
            } finally {
                connection.disconnect()
            }
        } catch (error: IOException) {
            MobileApiResult.Retry(error.message ?: "تعذر الاتصال بالـ CRM.")
        } catch (error: Exception) {
            MobileApiResult.Failure(error.message ?: "تعذر تنفيذ طلب الجوال.")
        }
    }

    private fun batteryPercent(context: Context): Int =
        (context.getSystemService(Context.BATTERY_SERVICE) as? BatteryManager)?.getIntProperty(BatteryManager.BATTERY_PROPERTY_CAPACITY)?.coerceIn(0, 100) ?: 0

    private fun networkType(context: Context): String {
        val manager = context.getSystemService(ConnectivityManager::class.java) ?: return "offline"
        val capabilities = manager.getNetworkCapabilities(manager.activeNetwork) ?: return "offline"
        return when {
            capabilities.hasTransport(android.net.NetworkCapabilities.TRANSPORT_WIFI) -> "wifi"
            capabilities.hasTransport(android.net.NetworkCapabilities.TRANSPORT_CELLULAR) -> "cellular"
            capabilities.hasTransport(android.net.NetworkCapabilities.TRANSPORT_ETHERNET) -> "ethernet"
            else -> "other"
        }
    }
}

private fun MobileApiResult<JSONObject>.mapUnit(): MobileApiResult<Unit> = when (this) {
    is MobileApiResult.Success -> MobileApiResult.Success(Unit)
    is MobileApiResult.Retry -> this
    is MobileApiResult.Failure -> this
}
