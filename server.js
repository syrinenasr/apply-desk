// Apply Desk — local server.
// Zero dependencies: Node's http server, a JSON file for storage, and the
// Claude Code CLI (`claude -p`) for labeling postings and writing resumes.

import http from "node:http";
import { spawn } from "node:child_process";
import { readFile, writeFile, mkdir, rename } from "node:fs/promises";
import { existsSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { cvHtml, cvName, cvTitle } from "./public/cv.js";

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.join(ROOT, "data");
const DB_FILE = path.join(DATA_DIR, "db.json");
const PORT = Number(process.env.PORT || 4317);
const CLAUDE_BIN = process.env.CLAUDE_BIN || "claude";
const RESUMES_DIR = path.join(ROOT, "resumes");
const GOTENBERG_URL = (process.env.GOTENBERG_URL || "http://localhost:3000").replace(/\/$/, "");
const CLAUDE_MODEL = process.env.CLAUDE_MODEL || ""; // e.g. "sonnet"; empty = your Claude Code default

/* ---------------- storage ---------------- */

let db = { profile: { resume: "", updatedAt: null }, jobs: [] };
let saving = Promise.resolve();

async function load() {
  await mkdir(DATA_DIR, { recursive: true });
  await mkdir(RESUMES_DIR, { recursive: true });
  if (existsSync(DB_FILE)) db = JSON.parse(await readFile(DB_FILE, "utf8"));
}
function persist() {
  // Serialize writes and swap atomically so a crash never leaves half a file.
  saving = saving.then(async () => {
    const tmp = DB_FILE + ".tmp";
    await writeFile(tmp, JSON.stringify(db, null, 2));
    await rename(tmp, DB_FILE);
  });
  return saving;
}
const findJob = (id) => db.jobs.find((j) => j.id === id);

/* ---------------- Claude ---------------- */

function askClaude(prompt, { timeoutMs = 300000 } = {}) {
  return new Promise((resolve, reject) => {
    const args = ["-p", "--output-format", "json", "--tools", "", "--no-session-persistence", "--strict-mcp-config",
      "--system-prompt", "You are a careful career assistant. Follow the requested output format exactly."];
    if (CLAUDE_MODEL) args.push("--model", CLAUDE_MODEL);
    // Run from a temp dir so no project CLAUDE.md leaks into the prompt.
    const child = spawn(CLAUDE_BIN, args, { cwd: tmpdir(), env: process.env });
    let out = "", err = "";
    const timer = setTimeout(() => { child.kill("SIGTERM"); reject(new Error("Claude took too long to answer.")); }, timeoutMs);
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (err += d));
    child.on("error", (e) => {
      clearTimeout(timer);
      reject(new Error(e.code === "ENOENT" ? "The `claude` command wasn't found. Install Claude Code or set CLAUDE_BIN." : e.message));
    });
    child.on("close", () => {
      clearTimeout(timer);
      try {
        const res = JSON.parse(out);
        if (res.is_error) return reject(new Error(res.result || "Claude returned an error."));
        resolve(String(res.result || ""));
      } catch {
        reject(new Error((err || out || "No answer from Claude.").trim().slice(0, 400)));
      }
    });
    child.stdin.end(prompt);
  });
}

function parseJson(text) {
  const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  const body = fence ? fence[1] : text.slice(text.indexOf("{"), text.lastIndexOf("}") + 1);
  return JSON.parse(body);
}

// What the candidate speaks at working level. The language label asks: can the candidate do this job with these?
const CANDIDATE_LANGUAGES = "English (fluent), French (fluent), Arabic (native), German (basic)";

// Location, work mode and work-permit rules, shared by the analysis and the extras check.
const LOCATION_RULES = `"city": the main city of the job, short, in its common English name ("Munich", "Cologne", "Zurich", "Montreal", "Brussels"). Use the city itself, not a metro area ("Greater Munich Metropolitan Area" → "Munich"); for a town next to a big city use the town ("Garching"). If several cities are listed, the first one. If the job is fully remote with no city, or no city is given, "".
"country": the country of that city in English ("Germany", "France", "United Kingdom", "United States", "Switzerland"); for a remote job with no city, the country or region it is open to if one is named ("Germany", "EU"), else "".
"workMode": "remote" only if the posting says the job is fully remote (working from home or anywhere, no regular office days); "hybrid" if it mixes office and home days or says "flexible/hybrid"; "onsite" if it clearly requires working at the office or a site; "unknown" if the posting doesn't say. Don't guess: a mention of "home office possible" is "hybrid", not "remote".
"workPermit": "sponsorship offered" if the posting explicitly offers visa sponsorship or relocation help with a work permit; "right to work required" if it explicitly requires an existing right to work / work authorization in that country (or says no sponsorship); else "not mentioned".`;

// The candidate's two job tracks, shared by the analysis and the extras check.
const TRACK_RULES = `"track": which of the candidate's two job tracks the role belongs to. "data" for AI, data and BI work: data engineer, analytics engineer, BI developer or analyst, data analyst or scientist, ML/AI engineer, Power BI, SQL, ETL and data-warehouse roles. "software" for Java, Angular and general software engineering: backend, full stack, frontend, Java/Spring, Angular, platform or product software. If a role mixes both, pick the one that matches most of the day-to-day work (building data pipelines, models and reports is "data"; building application features, APIs and UIs is "software", even for a data or AI product).`;

function analyzePrompt(job) {
  return `You help a candidate judge job postings. The candidate is based in Munich, Germany, is open to jobs in other cities and countries and to remote work, and speaks: ${CANDIDATE_LANGUAGES}.
Read the job posting and judge whether the candidate can do this job with those languages.

Reply with ONLY one JSON object of this shape:
{"title": string, "company": string, "location": string, "city": string, "country": string,
 "workMode": "remote" | "hybrid" | "onsite" | "unknown",
 "workPermit": "sponsorship offered" | "right to work required" | "not mentioned",
 "track": "data" | "software",
 "postingLanguage": "en" | "de" | "fr" | "other",
 "english": "yes" | "mixed" | "no",
 "germanRequirement": "not mentioned" | "nice to have" | "required",
 "germanLevel": "none" | "A1" | "A2" | "B1" | "B2" | "C1" | "C2" | "native" | "unspecified",
 "otherLanguage": string,
 "reason": string,
 "requirements": string[],
 "keywords": string[],
 "fit": number | null,
 "fitNotes": string,
 "requiredYearsMin": number | null,
 "requiredYearsMax": number | null,
 "portfolioProject": {"title": string, "description": string}}

How to set "english" (the language label; the name is kept for compatibility, it covers every language):
- "yes": the job can be done in English, French or Arabic (the candidate's fluent languages), and no other language is required. A French-speaking job that needs fluent French is "yes".
- "mixed": English or French is enough to do the job, but the local language (German, Dutch, Spanish, ...) is listed as a plus, or only basic German (A1-B1) is asked for.
- "no": the job requires a language the candidate doesn't have at working level: e.g. fluent, business-level or B2+ German, or fluent Dutch, Spanish, Italian...; or the posting is written in such a language and gives no sign that English or French alone is enough.
"germanRequirement" / "germanLevel": what the posting asks for German specifically ("not mentioned" and "none" if it doesn't mention German).
"otherLanguage": if a language other than English, French or German is required or a plus, its name and level, e.g. "Dutch (fluent)"; else "".
"reason": 1-2 sentences quoting or citing the posting's own language wording.
${LOCATION_RULES}
${TRACK_RULES}
"requirements": the 5-8 most important must-haves, each under 12 words, in English.
"keywords": 8-15 skills, tools and terms an ATS would scan for, in English.
"fit": 0-100 match between the candidate's resume and the requirements, or null if no resume is given.
"fitNotes": 1-3 sentences naming the strongest matches and the clearest gaps; "" if no resume.
"requiredYearsMin" / "requiredYearsMax": the years of professional experience the posting asks for, as numbers ("3+ years" → 3 and null; "2-5 years" → 2 and 5; "at least 5" → 5 and null). If the posting states no number of years, both are null; do not guess from words like "senior".
"portfolioProject": one GitHub portfolio project the candidate could build in 2-4 weekends to close this job's biggest skill gap, using the posting's tools where possible. "title": a short project title (under 10 words). "description": one sentence on what it does and which tools it uses.
Write every string in English, even if the posting is in another language.
Refer to the candidate as "the candidate", never with gendered pronouns.

Job link: ${job.url || "(none)"}

JOB POSTING:
${(job.description || "").slice(0, 30000)}

CANDIDATE RESUME:
${(db.profile.resume || "").slice(0, 20000) || "(not provided)"}`;
}

function resumePrompt(job) {
  const a = job.analysis || {};
  return `Rewrite the candidate's base resume so it targets the job below. The candidate is applying for this job in ${a.country || "the country of the job"}${a.workMode === "remote" ? " (a remote role)" : ""}.

Rules:
- Write in English.
- In the notes, address the candidate as "you".
- Never invent anything: no employer, title, date, degree, certification, number, tool or skill the base resume does not support. You may reword, reorder, emphasize, merge, condense and drop less relevant items.
- Use the posting's own terms where they truthfully describe the candidate's experience, so an ATS keyword scan matches.
- Open with a 2-3 sentence profile aimed at this role.
- Lead each bullet with an action verb and keep any real metrics from the base resume.
- State language skills honestly, as the base resume gives them.
- Keep it to about 450-700 words (one to two pages).
- Keep the contact details from the base resume.
- Never add a city, country or location to a job or school that the base resume does not give for it.

The resume must be readable by applicant tracking systems (ATS). Format it as Markdown, exactly:
# Full Name
City, Country | phone | email | LinkedIn  (one plain-text line, as given in the base resume)
## Summary
## Work Experience
### Job Title
Company | City (only if the base resume states it) | MM/YYYY - MM/YYYY
- bullets
## Skills
One line per category with the category in bold, e.g. "**Data & BI:** SQL Server, SSIS, Power BI"
## Education
### Degree
School, City | YYYY - YYYY
## Certifications
## Languages
(add other sections from the base resume only if they help this application)
ATS rules: standard section headings only as above; plain hyphen "-" in date ranges; no tables, columns, icons, emoji or decorative symbols; use "|" to separate items on one line; spell out each acronym once where the posting uses the long form.

After the resume, write a line containing only ===NOTES=== and then 3-6 short "- " bullets: what you emphasized or cut, and any requirement the candidate doesn't clearly meet that they should address in a cover letter or interview.
Output nothing before the "# " line.

JOB: ${a.title || ""} at ${a.company || ""} (${a.location || ""})
Key requirements: ${(a.requirements || []).join("; ")}
Keywords: ${(a.keywords || []).join(", ")}

JOB POSTING:
${(job.description || "").slice(0, 20000)}

BASE RESUME:
${(db.profile.resume || "").slice(0, 30000)}`;
}

// Fills in fields added after a job was analyzed (experience, GitHub project, location, work mode, work permit, track),
// without touching the language label or scores. Only the missing fields are asked for.
const LOCATION_KEYS = ["city", "country", "workMode", "workPermit"];
function missingExtras(a) {
  const need = [];
  if (!("requiredYearsMin" in a)) need.push("years");
  if (!a.portfolioProject) need.push("project");
  if (LOCATION_KEYS.some((k) => !(k in a))) need.push("location");
  if (!TRACKS.includes(a.track)) need.push("track");
  return need;
}

function extrasPrompt(job, need) {
  const shape = [], rules = [];
  if (need.includes("years")) {
    shape.push(`"requiredYearsMin": number | null, "requiredYearsMax": number | null`);
    rules.push(`"requiredYearsMin" / "requiredYearsMax": the years of professional experience the posting asks for, as numbers ("3+ years" → 3 and null; "2-5 years" → 2 and 5; "at least 5" → 5 and null). If the posting states no number of years, both are null; do not guess from words like "senior".`);
  }
  if (need.includes("project")) {
    shape.push(`"portfolioProject": {"title": string, "description": string}`);
    rules.push(`"portfolioProject": one GitHub portfolio project the candidate could build in 2-4 weekends to close this job's biggest skill gap, using the posting's tools where possible. "title": a short project title (under 10 words). "description": one sentence on what it does and which tools it uses.`);
  }
  if (need.includes("location")) {
    shape.push(`"city": string, "country": string, "workMode": "remote" | "hybrid" | "onsite" | "unknown", "workPermit": "sponsorship offered" | "right to work required" | "not mentioned"`);
    rules.push(LOCATION_RULES);
  }
  if (need.includes("track")) {
    shape.push(`"track": "data" | "software"`);
    rules.push(TRACK_RULES);
  }
  const resume = need.includes("project") ? `\n\nCANDIDATE RESUME:\n${(db.profile.resume || "").slice(0, 20000)}` : "";
  return `Read the job posting${resume ? " and the candidate's resume" : ""}. Reply with ONLY one JSON object:
{${shape.join(",\n ")}}
${rules.join("\n")}
Write every string in English.

Job link: ${job.url || "(none)"}
Location given in an earlier reading: ${job.analysis?.location || "(none)"}

JOB POSTING:
${(job.description || "").slice(0, 30000)}${resume}`;
}

// English names for cities that postings often give in the local language.
const CITY_ALIASES = {
  "münchen": "Munich", "munchen": "Munich", "muenchen": "Munich", "greater munich metropolitan area": "Munich",
  "köln": "Cologne", "koeln": "Cologne", "nürnberg": "Nuremberg", "nuernberg": "Nuremberg",
  "frankfurt am main": "Frankfurt", "frankfurt a. m.": "Frankfurt", "frankfurt/main": "Frankfurt",
  "hannover": "Hanover", "zürich": "Zurich", "genève": "Geneva", "geneve": "Geneva", "genf": "Geneva",
  "montréal": "Montreal", "bruxelles": "Brussels", "brussel": "Brussels", "wien": "Vienna", "lisboa": "Lisbon",
  "garching bei münchen": "Garching", "garching bei munchen": "Garching",
};
const COUNTRY_ALIASES = { "deutschland": "Germany", "uk": "United Kingdom", "great britain": "United Kingdom", "england": "United Kingdom",
  "usa": "United States", "us": "United States", "united states of america": "United States", "schweiz": "Switzerland", "suisse": "Switzerland" };
const WORK_MODES = ["remote", "hybrid", "onsite", "unknown"];
const WORK_PERMITS = ["sponsorship offered", "right to work required", "not mentioned"];
const TRACKS = ["data", "software"];
// Fallback when Claude's track answer is missing or unclear: data/BI/AI words in the title win, else software.
const guessTrack = (title) => (/\b(data\w*|analytics?|analyst|bi|business intelligence|power ?bi|etl|warehouse|ml|machine learning|ai|llm|scientist|reporting)\b/i.test(title || "") ? "data" : "software");
const shortText = (v, max = 60) => (typeof v === "string" ? v.replace(/\s+/g, " ").trim().slice(0, max) : "");
const cleanCity = (v) => { const c = shortText(v); return CITY_ALIASES[c.toLowerCase()] || c; };
const cleanCountry = (v) => { const c = shortText(v); return COUNTRY_ALIASES[c.toLowerCase()] || c; };

// Only the keys the answer actually contains, cleaned; so an extras call never blanks a field it wasn't asked for.
function cleanExtras(a) {
  const num = (v) => (typeof v === "number" && v >= 0 && v <= 30 ? v : null);
  const out = {};
  if ("requiredYearsMin" in a || "requiredYearsMax" in a) {
    out.requiredYearsMin = num(a.requiredYearsMin);
    out.requiredYearsMax = num(a.requiredYearsMax);
  }
  if ("portfolioProject" in a) {
    const p = a.portfolioProject && typeof a.portfolioProject === "object" ? a.portfolioProject : null;
    out.portfolioProject = p && p.title ? { title: String(p.title), description: String(p.description || "") } : null;
  }
  if ("city" in a) out.city = cleanCity(a.city);
  if ("country" in a) out.country = cleanCountry(a.country);
  if ("workMode" in a) { const m = String(a.workMode || "").toLowerCase().replace(/[^a-z]/g, ""); out.workMode = WORK_MODES.includes(m) ? m : "unknown"; }
  if ("workPermit" in a) { const w = String(a.workPermit || "").toLowerCase().trim(); out.workPermit = WORK_PERMITS.includes(w) ? w : "not mentioned"; }
  if ("otherLanguage" in a) out.otherLanguage = shortText(a.otherLanguage, 80);
  if ("track" in a) { const t = String(a.track || "").toLowerCase().trim(); out.track = TRACKS.includes(t) ? t : guessTrack(a.title); }
  return out;
}

// Scores the TAILORED resume (what you'd actually send) against the posting, on the same 0-100 scale as the analysis.
function resumeScorePrompt(job) {
  return `You are a recruiter screening one candidate's resume for the job below. Judge only what this resume shows.

Reply with ONLY one JSON object: {"fit": number, "fitNotes": string}
"fit": 0-100, how well this resume covers the posting's requirements (must-haves count most; seniority and years of experience count).
"fitNotes": 1-2 sentences naming the strongest matches and the clearest remaining gaps. Refer to the candidate as "the candidate", never with gendered pronouns.
Write in English.

JOB POSTING:
${(job.description || "").slice(0, 30000)}

RESUME:
${(job.resume || "").slice(0, 30000)}`;
}

async function scoreResume(job) {
  const r = parseJson(await askClaude(resumeScorePrompt(job)));
  if (typeof r.fit !== "number") throw new Error("The score came back incomplete. Try again.");
  job.resumeFit = { fit: Math.max(0, Math.min(100, Math.round(r.fit))), notes: String(r.fitNotes || ""), at: Date.now() };
  await persist();
  return job;
}

/* ---------------- PDF via Gotenberg ---------------- */

async function renderPdf(job) {
  const form = new FormData();
  form.append("files", new Blob([cvHtml(job)], { type: "text/html" }), "index.html");
  form.append("preferCssPageSize", "true");
  form.append("printBackground", "true");
  form.append("metadata", JSON.stringify({ Title: cvTitle(job), Author: (job.resume.match(/^#\s+(.+)$/m) || [])[1] || "", Subject: `Resume for ${job.title || "job application"}`, Keywords: (job.analysis?.keywords || []).slice(0, 15) }));
  let res;
  try {
    res = await fetch(`${GOTENBERG_URL}/forms/chromium/convert/html`, { method: "POST", body: form, signal: AbortSignal.timeout(60000) });
  } catch {
    throw new Error("Gotenberg isn't running. Start it with: docker start gotenberg");
  }
  if (!res.ok) throw new Error(`Gotenberg couldn't make the PDF (${res.status}).`);
  let name = `${cvName(job)}.pdf`;
  if (db.jobs.some((j) => j.id !== job.id && j.pdfFile === name)) name = `${cvName(job)}_${job.id.slice(0, 6)}.pdf`;
  await writeFile(path.join(RESUMES_DIR, name), Buffer.from(await res.arrayBuffer()));
  Object.assign(job, { pdfFile: name, pdfAt: Date.now(), pdfError: "" });
  await persist();
  return name;
}

// Called after every resume change; a failure is recorded, not thrown.
async function autoPdf(job) {
  try { await renderPdf(job); }
  catch (e) { job.pdfError = e.message; await persist(); console.error("[pdf]", e.message); }
}

/* ---------------- fetching postings ---------------- */

const decode = (s) => s
  .replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">")
  .replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'")
  .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(+n)).replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)));

function htmlToText(html) {
  return decode(html
    .replace(/<(script|style|noscript|svg|head|nav|footer)[\s\S]*?<\/\1>/gi, " ")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|li|h[1-6]|tr|section|ul|ol)>/gi, "\n")
    .replace(/<li[^>]*>/gi, "- ")
    .replace(/<[^>]+>/g, " "))
    .replace(/[ \t]+/g, " ").replace(/\n\s*\n\s*/g, "\n\n").trim();
}

function linkedInGuestUrl(url) {
  try {
    const u = new URL(url);
    if (!/linkedin\.com$/.test(u.hostname.replace(/^www\./, "").replace(/^[a-z]{2}\./, ""))) return null;
    const id = u.searchParams.get("currentJobId") || (u.pathname.match(/\/jobs\/view\/(?:[^/]*-)?(\d+)/) || [])[1];
    return id ? `https://www.linkedin.com/jobs-guest/jobs/api/jobPosting/${id}` : null;
  } catch { return null; }
}

function jobPostingFromLd(html) {
  for (const m of html.matchAll(/<script[^>]+application\/ld\+json[^>]*>([\s\S]*?)<\/script>/gi)) {
    try {
      const data = JSON.parse(m[1].trim());
      const items = [].concat(data["@graph"] || data);
      const jp = items.find((x) => x && [].concat(x["@type"]).includes("JobPosting"));
      if (jp) {
        const org = jp.hiringOrganization?.name || "";
        const loc = [].concat(jp.jobLocation || []).map((l) => l?.address?.addressLocality).filter(Boolean).join(", ");
        return [jp.title, org && `Company: ${org}`, loc && `Location: ${loc}`, htmlToText(decode(String(jp.description || "")))].filter(Boolean).join("\n\n");
      }
    } catch {}
  }
  return "";
}

// LinkedIn's guest job page: keep the title, company, location, description and
// job criteria, and drop the sign-in prompts around them.
function linkedInText(html) {
  const grab = (re) => htmlToText((html.match(re) || [])[1] || "");
  const title = grab(/class="[^"]*top-card-layout__title[^"]*"[^>]*>([\s\S]*?)<\//);
  const company = grab(/class="[^"]*topcard__org-name-link[^"]*"[^>]*>([\s\S]*?)<\/a>/);
  const location = grab(/class="topcard__flavor topcard__flavor--bullet"[^>]*>([\s\S]*?)<\/span>/);
  const desc = grab(/class="description__text description__text--rich"[^>]*>([\s\S]*?)<button[^>]*show-more-less-html__button/);
  const criteria = grab(/class="description__job-criteria-list"[^>]*>([\s\S]*?)<\/ul>/);
  if (desc.length < 200) return "";
  return [title, company && `Company: ${company}`, location && `Location: ${location}`, desc, criteria].filter(Boolean).join("\n\n");
}

const BROWSER_HEADERS = {
  "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0 Safari/537.36",
  "Accept-Language": "en-US,en;q=0.9,de;q=0.8",
  Accept: "text/html,application/xhtml+xml",
};

async function fetchPosting(url) {
  const guest = linkedInGuestUrl(url);
  const target = guest || url;
  const res = await fetch(target, {
    headers: BROWSER_HEADERS,
    redirect: "follow",
    signal: AbortSignal.timeout(20000),
  });
  if (!res.ok) throw new Error(`The site answered ${res.status}.`);
  const html = await res.text();
  const text = (guest && linkedInText(html)) || jobPostingFromLd(html) || htmlToText(html);
  return text.slice(0, 40000);
}

/* ---------------- posting status checks ---------------- */

const CHECK_EVERY_MS = 24 * 60 * 60 * 1000;
const CHECK_GAP_MS = 4000; // pause between requests so sites don't rate-limit us
const AUTO_CHECK = process.env.POSTING_CHECK !== "off";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const CLOSED_PHRASES = [
  /no longer accepting applications/i,
  /this (job|position|posting|vacancy) (is no longer available|has been filled|has expired|is closed)/i,
  /(stelle|stellenanzeige) ist (leider )?(nicht mehr verfügbar|bereits besetzt|abgelaufen)/i,
];

function validThrough(html) {
  const m = html.match(/"validThrough"\s*:\s*"([^"]+)"/);
  const t = m ? Date.parse(m[1]) : NaN;
  return Number.isNaN(t) ? null : t;
}

// Is the posting still open? Returns { state: "open" | "closed" | "unknown", note, blocked }.
// A rate limit or bot check is never read as "closed": it's "unknown", and the run stops.
async function checkPosting(job) {
  if (!job.url) return { state: "unknown", note: "No link is saved for this job." };
  const guest = linkedInGuestUrl(job.url);
  let res;
  try {
    res = await fetch(guest || job.url, { headers: BROWSER_HEADERS, redirect: "follow", signal: AbortSignal.timeout(20000) });
  } catch {
    return { state: "unknown", note: "Couldn't reach the site." };
  }
  if (res.status === 404 || res.status === 410) return { state: "closed", note: `The posting has been removed (the site answered ${res.status}).` };
  if (res.status === 429 || res.status === 999) return { state: "unknown", note: "The site is limiting requests right now. Try again later.", blocked: true };
  if (!res.ok) return { state: "unknown", note: `The site answered ${res.status}.` };
  const html = await res.text();
  if (CLOSED_PHRASES.some((re) => re.test(html))) return { state: "closed", note: "The posting says it no longer accepts applications." };
  if (guest) {
    if (!/top-card-layout__title/.test(html)) return { state: "unknown", note: "LinkedIn showed a security check instead of the posting. Try again later.", blocked: true };
    // The logged-out page keeps showing closed jobs; what changes is that LinkedIn removes the Apply button.
    if (/apply-button|public_jobs_apply-link/.test(html)) return { state: "open", note: "" };
    if (/top-card-layout__cta-container/.test(html)) return { state: "closed", note: "LinkedIn no longer shows an Apply button: it's not accepting applications." };
    return { state: "unknown", note: "Couldn't find LinkedIn's apply section on the page." };
  }
  const until = validThrough(html);
  if (until && until < Date.now()) return { state: "closed", note: "The posting's end date has passed." };
  if (jobPostingFromLd(html) || htmlToText(html).length > 500) return { state: "open", note: "" };
  return { state: "unknown", note: "Couldn't find the posting on the page." };
}

function applyCheck(job, r) {
  const now = Date.now();
  if (r.state === "unknown") {
    // Keep the last known answer; just record the failed attempt.
    job.posting = { ...(job.posting || { state: "unknown" }), note: r.note, attemptedAt: now };
    return;
  }
  job.posting = { state: r.state, note: r.note, checkedAt: now, attemptedAt: now };
  if (r.state === "closed" && job.status === "new") job.status = "closed";
}

// Jobs worth checking: ones you might still apply to, and applications waiting for an answer.
const needsCheck = (j) => j.url && ((j.status === "new" && j.english !== "no") || j.status === "applied");

let checking = null;
function checkAll({ force = false } = {}) {
  if (checking) return checking; // one run at a time
  checking = (async () => {
    const due = db.jobs.filter((j) => needsCheck(j) && (force || !((j.posting?.attemptedAt || 0) > Date.now() - CHECK_EVERY_MS / 2)));
    const summary = { checked: 0, open: 0, closed: [], unknown: 0, blocked: false };
    for (const [i, job] of due.entries()) {
      if (i) await sleep(CHECK_GAP_MS);
      const r = await checkPosting(job);
      applyCheck(job, r);
      await persist();
      summary.checked++;
      if (r.state === "open") summary.open++;
      else if (r.state === "closed") summary.closed.push(job.company || job.title || job.url);
      else summary.unknown++;
      if (r.blocked) { summary.blocked = true; break; }
    }
    if (!summary.blocked) { db.lastPostingCheck = Date.now(); await persist(); }
    console.log(`[postings] checked ${summary.checked}: ${summary.open} open, ${summary.closed.length} closed, ${summary.unknown} unknown${summary.blocked ? " (stopped: site is limiting requests)" : ""}`);
    return summary;
  })().finally(() => { checking = null; });
  return checking;
}

/* ---------------- HTTP ---------------- */

const send = (res, code, body, type = "application/json") => {
  res.writeHead(code, { "Content-Type": type + "; charset=utf-8", "Cache-Control": "no-store" });
  res.end(type === "application/json" ? JSON.stringify(body) : body);
};
const fail = (res, code, message) => send(res, code, { error: message });

async function body(req) {
  let raw = "";
  for await (const chunk of req) raw += chunk;
  return raw ? JSON.parse(raw) : {};
}

const busy = new Set();

const routes = {
  "GET /api/state": () => ({ profile: db.profile, jobs: db.jobs, busy: [...busy], postingCheck: { lastRun: db.lastPostingCheck || null, running: !!checking } }),

  async "POST /api/check-postings"() {
    const summary = await checkAll({ force: true });
    return { ...summary, jobs: db.jobs, lastRun: db.lastPostingCheck || null };
  },

  async "POST /api/jobs/:id/check"(_req, id) {
    const job = findJob(id);
    if (!job) throw Object.assign(new Error("Job not found."), { status: 404 });
    applyCheck(job, await checkPosting(job));
    await persist();
    return job;
  },

  async "PUT /api/profile"(req) {
    const b = await body(req);
    const years = Number(b.experienceYears);
    db.profile = {
      ...db.profile,
      ...("resume" in b ? { resume: String(b.resume || "").trim(), updatedAt: Date.now() } : {}),
      ...("experienceYears" in b ? { experienceYears: Number.isFinite(years) && years >= 0 && years <= 50 ? years : null } : {}),
    };
    await persist();
    return db.profile;
  },

  async "POST /api/jobs"(req) {
    const { url = "", description = "" } = await body(req);
    const cleanUrl = String(url).trim();
    let text = String(description).trim(), fetchNote = "";
    if (!text && !cleanUrl) throw Object.assign(new Error("Paste a job link or the job description."), { status: 400 });
    if (cleanUrl && db.jobs.some((j) => j.url === cleanUrl)) throw Object.assign(new Error("This link is already on your desk."), { status: 409 });
    if (!text) {
      try { text = await fetchPosting(cleanUrl); }
      catch (e) { fetchNote = e.message; }
      if (text.length < 300) {
        throw Object.assign(new Error(`Couldn't read the posting from that link${fetchNote ? ` (${fetchNote})` : ""}. Open it in your browser, copy the description and paste it below.`), { status: 422 });
      }
    }
    const job = {
      id: randomUUID(), url: cleanUrl, description: text, fetched: !String(description).trim(),
      createdAt: Date.now(), status: "new", english: null, analysis: null, title: "", company: "",
      resume: "", resumeNotes: "", resumeAt: null, resumeEdited: false, responses: [], appliedAt: null,
    };
    db.jobs.unshift(job);
    await persist();
    return job;
  },

  async "PATCH /api/jobs/:id"(req, id) {
    const job = findJob(id);
    if (!job) throw Object.assign(new Error("Job not found."), { status: 404 });
    const patch = await body(req);
    // Editor saves send the version they started from; refuse if the resume changed since (e.g. Claude updated it).
    if ("resume" in patch && "baseResumeVersion" in patch && (job.resumeChangedAt || null) !== patch.baseResumeVersion) {
      throw Object.assign(new Error("This resume was changed after you opened the editor (for example, Claude updated it), so your save was stopped to avoid overwriting that change. Your text is still in the editor: copy your changes, click Cancel to load the latest version, then paste them back."), { status: 409 });
    }
    if ("myLabel" in patch && ![null, "yes", "mixed", "no"].includes(patch.myLabel)) {
      throw Object.assign(new Error("My label must be yes, mixed, no or empty."), { status: 400 });
    }
    const allowed = ["status", "english", "myLabel", "responses", "appliedAt", "resume", "resumeEdited", "description", "title", "company", "posting", "url"];
    for (const k of allowed) if (k in patch) job[k] = patch[k];
    if ("resume" in patch) job.resumeChangedAt = Date.now();
    await persist();
    if ("resume" in patch && job.resume) await autoPdf(job);
    return job;
  },

  async "DELETE /api/jobs/:id"(_req, id) {
    db.jobs = db.jobs.filter((j) => j.id !== id);
    await persist();
    return { ok: true };
  },

  async "POST /api/jobs/:id/analyze"(_req, id) {
    const job = findJob(id);
    if (!job) throw Object.assign(new Error("Job not found."), { status: 404 });
    if (busy.has(id)) throw Object.assign(new Error("Already working on this job."), { status: 409 });
    busy.add(id);
    try {
      const a = parseJson(await askClaude(analyzePrompt(job)));
      if (!["yes", "mixed", "no"].includes(a.english)) throw new Error("The analysis came back incomplete. Try again.");
      a.requirements = Array.isArray(a.requirements) ? a.requirements.map(String) : [];
      a.keywords = Array.isArray(a.keywords) ? a.keywords.map(String) : [];
      a.fit = typeof a.fit === "number" ? a.fit : null;
      Object.assign(a, { city: "", country: "", workMode: "unknown", workPermit: "not mentioned", otherLanguage: "", track: guessTrack(a.title) }, cleanExtras(a));
      if (!("requiredYearsMin" in a)) Object.assign(a, { requiredYearsMin: null, requiredYearsMax: null });
      // The AI's answer stays in analysis.english for the evaluation; your own label, if set, still decides.
      Object.assign(job, { analysis: a, english: job.myLabel || a.english, title: String(a.title || ""), company: String(a.company || ""), analyzedAt: Date.now() });
      await persist();
      return job;
    } catch (e) {
      throw e instanceof SyntaxError ? new Error("The analysis came back malformed. Try again.") : e;
    } finally { busy.delete(id); }
  },

  async "POST /api/jobs/:id/resume"(_req, id) {
    const job = findJob(id);
    if (!job) throw Object.assign(new Error("Job not found."), { status: 404 });
    if (!db.profile.resume) throw Object.assign(new Error("Save your base resume first."), { status: 400 });
    if (busy.has(id)) throw Object.assign(new Error("Already working on this job."), { status: 409 });
    busy.add(id);
    try {
      const text = (await askClaude(resumePrompt(job))).replace(/^```(?:markdown|md)?\s*/i, "").replace(/```\s*$/, "");
      const [cv, notes = ""] = text.split("===NOTES===");
      const start = cv.indexOf("# ");
      Object.assign(job, { resume: (start > 0 ? cv.slice(start) : cv).trim(), resumeNotes: notes.trim(), resumeAt: Date.now(), resumeChangedAt: Date.now(), resumeEdited: false });
      await persist();
      await autoPdf(job);
      try { await scoreResume(job); } catch (e) { console.error("[score]", e.message); }
      return job;
    } finally { busy.delete(id); }
  },

  async "POST /api/jobs/:id/extras"(_req, id) {
    const job = findJob(id);
    if (!job) throw Object.assign(new Error("Job not found."), { status: 404 });
    if (!job.analysis) throw Object.assign(new Error("Analyze the job first."), { status: 400 });
    if (busy.has(id)) throw Object.assign(new Error("Already working on this job."), { status: 409 });
    busy.add(id);
    try {
      const need = missingExtras(job.analysis);
      if (!need.length) return job;
      const got = parseJson(await askClaude(extrasPrompt(job, need)));
      if ("track" in got) got.title = job.title || job.analysis.title;  // for the fallback guess only
      const clean = cleanExtras(got);
      if (!need.includes("track")) delete clean.track;
      Object.assign(job.analysis, clean);
      job.analysis.extrasAt = Date.now();
      await persist();
      return job;
    } catch (e) { throw e instanceof SyntaxError ? new Error("The answer came back malformed. Try again.") : e; }
    finally { busy.delete(id); }
  },

  async "POST /api/jobs/:id/score"(_req, id) {
    const job = findJob(id);
    if (!job) throw Object.assign(new Error("Job not found."), { status: 404 });
    if (!job.resume) throw Object.assign(new Error("This job has no tailored resume to score."), { status: 400 });
    if (busy.has(id)) throw Object.assign(new Error("Already working on this job."), { status: 409 });
    busy.add(id);
    try { return await scoreResume(job); }
    catch (e) { throw e instanceof SyntaxError ? new Error("The score came back malformed. Try again.") : e; }
    finally { busy.delete(id); }
  },
};

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, "http://localhost");
  try {
    if (req.method === "GET" && (url.pathname === "/" || url.pathname === "/index.html")) {
      return send(res, 200, await readFile(path.join(ROOT, "public", "index.html"), "utf8"), "text/html");
    }
    if (req.method === "GET" && ["/app.js", "/cv.js", "/eval.js"].includes(url.pathname)) {
      return send(res, 200, await readFile(path.join(ROOT, "public", url.pathname.slice(1)), "utf8"), "text/javascript");
    }
    const pdf = req.method === "GET" && url.pathname.match(/^\/api\/jobs\/([\w-]+)\/pdf$/);
    if (pdf) {
      const job = findJob(pdf[1]);
      if (!job?.resume) return fail(res, 404, "This job has no tailored resume yet.");
      const file = job.pdfFile && path.join(RESUMES_DIR, job.pdfFile);
      if (!file || !existsSync(file) || (job.pdfAt || 0) < (job.resumeChangedAt || job.resumeAt || 0)) await renderPdf(job);
      res.writeHead(200, { "Content-Type": "application/pdf", "Content-Disposition": `attachment; filename="${job.pdfFile}"`, "Cache-Control": "no-store" });
      return res.end(await readFile(path.join(RESUMES_DIR, job.pdfFile)));
    }
    const m = url.pathname.match(/^\/api\/jobs\/([\w-]+)(\/\w+)?$/);
    const key = m ? `${req.method} /api/jobs/:id${m[2] || ""}` : `${req.method} ${url.pathname}`;
    const handler = routes[key];
    if (!handler) return fail(res, 404, "Not found.");
    send(res, 200, await handler(req, m?.[1]));
  } catch (e) {
    console.error(`[${req.method} ${url.pathname}]`, e.message);
    fail(res, e.status || 500, e.message || "Something went wrong.");
  }
});

await load();
server.listen(PORT, "127.0.0.1", () => {
  console.log(`Apply Desk → http://localhost:${PORT}`);
  console.log(`Data file: ${DB_FILE}`);
});

// Check postings once a day while the app runs: first a minute after start, then hourly look whether a day has passed.
if (AUTO_CHECK) {
  const autoCheck = () => {
    if (Date.now() - (db.lastPostingCheck || 0) >= CHECK_EVERY_MS) checkAll().catch((e) => console.error("[postings]", e.message));
  };
  setTimeout(autoCheck, 60 * 1000);
  setInterval(autoCheck, 60 * 60 * 1000);
}
