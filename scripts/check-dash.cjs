const fs = require("fs");
const path = process.argv[2] || "src/dashboard.ts";
const src = fs.readFileSync(path, "utf8");
const i = src.indexOf(String.fromCharCode(96));
const j = src.lastIndexOf(String.fromCharCode(96));
if (i < 0 || j <= i) { console.log("NO TEMPLATE FOUND"); process.exit(2); }
const tpl = src.slice(i, j + 1);
let cooked;
try { cooked = eval(tpl); } catch (e) { console.log("TEMPLATE EVAL ERROR: " + e.message); process.exit(1); }
const s = cooked.indexOf("<script>");
const e = cooked.lastIndexOf("</script>");
const code = cooked.slice(s + 8, e);
try {
  new Function(code);
  console.log("COOKED SYNTAX OK (" + code.length + " chars)");
} catch (err) {
  console.log("COOKED SYNTAX ERROR: " + err.message);
  process.exit(1);
}