// Generate the Firefox update manifest (updates.json) for self-hosted
// auto-updates. Firefox polls the URL in manifest.json's
// browser_specific_settings.gecko.update_url and installs the newest
// applicable version listed here.
//
// Usage: node scripts/make-updates.mjs <xpiPath> <owner/repo> <tag> <outPath>
import { readFileSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { basename } from "node:path";

const [, , xpiPath, repo, tag, outPath] = process.argv;
if (!xpiPath || !repo || !tag || !outPath) {
  console.error("usage: make-updates.mjs <xpiPath> <owner/repo> <tag> <outPath>");
  process.exit(1);
}

const manifest = JSON.parse(readFileSync("manifest.json", "utf8"));
const gecko = manifest.browser_specific_settings.gecko;
const hash = "sha256:" + createHash("sha256").update(readFileSync(xpiPath)).digest("hex");
const updateLink = `https://github.com/${repo}/releases/download/${tag}/${basename(xpiPath)}`;

const doc = {
  addons: {
    [gecko.id]: {
      updates: [
        {
          version: manifest.version,
          update_link: updateLink,
          update_hash: hash,
          applications: { gecko: { strict_min_version: gecko.strict_min_version } },
        },
      ],
    },
  },
};

writeFileSync(outPath, JSON.stringify(doc, null, 2) + "\n");
console.log(JSON.stringify(doc, null, 2));
