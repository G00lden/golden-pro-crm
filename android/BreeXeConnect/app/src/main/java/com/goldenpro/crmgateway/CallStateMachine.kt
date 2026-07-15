package com.goldenpro.crmgateway

// Pure call state transitions kept independent from Android receivers for testing.

import java.util.UUID

data class CallSession(
    val id: String,
    val number: String,
    val answered: Boolean = false,
    val answeredSent: Boolean = false,
    val incomingSent: Boolean = false,
)

data class CallSignal(
    val type: String,
    val number: String,
    val sessionId: String,
)

data class CallTransition(
    val session: CallSession?,
    val signals: List<CallSignal>,
    val needsCallLogLookup: Boolean = false,
)

object CallStateMachine {
    const val STATE_RINGING = "RINGING"
    const val STATE_OFFHOOK = "OFFHOOK"
    const val STATE_IDLE = "IDLE"

    fun transition(
        current: CallSession?,
        phoneState: String,
        incomingNumber: String?,
        newId: () -> String = { UUID.randomUUID().toString() },
    ): CallTransition {
        val number = GatewayRepository.normalizePhone(incomingNumber.orEmpty())
        return when (phoneState) {
            STATE_RINGING -> {
                var session = current ?: CallSession(id = newId(), number = number)
                if (number.isNotBlank()) session = session.copy(number = number)
                val shouldSignal = session.number.isNotBlank() && !session.incomingSent
                val signals = if (shouldSignal) {
                    listOf(CallSignal("incoming_call", session.number, session.id))
                } else {
                    emptyList()
                }
                CallTransition(
                    session = session.copy(incomingSent = session.incomingSent || shouldSignal),
                    signals = signals,
                )
            }

            STATE_OFFHOOK -> {
                if (current == null) return CallTransition(null, emptyList())
                val session = if (number.isNotBlank()) current.copy(number = number) else current
                val shouldSignal = session.number.isNotBlank() && !session.answeredSent
                CallTransition(
                    session = session.copy(answered = true, answeredSent = session.answeredSent || shouldSignal),
                    signals = if (shouldSignal) {
                        listOf(CallSignal("call_answered", session.number, session.id))
                    } else {
                        emptyList()
                    },
                )
            }

            STATE_IDLE -> {
                if (current == null) return CallTransition(null, emptyList())
                val session = if (number.isNotBlank()) current.copy(number = number) else current
                val finalType = if (session.answered) "call_answered" else "missed_call"
                val shouldSignal = session.number.isNotBlank() && if (session.answered) {
                    !session.answeredSent
                } else {
                    true
                }
                CallTransition(
                    session = null,
                    signals = if (shouldSignal) {
                        listOf(CallSignal(finalType, session.number, session.id))
                    } else {
                        emptyList()
                    },
                    needsCallLogLookup = session.number.isBlank(),
                )
            }

            else -> CallTransition(current, emptyList())
        }
    }
}
