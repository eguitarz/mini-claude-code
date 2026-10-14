#!/usr/bin/env node
// Mini Claude Code (compact). Backend: Messages API if ANTHROPIC_API_KEY is set, else `claude -p`.
import Anthropic from "@anthropic-ai/sdk";
import type { MessageParam, Tool } from "@anthropic-ai/sdk/resources/messages";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { createInterface } from "node:readline/promises";

const MODEL = process.env.MCC_MODEL ?? "claude-opus-5-5";
const MAX_CONTEXT = Number(process.env.MCC_MAX_CONTEXT_CHARS ?? 120_000);
const CWD = process.cwd(), USE_API = Boolean(process.env.ANTHROPIC_API_KEY);
const rl = createInterface({ input: process.stdin, output: process.stdout });
type Call = { type: "tool_use"; id: string; name: string; input: Record<string, string> };
type Block = { type: "text"; text: string } | Call;
const tool = (name: string, description: string, ...args: string[]): Tool => ({ name, description,
  input_schema: { type: "object", properties: Object.fromEntries(args.map((a) => [a, { type: "string" }])), required: args } });
const tools = [tool("read_file", "Read a text file; returns contents with 1-based line numbers.", "path"),
  tool("write_file", "Overwrite ONE file with its complete new contents. read_file first.", "path", "content"),
  tool("run_shell", "Run a shell command in the working dir. Returns exit code, stdout, stderr. 120s timeout.", "command")];
const SYSTEM = `You are a coding agent in ${CWD}. To fix bugs: find the test command, run tests, read the source,
fix the root cause with write_file (not the tests unless they are wrong), re-run until green. End with a short summary.`;
const PROTOCOL = `\nTo call tools, end your reply with fenced blocks like:\n\`\`\`tool\n{"name": "run_shell", "input": {"command": "npm test"}}\n\`\`\`
Tools:\n${tools.map((t) => `- ${t.name}: ${t.description}`).join("\n")}
Results come back in <tool_result> tags. Reply with no tool block when done. Write only your next assistant turn.`;
const clip = (s: string, max = 20_000) => s.length <= max ? s : `${s.slice(0, max / 2)}\n... [${s.length - max} chars clipped] ...\n${s.slice(-max / 2)}`;
const ask = async (q: string) => (await rl.question(`${q} [y/N] `)).trim().toLowerCase().startsWith("y");
async function runTool({ name, input }: Call): Promise<[string, boolean]> {
  const path = resolve(CWD, input.path ?? "");
  if (name === "read_file") return !existsSync(path) ? [`File not found: ${input.path}`, true]
    : [clip(readFileSync(path, "utf8").split("\n").map((l, i) => `${String(i + 1).padStart(5)}  ${l}`).join("\n")), false];
  if (name === "write_file") {
    const before = existsSync(path) ? readFileSync(path, "utf8").split("\n").length : "new";
    if (!(await ask(`Write ${input.path} (${before} -> ${input.content.split("\n").length} lines)?`))) return ["User denied the write. Ask what to do instead.", true];
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, input.content);
    return [`Wrote ${input.content.length} chars to ${input.path}`, false];
  }
  if (name === "run_shell") {
    if (!(await ask(`Run \`${input.command}\`?`))) return ["User denied the command. Ask what to do instead.", true];
    const r = spawnSync(input.command, { shell: true, cwd: CWD, encoding: "utf8", timeout: 120_000, maxBuffer: 10 << 20 });
    const out = `${r.error ? `error: ${r.error.message}` : `exit code: ${r.status}`}\n--- stdout ---\n${r.stdout ?? ""}\n--- stderr ---\n${r.stderr ?? ""}`;
    console.log(clip(out, 1500));
    return [clip(out), r.status !== 0];
  }
  return [`Unknown tool: ${name}`, true];
}
// Over budget: blank the oldest tool outputs first; the tool_result blocks stay so pairs stay valid.
function trimContext(messages: MessageParam[]) {
  for (const m of messages) for (const b of typeof m.content === "string" ? [] : m.content) {
    if (JSON.stringify(messages).length <= MAX_CONTEXT) return;
    if (b.type === "tool_result") b.content = "[old tool output removed to save context]";
  }
}
async function callModel(messages: MessageParam[]): Promise<Block[]> {
  if (USE_API) {
    const res = await new Anthropic().messages.create({ model: MODEL, max_tokens: 8192, system: SYSTEM, tools, messages });
    return res.content.filter((b) => b.type === "text" || b.type === "tool_use") as Block[];
  }
  const render = (b: any) => b.type === "text" ? `<assistant>\n${b.text}\n</assistant>` : b.type === "tool_result"
    ? `<tool_result>\n${b.content}\n</tool_result>` : `<assistant>\n\`\`\`tool\n${JSON.stringify({ name: b.name, input: b.input })}\n\`\`\`\n</assistant>`;
  const transcript = messages.flatMap((m) => typeof m.content === "string" ? [`<user>\n${m.content}\n</user>`] : m.content.map(render)).join("\n\n");
  const args = ["-p", "--output-format", "json", "--model", MODEL, "--system-prompt", SYSTEM + PROTOCOL, "--tools", "", "--strict-mcp-config", "--setting-sources", "", "--no-session-persistence"];
  const r = spawnSync("claude", args, { input: transcript, encoding: "utf8", maxBuffer: 50 << 20 });
  const out = (() => { try { return JSON.parse(r.stdout); } catch { return {}; } })();
  if (r.error || out.is_error || typeof out.result !== "string") throw new Error(`claude -p failed: ${r.error?.message || r.stderr || r.stdout}`);
  const fence = /```tool\s*\n([\s\S]*?)\n```/g, text = out.result.split("```tool")[0].replace(/<\/?assistant>/g, "").trim();
  const parse = (json: string) => { try { return JSON.parse(json); } catch { return { name: "invalid_tool_call", input: { raw: json } }; } };
  const calls = [...out.result.matchAll(fence)].map(([, json], i): Block => ({ type: "tool_use", id: `toolu_${i}_${Date.now()}`, ...parse(json) }));
  return text ? [{ type: "text", text }, ...calls] : calls;
}
async function agent(messages: MessageParam[]) {
  for (let turn = 0; turn < 50; turn++) {
    trimContext(messages);
    const content = await callModel(messages);
    messages.push({ role: "assistant", content });
    content.forEach((b) => b.type === "text" && console.log(`\n${b.text}\n`));
    const calls = content.filter((b): b is Call => b.type === "tool_use");
    if (!calls.length) return;
    const results: [string, boolean][] = [];
    for (const call of calls) results.push(await runTool(call).catch((e): [string, boolean] => [`Tool failed: ${e.message}`, true]));
    messages.push({ role: "user", content: calls.map((c, i) => ({ type: "tool_result", tool_use_id: c.id, content: results[i][0], is_error: results[i][1] })) });
  }
  console.log("Stopped after 50 turns.");
}
const messages: MessageParam[] = [];
let task = process.argv.slice(2).join(" ").trim();
console.log(`mini claude code · ${MODEL} via ${USE_API ? "API key" : "claude -p"} · ${CWD}`);
while (true) {
  const input = task || (await rl.question("> ")).trim();
  task = "";
  if (input === "exit" || input === "quit") break;
  if (!input) continue;
  const checkpoint = messages.length; // on error, roll back the failed turn so the conversation stays valid
  messages.push({ role: "user", content: input });
  await agent(messages).catch((e) => { console.error(`API error: ${e.message}`); messages.length = checkpoint; });
}
rl.close();
