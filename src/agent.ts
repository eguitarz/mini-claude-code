#!/usr/bin/env node
// Minimum Claude Code: a while-loop agent with three tools, a bounded context, and y/n permissions.
// Usage (from inside the repo you want fixed):  node /path/to/src/agent.ts "fix the failing tests"
// Backend: the Messages API if ANTHROPIC_API_KEY is set, otherwise `claude -p` on your Claude subscription.
import Anthropic from "@anthropic-ai/sdk";
import type { MessageParam, Tool, ToolResultBlockParam } from "@anthropic-ai/sdk/resources/messages";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { createInterface } from "node:readline/promises";

const MODEL = process.env.MCC_MODEL ?? "claude-opus-5-5";
const MAX_TOKENS = 8192;
const MAX_CONTEXT_CHARS = Number(process.env.MCC_MAX_CONTEXT_CHARS ?? 120_000); // ~30k tokens
const MAX_TOOL_OUTPUT_CHARS = 20_000;
const MAX_TURNS = 50;
const CWD = process.cwd();
const USE_API = Boolean(process.env.ANTHROPIC_API_KEY);

const c = { dim: "\x1b[2m", cyan: "\x1b[36m", yellow: "\x1b[33m", red: "\x1b[31m", green: "\x1b[32m", reset: "\x1b[0m" };
const rl = createInterface({ input: process.stdin, output: process.stdout });

// ---------- tools ----------

const tools: Tool[] = [
  {
    name: "read_file",
    description: "Read a text file. Returns its contents with 1-based line numbers.",
    input_schema: {
      type: "object",
      properties: { path: { type: "string", description: "File path, relative to the working directory." } },
      required: ["path"],
    },
  },
  {
    name: "write_file",
    description:
      "Create or overwrite ONE file with the complete new contents. Always read_file first and send the whole file, not a fragment.",
    input_schema: {
      type: "object",
      properties: {
        path: { type: "string", description: "File path, relative to the working directory." },
        content: { type: "string", description: "The full new file contents." },
      },
      required: ["path", "content"],
    },
  },
  {
    name: "run_shell",
    description:
      "Run a shell command in the working directory (e.g. ls, grep, the test suite). Returns exit code, stdout and stderr. Times out after 120s.",
    input_schema: {
      type: "object",
      properties: { command: { type: "string", description: "The command to run." } },
      required: ["command"],
    },
  },
];

type ToolOutput = { content: string; isError?: boolean };

// Keep the head and the tail: test runners print the failures and summary at the end.
function clip(text: string, max = MAX_TOOL_OUTPUT_CHARS): string {
  if (text.length <= max) return text;
  const half = Math.floor(max / 2);
  return `${text.slice(0, half)}\n... [${text.length - max} chars clipped] ...\n${text.slice(-half)}`;
}

async function askPermission(question: string): Promise<boolean> {
  const answer = await rl.question(`${c.yellow}${question} [y/N] ${c.reset}`);
  return answer.trim().toLowerCase().startsWith("y");
}

function readFile(path: string): ToolOutput {
  const full = resolve(CWD, path);
  if (!existsSync(full)) return { content: `File not found: ${path}`, isError: true };
  const lines = readFileSync(full, "utf8").split("\n");
  return { content: clip(lines.map((l, i) => `${String(i + 1).padStart(5)}  ${l}`).join("\n")) };
}

async function writeFile(path: string, content: string): Promise<ToolOutput> {
  const full = resolve(CWD, path);
  const before = existsSync(full) ? readFileSync(full, "utf8") : null;
  console.log(`${c.cyan}write_file ${path}${c.reset} ${c.dim}(${before === null ? "new file" : `${before.split("\n").length} -> ${content.split("\n").length} lines`})${c.reset}`);
  printDiff(before ?? "", content);
  if (!(await askPermission(`Write ${path}?`))) return { content: "User denied the write. Ask what to do instead.", isError: true };
  mkdirSync(dirname(full), { recursive: true });
  writeFileSync(full, content);
  return { content: `Wrote ${content.length} chars to ${path}` };
}

// A tiny line diff: skip the common prefix/suffix, show what changed in between.
function printDiff(before: string, after: string): void {
  const a = before.split("\n"), b = after.split("\n");
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start++;
  let endA = a.length, endB = b.length;
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) { endA--; endB--; }
  const removed = a.slice(start, endA), added = b.slice(start, endB);
  const show = (lines: string[], sign: string, color: string) =>
    lines.slice(0, 40).forEach((l) => console.log(`${color}${sign} ${l}${c.reset}`));
  if (before) console.log(`${c.dim}@@ line ${start + 1} @@${c.reset}`);
  show(removed, "-", c.red);
  show(added, "+", c.green);
  if (removed.length > 40 || added.length > 40) console.log(`${c.dim}... (diff truncated)${c.reset}`);
}

async function runShell(command: string): Promise<ToolOutput> {
  console.log(`${c.cyan}$ ${command}${c.reset}`);
  if (!(await askPermission("Run this command?"))) return { content: "User denied the command. Ask what to do instead.", isError: true };
  const r = spawnSync(command, { shell: true, cwd: CWD, encoding: "utf8", timeout: 120_000, maxBuffer: 10 * 1024 * 1024 });
  const status = r.error ? `error: ${r.error.message}` : `exit code: ${r.status}`;
  const out = `${status}\n--- stdout ---\n${r.stdout ?? ""}\n--- stderr ---\n${r.stderr ?? ""}`;
  console.log(`${c.dim}${clip(out, 1500)}${c.reset}`);
  return { content: clip(out), isError: r.status !== 0 };
}

async function runTool(call: ToolCall): Promise<ToolOutput> {
  const input = call.input;
  try {
    switch (call.name) {
      case "read_file":
        console.log(`${c.cyan}read_file ${input.path}${c.reset}`);
        return readFile(input.path);
      case "write_file":
        return await writeFile(input.path, input.content);
      case "run_shell":
        return await runShell(input.command);
      default:
        return { content: `Unknown tool: ${call.name}`, isError: true };
    }
  } catch (err) {
    return { content: `Tool failed: ${(err as Error).message}`, isError: true };
  }
}

// ---------- context ----------

const TRUNCATED = "[old tool output removed to save context]";
const size = (messages: MessageParam[]) => JSON.stringify(messages).length;

// When the conversation is over budget, blank the oldest tool outputs first.
// The tool_result blocks stay in place, so every tool_use still has its pair.
function trimContext(messages: MessageParam[]): void {
  for (const msg of messages) {
    if (size(messages) <= MAX_CONTEXT_CHARS) return;
    if (typeof msg.content === "string") continue;
    for (const block of msg.content) {
      if (block.type === "tool_result" && block.content !== TRUNCATED) {
        block.content = TRUNCATED;
        console.log(`${c.dim}[context] dropped an old tool output${c.reset}`);
        if (size(messages) <= MAX_CONTEXT_CHARS) return;
      }
    }
  }
}

// ---------- loop ----------

const SYSTEM = `You are a coding agent working in ${CWD}.
Your tools: read_file, write_file (whole-file overwrite, one file per call), run_shell.
Workflow for fixing bugs:
1. Explore with run_shell (ls, grep, cat package.json) to find the test command.
2. Run the tests to see what fails.
3. Read the relevant source, find the root cause, fix it with write_file. Do not edit tests to make them pass unless the test itself is wrong.
4. Re-run the tests. Repeat until they all pass.
Finish with a short summary of the cause and the fix. Be concise.`;

// ---------- model backends ----------

type ToolCall = { type: "tool_use"; id: string; name: string; input: Record<string, string> };
type Block = { type: "text"; text: string } | ToolCall;

async function callModel(messages: MessageParam[]): Promise<Block[]> {
  return USE_API ? callApi(messages) : callClaudeCli(messages);
}

async function callApi(messages: MessageParam[]): Promise<Block[]> {
  const res = await new Anthropic().messages.create({ model: MODEL, max_tokens: MAX_TOKENS, system: SYSTEM, tools, messages });
  return res.content.flatMap((b): Block[] =>
    b.type === "text" ? [{ type: "text", text: b.text }]
    : b.type === "tool_use" ? [{ type: "tool_use", id: b.id, name: b.name, input: b.input as Record<string, string> }]
    : []);
}

// `claude -p` has no client-side tools, so the model writes ```tool JSON blocks that we parse
// into the same tool_use blocks the API would return. The rest of the loop doesn't know the difference.
const TOOL_PROTOCOL = `
To call tools, end your reply with one or more fenced blocks like this, then stop:
\`\`\`tool
{"name": "run_shell", "input": {"command": "npm test"}}
\`\`\`
Tools:
${tools.map((t) => `- ${t.name}: ${t.description} Input: ${JSON.stringify(t.input_schema.properties)}`).join("\n")}
Results come back in <tool_result> tags. Never write a <tool_result> yourself. Reply with no tool block when you are done.
You get the conversation as a transcript; write only your next assistant turn.`;

function toTranscript(messages: MessageParam[]): string {
  return messages
    .flatMap((m) => {
      if (typeof m.content === "string") return [`<user>\n${m.content}\n</user>`];
      return m.content.map((b) => {
        if (b.type === "text") return `<assistant>\n${b.text}\n</assistant>`;
        if (b.type === "tool_use") return `<assistant>\n\`\`\`tool\n${JSON.stringify({ name: b.name, input: b.input })}\n\`\`\`\n</assistant>`;
        if (b.type === "tool_result") return `<tool_result>\n${b.content}\n</tool_result>`;
        return "";
      });
    })
    .join("\n\n");
}

async function callClaudeCli(messages: MessageParam[]): Promise<Block[]> {
  const args = ["-p", "--output-format", "json", "--model", MODEL, "--system-prompt", SYSTEM + TOOL_PROTOCOL,
    "--tools", "", "--strict-mcp-config", "--setting-sources", "", "--no-session-persistence"];
  const r = spawnSync("claude", args, { input: toTranscript(messages), encoding: "utf8", maxBuffer: 50 * 1024 * 1024 });
  if (r.error) throw new Error(`could not run claude: ${r.error.message}`);
  let out: { result?: string; is_error?: boolean };
  try { out = JSON.parse(r.stdout); } catch { throw new Error(`claude -p failed: ${r.stderr || r.stdout}`); }
  if (out.is_error || typeof out.result !== "string") throw new Error(`claude -p failed: ${out.result ?? r.stdout}`);

  const fence = /```tool\s*\n([\s\S]*?)\n```/g;
  const firstTool = out.result.search(fence);
  const text = (firstTool === -1 ? out.result : out.result.slice(0, firstTool)).replace(/<\/?assistant>/g, "").trim();
  const blocks: Block[] = text ? [{ type: "text", text }] : [];
  for (const [, json] of out.result.matchAll(fence)) {
    const id = `toolu_${blocks.length}_${Date.now()}`;
    try {
      const { name, input } = JSON.parse(json);
      blocks.push({ type: "tool_use", id, name, input });
    } catch {
      blocks.push({ type: "tool_use", id, name: "invalid_tool_call", input: { raw: json } });
    }
  }
  return blocks;
}

async function agent(messages: MessageParam[]): Promise<void> {
  let turns = 0;
  while (turns++ < MAX_TURNS) {
    trimContext(messages);
    const content = await callModel(messages);
    messages.push({ role: "assistant", content });

    for (const block of content) if (block.type === "text") console.log(`\n${block.text}\n`);

    const calls = content.filter((b): b is ToolCall => b.type === "tool_use");
    if (calls.length === 0) return; // model is done (or wants the user)

    const results: ToolResultBlockParam[] = [];
    for (const call of calls) {
      const out = await runTool(call);
      results.push({ type: "tool_result", tool_use_id: call.id, content: out.content, is_error: out.isError });
    }
    messages.push({ role: "user", content: results });
  }
  console.log(`${c.red}Stopped after ${MAX_TURNS} turns.${c.reset}`);
}

async function main(): Promise<void> {
  const messages: MessageParam[] = [];
  let task = process.argv.slice(2).join(" ").trim();
  console.log(`${c.dim}mini claude code · ${MODEL} via ${USE_API ? "API key" : "claude -p (subscription)"} · ${CWD} · ctrl+c to quit${c.reset}`);
  while (true) {
    if (!task) task = (await rl.question(`${c.green}> ${c.reset}`)).trim();
    if (!task) continue;
    if (task === "exit" || task === "quit") break;
    const checkpoint = messages.length;
    messages.push({ role: "user", content: task });
    try {
      await agent(messages);
    } catch (err) {
      console.error(`${c.red}API error: ${(err as Error).message}${c.reset}`);
      messages.length = checkpoint; // roll back the failed turn so the conversation stays valid
    }
    task = "";
  }
  rl.close();
}

main();
