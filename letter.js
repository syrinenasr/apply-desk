// Application folders and cover letters: naming and the letter page.
// Pure functions, so they can be tested without starting the server.

import { esc } from "./public/cv.js";

const LEGAL_FORMS = /\b(GmbH|AG|SE|KG|KGaA|e\.?\s?V|Ltd|Limited|Inc|LLC|plc|S\.?A\.?S?|SARL|B\.?V|N\.?V|Co)\b\.?/gi;

// "REPA Deutschland GmbH" → "REPA Deutschland"; keeps letters, digits, spaces, &, + and -.
export function companyFolder(company) {
  const name = String(company || "")
    .replace(LEGAL_FORMS, "")
    .replace(/[^\p{L}\p{N} &+-]/gu, " ")
    .replace(/\s+/g, " ").trim()
    .replace(/^[-\s]+|[-\s]+$/g, "");
  return name || "Company";
}

// Reuse a folder made earlier by hand: "Panasonic" or "REPA" for "Panasonic Europe" or "REPA Deutschland GmbH".
export function pickFolder(company, existing) {
  const want = companyFolder(company);
  const lower = want.toLowerCase();
  return existing.find((f) => f.toLowerCase() === lower)
    || existing.find((f) => lower.startsWith(f.toLowerCase() + " "))
    || want;
}

// The candidate's name, contact line and home city, read from the tailored resume's first lines.
export function letterHead(resume) {
  const lines = String(resume || "").split("\n").map((l) => l.trim()).filter(Boolean);
  const name = (lines.find((l) => l.startsWith("# ")) || "# ").slice(2).trim();
  const contact = lines[lines.findIndex((l) => l.startsWith("# ")) + 1] || "";
  const place = contact.split("|").map((s) => s.trim()).find((s) => s.includes(",") && !/[@\d]/.test(s)) || "";
  return { name, contact: contact.startsWith("#") ? "" : contact, city: place.split(",")[0].trim() };
}

export function letterFiles(name, folder) {
  const person = name.replace(/[^\p{L}\p{N} -]/gu, "").trim().replace(/\s+/g, "-") || "Resume";
  return {
    resume: `${person}_Resume.pdf`,
    html: "cover-letter.html",
    pdf: `${person.replace(/-/g, "_")}_Cover_Letter_${folder.replace(/[^\p{L}\p{N}]+/gu, "-").replace(/^-|-$/g, "")}.pdf`,
  };
}

const LETTER_CSS = `
/* Same look as the ATS CV: one column, Arial, black text. */
@page { size: A4; margin: 22mm 22mm; }
body { margin: 0; color: #000; font-family: Arial, "Liberation Sans", Helvetica, sans-serif; font-size: 10.5pt; line-height: 1.5; font-variant-ligatures: none; font-feature-settings: "liga" 0, "clig" 0; }
h1 { font-size: 18pt; margin: 0 0 3px; }
.contact { margin: 0 0 22px; }
.meta { margin: 0 0 18px; }
.subject { font-weight: 700; margin: 0 0 18px; }
p { margin: 0 0 12px; }
.sign { margin-top: 20px; }`;

// letter = { subject, greeting, paragraphs: [...] } from Claude; head from letterHead().
export function letterHtml({ head, company, city, date, letter }) {
  const where = [company, city].filter(Boolean).join(", ");
  const dateLine = [head.city, date].filter(Boolean).join(", ");
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>${esc(`${head.name} - Cover Letter - ${company}`)}</title>
<style>${LETTER_CSS}
</style>
</head>
<body>

<h1>${esc(head.name)}</h1>
<p class="contact">${esc(head.contact)}</p>

<p class="meta">${esc(where)}<br>${esc(dateLine)}</p>

<p class="subject">${esc(letter.subject)}</p>

<p>${esc(letter.greeting)}</p>

${letter.paragraphs.map((p) => `<p>${esc(p)}</p>`).join("\n\n")}

<p class="sign">Warm regards,<br>${esc(head.name)}</p>

</body>
</html>
`;
}
