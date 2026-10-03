# Architecture

`config.js` validates loopback listener/receiver configuration and header
redaction rules. `server.js` owns HTTP boundaries, bounded body collection,
dashboard assets, and API response mapping. Raw ordered headers and body bytes
are retained only after header redaction.

`store.js` encapsulates SQLite prepared statements, retention transactions,
page limits, and capture queries. `replay.js` forwards to a server-owned literal
loopback allowlist with redirect refusal, timeout, safe header selection, and
bounded response previews. Capture paths do not become replay destinations.

The browser uses text nodes for captured content, explicit status/error messages,
and filtering/detail controls. Storage and actual local receiver behavior are
tested together. The service is deliberately local and unauthenticated; a public
relay would require a separate authorization, isolation, and abuse-control design.
