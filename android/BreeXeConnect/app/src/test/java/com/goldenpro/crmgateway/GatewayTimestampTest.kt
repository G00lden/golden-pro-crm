package com.goldenpro.crmgateway

import org.junit.Assert.assertEquals
import org.junit.Test

class GatewayTimestampTest {
    @Test fun `formats epoch as ISO UTC on old Android compatible API`() {
        assertEquals("1970-01-01T00:00:00.000Z", GatewayTimestamp.fromEpochMillis(0))
    }
}
