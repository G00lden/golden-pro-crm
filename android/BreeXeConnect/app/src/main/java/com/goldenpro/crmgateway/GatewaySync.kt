package com.goldenpro.crmgateway

// Network repository and WorkManager synchronization boundary.

import android.content.Context
import androidx.work.BackoffPolicy
import androidx.work.Constraints
import androidx.work.ExistingWorkPolicy
import androidx.work.ExistingPeriodicWorkPolicy
import androidx.work.NetworkType
import androidx.work.OneTimeWorkRequestBuilder
import androidx.work.PeriodicWorkRequestBuilder
import androidx.work.WorkManager
import androidx.work.Worker
import androidx.work.WorkerParameters
import org.json.JSONObject
import java.io.IOException
import java.net.HttpURLConnection
import java.net.SocketException
import java.net.SocketTimeoutException
import java.net.UnknownHostException
import java.net.URL
import javax.net.ssl.SSLException
import java.util.concurrent.TimeUnit
import java.util.UUID

object GatewayRepository {
    fun enqueue(context: Context, type: String, from: String, text: String = "") {
        val config = GatewayPreferences.config(context)
        val number = normalizePhone(from)
        if (number.isBlank()) {
            GatewayPreferences.markError(context, "تعذّر إرسال الحدث لأن رقم المتصل غير متاح.")
            return
        }
        GatewayQueue.add(
            context,
            GatewayEvent(
                type = type,
                from = number,
                to = normalizePhone(config.companyNumber),
                text = text,
                device = config.deviceName,
            ),
        )
        GatewaySync.schedule(context)
    }

    fun normalizePhone(value: String): String {
        val trimmed = value.trim()
        if (trimmed.isBlank()) return ""
        val digits = trimmed.filter(Char::isDigit)
        return when {
            trimmed.startsWith("+") -> "+$digits"
            trimmed.startsWith("00") -> "+${digits.drop(2)}"
            digits.length == 10 && digits.startsWith("0") -> "+966${digits.drop(1)}"
            digits.length == 9 && digits.startsWith("5") -> "+966$digits"
            else -> digits
        }
    }

    fun enqueue(context: Context, event: GatewayEvent) {
        if (event.from.isBlank()) {
            GatewayPreferences.markError(context, "تعذّر إرسال الحدث لأن رقم المكالمة غير متاح.")
            return
        }
        GatewayQueue.add(context, event)
        GatewaySync.schedule(context)
    }

    fun enqueueTest(context: Context, type: String, from: String) {
        val config = GatewayPreferences.config(context)
        val number = normalizePhone(from)
        if (number.isBlank()) {
            GatewayPreferences.markError(context, "أدخل رقمًا صحيحًا للحدث التجريبي.")
            return
        }
        val disposition = when (type) {
            "missed_call" -> "no_answer"
            else -> type
        }
        enqueue(
            context,
            GatewayEvent(
                id = "android-test-${UUID.randomUUID()}",
                type = type,
                from = number,
                to = normalizePhone(config.companyNumber),
                device = config.deviceName,
                source = "android_test",
                disposition = disposition,
            ),
        )
    }
}

object GatewaySync {
    private const val UNIQUE_WORK = "crm-gateway-event-sync"
    private const val PERIODIC_WORK = "crm-gateway-contact-sync-periodic"

    private fun networkConstraints() = Constraints.Builder()
        .setRequiredNetworkType(NetworkType.CONNECTED)
        .build()

    fun schedule(context: Context) {
        val request = OneTimeWorkRequestBuilder<GatewaySyncWorker>()
            .setConstraints(networkConstraints())
            .setBackoffCriteria(BackoffPolicy.EXPONENTIAL, 10, TimeUnit.SECONDS)
            .build()
        WorkManager.getInstance(context).enqueueUniqueWork(
            UNIQUE_WORK,
            ExistingWorkPolicy.KEEP,
            request,
        )
    }

    fun schedulePeriodic(context: Context) {
        val request = PeriodicWorkRequestBuilder<GatewaySyncWorker>(15, TimeUnit.MINUTES)
            .setConstraints(networkConstraints())
            .build()
        WorkManager.getInstance(context).enqueueUniquePeriodicWork(
            PERIODIC_WORK,
            ExistingPeriodicWorkPolicy.KEEP,
            request,
        )
    }
}

class GatewaySyncWorker(
    context: Context,
    parameters: WorkerParameters,
) : Worker(context, parameters) {
    override fun doWork(): Result {
        val configError = GatewayConfigValidator.firstError(GatewayPreferences.config(applicationContext))
        if (configError != null) {
            GatewayPreferences.markConfigurationError(applicationContext, configError)
            return Result.failure()
        }
        GatewayPreferences.markSending(applicationContext)

        when (val profile = MobileApi.syncProfile(applicationContext)) {
            is MobileApiResult.Retry -> return retry(profile.message)
            is MobileApiResult.Failure -> return fail(profile.message)
            is MobileApiResult.Success -> Unit
        }
        when (val policy = MobileApi.fetchPolicy(applicationContext)) {
            is MobileApiResult.Retry -> return retry(policy.message)
            is MobileApiResult.Failure -> return fail(policy.message)
            is MobileApiResult.Success -> Unit
        }

        val events = GatewayQueue.batch(applicationContext, MAX_EVENTS_PER_RUN)
        when (val sent = MobileApi.sendEvents(applicationContext, events)) {
            is MobileApiResult.Success -> {
                GatewayQueue.removeBatch(applicationContext, events.map { it.id })
                events.forEach { event -> GatewayActivityLog.add(applicationContext, "sent", "تم إرسال الحدث إلى CRM", GatewayActivityLog.maskedPhone(event.from)) }
            }
            is MobileApiResult.Retry -> return retry(sent.message)
            is MobileApiResult.Failure -> return fail(sent.message)
        }
        // A unique WorkManager request cannot enqueue itself while it is still
        // running. Retry this request so batches larger than MAX_EVENTS_PER_RUN
        // are guaranteed to drain instead of waiting for the periodic fallback.
        if (GatewayQueue.size(applicationContext) > 0) return Result.retry()

        when (val cache = MobileApi.syncCallerCache(applicationContext)) {
            is MobileApiResult.Retry -> return retry(cache.message)
            is MobileApiResult.Failure -> return fail(cache.message)
            is MobileApiResult.Success -> Unit
        }
        when (val dashboard = MobileApi.syncDashboard(applicationContext)) {
            is MobileApiResult.Retry -> return retry(dashboard.message)
            is MobileApiResult.Failure -> return fail(dashboard.message)
            is MobileApiResult.Success -> Unit
        }
        when (val commands = MobileApi.fetchCommands(applicationContext)) {
            is MobileApiResult.Retry -> return retry(commands.message)
            is MobileApiResult.Failure -> return fail(commands.message)
            is MobileApiResult.Success -> Unit
        }

        GatewayPreferences.markSuccess(applicationContext, "تمت مزامنة المكالمات والعملاء والأوامر مع CRM.")
        return Result.success()
    }

    companion object {
        private const val MAX_EVENTS_PER_RUN = 100
    }

    private fun retry(message: String): Result {
        GatewayPreferences.markError(applicationContext, message)
        return Result.retry()
    }

    private fun fail(message: String): Result {
        GatewayPreferences.markError(applicationContext, message)
        return Result.failure()
    }
}

sealed interface HttpResult {
    data object Success : HttpResult
    data class RetryableFailure(val message: String) : HttpResult
    data class PermanentFailure(val message: String) : HttpResult
}

sealed interface PairingResult {
    data class Success(val token: String, val deviceId: String) : PairingResult
    data class Failure(val message: String) : PairingResult
}

object GatewayHttp {
    private data class Response(val result: HttpResult, val body: String, val code: Int? = null)

    fun pair(
        serverUrl: String,
        pairingCode: String,
        deviceName: String,
        companyNumber: String,
    ): PairingResult {
        GatewayConfigValidator.firstPairingError(serverUrl, companyNumber, deviceName, pairingCode)?.let {
            return PairingResult.Failure(it)
        }
        val clientNonce = UUID.randomUUID().toString().replace("-", "")
        val response = requestWithBody(
            url = "${serverUrl.trim().trimEnd('/')}/api/mobile/v1/pair",
            method = "POST",
            token = "",
            body = JSONObject()
                .put("code", pairingCode)
                .put("deviceName", deviceName.trim())
                .put("companyNumber", GatewayRepository.normalizePhone(companyNumber))
                .put("clientNonce", clientNonce)
                .toString(),
        )
        when (val result = response.result) {
            HttpResult.Success -> {
                val json = runCatching { JSONObject(response.body) }.getOrNull()
                    ?: return PairingResult.Failure("استجابة الربط من CRM غير صالحة. أعد المحاولة.")
                val token = json.optString("token")
                val deviceId = json.optString("deviceId")
                if (token.isBlank() || deviceId.isBlank()) {
                    return PairingResult.Failure("لم يُرجع CRM بيانات الجهاز. أنشئ رمزًا جديدًا وأعد المحاولة.")
                }
                return PairingResult.Success(token, deviceId)
            }
            is HttpResult.PermanentFailure -> return PairingResult.Failure(result.message)
            is HttpResult.RetryableFailure -> return PairingResult.Failure(result.message)
        }
    }

    fun send(context: Context, event: GatewayEvent): HttpResult {
        val config = GatewayPreferences.config(context)
        GatewayConfigValidator.firstError(config)?.let { return HttpResult.PermanentFailure(it) }
        return request(
            url = "${config.serverUrl.trimEnd('/')}/api/gateway/event",
            method = "POST",
            token = config.token,
            body = event.toJson().toString(),
        )
    }

    fun checkConnection(context: Context): HttpResult {
        val config = GatewayPreferences.config(context)
        GatewayConfigValidator.firstError(config)?.let { return HttpResult.PermanentFailure(it) }
        return request(
            url = "${config.serverUrl.trimEnd('/')}/api/gateway/next",
            method = "GET",
            token = config.token,
            body = null,
        )
    }

    fun probe(context: Context): HttpResult {
        val result = checkConnection(context)
        when (result) {
            HttpResult.Success -> GatewayPreferences.markSuccess(context)
            is HttpResult.PermanentFailure -> GatewayPreferences.markError(context, result.message)
            is HttpResult.RetryableFailure -> GatewayPreferences.markError(context, result.message)
        }
        return result
    }

    fun syncContacts(context: Context): HttpResult {
        val config = GatewayPreferences.config(context)
        GatewayConfigValidator.firstError(config)?.let { return HttpResult.PermanentFailure(it) }
        val response = requestWithBody(
            url = "${config.serverUrl.trimEnd('/')}/api/gateway/contacts?limit=100",
            method = "GET",
            token = config.token,
            body = null,
        )
        if (response.result != HttpResult.Success) {
            // Servers deployed before contact sync placed this path behind the
            // normal CRM auth guard. Event delivery still works; retry contact
            // sync after the server update is deployed instead of blocking calls.
            val oldServer = response.code == 404 || (
                response.code == 401 && response.body.contains("Authentication token is required", ignoreCase = true)
            )
            return if (oldServer) HttpResult.Success else response.result
        }
        val contacts = runCatching { JSONObject(response.body).optJSONArray("contacts") }
            .getOrNull() ?: return HttpResult.RetryableFailure("استجابة جهات الاتصال من CRM غير صالحة.")
        val savedIds = mutableListOf<String>()
        for (index in 0 until contacts.length()) {
            val contact = contacts.optJSONObject(index) ?: continue
            val id = contact.optString("id")
            val phone = contact.optString("phone")
            if (id.isBlank() || phone.isBlank()) continue
            if (!ContactSaver.saveCaller(context, phone)) {
                return HttpResult.RetryableFailure("تعذر حفظ جهة اتصال المتصل. امنح صلاحية جهات الاتصال ثم أعد المحاولة.")
            }
            savedIds += id
        }
        if (savedIds.isEmpty()) return HttpResult.Success
        val ackBody = JSONObject().put("ids", org.json.JSONArray(savedIds)).toString()
        return request(
            url = "${config.serverUrl.trimEnd('/')}/api/gateway/contacts/ack",
            method = "POST",
            token = config.token,
            body = ackBody,
        )
    }

    private fun request(url: String, method: String, token: String, body: String?): HttpResult {
        return requestWithBody(url, method, token, body).result
    }

    private fun requestWithBody(url: String, method: String, token: String, body: String?): Response {
        repeat(NETWORK_ATTEMPTS) { attempt ->
            try {
                return executeRequest(url, method, token, body)
            } catch (error: Exception) {
                val retryable = error is IOException
                if (!retryable || attempt == NETWORK_ATTEMPTS - 1) {
                    return Response(HttpResult.RetryableFailure(friendlyNetworkMessage(error)), "")
                }
            }
        }
        return Response(HttpResult.RetryableFailure("تعذر الاتصال بالخادم بعد إعادة المحاولة."), "")
    }

    private fun executeRequest(url: String, method: String, token: String, body: String?): Response {
        val connection = (URL(url).openConnection() as HttpURLConnection).apply {
            requestMethod = method
            connectTimeout = 15_000
            readTimeout = 20_000
            useCaches = false
            setRequestProperty("Accept", "application/json")
            setRequestProperty("Accept-Encoding", "identity")
            setRequestProperty("Connection", "close")
            setRequestProperty("User-Agent", "BreeXeConnect/${BuildConfig.VERSION_NAME}")
            if (token.isNotBlank()) setRequestProperty("x-gateway-token", token)
        }
        return try {
            if (body != null) {
                connection.doOutput = true
                connection.setRequestProperty("Content-Type", "application/json; charset=utf-8")
                connection.outputStream.use { it.write(body.toByteArray(Charsets.UTF_8)) }
            }
            val code = connection.responseCode
            val stream = if (code in 200..299) connection.inputStream else connection.errorStream
            val responseBody = stream?.bufferedReader()?.use { it.readText() }.orEmpty()
            val result = when {
                code in 200..299 && responseBody.contains("\"received\":false") ->
                    HttpResult.RetryableFailure("لم يؤكد الخادم استلام الحدث. ستتم إعادة المحاولة.")
                code in 200..299 -> HttpResult.Success
                code in listOf(408, 425, 429) || code >= 500 ->
                    HttpResult.RetryableFailure(serverMessage(code, responseBody))
                code in 400..499 -> HttpResult.PermanentFailure(serverMessage(code, responseBody))
                else -> HttpResult.RetryableFailure(serverMessage(code, responseBody))
            }
            Response(result, responseBody, code)
        } finally {
            connection.disconnect()
        }
    }

    private fun serverMessage(code: Int, body: String): String {
        val detail = runCatching {
            val json = JSONObject(body)
            json.optString("error").ifBlank { json.optString("message") }
        }.getOrDefault("")
        return when (code) {
            400 -> if (detail.isBlank()) "بيانات الطلب غير صحيحة. تحقق منها وأعد المحاولة." else detail
            401 -> "انتهت صلاحية ربط هذا الجوال أو أُلغي من CRM. اربطه من جديد برمز مؤقت."
            403 -> "الخادم رفض صلاحية هذا الجوال. اربطه من جديد من شاشة نظام المكالمات."
            404 -> "مسار بوابة أندرويد غير منشور على الخادم بعد. انشر آخر تحديث للـ CRM."
            408 -> "انتهت مهلة طلب الخادم. ستتم إعادة المحاولة تلقائيًا."
            429 -> "الخادم استقبل طلبات كثيرة. ستتم إعادة المحاولة تلقائيًا."
            in 500..599 -> "خادم CRM غير متاح مؤقتًا (HTTP $code). ستتم إعادة المحاولة."
            else -> if (detail.isBlank()) "استجاب الخادم برمز HTTP $code." else "HTTP $code: $detail"
        }
    }

    private fun friendlyNetworkMessage(error: Exception): String = when (error) {
        is UnknownHostException -> "تعذر العثور على نطاق CRM. تحقق من الرابط والإنترنت وDNS."
        is SocketTimeoutException -> "انتهت مهلة الاتصال بخادم CRM. تحقق من الإنترنت ثم أعد المحاولة."
        is SSLException -> "فشل الاتصال الآمن HTTPS. تحقق من شهادة النطاق وتاريخ الجوال."
        is SocketException -> "انقطع اتصال الشبكة بالخادم. احتفظنا بالأحداث وسنعيد المحاولة تلقائيًا."
        else -> "تعذر الوصول إلى CRM عبر الشبكة: ${error.message ?: "خطأ غير معروف"}"
    }

    private const val NETWORK_ATTEMPTS = 2
}
