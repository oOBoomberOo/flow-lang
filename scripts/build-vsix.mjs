#!/usr/bin/env node
/**
 * Build a self-contained .vsix for the Flow extension.
 *
 * Stages:  build/vsix/extension/{package.json,extension.js,syntaxes,…}
 *          build/vsix/extension/vendor/{src,stdlib,registry,bin}
 *          build/vsix/{[Content_Types].xml,extension.vsixmanifest}
 * Zips it with PowerShell's Compress-Archive (no npm dependencies).
 */

import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";

const ROOT = path.join(import.meta.dirname, "..");
const EXT = path.join(ROOT, "vscode-extension");
const BUILD = path.join(ROOT, "build");
const STAGE = path.join(BUILD, "vsix");
const OUT = path.join(BUILD, "flow-language.vsix");

function copyDir(from, to) {
  fs.mkdirSync(to, { recursive: true });
  for (const e of fs.readdirSync(from, { withFileTypes: true })) {
    if (e.name === "node_modules" || e.name === "vendor" || e.name === "build") continue;
    const s = path.join(from, e.name);
    const d = path.join(to, e.name);
    if (e.isDirectory()) copyDir(s, d);
    else fs.copyFileSync(s, d);
  }
}

// --- stage ---------------------------------------------------------------
fs.rmSync(STAGE, { recursive: true, force: true });
const extDir = path.join(STAGE, "extension");
copyDir(EXT, extDir);

// the compiler travels with the extension so it works outside the repo
const vendor = path.join(extDir, "vendor");
for (const part of ["src", "stdlib", "registry", "bin"]) {
  copyDir(path.join(ROOT, part), path.join(vendor, part));
}
fs.writeFileSync(
  path.join(extDir, "README.md"),
  fs.readFileSync(path.join(ROOT, "docs", "editor.md"), "utf8"),
);
// keep Node's ESM detection quiet when the bundled compiler is imported
fs.writeFileSync(path.join(vendor, "package.json"), JSON.stringify({ type: "module" }, null, 2) + "\n");

const pkg = JSON.parse(fs.readFileSync(path.join(EXT, "package.json"), "utf8"));

// --- vsix scaffolding ----------------------------------------------------
fs.writeFileSync(
  path.join(STAGE, "[Content_Types].xml"),
  `<?xml version="1.0" encoding="utf-8"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension=".json" ContentType="application/json"/>
  <Default Extension=".js" ContentType="application/javascript"/>
  <Default Extension=".mjs" ContentType="application/javascript"/>
  <Default Extension=".ts" ContentType="text/plain"/>
  <Default Extension=".md" ContentType="text/markdown"/>
  <Default Extension=".flow" ContentType="text/plain"/>
  <Default Extension=".txt" ContentType="text/plain"/>
  <Default Extension=".vsixmanifest" ContentType="text/xml"/>
  <Default Extension=".xml" ContentType="text/xml"/>
</Types>
`,
);

fs.writeFileSync(
  path.join(STAGE, "extension.vsixmanifest"),
  `<?xml version="1.0" encoding="utf-8"?>
<PackageManifest Version="2.0.0" xmlns="http://schemas.microsoft.com/developer/vsx-schema/2011">
  <Metadata>
    <Identity Language="en-US" Id="${pkg.name}" Version="${pkg.version}" Publisher="${pkg.publisher}" />
    <DisplayName>${pkg.displayName}</DisplayName>
    <Description xml:space="preserve">${pkg.description}</Description>
    <Tags>flow,language,tierless,datapack</Tags>
    <Categories>Programming Languages,Linters</Categories>
    <GalleryFlags>Public</GalleryFlags>
    <Properties>
      <Property Id="Microsoft.VisualStudio.Code.Engine" Value="${pkg.engines.vscode}" />
      <Property Id="Microsoft.VisualStudio.Code.ExtensionKind" Value="workspace" />
    </Properties>
  </Metadata>
  <Installation>
    <InstallationTarget Id="Microsoft.VisualStudio.Code" />
  </Installation>
  <Dependencies />
  <Assets>
    <Asset Type="Microsoft.VisualStudio.Code.Manifest" Path="extension/package.json" Addressable="true" />
    <Asset Type="Microsoft.VisualStudio.Services.Content.Details" Path="extension/README.md" Addressable="true" />
  </Assets>
</PackageManifest>
`,
);

// --- zip -----------------------------------------------------------------
fs.rmSync(OUT, { force: true });
const zip = path.join(BUILD, "flow-language.zip");
fs.rmSync(zip, { force: true });
execFileSync("powershell", [
  "-NoProfile", "-Command",
  `Compress-Archive -Path '${STAGE}\\*' -DestinationPath '${zip}' -Force`,
], { stdio: "inherit" });
fs.renameSync(zip, OUT);

console.log(`built ${path.relative(ROOT, OUT)} (${(fs.statSync(OUT).size / 1024).toFixed(0)} KB)`);
