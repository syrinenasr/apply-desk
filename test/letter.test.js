// Run with: npm test
import { test } from "node:test";
import assert from "node:assert/strict";
import { companyFolder, pickFolder, letterHead, letterFiles, letterHtml } from "../letter.js";

test("drops legal forms and unsafe characters from the folder name", () => {
  assert.equal(companyFolder("REPA Deutschland GmbH"), "REPA Deutschland");
  assert.equal(companyFolder("HSE - Home Shopping Europe GmbH"), "HSE - Home Shopping Europe");
  assert.equal(companyFolder("Giesecke+Devrient"), "Giesecke+Devrient");
  assert.equal(companyFolder("Foo/Bar AG"), "Foo Bar");
  assert.equal(companyFolder(""), "Company");
});

test("reuses a folder made by hand for the same company", () => {
  const existing = ["Avelios", "NavVis", "REPA", "zooplus", "Panasonic"];
  assert.equal(pickFolder("Panasonic Europe", existing), "Panasonic");
  assert.equal(pickFolder("REPA Deutschland GmbH", existing), "REPA");
  assert.equal(pickFolder("navvis", existing), "NavVis");
  assert.equal(pickFolder("Amazon", existing), "Amazon");
  assert.equal(pickFolder("NavVisionary GmbH", existing), "NavVisionary");
});

test("reads name, contact line and city from the resume", () => {
  const h = letterHead("# Jane Doe\nMunich, Germany | +49 151 | a@b.com | linkedin.com/in/x\n\n## Summary");
  assert.deepEqual(h, { name: "Jane Doe", contact: "Munich, Germany | +49 151 | a@b.com | linkedin.com/in/x", city: "Munich" });
  assert.equal(letterHead("# A B\na@b.com | +49 1 | Paris, France").city, "Paris");
});

test("names the files like the earlier applications", () => {
  assert.deepEqual(letterFiles("Jane Doe", "Panasonic Europe"), {
    resume: "Jane-Doe_Resume.pdf",
    html: "cover-letter.html",
    pdf: "Jane_Doe_Cover_Letter_Panasonic-Europe.pdf",
  });
});

test("escapes the letter text", () => {
  const html = letterHtml({
    head: { name: "A B", contact: "x", city: "Munich" }, company: "R&D Co", city: "Berlin", date: "1 May 2026",
    letter: { subject: "Application: Dev", greeting: "Hello R&D team,", paragraphs: ["<b>hi</b>"] },
  });
  assert.match(html, /R&amp;D Co, Berlin<br>Munich, 1 May 2026/);
  assert.match(html, /&lt;b&gt;hi&lt;\/b&gt;/);
});
