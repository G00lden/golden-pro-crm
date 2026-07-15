package com.goldenpro.crmgateway

// Contact policy regression tests.

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class CallerContactPolicyTest {
    @Test
    fun savesOnlyConfirmedInboundCallers() {
        listOf("answered", "no_answer", "busy", "unreachable", "rejected", "after_hours")
            .forEach { assertTrue(CallerContactPolicy.shouldSave(it)) }
        assertFalse(CallerContactPolicy.shouldSave("outgoing"))
        assertFalse(CallerContactPolicy.shouldSave("blocked"))
        assertFalse(CallerContactPolicy.shouldSave("unknown"))
    }

    @Test
    fun generatedContactNameUsesLastFourDigits() {
        assertEquals("متصل CRM 1234", CallerContactPolicy.displayName("966500001234"))
    }

    @Test
    fun normalizesSaudiLocalNumbersBeforeSavingOrSending() {
        assertEquals("+966501234567", GatewayRepository.normalizePhone("0501234567"))
        assertEquals("+966501234567", GatewayRepository.normalizePhone("501234567"))
    }

    @Test
    fun requiresHttpsAndDeviceCredentialBeforeEnablingSync() {
        val valid = GatewayConfig(
            serverUrl = "https://crm.breexe-pro.com",
            token = "secret-token",
            companyNumber = "966501234567",
            deviceName = "جوال الشركة",
        )
        assertEquals(null, GatewayConfigValidator.firstError(valid))
        assertTrue(GatewayConfigValidator.firstError(valid.copy(token = ""))!!.contains("غير مرتبط"))
        assertTrue(GatewayConfigValidator.firstError(valid.copy(serverUrl = "http://crm.example.com"))!!.contains("https://"))
    }

    @Test
    fun pairingRequiresExactlyEightDigitsAndNoExistingToken() {
        assertEquals(
            null,
            GatewayConfigValidator.firstPairingError(
                serverUrl = "https://crm.breexe-pro.com",
                companyNumber = "966501234567",
                deviceName = "جوال الشركة",
                pairingCode = "01234567",
            ),
        )
        assertTrue(
            GatewayConfigValidator.firstPairingError(
                serverUrl = "https://crm.breexe-pro.com",
                companyNumber = "966501234567",
                deviceName = "جوال الشركة",
                pairingCode = "1234",
            )!!.contains("8"),
        )
    }

    @Test
    fun queueDeduplicatesIdsAndDropsOnlyWhenCapacityIsExceeded() {
        val first = GatewayEvent(id = "one", type = "answered", from = "+966500000001", to = "+966500000000")
        val second = GatewayEvent(id = "two", type = "answered", from = "+966500000002", to = "+966500000000")
        val duplicate = GatewayQueuePolicy.append(listOf(first), first, 2)
        assertTrue(duplicate.duplicate)
        assertEquals(listOf(first), duplicate.events)

        val overflow = GatewayQueuePolicy.append(listOf(first), second, 1)
        assertFalse(overflow.duplicate)
        assertEquals(1, overflow.dropped)
        assertEquals(listOf(second), overflow.events)
    }
}
