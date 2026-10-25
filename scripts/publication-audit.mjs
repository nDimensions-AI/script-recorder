// Copyright (c) 2026 nDimensions.AI and CharanTheAiGuy
// SPDX-License-Identifier: MIT
import { execFileSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const retiredPackages = [
  "@github/copilot",
  "@github/copilot-sdk",
  "@xterm/xterm",
  "@xterm/addon-fit",
  "node-pty",
  "koffi",
  "get-windows",
];
export function inspectPublicationFile(filename, bytes) {
  const problems = [];
  const normalized = filename.replaceAll("\\", "/");
  if (
    /^(?:node_modules|dist|dist-electron|release|artifacts|\.compliance[^/]*)(?:\/|$)/.test(
      normalized,
    )
  )
    problems.push("generated or local-only directory");
  if (
    /(?:^|\/)(?:\.env(?:\..*)?|provider\.json|\.npmrc)$|\.(?:sqlite(?:-.*)?|db(?:-.*)?|webm|wav|mp4|onnx|pem|pfx|p12)$/i.test(
      normalized,
    )
  )
    problems.push("local data or credential file");
  if (bytes.length > 10 * 1024 * 1024) problems.push("oversized source file");
  if (!bytes.subarray(0, 8192).includes(0)) {
    const text = bytes.toString("utf8");
    const patterns = [
      ["Google dotted key", /\bAQ\.[A-Za-z0-9_-]{20,}\b/],
      ["Google API key", /\bAIza[A-Za-z0-9_-]{35}\b/],
      [
        "GitHub token",
        /\b(?:gh[pousr]_[A-Za-z0-9]{36,}|github_pat_[A-Za-z0-9_]{40,})\b/,
      ],
      [
        "private key",
        /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----\s+[A-Za-z0-9+/=\s]{100,}/,
      ],
      ["embedded URL credential", /https?:\/\/[^\s/:@]+:[^\s/@]+@[^\s/]+/],
    ];
    // Structured scanner fixtures are constructed from separate strings in tests.
    for (const [label, pattern] of patterns)
      if (pattern.test(text)) problems.push(label);
  }
  return problems;
}

export function auditPublication(root) {
  const files = execFileSync("git", ["ls-files", "--cached", "-z"], {
    cwd: root,
    encoding: "utf8",
    windowsHide: true,
  })
    .split("\0")
    .filter(Boolean);
  if (!files.length)
    throw new Error(
      "Stage the intended source files before the publication audit.",
    );
  const failures = [];
  let totalBytes = 0;
  for (const file of files) {
    const mode = execFileSync("git", ["ls-files", "--stage", "--", file], {
      cwd: root,
      encoding: "utf8",
      windowsHide: true,
    }).slice(0, 6);
    if (mode !== "100644" && mode !== "100755")
      failures.push({ file, rules: ["links or submodules require review"] });
    const bytes = execFileSync("git", ["show", ":" + file], {
      cwd: root,
      windowsHide: true,
      maxBuffer: 12 * 1024 * 1024,
    });
    totalBytes += bytes.length;
    const rules = inspectPublicationFile(file, bytes);
    if (rules.length) failures.push({ file, rules });
  }
  const pkg = JSON.parse(
    execFileSync("git", ["show", ":package.json"], {
      cwd: root,
      encoding: "utf8",
      windowsHide: true,
    }),
  );
  const lock = JSON.parse(
    execFileSync("git", ["show", ":package-lock.json"], {
      cwd: root,
      encoding: "utf8",
      windowsHide: true,
    }),
  );
  for (const name of retiredPackages) {
    if (
      pkg.dependencies?.[name] ||
      Object.keys(lock.packages).some((p) => p.endsWith("node_modules/" + name))
    )
      failures.push({
        file: "package-lock.json",
        rules: ["retired dependency: " + name],
      });
  }
  for (const notice of [
    "LICENSE",
    "third_party/licenses/microsoft-skill-recorder.txt",
    "third_party/licenses/openai-whisper.txt",
    "THIRD-PARTY-NOTICES.md",
  ]) {
    if (!files.includes(notice))
      failures.push({ file: notice, rules: ["required license missing"] });
  }
  if (failures.length) throw new Error(JSON.stringify({ failures }, null, 2));
  return {
    files: files.length,
    totalBytes,
    credentialFindings: 0,
    retiredDependencies: 0,
  };
}

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  console.log(JSON.stringify(auditPublication(process.cwd()), null, 2));
}
