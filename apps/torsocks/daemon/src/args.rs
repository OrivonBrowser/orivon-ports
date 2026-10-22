//! The command line the page spawns the daemon with.

use std::path::PathBuf;

pub const USAGE: &str = "usage: torsocksd --data <dir> [--socks-port <port>[-<port>]] [--control-port <port>] [--publish <id>[,<id>...]]";

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Args {
    /// The app's TorSocks directory: `arti/`, `sites/` and `control.key` live here.
    pub data: PathBuf,
    /// The SOCKS5 ports to try, in order; the first free one is used.
    pub socks_ports: Vec<u16>,
    pub control_port: u16,
    /// Onion services to start at once, by id.
    pub publish: Vec<String>,
}

impl Args {
    pub fn parse(mut argv: impl Iterator<Item = String>) -> Result<Self, String> {
        let mut data = None;
        let mut socks_ports = vec![9150];
        let mut control_port = 9159;
        let mut publish = Vec::new();
        while let Some(flag) = argv.next() {
            let mut value = || argv.next().ok_or_else(|| format!("{flag} needs a value"));
            match flag.as_str() {
                "--data" => data = Some(PathBuf::from(value()?)),
                "--socks-port" => socks_ports = port_range(&value()?)?,
                "--control-port" => control_port = port(&value()?)?,
                "--publish" => {
                    publish = value()?.split(',').filter(|id| !id.is_empty()).map(str::to_owned).collect();
                    if let Some(bad) = publish.iter().find(|id| !crate::onion::valid_id(id)) {
                        return Err(format!("{bad:?} is not a service id"));
                    }
                }
                _ => return Err(format!("unknown argument {flag:?}")),
            }
        }
        let data = data.ok_or("--data is required")?;
        Ok(Self { data, socks_ports, control_port, publish })
    }
}

fn port(text: &str) -> Result<u16, String> {
    match text.parse::<u16>() {
        Ok(port) if port >= 1024 => Ok(port),
        _ => Err(format!("{text:?} is not a port from 1024 to 65535")),
    }
}

fn port_range(text: &str) -> Result<Vec<u16>, String> {
    let (first, last) = match text.split_once('-') {
        Some((a, b)) => (port(a)?, port(b)?),
        None => (port(text)?, port(text)?),
    };
    if last < first || last - first > 32 {
        return Err(format!("{text:?} is not a range of at most 33 ports"));
    }
    Ok((first..=last).collect())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn parse(line: &str) -> Result<Args, String> {
        Args::parse(line.split_whitespace().map(str::to_owned))
    }

    #[test]
    fn reads_every_flag() {
        let args = parse("--data /torsocks --socks-port 9150-9152 --control-port 9159 --publish a1,b2").unwrap();
        assert_eq!(args.data, PathBuf::from("/torsocks"));
        assert_eq!(args.socks_ports, vec![9150, 9151, 9152]);
        assert_eq!(args.control_port, 9159);
        assert_eq!(args.publish, vec!["a1", "b2"]);
    }

    #[test]
    fn refuses_what_it_cannot_honour() {
        assert!(parse("--socks-port 9150").is_err());
        assert!(parse("--data /d --socks-port 80").is_err());
        assert!(parse("--data /d --socks-port 9152-9150").is_err());
        assert!(parse("--data /d --publish ../x").is_err());
        assert!(parse("--data /d --verbose").is_err());
    }
}
