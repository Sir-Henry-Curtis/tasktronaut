# Using the Proxy with the Cline Extension

This guide is for validating the VS Code Cline extension from the outside with
the standalone `internet-proxy` tool.

## Goal

After following this guide, you should be able to:

- route Cline network traffic through the proxy
- capture destination hosts and ports
- capture HTTPS request paths with `--mitm`
- prove Cline only reaches the endpoints you expect

## 1. Start the Proxy

From the `tools/internet-proxy` directory:

```bash
cargo run --release -- \
  --listen 127.0.0.1:8080 \
  --mitm \
  --log-file logs/cline.jsonl
```

If this is the first MITM run, the proxy will create:

- `certs/ca-cert.pem`
- `certs/ca-key.pem`

## 2. Make VS Code Use the Proxy

The Cline VS Code extension uses VS Code's proxy configuration.

Set the VS Code proxy to:

```json
{
  "http.proxy": "http://127.0.0.1:8080"
}
```

You can add that in either:

- User Settings
- Workspace Settings

Then restart VS Code so the extension host picks up the change cleanly.

If you are testing the extension from this repository in an Extension
Development Host, launch the parent VS Code window from the terminal first,
then start the dev host from there so it inherits the same trust and proxy
environment.

## 3. Trust the Proxy CA for HTTPS Interception

If you enabled `--mitm`, the client must trust `certs/ca-cert.pem`.

You have two practical options:

### Option A: Temporary per-session trust

Launch VS Code from a terminal with `NODE_EXTRA_CA_CERTS` set:

```bash
export NODE_EXTRA_CA_CERTS="$(pwd)/certs/ca-cert.pem"
code /path/to/your/workspace
```

This is the safest test-only path because it does not modify the operating
system trust store.

### Option B: Add the CA to the OS trust store

If you want VS Code launched normally from the desktop to trust the proxy,
import `certs/ca-cert.pem` into your operating system trust store.

Use this only on a machine or profile where that is acceptable for testing.

## 4. Exercise the Cline Feature You Want to Validate

Examples:

- send a chat request to a model provider
- trigger a provider model list refresh
- test an MCP or remote configuration flow that should reach a known endpoint

## 5. Review the Captured Traffic

Watch stdout live, or inspect the JSONL file:

```bash
sed -n '1,40p' logs/cline.jsonl
```

In MITM mode you should see entries like:

- `kind=connect` when an HTTPS tunnel starts
- `kind=https status=forwarding` with method and path
- `kind=https status=completed` when the response finishes

That gives you evidence for:

- which host Cline connected to
- which port it used
- which HTTPS route it requested

VS Code itself may also generate unrelated traffic such as extension or editor
requests. If you want a cleaner capture, use a temporary VS Code profile and
combine this proxy with a strict `--allow-host` list.

## 6. Tighten the Test with an Allowlist

If you want the proxy to fail fast on unexpected egress, restart it with
explicit host constraints:

```bash
cargo run --release -- \
  --listen 127.0.0.1:8080 \
  --mitm \
  --log-file logs/cline.jsonl \
  --allow-host api.anthropic.com \
  --allow-host api.openai.com
```

Requests outside that set will be blocked and logged.

## Troubleshooting

### TLS errors in VS Code or Cline

The most common cause is missing trust for `certs/ca-cert.pem`.

Use the temporary launch method first:

```bash
export NODE_EXTRA_CA_CERTS="$(pwd)/certs/ca-cert.pem"
code /path/to/your/workspace
```

### No traffic appears in the proxy

Check:

1. VS Code really has `http.proxy` set to `http://127.0.0.1:8080`.
2. VS Code was restarted after changing the proxy setting.
3. The proxy is still running on the same port.

### You only see `CONNECT` entries and not HTTPS paths

Start the proxy with `--mitm`. Without that flag, HTTPS traffic is tunneled but
not decrypted.

### Upstream TLS verification fails during local lab testing

If your upstream target uses a self-signed test certificate, you can use:

```bash
--insecure-upstream
```

That is for controlled test environments only.
