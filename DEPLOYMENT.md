# Install, upgrade, and test AssetDesk

AssetDesk now runs as one self-contained application. It uses SQLite for tickets, knowledge, category permissions, personnel/equipment assets, images, and account data. There is no runtime BookStack or MariaDB dependency.

## Fresh installation with Docker Desktop

Install Git and Node.js 24, start Docker Desktop using Linux containers, then open PowerShell or a terminal:

```sh
git clone https://github.com/JoshMarzic/AssetDesk.git
cd AssetDesk
node scripts/setup.mjs
docker compose up -d --build --wait assetdesk
```

Docker Desktop's Containers view should show a healthy `assetdesk` service. On that computer, open `http://localhost:3000` and sign in using `DASHBOARD_ADMIN_EMAIL` and `DASHBOARD_ADMIN_PASSWORD` from the generated private `.env`. The initial email is `admin@assetdesk.local` unless changed before first startup. Later restarts preserve your account and password; changing bootstrap variables does not reset an existing password.

No BookStack account, API token, extra database service, or second browser login is needed.

## Try the native workflow

1. Create technicians in Team and share their initial passwords securely.
2. Create a ticket, choose priority/category, and assign a technician or use Assign to me. The saved ticket opens immediately.
3. Add internal notes, insert a shared response template, and explicitly mark a first response after contacting the requester. These operations do not send customer email.
4. Enter a resolution summary before marking Resolved, then close the request after confirmation. Check the ticket's activity history.
5. In Assets, create a Personnel record, then a PC or laptop and select that person as its owner. Add equipment details, location, lifecycle status, and notes.
6. Mention or manually link that asset ID on a ticket. Open the asset: its linked-ticket section should show that request and provide a link back to it.
7. Open Knowledge base. The Assets area contains asset records and can also contain asset documentation. Create an article in a category you may edit.
8. As an administrator, create a Restricted category and grant a named technician read and/or edit access. Verify another technician cannot find its category/articles in navigation, search, direct URLs, or media requests. Administrators retain access.
9. Open Actions in the left navigation. It is deliberately a placeholder for future automations, with no runnable actions yet.
10. Open Reports below Actions. Search by a submitted-date range, type/category, technician, and other ticket fields, then expand the advanced filters for asset, SLA, and duration criteria. Date ranges include both selected days in UTC. Export CSV downloads all matching tickets using the applied filters, across every results page. Verify an exported file in your spreadsheet application and open a matching ticket from the report.
11. Open a ticket and type a label into Tags, then press Enter. Confirm it appears immediately and remains after reopening the ticket. Search for it with the Tag filter in Reports and verify the CSV includes the tag. Tags can also be entered on the new-ticket form.

All-staff categories can allow or deny staff editing. Restricted categories use named-reader/editor grants. Editing or moving a record requires the appropriate category access. Personnel inventory records are separate from technician login accounts.

## Upgrade an existing installation

Keep the same checkout directory and Compose project name so the original `intake` volume is reused. Back up your private `.env` and all existing volumes before upgrading. If using the older wiki-based installation, preserve its `database` and `bookstack` volumes as well.

```sh
git pull
node scripts/setup.mjs
docker compose up -d --build --wait assetdesk
```

The new service keeps existing accounts, accepted email, tickets, notes, sessions, and response templates. It converts locally stored asset references and ticket links into native assets. The new default Compose file contains only AssetDesk; any old wiki/database containers are left as orphans rather than deleted. Do not use `--remove-orphans` until any desired legacy content has been imported and verified.

An orphan warning during this transition is expected. The native service itself does not read the old BookStack environment variables or require those containers to be available.

## Import existing BookStack documentation once

Skip this section for a fresh installation or if you have no legacy documents to retain.

The explicit migration helper imports accessible knowledge books/chapters, detailed asset pages, supported inline images, and native internal links. Existing local ticket data stays authoritative; generated ticket-mirror pages are skipped. It does not automatically translate BookStack user permissions: **all imported categories start restricted to administrators**. Review them and assign AssetDesk reader/editor grants afterward.

1. Keep the original `.env` entries for `BOOKSTACK_URL`, `BOOKSTACK_PUBLIC_URL`, `BOOKSTACK_TOKEN_ID`, and `BOOKSTACK_TOKEN_SECRET`. They are read only by the migration command, not by the native server. Preserve `DB_PASSWORD`, `DB_ROOT_PASSWORD`, and `BOOKSTACK_APP_KEY` if you might need to restart the bundled legacy services. Never paste these values into chat or commit them.
2. If the old wiki/database containers are still running, leave them running for the import. If they were stopped, the optional legacy Compose file can start them using their retained volumes:

   ```sh
   docker compose -f compose.legacy.yaml up -d --wait db bookstack
   ```

   Use the same original project name. For a custom project, supply your original `COMPOSE_PROJECT_NAME` as before. Do not start these definitions against empty volumes expecting them to contain your old documents.
3. Build/start the native application first using the upgrade commands above. This initializes native tables and ensures an active administrator exists.
4. Run the helper from the checkout on the host:

   ```sh
   node scripts/import-bookstack.mjs --container
   ```

   It securely passes legacy connection settings on stdin to a one-off native application container. It stops AssetDesk while writing, creates a consistent `assetdesk.sqlite.pre-native-import-<timestamp>.sqlite` backup in the retained `intake` volume, and restarts the service after success or failure. It neither deletes legacy content nor resets accounts. The original `http://bookstack:80` internal URL works when the old containers remain attached to the same Compose project network.
5. Sign in as an administrator. Review the summary counts and imported categories, articles, asset ownership, images, and linked tickets. Imported asset metadata is placed in a restricted imported asset category; native ticket backlinks remain attached to the same asset IDs. Already maintained native asset fields and their category permissions are preserved; the legacy page is still copied into restricted documentation. Unknown internal links become text. Unavailable images are reported; correct the prerequisite and rerun while keeping the old source available.
6. Grant the intended readers/editors in category settings. Completed imports are skipped on rerun; later native edits are preserved. An interrupted import can resume, including images that were temporarily unavailable. If you edit an incompletely imported article yourself, the helper preserves your edit instead of replacing it.
7. After verification, stop the obsolete services while retaining their volumes/backups:

   ```sh
   docker compose -f compose.legacy.yaml stop bookstack db
   ```

   AssetDesk continues running by itself. Keep the legacy backups until you are satisfied that the native records contain what you need.

For a host-managed native database instead of the Compose volume, stop that server process and run:

```sh
BOOKSTACK_URL=http://127.0.0.1:6875 node scripts/import-bookstack.mjs --database ./data/assetdesk.sqlite
```

The helper uses the existing private `.env` for the remaining legacy settings. A configured `BOOKSTACK_KNOWLEDGE_BOOK_ID` limits knowledge import to that book, while still importing the legacy Assets book. Without it, accessible non-ticket books are imported. Images must be supported raster files served by the configured legacy wiki; arbitrary external images are not downloaded. The helper and its isolated client are under `migration/` and are never loaded by normal application startup.

## Deploy on a Linux server with HTTPS

This example assumes Docker, Compose v2, Node.js 24/npm, and Caddy installed as a host service. It is a deployment recipe, not automatic server provisioning.

1. Point `helpdesk.example.com` at the server and allow inbound TCP ports 80 and 443. Keep the application port private.
2. Clone/copy the source to `/opt/assetdesk`, then run:

   ```sh
   cd /opt/assetdesk
   node scripts/setup.mjs
   ```

3. Edit private `.env` before first startup:

   ```dotenv
   DASHBOARD_ADMIN_EMAIL=desk-admin@example.com
   COOKIE_SECURE=true
   TRUST_PROXY_HOPS=1
   ```

   Retain the generated `DASHBOARD_ADMIN_PASSWORD` for the first login. `TRUST_PROXY_HOPS=1` trusts this single host-Caddy hop so rate limiting uses the forwarded client address. Leave its default `0` for direct access; only configure a known trusted proxy chain, with AssetDesk bound to loopback.
4. Build and start the application:

   ```sh
   docker compose up -d --build --wait assetdesk
   ```

5. Add this host Caddy site and reload Caddy:

   ```caddyfile
   helpdesk.example.com {
       reverse_proxy 127.0.0.1:3000
   }
   ```

   ```sh
   sudo systemctl reload caddy
   ```

   Public DNS and inbound 80/443 must work for certificate issuance. A proxy container needs a different networking configuration because its `127.0.0.1` refers to itself. With secure cookies enabled, use the HTTPS address in your browser.
6. Sign in, create named technician accounts, configure category permissions, and test a staging ticket and asset. No second wiki hostname or database server is required.

## Connect a support mailbox

AssetDesk accepts complete raw RFC 822/MIME email but does not poll Microsoft 365, Gmail, or IMAP. Configure your MTA or a provider adapter to deliver mail to the authenticated intake endpoint.

For pipe delivery, run as a restricted mail-delivery user:

```sh
node --env-file=/secure/path/assetdesk-mail.env /opt/assetdesk/scripts/forward-email.mjs
```

Give that private mail file only `INBOUND_EMAIL_TOKEN` and `ASSETDESK_INBOUND_URL`. If the mail gateway is on the same host, use `http://127.0.0.1:3000/api/inbound/email`.

For a gateway on another host, point an intake hostname at the server and expose only its inbound route through Caddy:

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

The gateway sends `Content-Type: message/rfc822` and `Authorization: Bearer <INBOUND_EMAIL_TOKEN>`. Parsed-JSON webhooks need an adapter that verifies signatures and preserves MIME. Apply sender/recipient restrictions, spam filtering, SPF/DKIM/DMARC, and provider authentication at the trusted gateway. From headers alone do not authenticate people.

Retain Message-IDs on retries. The bridge exits 75 for temporary failure and 65 for invalid/oversized mail. Limits are 10 MiB raw mail and 100,000 decoded text characters. Tickets and asset links are stored locally; HTTP success means durable acceptance. Requester replies can reopen existing tickets; subject text alone does not establish a thread.

## Validate and operate

```sh
npm ci
npm test
npm run test:browser
docker compose ps
curl --fail http://127.0.0.1:3000/readyz
```

Smoke commands create labeled development records, so use a test instance. Browser automation requires Playwright Chromium or a compatible installed Chromium. Native tests exercise category grants, direct-URL/media authorization, asset relationships, personnel ownership, ticket history, email intake, account roles, and migration.

Restart/troubleshoot with:

```sh
docker compose up -d --wait assetdesk
docker compose logs --tail=100 assetdesk
```

Back up the retained `intake` volume and private `.env` together. The SQLite database holds accounts, tickets, accepted email, notes, sessions, responses, categories, access grants, native assets, images, and migration maps. Use a consistent SQLite backup that includes committed WAL data. Run only one AssetDesk service per SQLite database.

`docker compose down` retains data. **`docker compose down -v` deletes the native database volume.** Old `database` and `bookstack` volumes should only be removed separately after their content has been backed up and the import verified.

Actions is a placeholder only. Outgoing customer email, attachments, invitations/reset emails, business-hour calendars, and active automation execution are not supplied by this release.
