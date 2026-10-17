#!/usr/bin/env node
// Thin launcher: runs the Python MCP server from PyPI so that
// `npx -y google-ai-scraper` works in any MCP client config.
// The npm version always matches the PyPI version it launches.
const { spawn } = require("node:child_process");
const { version } = require("../package.json");

const spec = /^\d/.test(version) && !version.includes("-")
  ? `google-ai-scraper==${version}`
  : "google-ai-scraper";
const args = process.argv.slice(2);

const runners = [
  ["uvx", ["--from", spec, "google-ai-scraper", ...args]],
  ["pipx", ["run", "--spec", spec, "google-ai-scraper", ...args]],
];

function run(index) {
  if (index >= runners.length) {
    console.error(
      "google-ai-scraper needs uv (https://docs.astral.sh/uv/) or pipx to run the Python server.\n" +
        "Install uv, then retry."
    );
    process.exit(127);
  }
  const [cmd, cmdArgs] = runners[index];
  const child = spawn(cmd, cmdArgs, { stdio: "inherit" });
  child.on("error", (err) => {
    if (err.code === "ENOENT") return run(index + 1);
    console.error(`Failed to start ${cmd}: ${err.message}`);
    process.exit(1);
  });
  for (const sig of ["SIGINT", "SIGTERM"]) {
    process.on(sig, () => child.kill(sig));
  }
  child.on("exit", (code, signal) => {
    process.exit(code ?? (signal ? 1 : 0));
  });
}

run(0);
