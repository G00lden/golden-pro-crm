package com.goldenpro.crmgateway.ui

// Material 3 Arabic-first application shell.

import android.content.Intent
import android.provider.Settings
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ColumnScope
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.layout.safeDrawing
import androidx.compose.foundation.layout.windowInsetsPadding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ExitToApp
import androidx.compose.material.icons.automirrored.filled.List
import androidx.compose.material.icons.automirrored.filled.Send
import androidx.compose.material.icons.filled.CheckCircle
import androidx.compose.material.icons.filled.Delete
import androidx.compose.material.icons.filled.Done
import androidx.compose.material.icons.filled.Home
import androidx.compose.material.icons.filled.Info
import androidx.compose.material.icons.filled.Lock
import androidx.compose.material.icons.filled.Refresh
import androidx.compose.material.icons.filled.Search
import androidx.compose.material.icons.filled.Settings
import androidx.compose.material.icons.filled.Share
import androidx.compose.material.icons.filled.Warning
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Button
import androidx.compose.material3.Card
import androidx.compose.material3.CardDefaults
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.FilledTonalButton
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.NavigationBar
import androidx.compose.material3.NavigationBarItem
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import androidx.core.net.toUri
import com.google.mlkit.vision.codescanner.GmsBarcodeScannerOptions
import com.google.mlkit.vision.codescanner.GmsBarcodeScanning
import com.google.mlkit.vision.barcode.common.Barcode
import com.goldenpro.crmgateway.BuildConfig
import com.goldenpro.crmgateway.CallerScreeningRole
import com.goldenpro.crmgateway.GatewayActivityEntry
import com.goldenpro.crmgateway.GatewayDiagnosticsReader
import com.goldenpro.crmgateway.R
import com.goldenpro.crmgateway.ui.theme.Gold
import com.goldenpro.crmgateway.ui.theme.Navy
import com.goldenpro.crmgateway.ui.theme.Teal
import java.text.DateFormat
import java.util.Date

@Composable
fun BreeXeConnectApp(viewModel: GatewayViewModel, onRequestCallerScreening: () -> Unit) {
    val state by viewModel.state.collectAsState()
    val context = LocalContext.current
    val permissionLauncher = rememberLauncherForActivityResult(ActivityResultContracts.RequestMultiplePermissions()) {
        viewModel.refresh()
        viewModel.setMessage(if (it.values.all { granted -> granted }) "اكتملت الأذونات." else "بعض الأذونات ما زالت ناقصة.")
    }
    val scannerOptions = remember {
        GmsBarcodeScannerOptions.Builder()
            .setBarcodeFormats(Barcode.FORMAT_QR_CODE)
            .enableAutoZoom()
            .build()
    }
    val scanner = remember { GmsBarcodeScanning.getClient(context, scannerOptions) }
    val scanQr = {
        scanner.startScan()
            .addOnSuccessListener { viewModel.handlePairingUri(it.rawValue) }
            .addOnCanceledListener { viewModel.setMessage("تم إلغاء المسح.") }
            .addOnFailureListener { viewModel.setMessage("تعذر فتح الماسح: ${it.message ?: "تأكد من تحديث خدمات Google Play"}") }
        Unit
    }

    LaunchedEffect(Unit) { viewModel.refresh() }

    if (!state.paired) {
        SetupScreen(
            state = state,
            onGrantPermissions = { permissionLauncher.launch(GatewayDiagnosticsReader.requiredPermissions) },
            onScanQr = scanQr,
            viewModel = viewModel,
        )
    } else {
        Dashboard(
            state = state,
            viewModel = viewModel,
            onGrantPermissions = { permissionLauncher.launch(GatewayDiagnosticsReader.requiredPermissions) },
            onScanQr = scanQr,
            onRequestCallerScreening = onRequestCallerScreening,
        )
    }
}

@Composable
private fun SetupScreen(
    state: GatewayUiState,
    onGrantPermissions: () -> Unit,
    onScanQr: () -> Unit,
    viewModel: GatewayViewModel,
) {
    LazyColumn(
        modifier = Modifier.fillMaxSize().windowInsetsPadding(WindowInsets.safeDrawing),
        contentPadding = androidx.compose.foundation.layout.PaddingValues(20.dp, 32.dp),
        verticalArrangement = Arrangement.spacedBy(16.dp),
    ) {
        item { BrandHeader(centered = true) }
        item {
            Text(
                "اربط جوال العمل بالـ CRM خلال دقائق، ثم اترك BreeXe Connect يلتقط المكالمات ويرسلها تلقائيًا.",
                modifier = Modifier.fillMaxWidth(),
                textAlign = TextAlign.Center,
                style = MaterialTheme.typography.bodyLarge,
            )
        }
        if (state.message.isNotBlank()) item { MessageCard(state.message) }
        item {
            SetupStepCard(
                number = "1",
                title = "فعّل أذونات المكالمات",
                description = if (state.diagnostics.permissionsGranted) "الأذونات مكتملة والجوال جاهز للالتقاط." else "مطلوبة لقراءة نوع المكالمة وحفظ المتصل في جهات الاتصال.",
                complete = state.diagnostics.permissionsGranted,
            ) {
                if (!state.diagnostics.permissionsGranted) Button(onClick = onGrantPermissions) { Text("منح الأذونات") }
            }
        }
        item {
            SetupStepCard(
                number = "2",
                title = "أدخل بيانات الجوال",
                description = "الرابط الافتراضي جاهز. أدخل رقم شريحة الشركة واسمًا واضحًا للجوال.",
                complete = state.companyNumber.isNotBlank() && state.deviceName.isNotBlank(),
            ) {
                ConnectionFields(state, viewModel, includeToken = false)
            }
        }
        item {
            SetupStepCard(
                number = "3",
                title = "امسح رمز الربط من الـ CRM",
                description = "من نظام المكالمات في CRM أنشئ رمزًا جديدًا، ثم امسحه أو أدخل الأرقام يدويًا.",
                complete = false,
            ) {
                OutlinedButton(modifier = Modifier.fillMaxWidth(), onClick = onScanQr) {
                    Icon(Icons.Default.Search, null)
                    Spacer(Modifier.width(8.dp))
                    Text("مسح QR")
                }
                OutlinedTextField(
                    value = state.pairingCode,
                    onValueChange = viewModel::updatePairingCode,
                    modifier = Modifier.fillMaxWidth(),
                    label = { Text("أو رمز الربط من 8 أرقام") },
                    singleLine = true,
                    keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.NumberPassword),
                )
                if (state.pairingCode.isNotBlank()) state.pairingError?.let {
                    Text(it, color = MaterialTheme.colorScheme.error)
                }
                Button(
                    modifier = Modifier.fillMaxWidth(),
                    enabled = state.pairingError == null && state.busyAction.isBlank(),
                    onClick = viewModel::pair,
                ) {
                    if (state.busyAction == "pair") SmallProgress() else Icon(Icons.AutoMirrored.Filled.Send, null)
                    Spacer(Modifier.width(8.dp))
                    Text(if (state.busyAction == "pair") "جاري الربط…" else "ربط الجوال بالـ CRM")
                }
            }
        }
        item {
            SecurityNote()
            Spacer(Modifier.height(24.dp))
        }
    }
}

@Composable
private fun Dashboard(
    state: GatewayUiState,
    viewModel: GatewayViewModel,
    onGrantPermissions: () -> Unit,
    onScanQr: () -> Unit,
    onRequestCallerScreening: () -> Unit,
) {
    var tab by rememberSaveable { mutableIntStateOf(0) }
    Scaffold(
        topBar = { Surface(shadowElevation = 2.dp) { BrandHeader(modifier = Modifier.padding(16.dp)) } },
        bottomBar = {
            NavigationBar {
                listOf("الرئيسية" to Icons.Default.Home, "النشاط" to Icons.AutoMirrored.Filled.List, "الإعدادات" to Icons.Default.Settings)
                    .forEachIndexed { index, item ->
                        NavigationBarItem(
                            selected = tab == index,
                            onClick = { tab = index },
                            icon = { Icon(item.second, null) },
                            label = { Text(item.first) },
                        )
                    }
            }
        },
    ) { padding ->
        when (tab) {
            0 -> HomeScreen(state, viewModel, onGrantPermissions, onRequestCallerScreening, Modifier.padding(padding))
            1 -> ActivityScreen(state, viewModel, Modifier.padding(padding))
            else -> SettingsScreen(state, viewModel, onScanQr, Modifier.padding(padding))
        }
    }
}

@Composable
private fun HomeScreen(
    state: GatewayUiState,
    viewModel: GatewayViewModel,
    onGrantPermissions: () -> Unit,
    onRequestCallerScreening: () -> Unit,
    modifier: Modifier = Modifier,
) {
    var testNumber by rememberSaveable { mutableStateOf("") }
    val context = LocalContext.current
    LazyColumn(
        modifier = modifier.fillMaxSize(),
        contentPadding = androidx.compose.foundation.layout.PaddingValues(16.dp),
        verticalArrangement = Arrangement.spacedBy(12.dp),
    ) {
        if (state.message.isNotBlank()) item { MessageCard(state.message) }
        item { HealthCard(state) }
        state.pendingCall?.let { call ->
            item {
                Card {
                    Column(Modifier.padding(16.dp), verticalArrangement = Arrangement.spacedBy(10.dp)) {
                        Text("نتيجة آخر مكالمة", fontWeight = FontWeight.Bold, style = MaterialTheme.typography.titleMedium)
                        Text("••••${call.phone.filter(Char::isDigit).takeLast(4)} · اختر النتيجة لتحديث العميل والمهمة في CRM.")
                        Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                            Button(onClick = { viewModel.saveCallOutcome("contacted") }, modifier = Modifier.weight(1f)) { Text("تم التواصل") }
                            OutlinedButton(onClick = { viewModel.saveCallOutcome("no_answer") }, modifier = Modifier.weight(1f)) { Text("لم يرد") }
                        }
                        Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                            OutlinedButton(onClick = { viewModel.saveCallOutcome("follow_up") }, modifier = Modifier.weight(1f)) { Text("متابعة") }
                            OutlinedButton(onClick = { viewModel.saveCallOutcome("interested") }, modifier = Modifier.weight(1f)) { Text("مهتم") }
                            OutlinedButton(onClick = { viewModel.saveCallOutcome("not_interested") }, modifier = Modifier.weight(1f)) { Text("غير مهتم") }
                        }
                    }
                }
            }
        }
        item {
            Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                Button(
                    modifier = Modifier.weight(1f),
                    enabled = state.busyAction.isBlank(),
                    onClick = viewModel::syncNow,
                ) {
                    Icon(Icons.Default.Refresh, null)
                    Spacer(Modifier.width(6.dp))
                    Text("مزامنة الآن")
                }
                OutlinedButton(
                    modifier = Modifier.weight(1f),
                    enabled = state.busyAction.isBlank(),
                    onClick = viewModel::probe,
                ) {
                    Icon(Icons.Default.CheckCircle, null)
                    Spacer(Modifier.width(6.dp))
                    Text("فحص الاتصال")
                }
            }
        }
        if (!state.diagnostics.permissionsGranted) item {
            ActionCard(
                icon = Icons.Default.Warning,
                title = "الأذونات ناقصة",
                description = "لن يتمكن التطبيق من معرفة المكالمة أو حفظ رقم المتصل حتى تمنح الأذونات.",
                action = "منح الآن",
                onClick = onGrantPermissions,
            )
        }
        if (CallerScreeningRole.isAvailable(context) && !CallerScreeningRole.isHeld(context)) item {
            ActionCard(
                icon = Icons.Default.Info,
                title = "تعريف المتصل من CRM",
                description = "ميزة اختيارية تعرض اسم العميل وآخر صفقة محليًا أثناء الرنين، دون استبدال تطبيق الهاتف.",
                action = "تفعيل تعريف المتصل",
                onClick = onRequestCallerScreening,
            )
        }
        if (!state.diagnostics.batteryUnrestricted) item { BatteryCard() }
        item {
            Card {
                Column(Modifier.padding(16.dp), verticalArrangement = Arrangement.spacedBy(10.dp)) {
                    Text("اختبار حدث", fontWeight = FontWeight.Bold, style = MaterialTheme.typography.titleMedium)
                    Text("تأكد من وصول حدث تجريبي إلى CRM قبل الاعتماد على المكالمات الحقيقية.")
                    OutlinedTextField(
                        value = testNumber,
                        onValueChange = { testNumber = it },
                        modifier = Modifier.fillMaxWidth(),
                        label = { Text("رقم متصل تجريبي") },
                        singleLine = true,
                        keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Phone),
                    )
                    Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                        OutlinedButton(onClick = { viewModel.enqueueTest("answered", testNumber) }, modifier = Modifier.weight(1f)) { Text("تم الرد") }
                        Button(onClick = { viewModel.enqueueTest("missed_call", testNumber) }, modifier = Modifier.weight(1f)) { Text("فائتة") }
                        OutlinedButton(onClick = { viewModel.enqueueTest("outgoing", testNumber) }, modifier = Modifier.weight(1f)) { Text("صادرة") }
                    }
                }
            }
        }
        if (state.activity.isNotEmpty()) item {
            Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                SectionTitle("آخر النشاط")
                state.activity.take(3).forEach { ActivityRow(it) }
            }
        }
        item { Spacer(Modifier.height(16.dp)) }
    }
}

@Composable
private fun ActivityScreen(state: GatewayUiState, viewModel: GatewayViewModel, modifier: Modifier = Modifier) {
    LazyColumn(
        modifier = modifier.fillMaxSize(),
        contentPadding = androidx.compose.foundation.layout.PaddingValues(16.dp),
        verticalArrangement = Arrangement.spacedBy(8.dp),
    ) {
        item {
            Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
                Column(Modifier.weight(1f)) {
                    Text("سجل النشاط", style = MaterialTheme.typography.headlineSmall, fontWeight = FontWeight.Bold)
                    Text("آخر 100 عملية مع إخفاء أرقام العملاء.")
                }
                if (state.activity.isNotEmpty()) IconButton(onClick = viewModel::clearActivity) {
                    Icon(Icons.Default.Delete, "مسح السجل")
                }
            }
        }
        if (state.activity.isEmpty()) item {
            EmptyState("لا يوجد نشاط بعد", "ستظهر هنا المكالمات الملتقطة ونتائج إرسالها إلى CRM.")
        } else items(state.activity, key = { it.id }) { ActivityRow(it) }
    }
}

@Composable
private fun SettingsScreen(
    state: GatewayUiState,
    viewModel: GatewayViewModel,
    onScanQr: () -> Unit,
    modifier: Modifier = Modifier,
) {
    val context = LocalContext.current
    var advanced by rememberSaveable { mutableStateOf(false) }
    var confirmDisconnect by rememberSaveable { mutableStateOf(false) }
    LazyColumn(
        modifier = modifier.fillMaxSize(),
        contentPadding = androidx.compose.foundation.layout.PaddingValues(16.dp),
        verticalArrangement = Arrangement.spacedBy(12.dp),
    ) {
        if (state.message.isNotBlank()) item { MessageCard(state.message) }
        item {
            Card {
                Column(Modifier.padding(16.dp), verticalArrangement = Arrangement.spacedBy(10.dp)) {
                    Text("اتصال CRM", style = MaterialTheme.typography.titleLarge, fontWeight = FontWeight.Bold)
                    ConnectionFields(state, viewModel, includeToken = advanced)
                    OutlinedButton(onClick = { advanced = !advanced }, modifier = Modifier.fillMaxWidth()) {
                        Icon(Icons.Default.Lock, null)
                        Spacer(Modifier.width(8.dp))
                        Text(if (advanced) "إخفاء التوكن اليدوي" else "إعداد متقدم: التوكن اليدوي")
                    }
                    if (advanced) state.configError?.let { Text(it, color = MaterialTheme.colorScheme.error) }
                    Button(
                        modifier = Modifier.fillMaxWidth(),
                        enabled = state.configError == null && state.busyAction.isBlank(),
                        onClick = viewModel::saveManualConfiguration,
                    ) {
                        Icon(Icons.Default.Done, null)
                        Spacer(Modifier.width(8.dp))
                        Text("حفظ الإعداد")
                    }
                }
            }
        }
        item {
            Card {
                Column(Modifier.padding(16.dp), verticalArrangement = Arrangement.spacedBy(10.dp)) {
                    Text("التشخيص والدعم", style = MaterialTheme.typography.titleMedium, fontWeight = FontWeight.Bold)
                    DiagnosticRow(Icons.Default.Info, "الإنترنت", if (state.diagnostics.networkAvailable) "متاح" else "غير متاح")
                    DiagnosticRow(Icons.Default.Settings, "البطارية", if (state.diagnostics.batteryUnrestricted) "غير مقيّد" else "قد يوقف الخلفية")
                    DiagnosticRow(Icons.Default.Info, "أذونات المكالمات", if (state.diagnostics.permissionsGranted) "مكتملة" else "ناقصة")
                    DiagnosticRow(Icons.Default.Refresh, "أحداث معلّقة", state.queue.pending.toString())
                    OutlinedButton(
                        modifier = Modifier.fillMaxWidth(),
                        onClick = {
                            val intent = Intent(Intent.ACTION_SEND).apply {
                                type = "text/plain"
                                putExtra(Intent.EXTRA_SUBJECT, "تقرير BreeXe Connect")
                                putExtra(Intent.EXTRA_TEXT, GatewayDiagnosticsReader.report(context))
                            }
                            context.startActivity(Intent.createChooser(intent, "مشاركة تقرير التشخيص"))
                        },
                    ) {
                        Icon(Icons.Default.Share, null)
                        Spacer(Modifier.width(8.dp))
                        Text("مشاركة تقرير آمن")
                    }
                }
            }
        }
        item {
            Card {
                Column(Modifier.padding(16.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                    Text("معلومات الربط", fontWeight = FontWeight.Bold)
                    LabeledValue("اسم الجوال", state.deviceName)
                    LabeledValue("معرّف الجهاز", state.registration.deviceId.ifBlank { "غير متاح" })
                    LabeledValue("الإصدار", "${BuildConfig.VERSION_NAME} (${BuildConfig.VERSION_CODE})")
                    OutlinedButton(onClick = onScanQr, modifier = Modifier.fillMaxWidth()) {
                        Icon(Icons.Default.Search, null)
                        Spacer(Modifier.width(8.dp))
                        Text("قراءة رمز ربط جديد")
                    }
                    if (state.pairingCode.isNotBlank()) {
                        OutlinedTextField(
                            value = state.pairingCode,
                            onValueChange = viewModel::updatePairingCode,
                            modifier = Modifier.fillMaxWidth(),
                            label = { Text("رمز الربط الجديد") },
                            singleLine = true,
                            keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.NumberPassword),
                        )
                        state.pairingError?.let { Text(it, color = MaterialTheme.colorScheme.error) }
                        Button(
                            onClick = viewModel::pair,
                            modifier = Modifier.fillMaxWidth(),
                            enabled = state.pairingError == null && state.busyAction.isBlank(),
                        ) {
                            if (state.busyAction == "pair") SmallProgress() else Icon(Icons.AutoMirrored.Filled.Send, null)
                            Spacer(Modifier.width(8.dp))
                            Text("إعادة ربط هذا الجوال")
                        }
                    }
                    OutlinedButton(onClick = { confirmDisconnect = true }, modifier = Modifier.fillMaxWidth()) {
                        Icon(Icons.AutoMirrored.Filled.ExitToApp, null, tint = MaterialTheme.colorScheme.error)
                        Spacer(Modifier.width(8.dp))
                        Text("فصل هذا الجوال", color = MaterialTheme.colorScheme.error)
                    }
                }
            }
        }
        if (state.queue.testEvents > 0) item {
            OutlinedButton(onClick = viewModel::clearTestEvents, modifier = Modifier.fillMaxWidth()) {
                Text("حذف ${state.queue.testEvents} أحداث تجريبية فقط")
            }
        }
        item { SecurityNote() }
    }
    if (confirmDisconnect) {
        AlertDialog(
            onDismissRequest = { confirmDisconnect = false },
            icon = { Icon(Icons.AutoMirrored.Filled.ExitToApp, null) },
            title = { Text("فصل الجوال؟") },
            text = { Text("سيُحذف مفتاح الربط من هذا الجوال فقط. لن تُحذف الأحداث المحفوظة. لإلغاء الصلاحية نهائيًا من جهاز مفقود، ألغِ الجهاز أيضًا من شاشة CRM.") },
            confirmButton = {
                Button(onClick = { confirmDisconnect = false; viewModel.disconnect() }) { Text("فصل الجوال") }
            },
            dismissButton = { OutlinedButton(onClick = { confirmDisconnect = false }) { Text("إلغاء") } },
        )
    }
}

@Composable
private fun ConnectionFields(state: GatewayUiState, viewModel: GatewayViewModel, includeToken: Boolean) {
    OutlinedTextField(
        value = state.serverUrl,
        onValueChange = viewModel::updateServer,
        modifier = Modifier.fillMaxWidth(),
        label = { Text("رابط خادم CRM") },
        supportingText = { Text("اتصال HTTPS فقط") },
        singleLine = true,
        keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Uri),
    )
    OutlinedTextField(
        value = state.companyNumber,
        onValueChange = viewModel::updateCompanyNumber,
        modifier = Modifier.fillMaxWidth(),
        label = { Text("رقم شريحة الشركة") },
        supportingText = { Text("مثال: +9665…") },
        singleLine = true,
        keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Phone),
    )
    OutlinedTextField(
        value = state.deviceName,
        onValueChange = viewModel::updateDeviceName,
        modifier = Modifier.fillMaxWidth(),
        label = { Text("اسم هذا الجوال") },
        supportingText = { Text("مثال: جوال المبيعات الرئيسي") },
        singleLine = true,
    )
    if (includeToken) OutlinedTextField(
        value = state.manualToken,
        onValueChange = viewModel::updateManualToken,
        modifier = Modifier.fillMaxWidth(),
        label = { Text("توكن البوابة") },
        singleLine = true,
        visualTransformation = PasswordVisualTransformation(),
    )
}

@Composable
private fun BrandHeader(modifier: Modifier = Modifier, centered: Boolean = false) {
    Row(
        modifier = modifier.fillMaxWidth(),
        horizontalArrangement = if (centered) Arrangement.Center else Arrangement.Start,
        verticalAlignment = Alignment.CenterVertically,
    ) {
        BrandMark()
        Spacer(Modifier.width(12.dp))
        Column(horizontalAlignment = if (centered) Alignment.CenterHorizontally else Alignment.Start) {
            Text("BreeXe Connect", style = MaterialTheme.typography.titleLarge, fontWeight = FontWeight.Bold, color = MaterialTheme.colorScheme.primary)
            Text("بوابة المكالمات الذكية", style = MaterialTheme.typography.bodySmall)
        }
    }
}

@Composable
private fun BrandMark() {
    Box(
        modifier = Modifier.size(52.dp).background(Navy, RoundedCornerShape(16.dp)),
        contentAlignment = Alignment.Center,
    ) {
        Icon(
            painter = painterResource(R.drawable.ic_launcher_monochrome),
            contentDescription = null,
            tint = Color.White,
            modifier = Modifier.size(34.dp),
        )
        Box(Modifier.align(Alignment.TopEnd).padding(8.dp).size(8.dp).background(Teal, CircleShape))
        Box(Modifier.align(Alignment.BottomEnd).padding(9.dp).size(6.dp).background(Gold, CircleShape))
    }
}

@Composable
private fun SetupStepCard(
    number: String,
    title: String,
    description: String,
    complete: Boolean,
    content: @Composable ColumnScope.() -> Unit,
) {
    Card {
        Column(Modifier.padding(16.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
            Row(verticalAlignment = Alignment.CenterVertically) {
                Box(
                    Modifier.size(34.dp).background(if (complete) Teal else Navy, CircleShape),
                    contentAlignment = Alignment.Center,
                ) {
                    if (complete) Icon(Icons.Default.CheckCircle, null, tint = Color.White, modifier = Modifier.size(22.dp))
                    else Text(number, color = Color.White, fontWeight = FontWeight.Bold)
                }
                Spacer(Modifier.width(10.dp))
                Column {
                    Text(title, fontWeight = FontWeight.Bold, style = MaterialTheme.typography.titleMedium)
                    Text(description, style = MaterialTheme.typography.bodySmall)
                }
            }
            content()
        }
    }
}

@Composable
private fun HealthCard(state: GatewayUiState) {
    val error = state.configError ?: state.runtime.lastError.takeIf { it.isNotBlank() }
    val ready = state.diagnostics.permissionsGranted && error == null && state.queue.pending == 0 && state.mobilePolicy.workSimKey.isNotBlank()
    val color = when {
        error != null || !state.diagnostics.permissionsGranted || state.mobilePolicy.workSimKey.isBlank() -> MaterialTheme.colorScheme.errorContainer
        state.queue.pending > 0 -> MaterialTheme.colorScheme.tertiaryContainer
        else -> MaterialTheme.colorScheme.secondaryContainer
    }
    Card(colors = CardDefaults.cardColors(containerColor = color)) {
        Column(Modifier.padding(18.dp), verticalArrangement = Arrangement.spacedBy(10.dp)) {
            Row(verticalAlignment = Alignment.CenterVertically) {
                Icon(if (ready) Icons.Default.CheckCircle else Icons.Default.Warning, null, modifier = Modifier.size(34.dp))
                Spacer(Modifier.width(10.dp))
                Column {
                    Text(if (ready) "البوابة جاهزة" else "تحتاج انتباهك", style = MaterialTheme.typography.titleLarge, fontWeight = FontWeight.Bold)
                    Text(if (ready) "يتم التقاط مكالمات شريحة العمل والمزامنة تلقائيًا." else error ?: if (state.mobilePolicy.workSimKey.isBlank()) "اختر شريحة العمل لهذا الجهاز من CRM؛ جميع الشرائح مغلقة مؤقتًا." else "يوجد ${state.queue.pending} أحداث بانتظار الإرسال.")
                }
            }
            HorizontalDivider()
            LabeledValue("أحداث معلقة", state.queue.pending.toString())
            LabeledValue("مهام اليوم", state.mobileDashboard.tasks.toString())
            LabeledValue("متابعات متأخرة", state.mobileDashboard.overdueTasks.toString())
            LabeledValue("مكالمات غير معالجة", state.mobileDashboard.pendingCalls.toString())
            LabeledValue("أوامر CRM", state.pendingCommands.toString())
            LabeledValue("شريحة العمل", if (state.mobilePolicy.workSimKey.isBlank()) "غير محددة" else "محددة وآمنة")
            LabeledValue("آخر نجاح", formatTime(state.runtime.lastSuccessAt))
        }
    }
}

@Composable
private fun BatteryCard() {
    val context = LocalContext.current
    ActionCard(
        icon = Icons.Default.Settings,
        title = "اسمح بالتشغيل في الخلفية",
        description = "بعض الأجهزة توقف المزامنة لتوفير البطارية. افتح الإعدادات واجعل التطبيق غير مقيّد.",
        action = "إعدادات البطارية",
        onClick = {
            context.startActivity(Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS, "package:${context.packageName}".toUri()))
        },
    )
}

@Composable
private fun ActionCard(icon: androidx.compose.ui.graphics.vector.ImageVector, title: String, description: String, action: String, onClick: () -> Unit) {
    Card(colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.tertiaryContainer)) {
        Column(Modifier.padding(16.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
            Row(verticalAlignment = Alignment.CenterVertically) {
                Icon(icon, null)
                Spacer(Modifier.width(8.dp))
                Text(title, fontWeight = FontWeight.Bold)
            }
            Text(description)
            FilledTonalButton(onClick = onClick) { Text(action) }
        }
    }
}

@Composable
private fun ActivityRow(entry: GatewayActivityEntry) {
    val icon = when (entry.kind) {
        "sent" -> Icons.Default.CheckCircle
        "error" -> Icons.Default.Warning
        "paired" -> Icons.AutoMirrored.Filled.Send
        "settings" -> Icons.Default.Settings
        else -> Icons.Default.Info
    }
    Card {
        Row(Modifier.fillMaxWidth().padding(14.dp), verticalAlignment = Alignment.CenterVertically) {
            Icon(icon, null, tint = if (entry.kind == "error") MaterialTheme.colorScheme.error else MaterialTheme.colorScheme.primary)
            Spacer(Modifier.width(12.dp))
            Column(Modifier.weight(1f)) {
                Text(entry.title, fontWeight = FontWeight.SemiBold)
                if (entry.detail.isNotBlank()) Text(entry.detail, style = MaterialTheme.typography.bodySmall)
            }
            Text(formatTime(entry.occurredAt), style = MaterialTheme.typography.labelSmall)
        }
    }
}

@Composable
private fun MessageCard(message: String) {
    Card(colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.primaryContainer)) {
        Text(message, Modifier.fillMaxWidth().padding(14.dp), color = MaterialTheme.colorScheme.onPrimaryContainer)
    }
}

@Composable
private fun SecurityNote() {
    Card(colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.surfaceVariant)) {
        Row(Modifier.padding(14.dp), verticalAlignment = Alignment.Top) {
            Icon(Icons.Default.Lock, null)
            Spacer(Modifier.width(10.dp))
            Text("مفتاح الربط مشفّر داخل Android Keystore. الاتصال يقبل HTTPS فقط ولا تُعرض أرقام العملاء في سجل النشاط.")
        }
    }
}

@Composable
private fun DiagnosticRow(icon: androidx.compose.ui.graphics.vector.ImageVector, label: String, value: String) {
    Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
        Icon(icon, null, modifier = Modifier.size(20.dp))
        Spacer(Modifier.width(8.dp))
        Text(label, Modifier.weight(1f))
        Text(value, fontWeight = FontWeight.SemiBold)
    }
}

@Composable
private fun LabeledValue(label: String, value: String) {
    Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween) {
        Text(label)
        Text(value, fontWeight = FontWeight.SemiBold)
    }
}

@Composable
private fun EmptyState(title: String, description: String) {
    Column(Modifier.fillMaxWidth().padding(32.dp), horizontalAlignment = Alignment.CenterHorizontally, verticalArrangement = Arrangement.spacedBy(8.dp)) {
        Icon(Icons.AutoMirrored.Filled.List, null, modifier = Modifier.size(48.dp), tint = MaterialTheme.colorScheme.outline)
        Text(title, fontWeight = FontWeight.Bold)
        Text(description, textAlign = TextAlign.Center)
    }
}

@Composable
private fun SectionTitle(title: String) {
    Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
        Text(title, Modifier.weight(1f), fontWeight = FontWeight.Bold, style = MaterialTheme.typography.titleMedium)
    }
}

@Composable
private fun SmallProgress() = CircularProgressIndicator(Modifier.size(20.dp), strokeWidth = 2.dp)

private fun formatTime(value: Long): String = if (value <= 0) "لا يوجد" else DateFormat.getDateTimeInstance(DateFormat.SHORT, DateFormat.SHORT).format(Date(value))
