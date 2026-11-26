// Trägt die Momentaufnahmen in src/index.html ein – vor jedem Bauen einer neuen Version laufen lassen (nach „git pull“):
//   COVER0      Cover-Adressen je Titel aus covers.json (schreibt der tägliche Lauf tools/news.js)
//   AIR0, WATCH Termine und laufende Staffeln aus news.json (für Orte ohne Zugriff auf news.json, z. B. das Artifact)
// Aufruf: node tools/seed.js
const fs = require("fs"), path = require("path");
const ROOT = path.join(__dirname, ".."), FILE = path.join(ROOT, "src", "index.html");
let s = fs.readFileSync(FILE, "utf8");
const put = (name, re, val) => { const m = s.match(re); if (!m) throw new Error(name + " nicht gefunden"); s = s.replace(m[0], () => "const " + name + " = " + JSON.stringify(val) + ";"); };

// Titel der Liste (nur für sie wird ein Cover eingetragen)
const titles = new Set();
for (const name of ["DATA", "EXTRA"]) {
  const a = s.indexOf("const " + name + " = ["), b = s.indexOf("\n];", a); if (a < 0 || b < 0) throw new Error(name + " nicht gefunden");
  Function("return " + s.slice(s.indexOf("[", a), b + 2))().forEach(d => titles.add(d[0]));
}
const PRE = "https://s4.anilist.co/file/anilistcdn/media/anime/cover/";
const cov = JSON.parse(fs.readFileSync(path.join(ROOT, "covers.json"), "utf8")), c0 = {};
[...titles].forEach(k => { const u = cov[k]; if (typeof u === "string" && u.startsWith(PRE)) c0[k] = u.slice(PRE.length); });
put("COVER0", /const COVER0 = \{.*?\};/s, c0);

const news = JSON.parse(fs.readFileSync(path.join(ROOT, "news.json"), "utf8"));
put("AIR0", /const AIR0 = \{.*?\};/s, { t: news.t, m: news.m });
put("WATCH", /const WATCH = \{.*?\};/s, news.w);

fs.writeFileSync(FILE, s);
const miss = [...titles].filter(k => !c0[k]);
console.log(`Cover: ${Object.keys(c0).length} von ${titles.size}` + (miss.length ? " – ohne: " + miss.join(" | ") : "") + ` · Termine: Stand ${new Date(news.t * 1000).toISOString().slice(0, 16)}`);
