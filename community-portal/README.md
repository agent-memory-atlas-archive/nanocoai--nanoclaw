# Community portal

The portal connects browser login, installation identity, and remote coding
terminals. The Host keeps one outbound account-cell connection. Each terminal
gets an individually routed SSH stream bound to its account, installation,
and authorized terminal key.

## Build

Use Node 22.13 or later:

```sh
cd community-portal
npm ci
npm run build:host
npm run build
```

`build:host` produces the bundled setup client, Host supervisor, and terminal
helper in the checkout's `setup/` directory. These bundles include `ws`; its
license is preserved in `setup/portal-client.LICENSE`. `build` produces the
portal service package, cell assets, and downloadable terminal helper under
the ignored `dist/` directory. Neither command publishes or deploys anything.

Source ownership:

- `device/`: installation client, reconnect logic, SSH endpoint, and terminal CLI.
- `service/`: browser sessions, authorization, revocation, and service adapters.
- `worker/`: account cells and bounded SSH stream routing.
- `protocol/`: installation credential envelope and revocation-epoch format.
- `web/`: browser approval, installation access, and terminal key controls.
- `../setup/`: Host lifecycle and setup integration.

The production identity adapter uses the configured account service as the
identity authority. WorkOS settings, service names, tables, and signing keys
are supplied by the service environment; no installation state ships here.

## Local development

```sh
npm run celld:install
npm run dev
```

This starts a loopback demo at `http://127.0.0.1:7310`, with local identity
and partner fixtures. `PORT` selects another starting port; the cell and
partner fixture use the next two ports. Demo state remains in the ignored
`.runtime/` directory. The demo does not prove live browser-provider consent.
Use `NANOCLAW_PORTAL_ORIGIN=http://127.0.0.1:7310` for Host setup and terminal
commands when testing against this demo instead of the hosted portal.

## Tests

```sh
npm test
npm run test:e2e
```

The E2E suite needs the checksum-verified `celld` binary installed above.
It exercises eight concurrent streams round-tripping 16 MiB, repeated Host
socket loss, relay restarts, silent stalls, short-ticket renewal while data
is in flight, admission limits, stream cleanup, and revocation during recovery.
It uses local identity and partner fixtures.

For optional storage integration tests, `npm run test:integration` starts
temporary DynamoDB Local and MinIO containers and removes them afterward.
Host and agent-runner tests run from their own package directories.

See [code mode](../docs/code-mode.md) for terminal commands and recovery limits.
