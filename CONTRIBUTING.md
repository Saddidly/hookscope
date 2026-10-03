# Contributing

Thanks for helping improve HookScope. Keep changes focused and include behavior tests for API, storage, security, and replay changes.

## Development

HookScope uses Node.js 22.14 or newer and has no npm runtime dependencies. The built-in `node:sqlite` module is experimental in Node 22.14; this version is the tested minimum.

```sh
npm ci
npm run check
npm test
```

## Design constraints

- Keep loopback binding as the default.
- Do not add arbitrary URL forwarding or redirect-following to replay.
- Keep capture count, body size, response previews, and request parsing bounded.
- Redact sensitive headers before they reach storage or the dashboard.
- Do not log captured bodies, headers, or query values.
- Document any change to data retention, redaction, or replay restrictions.
