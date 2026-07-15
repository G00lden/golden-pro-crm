package com.goldenpro.crmgateway

import android.content.Context
import androidx.core.content.edit
import com.google.firebase.messaging.FirebaseMessagingService
import com.google.firebase.messaging.RemoteMessage

class BreexeMessagingService : FirebaseMessagingService() {
    override fun onNewToken(token: String) {
        getSharedPreferences("breexe_push", Context.MODE_PRIVATE).edit(commit = true) { putString("token", token) }
        GatewaySync.schedule(this)
    }

    override fun onMessageReceived(message: RemoteMessage) {
        // Push carries only an opaque command id; details are fetched over authenticated HTTPS.
        if (message.data["commandId"].isNullOrBlank()) return
        GatewaySync.schedule(this)
    }
}
