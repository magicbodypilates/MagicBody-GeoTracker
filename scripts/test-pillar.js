/* eslint-disable no-console */
const fs = require("node:fs");
const path = require("node:path");

const pillar = Number(process.argv[2] || "0");
const root = process.cwd();

const requiredByPillar = {
  1: ["components/sovereign-dashboard.tsx"],
  2: ["components/sovereign-dashboard.tsx"],
  3: ["components/sovereign-dashboard.tsx"],
  4: ["components/sovereign-dashboard.tsx"],
  5: ["components/sovereign-dashboard.tsx"],
  6: ["components/sovereign-dashboard.tsx"],
  7: ["components/sovereign-dashboard.tsx"],
  8: ["components/sovereign-dashboard.tsx", "app/api/audit/route.ts"],
};

const targets = requiredByPillar[pillar] || [];
const missing = targets.filter((rel) => !fs.existsSync(path.join(root, rel)));

if (missing.length) {
  console.error(JSON.stringify({ pillar, ok: false, missing }, null, 2));
  process.exit(1);
}

console.log(JSON.stringify({ pillar, ok: true, checked: targets }, null, 2));
