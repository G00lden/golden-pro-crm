package com.goldenpro.crmgateway

import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale
import java.util.TimeZone

/** ISO-8601 UTC timestamps compatible with Android 7 (API 24). */
object GatewayTimestamp {
    fun now(): String = fromEpochMillis(System.currentTimeMillis())

    fun fromEpochMillis(value: Long): String = SimpleDateFormat("yyyy-MM-dd'T'HH:mm:ss.SSS'Z'", Locale.US)
        .apply { timeZone = TimeZone.getTimeZone("UTC") }
        .format(Date(value))
}
