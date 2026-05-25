# Security Policy

Please report security issues privately to security@sendblue.co.

Include the affected version, a concise reproduction, and any relevant logs. Do not open public issues for suspected vulnerabilities.

This project exposes browser automation and CDP controls by design. Keep `BROWSER_USE_API_KEY` secret, keep `BIND` and `CDP_BIND` on loopback unless protected by a trusted network boundary, and rotate the token if it may have been exposed.
