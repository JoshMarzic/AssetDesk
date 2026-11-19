# AssetDesk

AssetDesk is an IT service desk with a **ticket dashboard, technician assignments, email intake, and linked BookStack asset records**. Start with the active queue, overdue work, unassigned requests, and technician workload. Open a ticket to triage it, assign a technician, record internal notes, and document its resolution.

BookStack remains the place for editable asset ownership, equipment details, and documentation. Asset mentions such as `LAPTOP-1042`, `PC-17`, or `[asset: SERIAL123]` link to an existing asset page or create a missing record. Tickets and assets link back to each other. See [DEPLOYMENT.md](DEPLOYMENT.md) for Docker Desktop testing, upgrades, HTTPS deployment, and mailbox routing.

## Run locally

Requires Docker with Compose v2, Node.js 24, and npm.

```sh
npm ci
node scripts/setup.mjs
docker compose up -d --wait db bookstack
node scripts/bootstrap-bookstack.mjs
docker compose up -d --build --wait assetdesk
npm test
```

Open the **AssetDesk dashboard on port 3000** on the computer running Docker. Sign in using `DASHBOARD_ADMIN_EMAIL` and `DASHBOARD_ADMIN_PASSWORD` from your private `.env`. The initial email defaults to `admin@assetdesk.local`; setup generates a random password. On first startup the service creates this administrator. Later startups preserve existing accounts and passwords; changing the bootstrap password in `.env` does not reset an existing account.

**BookStack runs separately on port 6875.** For the bundled development stack, sign in with `admin@admin.com` and `BOOKSTACK_ADMIN_PASSWORD` from `.env`. These accounts are separate from dashboard technicians. The local bootstrap replaces only BookStack's stock `password` and leaves a customized administrator password alone.

`scripts/setup.mjs` creates `.env` with mode 0600, fills missing settings, and preserves existing nonempty values. Never commit that file. The BookStack bootstrap is for the pinned local development container; production and existing BookStack instances should use native user/role/token administration. Container image digests are pinned; test upgrades and back up data before changing them.

In a managed cloud environment that provides a proxy CA, build using:

```sh
docker build --secret id=proxy_ca,src="$CODEX_PROXY_CERT" -t assetdesk-assetdesk .
docker compose up -d --wait assetdesk
```

The optional BuildKit secret extends npm's trust without embedding session CA files or credentials. TLS and package integrity verification remain enabled.

## Upgrade an existing installation

Back up private `.env` and all three persistent volumes, then run:

```sh
git pull
node scripts/setup.mjs
docker compose up -d --build --wait assetdesk
```

Setup adds dashboard credentials while preserving BookStack/database configuration. The service migrates the existing SQLite database in place and retains accepted messages and ticket mappings. Existing tickets without service-desk fields start in Open for triage. Keep the `intake` volume: it now holds ticket workflow, technician accounts, notes, sessions, and activity history as well as the email queue.

Do not rerun BookStack bootstrap as a routine upgrade. Existing API credentials continue to work; refresh an expiring token through the appropriate local bootstrap or native production administration only when needed.

## Ticket workflow

The dashboard is authoritative for ticket status, assignment, priority, category, and work history. Search, filters, My Tickets, Unassigned, and Overdue views focus follow-up work.

- **Triage:** choose General, Hardware, Software, Network, or Access; set Low/Normal/High/Urgent priority; assign an active technician or use Assign to me.
- **Work:** move between Open, In Progress, and Waiting, add internal notes, and explicitly mark the first response after contacting the requester.
- **Resolve:** enter a resolution summary before marking Resolved, then Close after confirmation. Requester email replies reopen resolved/closed tickets; trusted support replies do not automatically reopen them.
- **Review:** activity history records changes. Version checks prevent silently overwriting another technician's changes; refresh after a conflict.

In a ticket's asset section, choose a known asset or enter an explicit asset ID to associate equipment manually. The association is saved to a durable queue and its BookStack ticket/asset links are updated in both directions when the wiki is available. Related Tickets surfaces requests sharing an asset or requester so technicians can review earlier symptoms and fixes.

The shared response library provides reusable text with `{{requester}}`, `{{technician}}`, `{{ticket_id}}`, and `{{subject}}` placeholders. Technicians can insert a rendered response into an internal note or copy it for their existing email client. Administrators can create, edit, and archive templates. These actions do not send an email or create a public reply.

Response and resolution indicators use **elapsed wall-clock time**, anchored to ticket creation. Changing priority recalculates targets from that same time. Waiting does not pause the clock; reopening does not erase original deadlines. There are no business-hour calendars, automatic escalations, or contractual SLA guarantees.

| Priority | First response | Resolution |
| --- | --- | --- |
| Low | 24 hours | 120 hours |
| Normal | 8 hours | 72 hours |
| High | 2 hours | 24 hours |
| Urgent | 1 hour | 8 hours |

Internal notes stay in AssetDesk and are **not sent to requesters**. Marking first response records an action already completed; it does not send email. Attachments, outgoing replies/acknowledgements, and automatic escalation are not implemented.

## Technician accounts

Administrators manage named accounts in Team and create technicians with initial passwords. Share passwords through your organization's secure process; AssetDesk does not send invitations or password-reset emails. Technicians work tickets and assignments; team-account management is administrator-only. The desk protects against removing its last active administrator.

Dashboard sessions use HttpOnly cookies, SameSite restrictions, CSRF protection on changes, and login rate limiting. Set `COOKIE_SECURE=true` when serving the dashboard through HTTPS in production. For the documented host-Caddy deployment, also set `TRUST_PROXY_HOPS=1` so rate limits use the client address forwarded by that single trusted proxy. Leave its default `0` for direct access; configure a value from 0–5 only for your known proxy chain and keep application ports private. Passwords are hashed. Do not use `ADMIN_TOKEN` or an email-delivery token as a browser password. Dashboard accounts do not grant BookStack access; manage wiki users separately.

## BookStack assets and ticket mirrors

The integration creates an **IT Help Desk** shelf containing **Tickets** and **Assets** books. Processed tickets have BookStack pages with original issues and asset links. Dashboard status, assignment, and related metadata mirror to BookStack tags asynchronously; outages leave updates queued for retry. Managed metadata may be replaced on the next sync. BookStack chapters and manually edited wiki tables no longer determine dashboard state.

Open an asset's BookStack page to edit owner, department, location, model, serial number, lifecycle, purchase/warranty details, and notes. Keep its unique `Asset ID` tag stable so future messages reuse the record. Add matching tags before adopting an existing inventory. Identifiers normalize to uppercase; matching pages are linked rather than replaced.

Automatic matching uses `ASSET_PREFIXES`; a digit in the suffix avoids ordinary prose being treated as equipment. Use `[asset: YOUR-ID]` for other identifiers. Preserve canonical `Asset ID` and `Ticket ID` tags for safe retries. Incoming email HTML is treated as text, never trusted wiki markup.

BookStack retains revisions, and the integration preserves existing HTML/Markdown when appending links/replies. Its API has no atomic compare-and-swap: avoid saving a manual edit at exactly the same time an email update appends to that page. The integration needs API access and content view/create/update rights, without user-management, settings, or deletion permissions. It does not need to move ticket pages.

## Receive email

AssetDesk does not poll inboxes. Route a dedicated support address through an MTA delivery pipe or provider adapter that sends the complete RFC 822/MIME message:

```text
POST /api/inbound/email
Authorization: Bearer <INBOUND_EMAIL_TOKEN>
Content-Type: message/rfc822

<raw email including From, Subject, Message-ID headers and body>
```

The included bridge accepts mail on stdin:

```sh
node --env-file=/secure/path/assetdesk-mail.env /path/to/AssetDesk/scripts/forward-email.mjs < message.eml
```

Its private configuration needs only `ASSETDESK_INBOUND_URL` and `INBOUND_EMAIL_TOKEN`. Run it as a restricted delivery user. Exit 75 requests retry after temporary failure; exit 65 rejects invalid/oversized mail. HTTP success means durable acceptance, while BookStack processing can remain queued. Requests time out after 30 seconds. Raw mail is limited to 10 MiB and decoded body text to 100,000 characters. Retain original Message-IDs on retries.

Parsed-JSON provider webhooks need an adapter; they cannot directly use this raw endpoint. Validate provider signatures and preserve MIME. From headers do not authenticate people: apply spam filtering, SPF/DKIM/DMARC, and sender/recipient restrictions at the gateway. Mail never grants dashboard/wiki access.

Replies with `In-Reply-To` or `References` join an original ticket when sent by its requester or a trusted address in `SUPPORT_EMAILS`; other senders create separate tickets. Subject text alone does not establish a thread. Replies to accepted messages still processing wait for them; references never seen by intake start a new ticket.

Local sample delivery without sending external email:

```sh
node --env-file=.env scripts/forward-email.mjs <<'MAIL'
From: Taylor Example <taylor@example.com>
To: helpdesk@example.com
Message-ID: <assetdesk-example-1@example.com>
Subject: LAPTOP-1042 will not boot
Content-Type: text/plain; charset=utf-8

My LAPTOP-1042 does not start after the update.
MAIL
```

## Validation and operations

```sh
npm test
node --env-file=.env scripts/desk-smoke.mjs
node --env-file=.env scripts/smoke.mjs
npm run test:browser
docker compose ps
```

The desk smoke script checks browser-session login, technician creation, manual intake, assignment, first-response recording, notes, resolution, BookStack metadata sync, and logout against the running stack. It creates labeled records and deactivates its temporary technician. The original smoke script checks raw-email intake and asset linking. Use a development instance for both. Browser checks cover ticket work, saved responses, manual asset association, and related tickets; they require Playwright's Chromium or an installed compatible Chromium. See the browser runner configuration for available overrides.

`GET /healthz` checks the process, and `GET /readyz` verifies BookStack connectivity/permissions. Browser endpoints under `/api/desk` use sessions. Original integration endpoints remain available with bearer `ADMIN_TOKEN`: `POST /api/tickets`, `GET /api/tickets/:key`, `GET /api/receipts/:id`, `GET /api/queue`, and `POST /api/receipts/:id/retry`. Processing receipts differ from ticket workflow status.

For host development, keep BookStack/database running, stop the Compose companion to avoid a port conflict, then run:

```sh
BOOKSTACK_URL=http://127.0.0.1:6875 node --env-file=.env --watch src/server.js
```

Keep `BOOKSTACK_PUBLIC_URL` equal to BookStack's `APP_URL`. If that URL changes, follow its `bookstack:update-url` procedure. Back up and restore **SQLite service-desk/queue data, MariaDB, BookStack `/config`, and private `.env` together**. SQLite includes shared response templates and pending manual asset associations as well as ticket work. Use one service instance per SQLite database. Named volumes survive `docker compose down`; **`docker compose down -v` deletes them**.

## Production or an existing BookStack

Serve the dashboard's HTTPS host separately from the wiki host. Disable guest wiki access and restrict ticket/asset books appropriately. Use a dedicated integration account/token configured in `BOOKSTACK_URL`, `BOOKSTACK_PUBLIC_URL`, `BOOKSTACK_TOKEN_ID`, and `BOOKSTACK_TOKEN_SECRET`. For an external wiki, run only the companion with its URL explicitly configured rather than starting the bundled wiki/database.

Compose is a development setup. Public hosting, TLS, mail routing, backups, and organizational access controls need deployment configuration; [DEPLOYMENT.md](DEPLOYMENT.md) supplies a host reverse-proxy example. BookStack is an independent GPL-licensed project; AssetDesk uses its REST API without modifying it. See [BookStack documentation](https://www.bookstackapp.com/docs/) and [LinuxServer's container documentation](https://docs.linuxserver.io/images/docker-bookstack/).
