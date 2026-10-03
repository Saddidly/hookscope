# Security policy

Please report vulnerabilities privately to the repository maintainer. No private reporting address is configured in this source tree; use the repository host's private vulnerability reporting feature when one is available.

HookScope is a local debugging tool. It binds to `127.0.0.1` by default, has no user authentication, and stores webhook payloads on disk. Anyone who can reach its HTTP listener can inspect and delete captures and invoke configured replay targets. Do not expose it to a public or shared network without adding an appropriate authentication and network boundary.

Replay targets must be explicitly configured and use a literal loopback IP. HookScope does not accept caller-supplied URLs, follows no redirects, and bounds the response preview. Sensitive request headers are redacted before storage. Request bodies and query strings may still contain secrets; protect the data directory and remove captures when they are no longer needed.
