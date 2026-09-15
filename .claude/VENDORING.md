# Vendored Legion

Legion v8.0.6 is vendored into this repo so `/legion:*` commands, agents, and
skills are available to anyone who clones it — no `npx` install step required.

## Layout

| Path                      | Contents                     |
| ------------------------- | ---------------------------- |
| `.claude/agents/`         | 49 agent personalities       |
| `.claude/commands/legion/`| 19 `/legion:*` slash commands|
| `.claude/legion/skills/`  | 33 skills                    |
| `.claude/legion/adapters/`| Per-runtime adapter guides   |
| `.claude/legion/manifest.json` | Install manifest        |

Installed with:

```
npx @9thlevelsoftware/legion --claude --local
```

## Paths are repo-relative, on purpose

The installer bakes the *absolute* path of the machine it ran on into ~80
cross-references across these files. Those were rewritten to be relative to the
repo root (`.claude/legion/skills/...`), which is what makes the vendored copy
portable between machines and checkouts.

**If you re-run the installer or `/legion:update`, redo that rewrite** or the
absolute paths come back and break for everyone else:

```
grep -rl "$PWD/.claude/" .claude | xargs sed -i 's#'"$PWD"'/.claude/#.claude/#g'
```

## Picking up changes

Claude Code scans `.claude/` at startup, so restart your CLI after installing or
updating — until then `/legion:*` will report as an unknown command.
