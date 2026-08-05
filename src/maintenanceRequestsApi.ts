import { apiFetch, apiFetchResponse } from "./api";
import type { MaintenanceRequestStatus } from "../shared/maintenanceRequest";

export type MaintenanceRequestEvent = {
  id?: string;
  action: string;
  from_status?: MaintenanceRequestStatus | null;
  to_status?: MaintenanceRequestStatus | null;
  message?: string;
  created_at?: string;
  createdAt?: string;
  actor_type?: string;
  customer_visible?: boolean;
};

export type MaintenanceRequest = {
  id: string;
  request_number: string;
  status: MaintenanceRequestStatus;
  customer_id?: string;
  customer_name: string;
  customer_phone?: string;
  city?: string;
  address?: string;
  service_type: string;
  request_type: "repair" | "periodic";
  product_id?: string;
  product_name: string;
  product_category?: string;
  product_image_url?: string;
  maintenance_kind?: "filter_change" | "cooling_cells" | "";
  maintenance_kit_id?: string;
  maintenance_kit_name?: string;
  maintenance_kit_category?: string;
  maintenance_kit_sku?: string;
  installation_id?: string;
  issue_description: string;
  warranty_status?: "yes" | "no" | "unknown";
  invoice_number?: string;
  preferred_date?: string | null;
  preferred_time?: string | null;
  scheduled_date?: string | null;
  scheduled_time?: string | null;
  technician_id?: string;
  technician_name?: string | null;
  booking_id?: string;
  customer_change_requested?: boolean;
  customer_change_note?: string;
  resolution_note?: string | null;
  portal_token?: string | null;
  portal_token_version?: number;
  portal_access_revoked_at?: string | null;
  customer_latitude?: number | null;
  customer_longitude?: number | null;
  location_accuracy?: number | null;
  location_url?: string | null;
  phone_verified?: boolean;
  phone_verified_at?: string | null;
  attachment_count?: number;
  created_at?: string;
  createdAt?: string;
  updated_at?: string;
  updatedAt?: string;
};

export type PublicMaintenanceRequest = Omit<MaintenanceRequest, "id" | "customer_phone" | "customer_id" | "portal_token"> & {
  events: MaintenanceRequestEvent[];
};

export type MaintenanceRequestList = {
  data: MaintenanceRequest[];
  stats: { total: number; new: number; active: number; closed: number; customer_changes: number };
  capped: boolean;
};

export type MaintenanceAttachment = { id: string; kind: "image" | "video"; media_type: string; byte_size: number };
export type MaintenanceProduct = { id: string; name: string; category: string; sku: string; image_url: string };
export type MaintenanceKitOption = MaintenanceProduct & {
  kind: "filter_change" | "cooling_cells";
  compatibility_note: string;
};
export type MaintenanceSlot = { time: string; available: boolean; capacity: number };
export type MaintenanceAvailability = {
  ready: boolean;
  dates: Array<{ date: string; slots: MaintenanceSlot[] }>;
  settings: { location_required: boolean; attachments_enabled: boolean };
};
export type MaintenancePortalSettings = {
  slot_times: string[];
  closed_weekdays: number[];
  booking_horizon_days: number;
  slot_capacity: number;
  min_lead_hours: number;
  location_required: boolean;
  attachments_enabled: boolean;
  whatsapp_verification_required: boolean;
};

export type MaintenanceRequestAction =
  | { action: "approve"; note?: string }
  | { action: "reject"; reason: string }
  | { action: "assign"; technician_id: string; date: string; scheduled_time: string; note?: string }
  | { action: "start"; note?: string }
  | { action: "close"; note: string }
  | { action: "close_override"; reason: string }
  | { action: "rotate_portal_link" }
  | { action: "revoke_portal_link" }
  | { action: "cancel"; reason: string };

async function publicFetch<T>(path: string, init: RequestInit = {}) {
  const headers = new Headers(init.headers);
  if (init.body && !headers.has("Content-Type")) headers.set("Content-Type", "application/json");
  const response = await fetch(path, { ...init, headers });
  const text = await response.text();
  let body: any = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = null;
  }
  if (!response.ok) throw new Error(body?.error || `تعذر إكمال الطلب (HTTP ${response.status}).`);
  return body as T;
}

export function customerPortalUrl(token?: string) {
  const url = new URL(window.location.origin);
  url.searchParams.set("maintenance", "customer");
  if (token) url.searchParams.set("token", token);
  return url.toString();
}

export function getMaintenanceRequests(filters: { status?: string; search?: string } = {}) {
  const params = new URLSearchParams();
  if (filters.status) params.set("status", filters.status);
  if (filters.search) params.set("search", filters.search);
  return apiFetch<MaintenanceRequestList>(`/api/maintenance-requests${params.size ? `?${params}` : ""}`);
}

export function getMaintenanceRequest(id: string) {
  return apiFetch<{ request: MaintenanceRequest; events: MaintenanceRequestEvent[]; attachments: MaintenanceAttachment[] }>(
    `/api/maintenance-requests/${encodeURIComponent(id)}`,
  );
}

export function actOnMaintenanceRequest(id: string, action: MaintenanceRequestAction) {
  return apiFetch<{ success: true; request: MaintenanceRequest; events: MaintenanceRequestEvent[] }>(
    `/api/maintenance-requests/${encodeURIComponent(id)}/action`,
    { method: "POST", body: JSON.stringify(action) },
  );
}

export function createPublicMaintenanceRequest(payload: {
  client_request_id: string;
  customer_name: string;
  customer_phone: string;
  city?: string;
  address: string;
  request_type: "repair" | "periodic";
  product_id: string;
  maintenance_kit_id?: string;
  issue_description: string;
  warranty_status: "yes" | "no" | "unknown";
  invoice_number?: string;
  preferred_date: string;
  preferred_time: string;
  customer_latitude?: number;
  customer_longitude?: number;
  location_accuracy?: number;
  location_url?: string;
  verification_id: string;
  verification_token: string;
  attachment_ids: string[];
  accept_terms: true;
  website?: string;
}) {
  return publicFetch<{ success: true; portal_token: string; request: PublicMaintenanceRequest }>(
    "/public/maintenance-requests",
    { method: "POST", body: JSON.stringify(payload) },
  );
}

export function getPublicMaintenanceProducts(query = "", mode: "repair" | "periodic" = "repair") {
  const params = new URLSearchParams({ mode });
  if (query) params.set("q", query);
  return publicFetch<{ data: MaintenanceProduct[] }>(`/public/maintenance-products?${params}`);
}

export function getPublicMaintenanceKits(productId: string) {
  return publicFetch<{ data: MaintenanceKitOption[] }>(`/public/maintenance-kits?product_id=${encodeURIComponent(productId)}`);
}

export function getPublicMaintenanceAvailability() {
  return publicFetch<MaintenanceAvailability>("/public/maintenance-availability");
}

export function requestPublicMaintenanceVerification(customerPhone: string) {
  return publicFetch<{ verification_id: string; expires_in_seconds: number; phone_hint: string }>(
    "/public/maintenance-phone-verification",
    { method: "POST", body: JSON.stringify({ customer_phone: customerPhone }) },
  );
}

export function confirmPublicMaintenanceVerification(verificationId: string, customerPhone: string, code: string) {
  return publicFetch<{ verification_token: string; expires_in_seconds: number }>(
    "/public/maintenance-phone-verification/confirm",
    { method: "POST", body: JSON.stringify({ verification_id: verificationId, customer_phone: customerPhone, code }) },
  );
}

export async function uploadPublicMaintenanceAttachment(
  file: File,
  verificationId: string,
  verificationToken: string,
) {
  return publicFetch<MaintenanceAttachment>("/public/maintenance-attachments", {
    method: "POST",
    headers: {
      "Content-Type": file.type,
      "X-Maintenance-Verification-Id": verificationId,
      "X-Maintenance-Verification-Token": verificationToken,
    },
    body: file,
  });
}

export function getMaintenancePortalSettings() {
  return apiFetch<{ settings: MaintenancePortalSettings; availability: MaintenanceAvailability }>("/api/maintenance-portal/settings");
}

export function saveMaintenancePortalSettings(settings: MaintenancePortalSettings) {
  return apiFetch<{ success: true; settings: MaintenancePortalSettings; availability: MaintenanceAvailability }>(
    "/api/maintenance-portal/settings",
    { method: "PUT", body: JSON.stringify(settings) },
  );
}

export async function openMaintenanceAttachment(requestId: string, attachmentId: string) {
  const response = await apiFetchResponse(`/api/maintenance-requests/${encodeURIComponent(requestId)}/attachments/${encodeURIComponent(attachmentId)}`);
  if (!response.ok) {
    const body = await response.json().catch(() => null);
    throw new Error(body?.error || "تعذر فتح المرفق.");
  }
  const url = URL.createObjectURL(await response.blob());
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.target = "_blank";
  anchor.rel = "noreferrer";
  anchor.click();
  window.setTimeout(() => URL.revokeObjectURL(url), 60_000);
}

export function getPublicMaintenanceRequest(token: string) {
  return publicFetch<{ request: PublicMaintenanceRequest }>(
    `/public/maintenance-request?token=${encodeURIComponent(token)}`,
  );
}

export function actOnPublicMaintenanceRequest(
  payload:
    | { token: string; action: "cancel"; reason: string }
    | { token: string; action: "request_reschedule"; preferred_date: string; preferred_time: string; note?: string },
) {
  return publicFetch<{ success: true; request: PublicMaintenanceRequest }>(
    "/public/maintenance-request/action",
    { method: "POST", body: JSON.stringify(payload) },
  );
}
