import {
  BatteryCharging,
  CheckCircle2,
  CircleAlert,
  Cloud,
  KeyRound,
  MessageCircle,
  PhoneCall,
  RefreshCcw,
  ShieldCheck,
  Signal,
  Smartphone,
  Users,
} from "lucide-react";
import { useEffect, useMemo, useState, type FormEvent } from "react";
import QRCode from "qrcode";
import * as api from "../api";
import { Badge, Button, Field, Loading, SelectInput, TextArea, TextInput, useData } from "../shared";

type Props = {
  notify: (message: string, ok?: boolean) => void;
  canPairDevices: boolean;
  canManageDevices: boolean;
  canExecuteCalls: boolean;
  canManagePolicy: boolean;
  canSendTests: boolean;
};

const MODE_LABEL: Record<api.CallReplyMode, string> = {
  disabled: "إيقاف الرد التلقائي",
  specific: "أرقام محددة فقط",
  all_except: "الجميع ما عدا الأرقام المستثناة",
  all: "جميع المتصلين من شريحة العمل",
};

const DISPOSITION_LABEL: Record<api.CallReplyDisposition, string> = {
  no_answer: "لم يتم الرد",
  busy: "الخط مشغول",
  unreachable: "مغلق أو خارج التغطية",
  rejected: "تم رفض المكالمة",
  after_hours: "خارج أوقات الدوام",
};

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : "تعذر تنفيذ العملية.";
}

function isOnline(device: api.MobileDevice) {
  if (!device.last_seen_at || device.revoked_at) return false;
  return Date.now() - new Date(device.last_seen_at).getTime() < 10 * 60 * 1000;
}

function formatSeen(value: string | null) {
  if (!value) return "لم يتصل بعد";
  return new Intl.DateTimeFormat("ar-SA", { dateStyle: "short", timeStyle: "short" }).format(new Date(value));
}

function parseNumberLines(value: string) {
  return value.split(/\r?\n/).map((line) => line.trim()).filter(Boolean).map((line) => {
    const [phone, ...label] = line.split(/[،,]/);
    return { phone: phone.trim(), label: label.join(" ").trim() };
  });
}

function DeviceCard({
  device,
  users,
  canManage,
  canExecuteCalls,
  onChanged,
  notify,
}: {
  device: api.MobileDevice;
  users: api.MobileAssignableUser[];
  canManage: boolean;
  canExecuteCalls: boolean;
  onChanged: () => Promise<void>;
  notify: Props["notify"];
}) {
  const [assignedUserUid, setAssignedUserUid] = useState(device.assigned_user_uid || "");
  const [workSimKey, setWorkSimKey] = useState(device.work_sim_key || "");
  const [branchId, setBranchId] = useState(device.branch_id || "");
  const [saving, setSaving] = useState(false);
  const [commanding, setCommanding] = useState("");
  const [dialPhone, setDialPhone] = useState("");

  useEffect(() => {
    setAssignedUserUid(device.assigned_user_uid || "");
    setWorkSimKey(device.work_sim_key || "");
    setBranchId(device.branch_id || "");
  }, [device.assigned_user_uid, device.branch_id, device.work_sim_key]);

  const save = async () => {
    setSaving(true);
    try {
      await api.updateMobileDevice(device.id, {
        assignedUserUid: assignedUserUid || null,
        branchId: branchId.trim() || null,
        workSimKey: workSimKey || null,
      });
      await onChanged();
      notify("تم حفظ ربط الموظف وشريحة العمل.");
    } catch (error) {
      notify(errorMessage(error), false);
    } finally {
      setSaving(false);
    }
  };

  const sendCommand = async (type: api.MobileCommand["command_type"], payload?: Record<string, unknown>) => {
    setCommanding(type);
    try {
      await api.createMobileCommand(device.id, { type, payload, expiresInSeconds: type === "dial_request" ? 300 : 3600 });
      notify(type === "dial_request" ? "وصل طلب الاتصال إلى الجوال وينتظر تأكيد الموظف." : "تم إرسال الأمر الآمن إلى الجوال.");
      if (type === "dial_request") setDialPhone("");
    } catch (error) {
      notify(errorMessage(error), false);
    } finally {
      setCommanding("");
    }
  };

  const online = isOnline(device);
  const missingPermissions = Object.entries(device.permissions || {}).filter(([, granted]) => !granted).length;
  return (
    <article className="mobile-device-card">
      <header className="mobile-device-head">
        <span className="mobile-device-icon"><Smartphone size={22} aria-hidden="true" /></span>
        <div>
          <h3>{device.name}</h3>
          <p>{[device.manufacturer, device.model, device.platform_version && `Android ${device.platform_version}`].filter(Boolean).join(" · ") || "بانتظار بيانات الجهاز"}</p>
        </div>
        <Badge tone={device.revoked_at ? "danger" : online ? "success" : "warn"}>
          {device.revoked_at ? "مفصول" : online ? "متصل" : "غير متصل"}
        </Badge>
      </header>

      <div className="mobile-health-row">
        <span><BatteryCharging size={15} aria-hidden="true" /> {device.battery_percent ?? "—"}%</span>
        <span><Signal size={15} aria-hidden="true" /> {device.network_type || "غير معروف"}</span>
        <span><ShieldCheck size={15} aria-hidden="true" /> {missingPermissions ? `${missingPermissions} أذونات ناقصة` : "الأذونات سليمة"}</span>
      </div>
      <p className="note">آخر نبضة: {formatSeen(device.last_seen_at)} · إصدار التطبيق: {device.app_version || "—"}</p>

      {canManage && !device.revoked_at && (
        <div className="form-grid mobile-device-form">
          <Field label="الموظف المسؤول">
            <SelectInput name={`assigned_user_${device.id}`} value={assignedUserUid} onChange={(event) => setAssignedUserUid(event.target.value)}>
              <option value="">غير معيّن</option>
              {users.map((user) => <option key={user.uid} value={user.uid}>{user.name} · {user.role}</option>)}
            </SelectInput>
          </Field>
          <Field label="الفرع">
            <TextInput name={`branch_${device.id}`} autoComplete="off" value={branchId} onChange={(event) => setBranchId(event.target.value)} placeholder="مثال: الرياض" />
          </Field>
          <Field label="شريحة العمل المسموح رفعها">
            <SelectInput name={`work_sim_${device.id}`} value={workSimKey} onChange={(event) => setWorkSimKey(event.target.value)}>
              <option value="">لا توجد شريحة مختارة — إيقاف آمن</option>
              {device.sims.filter((sim) => Boolean(sim.active)).map((sim) => (
                <option key={sim.sim_key} value={sim.sim_key}>
                  الشريحة {Number(sim.slot_index ?? 0) + 1} · {sim.carrier_name || sim.display_name || "غير معروفة"}{sim.phone_suffix ? ` · ••••${sim.phone_suffix}` : ""}
                </option>
              ))}
            </SelectInput>
          </Field>
          <div className="mobile-field-action"><Button loading={saving} onClick={save}>حفظ الربط</Button></div>
        </div>
      )}

      {!device.revoked_at && (
        <div className="mobile-command-bar">
          {canManage && <Button tone="muted" loading={commanding === "collect_health"} onClick={() => sendCommand("collect_health")}><RefreshCcw size={15} aria-hidden="true" /> فحص الجهاز</Button>}
          {canManage && <Button tone="muted" loading={commanding === "sync_contacts"} onClick={() => sendCommand("sync_contacts")}><Users size={15} aria-hidden="true" /> مزامنة العملاء</Button>}
          {canExecuteCalls && (
            <div className="mobile-dial-row">
              <TextInput name={`dial_${device.id}`} inputMode="tel" autoComplete="tel" value={dialPhone} onChange={(event) => setDialPhone(event.target.value)} placeholder="رقم العميل للاتصال" aria-label={`رقم الاتصال من ${device.name}`} />
              <Button loading={commanding === "dial_request"} disabled={!dialPhone.trim() || !device.work_sim_key} onClick={() => sendCommand("dial_request", { phone: dialPhone.trim(), reason: "طلب اتصال من CRM" })}>
                <PhoneCall size={15} aria-hidden="true" /> اتصال
              </Button>
            </div>
          )}
        </div>
      )}
    </article>
  );
}

export default function MobileOperationsPage(props: Props) {
  const devices = useData(api.getMobileDevices, []);
  const users = useData(api.getMobileAssignableUsers, [], props.canManageDevices);
  const policyBundle = useData(api.getCallReplyPolicy, []);
  const [tab, setTab] = useState<"devices" | "policy" | "test">("devices");
  const [enabled, setEnabled] = useState(false);
  const [mode, setMode] = useState<api.CallReplyMode>("disabled");
  const [selectedDeviceId, setSelectedDeviceId] = useState("");
  const [selectedSimKey, setSelectedSimKey] = useState("");
  const [unifonicEnabled, setUnifonicEnabled] = useState(true);
  const [numbersText, setNumbersText] = useState("");
  const [confirmationPhrase, setConfirmationPhrase] = useState("");
  const [savingPolicy, setSavingPolicy] = useState(false);
  const [previewPhone, setPreviewPhone] = useState("0535848176");
  const [previewDisposition, setPreviewDisposition] = useState<api.CallReplyDisposition>("no_answer");
  const [preview, setPreview] = useState<{ message: string; allowed?: boolean; reason?: string } | null>(null);
  const [testing, setTesting] = useState(false);
  const [testConfirmed, setTestConfirmed] = useState(false);
  const [pairingCode, setPairingCode] = useState<api.GatewayPairingCode | null>(null);
  const [pairingSeconds, setPairingSeconds] = useState(0);
  const [pairingQr, setPairingQr] = useState("");
  const [pairingBusy, setPairingBusy] = useState(false);

  useEffect(() => {
    const policy = policyBundle.data?.policy;
    if (!policy) return;
    setEnabled(policy.enabled);
    setMode(policy.mode);
    setSelectedDeviceId(policy.selectedDeviceId || "");
    setSelectedSimKey(policy.selectedSimKey || "");
    setUnifonicEnabled(policy.unifonicEnabled);
    setNumbersText(policy.numbers.map((item) => item.label ? `${item.phone}, ${item.label}` : item.phone).join("\n"));
  }, [policyBundle.data?.policy.version]);

  useEffect(() => {
    if (!pairingCode) {
      setPairingSeconds(0);
      return;
    }
    const update = () => setPairingSeconds(Math.max(0, Math.ceil((new Date(pairingCode.expiresAt).getTime() - Date.now()) / 1000)));
    update();
    const timer = window.setInterval(update, 1000);
    return () => window.clearInterval(timer);
  }, [pairingCode]);

  useEffect(() => {
    if (!pairingCode || pairingSeconds <= 0) {
      setPairingQr("");
      return;
    }
    let active = true;
    const payload = `breexe-connect://pair?server=${encodeURIComponent(window.location.origin)}&code=${encodeURIComponent(pairingCode.code)}`;
    QRCode.toDataURL(payload, {
      width: 320,
      margin: 2,
      errorCorrectionLevel: "M",
      color: { dark: "#0B355C", light: "#FFFFFF" },
    }).then((value) => {
      if (active) setPairingQr(value);
    }).catch(() => {
      if (active) setPairingQr("");
    });
    return () => { active = false; };
  }, [pairingCode, pairingSeconds > 0]);

  const sourceDevices = policyBundle.data?.devices || devices.data || [];
  const selectedDevice = sourceDevices.find((device) => device.id === selectedDeviceId);
  const activeDevices = (devices.data || []).filter((device) => !device.revoked_at);
  const onlineDevices = activeDevices.filter(isOnline);
  const attentionDevices = activeDevices.filter((device) => !device.work_sim_key || !isOnline(device) || Object.values(device.permissions || {}).some((granted) => !granted));
  const waConnected = policyBundle.data?.whatsapp.provider === "web" && policyBundle.data?.whatsapp.status === "connected";
  const policyNumbers = useMemo(() => parseNumberLines(numbersText), [numbersText]);
  const needsOpenAllConfirmation = enabled && (mode === "all" || (mode === "all_except" && policyNumbers.length === 0));

  const savePolicy = async (event: FormEvent) => {
    event.preventDefault();
    setSavingPolicy(true);
    try {
      await api.updateCallReplyPolicy({
        enabled: enabled && mode !== "disabled",
        mode,
        selectedDeviceId: selectedDeviceId || null,
        selectedSimKey: selectedSimKey || null,
        unifonicEnabled,
        version: policyBundle.data?.policy.version || 0,
        confirmationPhrase,
        numbers: policyNumbers,
      });
      setConfirmationPhrase("");
      await Promise.all([policyBundle.refresh(), devices.refresh()]);
      props.notify("تم حفظ سياسة واتساب وتعميم الإصدار الجديد على الأجهزة.");
    } catch (error) {
      props.notify(errorMessage(error), false);
    } finally {
      setSavingPolicy(false);
    }
  };

  const runPreview = async () => {
    try {
      const result = await api.previewCallReply({ phone: previewPhone || undefined, disposition: previewDisposition });
      setPreview({ message: result.message, allowed: result.decision?.allowed, reason: result.decision?.reason });
    } catch (error) {
      props.notify(errorMessage(error), false);
    }
  };

  const sendTest = async () => {
    if (!testConfirmed) return;
    setTesting(true);
    try {
      const result = await api.sendCallReplyTest({ phone: previewPhone, disposition: previewDisposition, confirm: true });
      setPreview({ message: result.message, allowed: true, reason: `تم الإرسال: ${result.testId}` });
      setTestConfirmed(false);
      props.notify(`تم إرسال تجربة واحدة إلى ${result.phone}.`);
    } catch (error) {
      props.notify(errorMessage(error), false);
    } finally {
      setTesting(false);
    }
  };

  const createPairingCode = async () => {
    setPairingBusy(true);
    try {
      setPairingCode(await api.createGatewayPairingCode());
      props.notify("تم إنشاء رمز ربط آمن صالح لعشر دقائق.");
    } catch (error) {
      props.notify(errorMessage(error), false);
    } finally {
      setPairingBusy(false);
    }
  };

  if (devices.loading || policyBundle.loading) return <Loading />;
  const loadError = devices.error || policyBundle.error;

  return (
    <section className="mobile-operations-page">
      <header className="page-head">
        <div>
          <h1>مركز الجوال والموظفين</h1>
          <p>تحكم موحد بأجهزة العمل، شريحة الشركة، أوامر الاتصال وسياسة الرد عبر واتساب.</p>
        </div>
        <Button tone="muted" onClick={() => Promise.all([devices.refresh(), policyBundle.refresh(), props.canManageDevices ? users.refresh() : Promise.resolve()])}>
          <RefreshCcw size={16} aria-hidden="true" /> تحديث
        </Button>
      </header>

      {loadError && <div className="error-box" role="alert"><CircleAlert size={19} aria-hidden="true" /><span>{loadError}</span></div>}

      <div className="stats-grid mobile-ops-stats">
        <div className="stat"><span><Smartphone size={20} aria-hidden="true" /></span><div><strong>{activeDevices.length}</strong><p>أجهزة نشطة</p></div></div>
        <div className="stat"><span><Cloud size={20} aria-hidden="true" /></span><div><strong>{onlineDevices.length}</strong><p>متصلة الآن</p></div></div>
        <div className={attentionDevices.length ? "stat warn" : "stat"}><span><CircleAlert size={20} aria-hidden="true" /></span><div><strong>{attentionDevices.length}</strong><p>تحتاج معالجة</p></div></div>
        <div className={waConnected ? "stat" : "stat danger"}><span><MessageCircle size={20} aria-hidden="true" /></span><div><strong>{waConnected ? "جاهز" : "متوقف"}</strong><p>واتساب ويب</p></div></div>
      </div>

      <nav className="tabs" aria-label="أقسام مركز الجوال">
        <button type="button" className={tab === "devices" ? "active" : ""} aria-current={tab === "devices" ? "page" : undefined} onClick={() => setTab("devices")}>الأجهزة</button>
        {props.canManagePolicy && <button type="button" className={tab === "policy" ? "active" : ""} aria-current={tab === "policy" ? "page" : undefined} onClick={() => setTab("policy")}>سياسة واتساب</button>}
        {props.canSendTests && <button type="button" className={tab === "test" ? "active" : ""} aria-current={tab === "test" ? "page" : undefined} onClick={() => setTab("test")}>تجربة رقم</button>}
      </nav>

      {tab === "devices" && (
        <div className="mobile-device-list">
          {props.canPairDevices && (
            <section className="panel mobile-pairing-panel" aria-labelledby="mobile-pairing-title">
              <div className="panel-head">
                <div>
                  <h2 id="mobile-pairing-title"><KeyRound size={19} aria-hidden="true" /> ربط جوال جديد</h2>
                  <p className="note">افتح BreeXe Connect واضغط «مسح QR». الرمز يعمل مرة واحدة وينتهي خلال عشر دقائق.</p>
                </div>
                <Button loading={pairingBusy} onClick={createPairingCode}>{pairingCode && pairingSeconds > 0 ? "إنشاء رمز جديد" : "إنشاء QR للربط"}</Button>
              </div>
              <div aria-live="polite">
                {pairingCode && pairingSeconds > 0 ? (
                  <div className="mobile-pairing-code">
                    {pairingQr && <img src={pairingQr} width={176} height={176} decoding="async" alt="رمز QR مؤقت لربط تطبيق BreeXe Connect" />}
                    <div>
                      <span className="note">أو أدخل الرمز يدويًا داخل التطبيق</span>
                      <code dir="ltr" translate="no">{pairingCode.code}</code>
                      <span className="note">متبقٍ {new Intl.NumberFormat("ar-SA").format(Math.ceil(pairingSeconds / 60))} دقيقة · الخادم: <span dir="ltr" translate="no">{window.location.origin}</span></span>
                    </div>
                  </div>
                ) : pairingCode ? <p className="note warn-text">انتهت صلاحية الرمز. أنشئ رمزًا جديدًا للمتابعة.</p> : null}
              </div>
            </section>
          )}
          {activeDevices.length ? activeDevices.map((device) => (
            <DeviceCard key={device.id} device={device} users={users.data || []} canManage={props.canManageDevices} canExecuteCalls={props.canExecuteCalls} onChanged={devices.refresh} notify={props.notify} />
          )) : (
            <div className="empty" role="status" aria-live="polite"><Smartphone size={28} aria-hidden="true" /><p>لا يوجد جهاز مربوط. أنشئ رمز QR أعلاه ثم امسحه بتطبيق BreeXe Connect.</p></div>
          )}
        </div>
      )}

      {tab === "policy" && (
        <form className="panel form mobile-policy-form" onSubmit={savePolicy}>
          <div className="panel-head"><div><h2>من تصله رسالة بعد المكالمة؟</h2><p className="note">الشريحة الشخصية لا تدخل في السياسة ولا تُرفع بياناتها إلى CRM.</p></div><Badge tone={enabled ? "success" : "muted"}>{enabled ? "مفعلة" : "متوقفة"}</Badge></div>
          <label className="mobile-toggle"><input name="policy_enabled" type="checkbox" checked={enabled} disabled={!props.canManagePolicy} onChange={(event) => { const next = event.target.checked; setEnabled(next); if (next && mode === "disabled") setMode("specific"); }} /><span>تفعيل الرد الآلي لمكالمات شريحة العمل غير المجابة</span></label>
          <fieldset className="mobile-mode-grid" disabled={!props.canManagePolicy || !enabled}>
            <legend>نطاق الإرسال</legend>
            {(Object.keys(MODE_LABEL) as api.CallReplyMode[]).filter((item) => item !== "disabled").map((item) => (
              <label key={item} className={mode === item ? "mobile-mode-option active" : "mobile-mode-option"}><input type="radio" name="reply_mode" value={item} checked={mode === item} onChange={() => setMode(item)} /><span>{MODE_LABEL[item]}</span></label>
            ))}
          </fieldset>
          <div className="form-grid">
            <Field label="الجهاز المصدر">
              <SelectInput name="policy_device" value={selectedDeviceId} disabled={!props.canManagePolicy || !enabled} onChange={(event) => { setSelectedDeviceId(event.target.value); setSelectedSimKey(""); }}>
                <option value="">اختر جهاز الموظف</option>
                {sourceDevices.filter((device) => !device.revoked_at).map((device) => <option key={device.id} value={device.id}>{device.name}{device.assigned_user_name ? ` · ${device.assigned_user_name}` : ""}</option>)}
              </SelectInput>
            </Field>
            <Field label="شريحة العمل">
              <SelectInput name="policy_sim" value={selectedSimKey} disabled={!props.canManagePolicy || !enabled || !selectedDevice} onChange={(event) => setSelectedSimKey(event.target.value)}>
                <option value="">اختر شريحة العمل</option>
                {(selectedDevice?.sims || []).filter((sim) => Boolean(sim.active)).map((sim) => <option key={sim.sim_key} value={sim.sim_key}>الشريحة {Number(sim.slot_index ?? 0) + 1} · {sim.carrier_name || "غير معروفة"}</option>)}
              </SelectInput>
            </Field>
          </div>
          {(mode === "specific" || mode === "all_except") && (
            <Field label={mode === "specific" ? "الأرقام التي ستستلم الرسالة" : "الأرقام المستثناة من الرسالة"}>
              <TextArea name="policy_numbers" dir="ltr" disabled={!props.canManagePolicy || !enabled} value={numbersText} onChange={(event) => setNumbersText(event.target.value)} placeholder={"966535848176, عميل تجريبي\n9665XXXXXXXX, اسم اختياري"} />
            </Field>
          )}
          <label className="mobile-toggle"><input name="unifonic_enabled" type="checkbox" checked={unifonicEnabled} disabled={!props.canManagePolicy || !enabled} onChange={(event) => setUnifonicEnabled(event.target.checked)} /><span>تطبيق السياسة أيضًا على التحويل الاحتياطي من Unifonic</span></label>
          {needsOpenAllConfirmation && (
            <Field label="تأكيد فتح الإرسال للجميع">
              <TextInput name="policy_confirmation" autoComplete="off" value={confirmationPhrase} disabled={!props.canManagePolicy} onChange={(event) => setConfirmationPhrase(event.target.value)} placeholder="اكتب: فتح الرد للجميع" />
            </Field>
          )}
          <div className="mobile-policy-summary" role="status" aria-live="polite">
            <CheckCircle2 size={18} aria-hidden="true" />
            <span>{enabled ? `${MODE_LABEL[mode]} · ${policyNumbers.length} رقم في القائمة · الجمعة مغلق، والدوام 8 ص–9 م بتوقيت الرياض.` : "الرد التلقائي متوقف؛ المكالمات والمهام تبقى مسجلة دون رسالة للعميل."}</span>
          </div>
          {props.canManagePolicy && <div className="form-actions"><Button type="submit" loading={savingPolicy}>حفظ ونشر السياسة</Button></div>}
        </form>
      )}

      {tab === "test" && props.canSendTests && (
        <section className="panel form mobile-test-panel">
          <div className="panel-head"><div><h2>تجربة واتساب لمرة واحدة</h2><p className="note">تُرسل فورًا فقط ولا تدخل الطابور إذا كان واتساب غير متصل. الحد: 5 تجارب في الساعة.</p></div><Badge tone={waConnected ? "success" : "danger"}>{waConnected ? "واتساب متصل" : "واتساب غير متصل"}</Badge></div>
          <div className="form-grid">
            <Field label="رقم التجربة">
              <TextInput name="test_phone" inputMode="tel" autoComplete="tel" dir="ltr" value={previewPhone} onChange={(event) => setPreviewPhone(event.target.value)} placeholder="0535848176" />
            </Field>
            <Field label="نتيجة المكالمة التجريبية">
              <SelectInput name="test_disposition" value={previewDisposition} onChange={(event) => setPreviewDisposition(event.target.value as api.CallReplyDisposition)}>
                {(Object.keys(DISPOSITION_LABEL) as api.CallReplyDisposition[]).map((item) => <option key={item} value={item}>{DISPOSITION_LABEL[item]}</option>)}
              </SelectInput>
            </Field>
          </div>
          <div className="form-actions"><Button tone="muted" onClick={runPreview}>معاينة الرسالة</Button></div>
          {preview && <div className="mobile-message-preview" role="status" aria-live="polite"><MessageCircle size={18} aria-hidden="true" /><div><strong>{preview.allowed === false ? "لن تُرسل وفق السياسة الحالية" : "نص الرسالة"}</strong><p>{preview.message}</p>{preview.reason && <small>{preview.reason}</small>}</div></div>}
          <label className="mobile-test-confirm"><input name="confirm_test" type="checkbox" checked={testConfirmed} onChange={(event) => setTestConfirmed(event.target.checked)} /><span>أؤكد إرسال رسالة حقيقية واحدة الآن إلى الرقم المكتوب.</span></label>
          <div className="form-actions"><Button tone="success" loading={testing} disabled={!waConnected || !previewPhone.trim() || !testConfirmed} onClick={sendTest}><MessageCircle size={16} aria-hidden="true" /> إرسال التجربة الآن</Button></div>
        </section>
      )}
    </section>
  );
}
