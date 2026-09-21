# Security

## Reporting

Report a vulnerability through GitHub's private advisory form on this repository, or to the
address in the Orivon shell repository's `SECURITY.md`. Please do not open a public issue for
an unfixed vulnerability.

## What this repository is, in security terms

**Building a port runs third-party code on your machine.** `orivon-port build` executes the
app's own install and build scripts, with your privileges. There is no way to build somebody's
application without running their toolchain, so this is inherent rather than a shortcoming to
be fixed.

What the executor does about it:

- **Every recipe pins a commit**, never a branch or a tag. What you build today is what you
  built yesterday, and a compromised upstream tag does not silently change it. `check:pinned`
  enforces this.
- **Nothing of theirs is ever committed here**, so this repository cannot become a distribution
  channel for a tampered build. `check:no-upstream` enforces this.
- **A recipe is reviewable.** It is a small JSON file naming a repository, a commit and a
  handful of commands — read it before running it, the same as any build script.

What it does *not* do: sandbox the build, verify a signature on the upstream commit, or audit
the app's dependency tree. If you are building a port of an app you do not trust, do it
somewhere you would run any untrusted build.

## The served app

A prepared app is static files served over plain HTTP on `127.0.0.1`. The server reads files off
disk and does nothing else. It is a development host, not a deployment: it has no TLS, no access
control, and it binds the loopback interface deliberately.

**The capabilities an app gets are the ones its manifest declares and a person accepted.** A
bridge cannot grant itself anything; it calls `orivon.*` like any other page, and the broker in
the shell decides. A port that seems to need a power Orivon will not give is a port that should
refuse by name, not one that should find a way around.

## Bridge code

A bridge runs inside the app's own origin with whatever that origin was granted. Two rules
follow, and both are in the porting guide:

- **Refuse by name, never by absence**, so a member Orivon cannot honour fails with a reason
  rather than as `undefined is not a function`.
- **Never manufacture a host path** to satisfy an app that expects one. The opaque handle exists
  to stop paths leaking; faking one reintroduces exactly what it prevents.
