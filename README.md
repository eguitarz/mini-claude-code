# mini claude code

A ~200-line CLI coding agent in one file: [src/agent.ts](src/agent.ts).

| Component  | How it works |
|------------|--------------|
| Loop       | `while` loop: call the model → run every `tool_use` → send back `tool_result`s → repeat until the model stops calling tools (max 50 turns). |
| Tools      | `read_file`, `write_file` (whole-file overwrite, one file per call), `run_shell` (120s timeout). |
| Context    | Over `MCC_MAX_CONTEXT_CHARS` (default 120k chars), the oldest tool outputs are blanked first. |
| Permission | `write_file` shows a diff and `run_shell` shows the command; each asks `y/N` before running. |

Not included: MCP, subagents, sandbox, streaming, multi-file edits.

## Run

```bash
npm install
export ANTHROPIC_API_KEY=sk-ant-...
cd example && node ../src/agent.ts "fix the failing tests"
```

Node 24+ runs the `.ts` file directly. With no argument it opens a `>` prompt; type `exit` to quit.
Env: `MCC_MODEL` (default `claude-opus-5-5`), `MCC_MAX_CONTEXT_CHARS`.

`example/` is a small repo with an off-by-one bug in `sum()`. `npm test` there fails 2 of 3 tests.
