package com.goldenpro.crmgateway

import android.content.Context
import androidx.core.content.edit
import com.google.firebase.FirebaseApp
import com.google.firebase.FirebaseOptions
import com.google.firebase.messaging.FirebaseMessaging

object MobilePush {
    fun initialize(context: Context) {
        if (BuildConfig.FIREBASE_PROJECT_ID.isBlank() || BuildConfig.FIREBASE_APPLICATION_ID.isBlank() || BuildConfig.FIREBASE_API_KEY.isBlank()) return
        runCatching {
            if (FirebaseApp.getApps(context).isEmpty()) {
                FirebaseApp.initializeApp(
                    context,
                    FirebaseOptions.Builder()
                        .setProjectId(BuildConfig.FIREBASE_PROJECT_ID)
                        .setApplicationId(BuildConfig.FIREBASE_APPLICATION_ID)
                        .setApiKey(BuildConfig.FIREBASE_API_KEY)
                        .build(),
                )
            }
            FirebaseMessaging.getInstance().token.addOnSuccessListener { token ->
                context.getSharedPreferences("breexe_push", Context.MODE_PRIVATE).edit(commit = true) { putString("token", token) }
                GatewaySync.schedule(context)
            }
        }
    }
}
