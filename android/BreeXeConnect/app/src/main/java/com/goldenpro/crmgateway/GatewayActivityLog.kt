package com.goldenpro.crmgateway

// Privacy-safe local operational history.

import android.content.Context
import androidx.core.content.edit
import org.json.JSONArray
import org.json.JSONObject
import java.util.UUID

data class GatewayActivityEntry(
    val id: String = UUID.randomUUID().toString(),
    val kind: String,
    val title: String,
    val detail: String = "",
    val occurredAt: Long = System.currentTimeMillis(),
)

object GatewayActivityLog {
    private const val PREFS = "crm_gateway_activity"
    private const val ENTRIES = "entries"
    private const val MAX_ENTRIES = 100
    private val lock = Any()

    fun add(context: Context, kind: String, title: String, detail: String = "") = synchronized(lock) {
        val entries = (read(context) + GatewayActivityEntry(kind = kind, title = title, detail = detail))
            .takeLast(MAX_ENTRIES)
        write(context, entries)
    }

    fun list(context: Context): List<GatewayActivityEntry> = synchronized(lock) {
        read(context).sortedByDescending { it.occurredAt }
    }

    fun clear(context: Context) = synchronized(lock) { write(context, emptyList()) }

    fun maskedPhone(value: String): String {
        val normalized = GatewayRepository.normalizePhone(value)
        if (normalized.length <= 4) return "رقم غير متاح"
        return "••••${normalized.takeLast(4)}"
    }

    private fun read(context: Context): List<GatewayActivityEntry> {
        val raw = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE).getString(ENTRIES, "[]").orEmpty()
        return runCatching {
            val array = JSONArray(raw)
            buildList {
                for (index in 0 until array.length()) {
                    val item = array.getJSONObject(index)
                    add(
                        GatewayActivityEntry(
                            id = item.optString("id"),
                            kind = item.optString("kind"),
                            title = item.optString("title"),
                            detail = item.optString("detail"),
                            occurredAt = item.optLong("occurredAt"),
                        ),
                    )
                }
            }
        }.getOrDefault(emptyList())
    }

    private fun write(context: Context, entries: List<GatewayActivityEntry>) {
        val array = JSONArray()
        entries.forEach { entry ->
            array.put(
                JSONObject()
                    .put("id", entry.id)
                    .put("kind", entry.kind)
                    .put("title", entry.title)
                    .put("detail", entry.detail)
                    .put("occurredAt", entry.occurredAt),
            )
        }
        context.getSharedPreferences(PREFS, Context.MODE_PRIVATE).edit { putString(ENTRIES, array.toString()) }
    }
}
