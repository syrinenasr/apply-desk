// Run with: npm test
import { test } from "node:test";
import assert from "node:assert/strict";
import { scoreLabels, labelPairs } from "../public/eval.js";

const p = (id, ai, mine) => ({ id, title: "", company: "", ai, mine });

test("counts agreements and rounds the accuracy", () => {
  const r = scoreLabels([
    p("a", "yes", "yes"),
    p("b", "no", "no"),
    p("c", "mixed", "no"),
  ]);
  assert.equal(r.total, 3);
  assert.equal(r.agree, 2);
  assert.equal(r.accuracy, 67);
});

test("lists the disagreements in input order", () => {
  const r = scoreLabels([
    p("a", "yes", "mixed"),
    p("b", "no", "no"),
    p("c", "mixed", "yes"),
  ]);
  assert.deepEqual(
    r.disagreements.map((d) => d.id),
    ["a", "c"],
  );
});

test("everything agrees", () => {
  const r = scoreLabels([p("a", "yes", "yes"), p("b", "mixed", "mixed")]);
  assert.equal(r.accuracy, 100);
  assert.deepEqual(r.disagreements, []);
});

test("no labels yet: accuracy is null, not NaN", () => {
  const r = scoreLabels([]);
  assert.equal(r.total, 0);
  assert.equal(r.agree, 0);
  assert.equal(r.accuracy, null);
  assert.deepEqual(r.disagreements, []);
});

test("labelPairs keeps only jobs you labeled that the AI also labeled", () => {
  const jobs = [
    { id: "a", myLabel: "yes", analysis: { english: "mixed" } },
    { id: "b", myLabel: null, analysis: { english: "yes" } },
    { id: "c", myLabel: "no", analysis: null },
  ];
  assert.deepEqual(
    labelPairs(jobs).map((x) => [x.id, x.ai, x.mine]),
    [["a", "mixed", "yes"]],
  );
});

test("rejects an unknown label", () => {
  assert.throws(() => scoreLabels([p("a", "maybe", "yes")]));
});
