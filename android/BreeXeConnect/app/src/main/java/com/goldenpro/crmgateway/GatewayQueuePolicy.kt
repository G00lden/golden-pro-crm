package com.goldenpro.crmgateway

// Pure queue policy kept separately for deterministic unit tests.

data class QueueAppendResult(
    val events: List<GatewayEvent>,
    val dropped: Int,
    val duplicate: Boolean,
)

object GatewayQueuePolicy {
    fun append(current: List<GatewayEvent>, event: GatewayEvent, capacity: Int): QueueAppendResult {
        if (current.any { it.id == event.id }) return QueueAppendResult(current, 0, duplicate = true)
        val combined = current + event
        val overflow = (combined.size - capacity).coerceAtLeast(0)
        return QueueAppendResult(combined.takeLast(capacity), overflow, duplicate = false)
    }
}
