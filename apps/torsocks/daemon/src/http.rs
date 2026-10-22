//! The HTTP/1.1 server behind each onion service: static files from the
//! service's `www` directory, GET and HEAD only, with byte ranges so a large
//! file resumes and a video seeks. Nothing it sends names the host: no `Date`
//! (a clock's skew can single a host out), no `Server`, no file times.

use std::convert::Infallible;
use std::io::{Read, Seek, SeekFrom};
use std::path::{Path, PathBuf};
use std::time::Duration;

use bytes::Bytes;
use http_body_util::{combinators::BoxBody, BodyExt, Full, StreamBody};
use hyper::body::Frame;
use hyper::header::{self, HeaderValue};
use hyper::{Method, Request, Response, StatusCode};
use hyper_util::rt::{TokioIo, TokioTimer};

use crate::listing;

const CHUNK: usize = 64 * 1024;
const WHOLE_FILE_LIMIT: u64 = 1024 * 1024;

pub type Body = BoxBody<Bytes, std::io::Error>;

pub async fn serve(stream: arti_client::DataStream, root: PathBuf, listing: bool) {
    let service = hyper::service::service_fn(move |request| {
        let root = root.clone();
        async move { Ok::<_, Infallible>(respond(&request, &root, listing)) }
    });
    let mut builder = hyper::server::conn::http1::Builder::new();
    builder.auto_date_header(false).timer(TokioTimer::new()).header_read_timeout(Duration::from_secs(60));
    if let Err(e) = builder.serve_connection(TokioIo::new(stream), service).await {
        tracing::debug!("onion HTTP connection ended: {e}");
    }
}

fn respond<B>(request: &Request<B>, root: &Path, listing: bool) -> Response<Body> {
    let head_only = request.method() == Method::HEAD;
    if request.method() != Method::GET && !head_only {
        return simple(StatusCode::METHOD_NOT_ALLOWED, "This site only serves files.");
    }
    let Some(relative) = safe_relative_path(request.uri().path()) else {
        return simple(StatusCode::BAD_REQUEST, "That address is not a file of this site.");
    };
    let mut target = root.join(&relative);
    if target.is_dir() {
        if !request.uri().path().ends_with('/') {
            let location = format!("{}/", request.uri().path());
            let mut response = simple(StatusCode::MOVED_PERMANENTLY, "Moved.");
            if let Ok(value) = HeaderValue::from_str(&location) {
                response.headers_mut().insert(header::LOCATION, value);
            }
            return response;
        }
        let index = target.join("index.html");
        if index.is_file() {
            target = index;
        } else if listing {
            return listing::page(root, &relative, head_only);
        } else {
            return not_found(root, head_only);
        }
    }
    if !target.is_file() {
        return not_found(root, head_only);
    }
    match file_response(&target, request.headers().get(header::RANGE), head_only) {
        Ok(response) => response,
        Err(e) => {
            tracing::warn!("could not read a published file: {e}");
            simple(StatusCode::INTERNAL_SERVER_ERROR, "The file could not be read.")
        }
    }
}

/// The request path as a path under the site root, or `None` for anything that could leave it.
pub fn safe_relative_path(raw: &str) -> Option<PathBuf> {
    let decoded = percent_encoding::percent_decode_str(raw).decode_utf8().ok()?;
    let mut path = PathBuf::new();
    for segment in decoded.split('/') {
        match segment {
            "" | "." => continue,
            ".." => return None,
            s if s.contains('\\') || s.contains('\0') || s.contains(':') => return None,
            s => path.push(s),
        }
    }
    Some(path)
}

fn not_found(root: &Path, head_only: bool) -> Response<Body> {
    let custom = root.join("404.html");
    if let Ok(bytes) = std::fs::read(&custom) {
        let mut response = with_type(bytes_body(bytes, head_only), "text/html; charset=utf-8");
        *response.status_mut() = StatusCode::NOT_FOUND;
        return response;
    }
    simple(StatusCode::NOT_FOUND, "There is no such file on this site.")
}

fn file_response(path: &Path, range: Option<&HeaderValue>, head_only: bool) -> std::io::Result<Response<Body>> {
    let mut file = std::fs::File::open(path)?;
    let size = file.metadata()?.len();
    let content_type = content_type_of(path);
    let (status, start, end) = match range.and_then(|r| r.to_str().ok()).map(|r| parse_range(r, size)) {
        Some(Some((start, end))) => (StatusCode::PARTIAL_CONTENT, start, end),
        Some(None) => {
            let mut response = simple(StatusCode::RANGE_NOT_SATISFIABLE, "That range is outside the file.");
            set(&mut response, header::CONTENT_RANGE, &format!("bytes */{size}"));
            return Ok(response);
        }
        None => (StatusCode::OK, 0, size.saturating_sub(1)),
    };
    let length = if size == 0 { 0 } else { end - start + 1 };
    let body = if head_only || length == 0 {
        empty()
    } else if length <= WHOLE_FILE_LIMIT {
        file.seek(SeekFrom::Start(start))?;
        let mut bytes = vec![0; length as usize];
        file.read_exact(&mut bytes)?;
        Full::new(Bytes::from(bytes)).map_err(|never| match never {}).boxed()
    } else {
        file.seek(SeekFrom::Start(start))?;
        chunked(file, length)
    };
    let mut response = with_type(body, content_type);
    *response.status_mut() = status;
    set(&mut response, header::CONTENT_LENGTH, &length.to_string());
    set(&mut response, header::ACCEPT_RANGES, "bytes");
    if status == StatusCode::PARTIAL_CONTENT {
        set(&mut response, header::CONTENT_RANGE, &format!("bytes {start}-{end}/{size}"));
    }
    Ok(response)
}

/// One `bytes=` range, as an inclusive `(start, end)`; `None` when it cannot be served.
pub fn parse_range(header: &str, size: u64) -> Option<(u64, u64)> {
    let spec = header.trim().strip_prefix("bytes=")?;
    if spec.contains(',') || size == 0 {
        return None;
    }
    let (first, last) = spec.split_once('-')?;
    let (start, end) = match (first.trim(), last.trim()) {
        ("", suffix) => {
            let n: u64 = suffix.parse().ok()?;
            if n == 0 {
                return None;
            }
            (size.saturating_sub(n), size - 1)
        }
        (start, "") => (start.parse().ok()?, size - 1),
        (start, end) => (start.parse().ok()?, end.parse::<u64>().ok()?.min(size - 1)),
    };
    (start <= end && start < size).then_some((start, end))
}

/// Streams `length` bytes from the file's current position, a chunk at a time.
fn chunked(file: std::fs::File, length: u64) -> Body {
    let chunks = futures::stream::unfold((file, length), |(mut file, left)| async move {
        if left == 0 {
            return None;
        }
        let want = left.min(CHUNK as u64) as usize;
        let mut buffer = vec![0; want];
        match file.read(&mut buffer) {
            Ok(0) => None,
            Ok(n) => {
                buffer.truncate(n);
                Some((Ok(Frame::data(Bytes::from(buffer))), (file, left - n as u64)))
            }
            Err(e) => Some((Err(e), (file, 0))),
        }
    });
    StreamBody::new(chunks).boxed()
}

pub fn content_type_of(path: &Path) -> &'static str {
    let extension = path.extension().and_then(|e| e.to_str()).unwrap_or("").to_ascii_lowercase();
    match extension.as_str() {
        "html" | "htm" => "text/html; charset=utf-8",
        "css" => "text/css; charset=utf-8",
        "js" | "mjs" => "text/javascript; charset=utf-8",
        "json" | "map" => "application/json",
        "txt" | "md" => "text/plain; charset=utf-8",
        "xml" => "application/xml",
        "svg" => "image/svg+xml",
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "gif" => "image/gif",
        "webp" => "image/webp",
        "avif" => "image/avif",
        "ico" => "image/x-icon",
        "bmp" => "image/bmp",
        "woff" => "font/woff",
        "woff2" => "font/woff2",
        "ttf" => "font/ttf",
        "otf" => "font/otf",
        "mp4" | "m4v" => "video/mp4",
        "webm" => "video/webm",
        "ogv" => "video/ogg",
        "mp3" => "audio/mpeg",
        "ogg" | "oga" => "audio/ogg",
        "wav" => "audio/wav",
        "flac" => "audio/flac",
        "pdf" => "application/pdf",
        "wasm" => "application/wasm",
        "zip" => "application/zip",
        _ => "application/octet-stream",
    }
}

pub fn simple(status: StatusCode, text: &'static str) -> Response<Body> {
    let mut response = with_type(Full::new(Bytes::from_static(text.as_bytes())).map_err(|never| match never {}).boxed(), "text/plain; charset=utf-8");
    *response.status_mut() = status;
    response
}

pub fn bytes_body(bytes: Vec<u8>, head_only: bool) -> Body {
    if head_only {
        empty()
    } else {
        Full::new(Bytes::from(bytes)).map_err(|never| match never {}).boxed()
    }
}

fn empty() -> Body {
    Full::new(Bytes::new()).map_err(|never| match never {}).boxed()
}

/// A response with its type and the headers every answer carries.
pub fn with_type(body: Body, content_type: &str) -> Response<Body> {
    let mut response = Response::new(body);
    set(&mut response, header::CONTENT_TYPE, content_type);
    set(&mut response, header::X_CONTENT_TYPE_OPTIONS, "nosniff");
    set(&mut response, header::REFERRER_POLICY, "no-referrer");
    set(&mut response, header::CACHE_CONTROL, "no-cache");
    response
}

pub fn set(response: &mut Response<Body>, name: header::HeaderName, value: &str) {
    if let Ok(value) = HeaderValue::from_str(value) {
        response.headers_mut().insert(name, value);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn paths_stay_under_the_root() {
        assert_eq!(safe_relative_path("/a/b.html"), Some(PathBuf::from("a/b.html")));
        assert_eq!(safe_relative_path("/"), Some(PathBuf::new()));
        assert_eq!(safe_relative_path("/my%20file.txt"), Some(PathBuf::from("my file.txt")));
        assert_eq!(safe_relative_path("/../x"), None);
        assert_eq!(safe_relative_path("/a/%2e%2e/%2e%2e/x"), None);
        assert_eq!(safe_relative_path("/a%5c..%5cx"), None);
        assert_eq!(safe_relative_path("/c:/x"), None);
        assert_eq!(safe_relative_path("/%00"), None);
        assert_eq!(safe_relative_path("/%ff"), None);
    }

    #[test]
    fn ranges_are_clamped_or_refused() {
        assert_eq!(parse_range("bytes=0-99", 1000), Some((0, 99)));
        assert_eq!(parse_range("bytes=900-", 1000), Some((900, 999)));
        assert_eq!(parse_range("bytes=-100", 1000), Some((900, 999)));
        assert_eq!(parse_range("bytes=990-2000", 1000), Some((990, 999)));
        assert_eq!(parse_range("bytes=1000-", 1000), None);
        assert_eq!(parse_range("bytes=5-1", 1000), None);
        assert_eq!(parse_range("bytes=0-1,5-6", 1000), None);
        assert_eq!(parse_range("bytes=-0", 1000), None);
        assert_eq!(parse_range("items=0-1", 1000), None);
    }
}
