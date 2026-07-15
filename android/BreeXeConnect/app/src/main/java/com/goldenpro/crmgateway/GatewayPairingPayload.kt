package com.goldenpro.crmgateway

import java.net.URI
import java.net.URLDecoder
import java.net.URLEncoder

/** Short-lived, non-secret bootstrap payload encoded in the CRM QR code. */
data class GatewayPairingPayload(val serverUrl: String, val code: String) {
    fun toUri(): String = "breexe-connect://pair?server=${encode(serverUrl)}&code=${encode(code)}"

    companion object {
        fun parse(value: String?): GatewayPairingPayload? {
            val uri = runCatching { URI(value?.trim().orEmpty()) }.getOrNull() ?: return null
            if (!uri.scheme.equals("breexe-connect", true) || !uri.host.equals("pair", true)) return null
            val values = uri.rawQuery.orEmpty().split('&').mapNotNull { item ->
                val separator = item.indexOf('=')
                if (separator <= 0) null else decode(item.substring(0, separator)) to decode(item.substring(separator + 1))
            }.toMap()
            val server = values["server"].orEmpty().trim().trimEnd('/')
            val code = values["code"].orEmpty()
            if (!code.matches(Regex("^\\d{8}$"))) return null
            val serverUri = runCatching { URI(server) }.getOrNull() ?: return null
            if (!serverUri.scheme.equals("https", true) || serverUri.host.isNullOrBlank()) return null
            return GatewayPairingPayload(server, code)
        }

        private fun encode(value: String) = URLEncoder.encode(value, Charsets.UTF_8.name())
        private fun decode(value: String) = URLDecoder.decode(value, Charsets.UTF_8.name())
    }
}
