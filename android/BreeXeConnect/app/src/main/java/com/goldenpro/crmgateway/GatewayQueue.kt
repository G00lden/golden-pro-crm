package com.goldenpro.crmgateway

// Durable SQLCipher-backed Room queue preserving events across restarts and network loss.

import android.content.Context
import androidx.core.content.edit
import org.json.JSONArray
import org.json.JSONObject

object GatewayQueue {
    private const val LEGACY_PREFS = "crm_gateway_queue"
    private const val LEGACY_EVENTS = "events"
    private const val META_PREFS = "crm_gateway_queue_meta"
    private const val DROPPED_EVENTS = "dropped_events"
    private const val MIGRATED = "room_migrated"
    const val MAX_EVENTS = 1000
    private val lock = Any()

    fun add(context: Context, event: GatewayEvent) = synchronized(lock) {
        migrateLegacy(context)
        val dao = MobileDatabase.get(context).mobileDao()
        val count = dao.eventCount()
        if (count >= MAX_EVENTS) {
            val removeCount = count - MAX_EVENTS + 1
            dao.removeEvents(dao.oldestEventIds(removeCount))
            incrementDropped(context, removeCount)
        }
        val inserted = dao.addEvent(
            MobileEventEntity(event.id, event.toJson().toString(), event.source, System.currentTimeMillis()),
        )
        if (inserted == -1L) return@synchronized
        GatewayActivityLog.add(
            context,
            "queued",
            "تم التقاط حدث مكالمة",
            "${event.dispositionLabel()} · ${GatewayActivityLog.maskedPhone(event.from)}",
        )
    }

    fun snapshot(context: Context): List<GatewayEvent> = synchronized(lock) {
        migrateLegacy(context)
        MobileDatabase.get(context).mobileDao().events(MAX_EVENTS).mapNotNull(::decode)
    }

    fun batch(context: Context, limit: Int = 100): List<GatewayEvent> = synchronized(lock) {
        migrateLegacy(context)
        MobileDatabase.get(context).mobileDao().events(limit.coerceIn(1, 100)).mapNotNull(::decode)
    }

    fun first(context: Context): GatewayEvent? = batch(context, 1).firstOrNull()

    fun remove(context: Context, id: String) = synchronized(lock) {
        MobileDatabase.get(context).mobileDao().removeEvents(listOf(id))
    }

    fun removeBatch(context: Context, ids: List<String>) = synchronized(lock) {
        if (ids.isNotEmpty()) MobileDatabase.get(context).mobileDao().removeEvents(ids)
    }

    fun size(context: Context): Int = synchronized(lock) {
        migrateLegacy(context)
        MobileDatabase.get(context).mobileDao().eventCount()
    }

    fun stats(context: Context): GatewayQueueStats = synchronized(lock) {
        migrateLegacy(context)
        val dao = MobileDatabase.get(context).mobileDao()
        GatewayQueueStats(
            pending = dao.eventCount(),
            testEvents = dao.testEventCount(),
            dropped = context.getSharedPreferences(META_PREFS, Context.MODE_PRIVATE).getInt(DROPPED_EVENTS, 0),
            capacity = MAX_EVENTS,
            legacyWasFull = false,
        )
    }

    fun clearTestEvents(context: Context): Int = synchronized(lock) {
        migrateLegacy(context)
        MobileDatabase.get(context).mobileDao().clearTestEvents()
    }

    private fun decode(entity: MobileEventEntity): GatewayEvent? =
        runCatching { GatewayEvent.fromJson(JSONObject(entity.payload)) }.getOrNull()

    private fun migrateLegacy(context: Context) {
        val meta = context.getSharedPreferences(META_PREFS, Context.MODE_PRIVATE)
        if (meta.getBoolean(MIGRATED, false)) return
        val legacy = context.getSharedPreferences(LEGACY_PREFS, Context.MODE_PRIVATE)
        val raw = legacy.getString(LEGACY_EVENTS, "[]").orEmpty()
        val dao = MobileDatabase.get(context).mobileDao()
        runCatching {
            val array = JSONArray(raw)
            for (index in 0 until array.length()) {
                val event = GatewayEvent.fromJson(array.getJSONObject(index))
                dao.addEvent(MobileEventEntity(event.id, event.toJson().toString(), event.source, System.currentTimeMillis() + index))
            }
        }
        meta.edit(commit = true) { putBoolean(MIGRATED, true) }
        legacy.edit { remove(LEGACY_EVENTS) }
    }

    private fun incrementDropped(context: Context, count: Int) {
        val prefs = context.getSharedPreferences(META_PREFS, Context.MODE_PRIVATE)
        prefs.edit(commit = true) { putInt(DROPPED_EVENTS, prefs.getInt(DROPPED_EVENTS, 0) + count) }
    }
}

data class GatewayQueueStats(
    val pending: Int,
    val testEvents: Int,
    val dropped: Int,
    val capacity: Int,
    val legacyWasFull: Boolean,
)

private fun GatewayEvent.dispositionLabel(): String = when (disposition) {
    "answered" -> "تم الرد"
    "no_answer" -> "لم يتم الرد"
    "busy" -> "مشغول"
    "unreachable" -> "مغلق أو خارج التغطية"
    "rejected" -> "مرفوضة"
    "after_hours" -> "خارج الدوام"
    "outgoing" -> "صادرة"
    else -> "حدث مكالمة"
}
