// Läuft einmal am Tag bei GitHub (siehe .github/workflows/news.yml) und schreibt news.json für den News-Reiter der App.
// Fragt bei AniList (frei zugänglich, kein Schlüssel nötig) für alle Titel der Liste nach:
//   - läuft gerade eine Staffel, und wann kommt die nächste Folge?
//   - ist eine neue Staffel angekündigt, und wann startet sie?
// Aufbau von news.json:
//   t: Zeitpunkt des Laufs (Sekunden)
//   w: je Titel (Name wie in der Liste) die AniList-Nummern der laufenden oder angekündigten Staffeln (negativ = der Titel selbst)
//   m: je AniList-Nummer [Status 1 läuft / 2 angekündigt, Zeitpunkt nächste Folge, Folge, Startjahr, -monat, -tag, Folgen gesamt]
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
  fs.writeFileSync(path.join(ROOT, "news.json"), JSON.stringify({ t: Math.floor(Date.now() / 1000), w, m }) + "\n");
  console.log(`${keys.length} Titel, ${found} gefunden, ${Object.keys(M).length} Staffeln geprüft, ${Object.keys(w).length} Titel mit Neuigkeiten`);
})().catch(e => { console.error(e.message || e); process.exit(1); });
