# Security

Do not publish administrator credentials, `private/`, `.dev.vars`, database exports, session cookies or subscription URLs containing access tokens. They are excluded from Git by default.

Initialization generates independent administrator credentials and refuses to overwrite existing initialization files. Import its SQL only into a new database. Change an existing password through the authenticated settings page.

If a secret is exposed, rotate it in your own deployment: change the administrator password, replace affected subscription tokens, and rotate `SESSION_SECRET` as needed. Deleting a file from the latest commit does not remove it from Git history.

Use [GitHub private vulnerability reporting](https://github.com/liumw/iptv-source-cloudflare/security/advisories/new) if enabled. If it is unavailable, open an issue asking for a private reporting channel without including secrets or exploit details.
