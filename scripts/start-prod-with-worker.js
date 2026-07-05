import { spawn } from "node:child_process";
import "dotenv/config";
import { createRequire } from "node:module";
import path from "node:path";

const root = process.cwd();
const require = createRequire(import.meta.url);

function packageBin(packageName, binPath) {
  return path.join(path.dirname(require.resolve(`${packageName}/package.json`)), binPath);
}

const remixServeCli = packageBin("@remix-run/serve", "dist/cli.js");
const tsxCli = packageBin("tsx", "dist/cli.mjs");

function run(name, command, args) {
  const child = spawn(command, args, {
    cwd: root,
    stdio: "inherit",
    shell: false,
    env: process.env,
  });

  child.on("exit", (code, signal) => {
    if (shuttingDown) return;
    if (signal) {
      shutdown(0);
      return;
    }

    console.error(`[${name}] exited with code ${code ?? 1}`);
    shutdown(code ?? 1);
  });

  return child;
}

let shuttingDown = false;
const children = [
  run("web", process.execPath, [remixServeCli, "./build/server/index.js"]),
  run("worker", process.execPath, [tsxCli, "app/worker/start-generation-worker.ts"]),
];

function shutdown(code = 0) {
  if (shuttingDown) return;
  shuttingDown = true;

  for (const child of children) {
    if (!child.killed) child.kill();
  }

  setTimeout(() => process.exit(code), 250);
}

process.on("SIGINT", () => shutdown(0));
process.on("SIGTERM", () => shutdown(0));
