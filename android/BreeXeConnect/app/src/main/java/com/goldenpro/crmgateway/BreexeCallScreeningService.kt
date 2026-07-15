package com.goldenpro.crmgateway

import android.app.role.RoleManager
import android.content.Context
import android.os.Build
import android.telecom.Call
import android.telecom.CallScreeningService

object CallerScreeningRole {
    fun isAvailable(context: Context): Boolean = Build.VERSION.SDK_INT >= 29 && context.getSystemService(RoleManager::class.java)?.isRoleAvailable(RoleManager.ROLE_CALL_SCREENING) == true
    fun isHeld(context: Context): Boolean = Build.VERSION.SDK_INT >= 29 && context.getSystemService(RoleManager::class.java)?.isRoleHeld(RoleManager.ROLE_CALL_SCREENING) == true
}

class BreexeCallScreeningService : CallScreeningService() {
    override fun onScreenCall(details: Call.Details) {
        val phone = GatewayRepository.normalizePhone(details.handle?.schemeSpecificPart.orEmpty())
        if (phone.isNotBlank()) {
            runCatching {
                MobileDatabase.get(this).mobileDao().caller(phone)
            }.getOrNull()?.let { MobileNotifications.showCaller(this, it, phone) }
        }
        val response = CallResponse.Builder()
            .setDisallowCall(false)
            .setRejectCall(false)
        if (Build.VERSION.SDK_INT >= 29) response.setSilenceCall(false)
        respondToCall(details, response.build())
    }
}
