package com.goldenpro.crmgateway

import android.Manifest
import android.annotation.SuppressLint
import android.content.Context
import android.content.pm.PackageManager
import android.telephony.SubscriptionInfo
import android.telephony.SubscriptionManager
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
        val matched = subscriptions.firstOrNull { subscription ->
            normalized.isNotBlank() && (
                normalized == subscription.subscriptionId.toString() ||
                normalized == subscription.iccId ||
                normalized.endsWith(subscription.subscriptionId.toString())
            )
        } ?: subscriptions.singleOrNull()
        return matched?.toProfile(context)?.simKey.orEmpty()
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
