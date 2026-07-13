import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const serverSource = await readFile(new URL("../server.ts", import.meta.url), "utf8");
const clientSource = await readFile(new URL("../src/track.ts", import.meta.url), "utf8");

test("tracking intake is registered before the authenticated API boundary", () => {
  const routeRegistration = serverSource.indexOf("registerTrackingRoutes(app");
  const authBoundary = serverSource.indexOf('app.use("/api", apiRateLimit, requireFirebaseUser)');

  assert.ok(routeRegistration >= 0, "tracking route must be registered");
  assert.ok(authBoundary >= 0, "authenticated API boundary must exist");
  assert.ok(routeRegistration < authBoundary, "landing tracking must validate before Firebase auth");
});

test("browser tracking sends the minimised payload without cookies or referrer", () => {
  assert.match(clientSource, /body:\s*JSON\.stringify\(serverPayload\)/);
  assert.match(clientSource, /credentials:\s*"omit"/);
  assert.match(clientSource, /referrerPolicy:\s*"no-referrer"/);
  assert.doesNotMatch(clientSource, /body:\s*JSON\.stringify\(payload\)/);
  assert.doesNotMatch(clientSource, /console\.log\([^\n]*payload/);
  assert.doesNotMatch(clientSource, /console\.warn\([^\n]*error/);
});
