# Verification

Local evidence recorded on 2026-10-03.

## Passed

4 integration tests passed using real SQLite files and local HTTP receivers. They exercise capture/filter/redaction/retention/limits, exact-body replay, redirect refusal, and origin/Host checks. Chromium acceptance sent a synthetic webhook and selected its dashboard history entry; body, query, and redacted headers rendered correctly.

## Environment and limits

Windows Node.js 22.14.0. Built-in SQLite is experimental at this minimum version. Browser replay was not exercised; integration tests verify its actual HTTP receiver behavior. No public deployment is supported.

## Hosted evidence

[GitHub Actions run](https://github.com/Saddidly/hookscope/actions/runs/37111967349) passed on 2026-10-03 for code revision `aa3d3952705b45839f68854d6a3e79a5090ca48f`.

Ubuntu, Node 22/24; HTTP/SQLite integration tests and Chromium desktop/mobile capture, filter, redaction, replay restriction, and deletion flows.

These checks cover the named environments and cases, not every possible input or platform. Re-run README commands after changing dependencies or moving to another platform. Screenshots and acceptance data are synthetic.

