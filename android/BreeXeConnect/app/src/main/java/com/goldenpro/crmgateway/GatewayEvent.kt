package com.goldenpro.crmgateway

// Canonical event contract sent to the CRM gateway.

import org.json.JSONObject
import java.util.UUID

data class GatewayEvent(
    val id: String = UUID.randomUUID().toString(),
    val type: String,
    val from: String,
    val to: String,
    val text: String = "",
    val timestamp: String = GatewayTimestamp.now(),
    val device: String = "",
    val source: String = "android",
    val disposition: String = "unknown",
    val durationSeconds: Long = 0,
    val phoneAccountId: String = "",
    val simKey: String = "",
    val relatedCallSid: String = "",
) {
    fun toJson(): JSONObject = JSONObject()
        .put("id", id)
        .put("eventId", id)
        .put("callSid", id)
        .put("type", type)
        .put("from", from)
        .put("to", to)
        .put("ts", timestamp)
        .put("occurredAt", timestamp)
        .put("device", device)
        .put("source", source)
        .put("disposition", disposition)
        .put("durationSeconds", durationSeconds)
        .put("phoneAccountId", phoneAccountId)
        .also { if (simKey.isNotBlank()) it.put("simKey", simKey) }
        .also { if (relatedCallSid.isNotBlank()) it.put("relatedCallSid", relatedCallSid) }
        .also { if (text.isNotBlank()) it.put("text", text) }

    fun toMobileEnvelope(): JSONObject = JSONObject()
        .put("schemaVersion", 1)
        .put("eventId", id)
        .put("type", type)
        .put("occurredAt", timestamp)
        .also { if (simKey.isNotBlank()) it.put("simKey", simKey) }
        .put(
            "payload",
            JSONObject()
                .put("callSid", relatedCallSid.ifBlank { id })
                .put("from", from)
                .put("to", to)
                .put("device", device)
                .put("source", source)
                .put("disposition", disposition)
                .put("durationSeconds", durationSeconds)
                .put("phoneAccountId", phoneAccountId)
                .also { if (type == "call_outcome") it.put("outcome", disposition) }
                .also { if (text.isNotBlank()) it.put("text", text) },
        )

    companion object {
        fun fromJson(json: JSONObject): GatewayEvent = GatewayEvent(
            id = json.optString("id"),
            type = json.optString("type"),
            from = json.optString("from"),
            to = json.optString("to"),
            text = json.optString("text"),
            timestamp = json.optString("ts"),
            device = json.optString("device"),
            source = json.optString("source", "android"),
            disposition = json.optString("disposition", "unknown"),
            durationSeconds = json.optLong("durationSeconds"),
            phoneAccountId = json.optString("phoneAccountId"),
            simKey = json.optString("simKey"),
            relatedCallSid = json.optString("relatedCallSid"),
        )
    }
}
