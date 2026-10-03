# Verification

Local evidence recorded on 2026-10-03.

## Passed

4 integration tests passed using real SQLite files and local HTTP receivers. They exercise capture/filter/redaction/retention/limits, exact-body replay, redirect refusal, and origin/Host checks. Chromium acceptance sent a synthetic webhook and selected its dashboard history entry; body, query, and redacted headers rendered correctly.

## Environment and limits

Windows Node.js 22.14.0. Built-in SQLite is experimental at this minimum version. Browser replay was not exercised; integration tests verify its actual HTTP receiver behavior. No public deployment is supported.

The checked-in CI workflow is ready to run when published. It is configuration,
not evidence of a hosted pass. Re-run README commands after changing dependencies
or moving to another platform. Screenshots, where included, use synthetic data.
