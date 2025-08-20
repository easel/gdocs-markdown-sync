Security Policy

Auth & Credentials

- OAuth (CLI): `npm run cli -- auth` launches PKCE flow and stores a refreshable token at `~/.config/gdocs-markdown-sync/tokens-<profile>.json` (default profile `default`). Restrict file permissions and never commit tokens.
- OAuth (Plugin): configure Client ID/Secret in settings and run “Start Auth Flow”.

Scopes

- Request minimal Drive/Docs scopes:
  - `drive`, `drive.file`, and `documents` for required read/write operations

Reporting

- Please open a security-related issue with minimal details; we will provide a secure channel for follow-up.

Logging

- Avoid logging document contents, tokens, or full headers. Prefer hashed IDs where practical.

Profiles

- Multiple accounts supported via profile names (`tokens-<profile>.json`).
