import { esc, md, cvName } from "./cv.js";
import { LABELS, labelPairs, scoreLabels } from "./eval.js";

const STATUS = { new: "To apply", applied: "Applied", interview: "Interviewing", offer: "Offer", rejected: "Rejected", skipped: "Skipped", closed: "Posting closed" };
const ENGLISH = { yes: "English friendly", mixed: "English OK, German a plus", no: "German required" };
const RESP = { interview: "Interview invite", rejection: "Rejection", offer: "Offer", other: "Recruiter reply / other" };
const CEFR = ["A1", "A2", "B1", "B2", "C1", "C2"];
const STAGES = [
  ["all", "All jobs"], ["todo", "To apply"], ["waiting", "Waiting"], ["interview", "Interviewing"], ["offer", "Offers"], ["closed", "Closed"]
];

const S = {
  loaded: false, offline: false, profile: {}, jobs: [],
  sel: null, filter: "all", busy: {}, err: {}, editing: null, armed: null
};

const $ = (s) => document.querySelector(s);
const today = () => new Date().toISOString().slice(0, 10);
const fmtDate = (t) => t ? new Date(t).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" }) : "";
const daysSince = (t) => t ? Math.floor((Date.now() - t) / 86400000) : null;
const job = (id) => S.jobs.find((j) => j.id === id);
const store = { get(k) { try { return localStorage.getItem(k); } catch { return null; } }, set(k, v) { try { localStorage.setItem(k, v); } catch {} } };
S.blind = store.get("mad-blind") === "1";
// Blind labeling: hide the AI's label on jobs you haven't labeled yet, so it can't sway your judgment.
const hideAi = (j) => S.blind && !j.myLabel && !!j.analysis;

function toast(msg) {
  const t = $("#toast"); t.textContent = msg; t.hidden = false;
  clearTimeout(toast.h); toast.h = setTimeout(() => (t.hidden = true), Math.max(2400, msg.length * 60));
}

/* ---------- API ---------- */
async function api(method, url, data) {
  let res;
  try {
    res = await fetch(url, { method, headers: data ? { "Content-Type": "application/json" } : {}, body: data ? JSON.stringify(data) : undefined });
  } catch {
    throw new Error("Can't reach the local server. Is `npm start` still running?");
  }
  const out = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(out.error || `Request failed (${res.status}).`);
  return out;
}
function upsert(j) {
  const i = S.jobs.findIndex((x) => x.id === j.id);
  if (i >= 0) S.jobs[i] = j; else S.jobs.unshift(j);
}
async function patch(id, data) {
  try { upsert(await api("PATCH", `/api/jobs/${id}`, data)); delete S.err[id]; }
  catch (e) { S.err[id] = e.message; }
  render();
}

/* ---------- derived ---------- */
const isClosed = (j) => j.status === "rejected" || j.status === "skipped" || j.status === "closed";
function inStage(j, f) {
  switch (f) {
    case "todo": return j.status === "new" && j.english !== "no";
    case "waiting": return j.status === "applied" && !(j.responses || []).length;
    case "interview": return j.status === "interview";
    case "offer": return j.status === "offer";
    case "closed": return isClosed(j) || (j.status === "new" && j.english === "no");
    default: return true;
  }
}
function stripe(j) {
  if (j.status === "offer") return "var(--ok)";
  if (j.status === "interview") return "var(--signal)";
  if (j.status === "applied") return "var(--accent)";
  if (isClosed(j)) return "var(--line)";
  if (hideAi(j)) return "transparent";
  return j.english === "yes" ? "var(--ok)" : j.english === "mixed" ? "var(--warn)" : j.english === "no" ? "var(--bad)" : "transparent";
}
function ago(t) {
  if (!t) return "";
  const m = Math.round((Date.now() - t) / 60000);
  if (m < 1) return "just now";
  if (m < 60) return `${m} min ago`;
  const h = Math.round(m / 60);
  return h < 24 ? `${h} h ago` : `${Math.round(h / 24)} d ago`;
}
function postingLine(j) {
  const p = j.posting || {};
  let text, color = "";
  if (p.state === "open") text = `Posting still open · checked ${ago(p.checkedAt)}`;
  else if (p.state === "closed") { text = `Posting closed · ${p.note || "no longer accepting applications"}`; color = "var(--bad)"; }
  else text = j.url ? "Posting not checked yet" : "No link saved, so the posting can't be checked";
  const failed = p.attemptedAt && p.attemptedAt !== p.checkedAt && p.note && p.state !== "closed" ? ` · last check failed: ${p.note}` : "";
  return `<div class="row" style="gap:8px"><span class="hint"${color ? ` style="color:${color}"` : ""}>${esc(text + failed)}</span>
    ${j.url && !S.checking ? `<button class="btn ghost small" data-act="checkposting">${S.checkingOne === j.id ? "Checking…" : "Check now"}</button>` : ""}</div>`;
}
// The match that matters: the tailored resume's score if there is one, else the base resume's.
const matchOf = (j) => j.resumeFit?.fit ?? j.analysis?.fit ?? null;
const langRank = (j) => (j.english === "yes" || j.english === "mixed" ? 0 : j.english === "no" ? 2 : 1);
function sortJobs(list) {
  if (S.sort === "newest") return list;  // the server keeps jobs newest first
  // Open jobs first, then English-friendly before German-required, then best match.
  return [...list].sort((a, b) => isClosed(a) - isClosed(b) || langRank(a) - langRank(b) || (matchOf(b) ?? -1) - (matchOf(a) ?? -1) || (b.createdAt || 0) - (a.createdAt || 0));
}
const resumeScoreStale = (j) => j.resumeFit && (j.resumeChangedAt || 0) > j.resumeFit.at;
// Experience check: what the posting asks for vs. the years saved with the base resume.
function yearsInfo(j) {
  const a = j.analysis || {}, min = a.requiredYearsMin, max = a.requiredYearsMax, mine = S.profile.experienceYears;
  if (!("requiredYearsMin" in a)) return null;                       // not checked yet
  if (min == null) return { cls: "", short: "Years not stated", text: "The posting doesn't state a number of years." };
  const need = max != null ? `${min}–${max} years` : `${min}+ years`;
  if (mine == null) return { cls: "", short: need, text: `Asks for ${need}. Add your years of experience in Base resume to compare.` };
  const you = `you have about ${mine}`;
  if (mine >= min && (max == null || mine <= max + 2)) return { cls: "yes", short: `${need} ✓`, text: `Asks for ${need}; ${you}. Your experience fits.` };
  if (max != null && mine > max + 2) return { cls: "mixed", short: `${need} ↑`, text: `Asks for ${need}; ${you}. You may be more experienced than they're looking for.` };
  const gap = Math.round((min - mine) * 10) / 10;
  if (gap <= 1) return { cls: "mixed", short: `${need} ~`, text: `Asks for ${need}; ${you}, ${gap} short. Close: worth applying, and show the depth of your work.` };
  return { cls: "no", short: `${need} ✗`, text: `Asks for ${need}; ${you}, ${gap} short. A stretch: expect this to come up.` };
}
const hostOf = (u) => { try { return new URL(u).hostname.replace(/^www\./, ""); } catch { return ""; } };

/* ---------- render ---------- */
function render() { renderBanner(); renderBase(); renderEval(); renderPipeline(); renderList(); renderDetail(); }

function renderBanner() {
  $("#banner").innerHTML = S.offline ? `<div class="banner">Can't reach the local server. Start it with <code>npm start</code> in the munich-job-desk folder, then reload.</div>` : "";
}

function renderBase() {
  const p = $("#base-panel");
  const has = !!(S.profile.resume || "").trim();
  $("#toggle-base").innerHTML = has ? "Base resume" : `Add base resume <span class="chip no">missing</span>`;
  if (p.hidden) return;
  const keep = document.getElementById("base-text")?.value;
  const words = has ? S.profile.resume.trim().split(/\s+/).length : 0;
  p.innerHTML = `
    <div class="row" style="justify-content:space-between">
      <h2>Your base resume</h2>
      <span class="hint">${has ? `${words} words · saved ${esc(fmtDate(S.profile.updatedAt))}` : "Not saved yet"}</span>
    </div>
    <p class="hint">Your full resume as plain text. Every tailored version is written from this, and nothing is added that isn't in it.</p>
    <textarea id="base-text" rows="16"></textarea>
    <div class="row">
      <label class="label" for="base-years">Years of professional experience</label>
      <input type="number" id="base-years" min="0" max="50" step="0.1" style="width:110px">
      <span class="hint">Used to compare with what each job asks for.</span>
    </div>
    <div class="row">
      <button class="btn primary" type="button" id="base-save">Save base resume</button>
      <button class="btn ghost" type="button" id="base-close">Close</button>
    </div>`;
  $("#base-text").value = keep ?? S.profile.resume ?? "";
  $("#base-years").value = S.profile.experienceYears ?? "";
}

function renderEval() {
  const p = $("#eval-panel");
  if (p.hidden) return;
  const analyzed = S.jobs.filter((j) => j.analysis?.english).length;
  const pairs = labelPairs(S.jobs);
  let result;
  try {
    const r = scoreLabels(pairs);
    const dis = (r.disagreements || []).map((d) => `<button type="button" data-sel="${esc(d.id)}">
        <strong>${esc(d.company || "Unknown company")}</strong> · ${esc(d.title || "Untitled")}<br>
        <span class="hint">You: ${esc(ENGLISH[d.mine])} · AI: ${esc(ENGLISH[d.ai])}</span></button>`).join("");
    result = r.total ? `
      <div class="eval-score"><span class="big">${r.accuracy}%</span><span>agreement · the AI matched you on <b>${r.agree}</b> of <b>${r.total}</b> jobs</span></div>
      ${dis ? `<h3 style="margin:4px 0 0;font-size:15px">Where you disagree</h3><div class="eval-list">${dis}</div>` : `<p class="hint">No disagreements.</p>`}`
      : `<p class="hint">No labels yet. Open a job, read the posting and choose <b>My label</b>.</p>`;
  } catch (e) {
    result = `<div class="verdict mixed"><p><b>The scoring isn't working yet:</b> ${esc(e.message)}</p>
      <p class="hint">Write <code>scoreLabels()</code> in <code>public/eval.js</code>, check it with <code>npm test</code>, then reload this page.</p></div>`;
  }
  p.innerHTML = `
    <div class="row" style="justify-content:space-between">
      <h2>Evaluation: AI label vs. yours</h2>
      <span class="hint">${pairs.length} of ${analyzed} analyzed jobs labeled by you${pairs.length < 30 ? ` · aim for 30` : ""}</span>
    </div>
    <p class="hint">For each job you label yourself, the desk compares your judgment with the AI's original label. Label a mix of English, German and unclear postings for a fair score.</p>
    <label class="row" style="gap:8px;cursor:pointer"><input type="checkbox" id="blind-mode"${S.blind ? " checked" : ""}>
      <span><b>Blind labeling:</b> hide the AI's label on jobs I haven't labeled yet</span></label>
    ${result}
    <div class="row"><button class="btn ghost" type="button" id="eval-close">Close</button></div>`;
}

function stats() {
  const applied = S.jobs.filter((j) => j.appliedAt).length;
  const replied = S.jobs.filter((j) => j.appliedAt && (j.responses || []).length).length;
  return { applied, replied, rate: applied ? Math.round((replied / applied) * 100) : 0 };
}

function renderPipeline() {
  const counts = Object.fromEntries(STAGES.map(([k]) => [k, S.jobs.filter((j) => inStage(j, k)).length]));
  $("#pipeline").innerHTML = STAGES.map(([k, l]) => `
    <button type="button" class="stage" data-filter="${k}" aria-pressed="${S.filter === k}">
      <span class="n">${counts[k]}</span><span class="l">${l}</span>
    </button>`).join("");
}

function renderList() {
  const el = $("#list");
  if (!S.loaded) { el.innerHTML = `<div class="empty">${S.offline ? "No connection to the local server." : '<span class="thinking">Loading your applications</span>'}</div>`; return; }
  if (!S.jobs.length) {
    el.innerHTML = `<div class="empty">
      <strong>No jobs yet.</strong>
      <ol>
        <li>Check your <strong>base resume</strong> is saved.</li>
        <li>Paste a job link above and click <strong>Analyze job</strong>.</li>
        <li>English-friendly jobs get a tailored resume. Click <strong>Mark as applied</strong> when you send it, and log replies as they come in.</li>
      </ol></div>`;
    return;
  }
  const { applied, replied, rate } = stats();
  const rateRow = applied ? `<div class="item" style="cursor:default"><span class="rate"><b>${applied}</b> applied · <b>${replied}</b> replied · <b>${rate}%</b> response rate</span></div>` : "";
  const items = sortJobs(S.jobs.filter((j) => inStage(j, S.filter)));
  const sortBar = `<div class="listbar"><label class="label" for="sort-by">Sort</label>
    <select id="sort-by"><option value="match"${S.sort !== "newest" ? " selected" : ""}>Best match (English-friendly first)</option><option value="newest"${S.sort === "newest" ? " selected" : ""}>Newest first</option></select></div>`;
  if (!items.length) { el.innerHTML = sortBar + rateRow + `<div class="empty">Nothing in “${esc(STAGES.find((s) => s[0] === S.filter)[1])}”.</div>`; return; }
  el.innerHTML = sortBar + rateRow + items.map((j) => {
    const a = j.analysis || {};
    const age = j.status === "applied" ? daysSince(j.appliedAt) : null;
    const late = age !== null && age >= 14 && !(j.responses || []).length;
    return `<button type="button" class="item" data-sel="${j.id}" aria-current="${S.sel === j.id}" style="--stripe:${stripe(j)}">
      <span class="t">${esc(j.title || a.title || "Untitled posting")}</span>
      <span class="c">${esc([j.company || a.company, a.location].filter(Boolean).join(" · ") || hostOf(j.url) || "Company unknown")}</span>
      <span class="meta">
        ${S.busy[j.id] ? `<span class="thinking" style="font-size:12px">${S.busy[j.id] === "analyzing" ? "Analyzing" : S.busy[j.id] === "scoring" ? "Scoring" : "Writing resume"}</span>`
          : hideAi(j) ? `<span class="chip">Label it yourself</span>`
          : j.english ? `<span class="chip dot ${j.english}">${ENGLISH[j.english]}</span>${j.myLabel ? `<span class="chip" title="Labeled by you">✓ you</span>` : ""}` : `<span class="chip">Not labeled</span>`}
        <span class="chip st-${j.status}">${STATUS[j.status] || j.status}</span>
        ${yearsInfo(j) && yearsInfo(j).cls ? `<span class="chip ${yearsInfo(j).cls}" title="${esc(yearsInfo(j).text)}">${esc(yearsInfo(j).short)}</span>` : ""}
        ${matchOf(j) !== null ? `<span class="match" title="${j.resumeFit ? "Match of your tailored resume" : "Match of your base resume (no tailored resume yet)"}">${matchOf(j)}${j.resumeFit ? "" : "*"}</span>` : ""}
        ${j.posting?.state === "closed" && j.status !== "closed" ? `<span class="chip no">Posting closed</span>` : ""}
        ${age !== null ? `<span class="age ${late ? "late" : ""}" title="Days since applied">${age}d</span>` : ""}
      </span>
    </button>`;
  }).join("");
}

function snapshotInputs(root) {
  const vals = {}; root.querySelectorAll("input[id],textarea[id],select[id]:not([data-status])").forEach((e) => (vals[e.id] = e.value));
  return { vals, focus: document.activeElement?.id };
}
function restoreInputs(root, s) {
  for (const [id, v] of Object.entries(s.vals)) { const e = root.querySelector("#" + CSS.escape(id)); if (e) e.value = v; }
  if (s.focus) document.getElementById(s.focus)?.focus();
}

function renderDetail() {
  const root = $("#detail");
  const j = job(S.sel);
  if (!j) {
    root.innerHTML = S.jobs.length ? `<div class="panel"><p class="hint">Pick a job from the list.</p></div>` : `<div class="panel">
      <h2>How a job moves through the desk</h2>
      <p class="hint">Each posting is labeled <span class="chip dot yes">English friendly</span>, <span class="chip dot mixed">English OK, German a plus</span> or <span class="chip dot no">German required</span>, with the CEFR level the posting asks for. English-friendly jobs get a resume rewritten from yours to match the requirements.</p>
    </div>`;
    return;
  }
  const keep = snapshotInputs(root);
  const a = j.analysis || {};
  const busy = S.busy[j.id];
  const lvl = a.germanLevel;
  const showLvl = lvl && lvl !== "unspecified" && lvl !== "none";
  const cefr = `<span class="cefr" title="German level the posting asks for">${CEFR.map((c) => `<span class="${lvl === c || (lvl === "native" && c === "C2") ? "on" : ""}">${c}</span>`).join("")}</span>`;
  const resps = (j.responses || []).map((r, i) => ({ ...r, i })).sort((x, y) => (x.date < y.date ? -1 : 1));

  let verdict;
  if (busy === "analyzing") verdict = `<div class="verdict"><span class="thinking">Reading the posting and checking the language requirement… this takes about 20–60 seconds.</span></div>`;
  else if (hideAi(j)) verdict = `<div class="verdict"><p><b>AI label hidden</b> (blind labeling is on). Read the job description below, then choose <b>My label</b>; the AI's answer appears once you have.</p></div>`;
  else if (j.english) verdict = `<div class="verdict ${a.english || j.english}">
      <div class="row" style="justify-content:space-between"><span class="v">${ENGLISH[a.english || j.english]}</span>${showLvl ? cefr : ""}</div>
      ${j.myLabel && a.english && j.myLabel !== a.english ? `<p class="hint">This is the AI's label. You labeled it <b>${ENGLISH[j.myLabel]}</b>, and the desk uses your label.</p>` : ""}
      ${a.reason ? `<p>${esc(a.reason)}</p>` : ""}
      ${a.germanRequirement ? `<p class="hint">German: ${esc(a.germanRequirement)}${showLvl ? ` (${esc(lvl)})` : ""} · Posting written in ${a.postingLanguage === "de" ? "German" : a.postingLanguage === "en" ? "English" : "another language"}</p>` : ""}
    </div>`;
  else verdict = `<div class="verdict"><p>Not analyzed yet.</p><div class="row"><button class="btn primary small" data-act="analyze">Analyze job</button></div></div>`;

  const analysisBlock = a.requirements ? `
    <div class="grid2">
      <div class="field"><span class="label">Key requirements</span><ul class="reqs">${(a.requirements || []).map((r) => `<li>${esc(r)}</li>`).join("")}</ul></div>
      <div class="col" style="gap:12px">
        ${j.resumeFit ? `<div class="fit"><span class="label">Match with your tailored resume</span>
          <div class="row"><span class="num">${j.resumeFit.fit}</span><span class="hint">/ 100</span>
            ${resumeScoreStale(j) ? `<span class="hint" style="color:var(--warn)">Resume edited since this score</span>` : ""}
            <button class="btn ghost small" data-act="score">${S.busy[j.id] === "scoring" ? "Scoring…" : "Re-score"}</button></div>
          <div class="bar"><i style="width:${j.resumeFit.fit}%"></i></div>
          ${j.resumeFit.notes ? `<p class="hint">${esc(j.resumeFit.notes)}</p>` : ""}</div>`
        : typeof a.fit === "number" ? `<div class="fit"><span class="label">Match with your base resume</span>
          <div class="row"><span class="num">${Math.round(a.fit)}</span><span class="hint">/ 100</span>
            ${j.resume ? `<button class="btn ghost small" data-act="score">${S.busy[j.id] === "scoring" ? "Scoring…" : "Score tailored resume"}</button>` : ""}</div>
          <div class="bar"><i style="width:${Math.max(0, Math.min(100, a.fit))}%"></i></div>
          ${a.fitNotes ? `<p class="hint">${esc(a.fitNotes)}</p>` : ""}</div>` : ""}
        ${(a.keywords || []).length ? `<div class="field"><span class="label">Keywords to hit</span><div class="kw">${a.keywords.map((k) => `<span class="chip">${esc(k)}</span>`).join("")}</div></div>` : ""}
      </div>
    </div>
    ${(() => {
      const y = yearsInfo(j), pp = a.portfolioProject;
      if (!y && !pp) return `<div class="row"><button class="btn small" data-act="extras">${S.busy[j.id] === "extras" ? "Checking…" : "Check experience required + suggest a GitHub project"}</button></div>`;
      return `<div class="grid2">
        <div class="field"><span class="label">Experience required</span>
          <p class="hint" style="margin:0">${y && y.cls ? `<span class="chip ${y.cls}">${esc(y.short)}</span> ` : ""}${esc(y ? y.text : "Not checked yet.")}</p></div>
        <div class="field"><span class="label">GitHub project to strengthen this application</span>
          ${pp ? `<p style="margin:0"><strong>${esc(pp.title)}</strong></p><p class="hint" style="margin:0">${esc(pp.description)}</p>` : `<p class="hint" style="margin:0">No suggestion yet.</p>`}</div>
      </div>`;
    })()}` : "";

  const appliedLine = j.appliedAt ? `Applied ${esc(fmtDate(j.appliedAt))} · ${daysSince(j.appliedAt)} days ago` : "";
  const nudge = j.status === "applied" && !resps.length && daysSince(j.appliedAt) >= 14 ? `<p class="hint" style="color:var(--warn)">No reply after ${daysSince(j.appliedAt)} days. A short follow-up email is reasonable now.</p>` : "";
  const track = `
    <div class="panel track">
      <div class="row" style="justify-content:space-between">
        <h2>Application</h2>
        <div class="row">
          <label class="label" for="status-${j.id}">Status</label>
          <select id="status-${j.id}" data-status="${j.id}" style="width:auto">${Object.entries(STATUS).map(([k, v]) => `<option value="${k}" ${j.status === k ? "selected" : ""}>${v}</option>`).join("")}</select>
        </div>
      </div>
      ${j.status === "new" ? `<div class="row">
          <button class="btn primary" data-act="applied">Mark as applied</button>
          <button class="btn" data-act="skip">Not applying</button>
          ${j.url ? `<a class="btn ghost" href="${esc(j.url)}" target="_blank" rel="noopener">Open posting ↗</a>` : ""}
        </div>` : `<p class="hint">${appliedLine || "Not applied."}</p>${nudge}`}
      ${j.appliedAt ? `
        <div class="field"><span class="label">Replies</span>
          ${resps.length ? `<ul class="timeline">${resps.map((r) => `<li><span class="d">${esc(r.date)}</span><span><strong>${esc(RESP[r.kind] || r.kind)}</strong>${r.note ? `<br><span class="hint">${esc(r.note)}</span>` : ""}</span><button class="btn ghost small" data-delresp="${r.i}" aria-label="Remove reply">✕</button></li>`).join("")}</ul>` : `<p class="hint">No replies logged yet.</p>`}
        </div>
        <div class="logform">
          <select id="rk-${j.id}" aria-label="Reply type">${Object.entries(RESP).map(([k, v]) => `<option value="${k}">${v}</option>`).join("")}</select>
          <input type="date" id="rd-${j.id}" value="${today()}" aria-label="Reply date">
          <textarea id="rn-${j.id}" rows="2" placeholder="Note: who replied, next step, interview date…"></textarea>
          <div class="row"><button class="btn primary small" data-act="logresp">Log reply</button></div>
        </div>` : ""}
    </div>`;

  let cv;
  const canWrite = j.english === "yes" || j.english === "mixed";
  const hasBase = !!(S.profile.resume || "").trim();
  if (busy === "writing") {
    cv = `<span class="thinking">Matching your experience to the requirements and writing the resume… this takes about 30–90 seconds.</span>`;
  } else if (j.resume) {
    const editing = S.editing === j.id;
    cv = `<div class="cv-toolbar">
        <span class="hint">Written ${esc(fmtDate(j.resumeAt))}${j.resumeEdited ? " · edited by you" : ""}${j.pdfFile && !j.pdfError ? ` · PDF saved as resumes/${esc(j.pdfFile)}` : ""}</span>
        <div class="row">
          ${editing ? `<button class="btn primary small" data-act="saveedit">Save edits</button><button class="btn small" data-act="canceledit">Cancel</button>`
            : `<button class="btn primary small" data-act="pdf">Download PDF</button>
               <button class="btn small" data-act="edit">Edit</button>
               <button class="btn small" data-act="copy">Copy text</button>
               <button class="btn small" data-act="generate">Rewrite</button>`}
        </div>
      </div>
      ${j.pdfError && !editing ? `<p class="err">PDF not made: ${esc(j.pdfError)}</p>` : ""}
      ${editing ? `<p class="hint"><span id="cv-dirty">No changes yet</span> · The preview on the right updates as you type. Save (or press ⌘S) to keep your changes and rebuild the PDF.</p>
        <div class="cv-split">
          <div class="field"><label class="label" for="cv-edit-${j.id}">Resume text (Markdown)</label>
            <textarea id="cv-edit-${j.id}" data-cvedit="${j.id}" spellcheck="true">${esc(j.resume)}</textarea></div>
          <div class="field"><span class="label">Live preview</span>
            <div class="paper"><div class="cv" id="cv-live-preview">${md(j.resume)}</div></div></div>
        </div>
        <details class="jd"><summary>Formatting help</summary><pre># Name  → your name (top)
## Heading  → a section, e.g. ## Work Experience
### Title  → a job title or degree
- text  → a bullet point
**text**  → bold
Leave an empty line between paragraphs.</pre></details>`
        : `<div class="paper"><div class="cv">${md(j.resume)}</div></div>`}
      ${j.resumeNotes && !editing ? `<div class="notes"><span class="label">What changed and gaps to cover</span>${md(j.resumeNotes)}</div>` : ""}`;
  } else if (!canWrite && j.english) {
    cv = `<p class="hint">No resume written: this posting needs German. ${hasBase ? `<button class="btn small" data-act="generate">Write one anyway</button>` : ""}</p>`;
  } else if (!hasBase) {
    cv = `<p class="hint">Save your base resume first, then write a tailored version here.</p><div class="row"><button class="btn" data-act="openbase">Add base resume</button></div>`;
  } else if (j.english) {
    cv = `<div class="row"><button class="btn primary" data-act="generate">Write tailored resume</button></div>`;
  } else {
    cv = `<p class="hint">The tailored resume appears here once the job is labeled English friendly.</p>`;
  }

  root.innerHTML = `
    <div class="panel">
      <div class="detail-head">
        <div class="row" style="justify-content:space-between">
          <span class="chip st-${j.status}">${STATUS[j.status]}</span>
          <span class="hint">Added ${esc(fmtDate(j.createdAt))}</span>
        </div>
        <h2>${esc(j.title || a.title || "Untitled posting")}</h2>
        <div class="co">${esc([j.company || a.company, a.location].filter(Boolean).join(" · "))}
          ${j.url ? ` · <a href="${esc(j.url)}" target="_blank" rel="noopener">${esc(hostOf(j.url) || "posting")} ↗</a>` : ""}</div>
        ${postingLine(j)}
      </div>
      ${S.err[j.id] ? `<p class="err">${esc(S.err[j.id])}</p>` : ""}
      ${verdict}
      <div class="row">
        <span class="label" title="Your own judgment. It decides the label in the desk, and the Evaluation panel compares it with the AI's.">My label</span>
        <div class="seg" role="group" aria-label="My label">
          ${LABELS.map((k) => `<button type="button" data-mine="${k}" aria-pressed="${j.myLabel === k}">${k === "yes" ? "English" : k === "mixed" ? "German a plus" : "German required"}</button>`).join("")}
        </div>
        ${j.myLabel && a.english && !hideAi(j) ? `<span class="hint">AI said: ${esc(ENGLISH[a.english])}${a.english === j.myLabel ? " ✓" : ""}</span>` : ""}
        ${j.english && !busy ? `<button class="btn ghost small" data-act="analyze">Re-analyze</button>` : ""}
      </div>
      ${analysisBlock}
      ${j.description ? `<details class="jd"${hideAi(j) ? " open" : ""}><summary>${j.fetched ? "Job description read from the link" : "Job description you pasted"}</summary><pre>${esc(j.description)}</pre></details>` : ""}
    </div>
    ${track}
    <div class="panel">
      <h2>Tailored resume</h2>
      ${cv}
    </div>
    <div class="row" style="justify-content:flex-end">
      <button class="btn danger small ${S.armed === j.id ? "armed" : ""}" data-act="delete">${S.armed === j.id ? "Click again to delete" : "Delete job"}</button>
    </div>`;
  restoreInputs(root, keep);
  refreshLivePreview();
}

/* ---------- live resume editor ---------- */
function refreshLivePreview() {
  document.querySelector(".desk").classList.toggle("editing", !!S.editing && !!job(S.editing));
  const ta = document.querySelector("[data-cvedit]"), out = $("#cv-live-preview");
  if (!ta || !out) return;
  out.innerHTML = md(ta.value);
  const dirty = ta.value !== (job(ta.dataset.cvedit)?.resume ?? "");
  const tag = $("#cv-dirty");
  tag.textContent = dirty ? "Unsaved changes" : "No changes yet";
  tag.style.color = dirty ? "var(--warn)" : "";
}
const hasUnsavedEdit = () => {
  const ta = document.querySelector("[data-cvedit]");
  return !!ta && ta.value !== (job(ta.dataset.cvedit)?.resume ?? "");
};
async function saveEdit(id) {
  const v = $(`#cv-edit-${id}`).value;
  try {
    upsert(await api("PATCH", `/api/jobs/${id}`, { resume: v, resumeEdited: true, baseResumeVersion: S.editBase ?? null }));
    S.editing = null; delete S.err[id]; toast("Resume saved · PDF rebuilt");
  } catch (e) {
    S.err[id] = e.message; toast("Not saved: the resume changed since you opened it");   // stay in the editor so nothing typed is lost
  }
  render();
}
document.addEventListener("input", (ev) => { if (ev.target.dataset?.cvedit) refreshLivePreview(); });
document.addEventListener("keydown", (ev) => {
  if ((ev.metaKey || ev.ctrlKey) && ev.key.toLowerCase() === "s" && S.editing) { ev.preventDefault(); saveEdit(S.editing); }
});
window.addEventListener("beforeunload", (ev) => { if (hasUnsavedEdit()) { ev.preventDefault(); ev.returnValue = ""; } });

/* ---------- Claude actions (run by the local server) ---------- */
async function analyze(id) {
  if (S.busy[id]) return;
  S.busy[id] = "analyzing"; delete S.err[id]; render();
  let j;
  try { j = await api("POST", `/api/jobs/${id}/analyze`); upsert(j); }
  catch (e) { S.err[id] = e.message; }
  delete S.busy[id]; render();
  if (j && (j.english === "yes" || j.english === "mixed") && (S.profile.resume || "").trim() && !j.resume) generate(id);
}
async function generate(id) {
  if (S.busy[id]) return;
  S.busy[id] = "writing"; S.editing = null; delete S.err[id]; render();
  try { upsert(await api("POST", `/api/jobs/${id}/resume`)); }
  catch (e) { S.err[id] = e.message; }
  delete S.busy[id]; render();
}

/* ---------- posting checks ---------- */
async function checkAllPostings(btn) {
  if (S.checking) return;
  S.checking = true; btn.disabled = true; btn.textContent = "Checking postings…"; render();
  try {
    const r = await api("POST", "/api/check-postings");
    S.jobs = r.jobs; S.lastCheck = r.lastRun;
    const parts = [`Checked ${r.checked}`, `${r.open} open`, `${r.closed.length} closed${r.closed.length ? ` (${r.closed.join(", ")})` : ""}`];
    if (r.unknown) parts.push(`${r.unknown} couldn't be checked`);
    toast(parts.join(" · ") + (r.blocked ? " · Stopped early: the site is limiting requests, try again later" : ""));
  } catch (e) { toast(e.message); }
  S.checking = false; btn.disabled = false; btn.textContent = "Check postings"; render();
}

/* ---------- PDF, rendered by Gotenberg on the server ---------- */
async function downloadPdf(j, btn) {
  btn.disabled = true; btn.textContent = "Preparing PDF…";
  try {
    const res = await fetch(`/api/jobs/${j.id}/pdf`);
    if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || "Couldn't make the PDF.");
    const a = Object.assign(document.createElement("a"), { href: URL.createObjectURL(await res.blob()), download: cvName(j) + ".pdf" });
    a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 5000);
    toast("PDF downloaded · also saved in munich-job-desk/resumes");
  } catch (e) { toast(e.message); }
  btn.disabled = false; btn.textContent = "Download PDF";
}

/* ---------- events ---------- */
document.addEventListener("click", async (ev) => {
  const t = ev.target.closest("button,[data-sel]"); if (!t) return;
  if (t.dataset.filter) { S.filter = t.dataset.filter; store.set("mad-filter", S.filter); render(); return; }
  if (t.dataset.sel) {
    if (hasUnsavedEdit() && !confirm("You have unsaved resume changes. Discard them?")) return;
    S.sel = t.dataset.sel; S.editing = null; S.armed = null; render();
    if (matchMedia("(max-width: 900px)").matches) $("#detail").scrollIntoView({ behavior: "smooth", block: "start" });
    return;
  }
  if (t.id === "toggle-base" || t.dataset.act === "openbase") {
    const p = $("#base-panel"); p.hidden = t.id === "toggle-base" ? !p.hidden : false; renderBase();
    if (!p.hidden) { p.scrollIntoView({ behavior: "smooth", block: "start" }); $("#base-text")?.focus(); }
    return;
  }
  if (t.id === "base-close") { $("#base-panel").hidden = true; return; }
  if (t.id === "toggle-eval") {
    const p = $("#eval-panel"); p.hidden = !p.hidden; renderEval();
    if (!p.hidden) p.scrollIntoView({ behavior: "smooth", block: "start" });
    return;
  }
  if (t.id === "eval-close") { $("#eval-panel").hidden = true; return; }
  if (t.id === "check-postings") return checkAllPostings(t);
  if (t.id === "base-save") {
    const v = $("#base-text").value.trim();
    if (v.length < 200) return toast("That looks too short for a full resume.");
    t.disabled = true;
    const yrs = $("#base-years").value;
    try { S.profile = await api("PUT", "/api/profile", { resume: v, experienceYears: yrs === "" ? null : Number(yrs) }); toast("Base resume saved"); $("#base-panel").hidden = true; }
    catch (e) { toast(e.message); }
    t.disabled = false; render(); return;
  }

  const j = job(S.sel); if (!j) return;
  if (t.dataset.mine) {
    // Clicking your current label again clears it, and the AI's label applies again.
    const k = j.myLabel === t.dataset.mine ? null : t.dataset.mine;
    return patch(j.id, { myLabel: k, english: k || j.analysis?.english || j.english });
  }
  if (t.dataset.delresp !== undefined) {
    const rs = (j.responses || []).slice(); rs.splice(Number(t.dataset.delresp), 1);
    return patch(j.id, { responses: rs });
  }
  const act = t.dataset.act; if (!act) return;
  if (act !== "delete") S.armed = null;
  switch (act) {
    case "checkposting": {
      S.checkingOne = j.id; render();
      try { const out = await api("POST", `/api/jobs/${j.id}/check`); upsert(out); toast(out.posting?.state === "closed" ? "This posting is closed" : out.posting?.state === "open" && out.posting.checkedAt === out.posting.attemptedAt ? "Still open" : "Couldn't check right now"); }
      catch (e) { toast(e.message); }
      S.checkingOne = null; render(); break;
    }
    case "extras": {
      if (S.busy[j.id]) break;
      S.busy[j.id] = "extras"; render();
      try { upsert(await api("POST", `/api/jobs/${j.id}/extras`)); }
      catch (e) { S.err[j.id] = e.message; }
      delete S.busy[j.id]; render(); break;
    }
    case "score": {
      if (S.busy[j.id]) break;
      S.busy[j.id] = "scoring"; render();
      try { upsert(await api("POST", `/api/jobs/${j.id}/score`)); toast("Tailored resume scored"); }
      catch (e) { S.err[j.id] = e.message; }
      delete S.busy[j.id]; render(); break;
    }
    case "analyze": analyze(j.id); break;
    case "generate": generate(j.id); break;
    case "applied": await patch(j.id, { status: "applied", appliedAt: Date.now() }); toast("Marked as applied"); break;
    case "skip": patch(j.id, { status: "skipped" }); break;
    case "logresp": {
      const kind = $(`#rk-${j.id}`).value, date = $(`#rd-${j.id}`).value || today(), note = $(`#rn-${j.id}`).value.trim();
      const next = { interview: "interview", rejection: "rejected", offer: "offer" }[kind];
      const data = { responses: [...(j.responses || []), { kind, date, note, at: Date.now() }] };
      if (next) data.status = next;
      $(`#rn-${j.id}`).value = "";
      await patch(j.id, data); toast("Reply logged");
      break;
    }
    case "edit":
      S.editing = j.id; S.editBase = j.resumeChangedAt ?? null; render();
      document.querySelector(".cv-split")?.scrollIntoView({ behavior: "smooth", block: "start" });
      document.querySelector("[data-cvedit]")?.focus({ preventScroll: true });
      break;
    case "canceledit":
      if (hasUnsavedEdit() && !confirm("Discard your changes?")) break;
      S.editing = null;
      try { const st = await api("GET", "/api/state"); S.jobs = st.jobs; S.profile = st.profile || {}; } catch {}
      render(); break;
    case "saveedit": await saveEdit(j.id); break;
    case "copy":
      try { await navigator.clipboard.writeText(j.resume); toast("Resume copied"); }
      catch { toast("Couldn't copy. Use Edit and copy from there."); }
      break;
    case "pdf": downloadPdf(j, t); break;
    case "delete":
      if (S.armed !== j.id) { S.armed = j.id; render(); setTimeout(() => { if (S.armed === j.id) { S.armed = null; render(); } }, 4000); break; }
      S.armed = null;
      try { await api("DELETE", `/api/jobs/${j.id}`); S.jobs = S.jobs.filter((x) => x.id !== j.id); S.sel = S.jobs[0]?.id || null; toast("Job deleted"); }
      catch (e) { toast(e.message); }
      render();
      break;
  }
});

document.addEventListener("change", (ev) => {
  if (ev.target.id === "blind-mode") { S.blind = ev.target.checked; store.set("mad-blind", S.blind ? "1" : "0"); render(); return; }
  if (ev.target.id === "sort-by") { S.sort = ev.target.value; store.set("mad-sort", S.sort); renderList(); return; }
  const id = ev.target.dataset?.status; if (!id) return;
  const status = ev.target.value, j = job(id);
  const data = { status };
  if (!["new", "skipped", "closed"].includes(status) && !j.appliedAt) data.appliedAt = Date.now();
  if (status === "new") data.appliedAt = null;
  patch(id, data);
});

$("#add-form").addEventListener("submit", async (ev) => {
  ev.preventDefault();
  const url = $("#job-url").value.trim(), description = $("#job-text").value.trim();
  const err = $("#add-err"); err.hidden = true;
  const fail = (m) => { err.textContent = m; err.hidden = false; };
  if (!url && !description) return fail("Paste a job link, or the job description.");
  if (description && description.length < 150) return fail("That description looks too short. Paste the whole posting, including requirements.");
  const btn = $("#add-btn"); btn.disabled = true; btn.textContent = url && !description ? "Reading the posting…" : "Adding…";
  try {
    const j = await api("POST", "/api/jobs", { url, description });
    upsert(j); S.sel = j.id;
    if (S.filter !== "all" && S.filter !== "todo") S.filter = "all";
    $("#job-url").value = ""; $("#job-text").value = "";
    analyze(j.id);
  } catch (e) {
    fail(e.message);
    if (/paste it below/.test(e.message)) $("#job-text").focus();
  } finally { btn.disabled = false; btn.textContent = "Analyze job"; }
});

/* ---------- boot ---------- */
S.filter = store.get("mad-filter") || "all";
S.sort = store.get("mad-sort") || "match";
render();
(async () => {
  try {
    const st = await api("GET", "/api/state");
    S.profile = st.profile || {}; S.jobs = st.jobs || []; S.lastCheck = st.postingCheck?.lastRun;
    S.loaded = true; S.sel = S.jobs[0]?.id || null;
    if (!S.jobs.length && !(S.profile.resume || "").trim()) $("#base-panel").hidden = false;
  } catch { S.offline = true; }
  render();
})();
