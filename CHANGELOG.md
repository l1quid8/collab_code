# Changelog

## [0.2.0] - 2026-09-29

Updated for the Codex CLI 0.158 app-server protocol (requires 0.118.0+). Verified end-to-end against codex-cli 0.158.0.

### Fixed
- Failed Codex turns (rate limits, auth errors, bad model) now exit non-zero with the real error instead of "No response content captured".
- Files Codex creates are tracked as created, so **Reject** removes them. Previously every file was recorded as modified and new files survived a reject.
- Files written by Codex's shell commands (lockfiles, generated code) are tracked too, via a `git status` baseline; files you already had uncommitted edits in are flagged instead of silently included.
- Commands show their real exit code (was always `exit ?`).
- `session-status` includes `filesCreated` / `filesModified`, which the commit and reject steps rely on.
- Sub-agent threads can no longer end a turn early.
- Codex's interim and final messages are separated instead of run together.

### Changed
- Plans and messages are passed on stdin (`-` plus a quoted heredoc), so backticks and `$` in markdown are never run by the shell.
- Turn timeouts interrupt Codex and report partial work. Default is 570s, just under Claude Code's 10-minute Bash limit.
- `.collab/` ignores itself, so session state never shows up in `git status`.
- Config values are validated when set, and only keys you set are saved.
- Architect model choices are `opus` / `sonnet` (no pinned versions).

### Performance
- Per-command overhead roughly halved (~685 ms → ~334 ms): event-driven turn completion and an in-connection auth check instead of extra `codex` process spawns.
- Resuming a debate no longer re-sends the whole thread history each round.
- ~36% less stdio traffic on large edits by opting out of unused notifications.

### Added
- Test suite (`npm test`) with a fake `codex` binary; CI on Node 18, 22 and 24.

## 0.1.x

Untagged pre-releases.

[0.2.0]: https://github.com/l1quid8/collab_code/releases/tag/v0.2.0
