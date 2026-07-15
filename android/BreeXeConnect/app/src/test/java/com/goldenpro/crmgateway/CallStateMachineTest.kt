package com.goldenpro.crmgateway

// Telephony state transition regression tests.

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class CallStateMachineTest {
    @Test
    fun ringingThenIdleEmitsIncomingAndMissedSignals() {
        val ringing = CallStateMachine.transition(
            current = null,
            phoneState = CallStateMachine.STATE_RINGING,
            incomingNumber = "+966500000001",
            newId = { "call-1" },
        )
        assertEquals(listOf("incoming_call"), ringing.signals.map { it.type })

        val idle = CallStateMachine.transition(
            current = ringing.session,
            phoneState = CallStateMachine.STATE_IDLE,
            incomingNumber = null,
        )
        assertEquals(listOf("missed_call"), idle.signals.map { it.type })
        assertNull(idle.session)
        assertFalse(idle.needsCallLogLookup)
    }

    @Test
    fun duplicateRingingBroadcastDoesNotDuplicateIncomingSignal() {
        val first = CallStateMachine.transition(
            current = null,
            phoneState = CallStateMachine.STATE_RINGING,
            incomingNumber = null,
            newId = { "call-2" },
        )
        assertTrue(first.signals.isEmpty())

        val withNumber = CallStateMachine.transition(
            current = first.session,
            phoneState = CallStateMachine.STATE_RINGING,
            incomingNumber = "0500000002",
        )
        assertEquals(1, withNumber.signals.size)

        val duplicate = CallStateMachine.transition(
            current = withNumber.session,
            phoneState = CallStateMachine.STATE_RINGING,
            incomingNumber = "0500000002",
        )
        assertTrue(duplicate.signals.isEmpty())
    }

    @Test
    fun offHookMarksCallAnswered() {
        val ringing = CallStateMachine.transition(
            current = null,
            phoneState = CallStateMachine.STATE_RINGING,
            incomingNumber = "+966500000003",
            newId = { "call-3" },
        )
        val answered = CallStateMachine.transition(
            current = ringing.session,
            phoneState = CallStateMachine.STATE_OFFHOOK,
            incomingNumber = null,
        )
        assertEquals(listOf("call_answered"), answered.signals.map { it.type })
        assertTrue(answered.session?.answered == true)

        val idle = CallStateMachine.transition(
            current = answered.session,
            phoneState = CallStateMachine.STATE_IDLE,
            incomingNumber = null,
        )
        assertTrue(idle.signals.isEmpty())
    }

    @Test
    fun missingNumberRequestsCallLogLookup() {
        val ringing = CallStateMachine.transition(
            current = null,
            phoneState = CallStateMachine.STATE_RINGING,
            incomingNumber = null,
            newId = { "call-4" },
        )
        val idle = CallStateMachine.transition(
            current = ringing.session,
            phoneState = CallStateMachine.STATE_IDLE,
            incomingNumber = null,
        )
        assertTrue(idle.needsCallLogLookup)
        assertTrue(idle.signals.isEmpty())
    }
}
