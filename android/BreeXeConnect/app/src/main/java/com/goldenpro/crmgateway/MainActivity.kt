package com.goldenpro.crmgateway

// Thin Android entry point; UI and business state live in dedicated layers.

import android.content.Intent
import android.os.Bundle
import android.app.role.RoleManager
import android.os.Build
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import androidx.activity.viewModels
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.ui.platform.LocalLayoutDirection
import androidx.compose.ui.unit.LayoutDirection
import com.goldenpro.crmgateway.ui.BreeXeConnectApp
import com.goldenpro.crmgateway.ui.GatewayViewModel
import com.goldenpro.crmgateway.ui.theme.BreeXeTheme

class MainActivity : ComponentActivity() {
    private val gatewayViewModel: GatewayViewModel by viewModels()

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        enableEdgeToEdge()
        MobileNotifications.ensureChannels(this)
        MobilePush.initialize(this)
        startBackgroundWork()
        gatewayViewModel.handlePairingUri(intent?.dataString)
        setContent {
            BreeXeTheme {
                CompositionLocalProvider(LocalLayoutDirection provides LayoutDirection.Rtl) {
                    BreeXeConnectApp(gatewayViewModel, onRequestCallerScreening = ::requestCallerScreening)
                }
            }
        }
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        setIntent(intent)
        gatewayViewModel.handlePairingUri(intent.dataString)
    }

    override fun onResume() {
        super.onResume()
        gatewayViewModel.refresh()
    }

    private fun startBackgroundWork() {
        GatewaySync.schedule(this)
        GatewaySync.schedulePeriodic(this)
        CallLogSyncWorker.schedule(this, 0)
        CallLogSyncWorker.schedulePeriodic(this)
    }

    private fun requestCallerScreening() {
        if (Build.VERSION.SDK_INT < 29) return
        val roleManager = getSystemService(RoleManager::class.java) ?: return
        if (roleManager.isRoleAvailable(RoleManager.ROLE_CALL_SCREENING) && !roleManager.isRoleHeld(RoleManager.ROLE_CALL_SCREENING)) {
            startActivityForResult(roleManager.createRequestRoleIntent(RoleManager.ROLE_CALL_SCREENING), 2101)
        }
    }
}
