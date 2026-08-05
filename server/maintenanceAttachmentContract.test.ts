import assert from "node:assert/strict";
import test from "node:test";

process.env.NODE_ENV = "test";
process.env.DATA_PROVIDER = "sqlite";
process.env.DB_PROVIDER = "sqlite";
process.env.DB_PATH = ":memory:";

const { mediaContract } = await import("./maintenancePortalExperience");

test("invoice attachments require a real PDF signature and use the document contract", () => {
  assert.deepEqual(mediaContract("application/pdf", Buffer.from("%PDF-1.7\ninvoice")), {
    kind: "document",
    ext: "pdf",
    max: 10 * 1024 * 1024,
  });
  assert.throws(
    () => mediaContract("application/pdf", Buffer.from("not-a-pdf")),
    (error: any) => error?.status === 415,
  );
});

test("invoice attachments fail closed above 10MB while existing image and video contracts remain valid", () => {
  const oversized = Buffer.alloc(10 * 1024 * 1024 + 1);
  oversized.write("%PDF-");
  assert.throws(
    () => mediaContract("application/pdf", oversized),
    (error: any) => error?.status === 413,
  );
  assert.equal(mediaContract("image/jpeg", Buffer.from([0xff, 0xd8, 0xff])).kind, "image");
  assert.equal(mediaContract("video/mp4", Buffer.from("0000ftyp0000")).kind, "video");
});
