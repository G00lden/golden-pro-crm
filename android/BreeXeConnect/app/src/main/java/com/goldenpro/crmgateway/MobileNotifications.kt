package com.goldenpro.crmgateway

import android.Manifest
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.net.Uri
import android.os.Build
import androidx.core.app.NotificationCompat
import androidx.core.app.NotificationManagerCompat
import androidx.core.content.ContextCompat
import org.json.JSONObject
import java.util.concurrent.Executors

object MobileNotifications {
    private const val COMMAND_CHANNEL = "breexe_commands"
    private const val CALLER_CHANNEL = "breexe_caller_id"

    fun ensureChannels(context: Context) {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return
        val manager = context.getSystemService(NotificationManager::class.java)
        manager.createNotificationChannel(NotificationChannel(COMMAND_CHANNEL, "أوامر CRM", NotificationManager.IMPORTANCE_HIGH))
        manager.createNotificationChannel(NotificationChannel(CALLER_CHANNEL, "تعريف المتصل", NotificationManager.IMPORTANCE_HIGH))
    }

    fun showCommand(context: Context, command: MobileCommandEntity) {
        ensureChannels(context)
        val payload = runCatching { JSONObject(command.payload) }.getOrDefault(JSONObject())
        if (command.type in setOf("collect_health", "sync_contacts", "refresh_policy")) {
            MobileCommandProcessor.executeSafe(context, command)
            return
        }
        val title: String
        val text: String
        when (command.type) {
            "dial_request" -> {
                title = "طلب اتصال من CRM"
                text = listOf(payload.optString("customerName"), payload.optString("phone"), payload.optString("reason")).filter(String::isNotBlank).joinToString(" · ")
            }
            "local_wipe" -> {
                title = "طلب مسح بيانات BreeXe"
                text = "لن يتم المسح إلا بعد تأكيدك من هذا الجوال."
            }
            else -> {
                title = "مهمة جديدة من CRM"
                text = "افتح BreeXe Connect لعرض التفاصيل."
            }
        }
        val openIntent = Intent(context, MainActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP)
        val builder = NotificationCompat.Builder(context, COMMAND_CHANNEL)
            .setSmallIcon(R.mipmap.ic_launcher)
            .setContentTitle(title)
            .setContentText(text)
            .setStyle(NotificationCompat.BigTextStyle().bigText(text))
            .setContentIntent(PendingIntent.getActivity(context, command.id.hashCode(), openIntent, PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE))
            .setAutoCancel(true)
            .setPriority(NotificationCompat.PRIORITY_HIGH)
        if (command.type == "dial_request") {
            builder.addAction(0, "اتصال", action(context, command.id, "confirm"))
            builder.addAction(0, "إلغاء", action(context, command.id, "cancel"))
        } else if (command.type == "local_wipe") {
            builder.addAction(0, "مسح بيانات التطبيق", action(context, command.id, "wipe"))
            builder.addAction(0, "إلغاء", action(context, command.id, "cancel"))
        }
        notify(context, command.id.hashCode(), builder.build())
    }

    fun showCaller(context: Context, caller: CallerCacheEntity, phone: String) {
        ensureChannels(context)
        val details = listOf(caller.company, caller.lastDeal, if (caller.overdue) "متابعة متأخرة" else "").filter(String::isNotBlank).joinToString(" · ")
        val notification = NotificationCompat.Builder(context, CALLER_CHANNEL)
            .setSmallIcon(R.mipmap.ic_launcher)
            .setContentTitle(caller.name.ifBlank { phone })
            .setContentText(details.ifBlank { "عميل مسجل في CRM" })
            .setStyle(NotificationCompat.BigTextStyle().bigText(details))
            .setPriority(NotificationCompat.PRIORITY_HIGH)
            .setCategory(NotificationCompat.CATEGORY_CALL)
            .setTimeoutAfter(30_000)
            .build()
        notify(context, phone.hashCode(), notification)
    }

    private fun action(context: Context, commandId: String, action: String): PendingIntent {
        val intent = Intent(context, MobileCommandActionReceiver::class.java).putExtra("command_id", commandId).putExtra("action", action)
        return PendingIntent.getBroadcast(context, "$commandId:$action".hashCode(), intent, PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE)
    }

    private fun notify(context: Context, id: Int, notification: android.app.Notification) {
        if (Build.VERSION.SDK_INT >= 33 && ContextCompat.checkSelfPermission(context, Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED) return
        NotificationManagerCompat.from(context).notify(id, notification)
    }
}

object MobileCommandProcessor {
    private val executor = Executors.newSingleThreadExecutor()

    fun executeSafe(context: Context, command: MobileCommandEntity) {
        executor.execute {
            val result = when (command.type) {
                "collect_health" -> MobileApi.syncProfile(context)
                "sync_contacts" -> MobileApi.syncCallerCache(context)
                "refresh_policy" -> MobileApi.fetchPolicy(context).mapToUnit()
                else -> MobileApiResult.Failure("الأمر يحتاج موافقة الموظف.")
            }
            when (result) {
                is MobileApiResult.Success -> MobileApi.acknowledgeCommand(context, command.id, "completed")
                is MobileApiResult.Failure -> MobileApi.acknowledgeCommand(context, command.id, "failed", JSONObject().put("error", result.message))
                is MobileApiResult.Retry -> GatewaySync.schedule(context)
            }
        }
    }

    private fun MobileApiResult<MobilePolicy>.mapToUnit(): MobileApiResult<Unit> = when (this) {
        is MobileApiResult.Success -> MobileApiResult.Success(Unit)
        is MobileApiResult.Failure -> this
        is MobileApiResult.Retry -> this
    }
}

class MobileCommandActionReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        val commandId = intent.getStringExtra("command_id").orEmpty()
        val action = intent.getStringExtra("action").orEmpty()
        val command = MobileDatabase.get(context).mobileDao().command(commandId) ?: return
        val pending = goAsync()
        Executors.newSingleThreadExecutor().execute {
            try {
                when (action) {
                    "confirm" -> confirmDial(context, command)
                    "wipe" -> wipeLocalData(context, command)
                    else -> MobileApi.acknowledgeCommand(context, command.id, "cancelled")
                }
                NotificationManagerCompat.from(context).cancel(command.id.hashCode())
            } finally {
                pending.finish()
            }
        }
    }

    private fun confirmDial(context: Context, command: MobileCommandEntity) {
        val payload = runCatching { JSONObject(command.payload) }.getOrDefault(JSONObject())
        val phone = GatewayRepository.normalizePhone(payload.optString("phone"))
        if (phone.isBlank()) {
            MobileApi.acknowledgeCommand(context, command.id, "failed", JSONObject().put("error", "invalid_phone"))
            return
        }
        val confirmed = MobileApi.acknowledgeCommand(context, command.id, "confirmed")
        if (confirmed !is MobileApiResult.Success) return
        context.startActivity(Intent(Intent.ACTION_DIAL, Uri.parse("tel:$phone")).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
        MobileApi.acknowledgeCommand(context, command.id, "completed", JSONObject().put("openedDialer", true))
    }

    private fun wipeLocalData(context: Context, command: MobileCommandEntity) {
        MobileApi.acknowledgeCommand(context, command.id, "confirmed")
        val dao = MobileDatabase.get(context).mobileDao()
        dao.clearEvents()
        dao.wipeCallerCache()
        dao.clearCommands()
        MobileApi.acknowledgeCommand(context, command.id, "completed", JSONObject().put("localDataWiped", true))
        GatewayPreferences.clearPairing(context)
    }
}
