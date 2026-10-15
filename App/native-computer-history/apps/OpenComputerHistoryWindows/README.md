# Windows History recorder

This helper uses a persistent Go supervisor, Windows low-level input/foreground
hooks, and a persistent PowerShell UI Automation worker. It does not capture
screenshots and does not send individual keystrokes or printable virtual-key
codes to the recorder. The common Node History layer still owns saved app/site
policy, retention, redaction, summaries and Memory.

`--observe --parent-pid <Node PID> --wechat-consent <live consent.json>` starts
the observer. Stdin EOF or `{"kind":"stop"}` stops it. The owning process is
held through a Windows process handle; a kill-on-close job covers the helper
and every UIA worker. UIA calls have a four-second hard process deadline and a
two-second tree traversal budget. Failed workers restart with bounded backoff.

Full trees contain at most 400 nodes and 120,000 characters. Full reads are
limited to one per second; unchanged idle windows refresh every four seconds.
An idle one-second probe checks only foreground identity and local event
counters when nothing changed. Typing is coalesced until one second of quiet.
Keyboard output records an action category/count, never raw typed characters.
Current safe UIA field values remain visible-content evidence and follow the
common History retention policy.

Browser windows are read whatever their browsing mode; the user's website
exclusions decide what is kept. A page address is recorded only when it is the
top-level Document's committed URI. While the address bar is being edited or
the page is loading, the event carries no address. HWND, process and URL are
verified before and after reads. WeChat consent is re-read before and after
each observation; passwords and their descendants are never read. The
Windows browser authority sidecar remains available to corroborate normal
Chrome/Edge addresses and keeps excluded URLs and titles out of its file.
Extension DOM History retains its separate private-tab protections.

Actions must carry a recent verified window/URL/focus/navigation origin and
remain fresh. Stale or mismatched actions are dropped and replaced with a new
current-state observation. A control that appeared after the click is never
used to name that earlier click. Click labels come only from a bounded previous
authorized snapshot cache of runtime IDs, bounds and labels, with no values.
Current hit-test runtime IDs must match that cache; a newly captured tree only
serves later actions. Name/structure/value/focus changes invalidate proof.
This can omit actions when UIA is slow or
changes cannot be proven; it avoids attributing excluded-page actions or old
field values to a newly allowed page.

Pure validation (no hooks, desktop reads or UIA listeners):

```sh
go test -race ./...
go vet ./...
go run . --self-test
GOOS=windows GOARCH=amd64 go build .
GOOS=windows GOARCH=arm64 go build .
```

On Windows, `powershell -NoProfile -MTA -File worker.ps1 -SelfTest` compiles the
real UIA API declarations and exercises synthetic consent/sanitization
fixtures without accessing the desktop. These checks do not prove installed
runtime/GUI behavior, browser profile coverage, latency, CPU usage or battery
impact. User-run Windows acceptance is required for those claims.
