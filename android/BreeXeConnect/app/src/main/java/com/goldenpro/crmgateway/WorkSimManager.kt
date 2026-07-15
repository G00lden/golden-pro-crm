package com.goldenpro.crmgateway

import android.Manifest
import android.annotation.SuppressLint
import android.content.Context
import android.content.pm.PackageManager
import android.os.Build
import android.telecom.PhoneAccountHandle
import android.telecom.TelecomManager
import android.telephony.SubscriptionInfo
import android.telephony.SubscriptionManager
import android.telephony.TelephonyManager
import android.util.Base64
import androidx.core.content.ContextCompat
import androidx.core.content.edit
import java.security.MessageDigest
import java.security.SecureRandom

data class WorkSimProfile(
    val simKey: String,
    val slotIndex: Int,
    val carrierName: String,
    val displayName: String,
    val phoneSuffix: String,
)

data class SimAccountIdentity(
    val subscriptionId: Int,
    val iccId: String,
)

object WorkSimAccountMatcher {
    fun matchSubscriptionId(
        phoneAccountId: String,
        identities: List<SimAccountIdentity>,
        resolvedSubscriptionId: Int? = null,
    ): Int? {
        val normalized = phoneAccountId.trim()
        identities.firstOrNull { identity ->
            normalized.isNotBlank() && (
                normalized == identity.subscriptionId.toString() ||
                    (identity.iccId.isNotBlank() && normalized == identity.iccId)
                )
        }?.let { return it.subscriptionId }
        if (resolvedSubscriptionId != null && identities.any { it.subscriptionId == resolvedSubscriptionId }) {
            return resolvedSubscriptionId
        }
        return identities.singleOrNull()?.subscriptionId
    }
}

object WorkSimManager {
    private const val PREFS = "breexe_sim_identity"
    private const val INSTALL_SALT = "install_salt"

    @SuppressLint("MissingPermission")
    fun activeSims(context: Context): List<WorkSimProfile> {
        if (ContextCompat.checkSelfPermission(context, Manifest.permission.READ_PHONE_STATE) != PackageManager.PERMISSION_GRANTED) return emptyList()
        val manager = context.getSystemService(SubscriptionManager::class.java) ?: return emptyList()
        return runCatching { manager.activeSubscriptionInfoList.orEmpty().map { it.toProfile(context) } }.getOrDefault(emptyList())
    }

    @SuppressLint("MissingPermission")
    fun simKeyForCall(context: Context, phoneAccountId: String): String {
        if (ContextCompat.checkSelfPermission(context, Manifest.permission.READ_PHONE_STATE) != PackageManager.PERMISSION_GRANTED) return ""
        val manager = context.getSystemService(SubscriptionManager::class.java) ?: return ""
        val subscriptions = runCatching { manager.activeSubscriptionInfoList.orEmpty() }.getOrDefault(emptyList())
        val normalized = phoneAccountId.trim()
        val identities = subscriptions.map { SimAccountIdentity(it.subscriptionId, it.iccId.orEmpty()) }
        val resolvedSubscriptionId = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R && normalized.isNotBlank()) {
            val telecom = context.getSystemService(TelecomManager::class.java)
            val telephony = context.getSystemService(TelephonyManager::class.java)
            val handle = runCatching {
                telecom?.callCapablePhoneAccounts.orEmpty().firstOrNull { it.id == normalized }
            }.getOrNull()
            if (handle == null || telephony == null) null else runCatching {
                telephony.getSubscriptionId(handle)
            }.getOrNull()
        } else null
        val subscriptionId = WorkSimAccountMatcher.matchSubscriptionId(normalized, identities, resolvedSubscriptionId)
        val matched = subscriptions.firstOrNull { it.subscriptionId == subscriptionId }
        return matched?.toProfile(context)?.simKey.orEmpty()
    }

    @SuppressLint("MissingPermission")
    fun phoneAccountHandleForSimKey(context: Context, simKey: String): PhoneAccountHandle? {
        if (simKey.isBlank()) return null
        if (ContextCompat.checkSelfPermission(context, Manifest.permission.READ_PHONE_STATE) != PackageManager.PERMISSION_GRANTED) return null
        val subscriptionManager = context.getSystemService(SubscriptionManager::class.java) ?: return null
        val subscriptions = runCatching { subscriptionManager.activeSubscriptionInfoList.orEmpty() }.getOrDefault(emptyList())
        val selected = subscriptions.firstOrNull { it.toProfile(context).simKey == simKey } ?: return null
        val telecom = context.getSystemService(TelecomManager::class.java) ?: return null
        val handles = runCatching { telecom.callCapablePhoneAccounts.orEmpty() }.getOrDefault(emptyList())
        val exact = handles.firstOrNull { handle ->
            handle.id == selected.subscriptionId.toString() ||
                (selected.iccId?.isNotBlank() == true && handle.id == selected.iccId)
        }
        if (exact != null) return exact
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.R) return if (subscriptions.size == 1) handles.singleOrNull() else null
        val telephony = context.getSystemService(TelephonyManager::class.java) ?: return null
        return handles.firstOrNull { handle ->
            runCatching { telephony.getSubscriptionId(handle) == selected.subscriptionId }.getOrDefault(false)
        } ?: if (subscriptions.size == 1) handles.singleOrNull() else null
    }

    fun isSelectedWorkSim(context: Context, simKey: String): Boolean {
        val selected = GatewayPreferences.mobilePolicy(context).workSimKey
        return WorkSimSelectionPolicy.shouldProcess(selected, simKey)
    }

    private fun SubscriptionInfo.toProfile(context: Context): WorkSimProfile {
        val material = "${installSalt(context)}|$subscriptionId|$simSlotIndex|${carrierName}|${countryIso}"
        val digest = MessageDigest.getInstance("SHA-256").digest(material.toByteArray())
        val key = Base64.encodeToString(digest, Base64.URL_SAFE or Base64.NO_WRAP or Base64.NO_PADDING)
        val visibleNumber = runCatching { number.orEmpty().filter(Char::isDigit).takeLast(4) }.getOrDefault("")
        return WorkSimProfile(
            simKey = key,
            slotIndex = simSlotIndex,
            carrierName = carrierName?.toString().orEmpty(),
            displayName = displayName?.toString().orEmpty(),
            phoneSuffix = visibleNumber,
        )
    }

    private fun installSalt(context: Context): String {
        val prefs = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
        prefs.getString(INSTALL_SALT, "")?.takeIf(String::isNotBlank)?.let { return it }
        val value = ByteArray(24).also(SecureRandom()::nextBytes).joinToString("") { "%02x".format(it) }
        prefs.edit(commit = true) { putString(INSTALL_SALT, value) }
        return value
    }
}

object WorkSimSelectionPolicy {
    fun shouldProcess(selectedWorkSimKey: String, eventSimKey: String): Boolean =
        selectedWorkSimKey.isNotBlank() && eventSimKey.isNotBlank() && selectedWorkSimKey == eventSimKey
}
