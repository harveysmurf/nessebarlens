/**
 * photos --audit (#244): the read-only bucket-vs-catalog report. The bucket
 * listings are injected as fakes, so every category is detected without R2.
 */

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  MASTERS_BUCKET_NAME,
  STAGING_MASTERS_BUCKET_NAME,
  WEB_BUCKET_NAME,
  WEB_DERIVATIVE_FORMATS,
  WEB_DERIVATIVE_WIDTHS,
  webDerivativeKey,
} from "../src/domain/catalog/derivative-ladder.ts";
import {
  AUDIT_CATEGORIES,
  auditFindings,
  auditJson,
  createAuditS3,
  formatBytes,
  formatReport,
  parseWebKey,
  readCatalogEntries,
  runAudit,
} from "../scripts/audit-photos.mjs";

const NEW = "aaaaaaaa";
const OLD = "bbbbbbbb";
const SHA = "c".repeat(64);

/** The eight `{slug}/{hash}/…` objects one master publishes. */
function webObjects(slug, hash, size = 100) {
  const objects = [];
  for (const width of WEB_DERIVATIVE_WIDTHS) {
    for (const format of WEB_DERIVATIVE_FORMATS) {
      objects.push({ key: webDerivativeKey(slug, hash, width, format), size });
    }
  }
  return objects;
}

const DAWN = { slug: "dawn", published: true, imageHash: NEW, masterSha256: SHA };

test("parseWebKey reads a well-formed key and rejects everything else", () => {
  assert.deepEqual(parseWebKey("dawn/aaaaaaaa/1500.jpg"), {
    slug: "dawn",
    hash8: NEW,
    width: 1500,
    format: "jpg",
  });
  assert.deepEqual(parseWebKey("winter-pier/0123abcd/400.webp"), {
    slug: "winter-pier",
    hash8: "0123abcd",
    width: 400,
    format: "webp",
  });
  assert.equal(parseWebKey("dawn/aaaaaaaa/999.jpg"), null);
  assert.equal(parseWebKey("dawn/aaaaaaaa/400.gif"), null);
  assert.equal(parseWebKey("dawn/short/400.jpg"), null);
  assert.equal(parseWebKey("Dawn/aaaaaaaa/400.jpg"), null);
  assert.equal(parseWebKey("dawn/aaaaaaaa/400.jpg/extra"), null);
});

test("a replaced image's old hash is the only finding", () => {
  // The acceptance case: --replace-image leaves the previous hash's eight web
  // objects behind; everything current is quiet and nothing else is reported.
  const findings = auditFindings({
    catalog: [DAWN],
    webObjects: [...webObjects("dawn", NEW), ...webObjects("dawn", OLD)],
    stagingObjects: [{ key: "prints/dawn.jpg", size: 1 }],
    mastersObjects: [{ key: "prints/dawn.jpg", size: 1 }],
  });
  assert.equal(findings.orphanedWeb.length, 8);
  assert.ok(findings.orphanedWeb.every((item) => item.currentHash === NEW));
  assert.deepEqual(findings.orphanedWeb.map((item) => item.key.split("/")[1]), Array(8).fill(OLD));
  assert.deepEqual(findings.missing, []);
  assert.deepEqual(findings.unpublishedMasters, []);
  assert.deepEqual(findings.unknown, []);
});

test("a missing web rung, staging master and production master are each reported", () => {
  const web = webObjects("dawn", NEW);
  // Drop the 400.jpg rung and nothing else.
  const withoutOne = web.filter((object) => object.key !== webDerivativeKey("dawn", NEW, 400, "jpg"));
  const findings = auditFindings({
    catalog: [DAWN],
    webObjects: withoutOne,
    stagingObjects: [],
    mastersObjects: [{ key: "prints/dawn.jpg", size: 1 }],
  });
  assert.deepEqual(
    findings.missing.map((item) => `${item.bucket}/${item.key}`),
    [
      `${STAGING_MASTERS_BUCKET_NAME}/prints/dawn.jpg`,
      `${WEB_BUCKET_NAME}/dawn/${NEW}/400.jpg`,
    ],
  );
});

test("a photo published with no image_hash is not reported as missing", () => {
  // The placeholder phase: a published photo with no ladder must stay quiet.
  const findings = auditFindings({
    catalog: [{ slug: "dawn", published: true, imageHash: undefined }],
    webObjects: [],
    stagingObjects: [],
    mastersObjects: [],
  });
  assert.deepEqual(findings.missing, []);
});

test("an unpublished photo's masters are informational, not orphaned web", () => {
  const findings = auditFindings({
    catalog: [{ slug: "dawn", published: false, imageHash: OLD, masterSha256: SHA }],
    webObjects: webObjects("dawn", OLD),
    stagingObjects: [{ key: "prints/dawn.jpg", size: 10 }],
    mastersObjects: [{ key: "prints/dawn.jpg", size: 20 }],
  });
  assert.deepEqual(findings.orphanedWeb, []);
  assert.deepEqual(
    findings.unpublishedMasters.map((item) => item.bucket),
    [MASTERS_BUCKET_NAME, STAGING_MASTERS_BUCKET_NAME],
  );
});

test("keys matching no pattern are reported as unknown, per bucket", () => {
  const findings = auditFindings({
    catalog: [DAWN],
    webObjects: [{ key: "readme.txt", size: 3 }, ...webObjects("dawn", NEW)],
    stagingObjects: [{ key: "prints/dawn.jpg.orig", size: 4 }],
    mastersObjects: [{ key: "prints/dawn.jpg", size: 5 }],
  });
  assert.deepEqual(
    findings.unknown.map((item) => `${item.bucket}/${item.key}`),
    [`${STAGING_MASTERS_BUCKET_NAME}/prints/dawn.jpg.orig`, `${WEB_BUCKET_NAME}/readme.txt`],
  );
  assert.deepEqual(findings.orphanedWeb, []);
});

test("findings are sorted by bucket then key", () => {
  const findings = auditFindings({
    catalog: [DAWN],
    webObjects: [
      { key: webDerivativeKey("dawn", OLD, 2000, "webp"), size: 1 },
      { key: webDerivativeKey("dawn", OLD, 400, "jpg"), size: 1 },
    ],
    stagingObjects: [],
    mastersObjects: [],
  });
  assert.deepEqual(
    findings.orphanedWeb.map((item) => item.key),
    [webDerivativeKey("dawn", OLD, 400, "jpg"), webDerivativeKey("dawn", OLD, 2000, "webp")],
  );
});

test("formatBytes switches unit at 1024 and keeps one decimal", () => {
  assert.equal(formatBytes(0), "0 B");
  assert.equal(formatBytes(512), "512 B");
  assert.equal(formatBytes(1024), "1.0 KB");
  assert.equal(formatBytes(1536), "1.5 KB");
  assert.equal(formatBytes(1024 * 1024), "1.0 MB");
  assert.equal(formatBytes(1024 ** 4), "1.0 TB");
});

test("formatReport groups by category with a total size, and says so when clean", () => {
  const findings = auditFindings({
    catalog: [DAWN],
    webObjects: webObjects("dawn", OLD, 100),
    stagingObjects: [],
    mastersObjects: [],
  });
  const report = formatReport(findings);
  assert.match(report, /Orphaned web images: 8, 800 B/);
  assert.match(report, new RegExp(`${WEB_BUCKET_NAME}/dawn/${OLD}/400.jpg  100 B`));
  assert.match(report, /Missing objects: 10/);

  const clean = formatReport(
    auditFindings({ catalog: [DAWN], webObjects: webObjects("dawn", NEW), stagingObjects: [{ key: "prints/dawn.jpg" }], mastersObjects: [{ key: "prints/dawn.jpg" }] }),
  );
  assert.match(clean, /No findings/);
});

test("auditJson carries count, totalBytes and items for every category", () => {
  const findings = auditFindings({
    catalog: [DAWN],
    webObjects: webObjects("dawn", OLD, 100),
    stagingObjects: [],
    mastersObjects: [],
  });
  const json = auditJson(findings);
  assert.deepEqual(
    json.categories.map((category) => category.key),
    AUDIT_CATEGORIES.map((category) => category.key),
  );
  const orphaned = json.categories.find((category) => category.key === "orphanedWeb");
  assert.equal(orphaned.count, 8);
  assert.equal(orphaned.totalBytes, 800);
  assert.equal(orphaned.items.length, 8);
});

test("readCatalogEntries reads published and unpublished files and rejects a bad one", () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "audit-catalog-"));
  mkdirSync(dir, { recursive: true });
  const body = (extra) =>
    ["title: Dawn", "caption: c", "description: d", "alt: a", "category: fine-art", extra].join(
      "\n",
    );
  writeFileSync(path.join(dir, "dawn.yaml"), body(`image_hash: ${NEW}\nmaster_sha256: ${SHA}`));
  writeFileSync(path.join(dir, "draft.yaml"), body("published: false"));
  const entries = readCatalogEntries(dir);
  assert.deepEqual(
    entries.map((entry) => [entry.slug, entry.published, entry.imageHash]),
    [
      ["dawn", true, NEW],
      ["draft", false, undefined],
    ],
  );

  writeFileSync(path.join(dir, "broken.yaml"), "title: no\n");
  assert.throws(() => readCatalogEntries(dir), /the catalog is invalid/);
  assert.throws(() => readCatalogEntries(path.join(dir, "missing")), /no content\/photos\//);
});

test("the audit client has only list and head, and refuses any other bucket", async () => {
  const s3 = createAuditS3({
    R2_S3_ENDPOINT: "https://r2.example.com",
    R2_ACCESS_KEY_ID: "key",
    R2_SECRET_ACCESS_KEY: "secret",
  });
  assert.deepEqual(Object.keys(s3).sort(), ["head", "list"]);
  assert.equal("put" in s3, false);
  assert.equal("delete" in s3, false);
  await assert.rejects(() => s3.list("someone-elses-bucket"), /refusing to read/);
  await assert.rejects(() => s3.head("someone-elses-bucket", "k"), /refusing to read/);
});

test("runAudit lists all three buckets and prints the chosen format", async () => {
  const lists = [];
  const s3 = {
    async list(bucket) {
      lists.push(bucket);
      if (bucket === WEB_BUCKET_NAME) return webObjects("dawn", OLD, 10);
      if (bucket === MASTERS_BUCKET_NAME) return [{ key: "prints/dawn.jpg", size: 5 }];
      return [];
    },
  };
  const catalog = [DAWN];

  const textLogs = [];
  const text = await runAudit(
    {},
    { s3, catalog, log: (line) => textLogs.push(line) },
  );
  assert.equal(text.status, 0);
  assert.deepEqual(lists, [WEB_BUCKET_NAME, STAGING_MASTERS_BUCKET_NAME, MASTERS_BUCKET_NAME]);
  assert.match(textLogs.join("\n"), /Orphaned web images: 8/);

  const jsonLogs = [];
  const json = await runAudit(
    { json: true },
    { s3, catalog, log: (line) => jsonLogs.push(line) },
  );
  assert.equal(json.status, 0);
  assert.equal(JSON.parse(jsonLogs.join("\n")).categories[0].count, 8);
});
