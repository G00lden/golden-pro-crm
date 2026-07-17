package com.goldenpro.crmgateway.ui

// Presentation state and user actions for setup, dashboard, and diagnostics.

import android.app.Application
import androidx.lifecycle.AndroidViewModel
import androidx.lifecycle.viewModelScope
import com.goldenpro.crmgateway.GatewayActivityEntry
import com.goldenpro.crmgateway.GatewayActivityLog
import com.goldenpro.crmgateway.GatewayConfig
import com.goldenpro.crmgateway.GatewayConfigValidator
import com.goldenpro.crmgateway.GatewayDiagnostics
import com.goldenpro.crmgateway.GatewayDiagnosticsReader
import com.goldenpro.crmgateway.GatewayHttp
import com.goldenpro.crmgateway.GatewayPairingPayload
import com.goldenpro.crmgateway.GatewayPreferences
import com.goldenpro.crmgateway.GatewayQueue
import com.goldenpro.crmgateway.GatewayQueueStats
import com.goldenpro.crmgateway.GatewayRegistration
import com.goldenpro.crmgateway.GatewayRepository
import com.goldenpro.crmgateway.GatewayRuntime
import com.goldenpro.crmgateway.MobileDashboardSummary
import com.goldenpro.crmgateway.MobileApi
import com.goldenpro.crmgateway.MobilePolicy
import com.goldenpro.crmgateway.PendingCallResult
import com.goldenpro.crmgateway.GatewayEvent
import com.goldenpro.crmgateway.GatewayTimestamp
import com.goldenpro.crmgateway.GatewaySync
import com.goldenpro.crmgateway.HttpResult
import com.goldenpro.crmgateway.PairingResult
import com.goldenpro.crmgateway.WorkSimManager
import com.goldenpro.crmgateway.WorkSimProfile
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext

data class GatewayUiState(
    val serverUrl: String = "https://crm.breexe-pro.com",
    val companyNumber: String = "",
    val deviceName: String = "",
    val pairingCode: String = "",
    val manualToken: String = "",
    val runtime: GatewayRuntime = GatewayRuntime("", "", 0, 0),
    val registration: GatewayRegistration = GatewayRegistration("", 0),
    val queue: GatewayQueueStats = GatewayQueueStats(0, 0, 0, 1000, false),
    val diagnostics: GatewayDiagnostics = GatewayDiagnostics(false, false, false, false, 0, 0),
    val activity: List<GatewayActivityEntry> = emptyList(),
    val mobilePolicy: MobilePolicy = MobilePolicy(0, "", "", "", "byod"),
    val activeSims: List<WorkSimProfile> = emptyList(),
    val mobileDashboard: MobileDashboardSummary = MobileDashboardSummary(0, 0, 0, 0),
    val pendingCommands: Int = 0,
    val pendingCall: PendingCallResult? = null,
    val busyAction: String = "",
    val message: String = "",
) {
    val config: GatewayConfig get() = GatewayConfig(serverUrl, manualToken, companyNumber, deviceName)
    val paired: Boolean get() = manualToken.isNotBlank()
    val configError: String? get() = GatewayConfigValidator.firstError(config)
    val pairingError: String? get() = GatewayConfigValidator.firstPairingError(serverUrl, companyNumber, deviceName, pairingCode)
}

class GatewayViewModel(application: Application) : AndroidViewModel(application) {
    private val context get() = getApplication<Application>()
    private val _state = MutableStateFlow(loadStateSafely())
    val state: StateFlow<GatewayUiState> = _state.asStateFlow()

    fun refresh() {
        val current = _state.value
        val refreshed = runCatching {
            val persisted = GatewayPreferences.config(context)
            current.copy(
                    serverUrl = persisted.serverUrl.ifBlank { current.serverUrl },
                    companyNumber = persisted.companyNumber.ifBlank { current.companyNumber },
                    deviceName = persisted.deviceName.ifBlank { current.deviceName },
                    manualToken = persisted.token,
                    runtime = GatewayPreferences.runtime(context),
                    registration = GatewayPreferences.registration(context),
                    queue = GatewayQueue.stats(context),
                    diagnostics = GatewayDiagnosticsReader.read(context),
                    activity = GatewayActivityLog.list(context),
                    mobilePolicy = GatewayPreferences.mobilePolicy(context),
                    activeSims = WorkSimManager.activeSims(context),
                    mobileDashboard = GatewayPreferences.mobileDashboard(context),
                    pendingCommands = com.goldenpro.crmgateway.MobileDatabase.get(context).mobileDao().pendingCommands().size,
                    pendingCall = GatewayPreferences.pendingCall(context),
                    message = current.message.takeUnless(::isStartupFailureMessage).orEmpty(),
                )
        }.getOrElse { error ->
            current.copy(message = startupFailureMessage(error))
        }
        _state.value = refreshed
    }

    fun updateServer(value: String) = _state.update { it.copy(serverUrl = value, message = "") }
    fun updateCompanyNumber(value: String) = _state.update { it.copy(companyNumber = value, message = "") }
    fun updateDeviceName(value: String) = _state.update { it.copy(deviceName = value, message = "") }
    fun updatePairingCode(value: String) = _state.update { it.copy(pairingCode = value.filter(Char::isDigit).take(8), message = "") }
    fun updateManualToken(value: String) = _state.update { it.copy(manualToken = value.trim(), message = "") }
    fun setMessage(value: String) = _state.update { it.copy(message = value) }

    fun handlePairingUri(rawValue: String?) {
        val payload = GatewayPairingPayload.parse(rawValue)
        if (payload == null) {
            if (!rawValue.isNullOrBlank()) setMessage("رمز QR غير صالح أو لا يخص BreeXe Connect.")
            return
        }
        _state.update {
            it.copy(
                serverUrl = payload.serverUrl,
                pairingCode = payload.code,
                message = if (it.paired) {
                    "تمت قراءة الرمز الجديد. اضغط إعادة ربط هذا الجوال لإكمال العملية."
                } else {
                    "تمت قراءة رمز الربط. أكمل رقم شريحة الشركة ثم اضغط ربط الجوال."
                },
            )
        }
    }

    fun pair() = runAction("pair") { snapshot ->
        snapshot.pairingError?.let { return@runAction it }
        when (val result = GatewayHttp.pair(snapshot.serverUrl, snapshot.pairingCode, snapshot.deviceName, snapshot.companyNumber)) {
            is PairingResult.Success -> {
                val config = snapshot.config.copy(token = result.token)
                GatewayPreferences.savePairing(context, config, result.deviceId)
                GatewaySync.schedule(context)
                "تم ربط الجوال بنجاح. اختر شريحة العمل من الشاشة الرئيسية لإكمال التجهيز."
            }
            is PairingResult.Failure -> result.message
        }
    }

    fun saveManualConfiguration() = runAction("save") { snapshot ->
        snapshot.configError?.let { return@runAction it }
        GatewayPreferences.saveConfig(context, snapshot.config)
        GatewayPreferences.markConfigured(context)
        GatewayActivityLog.add(context, "settings", "تم حفظ إعداد الاتصال")
        GatewaySync.schedule(context)
        "تم حفظ الإعداد وبدء المزامنة."
    }

    fun probe() = runAction("probe") { snapshot ->
        snapshot.configError?.let { return@runAction it }
        GatewayPreferences.saveConfig(context, snapshot.config)
        when (val result = GatewayHttp.probe(context)) {
            HttpResult.Success -> "الاتصال بالـ CRM يعمل بنجاح."
            is HttpResult.PermanentFailure -> result.message
            is HttpResult.RetryableFailure -> result.message
        }
    }

    fun syncNow() = runAction("sync") { snapshot ->
        snapshot.configError?.let { return@runAction it }
        GatewayPreferences.saveConfig(context, snapshot.config)
        GatewaySync.schedule(context)
        "بدأت المزامنة. ستستمر تلقائيًا في الخلفية."
    }

    fun selectWorkSim(simKey: String) = runAction("workSim") { snapshot ->
        val sim = snapshot.activeSims.firstOrNull { it.simKey == simKey }
            ?: return@runAction "الشريحة المختارة لم تعد ظاهرة على هذا الجوال. حدّث الشاشة ثم أعد المحاولة."
        when (val profile = MobileApi.syncProfile(context)) {
            is com.goldenpro.crmgateway.MobileApiResult.Failure -> return@runAction profile.message
            is com.goldenpro.crmgateway.MobileApiResult.Retry -> return@runAction profile.message
            is com.goldenpro.crmgateway.MobileApiResult.Success -> Unit
        }
        when (val result = MobileApi.selectWorkSim(context, simKey)) {
            is com.goldenpro.crmgateway.MobileApiResult.Success -> {
                GatewaySync.schedule(context)
                val label = sim.carrierName.ifBlank { sim.displayName.ifBlank { "الشريحة ${sim.slotIndex + 1}" } }
                "تم اعتماد $label كشريحة العمل. ستُهمل مكالمات أي شريحة أخرى."
            }
            is com.goldenpro.crmgateway.MobileApiResult.Failure -> result.message
            is com.goldenpro.crmgateway.MobileApiResult.Retry -> result.message
        }
    }

    fun enqueueTest(type: String, number: String) {
        GatewayRepository.enqueueTest(context, type, number)
        setMessage("تمت إضافة حدث تجريبي إلى الطابور.")
        refresh()
    }

    fun saveCallOutcome(outcome: String) {
        val call = _state.value.pendingCall ?: return
        GatewayRepository.enqueue(
            context,
            GatewayEvent(
                id = "outcome-${call.callSid}-$outcome",
                type = "call_outcome",
                from = call.phone,
                to = GatewayRepository.normalizePhone(_state.value.companyNumber),
                timestamp = GatewayTimestamp.now(),
                device = _state.value.deviceName,
                disposition = outcome,
                relatedCallSid = call.callSid,
            ),
        )
        GatewayPreferences.savePendingCall(context, null)
        _state.update { it.copy(pendingCall = null, message = "تم حفظ نتيجة المكالمة وستُرفع إلى CRM.") }
    }

    fun clearTestEvents() {
        val count = GatewayQueue.clearTestEvents(context)
        setMessage("تم حذف $count من الأحداث التجريبية فقط.")
        refresh()
    }

    fun clearActivity() {
        GatewayActivityLog.clear(context)
        refresh()
    }

    fun disconnect() {
        GatewayPreferences.clearPairing(context)
        _state.update { it.copy(pairingCode = "", manualToken = "", message = "تم فصل الربط المحلي دون حذف الأحداث.") }
        refresh()
    }

    private fun runAction(name: String, block: suspend (GatewayUiState) -> String) {
        if (_state.value.busyAction.isNotBlank()) return
        val snapshot = _state.value
        _state.update { it.copy(busyAction = name, message = "") }
        viewModelScope.launch {
            val result = withContext(Dispatchers.IO) {
                runCatching { block(snapshot) }.getOrElse { "حدث خطأ غير متوقع: ${it.message ?: "غير معروف"}" }
            }
            _state.update { it.copy(busyAction = "", message = result) }
            refresh()
        }
    }

    private fun loadState(): GatewayUiState {
        val config = GatewayPreferences.config(context)
        return GatewayUiState(
            serverUrl = config.serverUrl.ifBlank { "https://crm.breexe-pro.com" },
            companyNumber = config.companyNumber,
            deviceName = config.deviceName,
            manualToken = config.token,
            runtime = GatewayPreferences.runtime(context),
            registration = GatewayPreferences.registration(context),
            queue = GatewayQueue.stats(context),
            diagnostics = GatewayDiagnosticsReader.read(context),
            activity = GatewayActivityLog.list(context),
            mobilePolicy = GatewayPreferences.mobilePolicy(context),
            activeSims = WorkSimManager.activeSims(context),
            mobileDashboard = GatewayPreferences.mobileDashboard(context),
            pendingCommands = com.goldenpro.crmgateway.MobileDatabase.get(context).mobileDao().pendingCommands().size,
            pendingCall = GatewayPreferences.pendingCall(context),
        )
    }

    private fun loadStateSafely(): GatewayUiState = runCatching(::loadState).getOrElse { error ->
        val config = runCatching { GatewayPreferences.config(context) }.getOrDefault(GatewayConfig("", "", "", ""))
        GatewayUiState(
            serverUrl = config.serverUrl.ifBlank { "https://crm.breexe-pro.com" },
            companyNumber = config.companyNumber,
            deviceName = config.deviceName,
            manualToken = config.token,
            message = startupFailureMessage(error),
        )
    }

    private fun startupFailureMessage(error: Throwable): String =
        "تعذر فتح التخزين المحلي للتطبيق، لكن بيانات CRM لم تتأثر. " +
            "أعد تشغيل الجوال بعد تثبيت هذا التحديث. رمز التشخيص: ${error.javaClass.simpleName}."

    private fun isStartupFailureMessage(value: String): Boolean = value.startsWith("تعذر فتح التخزين المحلي")
}
