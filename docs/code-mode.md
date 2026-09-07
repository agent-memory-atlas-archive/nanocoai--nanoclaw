# Code mode

Code mode runs Claude Code in a persistent tmux session inside an agent
container. The workspace survives container restarts. Detaching a terminal
leaves the agent running; attaching to a cold sandbox starts its container.

## Local terminal

Rebuild the agent image after updating this branch, then start the Host normally.
From the Host checkout:

```sh
bin/ncl sandboxes new my-project
bin/ncl sandboxes list
bin/ncl sandboxes attach my-project
```

Detach with **Ctrl-b, then d**. Existing groups can use code mode through
`bin/ncl groups config update <group> --code-mode true`, followed by
`bin/ncl groups restart <group>`. `bin/ncl groups attach <group>` shares the
same terminal implementation as sandbox attachment. Agents cannot invoke
these Host-only terminal commands through their mailbox.

## Remote terminal

Remote access uses the community portal's browser login and the Host's existing
outbound connection. Enable it explicitly on a signed-in Host:

```sh
node setup/nanocode.mjs enable
```

The receiving Host needs OpenSSH server installed. The helper starts a dedicated
listener on loopback; it does not change the system SSH service or open an
inbound network port. The portal lists the installation's device ID.

On your terminal machine, use the helper downloaded from the portal or this
checkout's `setup/nanocode.mjs`:

```sh
node setup/nanocode.mjs login
node setup/nanocode.mjs connect <device-id> new my-project
node setup/nanocode.mjs connect <device-id> list
node setup/nanocode.mjs connect <device-id> attach my-project
```

Browser approval authorizes a separate public SSH key. The private key stays
on the terminal machine. SSH encrypts terminal traffic end to end and pins
the receiving Host's key. Access covers coding sandboxes on opted-in
installations belonging to the signed-in account. The forced command accepts
only sandbox creation, listing, and attachment.

Disable access with `node setup/nanocode.mjs disable`, or revoke a terminal
key in the portal. A matching portal backend is required; building this branch
does not update a hosted service. Its source and local test commands are in
[community-portal](../community-portal/README.md).

## Connection recovery

- Interrupted attachment retries with fresh authorization and SSH for up to
  two minutes, measured from the interruption. Longer outages require another
  attach command. Successful recovery redraws the existing tmux session.
- Clean detach, sign-out, revocation, authentication failure, and a changed
  Host key stop recovery. Temporary network and API failures retry with jitter.
- Creation runs once before attachment. An ambiguous creation response is
  reported for inspection; creation and terminal keystrokes are never replayed.
- Each stream direction permits 64 KiB of unacknowledged data in 16 KiB frames.
  Both endpoints and the relay enforce that limit. One account cell admits
  at most eight streams, and closing one stream leaves the others running.
- Heartbeats detect silent connections. Short-lived tickets renew without
  replacing stream counters. Final bytes drain before the stream closes.
- Host shutdown, including a hard crash, retires its dedicated SSH listener.
  A replacement Host can reconnect to the surviving agent container.

## Configuration and dependencies

Code mode uses the existing agent image, Claude Code installation, and mailbox.
The image adds the distribution's `tmux` package. Remote terminal access requires
Node 22.13+ and an OpenSSH client; only the receiving Host needs OpenSSH server.
The portal service has its own package lock and dependencies.

`NANOCLAW_CODE_PERMISSION_MODE` defaults to `auto`. A group's
`--permission-mode auto|bypass` overrides it; bypass must be explicitly selected.
The Host stamps the instruction and permission files into read-only mounts.
Workspace toolchains can persist under `/workspace/tools`.

`NANOCLAW_CODE_IDLE_TTL_MS` and `NANOCLAW_CODE_ATTACH_IDLE_TTL_MS` control idle
session retirement. Choose an attached idle lease longer than the reconnect
budget if the same process must survive a sustained outage.
