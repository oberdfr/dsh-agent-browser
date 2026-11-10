# dsh-agent-browser

An embedded Browser for the [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) right sidebar: **one Chromium, one compact tool, one shared session** between you and the agent.

The agent does not drive a separate headless browser. It drives the same panel you are looking at, so you can watch every step, take over at any moment, and hand a tab over explicitly.

## What it gives you

- **One tool for the agent**: `browser({ op, tab?, args? })` with `help` on demand instead of a wall of tool definitions.
- **A real embedded Chromium** in the sidebar, with tabs, an address bar, history and a viewport selector.
- **Shared control**: tabs opened by the agent are separate from yours; a tab you opened is only reachable by the agent after you share it.
- **Page work**: navigation, snapshot, inspection, extraction, waiting, scrolling, frames, accessibility audit.
- **Input**: DOM events and native `sendInputEvent`, without stealing focus.
- **Scripting**: `js.eval` with arguments separated from code and a bounded result.
- **Network and API work**: observed requests, request bodies on request, endpoint inventory, replay, cURL/fetch/OpenAPI export, page-context and Host-mode requests.
- **Declarative tests**: `test.run` with actions, waits, assertions and proofs.
- **Diagnostics drawer**: Network/API, Console, Test and Reports tabs fed by the live page.
- **Artifacts**: bounded results with handles instead of megabytes in the context.

## Install

From the DSH plugin manager, install this repository directory, or:

```sh
dsh plugin --profile web add <owner>/dsh-agent-browser
```

Then hard-refresh the browser (Ctrl/Cmd+Shift+R).

Requires DSH `0.2.2-rc.1` or newer. The package declares `dsh.bundle`, so the profile loads it as a bundle patch that inserts one `dsh-agent-browser` row.

## Requirements

- `@deepseek-ai/schemastery` and `zod` are peer dependencies, resolved from the DSH installation.

## Known limits

These are declared, not hidden:

- **Native screenshots** (`image.capture`) do not currently return pixels from the embedded webview: the call ends in `CAPTURE_TIMEOUT`. Treat screenshot capture as unavailable.
- **PDF** (`image.pdf`) is gated with `PDF_NOT_SMOKE_TESTED` until a packaged smoke test is run.
- **No companion, no CDP port, no second browser.** The panel uses public Electron webview APIs only, so DevTools are not exposed through the tool.
- **Network observation** is page-level (PerformanceObserver plus fetch/XHR/WebSocket wrappers). Worker, Service Worker and cross-origin frame traffic are not observed, and requests started before the hook have timing only.
- **Synthetic DOM input is not trusted input**; native input requires existing guest focus and never steals it.
- **Closed shadow roots and cross-origin frames** are listed but not inspected.
- **Login persistence across restarts is not guaranteed**: partitions are temporary by policy.

## License

MIT. This package embeds a modified copy of the OpenChamber Browser panel Client, also MIT; see `vendor/LICENSE.openchamber` and `vendor/annotations/NOTICE.md`.
