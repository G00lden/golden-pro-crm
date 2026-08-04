import { adminDb } from "./firebaseAdmin";

type UnknownRecord = Record<string, any>;

export type FieldTechEvidenceArtifact = {
  ref: string;
  sha256: string;
  capturedAt: string;
};

export type FieldTechCompletionEvidence = {
  beforePhoto?: FieldTechEvidenceArtifact;
  afterPhoto?: FieldTechEvidenceArtifact;
  customerSignature?: FieldTechEvidenceArtifact;
};

function required(value: unknown) {
  if (value === undefined || value === null || value === "") return true;
  return ![false, 0, "0", "false"].includes(value as never);
}

function artifact(value: unknown, label: string, nowMs: number): FieldTechEvidenceArtifact {
  const input = value && typeof value === "object" && !Array.isArray(value)
    ? value as UnknownRecord
    : {};
  const ref = String(input.ref || "").trim();
  const sha256 = String(input.sha256 || "").trim().toLowerCase();
  const capturedAt = String(input.capturedAt || "").trim();
  const capturedAtMs = Date.parse(capturedAt);
  if (
    !/^[A-Za-z0-9][A-Za-z0-9._/-]{7,239}$/.test(ref)
    || ref.includes("..")
    || !/^[a-f0-9]{64}$/.test(sha256)
    || !Number.isFinite(capturedAtMs)
    || capturedAtMs > nowMs + 5 * 60_000
    || capturedAtMs < nowMs - 30 * 24 * 60 * 60_000
  ) {
    throw Object.assign(new Error(`${label} must include a safe reference, SHA-256 hash, and valid capture time.`), {
      status: 409,
      code: "FIELDTECH_EVIDENCE_INVALID",
    });
  }
  return { ref, sha256, capturedAt: new Date(capturedAtMs).toISOString() };
}

export function validateFieldTechCompletionEvidence(
  booking: UnknownRecord,
  rawEvidence: unknown,
  nowMs = Date.now(),
) {
  const evidence = rawEvidence && typeof rawEvidence === "object" && !Array.isArray(rawEvidence)
    ? rawEvidence as UnknownRecord
    : {};
  const normalized: FieldTechCompletionEvidence = {};
  if (required(booking.fieldtech_require_before_photo)) {
    normalized.beforePhoto = artifact(evidence.beforePhoto, "Before photo", nowMs);
  }
  if (required(booking.fieldtech_require_after_photo)) {
    normalized.afterPhoto = artifact(evidence.afterPhoto, "After photo", nowMs);
  }
  if (required(booking.fieldtech_require_signature)) {
    normalized.customerSignature = artifact(evidence.customerSignature, "Customer signature", nowMs);
  }
  return normalized;
}

export function completionEvidencePatch(evidence: FieldTechCompletionEvidence) {
  return {
    before_photo_ref: evidence.beforePhoto?.ref || null,
    before_photo_sha256: evidence.beforePhoto?.sha256 || null,
    before_photo_captured_at: evidence.beforePhoto?.capturedAt || null,
    after_photo_ref: evidence.afterPhoto?.ref || null,
    after_photo_sha256: evidence.afterPhoto?.sha256 || null,
    after_photo_captured_at: evidence.afterPhoto?.capturedAt || null,
    signature_ref: evidence.customerSignature?.ref || null,
    signature_sha256: evidence.customerSignature?.sha256 || null,
    signature_captured_at: evidence.customerSignature?.capturedAt || null,
    evidence_complete: true,
  };
}

export async function assertStoredBookingCompletionEvidence(
  bookingId: string,
  ownerUid: string,
) {
  const [snapshot, bookingSnapshot] = await Promise.all([
    adminDb.collection("fieldtech_job_states").doc(bookingId).get(),
    adminDb.collection("bookings").doc(bookingId).get(),
  ]);
  const state = snapshot.exists ? snapshot.data() || {} : {};
  const booking = bookingSnapshot.exists ? bookingSnapshot.data() || {} : {};
  const stateOwner = String(state.createdBy || state.owner_uid || "");
  const bookingOwner = String(booking.createdBy || booking.owner_uid || "");
  if (
    !snapshot.exists
    || !bookingSnapshot.exists
    || stateOwner !== ownerUid
    || bookingOwner !== ownerUid
    || ![true, 1, "1", "true"].includes(state.evidence_complete)
  ) {
    throw Object.assign(new Error("لا يمكن إغلاق الحجز قبل اكتمال صور ما قبل/بعد الصيانة وتوقيع العميل في FieldTech."), {
      status: 409,
      code: "FIELDTECH_EVIDENCE_REQUIRED",
    });
  }
  validateFieldTechCompletionEvidence(booking, {
    beforePhoto: {
      ref: state.before_photo_ref,
      sha256: state.before_photo_sha256,
      capturedAt: state.before_photo_captured_at,
    },
    afterPhoto: {
      ref: state.after_photo_ref,
      sha256: state.after_photo_sha256,
      capturedAt: state.after_photo_captured_at,
    },
    customerSignature: {
      ref: state.signature_ref,
      sha256: state.signature_sha256,
      capturedAt: state.signature_captured_at,
    },
  });
  return state;
}
