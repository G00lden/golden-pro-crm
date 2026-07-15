package com.goldenpro.crmgateway

// QR pairing payload security tests.

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class GatewayPairingPayloadTest {
    @Test fun `round trips a secure pairing payload`() {
        val payload = GatewayPairingPayload("https://crm.breexe-pro.com", "12345678")
        assertEquals(payload, GatewayPairingPayload.parse(payload.toUri()))
    }

    @Test fun `rejects insecure or malformed payloads`() {
        assertNull(GatewayPairingPayload.parse("http://crm.example.com"))
        assertNull(GatewayPairingPayload.parse("breexe-connect://pair?server=http%3A%2F%2Fcrm.example.com&code=12345678"))
        assertNull(GatewayPairingPayload.parse("breexe-connect://pair?server=https%3A%2F%2Fcrm.example.com&code=1234"))
    }
}
