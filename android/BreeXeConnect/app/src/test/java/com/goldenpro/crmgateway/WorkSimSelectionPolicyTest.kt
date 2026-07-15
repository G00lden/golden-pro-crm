package com.goldenpro.crmgateway

import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class WorkSimSelectionPolicyTest {
    @Test
    fun failsClosedWhenWorkSimIsMissingOrUnknown() {
        assertFalse(WorkSimSelectionPolicy.shouldProcess("", "sim-work"))
        assertFalse(WorkSimSelectionPolicy.shouldProcess("sim-work", ""))
        assertFalse(WorkSimSelectionPolicy.shouldProcess("sim-work", "sim-personal"))
        assertTrue(WorkSimSelectionPolicy.shouldProcess("sim-work", "sim-work"))
    }
}
