# CaptainKrabs Keep-Alive Scheduler

Scheduled 24/7 cloud health check & authenticated daemon heartbeat runner on GitHub Actions.

- **Zero secrets in repository**: target URL and HMAC keys live exclusively in encrypted GitHub Actions Repository Secrets (`CK_RENDER_URL`, `DAEMON_API_KEY`, `DAEMON_SIGNING_KEY`).
- **Schedule**: every 5 minutes at off-peak minutes (`3,8,13,18,23,28,33,38,43,48,53,58 * * * *`).
- **Permissions**: `permissions: {}` (no repository write access needed).
