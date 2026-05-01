# Internet Proxy

Standalone Rust proxy for validating what remote endpoints an application
attempts to reach, with optional HTTPS interception for request-path logging.

It is intentionally independent from the `cline` extension so you can run it as
an external harness and point any app at it with standard proxy environment
variables.

## What it does

- accepts standard HTTP proxy traffic
- supports HTTPS `CONNECT` tunneling
- optionally performs TLS MITM interception for HTTPS
- logs destination host, port, client address, and resolved IPs
- logs decrypted HTTPS request methods and paths when `--mitm` is enabled
- optionally restricts traffic to an allowlist of expected hosts
- persists a local CA certificate and key for repeatable test runs
- writes logs to stdout and optional JSONL file

## Quick Start

```bash
cargo run --release -- --listen 127.0.0.1:8080 --log-file proxy-log.jsonl
```

## HTTPS MITM Mode

Use `--mitm` when you need HTTPS request paths instead of only host and port.

```bash
cargo run --release -- \
  --listen 127.0.0.1:8080 \
  --mitm \
  --log-file logs/proxy-log.jsonl
```

On first run, the proxy creates:

- `certs/ca-cert.pem`
- `certs/ca-key.pem`

Trust `certs/ca-cert.pem` in the client you are testing. Without that trust
step, HTTPS clients will reject the intercepted certificates.

## Example with an allowlist

```bash
cargo run --release -- \
  --listen 127.0.0.1:8080 \
  --mitm \
  --log-file proxy-log.jsonl \
  --allow-host api.anthropic.com \
  --allow-host api.openai.com
```

## Point an App at the Proxy

```bash
export http_proxy=http://127.0.0.1:8080
export https_proxy=http://127.0.0.1:8080
```

Then launch the app you want to validate.

## Log Output

Plain HTTP and raw `CONNECT` mode show destination endpoint details such as:

- client address
- destination host
- destination port
- resolved IPs

With `--mitm`, HTTPS requests also log decrypted request fields such as:

- HTTP method
- path and query
- completion timing

## Cline Extension

See [CLINE.md](./CLINE.md) for a step-by-step guide for validating the VS Code
extension with this proxy.

## Useful Workflow

1. Start the proxy with a JSONL log file.
2. Add `--mitm` if you need HTTPS request paths.
3. Point the target app at the proxy.
4. Trust `certs/ca-cert.pem` if HTTPS interception is enabled.
5. Exercise the feature you want to validate.
6. Review stdout or `proxy-log.jsonl` for the hosts, ports, and request paths used.
7. Add `--allow-host` entries if you want the proxy to block anything outside the expected endpoint set.

## Notes

- `--insecure-upstream` is available for lab setups with self-signed upstream
  certificates. Do not use it for normal internet validation unless you
  understand the tradeoff.
- This proxy currently handles intercepted HTTPS as HTTP/1.1. That is a good
  fit for endpoint validation and request-path inspection, but it is not meant
  to be a production reverse proxy.
