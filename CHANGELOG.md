# Changelog

## 0.4.0

- Reports go to the calling T3 thread by default, read from `T3CODE_THREAD_ID`. `reportToThreadId`
  names another thread and `report: false` turns reporting off.
- The tool surface is what stock OpenBot supports: `openbot_status`, `list_agents`, `send_message`,
  `run_routine`, `list_pending`, `answer_prompt`.
- The server's MCP instructions tell the T3 agent when to delegate, to end its turn after sending,
  and to answer an OpenBot-initiated task with reporting off.
- The Codex registration forwards the thread ID with `env_vars`; `doctor` checks it.

## 0.3.0

- First stateless stdio version: profile detection, agents by name, tagged one-way reports,
  `install` and `doctor` commands.
