---
name: deepwiki
description: Use when a task needs knowledge about a third-party GitHub repository or published library — its architecture, internals, APIs, configuration, runtime behavior, or usage — for example "how does X work in <owner/repo>" or "which option does <library> provide for Y". Researches through the DeepWiki MCP tools (mcp__deepwiki__*). Do not use for this repository's own code (use local search) or for current events and non-repository facts (use web search).
---

# Skill: deepwiki

Research third-party GitHub repositories through the DeepWiki MCP instead of
guessing from training-data memory. DeepWiki serves AI-generated, wiki-style
documentation for public GitHub repositories, grounded in the actual code.

## Tools

| Tool                                 | Use it for                                                                           |
| ------------------------------------ | ------------------------------------------------------------------------------------ |
| `mcp__deepwiki__read_wiki_structure` | The list of documentation topics for a repository — the map before you dive          |
| `mcp__deepwiki__ask_question`        | A targeted question about a repository, answered with context from its code and docs |
| `mcp__deepwiki__read_wiki_contents`  | The full wiki contents — only for a genuine top-to-bottom deep dive                  |

## Workflow

1. Identify the repository as `owner/repo` (e.g. `oven-sh/bun`). Confirm it
   is the upstream project the question is actually about, not a fork.
2. Call `read_wiki_structure` first to see which topics exist.
3. Ask targeted questions with `ask_question` — one focused question per
   call, building on what the structure revealed. Prefer several small
   questions over one giant one; each answer costs context.
4. Reach for `read_wiki_contents` only when you truly need the whole wiki;
   its output is large.

## Guardrails

- DeepWiki covers public GitHub repositories only. Private repos need an
  authenticated service — do not force DeepWiki onto them.
- The wiki is AI-generated: it can hallucinate or lag behind the default
  branch. When an answer will drive code changes, cross-check the specific
  claim against the real source (a clone, the GitHub file view, or `gh`
  search) before relying on it.
- Keep questions concrete — ask about specific files, symbols, or behaviors
  rather than open-ended opinions.
- First-party code lives in this repository: use the local search tools, not
  DeepWiki. Current events and non-repository facts belong to web search.

## Availability

The tools require the `deepwiki` MCP server, declared in `.mcp.json` at the
repository root and pre-approved in `.claude/settings.json` (the
`enabledMcpjsonServers` entry plus the `mcp__deepwiki__*` allow rule), so it
connects without a first-use prompt. If the `mcp__deepwiki__*` tools are
missing, check the MCP status (e.g. `/mcp`) before assuming the answer is
"no information".
