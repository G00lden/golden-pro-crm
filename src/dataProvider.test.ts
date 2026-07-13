import assert from "node:assert/strict";
import test from "node:test";
import { usesBrowserLocalData, usesServerData } from "./dataProvider";

test("server data providers are selected from either supported environment key", () => {
  assert.equal(usesServerData("sqlite"), true);
  assert.equal(usesServerData(undefined, "supabase"), true);
  assert.equal(usesServerData("firebase"), false);
  assert.equal(usesServerData(), false);
});

test("local authentication still uses the server when a server data provider is selected", () => {
  assert.equal(usesBrowserLocalData(true, "sqlite"), false);
  assert.equal(usesBrowserLocalData(true, undefined, "supabase"), false);
  assert.equal(usesBrowserLocalData(true, "firebase"), true);
  assert.equal(usesBrowserLocalData(false, "firebase"), false);
});
