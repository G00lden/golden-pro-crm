export const MAINTENANCE_REQUEST_STATUSES = [
  "new",
  "approved",
  "scheduled",
  "in_progress",
  "closed",
  "rejected",
  "cancelled",
] as const;

export type MaintenanceRequestStatus = typeof MAINTENANCE_REQUEST_STATUSES[number];

export const maintenanceRequestTransitions: Record<MaintenanceRequestStatus, readonly MaintenanceRequestStatus[]> = {
  new: ["approved", "scheduled", "rejected", "cancelled"],
  approved: ["scheduled", "rejected", "cancelled"],
  scheduled: ["scheduled", "in_progress", "closed", "cancelled"],
  in_progress: ["closed", "cancelled"],
  closed: [],
  rejected: [],
  cancelled: [],
};

export function isMaintenanceRequestStatus(value: unknown): value is MaintenanceRequestStatus {
  return MAINTENANCE_REQUEST_STATUSES.includes(value as MaintenanceRequestStatus);
}

export function canTransitionMaintenanceRequest(
  from: MaintenanceRequestStatus,
  to: MaintenanceRequestStatus,
) {
  return maintenanceRequestTransitions[from].includes(to);
}

export function maintenanceRequestStatusLabel(status: MaintenanceRequestStatus) {
  const labels: Record<MaintenanceRequestStatus, string> = {
    new: "جديد",
    approved: "معتمد",
    scheduled: "مجدول للفني",
    in_progress: "قيد التنفيذ",
    closed: "مغلق",
    rejected: "مرفوض",
    cancelled: "ملغي",
  };
  return labels[status];
}

export function maintenanceRequestStatusTone(status: MaintenanceRequestStatus) {
  if (status === "closed") return "success" as const;
  if (status === "rejected" || status === "cancelled") return "danger" as const;
  if (status === "new" || status === "in_progress") return "warn" as const;
  return "muted" as const;
}
