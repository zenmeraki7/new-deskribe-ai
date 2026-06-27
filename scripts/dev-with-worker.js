import { spawn } from "node:child_process";
import path from "node:path";

const root = process.cwd();
const isWindows = process.platform === "win32";

function bin(name) {
  return path.join(root, "node_modules", ".bin", `${name}${isWindows ? ".cmd" : ""}`);
}

const processes = [
  {
    name: "web",
    command: bin("remix"),
    args: ["vite:dev"],
  },
  {
    name: "worker",
    command: bin("tsx"),
    args: ["app/worker/start-generation-worker.ts"],
  },
];

const children = processes.map(({ name, command, args }) => {
  const child = spawn(command, args, {
    cwd: root,
    env: process.env,
    stdio: "inherit",
    shell: isWindows,
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
