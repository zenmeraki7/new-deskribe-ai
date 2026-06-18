import { spawn } from "node:child_process";

const isWindows = process.platform === "win32";

function run(name, command, args) {
  const child = spawn(command, args, {
    stdio: "inherit",
    shell: isWindows,
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
  run("web", "npm", ["run", "start"]),
  run("worker", "npm", ["run", "worker:generation"]),
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
