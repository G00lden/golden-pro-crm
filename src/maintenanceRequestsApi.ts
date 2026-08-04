import { apiFetch } from "./api";
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
  product_id?: string;
  product_name: string;
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
  return apiFetch<{ request: MaintenanceRequest; events: MaintenanceRequestEvent[] }>(
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
  service_type: string;
  product_name: string;
  issue_description: string;
  warranty_status: "yes" | "no" | "unknown";
  invoice_number?: string;
  preferred_date?: string;
  preferred_time?: string;
  accept_terms: true;
  website?: string;
}) {
  return publicFetch<{ success: true; portal_token: string; request: PublicMaintenanceRequest }>(
    "/public/maintenance-requests",
    { method: "POST", body: JSON.stringify(payload) },
  );
}

export function getPublicMaintenanceRequest(token: string) {
  return publicFetch<{ request: PublicMaintenanceRequest }>(
    `/public/maintenance-request?token=${encodeURIComponent(token)}`,
  );
}

export function actOnPublicMaintenanceRequest(
  payload:
    | { token: string; action: "cancel"; reason: string }
    | { token: string; action: "request_reschedule"; preferred_date: string; preferred_time?: string; note?: string },
) {
  return publicFetch<{ success: true; request: PublicMaintenanceRequest }>(
    "/public/maintenance-request/action",
    { method: "POST", body: JSON.stringify(payload) },
  );
}
