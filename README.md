# mini claude code

A ~280-line CLI coding agent in one file: [src/agent.ts](src/agent.ts).

![The agent fixes the bug in example/ and the tests go green](demo/demo.gif)

| Component  | How it works |
|------------|--------------|
| Loop       | `while` loop: call the model → run every `tool_use` → send back `tool_result`s → repeat until the model stops calling tools (max 50 turns). |
| Tools      | `read_file`, `write_file` (whole-file overwrite, one file per call), `run_shell` (120s timeout). |
| Context    | Over `MCC_MAX_CONTEXT_CHARS` (default 120k chars), the oldest tool outputs are blanked first. |
| Backend    | Uses the Messages API if `ANTHROPIC_API_KEY` is set. Otherwise it runs `claude -p` on your Claude subscription login, with Claude Code's built-in tools, MCP servers and settings turned off. The model then asks for tools in fenced ```` ```tool ```` JSON blocks, which are parsed into the same tool calls the loop already handles. |
| Permission | `write_file` shows a diff and `run_shell` shows the command; each asks `y/N` before running. |

Not included: MCP, subagents, sandbox, streaming, multi-file edits.

## Run

```bash
npm install
cd example && node ../src/agent.ts "fix the failing tests"
```

With no `ANTHROPIC_API_KEY`, this uses your Claude subscription through the [Claude Code](https://code.claude.com) CLI. Install it and run `claude` once to log in.
To use an API key instead, `export ANTHROPIC_API_KEY=sk-ant-...`.

Subscription use is for your own personal use. Anthropic doesn't allow apps to offer Claude.ai login to other users; see the [Claude Code legal and compliance page](https://code.claude.com/docs/en/legal-and-compliance).

Node 24+ runs the `.ts` file directly. With no argument it opens a `>` prompt; type `exit` to quit.
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
- Run with `MCC_MAX_CONTEXT_CHARS=2000` to see old tool outputs dropped (`[context] dropped an old tool output`).
- Run it from inside your own repo: `node /path/to/src/agent.ts "fix the failing tests"`. Use a repo you can reset, since it overwrites files after you approve.
