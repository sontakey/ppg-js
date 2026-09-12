# Security Policy

## Reporting a vulnerability

ppg-js is a client-side signal-processing library — it has no server, no
account system, and no network calls beyond loading the library itself. The
main risk surface is the debug log (`getDebugLog()` / `downloadDebugLog()`),
which can contain a user's camera-derived signal data, device user agent,
and screen dimensions if the caller chooses to export and share it.

If you find a security issue (e.g. a way the library could exfiltrate camera
data without the caller's action, or a supply-chain issue in a dependency),
please open a private report:

- Preferred: GitHub Security Advisories on this repository
  (`Security` tab -> `Report a vulnerability`)
- Alternative: open a regular issue without exploit details and ask for a
  private channel

Do not include personal health data or real device identifiers in a public
issue.

## Scope

This is a personal open-source project maintained on a best-effort basis.
There is no bug bounty and no guaranteed response time, but reports are
taken seriously and will be triaged.

## Not a medical device

ppg-js is not a certified medical device. Do not rely on it for diagnosis or
treatment decisions. This is a functionality statement, not a security one,
but it matters for how any reported issue should be prioritized.
