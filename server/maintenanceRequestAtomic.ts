import { adminDb } from "./firebaseAdmin";

export type MaintenanceMutationResult =
  | "applied"
  | "request_not_found"
  | "request_conflict"
  | "booking_owner_conflict"
  | "booking_time_conflict"
  | "booking_capacity_exceeded";

export type MaintenanceAtomicMutation = {
  requestId: string;
  ownerUid: string;
  expectedStatus: string;
  requestPatch: Record<string, unknown>;
  eventId: string;
  event: Record<string, unknown>;
  booking?: {
    id: string;
    data: Record<string, unknown>;
  };
  capacity?: {
    technicianId: string;
    date: string;
    scheduledTime: string;
    maxDaily: number;
    excludeBookingId: string;
  };
};

type AtomicMaintenanceStore = {
  applyMaintenanceMutation?: (input: MaintenanceAtomicMutation) => Promise<MaintenanceMutationResult>;
  runTransaction?: <T>(callback: (transaction: {
    get: (ref: unknown) => Promise<any>;
    set: (ref: unknown, data: Record<string, unknown>, options?: { merge?: boolean }) => void;
    update: (ref: unknown, data: Record<string, unknown>) => void;
  }) => Promise<T>) => Promise<T>;
  collection: (name: string) => {
    doc: (id: string) => unknown;
    where: (field: string, operator: string, value: unknown) => any;
  };
};

function ownerOf(record: Record<string, any>) {
  return String(record.createdBy ?? record.owner_uid ?? "");
}

/**
 * Applies the maintenance request, linked booking, and append-only event as one
 * provider-native transaction. SQLite and Supabase expose the same primitive
 * through their adapters; native Firestore uses runTransaction directly.
 */
export async function applyMaintenanceMutation(input: MaintenanceAtomicMutation) {
  const store = adminDb as unknown as AtomicMaintenanceStore;
  if (typeof store.applyMaintenanceMutation === "function") {
    return store.applyMaintenanceMutation(input);
  }
  if (typeof store.runTransaction !== "function") {
    throw new Error("The configured database does not support atomic maintenance mutations.");
  }

  const requestRef = store.collection("maintenance_requests").doc(input.requestId);
  const eventRef = store.collection("maintenance_request_events").doc(input.eventId);
  const bookingRef = input.booking
    ? store.collection("bookings").doc(input.booking.id)
    : null;

  return store.runTransaction(async (transaction) => {
    const requestSnapshot = await transaction.get(requestRef);
    if (!requestSnapshot.exists || ownerOf(requestSnapshot.data() || {}) !== input.ownerUid) {
      return "request_not_found" as const;
    }
    if (String(requestSnapshot.data()?.status || "") !== input.expectedStatus) {
      return "request_conflict" as const;
    }

    if (bookingRef && input.booking) {
      const bookingSnapshot = await transaction.get(bookingRef);
      if (bookingSnapshot.exists && ownerOf(bookingSnapshot.data() || {}) !== input.ownerUid) {
        return "booking_owner_conflict" as const;
      }
      if (input.capacity) {
        const capacityQuery = store.collection("bookings")
          .where("createdBy", "==", input.ownerUid)
          .where("technician_id", "==", input.capacity.technicianId)
          .where("date", "==", input.capacity.date);
        const capacitySnapshot = await transaction.get(capacityQuery);
        const activeBookings = (capacitySnapshot.docs || [])
          .map((doc: { id: string; data: () => Record<string, any> }) => ({ id: doc.id, ...doc.data() }))
          .filter((booking: Record<string, any>) => (
            booking.id !== input.capacity!.excludeBookingId
            && String(booking.status || "confirmed") !== "cancelled"
          ));
        if (activeBookings.some((booking: Record<string, any>) => String(booking.scheduled_time || "") === input.capacity!.scheduledTime)) {
          return "booking_time_conflict" as const;
        }
        if (activeBookings.length >= input.capacity.maxDaily) {
          return "booking_capacity_exceeded" as const;
        }
      }
      transaction.set(bookingRef, input.booking.data, { merge: bookingSnapshot.exists });
    }

    transaction.update(requestRef, input.requestPatch);
    transaction.set(eventRef, input.event);
    return "applied" as const;
  });
}
