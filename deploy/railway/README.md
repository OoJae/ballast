# Public host on Railway

The public site runs here: https://ballast-public-production.up.railway.app

One container runs two processes:
- the market recorder;
- the read-only API, which also serves the built web app.

It holds no keys and never signs a Strike request, so it may run in any region. Railway's `sfo` region is on Strike's restricted list, so **never** run the keeper or the watchdog here.

## Layout

| Item              | Value                                                                                                                   |
| ----------------- | ----------------------------------------------------------------------------------------------------------------------- |
| Project / service | `ballast` / `ballast-public`                                                                                            |
| Build             | `deploy/railway/Dockerfile` (node 22, `pnpm install --frozen-lockfile`, `pnpm web:build`)                               |
| Start             | `deploy/railway/start.sh`: recorder and API side by side. If either exits, the container exits and Railway restarts it. |
| Volume            | `/data`; recordings go to `/data/recordings`                                                                            |
| Healthcheck       | `GET /` (timeout 300 s)                                                                                                 |
| API               | `BOOK_SOURCE=replay`, `WEB_DIST=/app/apps/web/dist`, listening on `$PORT`                                               |

The recordings on this host are its own hash-chained series, starting at its first deploy (2026-10-23 08:23 UTC). Recorders A (laptop) and B (Sonar-VPS2) keep independent chains. They are never merged into this one.

## Deploy

```bash
railway up --service ballast-public --detach -m "<summary>"
railway deployment list --service ballast-public --json   # wait for SUCCESS
```

`.dockerignore` and `.gitignore` keep internal files out of the upload and the image (checked inside the running container).

## Builder gotcha

Railway first built with Railpack ("No start command detected"). Two settings that looked like they should switch it to the Dockerfile did nothing:
- a `railway.json` (config-as-code, now deprecated) was ignored;
- `railway environment edit --service-config … build.builder DOCKERFILE` answered "No changes to apply".

What worked: setting the service instance's `dockerfilePath` through the GraphQL API, plus the service variable `RAILWAY_DOCKERFILE_PATH=deploy/railway/Dockerfile`. The next deploy's manifest showed `builder: DOCKERFILE`.
