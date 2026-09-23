# Deploying this fork to production

This fork adds native WhatsApp (Interakt) and Mobile Push (FCM) channels. Because those
changes are not in any published Dittofeed image, production must run an image built
from **this repository**. Everything below assumes that.

Topology: one `lite` container for the web tier, one `worker` container for journeys,
Postgres and ClickHouse containerized on the same VM. All three application containers
run **the same image**.

- [docker-compose.prod.yaml](docker-compose.prod.yaml) — the stack
- [docker-compose.tailnet.yaml](docker-compose.tailnet.yaml) — optional overlay to publish on a tailnet address as well as loopback
- [compose.sh](compose.sh) — wrapper that applies the right compose files and env file; prefer it over calling `docker compose` directly
- [.env.prod.example](.env.prod.example) — the environment template
- [.github/workflows/docker-build-publish.yaml](.github/workflows/docker-build-publish.yaml) — builds and publishes the image

---

## Read this first: three things that will bite you

**1. The published `dittofeed/dittofeed-admin-cli` image cannot migrate this fork.**
`docker-compose.lite.yaml` hardcodes `dittofeed/dittofeed-admin-cli:${IMAGE_TAG:-v0.23.0}` —
note that `IMAGE_REPOSITORY` is only wired to the `lite` service, not to `admin-cli`. That
upstream image has no knowledge of migration `0011_whatsapp_channel`, so it would never add
`WhatsApp` to the `DBChannelType` Postgres enum, and every WhatsApp send would fail on an
invalid enum value. `docker-compose.prod.yaml` solves this by running admin-cli **out of the
fork's own image**, which the `lite` Dockerfile already bundles. One image, three roles:

| Role | Command |
|---|---|
| Web (API + dashboard) | `node ./packages/lite/dist/scripts/startLite.js` |
| Worker | `node ./packages/worker/dist/scripts/startWorker.js` |
| Migrations / admin | `node ./packages/admin-cli/dist/scripts/cli.js <cmd>` |

**2. `SECRET_KEY` is not optional and cannot be rotated later.**
In single-tenant mode it encrypts the session cookie
([buildApp.ts:115-127](packages/api/src/buildApp.ts#L115-L127)). The value baked into
`docker-compose.lite.yaml` is published in the public repo — anyone who knows it can forge a
valid session and get full dashboard access. It also encrypts stored Gmail OAuth tokens
([secrets.ts](packages/backend-lib/src/secrets.ts)), and there is no key-rotation path, so
changing it later invalidates those. Generate it once, before first boot:

```bash
openssl rand -base64 32   # exactly 32 bytes of base64, which is what AES-256-GCM needs
```

**3. `DASHBOARD_URL` unset defaults to `https://app.dittofeed.com`.**
See [config.ts:508-518](packages/backend-lib/src/config.ts#L508-L518). That value becomes the
allowed CORS origin (`allowedOrigins` falls back to it) and, in single-tenant mode, the
dashboard's own API base ([apiBase.ts](packages/backend-lib/src/apiBase.ts) rule 4). Unset, a
production instance points part of itself at upstream's SaaS. Always set it.

---

## Step 1 — Build and publish the image

The workflow is already converted to GHCR, which authenticates with the built-in
`GITHUB_TOKEN`. **No secrets to configure.** It builds only the `lite` image (all three roles
come from it), targets `linux/amd64` only, and caches layers between runs.

```bash
# From the fork, on the branch you want to ship:
git tag v0.24.0-saya.1
git push fork v0.24.0-saya.1
```

Watch it at `https://github.com/lakshya16240/dittofeed/actions`. First build is 15–25 minutes
(the Next.js dashboard dominates); later builds are much faster off the layer cache.

You can also build without tagging via **Actions → Publish Docker image → Run workflow**, which
accepts a branch or SHA.

Every build publishes `sha-<full-sha>`. Pin that in production rather than `latest`, so a
`docker compose pull` cannot silently change code under you.

> **Make the package public, or add a pull secret.** GHCR packages default to private. Either
> set the package to public under the repo's Packages settings, or on the VM run
> `echo $GHCR_PAT | docker login ghcr.io -u lakshya16240 --password-stdin` with a PAT that has
> `read:packages`.

## Step 2 — Prepare the VM

Needs Docker Engine with the Compose plugin, and ~8 GB RAM for the defaults in
`.env.prod.example`. Clone the fork, because the compose file mounts Temporal's dynamic config
from the working tree:

```bash
git clone https://github.com/lakshya16240/dittofeed.git /opt/dittofeed
cd /opt/dittofeed
git checkout v0.24.0-saya.1     # match the image tag you built

cp .env.prod.example .env.prod
chmod 600 .env.prod
```

Fill in `.env.prod`. Every value marked REQUIRED has no usable default:

```bash
# Generate the four secrets
printf 'SECRET_KEY=%s\n'         "$(openssl rand -base64 32)"
printf 'PASSWORD=%s\n'           "$(openssl rand -base64 24)"
printf 'DATABASE_PASSWORD=%s\n'  "$(openssl rand -base64 24)"
printf 'CLICKHOUSE_PASSWORD=%s\n' "$(openssl rand -base64 24)"
```

Then set `IMAGE_TAG` to the `sha-…` tag from step 1 and `DASHBOARD_URL` to the public origin.

Sanity-check interpolation before starting anything — this fails loudly on any missing
required variable rather than booting a misconfigured stack:

```bash
docker compose -f docker-compose.prod.yaml --env-file .env.prod config --quiet && echo OK
```

## Step 3 — Start dependencies, then migrate

Bring up only the data layer first. Both have healthchecks, so `--wait` returns when they are
actually ready rather than merely started:

```bash
docker compose -f docker-compose.prod.yaml --env-file .env.prod \
  up -d --wait postgres clickhouse-server temporal
```

**First install.** `bootstrap` runs the Postgres migrations, creates the ClickHouse schema,
registers the Temporal namespace and creates the workspace:

```bash
docker compose -f docker-compose.prod.yaml --env-file .env.prod \
  run --rm admin bootstrap --workspace-name="$WORKSPACE_NAME"
```

**Upgrading an existing instance** (your test instance was bootstrapped on the `v0.23.0`
default image, so it needs this). Run the pre-upgrade step *before* starting the new
application version — it runs the migrations, rebuilds the user-sorting index tables, swaps
the `message_id` index to a bloom filter, and backfills unsubscribed segments for existing
subscription groups ([upgrades.ts:1167](packages/admin-cli/src/upgrades.ts#L1167)):

```bash
docker compose -f docker-compose.prod.yaml --env-file .env.prod \
  run --rm admin upgrade-0-24-0-pre
```

Confirm the fork's own migration landed. This is the check that proves the WhatsApp channel
will work at all:

```bash
docker compose -f docker-compose.prod.yaml --env-file .env.prod exec -T postgres \
  psql -U "$DATABASE_USER" -d dittofeed -c 'select unnest(enum_range(NULL::"DBChannelType"));'
```

Expect five rows: `Email`, `MobilePush`, `Sms`, `Webhook`, **`WhatsApp`**. If `WhatsApp` is
missing, the migration did not run — you are almost certainly running an upstream image.

## Step 4 — Start the application

```bash
docker compose -f docker-compose.prod.yaml --env-file .env.prod up -d
docker compose -f docker-compose.prod.yaml --env-file .env.prod ps
docker compose -f docker-compose.prod.yaml --env-file .env.prod logs -f lite worker
```

The web tier listens on `127.0.0.1:3000` only. Put a reverse proxy in front for TLS —
`SESSION_COOKIE_SECURE=true` means the browser will not store the session cookie over plain
HTTP, so login silently fails without it. Caddy, which handles certificates on its own:

```
ditto.example.com {
    reverse_proxy 127.0.0.1:3000
}
```

## Step 5 — Verify

```bash
curl -fsS https://ditto.example.com/api            # API reachable through the proxy
```

Then in the dashboard:

1. Log in with `PASSWORD`.
2. **Settings → Interakt** — save the support and campaign keys.
3. **Templates → New → WhatsApp** — create a template, set the provider to `Test`, and send a
   test. `Test` renders and resolves the recipient but never calls Interakt, so this cannot
   reach a real customer. Confirm the body parameters land in the right positions.
4. Switch the provider to `Interakt` and send one real message to your own number.
5. **Deliveries** — confirm the row appears with the right `to`. If sends succeed but no row
   appears, that is the `SearchDeliveriesResponseItem` union failing validation, not a send
   problem.

Confirm the worker split is actually working, since a misconfigured worker fails *silently*:

```bash
# Should log a Temporal worker starting on the "default" task queue
docker compose -f docker-compose.prod.yaml --env-file .env.prod logs worker | grep -i "task queue\|worker state"
# Should NOT mention starting a worker
docker compose -f docker-compose.prod.yaml --env-file .env.prod logs lite | grep -i "worker"
```

Then create a trivial segment and check it computes within ~2 minutes. If segments never
update, the worker is not consuming the queue the web tier schedules onto — see the warning
below.

## Publishing on a tailnet as well as loopback

`docker-compose.prod.yaml` binds one interface, chosen by `LITE_BIND` and
defaulting to `127.0.0.1`. That is right when only a reverse proxy or a
Cloudflare tunnel sits in front. It cannot serve loopback and a tailnet address
at once -- setting `LITE_BIND` to the tailnet address stops loopback listening,
which takes the tunnel down with no error anywhere.

For both at once, add the overlay:

```bash
echo 'LITE_TAILNET_BIND='"$(tailscale ip -4)" >> .env.prod

docker compose -f docker-compose.prod.yaml -f docker-compose.tailnet.yaml \
  --env-file .env.prod up -d lite
```

`PORTS` in `ps` should then list both `127.0.0.1:3000` and the tailnet address.

**Use `./compose.sh` rather than calling `docker compose` directly.** Passing
`-f` disables Compose's automatic override discovery, so a command that omits
the second file silently drops the tailnet bind on the next `up -d` -- the
tunnel keeps working and direct access just stops, with no error. The wrapper
applies the right files and env file every time:

```bash
sudo ./compose.sh up -d
sudo ./compose.sh ps
sudo ./compose.sh logs -f lite worker
sudo ./compose.sh pull
sudo ./compose.sh run --rm admin migrate
```

It includes the tailnet overlay only when `LITE_TAILNET_BIND` is set, so the
same script works unchanged on a host that only needs loopback. It echoes the
command it runs, so what happened is always visible.

## Step 6 — Redeploying

```bash
cd /opt/dittofeed
git fetch fork --tags && git checkout <new-tag>
sed -i "s|^IMAGE_TAG=.*|IMAGE_TAG=sha-<new-sha>|" .env.prod

docker compose -f docker-compose.prod.yaml --env-file .env.prod pull
# Run migrations BEFORE the new code starts, if the release adds any
docker compose -f docker-compose.prod.yaml --env-file .env.prod run --rm admin migrate
docker compose -f docker-compose.prod.yaml --env-file .env.prod up -d
```

Rollback is `IMAGE_TAG` back to the previous `sha-…` and `up -d` again. Note that rollback does
**not** revert migrations, so avoid destructive ones.

**Compose and env changes need no rebuild.** The Dockerfile copies only
`packages/*`, so the compose files and `.env.prod.example` are never in the
image -- they take effect from the git checkout on the host. For a change that
touches only those, `git pull` (or `git checkout <tag>`) plus `up -d` is the
whole deploy; tagging is optional and only worth it to keep the deployed tag
aligned with the tree.

---

## Do not copy the helm chart's task-queue variables

[helm-charts/dittofeed/templates/deployment.yaml](helm-charts/dittofeed/templates/deployment.yaml#L77-L85)
sets `GLOBAL_CRON_TASK_QUEUE=global`, `COMPUTED_PROPERTIES_TASK_QUEUE=workspace` and
`COMPUTED_PROPERTIES_ACTIVITY_TASK_QUEUE=workspace` when the worker is separated. It can do
that because it also runs **three** worker deployments, one per queue
([workers.yaml:96-98](helm-charts/dittofeed/templates/workers.yaml#L96-L98)).

`docker-compose.prod.yaml` runs one worker and therefore sets **none** of them. Every queue
defaults to `"default"` ([config.ts:584-585](packages/backend-lib/src/config.ts#L584-L585),
[worker/config.ts:67](packages/worker/src/config.ts#L67)), so the single worker serves
journeys, computed properties and the global cron together.

If you set those variables without adding the matching workers, computed properties get
scheduled onto a queue nothing polls. **Segments stop updating and nothing logs an error** —
segment-entry journeys and broadcasts just quietly never fire. Split the queues only when you
also add a worker container per queue.

## Scaling later

- **More journey throughput** — raise `WORKER_HEAP_MB` / `WORKER_MEM_LIMIT`, or run
  `docker compose ... up -d --scale worker=3`. Temporal distributes work across pollers, so
  replicas need no coordination.
- **Isolate computed properties from journeys** — add a second worker service with
  `TASK_QUEUE=workspace`, then set `COMPUTED_PROPERTIES_TASK_QUEUE=workspace` and
  `COMPUTED_PROPERTIES_ACTIVITY_TASK_QUEUE=workspace` on *every* service. Both halves must
  land together.
- **Off-box data layer** — point `DATABASE_HOST` / `CLICKHOUSE_HOST` elsewhere and delete the
  two services. No application change.

## What this runbook does not cover

- **Backups.** Handled by your existing Ansible runbook. It needs to cover the `postgres`
  volume — Postgres holds workspaces, templates, journeys, subscription state and the provider
  keys, none of which is reconstructible from GA4. The `clickhouse_lib` volume holds the event
  stream and delivery history; losing it loses reporting but not configuration.
- **Provider credentials are stored unencrypted.** Channel secrets go to `Secret.configValue`
  as plaintext JSONB — `encrypt()` is only applied to Gmail OAuth tokens. So the Interakt keys
  and the FCM service-account private key sit readable in Postgres. Their protection is
  database access control, disk encryption, and treating any dump as secret material.
  `SECRET_KEY` does **not** cover them.
- **Rotating the Firebase key** means updating it in Dittofeed *and* in `samasya_backend`,
  which still has a copy — see `DITTOFEED_FUTURE.md` in that repo.
