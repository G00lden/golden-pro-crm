import assert from "node:assert/strict";
import test from "node:test";
import { usesServerData } from "./dataProvider";

test("server data providers are selected from either supported environment key", () => {
  assert.equal(usesServerData("sqlite"), true);
  assert.equal(usesServerData(undefined, "supabase"), true);
  assert.equal(usesServerData("firebase"), false);
  assert.equal(usesServerData(), false);
});
