//! `shellexpand::path::full_with_context`, the one call Arti's
//! `tor-config-path` makes, for paths that are UTF-8.
//!
//! The real crate reads paths through `os_str_bytes` 6, which uses
//! `std::os::wasi`, a module only nightly Rust offers on `wasm32-wasip2`.
//! TorSocks gives Arti literal UTF-8 paths, so a path that is not UTF-8 is
//! returned unexpanded rather than read byte by byte. The grammar is the real
//! crate's: a leading `~` (alone or before `/`), `$NAME`, `${NAME}` and
//! `${NAME:-default}`, a lookup answering `None` leaving the text as written.

use std::fmt;

/// A variable whose lookup failed, and why.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LookupError<E> {
    pub var_name: String,
    pub cause: E,
}

impl<E: fmt::Display> fmt::Display for LookupError<E> {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "error looking key '{}' up: {}", self.var_name, self.cause)
    }
}

impl<E: fmt::Display + fmt::Debug> std::error::Error for LookupError<E> {}

pub mod path {
    use std::borrow::Cow;
    use std::path::{Path, PathBuf};

    use super::LookupError;

    pub fn full_with_context<SI, CO, C, E, P, HD>(input: &SI, home_dir: HD, mut context: C) -> Result<Cow<'_, Path>, LookupError<E>>
    where
        SI: AsRef<Path> + ?Sized,
        CO: AsRef<Path>,
        C: FnMut(&str) -> Result<Option<CO>, E>,
        P: AsRef<Path>,
        HD: FnOnce() -> Option<P>,
    {
        let path = input.as_ref();
        let Some(text) = path.to_str() else {
            return Ok(Cow::Borrowed(path));
        };
        let after_vars = expand_vars(text, &mut context)?;
        let expanded = expand_tilde(&after_vars, home_dir);
        if expanded == text {
            Ok(Cow::Borrowed(path))
        } else {
            Ok(Cow::Owned(PathBuf::from(expanded)))
        }
    }

    fn expand_tilde<P: AsRef<Path>, HD: FnOnce() -> Option<P>>(text: &str, home_dir: HD) -> String {
        let Some(rest) = text.strip_prefix('~') else {
            return text.to_owned();
        };
        if !(rest.is_empty() || rest.starts_with('/') || (cfg!(windows) && rest.starts_with('\\'))) {
            return text.to_owned();
        }
        match home_dir().as_ref().and_then(|home| home.as_ref().to_str().map(str::to_owned)) {
            Some(home) => format!("{home}{rest}"),
            None => text.to_owned(),
        }
    }

    fn is_name_char(c: char) -> bool {
        c.is_ascii_alphanumeric() || c == '_'
    }

    fn expand_vars<CO, C, E>(text: &str, context: &mut C) -> Result<String, LookupError<E>>
    where
        CO: AsRef<Path>,
        C: FnMut(&str) -> Result<Option<CO>, E>,
    {
        let mut out = String::with_capacity(text.len());
        let mut rest = text;
        while let Some(dollar) = rest.find('$') {
            out.push_str(&rest[..dollar]);
            let after = &rest[dollar + 1..];
            if let Some(braced) = after.strip_prefix('{') {
                let Some(close) = braced.find('}') else {
                    // An unclosed brace is kept as written, as the real crate keeps it.
                    out.push_str(&rest[dollar..]);
                    return Ok(out);
                };
                let inner = &braced[..close];
                let (name, default) = match inner.split_once(":-") {
                    Some((name, default)) => (name, Some(default)),
                    None => (inner, None),
                };
                match lookup(name, context)? {
                    Some(value) => out.push_str(&value),
                    None => match default {
                        Some(default) => out.push_str(&expand_vars(default, context)?),
                        None => out.push_str(&rest[dollar..dollar + 2 + close + 1]),
                    },
                }
                rest = &braced[close + 1..];
            } else {
                let end = after.find(|c: char| !is_name_char(c)).unwrap_or(after.len());
                if end == 0 {
                    out.push('$');
                } else {
                    let name = &after[..end];
                    match lookup(name, context)? {
                        Some(value) => out.push_str(&value),
                        None => out.push_str(&rest[dollar..dollar + 1 + end]),
                    }
                }
                rest = &after[end..];
            }
        }
        out.push_str(rest);
        Ok(out)
    }

    fn lookup<CO, C, E>(name: &str, context: &mut C) -> Result<Option<String>, LookupError<E>>
    where
        CO: AsRef<Path>,
        C: FnMut(&str) -> Result<Option<CO>, E>,
    {
        match context(name) {
            Ok(Some(value)) => Ok(Some(value.as_ref().to_string_lossy().into_owned())),
            Ok(None) => Ok(None),
            Err(cause) => Err(LookupError { var_name: name.to_owned(), cause }),
        }
    }

    #[cfg(test)]
    mod tests {
        use super::*;

        fn expand(input: &str) -> Result<String, LookupError<&'static str>> {
            full_with_context(
                input,
                || Some("/home/u"),
                |name| match name {
                    "ARTI_CACHE" => Ok(Some("/data/cache")),
                    "EMPTY" => Ok(Some("")),
                    "BAD" => Err("refused"),
                    _ => Ok(None),
                },
            )
            .map(|p| p.to_string_lossy().into_owned())
        }

        #[test]
        fn expands_variables_and_home() {
            assert_eq!(expand("${ARTI_CACHE}/dir").unwrap(), "/data/cache/dir");
            assert_eq!(expand("$ARTI_CACHE/dir").unwrap(), "/data/cache/dir");
            assert_eq!(expand("~/x").unwrap(), "/home/u/x");
            assert_eq!(expand("~").unwrap(), "/home/u");
            assert_eq!(expand("a${EMPTY}b").unwrap(), "ab");
            assert_eq!(expand("${NOPE:-/fallback}/x").unwrap(), "/fallback/x");
            assert_eq!(expand("${NOPE:-$ARTI_CACHE}").unwrap(), "/data/cache");
        }

        #[test]
        fn leaves_what_it_cannot_expand() {
            assert_eq!(expand("/literal/path").unwrap(), "/literal/path");
            assert_eq!(expand("$NOPE/x").unwrap(), "$NOPE/x");
            assert_eq!(expand("${NOPE}/x").unwrap(), "${NOPE}/x");
            assert_eq!(expand("cost $5").unwrap(), "cost $5");
            assert_eq!(expand("a $ b").unwrap(), "a $ b");
            assert_eq!(expand("${open").unwrap(), "${open");
            assert_eq!(expand("~user/x").unwrap(), "~user/x");
            assert_eq!(expand("x/~").unwrap(), "x/~");
        }

        #[test]
        fn reports_a_failed_lookup_by_name() {
            let error = expand("${BAD}").unwrap_err();
            assert_eq!(error.var_name, "BAD");
            assert_eq!(error.cause, "refused");
        }
    }
}
