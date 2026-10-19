// Evaluation: how often does the AI's language label agree with yours?
// Used by the Evaluation panel in the browser and by test/eval.test.js.

export const LABELS = ["yes", "mixed", "no"]; // Language OK (English/French) · Local language a plus · Local language required

// The jobs you have labeled yourself, each paired with the AI's label.
export function labelPairs(jobs) {
  return jobs
    .filter((j) => j.myLabel && j.analysis?.english)
    .map((j) => ({ id: j.id, title: j.title || "", company: j.company || "", ai: j.analysis.english, mine: j.myLabel }));
}

/**
 * Score the AI against your labels.
 *
 * pairs: [{ id, title, company, ai, mine }], where ai and mine are "yes", "mixed" or "no".
 *
 * Return an object with:
 *   total          number of pairs
 *   agree          how many pairs have ai === mine
 *   accuracy       agree / total as a whole percentage (e.g. 87), or null when there are no pairs
 *   disagreements  the pairs where ai !== mine, in the same order as the input
 *
 * Check your work with:  npm test
 */
export function scoreLabels(pairs) {
  let res  = { total: pairs.length, agree: 0, accuracy: null, disagreements: [] };
  pairs.forEach((p) => {
    if (!LABELS.includes(p.ai)) throw new Error(`AI label ${p.ai} is not one of ${LABELS.join(", ")}`);
    if (!LABELS.includes(p.mine)) throw new Error(`Your label ${p.mine} is not one of ${LABELS.join(", ")}`);
    if (p.ai === p.mine) res.agree++;
    else res.disagreements.push(p);
  });
  res.accuracy = res.total ? Math.round((res.agree / res.total) * 100) : null;
  return res;
}
