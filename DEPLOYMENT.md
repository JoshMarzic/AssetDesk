# Deploy and test AssetDesk

## Get the code

```sh
git clone https://github.com/JoshMarzic/AssetDesk.git
cd AssetDesk
```

Requires **Docker Engine/Desktop, Compose v2, Node.js 24, and npm**. Use a Bash-compatible terminal for examples. Private `.env`, dependencies, and database data are excluded from Git; each fresh installation generates its own credentials.

## Test with Docker Desktop

Start Docker Desktop using Linux containers, then run:

```sh
npm ci
node scripts/setup.mjs
docker compose up -d --wait db bookstack
node scripts/bootstrap-bookstack.mjs
docker compose up -d --build --wait assetdesk
npm test
docker compose ps
```

Desktop's Containers view should show database, BookStack, and AssetDesk under the Compose project, all healthy.

On the computer running Docker, open the **dashboard at `http://localhost:3000`**. In private `.env`, find `DASHBOARD_ADMIN_EMAIL` (initially `admin@assetdesk.local`) and generated `DASHBOARD_ADMIN_PASSWORD`. Sign in and use Team to create technicians. These are separate from API tokens and BookStack users. Later restarts preserve accounts; editing bootstrap password variables does not reset existing accounts.

**BookStack is at `http://localhost:6875`**, with separate development login `admin@admin.com` and `BOOKSTACK_ADMIN_PASSWORD` from `.env`. The development bootstrap replaces only the stock password; customized logins remain unchanged. Edit asset ownership/documentation in BookStack and manage ticket status/assignment in the dashboard.

Verify the dashboard workflow and create labeled sample records against the real stack:

```sh
node --env-file=.env scripts/desk-smoke.mjs
node --env-file=.env scripts/smoke.mjs
```

The desk smoke checks login, technician creation, manual tickets, assignment, notes, resolution, metadata sync, and logout; it deactivates its temporary technician afterward. The original smoke checks raw-mail intake and asset linking. They print `PASS` on success and send no external email. Both create example records, so use a development instance. For browser automation, including saved responses, manual asset linking, and related tickets, run `npm run test:browser` with Playwright's Chromium or a compatible installed Chromium.

## Try the service-desk workflow

1. In Team, create a named technician and securely share their initial password. Invitations and password-reset emails are not sent automatically.
2. Select New ticket, enter requester/issue details, choose priority/category, and assign the technician. Find it in the queue and their My Tickets view. A technician can also claim a ticket using Assign to me.
3. Open it, move to In Progress, and add an internal work note. Try inserting a shared saved response; check that `{{requester}}`, `{{technician}}`, `{{ticket_id}}`, and `{{subject}}` expand for the current ticket. Copy a rendered response for your existing email client if needed. Explicitly mark first response after contacting the requester; these actions do not send email.
4. Enter a resolution summary before selecting Resolved, then Close after confirmation. Check activity history and dashboard counts.
5. Mention an asset ID in an issue, edit its linked BookStack owner/location, then create another request mentioning that ID. Expect the same asset and preserved ownership details. Also manually associate an asset from the ticket drawer: choose a known asset or enter an explicit ID. Its durable queue should update links on both the ticket and asset BookStack pages when the wiki is reachable.
6. Open Related Tickets to find other requests sharing the asset or requester. As an administrator, create/edit a shared response template and archive one you no longer use. Technicians can use the shared library but cannot administer templates.

Response/resolution targets are elapsed wall-clock indicators documented in README.md. Waiting does not pause them, and reopening retains creation-time deadlines. There are no business-hour calendars or automatic escalations.

Deliver a sample email through the bridge without a mail server:

```sh
node --env-file=.env scripts/forward-email.mjs <<'MAIL'
From: Taylor Example <taylor@example.com>
To: helpdesk@example.com
Message-ID: <manual-test-1@example.com>
Subject: LAPTOP-1042 will not start
Content-Type: text/plain; charset=utf-8

My LAPTOP-1042 will not start after an update.
MAIL
```

Refresh the dashboard after a few seconds. Expect one ticket linked to `LAPTOP-1042`, creating a missing asset. Redelivering the same Message-ID should not create a duplicate; use a new ID for a distinct issue. Requester replies with valid thread headers join and reopen resolved/closed tickets; subject text alone does not establish a thread.

A remote workspace's loopback ports are not your laptop's loopback ports. Run locally, use the platform's supported port forwarding, or deploy on your server. For your own SSH-accessible server configured with local URLs, a temporary tunnel is:

```sh
ssh -L 3000:127.0.0.1:3000 -L 6875:127.0.0.1:6875 user@your-server
```

This does not imply that the managed development workspace provides SSH access.

## Upgrade an existing installation

Back up all persistent volumes and private `.env`, then run:

```sh
git pull
node scripts/setup.mjs
docker compose up -d --build --wait assetdesk
```

Setup adds dashboard credentials and preserves nonempty configuration. SQLite migrates in place without discarding accepted mail or ticket-page mappings. Old tickets without dashboard workflow fields start in Open for triage. Sign in on port 3000 and create named technicians.

Keep the `intake` volume. Do not rerun BookStack bootstrap as a routine upgrade; refresh a genuinely expiring API token through the appropriate development or production administration path. Dashboard status/assignment becomes authoritative. Moving wiki pages does not update the dashboard; managed metadata syncs one way to BookStack tags, with retries after outages.

## Deploy on a Linux server with HTTPS

This example uses a Linux server with Docker, Compose v2, Node.js 24/npm, and **Caddy installed on the host**. It is a deployment recipe, not automatic server provisioning.

1. Point two DNS names at the server: `helpdesk.example.com` for the dashboard and `wiki.example.com` for BookStack. Allow inbound TCP 80/443. Keep the database and application ports private. Replace example domains throughout.
2. Clone/copy source to `/opt/assetdesk` and prepare private configuration:

   ```sh
   cd /opt/assetdesk
   npm ci
   node scripts/setup.mjs
   ```

3. Before first startup edit `.env`:

   ```dotenv
   BOOKSTACK_PUBLIC_URL=https://wiki.example.com
   DASHBOARD_ADMIN_EMAIL=desk-admin@example.com
   COOKIE_SECURE=true
   TRUST_PROXY_HOPS=1
   ```

   Retain the private generated `DASHBOARD_ADMIN_PASSWORD` for the initial login; later restarts preserve accounts/passwords. `TRUST_PROXY_HOPS=1` trusts the single host-Caddy hop so browser login limits use each client's forwarded IP instead of sharing Caddy's address. Use this only with the application bound to loopback and accessible through that trusted proxy. The default is `0` for direct access; supported values are 0–5 for a known proxy chain. Keep Compose's internal BookStack routing unchanged. For an existing wiki whose URL changes, follow `bookstack:update-url` before creating new links.

4. Start the database and wiki:

   ```sh
   docker compose up -d --wait db bookstack
   ```

5. Add these sites to the host's `/etc/caddy/Caddyfile` and reload Caddy. DNS and inbound 80/443 must work for automatic certificates.

   ```caddyfile
   helpdesk.example.com {
       reverse_proxy 127.0.0.1:3000
   }

   wiki.example.com {
       reverse_proxy 127.0.0.1:6875
   }
   ```

   ```sh
   sudo systemctl reload caddy
   ```

   Caddy here is a host service; in a proxy container, `127.0.0.1` points to that container and requires different networking. With `COOKIE_SECURE=true`, use the HTTPS dashboard address; secure session cookies are not sent over HTTP.

6. Restrict first-run wiki access to yourself. For production use native BookStack administration rather than the development bootstrap. A fresh BookStack database begins with `admin@admin.com` / `password`: **change that password immediately**, configure your real administrator, and disable guests. `BOOKSTACK_ADMIN_PASSWORD` is applied only by development bootstrap, not by Compose itself.
7. Create a dedicated BookStack integration role/user. Grant Access system API and content view/create/update on required shelves, books, chapters, and pages. Initial provisioning needs permission to create the help desk structure. No user-management, settings, or deletion rights are needed. Create an API token and securely replace `.env` placeholders:

   ```dotenv
   BOOKSTACK_TOKEN_ID=<token ID from BookStack>
   BOOKSTACK_TOKEN_SECRET=<token secret from BookStack>
   ```

   Restrict accessible content after provisioning. Manage human wiki permissions separately from dashboard technicians.

8. Start AssetDesk and check readiness:

   ```sh
   docker compose up -d --build --wait assetdesk
   docker compose ps
   curl --fail http://127.0.0.1:3000/readyz
   ```

   Expect `{"status":"ready"}`. Sign in at the HTTPS dashboard with the initial dashboard email/password, create technician accounts, and test a staging request. Do not use bearer tokens as browser credentials.

For an intentional integration smoke run against the HTTPS wiki, use `SMOKE_BOOKSTACK_URL=https://wiki.example.com node --env-file=.env scripts/smoke.mjs`; it creates sample data. `npm test` runs automated suites without a public deployment.

## Connect a support mailbox

AssetDesk accepts mail but does not poll Microsoft 365, Gmail, or IMAP. Route a dedicated address through an MTA delivery pipe or provider adapter. For pipe delivery, execute as a restricted user with complete raw mail on stdin:

```sh
node --env-file=/secure/path/assetdesk-mail.env /opt/assetdesk/scripts/forward-email.mjs
```

Give that private mail file only `INBOUND_EMAIL_TOKEN` and `ASSETDESK_INBOUND_URL`, not full application credentials. On the same host use `http://127.0.0.1:3000/api/inbound/email`.

For a remote gateway, add an intake DNS name and expose only this path through Caddy:

```caddyfile
intake.example.com {
    handle /api/inbound/email {
        request_body {
            max_size 10MB
        }
        reverse_proxy 127.0.0.1:3000
    }
    handle {
        respond 404
    }
}
```

Set the gateway's private URL to `https://intake.example.com/api/inbound/email`. Send raw MIME with `Content-Type: message/rfc822` and `Authorization: Bearer <INBOUND_EMAIL_TOKEN>`. Parsed-JSON webhooks require adapters. Apply sender/recipient restrictions, spam filtering, SPF/DKIM/DMARC, and provider signature validation at the gateway; From is not authentication. Keep Message-IDs during retries. The bridge exits 75 for temporary failures and 65 for invalid/oversized messages. Limits are 10 MiB raw mail and 100,000 decoded text characters.

## Restart, troubleshoot, and retain data

```sh
docker compose up -d --wait
docker compose ps
docker compose logs --tail=100 assetdesk bookstack
curl --fail http://127.0.0.1:3000/readyz
```

Keep private `.env` and back up/restore all three volumes together: `database` (MariaDB), `bookstack` (wiki files), and `intake` (SQLite queue, workflow, accounts, notes, sessions, history, shared response templates, and queued manual asset associations). Use database-aware MariaDB backups and consistent SQLite backups; a running SQLite database can have WAL/SHM files. Use one AssetDesk instance per SQLite database.

`docker compose down` retains data. **`docker compose down -v` deletes it.** Refresh expiring BookStack API tokens through native production administration. Keep credentials out of Git and logs.

Internal notes and first-response flags do not send email. Outbound replies/acknowledgements, attachments, mailbox hosting, business-hours calendars, and automatic escalation are not supplied by the bundled stack.
