/**
 * The path grammar, and the one place it is written down.
 *
 * Two callers need to know where a path's tail begins: the locale path helper
 * keeps it, because a print's selection lives in the query string, and the
 * analytics route drops it, because a path with a query string in it is not a
 * path. They must not each hold their own copy of the rule, so the rule lives
 * here and both ask.
 */

import assert from "node:assert/strict";
import test from "node:test";

import { splitPathParts } from "../src/domain/paths/path-parts.ts";

test("a path with no tail is all route", () => {
  assert.deepEqual(splitPathParts("/en/fine-art"), {
    route: "/en/fine-art",
    tail: "",
  });
  assert.deepEqual(splitPathParts(""), { route: "", tail: "" });
});

test("a query string is the tail, and it keeps its marker", () => {
  assert.deepEqual(splitPathParts("/en/prints/a-photo?format=framed"), {
    route: "/en/prints/a-photo",
    tail: "?format=framed",
  });
});

test("a fragment is the tail too", () => {
  assert.deepEqual(splitPathParts("/en/story#contact"), {
    route: "/en/story",
    tail: "#contact",
  });
});

test("whichever comes first ends the route", () => {
  // A fragment after a query string is part of the query string as far as the
  // route is concerned: the route ended at the "?".
  assert.deepEqual(splitPathParts("/en/story?a=1#contact"), {
    route: "/en/story",
    tail: "?a=1#contact",
  });
  assert.deepEqual(splitPathParts("/en/story#contact?a=1"), {
    route: "/en/story",
    tail: "#contact?a=1",
  });
});

test("the two halves re-join into the path they came from", () => {
  for (const path of [
    "/",
    "/en",
    "/en/fine-art",
    "/en/prints/a-photo?format=framed&size=a4",
    "/en/story#contact",
    "/en/story?a=1#b",
  ]) {
    const { route, tail } = splitPathParts(path);
    assert.equal(`${route}${tail}`, path, `${path} did not survive the split`);
  }
});

test("an empty route is impossible for a path that starts with a slash", () => {
  // The analytics route relies on this: it accepts a path only when it starts
  // with "/", and a "?" or "#" can never be that first character, so the route
  // it keeps is never empty.
  for (const path of ["/?a=1", "/#b"]) {
    assert.notEqual(splitPathParts(path).route, "", `${path} kept no route`);
  }
});
