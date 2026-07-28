import assert from "node:assert/strict";
import test from "node:test";
import { parseCampaignAudience } from "./campaignAudienceImport";

test("campaign audience import accepts Arabic and English CSV headers", () => {
  assert.deepEqual(
    parseCampaignAudience("رقم الجوال,الاسم\n0501234567,يعقوب\n966501234568,أحمد").members,
    [
      { phone: "966501234567", name: "يعقوب" },
      { phone: "966501234568", name: "أحمد" },
    ],
  );
  assert.deepEqual(
    parseCampaignAudience("phone\tname\n501234569\tCustomer").members,
    [{ phone: "966501234569", name: "Customer" }],
  );
});

test("campaign audience import removes duplicates, rejects invalid rows, and enforces the cap", () => {
  const result = parseCampaignAudience(
    "0501234567\n0501234567\nnot-a-phone\n0501234568\n0501234569",
    2,
  );
  assert.deepEqual(result.members.map((item) => item.phone), [
    "966501234567",
    "966501234568",
  ]);
  assert.equal(result.duplicates, 1);
  assert.equal(result.invalid, 1);
  assert.equal(result.overflow, 1);
});
