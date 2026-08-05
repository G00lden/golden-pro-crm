const maintenanceTimeFormatter = new Intl.DateTimeFormat("ar-SA-u-nu-latn", {
  hour: "numeric",
  minute: "2-digit",
  hour12: true,
  timeZone: "UTC",
});

export function formatMaintenanceTime(value?: string | null) {
  const normalized = String(value || "").trim();
  if (!normalized) return "";
  const match = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(normalized);
  if (!match) return normalized;
  const hour = Number(match[1]);
  const minute = Number(match[2]);
  return maintenanceTimeFormatter.format(new Date(Date.UTC(2000, 0, 1, hour, minute)));
}
