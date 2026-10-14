# mini-claude-code

**A working Claude Code clone in 98 lines of TypeScript.** One file: [src/agent.ts](src/agent.ts).

![The agent fixes the bug in example/ and the tests go green](demo/demo.gif)

Give it a task, and it explores your repo, runs your tests, edits files, and re-runs until they pass. Every write and every shell command asks you first.

## What's in the 98 lines

| Component  | How it works |
|------------|--------------|
| Loop       | `while` loop: call the model, run every `tool_use`, send back `tool_result`s, repeat until the model stops calling tools (max 50 turns). |
| Tools      | `read_file` (line-numbered), `write_file` (whole-file overwrite, one file per call), `run_shell` (120s timeout). Long outputs keep their head and tail. |
| Permission | `write_file` shows the line count change and `run_shell` shows the command; each asks `y/N`. A "no" goes back to the model, which asks you what to do instead. |
| Context    | Over `MCC_MAX_CONTEXT_CHARS` (default 120k chars), the oldest tool outputs are blanked first, so tool calls and results stay paired. |
| Backend    | The Messages API if `ANTHROPIC_API_KEY` is set. Otherwise `claude -p` on your Claude subscription login, with Claude Code's built-in tools, MCP servers and settings turned off; the model asks for tools in fenced ```` ```tool ```` JSON blocks, parsed into the same tool calls. |
| REPL       | Task from the command line, then a `>` prompt for follow-ups. A failed model call is rolled back so the conversation stays valid. |

Not included: MCP, subagents, sandbox, streaming, diffs, multi-file edits.

## Quick start

```bash
npm install
cd example && node ../src/agent.ts "fix the failing tests"
```

With no `ANTHROPIC_API_KEY`, this uses your Claude subscription through the [Claude Code](https://code.claude.com) CLI. Install it and run `claude` once to log in.
To use an API key instead, `export ANTHROPIC_API_KEY=sk-ant-...`.

Subscription use is for your own personal use. Anthropic doesn't allow apps to offer Claude.ai login to other users; see the [Claude Code legal and compliance page](https://code.claude.com/docs/en/legal-and-compliance).

Node 22.18+ or 24+ runs the `.ts` file directly. With no argument it opens a `>` prompt; type `exit` to quit.
Env: `MCC_MODEL` (default `claude-opus-5-5`), `MCC_MAX_CONTEXT_CHARS`.

## Try it

`example/` has an off-by-one bug in `sum()`, so 2 of its 3 tests fail.

```bash
cd example
npm test                                      # pass 1, fail 2
node ../src/agent.ts "fix the failing tests"  # answer y to each prompt
npm test                                      # pass 3, fail 0
git checkout .                                # put the bug back
```

Also try:
- Answer `n` to a prompt. The agent stops and asks what to do instead.
- Run with `MCC_MAX_CONTEXT_CHARS=2000` on a longer task to see old tool outputs replaced with `[old tool output removed to save context]`.
- Run it from inside your own repo: `node /path/to/src/agent.ts "fix the failing tests"`. Use a repo you can reset, since it overwrites files after you approve.
