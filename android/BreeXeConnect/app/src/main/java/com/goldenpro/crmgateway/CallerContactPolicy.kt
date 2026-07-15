package com.goldenpro.crmgateway

// Contact naming rules shared by call-log and CRM contact synchronization.

object CallerContactPolicy {
    private val inboundDispositions = setOf("answered", "no_answer", "busy", "unreachable", "rejected", "after_hours")

    fun shouldSave(disposition: String): Boolean = disposition in inboundDispositions

    fun displayName(normalizedPhone: String): String = "متصل CRM ${normalizedPhone.takeLast(4)}"
}
