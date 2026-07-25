# CodeDB Security Policy

First off, thank you for helping keep **CodeDB** secure! We take security seriously and appreciate responsible disclosure of security vulnerabilities.

---

## Reporting a Vulnerability

If you discover a security vulnerability within **CodeDB**, please report it responsibly:

- **Private Disclosure:** Do **NOT** open a public GitHub issue for security vulnerabilities.
- **How to Report:** Submit a private security advisory via [GitHub Security Advisories](https://github.com/federicoferrulli/CodeDB/security/advisories/new) or contact the project maintainer directly.
- **Response Timeline:** We aim to acknowledge receipt of security reports within **48 hours** and provide a patch or resolution path promptly.

---

## CodeDB Security Architecture & Boundaries

Understanding CodeDB's security architecture helps put vulnerability reports in context:

### 1. Credentials & Secrets Encryption (Vault)
- **AES-256-GCM Encryption:** Saved database connections in `connections.ini` encrypt sensitive fields (passwords, SSH passphrases, private keys) using AES-256-GCM derived from a user-defined Master Passphrase.
- **Zero Raw Exposure:** Saved credentials are **never sent back to the browser**. Form fields for existing connections remain empty and retain server-side secrets on submission.
- **Fail-Safe Decryption:** If decryption fails (e.g. incorrect Master Passphrase), the application refuses to start or load secrets, preventing unencrypted overwrites or secret zeroing. Backup copies (`connections.ini.bak`, `.bak2`) are preserved automatically.

### 2. AI Model Context Protocol (MCP) Gateway
- **Read-Only by Default:** The `/mcp` gateway enforces read-only mode for query tools (`execute_query`, `get_schema`, `audit_schema`, `analyze_pii`, etc.).
- **SQL / MQL Query Sanitization:** SQL queries are sanitized with strict token whitelisting (`SELECT`, `WITH`, `SHOW`, `EXPLAIN`, etc.) and executed within a `READ ONLY` transaction. MongoDB pipelines block destructive stages such as `$out` and `$merge`.
- **Human-in-the-Loop Confirmation:** Modifying operations (`execute_write`, `restore_backup`, `set_connection_read_only`) require explicit human confirmation via single-use `confirm_token` tokens.
- **Credential Masking:** AI clients connect using saved connection names/IDs — raw database credentials and connection parameters are never exposed to AI models.

### 3. Local Binding & Transport Security
- **Local Access:** By default, CodeDB binds to `localhost` (`127.0.0.1`). If exposing the application over public networks, you should place it behind an authenticated reverse proxy (e.g., Nginx, Caddy, or Cloudflare Tunnels) with HTTPS enabled.
- **SSH Tunneling:** Remote database connections support encrypted SSH tunnels (password or RSA/Ed25519 private keys with passphrase) via `ssh2`.

---

## Security Best Practices for Users

- **Keep Updated:** Always use the latest version of CodeDB to ensure you have the latest security patches.
- **Strong Master Passphrase:** Set a strong Master Passphrase to protect your saved credentials in `connections.ini`.
- **Protected Environment:** Do not expose unauthenticated CodeDB HTTP/Socket instances directly to the public internet.

Thank you for helping keep CodeDB secure!
