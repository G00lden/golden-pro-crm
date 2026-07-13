import test from "node:test";
import assert from "node:assert/strict";
import { renderToStaticMarkup } from "react-dom/server";
import { PublicContactLink } from "./PublicContactLink";

test("an unconfigured public contact renders disabled without a fake href", () => {
  const html = renderToStaticMarkup(
    <PublicContactLink channel="call" ariaLabel="اتصال">اتصال</PublicContactLink>,
  );

  assert.match(html, /aria-disabled="true"/);
  assert.match(html, /role="link"/);
  assert.doesNotMatch(html, /href=/);
  assert.doesNotMatch(html, /966500000000/);
});
