// Prints the CHANGELOG.md section of one version (the lines between `## [X.Y.Z]` and the next
// `## ` heading) for the GitHub Release body. Fails when the section is missing or empty, so the
// publish workflow stops before `npm publish` if the changelog was not updated.
// Usage: node scripts/release-notes.mjs [version]   (defaults to package.json "version")
import { readFileSync } from "node:fs";

const version = process.argv[2] ?? JSON.parse(readFileSync("package.json", "utf8")).version;
const lines = readFileSync("CHANGELOG.md", "utf8").split(/\r?\n/);
const start = lines.findIndex((line) => line.startsWith(`## [${version}]`));
if (start === -1) {
  console.error(`release-notes: CHANGELOG.md has no "## [${version}]" section`);
  process.exit(1);
}
const rest = lines.slice(start + 1);
const end = rest.findIndex((line) => line.startsWith("## ") || /^\[[^\]]+\]: /.test(line));
const notes = (end === -1 ? rest : rest.slice(0, end)).join("\n").trim();
if (!notes) {
  console.error(`release-notes: the "## [${version}]" section of CHANGELOG.md is empty`);
  process.exit(1);
}
console.log(notes);
