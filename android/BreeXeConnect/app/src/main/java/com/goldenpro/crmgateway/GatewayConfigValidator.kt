package com.goldenpro.crmgateway

// Single validation boundary for manual and QR-based setup.

import java.net.URI

object GatewayConfigValidator {
    fun firstError(config: GatewayConfig): String? {
        baseError(config.serverUrl, config.companyNumber, config.deviceName)?.let { return it }
        if (config.token.trim().isBlank()) {
            return "هذا الجوال غير مرتبط بالـ CRM. استخدم رمز الربط أو أدخل التوكن يدويًا من الخيارات المتقدمة."
        }
        return null
    }

    fun firstPairingError(
        serverUrl: String,
        companyNumber: String,
        deviceName: String,
        pairingCode: String,
    ): String? {
        baseError(serverUrl, companyNumber, deviceName)?.let { return it }
        if (!pairingCode.matches(Regex("^\\d{8}$"))) {
            return "أدخل رمز الربط المكوّن من 8 أرقام كما يظهر في الـ CRM."
        }
        return null
    }

    private fun baseError(serverUrlValue: String, companyNumber: String, deviceName: String): String? {
        val serverUrl = serverUrlValue.trim()
        if (serverUrl.isBlank()) return "أدخل رابط خادم CRM."
        val uri = runCatching { URI(serverUrl) }.getOrNull()
            ?: return "رابط الخادم غير صالح."
        if (!uri.scheme.equals("https", ignoreCase = true) || uri.host.isNullOrBlank()) {
            return "رابط الخادم يجب أن يبدأ بـ https:// ويحتوي على نطاق صحيح."
        }
        val companyPhone = GatewayRepository.normalizePhone(companyNumber)
        if (companyPhone.filter(Char::isDigit).length < 9) {
            return "أدخل رقم شريحة الشركة بصيغة صحيحة."
        }
        if (deviceName.trim().isBlank()) return "أدخل اسمًا لهذا الجوال."
        return null
    }
}
