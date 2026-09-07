import { createRequire as ncRequire } from "node:module"; const require = ncRequire(import.meta.url);

// device/nanocode-daemon.mjs
import { spawn } from "node:child_process";
var [sshd, config] = process.argv.slice(2);
if (!sshd || !config) throw new Error("Missing sshd configuration");
var child = spawn(sshd, ["-D", "-e", "-f", config], { stdio: ["ignore", "ignore", "inherit"] });
var stopping = false;
var deadline;
var stop = () => {
  if (stopping) return;
  stopping = true;
  child.kill("SIGTERM");
  deadline = setTimeout(() => child.kill("SIGKILL"), 5e3);
};
process.stdin.resume();
process.stdin.once("end", stop);
process.stdin.once("error", stop);
for (const signal of ["SIGTERM", "SIGINT", "SIGHUP"]) process.once(signal, stop);
child.once("error", () => {
  clearTimeout(deadline);
  process.exit(1);
});
child.once("exit", (code) => {
  clearTimeout(deadline);
  process.exit(stopping ? 0 : code ?? 1);
});
