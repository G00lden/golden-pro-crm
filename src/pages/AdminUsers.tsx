import { Edit3, Plus, RefreshCcw, Save, Search, Trash2, UserPlus, UserRoundCog, X } from "lucide-react";
import { useCallback, useEffect, useId, useMemo, useRef, useState, type FormEvent, type ReactNode } from "react";
import * as api from "../api";
import { UserRoleBadge } from "../components/UserRoleBadge";
import { useDialogAccessibility } from "../dialogAccessibility";

type Notifier = (message: string, ok?: boolean) => void;

const ROLE_OPTIONS: Array<{ value: api.AppUserRole; label: string }> = [
  { value: "admin", label: "مسؤول" },
  { value: "manager", label: "مدير" },
  { value: "sales", label: "مبيعات" },
  { value: "technician", label: "فني" },
  { value: "user", label: "مستخدم" },
];

const PERMISSION_OPTIONS = [
  ["mobile.devices.view", "مشاهدة الأجهزة"],
  ["mobile.devices.pair", "ربط جهاز جديد"],
  ["mobile.devices.manage", "إدارة الأجهزة والتعيين"],
  ["mobile.calls.view", "مشاهدة المكالمات"],
  ["mobile.calls.execute", "إرسال طلب اتصال للجوال"],
  ["mobile.calls.export", "تصدير سجلات المكالمات"],
  ["mobile.calls.bulk", "التحديد والإجراءات الجماعية"],
  ["mobile.whatsapp.send", "إرسال واتساب من المكالمات"],
  ["mobile.contacts.manage", "حفظ وتعديل جهات الاتصال"],
  ["mobile.contacts.sync", "مزامنة جهات الاتصال"],
  ["mobile.sims.manage", "إدارة شريحة العمل"],
  ["mobile.tasks.update", "تحديث المهام من الجوال"],
  ["mobile.reply_policy.manage", "إدارة سياسة واتساب"],
  ["mobile.tests.send", "إرسال تجربة واتساب"],
  ["mobile.device.lock", "قفل جهاز شركة"],
  ["mobile.device.wipe", "مسح بيانات الجهاز"],
] as const;

function fmtDateTime(value?: string | null) {
  if (!value) return "—";
  try {
    return new Date(value.replace(" ", "T") + (value.length === 19 ? "Z" : "")).toLocaleString("ar-SA");
  } catch {
    return value;
  }
}

export function AdminUsersPage({ notify, currentUid }: { notify: Notifier; currentUid: string | null }) {
  const [search, setSearch] = useState("");
  const [roleFilter, setRoleFilter] = useState<string>("");
  const [activeFilter, setActiveFilter] = useState<string>("");
  const [users, setUsers] = useState<api.ManagedAppUser[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [edit, setEdit] = useState<api.ManagedAppUser | null>(null);
  const [create, setCreate] = useState(false);

  const requestSeq = useRef(0);

  const refresh = useCallback(async () => {
    // Guard against out-of-order responses: a slower earlier request must not
    // overwrite the results of a newer filter/search. Only the latest request
    // is allowed to apply its result.
    const seq = ++requestSeq.current;
    setLoading(true);
    setError("");
    try {
      const res = await api.listAppUsers({
        search: search.trim() || undefined,
        role: roleFilter || undefined,
        active: activeFilter === "" ? undefined : activeFilter === "true",
      });
      if (seq !== requestSeq.current) return;
      setUsers(res.users);
    } catch (err) {
      if (seq !== requestSeq.current) return;
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      if (seq === requestSeq.current) setLoading(false);
    }
  }, [search, roleFilter, activeFilter]);

  useEffect(() => {
    const timer = setTimeout(refresh, 200);
    return () => clearTimeout(timer);
  }, [refresh]);

  const stats = useMemo(() => {
    const total = users.length;
    const admins = users.filter((u) => u.role === "admin").length;
    const active = users.filter((u) => u.active).length;
    const suspended = total - active;
    return { total, admins, active, suspended };
  }, [users]);

  const handleSave = async (id: string | null, payload: Partial<api.ManagedAppUser>) => {
    try {
      if (id) {
        await api.updateAppUser(id, {
          name: payload.name,
          email: payload.email,
          phone: payload.phone,
          role: payload.role,
          permissions: payload.permissions,
          active: payload.active,
        });
        notify("تم حفظ تعديلات المستخدم");
      } else {
        await api.createAppUser({
          name: payload.name || "",
          email: payload.email || undefined,
          phone: payload.phone || undefined,
          role: (payload.role as api.AppUserRole) || "user",
          permissions: payload.permissions,
        });
        notify("تم إضافة المستخدم");
      }
      setEdit(null);
      setCreate(false);
      await refresh();
    } catch (err) {
      notify(err instanceof Error ? err.message : "تعذر الحفظ", false);
    }
  };

  const toggleActive = async (user: api.ManagedAppUser) => {
    if (user.active && user.uid && user.uid === currentUid) {
      notify("لا يمكنك تعليق حسابك أثناء استخدامه.", false);
      return;
    }
    try {
      await api.setAppUserActive(user.id, !user.active);
      notify(user.active ? "تم تعليق المستخدم" : "تم تفعيل المستخدم");
      await refresh();
    } catch (err) {
      notify(err instanceof Error ? err.message : "تعذر تغيير الحالة", false);
    }
  };

  const remove = async (user: api.ManagedAppUser) => {
    if (user.uid && user.uid === currentUid) {
      notify("لا يمكنك حذف حسابك الحالي.", false);
      return;
    }
    if (!window.confirm(`حذف المستخدم ${user.name || user.email || user.id}؟`)) return;
    try {
      await api.deleteAppUser(user.id);
      notify("تم حذف المستخدم");
      await refresh();
    } catch (err) {
      notify(err instanceof Error ? err.message : "تعذر الحذف", false);
    }
  };

  return (
    <div className="users-workspace cloud-design">
      <div className="page-head users-hero">
        <div>
          <span className="eyebrow">Cloud Design</span>
          <h1>إدارة المستخدمين</h1>
          <p>أدوار وصلاحيات الوصول إلى BreeXe Pro CRM</p>
        </div>
        <div className="actions">
          <button className="btn primary" type="button" onClick={refresh} disabled={loading}>
            <RefreshCcw size={16} /> تحديث
          </button>
          <button className="btn primary" type="button" onClick={() => setCreate(true)}>
            <UserPlus size={16} /> إضافة مستخدم
          </button>
        </div>
      </div>

      <div className="stats-grid metric-grid users-metrics">
        <article className="stat">
          <span>الإجمالي</span>
          <strong>{stats.total}</strong>
        </article>
        <article className="stat">
          <span>مسؤولون</span>
          <strong>{stats.admins}</strong>
        </article>
        <article className="stat">
          <span>نشطون</span>
          <strong>{stats.active}</strong>
        </article>
        <article className="stat">
          <span>معلّقون</span>
          <strong>{stats.suspended}</strong>
        </article>
      </div>

      <div className="toolbar users-toolbar" style={{ gap: 8, flexWrap: "wrap" }}>
        <Search size={16} />
        <input
          className="input"
          name="admin_user_search"
          autoComplete="off"
          aria-label="بحث في المستخدمين"
          placeholder="بحث بالاسم أو البريد أو الجوال…"
          value={search}
          onChange={(event) => setSearch(event.target.value)}
          style={{ flex: 1, minWidth: 220 }}
        />
        <select
          className="input"
          name="admin_user_role_filter"
          autoComplete="off"
          aria-label="تصفية المستخدمين حسب الدور"
          value={roleFilter}
          onChange={(event) => setRoleFilter(event.target.value)}
          style={{ minWidth: 140 }}
        >
          <option value="">كل الأدوار</option>
          {ROLE_OPTIONS.map((opt) => (
            <option key={opt.value} value={opt.value}>{opt.label}</option>
          ))}
        </select>
        <select
          className="input"
          name="admin_user_status_filter"
          autoComplete="off"
          aria-label="تصفية المستخدمين حسب الحالة"
          value={activeFilter}
          onChange={(event) => setActiveFilter(event.target.value)}
          style={{ minWidth: 140 }}
        >
          <option value="">كل الحالات</option>
          <option value="true">نشط</option>
          <option value="false">معلق</option>
        </select>
      </div>

      {error && (
        <div className="error-box" role="alert">
          <span>{error}</span>
        </div>
      )}

      {loading ? (
        <div className="empty" role="status" aria-live="polite"><RefreshCcw size={26} className="spin" aria-hidden="true" /><p>جاري التحميل…</p></div>
      ) : users.length === 0 ? (
        <div className="empty">
          <UserRoundCog size={30} />
          <p>لا يوجد مستخدمون بعد</p>
          <button className="btn primary" type="button" onClick={() => setCreate(true)}>
            <Plus size={16} /> إضافة أول مستخدم
          </button>
        </div>
      ) : (
        <div className="list users-list">
          {users.map((user) => (
            <article className="row-card user-card" key={user.id}>
              <div className="row-main">
                <strong>{user.name || user.email || user.id}</strong>
                <span dir="ltr" style={{ direction: "ltr", textAlign: "right" }}>
                  {user.email || "—"} {user.phone ? `· ${user.phone}` : ""}
                </span>
                <div className="chips" style={{ gap: 6, flexWrap: "wrap" }}>
                  <UserRoleBadge role={user.role} />
                  <span className={`badge ${user.active ? "success" : "danger"}`}>{user.active ? "نشط" : "معلق"}</span>
                  <span className="badge muted">{user.provider}</span>
                  {user.last_login_at && (
                    <span className="badge muted">آخر دخول: {fmtDateTime(user.last_login_at)}</span>
                  )}
                  {user.uid && user.uid === currentUid && <span className="badge warn">حسابك</span>}
                </div>
              </div>
              <div className="row-actions">
                <button
                  className={`icon-btn ${user.active ? "" : "success"}`}
                  type="button"
                  title={user.active ? "تعليق" : "تفعيل"}
                  aria-label={`${user.active ? "تعليق" : "تفعيل"} المستخدم ${user.name || user.email || user.id}`}
                  onClick={() => toggleActive(user)}
                >
                  {user.active ? <X size={15} /> : <UserPlus size={15} />}
                </button>
                <button className="icon-btn" type="button" title="تعديل" aria-label={`تعديل المستخدم ${user.name || user.email || user.id}`} onClick={() => setEdit(user)}>
                  <Edit3 size={15} />
                </button>
                <button
                  className="icon-btn danger"
                  type="button"
                  title="حذف"
                  aria-label={`حذف المستخدم ${user.name || user.email || user.id}`}
                  onClick={() => remove(user)}
                >
                  <Trash2 size={15} />
                </button>
              </div>
            </article>
          ))}
        </div>
      )}

      {(edit || create) && (
        <UserModal title={edit ? "تعديل مستخدم" : "إضافة مستخدم"} onClose={() => { setEdit(null); setCreate(false); }}>
          <UserForm
            initial={edit || undefined}
            onCancel={() => { setEdit(null); setCreate(false); }}
            onSave={(payload) => handleSave(edit ? edit.id : null, payload)}
          />
        </UserModal>
      )}
    </div>
  );
}

function UserModal({ title, children, onClose }: { title: string; children: ReactNode; onClose: () => void }) {
  const dialogRef = useRef<HTMLElement>(null);
  const titleId = useId();
  useDialogAccessibility(dialogRef, onClose);

  return (
    <div className="modal-backdrop" role="presentation" onMouseDown={onClose}>
      <section
        ref={dialogRef}
        className="modal wide"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
        onMouseDown={(event) => event.stopPropagation()}
      >
        <header className="modal-head">
          <h2 id={titleId}>{title}</h2>
          <button className="icon-btn" type="button" title="إغلاق" aria-label="إغلاق" onClick={onClose}>
            <X size={16} aria-hidden="true" />
          </button>
        </header>
        {children}
      </section>
    </div>
  );
}

function UserForm({
  initial,
  onSave,
  onCancel,
}: {
  initial?: api.ManagedAppUser;
  onSave: (payload: Partial<api.ManagedAppUser>) => Promise<void>;
  onCancel: () => void;
}) {
  const [name, setName] = useState(initial?.name || "");
  const [email, setEmail] = useState(initial?.email || "");
  const [phone, setPhone] = useState(initial?.phone || "");
  const [role, setRole] = useState<api.AppUserRole>(initial?.role || "user");
  const [active, setActive] = useState<boolean>(initial?.active ?? true);
  const [permissions, setPermissions] = useState<Record<string, boolean>>(initial?.permissions || {});
  const [saving, setSaving] = useState(false);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setSaving(true);
    try {
      await onSave({
        name: name.trim(),
        email: email.trim() || null,
        phone: phone.trim(),
        role,
        permissions,
        active,
      });
    } finally {
      setSaving(false);
    }
  };

  return (
    <form className="form" aria-busy={saving} onSubmit={submit}>
      <label className="field">
        <span>الاسم</span>
        <input className="input" name="managed_user_name" autoComplete="name" value={name} onChange={(event) => setName(event.target.value)} required />
      </label>
      <label className="field">
        <span>البريد الإلكتروني</span>
        <input
          className="input"
          dir="ltr"
          type="email"
          name="managed_user_email"
          autoComplete="email"
          spellCheck={false}
          value={email}
          onChange={(event) => setEmail(event.target.value)}
        />
      </label>
      <label className="field">
        <span>الجوال</span>
        <input className="input" type="tel" inputMode="tel" name="managed_user_phone" autoComplete="tel" value={phone} onChange={(event) => setPhone(event.target.value)} placeholder="مثال: 05xxxxxxxx…" />
      </label>
      <label className="field">
        <span>الدور</span>
        <select className="input" name="managed_user_role" autoComplete="off" value={role} onChange={(event) => setRole(event.target.value as api.AppUserRole)}>
          {ROLE_OPTIONS.map((opt) => (
            <option key={opt.value} value={opt.value}>{opt.label}</option>
          ))}
        </select>
      </label>

      <fieldset className="managed-permissions">
        <legend>صلاحيات الجوال المخصصة</legend>
        <p className="note">اتركها «حسب الدور» لاستخدام التوزيع الافتراضي، أو امنح/امنع صلاحية لهذا المستخدم فقط.</p>
        <div className="managed-permissions-grid">
          {PERMISSION_OPTIONS.map(([capability, label]) => (
            <label className="field" key={capability}>
              <span>{label}</span>
              <select
                className="input"
                name={`permission_${capability.replaceAll(".", "_")}`}
                value={Object.prototype.hasOwnProperty.call(permissions, capability) ? String(permissions[capability]) : "inherit"}
                onChange={(event) => setPermissions((current) => {
                  const next = { ...current };
                  if (event.target.value === "inherit") delete next[capability];
                  else next[capability] = event.target.value === "true";
                  return next;
                })}
              >
                <option value="inherit">حسب الدور</option>
                <option value="true">سماح إضافي</option>
                <option value="false">منع صريح</option>
              </select>
            </label>
          ))}
        </div>
      </fieldset>

      {initial && (
        <label className="field" style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
          <input
            type="checkbox"
            name="managed_user_active"
            checked={active}
            onChange={(event) => setActive(event.target.checked)}
          />
          <span>الحساب نشط</span>
        </label>
      )}

      <div className="form-actions">
        <button className="btn primary" type="submit" disabled={saving} aria-busy={saving}>
          <Save size={16} aria-hidden="true" /> {saving ? "جاري الحفظ…" : "حفظ"}
        </button>
        <button className="btn muted" type="button" disabled={saving} onClick={onCancel}>إلغاء</button>
      </div>
    </form>
  );
}

export default AdminUsersPage;
