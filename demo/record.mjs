// Records demo/demo.gif: types the commands, runs the real agent on a fresh copy of example/, answers y at each prompt.
// It runs from /tmp/mini-claude-code so the GIF doesn't show your home directory.
// Re-record from the repo root:
//   asciinema rec --overwrite --headless --window-size 100x30 -i 1.5 -c "node demo/record.mjs" demo/demo.cast
//   agg --theme monokai --font-size 16 --last-frame-duration 6 demo/demo.cast demo/demo.gif
import { execSync, spawn } from "node:child_process";
import { cpSync, rmSync, symlinkSync } from "node:fs";
import { fileURLToPath } from "node:url";

const repo = fileURLToPath(new URL("..", import.meta.url));
const root = "/tmp/mini-claude-code";
rmSync(root, { recursive: true, force: true });
for (const f of ["src", "example", "package.json"]) cpSync(`${repo}/${f}`, `${root}/${f}`, { recursive: true });
symlinkSync(`${repo}/node_modules`, `${root}/node_modules`);
const cwd = `${root}/example`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const out = (s) => process.stdout.write(s);

async function type(text) {
  out("\x1b[32m$\x1b[0m ");
  for (const ch of text) { out(ch); await sleep(30); }
  await sleep(400);
  out("\r\n");
}

async function shell(cmd) {
  await type(cmd);
  out(execSync(cmd, { cwd, encoding: "utf8", shell: "/bin/bash" }).replace(/\n/g, "\r\n"));
  await sleep(1500);
}

async function agent(task) {
  await type(`node ../src/agent.ts "${task}"`);
  const p = spawn("node", ["../src/agent.ts", task], { cwd, env: { ...process.env, ANTHROPIC_API_KEY: "" } });
  let buf = "";
  const answer = async (text) => { buf = ""; await sleep(800); out(`${text}\r\n`); p.stdin.write(`${text}\n`); };
  p.stdout.on("data", (d) => {
    const s = d.toString();
    out(s.replace(/\n/g, "\r\n"));
    buf += s;
    if (/\[y\/N\] (\x1b\[0m)?$/.test(buf)) answer("y");
    else if (/> (\x1b\[0m)?$/.test(buf)) answer("exit");
  });
  p.stderr.on("data", (d) => out(d.toString()));
  await new Promise((r) => p.on("exit", r));
}

const summary = "npm test 2>&1 | grep -E '^ℹ (pass|fail)'";
await shell(summary);
await agent("run npm test, fix the bug, then run npm test again");
await shell(summary);
rmSync(root, { recursive: true, force: true });
