use openssl::asn1::{Asn1Integer, Asn1Time};
use openssl::bn::{BigNum, MsbOption};
use openssl::hash::MessageDigest;
use openssl::pkey::{PKey, Private};
use openssl::rsa::Rsa;
use openssl::ssl::{SslAcceptor, SslConnector, SslMethod, SslVerifyMode};
use openssl::x509::extension::{
    AuthorityKeyIdentifier, BasicConstraints, ExtendedKeyUsage, KeyUsage, SubjectAlternativeName,
    SubjectKeyIdentifier,
};
use openssl::x509::{X509, X509NameBuilder};
use std::env;
use std::fs::{self, File};
use std::io::{self, Read, Write};
use std::net::{IpAddr, Shutdown, SocketAddr, TcpListener, TcpStream, ToSocketAddrs};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

const HEADER_LIMIT_BYTES: usize = 64 * 1024;

fn main() -> io::Result<()> {
    let config = Config::parse(env::args().skip(1))?;
    let logger = Arc::new(Logger::new(config.log_file.clone())?);
    let listener = TcpListener::bind(&config.listen)?;

    println!(
        "internet-proxy listening on {}{}{}",
        config.listen,
        allowlist_label(&config.allow_hosts),
        mitm_label(&config)
    );

    if config.mitm {
        println!(
            "trust this CA certificate for intercepted HTTPS: {}",
            config.ca_cert_path.display()
        );
    }

    for stream in listener.incoming() {
        match stream {
            Ok(stream) => {
                let logger = Arc::clone(&logger);
                let config = config.clone();
                thread::spawn(move || {
                    if let Err(error) = handle_client(stream, &config, &logger) {
                        logger.log(LogEvent::error("connection_error", error.to_string()));
                    }
                });
            }
            Err(error) => logger.log(LogEvent::error("accept_error", error.to_string())),
        }
    }

    Ok(())
}

#[derive(Clone)]
struct Config {
    listen: String,
    log_file: Option<PathBuf>,
    resolve_dns: bool,
    allow_hosts: Vec<String>,
    mitm: bool,
    insecure_upstream: bool,
    ca_cert_path: PathBuf,
    ca_key_path: PathBuf,
    mitm_authority: Option<Arc<MitmAuthority>>,
}

impl Config {
    fn parse<I>(args: I) -> io::Result<Self>
    where
        I: IntoIterator<Item = String>,
    {
        let mut listen = String::from("127.0.0.1:8080");
        let mut log_file = None;
        let mut resolve_dns = true;
        let mut allow_hosts = Vec::new();
        let mut mitm = false;
        let mut insecure_upstream = false;
        let mut ca_cert_path = PathBuf::from("certs/ca-cert.pem");
        let mut ca_key_path = PathBuf::from("certs/ca-key.pem");

        let mut args = args.into_iter();
        while let Some(arg) = args.next() {
            match arg.as_str() {
                "--listen" => listen = next_value("--listen", &mut args)?,
                "--log-file" => {
                    log_file = Some(PathBuf::from(next_value("--log-file", &mut args)?))
                }
                "--allow-host" => {
                    allow_hosts.push(normalize_host(&next_value("--allow-host", &mut args)?))
                }
                "--mitm" => mitm = true,
                "--insecure-upstream" => insecure_upstream = true,
                "--ca-cert" => ca_cert_path = PathBuf::from(next_value("--ca-cert", &mut args)?),
                "--ca-key" => ca_key_path = PathBuf::from(next_value("--ca-key", &mut args)?),
                "--no-dns" => resolve_dns = false,
                "--help" | "-h" => {
                    print_help();
                    std::process::exit(0);
                }
                other => {
                    return Err(io::Error::new(
                        io::ErrorKind::InvalidInput,
                        format!("unknown argument: {other}"),
                    ));
                }
            }
        }

        let mitm_authority = if mitm {
            Some(Arc::new(MitmAuthority::load_or_create(
                &ca_cert_path,
                &ca_key_path,
            )?))
        } else {
            None
        };

        Ok(Self {
            listen,
            log_file,
            resolve_dns,
            allow_hosts,
            mitm,
            insecure_upstream,
            ca_cert_path,
            ca_key_path,
            mitm_authority,
        })
    }
}

fn next_value<I>(flag: &str, args: &mut I) -> io::Result<String>
where
    I: Iterator<Item = String>,
{
    args.next().ok_or_else(|| {
        io::Error::new(
            io::ErrorKind::InvalidInput,
            format!("missing value for {flag}"),
        )
    })
}

fn print_help() {
    println!("internet-proxy");
    println!();
    println!("Usage:");
    println!("  cargo run --release -- [options]");
    println!();
    println!("Options:");
    println!("  --listen <addr>            Bind address. Default: 127.0.0.1:8080");
    println!("  --log-file <path>          Append JSONL logs to a file");
    println!("  --allow-host <host>        Allow only matching host or domain suffix");
    println!("  --mitm                     Intercept HTTPS and log decrypted request paths");
    println!("  --ca-cert <path>           CA certificate path. Default: certs/ca-cert.pem");
    println!("  --ca-key <path>            CA private key path. Default: certs/ca-key.pem");
    println!("  --insecure-upstream        Skip TLS verification to the upstream server");
    println!("  --no-dns                   Skip DNS resolution in logs");
    println!("  --help                     Show this message");
}

struct Logger {
    file: Option<Mutex<File>>,
}

impl Logger {
    fn new(path: Option<PathBuf>) -> io::Result<Self> {
        let file = match path {
            Some(path) => Some(Mutex::new(
                File::options().create(true).append(true).open(path)?,
            )),
            None => None,
        };
        Ok(Self { file })
    }

    fn log(&self, event: LogEvent) {
        println!("{}", event.human_line());
        if let Some(file) = &self.file {
            if let Ok(mut file) = file.lock() {
                let _ = writeln!(file, "{}", event.to_json_line());
            }
        }
    }
}

#[derive(Clone, Debug)]
struct LogEvent {
    timestamp_ms: u128,
    kind: &'static str,
    status: &'static str,
    client: Option<String>,
    method: Option<String>,
    host: Option<String>,
    port: Option<u16>,
    path: Option<String>,
    resolved_ips: Vec<String>,
    bytes_up: Option<u64>,
    bytes_down: Option<u64>,
    duration_ms: Option<u128>,
    detail: Option<String>,
}

impl LogEvent {
    fn error(kind: &'static str, detail: String) -> Self {
        Self {
            timestamp_ms: now_ms(),
            kind,
            status: "error",
            client: None,
            method: None,
            host: None,
            port: None,
            path: None,
            resolved_ips: Vec::new(),
            bytes_up: None,
            bytes_down: None,
            duration_ms: None,
            detail: Some(detail),
        }
    }

    fn human_line(&self) -> String {
        let mut parts = vec![
            format!("ts={}", self.timestamp_ms),
            format!("kind={}", self.kind),
            format!("status={}", self.status),
        ];

        if let Some(client) = &self.client {
            parts.push(format!("client={client}"));
        }
        if let Some(method) = &self.method {
            parts.push(format!("method={method}"));
        }
        if let Some(host) = &self.host {
            parts.push(format!("host={host}"));
        }
        if let Some(port) = self.port {
            parts.push(format!("port={port}"));
        }
        if let Some(path) = &self.path {
            parts.push(format!("path={path}"));
        }
        if !self.resolved_ips.is_empty() {
            parts.push(format!("resolved_ips={}", self.resolved_ips.join(",")));
        }
        if let Some(bytes_up) = self.bytes_up {
            parts.push(format!("bytes_up={bytes_up}"));
        }
        if let Some(bytes_down) = self.bytes_down {
            parts.push(format!("bytes_down={bytes_down}"));
        }
        if let Some(duration_ms) = self.duration_ms {
            parts.push(format!("duration_ms={duration_ms}"));
        }
        if let Some(detail) = &self.detail {
            parts.push(format!("detail={detail}"));
        }

        parts.join(" ")
    }

    fn to_json_line(&self) -> String {
        let mut fields = Vec::new();
        fields.push(json_field_num("timestamp_ms", self.timestamp_ms));
        fields.push(json_field_str("kind", self.kind));
        fields.push(json_field_str("status", self.status));

        if let Some(client) = &self.client {
            fields.push(json_field_str("client", client));
        }
        if let Some(method) = &self.method {
            fields.push(json_field_str("method", method));
        }
        if let Some(host) = &self.host {
            fields.push(json_field_str("host", host));
        }
        if let Some(port) = self.port {
            fields.push(format!("\"port\":{port}"));
        }
        if let Some(path) = &self.path {
            fields.push(json_field_str("path", path));
        }
        if !self.resolved_ips.is_empty() {
            let items = self
                .resolved_ips
                .iter()
                .map(|item| format!("\"{}\"", escape_json(item)))
                .collect::<Vec<_>>()
                .join(",");
            fields.push(format!("\"resolved_ips\":[{items}]"));
        }
        if let Some(bytes_up) = self.bytes_up {
            fields.push(format!("\"bytes_up\":{bytes_up}"));
        }
        if let Some(bytes_down) = self.bytes_down {
            fields.push(format!("\"bytes_down\":{bytes_down}"));
        }
        if let Some(duration_ms) = self.duration_ms {
            fields.push(format!("\"duration_ms\":{duration_ms}"));
        }
        if let Some(detail) = &self.detail {
            fields.push(json_field_str("detail", detail));
        }

        format!("{{{}}}", fields.join(","))
    }
}

fn json_field_str(name: &str, value: &str) -> String {
    format!("\"{name}\":\"{}\"", escape_json(value))
}

fn json_field_num(name: &str, value: u128) -> String {
    format!("\"{name}\":{value}")
}

fn escape_json(input: &str) -> String {
    let mut output = String::with_capacity(input.len());
    for ch in input.chars() {
        match ch {
            '\\' => output.push_str("\\\\"),
            '"' => output.push_str("\\\""),
            '\n' => output.push_str("\\n"),
            '\r' => output.push_str("\\r"),
            '\t' => output.push_str("\\t"),
            other => output.push(other),
        }
    }
    output
}

fn handle_client(mut client: TcpStream, config: &Config, logger: &Arc<Logger>) -> io::Result<()> {
    client.set_read_timeout(Some(Duration::from_secs(30)))?;
    client.set_write_timeout(Some(Duration::from_secs(30)))?;

    let client_addr = client.peer_addr().ok().map(|addr| addr.to_string());
    let Some((header_bytes, leftover)) = read_until_headers_end(&mut client)? else {
        return Ok(());
    };

    let request = Request::parse(&header_bytes)?;
    let destination = request.destination()?;
    let host = normalize_host(&destination.host);

    if !host_allowed(&host, &config.allow_hosts) {
        logger.log(LogEvent {
            timestamp_ms: now_ms(),
            kind: request.kind(),
            status: "blocked",
            client: client_addr.clone(),
            method: Some(request.method.clone()),
            host: Some(host),
            port: Some(destination.port),
            path: request.path.clone(),
            resolved_ips: Vec::new(),
            bytes_up: None,
            bytes_down: None,
            duration_ms: None,
            detail: Some(String::from("host_not_in_allowlist")),
        });
        write_plain_response(
            &mut client,
            "403 Forbidden",
            b"host blocked by proxy allowlist\n",
        )?;
        return Ok(());
    }

    match request.method.as_str() {
        "CONNECT" if config.mitm => handle_connect_mitm(
            client,
            client_addr,
            request,
            leftover,
            destination,
            config,
            logger,
        ),
        "CONNECT" => handle_connect_tunnel(
            client,
            client_addr,
            request,
            leftover,
            destination,
            config,
            logger,
        ),
        _ => handle_http_plain(
            client,
            client_addr,
            request,
            leftover,
            destination,
            config,
            logger,
        ),
    }
}

fn handle_connect_tunnel(
    mut client: TcpStream,
    client_addr: Option<String>,
    request: Request,
    leftover: Vec<u8>,
    destination: Destination,
    config: &Config,
    logger: &Arc<Logger>,
) -> io::Result<()> {
    let resolved = resolve_target(&destination, config.resolve_dns)?;
    let mut upstream = connect_target(&destination, &resolved)?;
    upstream.set_read_timeout(None)?;
    upstream.set_write_timeout(None)?;
    client.set_read_timeout(None)?;
    client.set_write_timeout(None)?;

    logger.log(LogEvent {
        timestamp_ms: now_ms(),
        kind: "connect",
        status: "connected",
        client: client_addr,
        method: Some(request.method),
        host: Some(destination.host.clone()),
        port: Some(destination.port),
        path: None,
        resolved_ips: resolved_ips_only(&resolved),
        bytes_up: None,
        bytes_down: None,
        duration_ms: None,
        detail: None,
    });

    client.write_all(b"HTTP/1.1 200 Connection Established\r\n\r\n")?;
    if !leftover.is_empty() {
        upstream.write_all(&leftover)?;
    }

    let started = Instant::now();
    let mut upstream_writer = upstream.try_clone()?;
    let mut client_reader = client.try_clone()?;
    let client_to_upstream =
        thread::spawn(move || copy_and_shutdown(&mut client_reader, &mut upstream_writer));

    let upstream_to_client = copy_and_shutdown(&mut upstream, &mut client)?;
    let client_to_upstream = client_to_upstream
        .join()
        .unwrap_or_else(|_| Err(io::Error::other("CONNECT worker panicked")))?;

    logger.log(LogEvent {
        timestamp_ms: now_ms(),
        kind: "connect",
        status: "closed",
        client: None,
        method: Some(String::from("CONNECT")),
        host: Some(destination.host),
        port: Some(destination.port),
        path: None,
        resolved_ips: Vec::new(),
        bytes_up: Some(client_to_upstream),
        bytes_down: Some(upstream_to_client),
        duration_ms: Some(started.elapsed().as_millis()),
        detail: None,
    });

    Ok(())
}

fn handle_connect_mitm(
    mut client: TcpStream,
    client_addr: Option<String>,
    request: Request,
    leftover: Vec<u8>,
    destination: Destination,
    config: &Config,
    logger: &Arc<Logger>,
) -> io::Result<()> {
    let resolved = resolve_target(&destination, config.resolve_dns)?;
    logger.log(LogEvent {
        timestamp_ms: now_ms(),
        kind: "connect",
        status: "intercepting",
        client: client_addr.clone(),
        method: Some(request.method),
        host: Some(destination.host.clone()),
        port: Some(destination.port),
        path: None,
        resolved_ips: resolved_ips_only(&resolved),
        bytes_up: None,
        bytes_down: None,
        duration_ms: None,
        detail: None,
    });

    client.write_all(b"HTTP/1.1 200 Connection Established\r\n\r\n")?;
    client.set_read_timeout(Some(Duration::from_secs(60)))?;
    client.set_write_timeout(Some(Duration::from_secs(60)))?;

    let prefixed_client = PrefixedStream::new(client, leftover);
    let acceptor = config
        .mitm_authority
        .as_ref()
        .expect("mitm authority should exist when mitm is enabled")
        .acceptor_for_host(&destination.host)?;
    let mut client_tls = acceptor.accept(prefixed_client).map_err(io_other)?;

    let upstream_tcp = connect_target(&destination, &resolved)?;
    upstream_tcp.set_read_timeout(Some(Duration::from_secs(60)))?;
    upstream_tcp.set_write_timeout(Some(Duration::from_secs(60)))?;

    let connector = build_upstream_connector(config.insecure_upstream)?;
    let mut upstream_tls = connector
        .connect(&destination.host, upstream_tcp)
        .map_err(io_other)?;

    let Some((header_bytes, body_leftover)) = read_until_headers_end(&mut client_tls)? else {
        return Ok(());
    };

    let inner_request = Request::parse(&header_bytes)?;
    let inner_destination = inner_request.destination_with_default_port(destination.port)?;
    if normalize_host(&inner_destination.host) != normalize_host(&destination.host)
        || inner_destination.port != destination.port
    {
        logger.log(LogEvent {
            timestamp_ms: now_ms(),
            kind: "https",
            status: "blocked",
            client: client_addr,
            method: Some(inner_request.method.clone()),
            host: Some(inner_destination.host),
            port: Some(inner_destination.port),
            path: inner_request.path.clone(),
            resolved_ips: Vec::new(),
            bytes_up: None,
            bytes_down: None,
            duration_ms: None,
            detail: Some(String::from("inner_request_host_mismatch")),
        });
        write_plain_response(
            &mut client_tls,
            "421 Misdirected Request",
            b"inner HTTPS request did not match CONNECT target\n",
        )?;
        return Ok(());
    }

    logger.log(LogEvent {
        timestamp_ms: now_ms(),
        kind: "https",
        status: "forwarding",
        client: None,
        method: Some(inner_request.method.clone()),
        host: Some(destination.host.clone()),
        port: Some(destination.port),
        path: inner_request.path.clone(),
        resolved_ips: Vec::new(),
        bytes_up: None,
        bytes_down: None,
        duration_ms: None,
        detail: None,
    });

    forward_http_request(&mut upstream_tls, &inner_request, Some(&destination))?;
    forward_request_body(
        &mut client_tls,
        &mut upstream_tls,
        &inner_request,
        body_leftover,
    )?;
    upstream_tls.flush()?;

    let started = Instant::now();
    let bytes_down = io::copy(&mut upstream_tls, &mut client_tls)?;
    logger.log(LogEvent {
        timestamp_ms: now_ms(),
        kind: "https",
        status: "completed",
        client: None,
        method: Some(inner_request.method),
        host: Some(destination.host),
        port: Some(destination.port),
        path: inner_request.path,
        resolved_ips: Vec::new(),
        bytes_up: None,
        bytes_down: Some(bytes_down),
        duration_ms: Some(started.elapsed().as_millis()),
        detail: None,
    });

    Ok(())
}

fn handle_http_plain(
    mut client: TcpStream,
    client_addr: Option<String>,
    request: Request,
    leftover: Vec<u8>,
    destination: Destination,
    config: &Config,
    logger: &Arc<Logger>,
) -> io::Result<()> {
    let resolved = resolve_target(&destination, config.resolve_dns)?;
    let mut upstream = connect_target(&destination, &resolved)?;
    upstream.set_read_timeout(Some(Duration::from_secs(60)))?;
    upstream.set_write_timeout(Some(Duration::from_secs(60)))?;

    logger.log(LogEvent {
        timestamp_ms: now_ms(),
        kind: "http",
        status: "forwarding",
        client: client_addr,
        method: Some(request.method.clone()),
        host: Some(destination.host.clone()),
        port: Some(destination.port),
        path: request.path.clone(),
        resolved_ips: resolved_ips_only(&resolved),
        bytes_up: None,
        bytes_down: None,
        duration_ms: None,
        detail: None,
    });

    forward_http_request(&mut upstream, &request, Some(&destination))?;
    forward_request_body(&mut client, &mut upstream, &request, leftover)?;
    let _ = upstream.shutdown(Shutdown::Write);

    let started = Instant::now();
    let bytes_down = io::copy(&mut upstream, &mut client)?;
    logger.log(LogEvent {
        timestamp_ms: now_ms(),
        kind: "http",
        status: "completed",
        client: None,
        method: Some(request.method),
        host: Some(destination.host),
        port: Some(destination.port),
        path: request.path,
        resolved_ips: Vec::new(),
        bytes_up: None,
        bytes_down: Some(bytes_down),
        duration_ms: Some(started.elapsed().as_millis()),
        detail: None,
    });

    Ok(())
}

fn forward_http_request<W: Write>(
    upstream: &mut W,
    request: &Request,
    fallback_destination: Option<&Destination>,
) -> io::Result<()> {
    let path = request
        .path
        .as_deref()
        .filter(|value| !value.is_empty())
        .unwrap_or("/");
    write!(
        upstream,
        "{} {} {}\r\n",
        request.method, path, request.version
    )?;

    let mut saw_host = false;
    for (name, value) in &request.headers {
        if name.eq_ignore_ascii_case("host") {
            saw_host = true;
        }
        if name.eq_ignore_ascii_case("proxy-connection")
            || name.eq_ignore_ascii_case("proxy-authorization")
            || name.eq_ignore_ascii_case("connection")
        {
            continue;
        }
        write!(upstream, "{name}: {value}\r\n")?;
    }

    if !saw_host {
        if let Some(destination) = fallback_destination {
            write!(upstream, "Host: {}\r\n", destination.authority())?;
        }
    }

    write!(upstream, "Connection: close\r\n\r\n")?;
    upstream.flush()
}

fn forward_request_body<R: Read, W: Write>(
    client: &mut R,
    upstream: &mut W,
    request: &Request,
    leftover: Vec<u8>,
) -> io::Result<()> {
    if let Some(length) = request.content_length {
        relay_known_length(client, upstream, leftover, length)
    } else if request.chunked {
        relay_chunked_body(client, upstream, leftover)
    } else {
        Ok(())
    }
}

fn relay_known_length<R: Read, W: Write>(
    reader: &mut R,
    writer: &mut W,
    mut leftover: Vec<u8>,
    expected_len: usize,
) -> io::Result<()> {
    let initial = leftover.len().min(expected_len);
    if initial > 0 {
        writer.write_all(&leftover[..initial])?;
    }

    let mut remaining = expected_len.saturating_sub(initial);
    leftover.clear();
    let mut buffer = [0_u8; 8192];
    while remaining > 0 {
        let to_read = remaining.min(buffer.len());
        let read = reader.read(&mut buffer[..to_read])?;
        if read == 0 {
            return Err(io::Error::new(
                io::ErrorKind::UnexpectedEof,
                "request body ended before Content-Length was satisfied",
            ));
        }
        writer.write_all(&buffer[..read])?;
        remaining -= read;
    }
    Ok(())
}

fn relay_chunked_body<R: Read, W: Write>(
    reader: &mut R,
    writer: &mut W,
    mut leftover: Vec<u8>,
) -> io::Result<()> {
    loop {
        let size_line = read_line_from_buffer_or_stream(reader, &mut leftover)?;
        writer.write_all(size_line.as_bytes())?;
        let trimmed = size_line.trim();
        let hex = trimmed.split(';').next().unwrap_or_default();
        let chunk_size = usize::from_str_radix(hex, 16).map_err(|_| {
            io::Error::new(
                io::ErrorKind::InvalidData,
                format!("invalid chunk size line: {trimmed}"),
            )
        })?;

        copy_exact_from_buffer_or_stream(reader, writer, &mut leftover, chunk_size + 2)?;

        if chunk_size == 0 {
            loop {
                let trailer = read_line_from_buffer_or_stream(reader, &mut leftover)?;
                writer.write_all(trailer.as_bytes())?;
                if trailer == "\r\n" {
                    return Ok(());
                }
            }
        }
    }
}

fn read_line_from_buffer_or_stream<R: Read>(
    reader: &mut R,
    buffer: &mut Vec<u8>,
) -> io::Result<String> {
    loop {
        if let Some(pos) = find_bytes(buffer, b"\r\n") {
            let line = buffer.drain(..pos + 2).collect::<Vec<_>>();
            return Ok(String::from_utf8_lossy(&line).into_owned());
        }

        let mut chunk = [0_u8; 1024];
        let read = reader.read(&mut chunk)?;
        if read == 0 {
            return Err(io::Error::new(
                io::ErrorKind::UnexpectedEof,
                "unexpected EOF while reading line",
            ));
        }
        buffer.extend_from_slice(&chunk[..read]);
    }
}

fn copy_exact_from_buffer_or_stream<R: Read, W: Write>(
    reader: &mut R,
    writer: &mut W,
    buffer: &mut Vec<u8>,
    mut total: usize,
) -> io::Result<()> {
    if !buffer.is_empty() {
        let take = buffer.len().min(total);
        writer.write_all(&buffer[..take])?;
        buffer.drain(..take);
        total -= take;
    }

    let mut chunk = [0_u8; 8192];
    while total > 0 {
        let limit = total.min(chunk.len());
        let read = reader.read(&mut chunk[..limit])?;
        if read == 0 {
            return Err(io::Error::new(
                io::ErrorKind::UnexpectedEof,
                "unexpected EOF while copying chunked body",
            ));
        }
        writer.write_all(&chunk[..read])?;
        total -= read;
    }

    Ok(())
}

fn write_plain_response<W: Write>(stream: &mut W, status: &str, body: &[u8]) -> io::Result<()> {
    write!(
        stream,
        "HTTP/1.1 {status}\r\nContent-Type: text/plain\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
        body.len()
    )?;
    stream.write_all(body)?;
    stream.flush()
}

fn resolve_target(destination: &Destination, enabled: bool) -> io::Result<Vec<SocketAddr>> {
    if !enabled {
        return Ok(Vec::new());
    }
    (destination.host.as_str(), destination.port)
        .to_socket_addrs()
        .map(|iter| iter.collect())
}

fn connect_target(destination: &Destination, resolved: &[SocketAddr]) -> io::Result<TcpStream> {
    if !resolved.is_empty() {
        for addr in resolved {
            if let Ok(stream) = TcpStream::connect_timeout(addr, Duration::from_secs(10)) {
                return Ok(stream);
            }
        }
    }

    TcpStream::connect(destination.authority())
}

fn build_upstream_connector(insecure_upstream: bool) -> io::Result<SslConnector> {
    let mut builder = SslConnector::builder(SslMethod::tls_client()).map_err(io_other)?;
    if insecure_upstream {
        builder.set_verify(SslVerifyMode::NONE);
    } else {
        builder.set_default_verify_paths().map_err(io_other)?;
        builder.set_verify(SslVerifyMode::PEER);
    }
    Ok(builder.build())
}

fn copy_and_shutdown(reader: &mut TcpStream, writer: &mut TcpStream) -> io::Result<u64> {
    let copied = io::copy(reader, writer)?;
    let _ = writer.shutdown(Shutdown::Write);
    Ok(copied)
}

fn read_until_headers_end<R: Read>(stream: &mut R) -> io::Result<Option<(Vec<u8>, Vec<u8>)>> {
    let mut buffer = Vec::new();
    let mut chunk = [0_u8; 4096];

    loop {
        let read = stream.read(&mut chunk)?;
        if read == 0 {
            if buffer.is_empty() {
                return Ok(None);
            }
            return Err(io::Error::new(
                io::ErrorKind::UnexpectedEof,
                "connection closed before headers completed",
            ));
        }

        buffer.extend_from_slice(&chunk[..read]);
        if let Some(pos) = find_bytes(&buffer, b"\r\n\r\n") {
            let leftover = buffer.split_off(pos + 4);
            return Ok(Some((buffer, leftover)));
        }

        if buffer.len() > HEADER_LIMIT_BYTES {
            return Err(io::Error::new(
                io::ErrorKind::InvalidData,
                "request headers exceeded size limit",
            ));
        }
    }
}

fn find_bytes(haystack: &[u8], needle: &[u8]) -> Option<usize> {
    haystack
        .windows(needle.len())
        .position(|window| window == needle)
}

#[derive(Clone, Debug)]
struct Request {
    method: String,
    target: String,
    version: String,
    headers: Vec<(String, String)>,
    host_header: Option<String>,
    path: Option<String>,
    content_length: Option<usize>,
    chunked: bool,
}

impl Request {
    fn parse(bytes: &[u8]) -> io::Result<Self> {
        let text = String::from_utf8_lossy(bytes);
        let mut lines = text.split("\r\n");
        let request_line = lines
            .next()
            .ok_or_else(|| io::Error::new(io::ErrorKind::InvalidData, "missing request line"))?;

        let mut parts = request_line.split_whitespace();
        let method = parts
            .next()
            .ok_or_else(|| io::Error::new(io::ErrorKind::InvalidData, "missing method"))?
            .to_string();
        let target = parts
            .next()
            .ok_or_else(|| io::Error::new(io::ErrorKind::InvalidData, "missing target"))?
            .to_string();
        let version = parts
            .next()
            .ok_or_else(|| io::Error::new(io::ErrorKind::InvalidData, "missing version"))?
            .to_string();

        let mut headers = Vec::new();
        let mut host_header = None;
        let mut content_length = None;
        let mut chunked = false;

        for line in lines {
            if line.is_empty() {
                break;
            }
            if let Some((name, value)) = line.split_once(':') {
                let value = value.trim().to_string();
                if name.eq_ignore_ascii_case("host") {
                    host_header = Some(value.clone());
                }
                if name.eq_ignore_ascii_case("content-length") {
                    content_length = value.parse::<usize>().ok();
                }
                if name.eq_ignore_ascii_case("transfer-encoding")
                    && value.to_ascii_lowercase().contains("chunked")
                {
                    chunked = true;
                }
                headers.push((name.to_string(), value));
            }
        }

        let path = if method == "CONNECT" {
            None
        } else {
            Some(extract_path(&target))
        };

        Ok(Self {
            method,
            target,
            version,
            headers,
            host_header,
            path,
            content_length,
            chunked,
        })
    }

    fn destination(&self) -> io::Result<Destination> {
        self.destination_with_default_port(80)
    }

    fn destination_with_default_port(&self, default_port: u16) -> io::Result<Destination> {
        if self.method == "CONNECT" {
            return parse_authority(&self.target, 443);
        }

        if let Some(without_scheme) = self.target.strip_prefix("http://") {
            let (authority, _) = split_authority_and_path(without_scheme);
            return parse_authority(authority, 80);
        }

        if let Some(without_scheme) = self.target.strip_prefix("https://") {
            let (authority, _) = split_authority_and_path(without_scheme);
            return parse_authority(authority, 443);
        }

        let host = self.host_header.as_deref().ok_or_else(|| {
            io::Error::new(
                io::ErrorKind::InvalidData,
                "origin-form request missing Host header",
            )
        })?;
        parse_authority(host, default_port)
    }

    fn kind(&self) -> &'static str {
        if self.method == "CONNECT" {
            "connect"
        } else {
            "http"
        }
    }
}

#[derive(Clone, Debug)]
struct Destination {
    host: String,
    port: u16,
}

impl Destination {
    fn authority(&self) -> String {
        if self.host.contains(':') && !self.host.starts_with('[') {
            format!("[{}]:{}", self.host, self.port)
        } else {
            format!("{}:{}", self.host, self.port)
        }
    }
}

fn split_authority_and_path(input: &str) -> (&str, &str) {
    match input.find('/') {
        Some(pos) => (&input[..pos], &input[pos..]),
        None => (input, "/"),
    }
}

fn extract_path(target: &str) -> String {
    if let Some(without_scheme) = target.strip_prefix("http://") {
        let (_, path) = split_authority_and_path(without_scheme);
        return path.to_string();
    }
    if let Some(without_scheme) = target.strip_prefix("https://") {
        let (_, path) = split_authority_and_path(without_scheme);
        return path.to_string();
    }
    if target.is_empty() {
        String::from("/")
    } else {
        target.to_string()
    }
}

fn parse_authority(input: &str, default_port: u16) -> io::Result<Destination> {
    if let Some(rest) = input.strip_prefix('[') {
        let end = rest.find(']').ok_or_else(|| {
            io::Error::new(
                io::ErrorKind::InvalidData,
                format!("invalid authority: {input}"),
            )
        })?;
        let host = &rest[..end];
        let suffix = &rest[end + 1..];
        let port = if let Some(port_text) = suffix.strip_prefix(':') {
            port_text.parse::<u16>().map_err(|_| {
                io::Error::new(
                    io::ErrorKind::InvalidData,
                    format!("invalid port in {input}"),
                )
            })?
        } else {
            default_port
        };
        return Ok(Destination {
            host: host.to_string(),
            port,
        });
    }

    if let Some((host, port_text)) = input.rsplit_once(':') {
        if port_text.chars().all(|ch| ch.is_ascii_digit()) {
            let port = port_text.parse::<u16>().map_err(|_| {
                io::Error::new(
                    io::ErrorKind::InvalidData,
                    format!("invalid port in {input}"),
                )
            })?;
            return Ok(Destination {
                host: host.to_string(),
                port,
            });
        }
    }

    Ok(Destination {
        host: input.to_string(),
        port: default_port,
    })
}

fn now_ms() -> u128 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis()
}

fn normalize_host(host: &str) -> String {
    host.trim().trim_matches('.').to_ascii_lowercase()
}

fn allowlist_label(allow_hosts: &[String]) -> String {
    if allow_hosts.is_empty() {
        String::new()
    } else {
        format!(" with allowlist={}", allow_hosts.join(","))
    }
}

fn mitm_label(config: &Config) -> String {
    if config.mitm {
        format!(
            " with mitm ca_cert={} ca_key={}",
            config.ca_cert_path.display(),
            config.ca_key_path.display()
        )
    } else {
        String::new()
    }
}

fn host_allowed(host: &str, allow_hosts: &[String]) -> bool {
    if allow_hosts.is_empty() {
        return true;
    }

    allow_hosts.iter().any(|allowed| {
        host == allowed
            || host
                .strip_suffix(allowed)
                .is_some_and(|prefix| prefix.is_empty() || prefix.ends_with('.'))
    })
}

fn resolved_ips_only(addrs: &[SocketAddr]) -> Vec<String> {
    let mut ips = Vec::new();
    for addr in addrs {
        let value = addr.ip().to_string();
        if !ips.iter().any(|existing| existing == &value) {
            ips.push(value);
        }
    }
    ips
}

fn io_other<E: ToString>(error: E) -> io::Error {
    io::Error::other(error.to_string())
}

struct MitmAuthority {
    ca_cert: X509,
    ca_key: PKey<Private>,
}

impl MitmAuthority {
    fn load_or_create(cert_path: &Path, key_path: &Path) -> io::Result<Self> {
        if cert_path.exists() && key_path.exists() {
            let cert_pem = fs::read(cert_path)?;
            let key_pem = fs::read(key_path)?;
            let ca_cert = X509::from_pem(&cert_pem).map_err(io_other)?;
            let ca_key = PKey::private_key_from_pem(&key_pem).map_err(io_other)?;
            return Ok(Self { ca_cert, ca_key });
        }

        if let Some(parent) = cert_path.parent() {
            fs::create_dir_all(parent)?;
        }
        if let Some(parent) = key_path.parent() {
            fs::create_dir_all(parent)?;
        }

        let (ca_cert, ca_key) = generate_ca_certificate()?;
        fs::write(cert_path, ca_cert.to_pem().map_err(io_other)?)?;
        fs::write(
            key_path,
            ca_key.private_key_to_pem_pkcs8().map_err(io_other)?,
        )?;
        set_private_key_permissions(key_path)?;

        Ok(Self { ca_cert, ca_key })
    }

    fn acceptor_for_host(&self, host: &str) -> io::Result<SslAcceptor> {
        let (leaf_cert, leaf_key) = self.generate_leaf_certificate(host)?;
        let mut builder =
            SslAcceptor::mozilla_intermediate_v5(SslMethod::tls_server()).map_err(io_other)?;
        builder.set_private_key(&leaf_key).map_err(io_other)?;
        builder.set_certificate(&leaf_cert).map_err(io_other)?;
        builder.check_private_key().map_err(io_other)?;
        Ok(builder.build())
    }

    fn generate_leaf_certificate(&self, host: &str) -> io::Result<(X509, PKey<Private>)> {
        let leaf_key = PKey::from_rsa(Rsa::generate(2048).map_err(io_other)?).map_err(io_other)?;
        let mut name = X509NameBuilder::new().map_err(io_other)?;
        name.append_entry_by_text("CN", host).map_err(io_other)?;
        let name = name.build();

        let mut builder = X509::builder().map_err(io_other)?;
        builder.set_version(2).map_err(io_other)?;
        let serial = random_serial_number()?;
        builder.set_serial_number(&serial).map_err(io_other)?;
        builder.set_subject_name(&name).map_err(io_other)?;
        builder
            .set_issuer_name(self.ca_cert.subject_name())
            .map_err(io_other)?;
        builder.set_pubkey(&leaf_key).map_err(io_other)?;

        let not_before = Asn1Time::days_from_now(0).map_err(io_other)?;
        let not_after = Asn1Time::days_from_now(30).map_err(io_other)?;
        builder
            .set_not_before(not_before.as_ref())
            .map_err(io_other)?;
        builder
            .set_not_after(not_after.as_ref())
            .map_err(io_other)?;

        let basic = BasicConstraints::new()
            .critical()
            .build()
            .map_err(io_other)?;
        builder.append_extension(basic).map_err(io_other)?;

        let key_usage = KeyUsage::new()
            .critical()
            .digital_signature()
            .key_encipherment()
            .build()
            .map_err(io_other)?;
        builder.append_extension(key_usage).map_err(io_other)?;

        let eku = ExtendedKeyUsage::new()
            .server_auth()
            .build()
            .map_err(io_other)?;
        builder.append_extension(eku).map_err(io_other)?;

        let mut san = SubjectAlternativeName::new();
        if host.parse::<IpAddr>().is_ok() {
            san.ip(host);
        } else {
            san.dns(host);
        }
        let san = san
            .build(&builder.x509v3_context(Some(&self.ca_cert), None))
            .map_err(io_other)?;
        builder.append_extension(san).map_err(io_other)?;

        let ski = SubjectKeyIdentifier::new()
            .build(&builder.x509v3_context(Some(&self.ca_cert), None))
            .map_err(io_other)?;
        builder.append_extension(ski).map_err(io_other)?;

        let aki = AuthorityKeyIdentifier::new()
            .keyid(true)
            .issuer(true)
            .build(&builder.x509v3_context(Some(&self.ca_cert), None))
            .map_err(io_other)?;
        builder.append_extension(aki).map_err(io_other)?;

        builder
            .sign(&self.ca_key, MessageDigest::sha256())
            .map_err(io_other)?;

        Ok((builder.build(), leaf_key))
    }
}

fn generate_ca_certificate() -> io::Result<(X509, PKey<Private>)> {
    let ca_key = PKey::from_rsa(Rsa::generate(4096).map_err(io_other)?).map_err(io_other)?;
    let mut name = X509NameBuilder::new().map_err(io_other)?;
    name.append_entry_by_text("CN", "internet-proxy local CA")
        .map_err(io_other)?;
    name.append_entry_by_text("O", "internet-proxy")
        .map_err(io_other)?;
    let name = name.build();

    let mut builder = X509::builder().map_err(io_other)?;
    builder.set_version(2).map_err(io_other)?;
    let serial = random_serial_number()?;
    builder.set_serial_number(&serial).map_err(io_other)?;
    builder.set_subject_name(&name).map_err(io_other)?;
    builder.set_issuer_name(&name).map_err(io_other)?;
    builder.set_pubkey(&ca_key).map_err(io_other)?;

    let not_before = Asn1Time::days_from_now(0).map_err(io_other)?;
    let not_after = Asn1Time::days_from_now(3650).map_err(io_other)?;
    builder
        .set_not_before(not_before.as_ref())
        .map_err(io_other)?;
    builder
        .set_not_after(not_after.as_ref())
        .map_err(io_other)?;

    let basic = BasicConstraints::new()
        .critical()
        .ca()
        .build()
        .map_err(io_other)?;
    builder.append_extension(basic).map_err(io_other)?;

    let key_usage = KeyUsage::new()
        .critical()
        .key_cert_sign()
        .crl_sign()
        .digital_signature()
        .build()
        .map_err(io_other)?;
    builder.append_extension(key_usage).map_err(io_other)?;

    let ski = SubjectKeyIdentifier::new()
        .build(&builder.x509v3_context(None, None))
        .map_err(io_other)?;
    builder.append_extension(ski).map_err(io_other)?;

    let aki = AuthorityKeyIdentifier::new()
        .keyid(true)
        .issuer(true)
        .build(&builder.x509v3_context(None, None))
        .map_err(io_other)?;
    builder.append_extension(aki).map_err(io_other)?;

    builder
        .sign(&ca_key, MessageDigest::sha256())
        .map_err(io_other)?;

    Ok((builder.build(), ca_key))
}

fn random_serial_number() -> io::Result<Asn1Integer> {
    let mut serial = BigNum::new().map_err(io_other)?;
    serial
        .rand(159, MsbOption::MAYBE_ZERO, false)
        .map_err(io_other)?;
    serial.to_asn1_integer().map_err(io_other)
}

#[cfg(unix)]
fn set_private_key_permissions(path: &Path) -> io::Result<()> {
    use std::os::unix::fs::PermissionsExt;

    let permissions = fs::Permissions::from_mode(0o600);
    fs::set_permissions(path, permissions)
}

#[cfg(not(unix))]
fn set_private_key_permissions(_path: &Path) -> io::Result<()> {
    Ok(())
}

#[derive(Debug)]
struct PrefixedStream<T> {
    prefix: Vec<u8>,
    offset: usize,
    inner: T,
}

impl<T> PrefixedStream<T> {
    fn new(inner: T, prefix: Vec<u8>) -> Self {
        Self {
            prefix,
            offset: 0,
            inner,
        }
    }
}

impl<T: Read> Read for PrefixedStream<T> {
    fn read(&mut self, buf: &mut [u8]) -> io::Result<usize> {
        if self.offset < self.prefix.len() {
            let remaining = self.prefix.len() - self.offset;
            let take = remaining.min(buf.len());
            buf[..take].copy_from_slice(&self.prefix[self.offset..self.offset + take]);
            self.offset += take;
            return Ok(take);
        }
        self.inner.read(buf)
    }
}

impl<T: Write> Write for PrefixedStream<T> {
    fn write(&mut self, buf: &[u8]) -> io::Result<usize> {
        self.inner.write(buf)
    }

    fn flush(&mut self) -> io::Result<()> {
        self.inner.flush()
    }
}
