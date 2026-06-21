import type { CSSProperties } from "react";

export type UserRole = "admin" | "manager" | "sales" | "technician" | "user";

const ROLE_LABEL: Record<UserRole, string> = {
  admin: "مسؤول",
  manager: "مدير",
  sales: "مبيعات",
  technician: "فني",
  user: "مستخدم",
};

const ROLE_STYLE: Record<UserRole, CSSProperties> = {
  admin: { background: "#7c2d12", color: "#fff7ed", borderColor: "#9a3412" },
  manager: { background: "#1e3a8a", color: "#dbeafe", borderColor: "#1d4ed8" },
  sales: { background: "#854d0e", color: "#fef3c7", borderColor: "#a16207" },
  technician: { background: "#065f46", color: "#d1fae5", borderColor: "#047857" },
  user: { background: "#374151", color: "#e5e7eb", borderColor: "#4b5563" },
};

export function UserRoleBadge({ role }: { role: string | undefined | null }) {
  const safeRole = (["admin", "manager", "sales", "technician", "user"].includes(String(role || "")) ? role : "user") as UserRole;
  return (
    <span
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: 6,
        padding: "2px 10px",
        borderRadius: 999,
        fontSize: 12,
        fontWeight: 600,
        border: "1px solid",
        ...ROLE_STYLE[safeRole],
      }}
    >
      {ROLE_LABEL[safeRole]}
    </span>
  );
}

export default UserRoleBadge;
