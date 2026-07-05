import { spawn } from "node:child_process";
import "dotenv/config";
import { createRequire } from "node:module";
import path from "node:path";

const root = process.cwd();
const require = createRequire(import.meta.url);

function packageBin(packageName, binPath) {
  return path.join(path.dirname(require.resolve(`${packageName}/package.json`)), binPath);
}

const remixCli = packageBin("@remix-run/dev", "dist/cli.js");
const tsxCli = packageBin("tsx", "dist/cli.mjs");

const processes = [
  {
    name: "web",
    command: process.execPath,
    args: [remixCli, "vite:dev"],
  },
  {
    name: "worker",
    command: process.execPath,
    args: [tsxCli, "app/worker/start-generation-worker.ts"],
  },
];

const children = processes.map(({ name, command, args }) => {
  const child = spawn(command, args, {
    cwd: root,
    env: process.env,
    stdio: "inherit",
    shell: false,
  });

  child.on("exit", (code, signal) => {
    if (code === 0 || signal) return;
    console.error(`[${name}] exited with code ${code}`);
    shutdown(code ?? 1);
  });

  return child;
});

let shuttingDown = false;

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
