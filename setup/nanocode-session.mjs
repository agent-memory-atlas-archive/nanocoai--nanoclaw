import { createRequire as ncRequire } from "node:module"; const require = ncRequire(import.meta.url);

// device/nanocode-session.mjs
import { spawn } from "node:child_process";
import path from "node:path";
var root = process.argv[2];
var command = process.env.SSH_ORIGINAL_COMMAND || "list";
var args = command.trim().split(/\s+/);
if (!root || /[\r\n\0]/.test(command) || !["new", "list", "attach"].includes(args[0]) || args.some((a) => /^--?(owner|as|door[-_])/i.test(a))) {
  console.error("nanocode: use new, list, or attach; identity comes from portal login.");
  process.exit(2);
}
var child = spawn(process.execPath, [path.join(root, "dist/cli/client.js"), "sandboxes", ...args], { cwd: root, stdio: "inherit" });
var reset = () => {
  if (process.stdout.isTTY) process.stdout.write("\x1B[?1000l\x1B[?1002l\x1B[?1003l\x1B[?1006l");
};
for (const sig of ["SIGTERM", "SIGHUP", "SIGINT"]) process.on(sig, () => {
  reset();
  child.kill(sig);
});
child.on("error", () => {
  reset();
  process.exit(1);
});
child.on("exit", (code) => {
  reset();
  process.exit(code ?? 1);
});
