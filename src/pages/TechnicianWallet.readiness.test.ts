import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const source = readFileSync(new URL("./TechnicianWallet.tsx", import.meta.url), "utf8");

test("technician wallet checks FieldTech readiness before requesting remote financials", () => {
  assert.match(source, /const fieldTechStatus = useData\(api\.getFieldTechStatus\)/);
  assert.match(source, /fieldTechStatus\.data\?\.configured === true/);
  assert.match(source, /!fieldTechStatus\.data\?\.configured/);
  assert.match(source, /FIELDTECH_SERVER_URL وFIELDTECH_INTEGRATION_SECRET/);
});
