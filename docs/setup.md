# Setup

The connector is a stdio MCP server. Each MCP client, such as the Codex or Claude provider inside
T3, spawns it on demand. It keeps no state, listens on no port, and needs no token or sign-in. It
finds the running OpenBot profile by itself and calls OpenBot's Local scripts API.

It works with the installed OpenBot app as shipped. OpenBot talks to T3 directly, through T3's own
MCP endpoint; the connector is not involved in that direction.

## Prerequisites

- Node 22 or newer. This checkout was tested with Node 22.22.0 and 24.21.0.
- The installed OpenBot app, version 0.40.0 or newer.
- **Local scripts** enabled for each OpenBot agent you want to reach. Open the agent, choose
  **Permissions**, and turn on **Local scripts**. OpenBot then publishes its automation URL and token
  files for that profile. That switch is the only grant the connector relies on.

## Build

```sh
git clone https://github.com/sdlyy/t3-openbot-connector.git
cd t3-openbot-connector
npm ci
npm run build
npm run doctor
```

`doctor` prints the profiles that currently publish automation files, the one the connector will
use, the agents that allow Local scripts, and whether the Codex and
Claude registrations point at this build. When more than one
profile publishes files, for example the installed app and a development build, pass
`--automation-dir PATH` or set `OPENBOT_AUTOMATION_DIR`.

## Connect T3 to OpenBot

Register the connector as a stdio MCP server in both providers T3 runs:

```sh
npm run register
```

This writes one `[mcp_servers.t3_openbot]` table into `~/.codex/config.toml` and one `t3_openbot`
entry under `mcpServers` in `~/.claude.json`, using the absolute path of the Node binary that ran
the command and of this checkout's built CLI. It replaces an older entry of the same name and
leaves everything else in both files untouched. Run it again after moving the checkout or changing
the Node version; `doctor` reports whether both entries still point at the current build.

What it writes, for reference:

```toml
[mcp_servers.t3_openbot]
command = "/absolute/path/to/node"
args = ["/absolute/path/to/t3-openbot-connector/dist/src/cli.js"]
env_vars = ["T3CODE_THREAD_ID"]
```

The last line lets Codex pass the T3 thread ID to the connector, which is how reports find their way
back to the thread that asked.

New T3 threads pick the server up when their provider session starts. Run the command with the
Node you want the providers to use. With a version manager, run it through that manager, for
example `fnm exec --using=24 npm run register`, so the entry does not point at a shell-specific shim.

## Connect OpenBot to T3

In OpenBot, add an MCP server of type **Streamable HTTP** with the URL `http://127.0.0.1:3773/mcp`
and no headers, then choose **Sign in**. T3 shows an approval page that asks for a pairing code
from T3 **Settings → Connections**. Choose a permission mode that may message the threads you want
reports in. OpenBot agents then have T3's own tools, including `t3_thread_send`.

This is how results get back to T3: the OpenBot agent posts its answer itself.

Then give the agent its standing instructions from [agent-instructions.md](agent-instructions.md).
They keep it from waiting for a reply that never comes.

## Use the bridge

| Need | Tool |
| --- | --- |
| Check the connection and the report thread | `openbot_status` |
| Discover agents and their routines | `list_agents` |
| Start work and get the answer back in this thread | `send_message` with a fresh `requestId` |
| Send the answer to another thread | `send_message` with `reportToThreadId` |
| Fire and forget | `send_message` with `report: false` |
| Start an existing routine now | `run_routine`, optionally with a payload |
| See what an agent is waiting on | `list_pending` |
| Answer an agent's question | `answer_prompt` |

In practice you say "ask Ada in OpenBot to ..." in a T3 thread. The T3 agent sends the task and ends
its turn, and the answer arrives in the same thread as a new message.

Every tool takes `agent` as either the agent's ID or its name. A name must be unique among the
agents that allow Local scripts; the connector refuses to guess between two agents called the same.

`send_message` and `run_routine` return a queued receipt, not a result. For `send_message` inside
T3, the connector appends an instruction so the OpenBot agent posts into the calling thread itself, with a
stable `clientRequestId`, whether it finished or not. The report starts with one line such as
`[OpenBot report] agent: Ada · request: <requestId> · outcome: completed`, or
`outcome: failed` with the reason, followed by the answer. The instruction also tells the agent that
the report is one-way: end the turn after the receipt, do not wait for or invent a reply, and expect
any follow-up as a new message in its queue. A routine can carry the same instruction in its own
text. OpenBot deduplicates a repeated message `requestId` for 24 hours; a routine run has no retry
key.

If an agent still lingers after reporting, add a standing rule to that agent's own instructions in
OpenBot; see [the design notes](design.md#the-report-is-one-way).

Approvals and browser takeovers appear in `list_pending` but must be handled in OpenBot. The
connector does not accept or decline a command on your behalf.

To create or change a schedule, ask the agent: OpenBot agents have their own
routine tools, so a `send_message` such as "Create a daily routine at 09:00 Europe/Warsaw that..."
does it, and `list_agents` shows the result.

## When something is off

| Symptom | Cause and fix |
| --- | --- |
| `openbot_offline` | OpenBot is not running, or no agent has Local scripts on. |
| `agent_not_found` | The agent exists but its Local scripts switch is off. |
| `openbot_rate_limited` | OpenBot allows 30 messages and runs per agent per hour. |
| No report arrives | Read `list_pending`; the agent may be waiting on a question or approval. If its answer in OpenBot says the T3 tools are unavailable, sign in again under **Connect OpenBot to T3**. |
| Tools missing in a T3 thread | The thread started before `npm run register`; open a new one. `npm run doctor` shows a broken Node path. |

## Validate

```sh
npm test
```

The tests spawn the real CLI over stdio against a stand-in for OpenBot's Local scripts API, including an OpenBot that starts after the connector.
