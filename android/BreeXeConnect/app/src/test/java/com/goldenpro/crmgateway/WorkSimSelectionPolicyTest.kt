package com.goldenpro.crmgateway

import org.junit.Assert.assertFalse
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
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

    @Test
    fun phoneAccountMatchingUsesExactIdsAndDoesNotCollideOnSuffixes() {
        val identities = listOf(
            SimAccountIdentity(subscriptionId = 1, iccId = "icc-one"),
            SimAccountIdentity(subscriptionId = 11, iccId = "icc-eleven"),
        )

        assertEquals(1, WorkSimAccountMatcher.matchSubscriptionId("1", identities))
        assertEquals(11, WorkSimAccountMatcher.matchSubscriptionId("11", identities))
        assertEquals(11, WorkSimAccountMatcher.matchSubscriptionId("vendor-handle", identities, 11))
        assertNull(WorkSimAccountMatcher.matchSubscriptionId("vendor-11", identities))
        assertEquals(1, WorkSimAccountMatcher.matchSubscriptionId("unknown", identities.take(1)))
    }
}
