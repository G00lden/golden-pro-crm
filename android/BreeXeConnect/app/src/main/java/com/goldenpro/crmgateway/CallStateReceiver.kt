package com.goldenpro.crmgateway

// Android telephony adapter; business rules remain in CallStateMachine.

import android.Manifest
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.provider.CallLog
import android.telephony.TelephonyManager
import androidx.core.content.ContextCompat
import androidx.core.content.edit
import androidx.work.Data
import androidx.work.ExistingPeriodicWorkPolicy
import androidx.work.OneTimeWorkRequestBuilder
import androidx.work.PeriodicWorkRequestBuilder
import androidx.work.WorkManager
import androidx.work.Worker
import androidx.work.WorkerParameters
import org.json.JSONObject
import java.util.concurrent.TimeUnit

class CallStateReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        if (intent.action != TelephonyManager.ACTION_PHONE_STATE_CHANGED) return
        val state = intent.getStringExtra(TelephonyManager.EXTRA_STATE) ?: return
        val incomingNumber = if (intent.hasExtra(TelephonyManager.EXTRA_INCOMING_NUMBER)) {
            intent.getStringExtra(TelephonyManager.EXTRA_INCOMING_NUMBER)
        } else {
            null
        }
        val store = CallSessionStore(context)
        val current = store.load()
        val transition = CallStateMachine.transition(current, state, incomingNumber)
        store.save(transition.session)
        transition.signals.filter { it.type == "incoming_call" }.forEach { signal ->
            GatewayRepository.enqueue(context, signal.type, signal.number)
        }
        if (state == TelephonyManager.EXTRA_STATE_IDLE) {
            CallLogSyncWorker.schedule(context, 2)
        }
    }
}

class CallLogSyncWorker(
    context: Context,
    parameters: WorkerParameters,
) : Worker(context, parameters) {
    override fun doWork(): Result {
        if (ContextCompat.checkSelfPermission(applicationContext, Manifest.permission.READ_CALL_LOG) != PackageManager.PERMISSION_GRANTED) {
            return Result.failure()
        }
        val prefs = applicationContext.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
        val lastId = prefs.getLong(KEY_LAST_ID, 0)
        val projection = arrayOf(
            CallLog.Calls._ID,
            CallLog.Calls.NUMBER,
            CallLog.Calls.TYPE,
            CallLog.Calls.DATE,
            CallLog.Calls.DURATION,
            CallLog.Calls.PHONE_ACCOUNT_ID,
        )
        val selection: String
        val args: Array<String>
        if (lastId > 0) {
            selection = "${CallLog.Calls._ID} > ?"
            args = arrayOf(lastId.toString())
        } else {
            selection = "${CallLog.Calls.DATE} >= ?"
            args = arrayOf((System.currentTimeMillis() - TimeUnit.MINUTES.toMillis(5)).toString())
        }

        var newestId = lastId
        val scanned = runCatching {
            applicationContext.contentResolver.query(
                CallLog.Calls.CONTENT_URI,
                projection,
                selection,
                args,
                "${CallLog.Calls._ID} ASC",
            )?.use { cursor ->
                val idIndex = cursor.getColumnIndexOrThrow(CallLog.Calls._ID)
                val numberIndex = cursor.getColumnIndexOrThrow(CallLog.Calls.NUMBER)
                val typeIndex = cursor.getColumnIndexOrThrow(CallLog.Calls.TYPE)
                val dateIndex = cursor.getColumnIndexOrThrow(CallLog.Calls.DATE)
                val durationIndex = cursor.getColumnIndexOrThrow(CallLog.Calls.DURATION)
                val accountIndex = cursor.getColumnIndex(CallLog.Calls.PHONE_ACCOUNT_ID)
                while (cursor.moveToNext()) {
                    val id = cursor.getLong(idIndex)
                    val number = GatewayRepository.normalizePhone(cursor.getString(numberIndex).orEmpty())
                    val disposition = dispositionFor(cursor.getInt(typeIndex))
                    newestId = maxOf(newestId, id)
                    if (number.isBlank()) continue
                    val phoneAccountId = if (accountIndex >= 0) cursor.getString(accountIndex).orEmpty() else ""
                    val simKey = WorkSimManager.simKeyForCall(applicationContext, phoneAccountId)
                    if (!WorkSimManager.isSelectedWorkSim(applicationContext, simKey)) {
                        GatewayActivityLog.add(applicationContext, "ignored", "تم تجاهل مكالمة من شريحة شخصية أو غير معروفة")
                        continue
                    }
                    if (CallerContactPolicy.shouldSave(disposition)) {
                        ContactSaver.saveCaller(applicationContext, number)
                    }
                    GatewayRepository.enqueue(
                        applicationContext,
                        GatewayEvent(
                            id = "android-calllog-$id",
                            type = disposition,
                            from = number,
                            to = GatewayRepository.normalizePhone(GatewayPreferences.config(applicationContext).companyNumber),
                            timestamp = GatewayTimestamp.fromEpochMillis(cursor.getLong(dateIndex)),
                            device = GatewayPreferences.config(applicationContext).deviceName,
                            disposition = disposition,
                            durationSeconds = cursor.getLong(durationIndex),
                            phoneAccountId = "",
                            simKey = simKey,
                        ),
                    )
                    if (disposition in setOf("answered", "no_answer", "rejected")) {
                        GatewayPreferences.savePendingCall(applicationContext, PendingCallResult("android-calllog-$id", number, disposition, cursor.getLong(dateIndex)))
                    }
                }
            }
            true
        }.getOrElse {
            GatewayPreferences.markError(applicationContext, it.message ?: "تعذر قراءة سجل المكالمات.")
            false
        }
        if (!scanned) return Result.retry()
        if (newestId > lastId) prefs.edit { putLong(KEY_LAST_ID, newestId) }
        return Result.success()
    }

    private fun dispositionFor(type: Int): String = when (type) {
        CallLog.Calls.INCOMING_TYPE -> "answered"
        CallLog.Calls.OUTGOING_TYPE -> "outgoing"
        CallLog.Calls.MISSED_TYPE -> "no_answer"
        CallLog.Calls.REJECTED_TYPE -> "rejected"
        CallLog.Calls.BLOCKED_TYPE -> "blocked"
        else -> "unknown"
    }

    companion object {
        private const val PREFS = "crm_gateway_call_log"
        private const val KEY_LAST_ID = "last_id"
        private const val PERIODIC_WORK = "crm-gateway-call-log-periodic"

        fun schedule(context: Context, delaySeconds: Long = 0) {
            val request = OneTimeWorkRequestBuilder<CallLogSyncWorker>()
                .setInitialDelay(delaySeconds, TimeUnit.SECONDS)
                .build()
            WorkManager.getInstance(context).enqueue(request)
        }

        fun schedulePeriodic(context: Context) {
            val request = PeriodicWorkRequestBuilder<CallLogSyncWorker>(15, TimeUnit.MINUTES).build()
            WorkManager.getInstance(context).enqueueUniquePeriodicWork(
                PERIODIC_WORK,
                ExistingPeriodicWorkPolicy.KEEP,
                request,
            )
        }
    }
}

private class CallSessionStore(context: Context) {
    private val prefs = context.getSharedPreferences("crm_gateway_call_state", Context.MODE_PRIVATE)

    fun load(): CallSession? {
        val raw = prefs.getString("session", null) ?: return null
        return runCatching {
            val json = JSONObject(raw)
            CallSession(
                id = json.getString("id"),
                number = json.optString("number"),
                answered = json.optBoolean("answered"),
                answeredSent = json.optBoolean("answeredSent"),
                incomingSent = json.optBoolean("incomingSent"),
            )
        }.getOrNull()
    }

    fun save(session: CallSession?) {
        prefs.edit(commit = true) {
            if (session == null) {
                remove("session")
            } else {
                putString(
                    "session",
                    JSONObject()
                        .put("id", session.id)
                        .put("number", session.number)
                        .put("answered", session.answered)
                        .put("answeredSent", session.answeredSent)
                        .put("incomingSent", session.incomingSent)
                        .toString(),
                )
            }
        }
    }
}

class CallLogResolveWorker(
    context: Context,
    parameters: WorkerParameters,
) : Worker(context, parameters) {
    override fun doWork(): Result {
        if (ContextCompat.checkSelfPermission(applicationContext, Manifest.permission.READ_CALL_LOG) != PackageManager.PERMISSION_GRANTED) {
            return Result.failure()
        }
        val number = latestIncomingNumber(applicationContext)
        if (number.isBlank()) return if (runAttemptCount < 3) Result.retry() else Result.failure()
        val type = if (inputData.getBoolean(KEY_ANSWERED, false)) "call_answered" else "missed_call"
        GatewayRepository.enqueue(applicationContext, type, number)
        return Result.success()
    }

    private fun latestIncomingNumber(context: Context): String {
        val cutoff = System.currentTimeMillis() - TimeUnit.MINUTES.toMillis(3)
        val projection = arrayOf(CallLog.Calls.NUMBER)
        val selection = "${CallLog.Calls.DATE} >= ? AND ${CallLog.Calls.TYPE} IN (?, ?)"
        val args = arrayOf(
            cutoff.toString(),
            CallLog.Calls.INCOMING_TYPE.toString(),
            CallLog.Calls.MISSED_TYPE.toString(),
        )
        return runCatching {
            context.contentResolver.query(
                CallLog.Calls.CONTENT_URI,
                projection,
                selection,
                args,
                "${CallLog.Calls.DATE} DESC",
            )?.use { cursor ->
                if (cursor.moveToFirst()) cursor.getString(0).orEmpty() else ""
            }.orEmpty()
        }.getOrDefault("")
    }

    companion object {
        private const val KEY_ANSWERED = "answered"

        fun schedule(context: Context, answered: Boolean) {
            val request = OneTimeWorkRequestBuilder<CallLogResolveWorker>()
                .setInitialDelay(3, TimeUnit.SECONDS)
                .setInputData(Data.Builder().putBoolean(KEY_ANSWERED, answered).build())
                .setBackoffCriteria(androidx.work.BackoffPolicy.LINEAR, 10, TimeUnit.SECONDS)
                .build()
            WorkManager.getInstance(context).enqueue(request)
        }
    }
}
