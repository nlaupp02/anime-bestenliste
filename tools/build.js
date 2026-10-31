// Baut die ausgelieferte index.html aus der lesbaren Quelle: Skript und Stil werden verdichtet (Kommentare, Leerzeichen raus),
// Namen von Funktionen und Variablen auf oberster Ebene bleiben erhalten (die Tests und das Artifact greifen darauf zu).
// Aufruf: node build.js <quelle> <ziel>
const fs = require("fs"), { minify: minJs } = require("terser"), { minify: minCss } = require("csso");
const [src, dst] = process.argv.slice(2);
let s = fs.readFileSync(src, "utf8");
const before = s.length;
(async () => {
  // Skripte (ohne externe src)
  const scripts = [...s.matchAll(/<script>([\s\S]*?)<\/script>/g)];
  for (const m of scripts) {
    const r = await minJs(m[1], {
      ecma: 2020, toplevel: false, module: false,
      compress: { passes: 2, drop_console: false, keep_fargs: true, unsafe: false, directives: false, inline: 1, reduce_vars: true, sequences: false, join_vars: false },
      mangle: { toplevel: false, keep_classnames: true },
      format: { comments: false, ascii_only: false, ecma: 2020 }
    });
    if (r.error) throw r.error;
    s = s.replace(m[0], () => "<script>" + r.code + "</script>");
  }
  // Stile: ohne Umstrukturierung (Reihenfolge der Regeln bleibt, damit nichts anders überdeckt)
  const styles = [...s.matchAll(/<style>([\s\S]*?)<\/style>/g)];
  for (const m of styles) {
    const r = minCss(m[1], { restructure: false, comments: false });
    // csso macht aus „0px“ ein „0“, auch im Ersatzwert von env(): In calc() ist ein nacktes 0 aber ungültig (Zahl statt Länge). Zurück auf 0px
    const css = r.css.replace(/env\((safe-area-inset-[a-z]+),0\)/g, "env($1,0px)");
    s = s.replace(m[0], () => "<style>" + css + "</style>");
  }
  // HTML-Kommentare raus (nicht in Skript/Stil, die sind schon verdichtet)
  s = s.replace(/<!--(?!\[)[\s\S]*?-->\n?/g, "");
  fs.writeFileSync(dst, s);
  console.log(`build: ${before} → ${s.length} Zeichen (${Math.round(100 - s.length / before * 100)} % kleiner)`);
})().catch(e => { console.error(e); process.exit(1); });
