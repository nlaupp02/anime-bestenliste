// Läuft einmal am Tag bei GitHub (siehe .github/workflows/news.yml) und schreibt news.json für den News-Reiter der App.
// Fragt bei AniList (frei zugänglich, kein Schlüssel nötig) für alle Titel der Liste nach:
//   - läuft gerade eine Staffel, und wann kommt die nächste Folge?
//   - ist eine neue Staffel angekündigt, und wann startet sie?
// Aufbau von news.json:
//   t: Zeitpunkt des Laufs (Sekunden)
//   w: je Titel (Name wie in der Liste) die AniList-Nummern der laufenden oder angekündigten Staffeln (negativ = der Titel selbst)
//   m: je AniList-Nummer [Status 1 läuft / 2 angekündigt, Zeitpunkt nächste Folge, Folge, Startjahr, -monat, -tag, Folgen gesamt]
//   l: je Titel eine berichtigte Längenangabe („12 Folgen“ statt „12 Folgen, läuft gerade“) – siehe Abgleich unten
//
// Abgleich (seit V381): Stimmen „Staffeln · Folgen“ in der Liste noch?
//   tools/len-base.json hält je Serie fest, welcher Text in der Liste steht und wie die Staffeln bei AniList an dem Tag standen
//   (F = fertig, R = läuft, N = angekündigt, dahinter die Folgenzahl). Jeden Tag wird damit verglichen:
//   - eindeutige Fälle (Staffel zu Ende, neue Staffel gestartet) bekommen sofort einen neuen Text in news.json (l), die App zeigt ihn an
//   - alles andere kommt nur in die Prüfliste check.json (pruefen) – dort steht auch, was noch von Hand zu klären ist
//     (z. B. ob die neue Staffel wirklich auf Crunchyroll Deutschland läuft; das lässt sich nicht automatisch abfragen)
//   Wird der Text in der Liste von Hand geändert, gilt ab dem nächsten Lauf der neue Stand. Soll ein Titel ohne Textänderung
//   als „geprüft“ gelten: seinen Eintrag aus tools/len-base.json löschen.
const fs = require("fs"), path = require("path");
const ROOT = path.join(__dirname, "..");
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function gql(query) {
  for (let k = 0; k < 12; k++) {
    let r;
    try { r = await fetch("https://graphql.anilist.co", { method: "POST", headers: { "Content-Type": "application/json", Accept: "application/json" }, body: JSON.stringify({ query }) }); }
    catch (e) { await sleep(15000); continue; }
    if (r.status === 429) { await sleep(((+r.headers.get("retry-after") || 60) + 2) * 1000); continue; }
    const js = await r.json().catch(() => null);
    await sleep(2500); // höchstens etwa 24 Anfragen pro Minute
    if (js && js.data) return js;
    if (r.status >= 500) { await sleep(20000); continue; }
    throw new Error("AniList " + r.status + ": " + JSON.stringify(js && js.errors).slice(0, 300));
  }
  throw new Error("AniList antwortet nicht");
}

// MyAnimeList-Nummern: ältere Titel aus tools/news-ids.json, alle neueren stehen in der App selbst (ID_MAL)
function loadIds() {
  const ids = JSON.parse(fs.readFileSync(path.join(__dirname, "news-ids.json"), "utf8"));
  const src = fs.readFileSync(path.join(ROOT, "src", "index.html"), "utf8");
  const m = src.match(/const ID_MAL = (\{[\s\S]*?\n\});/);
  if (m) Object.assign(ids, Function("return " + m[1])());
  return ids;
}

// Art und Längenangabe je Titel, wie sie in der App stehen (DATA und EXTRA)
function loadRows() {
  const src = fs.readFileSync(path.join(ROOT, "src", "index.html"), "utf8"), out = {};
  for (const name of ["DATA", "EXTRA"]) {
    const a = src.indexOf("const " + name + " = ["); if (a < 0) continue;
    const b = src.indexOf("\n];", a); if (b < 0) continue;
    Function("return " + src.slice(src.indexOf("[", a), b + 2))().forEach(d => { if (Array.isArray(d) && typeof d[0] === "string") out[d[0]] = { type: d[1], len: String(d[7] || "") }; });
  }
  return out;
}

// Abgleich der Längenangaben (Beschreibung oben). Gibt { l, auto, pruefen } zurück und ergänzt base.
function lenCheck(keys, rows, chain, M, base, nowMs) {
  const code = x => ({ FINISHED: "F", RELEASING: "R", NOT_YET_RELEASED: "N", CANCELLED: "C", HIATUS: "H" }[x.status] || "?") + (x.episodes || 0);
  const ep = id => M[id].episodes || 0, tv = id => M[id].format === "TV";
  const recent = id => { const s = M[id].startDate || {}; return !!s.year && nowMs - Date.UTC(s.year, (s.month || 1) - 1, s.day || 1) < 420 * 864e5; };
  const l = {}, auto = [], pruefen = [];
  for (const k of keys.slice().sort()) {
    const row = rows[k], ch = chain[k]; if (!row || !ch || row.type !== "S") continue;
    const now = {}; ch.forEach(id => { now[id] = code(M[id]); });
    const b = base[k];
    if (!b || b.len !== row.len || !b.st) { base[k] = { len: row.len, st: now }; continue; } // neu in der Liste oder Text geändert: ab jetzt gilt dieser Stand
    const fin = [], start = [], both = [], eps = [];
    for (const id of ch) {
      const was = b.st[id] || "N0", is = now[id], w0 = was[0], i0 = is[0];
      if (w0 === "R" && i0 === "F") fin.push(id);
      else if ((w0 === "N" || w0 === "?") && i0 === "R") start.push(id);
      else if ((w0 === "N" || w0 === "?") && i0 === "F") both.push(id);
      else if (w0 === "F" && i0 === "F" && +was.slice(1) && +is.slice(1) && was !== is) eps.push(id);
    }
    const n = fin.length + start.length + both.length + eps.length; if (!n) continue;
    const T = row.len; let m, S = 0, E = 0, kind = "";
    if ((m = T.match(/^(\d+) Folgen$/))) { S = 1; E = +m[1]; kind = "a"; }
    else if ((m = T.match(/^(\d+) Staffeln · (\d+) Folgen$/))) { S = +m[1]; E = +m[2]; kind = "b"; }
    else if ((m = T.match(/^(\d+) Folgen, läuft gerade$/))) { S = 1; E = +m[1]; kind = "c"; }
    else if (T === "läuft gerade") { S = 1; kind = "d"; }
    else if ((m = T.match(/^(\d+) Staffeln, Staffel \d+ läuft gerade$/))) { S = +m[1]; kind = "e"; }
    let neu = "", grund = "", frage = "";
    if (n === 1 && fin.length && kind === "c") { neu = `${ep(fin[0]) || E} Folgen`; grund = "Staffel ist zu Ende"; }
    else if (n === 1 && fin.length && kind === "d" && ep(fin[0])) { neu = `${ep(fin[0])} Folgen`; grund = "Staffel ist zu Ende"; }
    else if (n === 1 && fin.length && kind === "e") {
      const sum = ch.filter(id => now[id][0] === "F" && tv(id)).reduce((a, id) => a + ep(id), 0);
      if (sum) { neu = `${S} Staffeln · ${sum} Folgen`; grund = "Staffel ist zu Ende"; frage = "Folgenzahl ist von AniList zusammengezählt – mit Crunchyroll vergleichen"; }
    }
    else if (n === 1 && start.length && (kind === "a" || kind === "b") && tv(start[0]) && (!ep(start[0]) || ep(start[0]) >= 6)) {
      neu = `${S + 1} Staffeln, Staffel ${S + 1} läuft gerade`; grund = "neue Staffel ist gestartet"; frage = "Läuft die neue Staffel auf Crunchyroll Deutschland? Auf Deutsch?";
    }
    else if (n === 1 && both.length && (kind === "a" || kind === "b") && tv(both[0]) && ep(both[0]) >= 6 && recent(both[0])) {
      neu = `${S + 1} Staffeln · ${E + ep(both[0])} Folgen`; grund = "neue Staffel ist gelaufen"; frage = "Ist die neue Staffel auf Crunchyroll Deutschland? Auf Deutsch?";
    }
    if (neu && neu !== T) { l[k] = neu; auto.push({ k, alt: T, neu, grund }); if (frage) pruefen.push({ k, text: T, neu, grund: frage }); continue; }
    const what = [];
    fin.forEach(id => what.push(`Staffel bei AniList beendet (${ep(id) || "?"} Folgen)`));
    start.forEach(id => what.push(`neue Staffel gestartet (${M[id].format || "?"}${ep(id) ? ", " + ep(id) + " Folgen" : ""})`));
    both.forEach(id => what.push(`neuer Eintrag bei AniList, schon beendet (${M[id].format || "?"}, ${ep(id) || "?"} Folgen)`));
    eps.forEach(id => what.push(`Folgenzahl bei AniList geändert: ${b.st[id].slice(1)} → ${ep(id)}`));
    pruefen.push({ k, text: T, grund: what.join("; ") });
  }
  return { l, auto, pruefen };
}

(async () => {
  const ids = loadIds(), keys = Object.keys(ids);
  const F = "id idMal status format episodes nextAiringEpisode{airingAt episode} startDate{year month day} relations{edges{relationType(version:2) node{id type format status}}}";
  const M = {};
  const page = async (arg, list) => {
    for (let i = 0; i < list.length; i += 40) {
      const js = await gql(`query{Page(perPage:50){media(${arg}:[${list.slice(i, i + 40)}],type:ANIME){${F}}}}`);
      js.data.Page.media.forEach(x => { M[x.id] = x; });
    }
  };
  await page("idMal_in", [...new Set(Object.values(ids))]);
  const byMal = {}; Object.values(M).forEach(x => { if (x.idMal) byMal[x.idMal] = x.id; });
  const found = keys.filter(k => byMal[ids[k]]).length;
  if (found < keys.length * 0.9) throw new Error(`Nur ${found} von ${keys.length} Titeln gefunden – news.json bleibt, wie sie ist`);

  // Fortsetzungen verfolgen (nur Serien, keine Filme)
  const OKF = ["TV", "TV_SHORT", "ONA"], chain = {};
  for (const k of keys) { const root = byMal[ids[k]]; if (root && M[root].format !== "MOVIE") chain[k] = [root]; }
  for (let hop = 0; hop < 10; hop++) {
    const want = new Set();
    for (const ch of Object.values(chain)) {
      for (let p = 0; p < ch.length; p++) {
        const x = M[ch[p]]; if (!x) continue;
        for (const e of (x.relations && x.relations.edges) || []) if (e.relationType === "SEQUEL" && e.node.type === "ANIME" && OKF.includes(e.node.format) && !ch.includes(e.node.id)) ch.push(e.node.id);
      }
      ch.forEach(id => { if (!M[id]) want.add(id); });
    }
    if (!want.size) break;
    await page("id_in", [...want]);
    want.forEach(id => { if (!M[id]) M[id] = { id, status: "?", relations: { edges: [] } }; });
  }

  const w = {}, m = {};
  for (const k of keys.sort()) {
    const ch = chain[k]; if (!ch) continue;
    const act = ch.filter(id => M[id].status === "RELEASING" || M[id].status === "NOT_YET_RELEASED");
    if (!act.length) continue;
    w[k] = act.map(id => id === ch[0] ? -id : id);
    for (const id of act) {
      const x = M[id], n = x.nextAiringEpisode, s = x.startDate || {};
      m[id] = [x.status === "RELEASING" ? 1 : 2, n ? n.airingAt : 0, n ? n.episode : 0, s.year || 0, s.month || 0, s.day || 0, x.episodes || 0];
    }
  }
  // Abgleich der Längenangaben
  const basePath = path.join(__dirname, "len-base.json"), t = Math.floor(Date.now() / 1000);
  let base = {}; try { base = JSON.parse(fs.readFileSync(basePath, "utf8")); } catch (e) {}
  const rows = loadRows(), had = Object.keys(base).length;
  const chk = lenCheck(keys, rows, chain, M, base, Date.now());
  Object.keys(base).forEach(k => { if (!rows[k]) delete base[k]; });
  const ord = {}; Object.keys(base).sort().forEach(k => { ord[k] = base[k]; });
  fs.writeFileSync(basePath, JSON.stringify(ord).replace(/\},"/g, '},\n"') + "\n");
  fs.writeFileSync(path.join(ROOT, "check.json"), JSON.stringify({ t, serien: Object.keys(ord).length, auto: chk.auto, pruefen: chk.pruefen }, null, 1) + "\n");
  fs.writeFileSync(path.join(ROOT, "news.json"), JSON.stringify({ t, w, m, l: chk.l }) + "\n");
  console.log(`${keys.length} Titel, ${found} gefunden, ${Object.keys(M).length} Staffeln geprüft, ${Object.keys(w).length} Titel mit Neuigkeiten`);
  console.log(`Abgleich: ${Object.keys(ord).length} Serien (${Object.keys(ord).length - had} neu festgehalten), ${chk.auto.length} automatisch angepasst, ${chk.pruefen.length} zu prüfen`);
})().catch(e => { console.error(e.message || e); process.exit(1); });
