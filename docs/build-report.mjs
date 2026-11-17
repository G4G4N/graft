// Inline docs/data/*.json into the report template → docs/graft-swarm-report.html
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
const here = dirname(fileURLToPath(import.meta.url));
const safe = (s) => s.replace(/</g, "\\u003c");
const version = /VERSION = "([^"]+)"/.exec(readFileSync(join(here, "../src/version.ts"), "utf8"))[1];
const tpl = readFileSync(join(here, "report.template.html"), "utf8").replace(/__VERSION__/g, version);
const out = tpl
  .replace("__RESULTS__", () => {
    const d = JSON.parse(readFileSync(join(here, "data/results.json"), "utf8"));
    try {
      d.agentRuns = JSON.parse(readFileSync(join(here, "data/agent-runs.json"), "utf8"));
    } catch {}
    return safe(JSON.stringify(d));
  })
  .replace("__BUGS__", () => safe(JSON.stringify(JSON.parse(readFileSync(join(here, "data/bugs.json"), "utf8")))));
writeFileSync(join(here, "graft-swarm-report.html"), out);
console.log(`docs/graft-swarm-report.html (${(out.length / 1024).toFixed(0)} KB)`);
