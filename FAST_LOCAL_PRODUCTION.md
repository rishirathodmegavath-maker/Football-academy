# Fast local mode (production build)

`npm run dev` compiles each page the first time it is opened and runs React's slower development build. The production build
opens the same pages in a fraction of a second.

```powershell
powershell -ExecutionPolicy Bypass -File scripts\local-production.ps1                 # build and start on port 3000
powershell -ExecutionPolicy Bypass -File scripts\local-production.ps1 -Port 3200 -StaySignedIn
powershell -ExecutionPolicy Bypass -File scripts\local-production.ps1 -SkipBuild      # nothing changed since the last build
```

- Data: a SQLite file in `.local\` (not committed). Back it up before experiments; `docs/OPERATIONS.md` describes the backup command.
- Each port gets its own session cookie name (`sz-fb-<port>`), so a Football and a Badminton server on one browser do not sign
  each other out. `-StaySignedIn` keeps a session for a year (`SPORTOZEN_SESSION_PERSISTENT=1`); without it the default 8 hour
  limit applies.
- If Turbopack stops with a panic when `node_modules` is a link, add `-Webpack`.
- Memory: the build needs a few GB. On a PC with about 8 GB, close other servers and Docker apps while it builds.
- A real deployment needs an HTTPS `BETTER_AUTH_URL` and `BETTER_AUTH_SECRET`; see `docs/DEPLOYMENT.md`.
