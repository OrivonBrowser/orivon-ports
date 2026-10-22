//! The page a shared folder shows when it has no `index.html`: its files and
//! folders, linked, with sizes. Names are escaped and links percent-encoded;
//! the page runs no script and loads nothing, as its CSP says.

use std::path::Path;

use hyper::header;
use hyper::Response;
use percent_encoding::{utf8_percent_encode, AsciiSet, CONTROLS};

use crate::http::{bytes_body, set, with_type, Body};

/// What a path segment must escape to stay one segment of a URL.
const SEGMENT: &AsciiSet = &CONTROLS.add(b' ').add(b'"').add(b'#').add(b'%').add(b'<').add(b'>').add(b'?').add(b'`').add(b'{').add(b'}').add(b'/').add(b'\\').add(b'\'');

const CSP: &str = "default-src 'none'; style-src 'unsafe-inline'; img-src data:; base-uri 'none'; form-action 'none'";

pub fn page(root: &Path, relative: &Path, head_only: bool) -> Response<Body> {
    let mut entries: Vec<(String, bool, u64)> = std::fs::read_dir(root.join(relative))
        .map(|dir| {
            dir.filter_map(Result::ok)
                .filter_map(|entry| {
                    let name = entry.file_name().into_string().ok()?;
                    let meta = entry.metadata().ok()?;
                    Some((name, meta.is_dir(), meta.len()))
                })
                .collect()
        })
        .unwrap_or_default();
    entries.sort_by(|a, b| b.1.cmp(&a.1).then_with(|| a.0.to_lowercase().cmp(&b.0.to_lowercase())));
    let html = render(&relative.to_string_lossy(), &entries);
    let mut response = with_type(bytes_body(html.into_bytes(), head_only), "text/html; charset=utf-8");
    set(&mut response, header::CONTENT_SECURITY_POLICY, CSP);
    response
}

pub fn render(relative: &str, entries: &[(String, bool, u64)]) -> String {
    let title = if relative.is_empty() { "/".to_owned() } else { format!("/{}/", relative.trim_matches('/')) };
    let mut rows = String::new();
    if !relative.is_empty() {
        rows.push_str("<li class=\"up\"><a href=\"../\">..</a><span></span></li>\n");
    }
    for (name, is_dir, size) in entries {
        let href = utf8_percent_encode(name, SEGMENT).to_string();
        let (href, label, size) = if *is_dir {
            (format!("{href}/"), format!("{}/", escape(name)), String::new())
        } else {
            (href, escape(name), human_size(*size))
        };
        rows.push_str(&format!("<li><a href=\"{href}\">{label}</a><span>{size}</span></li>\n"));
    }
    if entries.is_empty() {
        rows.push_str("<li class=\"empty\">This folder is empty.</li>\n");
    }
    format!(
        "<!doctype html><html lang=\"en\"><head><meta charset=\"utf-8\"><meta name=\"viewport\" content=\"width=device-width, initial-scale=1\">\
<meta name=\"referrer\" content=\"no-referrer\"><title>Index of {title}</title><style>{STYLE}</style></head><body><main>\
<header><p class=\"kicker\">onion folder</p><h1>{title}</h1></header><ul>\n{rows}</ul>\
<footer>Served over Tor by TorSocks</footer></main></body></html>",
        title = escape(&title)
    )
}

pub fn escape(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    for c in text.chars() {
        match c {
            '&' => out.push_str("&amp;"),
            '<' => out.push_str("&lt;"),
            '>' => out.push_str("&gt;"),
            '"' => out.push_str("&quot;"),
            '\'' => out.push_str("&#39;"),
            c => out.push(c),
        }
    }
    out
}

fn human_size(bytes: u64) -> String {
    const UNITS: [&str; 5] = ["B", "KB", "MB", "GB", "TB"];
    let mut value = bytes as f64;
    let mut unit = 0;
    while value >= 1024.0 && unit < UNITS.len() - 1 {
        value /= 1024.0;
        unit += 1;
    }
    if unit == 0 {
        format!("{bytes} B")
    } else {
        format!("{value:.1} {}", UNITS[unit])
    }
}

const STYLE: &str = "\
:root{color-scheme:dark;--bg:#07090c;--panel:#0d1117;--line:#1d2530;--text:#d7e0ea;--muted:#7d8a99;--accent:#9d7cff;--accent2:#3ee6a8}\
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--text);font:15px/1.55 ui-monospace,SFMono-Regular,Menlo,Consolas,monospace}\
main{max-width:860px;margin:0 auto;padding:48px 20px}.kicker{color:var(--accent2);text-transform:uppercase;letter-spacing:.18em;font-size:12px;margin:0}\
h1{font-size:22px;margin:6px 0 28px;word-break:break-all}ul{list-style:none;margin:0;padding:0;border:1px solid var(--line);border-radius:10px;background:var(--panel)}\
li{display:flex;justify-content:space-between;gap:16px;padding:11px 16px;border-top:1px solid var(--line)}li:first-child{border-top:0}\
a{color:var(--accent);text-decoration:none;word-break:break-all}a:hover{text-decoration:underline}span{color:var(--muted);white-space:nowrap}\
.empty{color:var(--muted)}footer{margin-top:28px;color:var(--muted);font-size:12px}";

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn names_are_escaped_and_links_encoded() {
        let html = render("docs", &[("<b>&\".txt".into(), false, 2048), ("a b".into(), true, 0)]);
        assert!(html.contains("&lt;b&gt;&amp;&quot;.txt"));
        assert!(html.contains("href=\"%3Cb%3E&%22.txt\""));
        assert!(html.contains("href=\"a%20b/\""));
        assert!(html.contains("2.0 KB"));
        assert!(html.contains("href=\"../\""));
        assert!(!html.contains("<b>"));
    }
}
