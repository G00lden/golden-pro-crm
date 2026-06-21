import { Edit3, Plus, RefreshCcw, Save, Search, Trash2, UserPlus, UserRoundCog, X } from "lucide-react";
import { useCallback, useEffect, useMemo, useState, type FormEvent } from "react";
import * as api from "../api";
import { UserRoleBadge } from "../components/UserRoleBadge";

type Notifier = (message: string, ok?: boolean) => void;

const ROLE_OPTIONS: Array<{ value: api.AppUserRole; label: string }> = [
  { value: "admin", label: "مسؤول" },
  { value: "manager", label: "مدير" },
  { value: "sales", label: "مبيعات" },
  { value: "technician", label: "فني" },
  { value: "user", label: "مستخدم" },
];

const PERMISSION_OPTIONS: Array<{ key: string; label: string }> = [
  { key: "manage_customers", label: "إدارة العملاء" },
  { key: "manage_products", label: "إدارة المنتجات" },
  { key: "manage_installations", label: "إدارة الصيانة" },
  { key: "manage_bookings", label: "إدارة الحجوزات" },
  { key: "manage_technicians", label: "إدارة الفنيين" },
  { key: "send_messages", label: "إرسال رسائل واتساب" },
  { key: "view_reports", label: "عرض التقارير" },
];

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

  const refresh = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const res = await api.listAppUsers({
        search: search.trim() || undefined,
        role: roleFilter || undefined,
        active: activeFilter === "" ? undefined : activeFilter === "true",
      });
      setUsers(res.users);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
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
          placeholder="بحث بالاسم أو البريد أو الجوال"
          value={search}
          onChange={(event) => setSearch(event.target.value)}
          style={{ flex: 1, minWidth: 220 }}
        />
        <select
          className="input"
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
        <div className="empty"><RefreshCcw size={26} className="spin" /><p>جاري التحميل...</p></div>
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
                  onClick={() => toggleActive(user)}
                >
                  {user.active ? <X size={15} /> : <UserPlus size={15} />}
                </button>
                <button className="icon-btn" type="button" title="تعديل" onClick={() => setEdit(user)}>
                  <Edit3 size={15} />
                </button>
                <button
                  className="icon-btn danger"
                  type="button"
                  title="حذف"
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
        <div className="modal-backdrop" onMouseDown={() => { setEdit(null); setCreate(false); }}>
          <section className="modal" onMouseDown={(event) => event.stopPropagation()}>
            <header className="modal-head">
              <h2>{edit ? "تعديل مستخدم" : "إضافة مستخدم"}</h2>
              <button className="icon-btn" type="button" title="إغلاق" onClick={() => { setEdit(null); setCreate(false); }}>
                <X size={16} />
              </button>
            </header>
            <UserForm
              initial={edit || undefined}
              onCancel={() => { setEdit(null); setCreate(false); }}
              onSave={(payload) => handleSave(edit ? edit.id : null, payload)}
            />
          </section>
        </div>
      )}
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

  const togglePerm = (key: string) => {
    setPermissions((prev) => ({ ...prev, [key]: !prev[key] }));
  };

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setSaving(true);
    try {
      await onSave({
        name: name.trim(),
        email: email.trim() || null,
        phone: phone.trim(),
        role,
        active,
        permissions,
      });
    } finally {
      setSaving(false);
    }
  };

  return (
    <form className="form" onSubmit={submit}>
      <label className="field">
        <span>الاسم</span>
        <input className="input" value={name} onChange={(event) => setName(event.target.value)} required />
      </label>
      <label className="field">
        <span>البريد الإلكتروني</span>
        <input
          className="input"
          dir="ltr"
          type="email"
          value={email}
          onChange={(event) => setEmail(event.target.value)}
        />
      </label>
      <label className="field">
        <span>الجوال</span>
        <input className="input" value={phone} onChange={(event) => setPhone(event.target.value)} placeholder="05xxxxxxxx" />
      </label>
      <label className="field">
        <span>الدور</span>
        <select className="input" value={role} onChange={(event) => setRole(event.target.value as api.AppUserRole)}>
          {ROLE_OPTIONS.map((opt) => (
            <option key={opt.value} value={opt.value}>{opt.label}</option>
          ))}
        </select>
      </label>

      {initial && (
        <label className="field" style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
          <input
            type="checkbox"
            checked={active}
            onChange={(event) => setActive(event.target.checked)}
          />
          <span>الحساب نشط</span>
        </label>
      )}

      <fieldset className="permission-box">
        <legend style={{ padding: "0 6px", fontSize: 13 }}>صلاحيات إضافية</legend>
        <div className="permission-grid">
          {PERMISSION_OPTIONS.map((opt) => (
            <label key={opt.key} className="check-row">
              <input
                type="checkbox"
                checked={!!permissions[opt.key]}
                onChange={() => togglePerm(opt.key)}
              />
              <span>{opt.label}</span>
            </label>
          ))}
        </div>
        <p className="helper-text">
          المسؤول (admin) يحصل على جميع الصلاحيات تلقائياً بدون الحاجة لتفعيلها.
        </p>
      </fieldset>

      <div className="form-actions">
        <button className="btn primary" type="submit" disabled={saving}>
          <Save size={16} /> {saving ? "جاري الحفظ..." : "حفظ"}
        </button>
        <button className="btn muted" type="button" onClick={onCancel}>إلغاء</button>
      </div>
    </form>
  );
}

export default AdminUsersPage;
