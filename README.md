# AssetDesk

A small email-to-ticket service using **real BookStack pages as the help desk UI**. Agents work in BookStack's familiar editor, shelves, books, chapters, tags, permissions, search, and revision history. There is no replacement wiki or separate asset database to maintain.

An accepted message becomes a ticket page. Mentions such as `LAPTOP-1042`, `PC-17`, or `[asset: SERIAL123]` resolve to existing asset pages, or create an editable asset record when no matching page exists. The ticket links to its assets and each asset links back to related tickets.

For browser testing, a first-time HTTPS server deployment, and connecting your mailbox, see [DEPLOYMENT.md](DEPLOYMENT.md).

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

The local services bind to loopback. Open BookStack on host port **6875**. Sign in with `admin@admin.com` and the generated `BOOKSTACK_ADMIN_PASSWORD` in your local `.env`. The bootstrap replaces the stock `password` only when that password is still in use; it leaves a customized admin password alone. Use a password manager when transferring the generated login, and never commit `.env`.

`scripts/setup.mjs` creates `.env` with mode 0600 and preserves existing nonempty settings. The local development bootstrap creates a dedicated API account with content view/create/update permissions, without user-management, settings, or deletion permissions. Its token expires after one year; rerun the bootstrap to refresh it for this development instance. This script uses BookStack's internal Laravel models and is intended for the pinned local container version. Use native user/role/token administration for production or an existing BookStack instance.

BookStack and MariaDB image digests are pinned in `compose.yaml`. Update these deliberately, test upgrades, and back up first.

In a managed cloud environment that provides a proxy CA, build using:

```sh
docker build --secret id=proxy_ca,src="$CODEX_PROXY_CERT" -t assetdesk-assetdesk .
docker compose up -d --wait assetdesk
```

The optional BuildKit secret extends npm's trust during installation without embedding the session CA or credentials in the image. TLS and package integrity verification remain enabled.

## BookStack workflow

The integration creates an **IT Help Desk** shelf containing **Tickets** and **Assets** books. New tickets appear in the **Open** chapter. Use BookStack's page editing and moving controls to record progress, assignment, resolution notes, and move tickets through the workflow chapters. BookStack requires page update/delete rights on the source page and page-create rights in the destination to move a ticket; assign those rights to human help-desk agents as appropriate. The intake service deliberately has no delete permission because email processing does not need to move or delete pages. AssetDesk's queue state describes email processing, not the ticket's business status; BookStack remains the record of work.

Open any asset page to edit its ownership and equipment details in the native editor. Keep the `Asset ID` tag stable so future messages find the same asset. Add owner, department, location, serial number, model, lifecycle status, warranty, purchase details, and notes as appropriate. Do not reuse an asset ID for a different device. Existing pages with a matching `Asset ID` tag are linked instead of replaced. Asset identifiers are normalized to uppercase; use one canonical ID per page. When adopting an existing inventory, add matching `Asset ID` tags before intake begins.

Automatic asset matching recognizes the prefixes in `ASSET_PREFIXES`; numeric suffixes help avoid treating ordinary prose as equipment. Use `[asset: YOUR-ID]` when a device uses another identifier. Ticket bodies are treated as text; emailed HTML is never inserted into the wiki as trusted markup. Attachments are not imported.

Replies with `In-Reply-To` or `References` headers append to the original ticket when sent by its requester or a trusted address listed in `SUPPORT_EMAILS`. Other senders create separate tickets. Subject lines alone do not establish a thread. A reply referencing an accepted message that is still retrying waits for that message instead of creating another ticket. If the referenced message has never reached this intake, the reply starts a new ticket.

The integration preserves existing HTML/Markdown when adding links or replies, and BookStack keeps revision history. BookStack's API has no atomic compare-and-swap for page edits: avoid saving a manual edit at exactly the same time an email update is appending to that page. Keep canonical `Asset ID` and `Ticket ID` tags intact for safe retries.

## Receive email

BookStack itself does not fetch an inbox. Connect your help desk mailbox to the authenticated raw-MIME intake endpoint through an MTA delivery pipe or a provider adapter that sends the complete RFC 822 message:

```text
POST /api/inbound/email
Authorization: Bearer <INBOUND_EMAIL_TOKEN>
Content-Type: message/rfc822

<raw email including From, Subject, Message-ID headers and body>
```

The included bridge accepts email on stdin:

```sh
node --env-file=/secure/path/assetdesk.env /path/to/AssetDesk/scripts/forward-email.mjs < message.eml
```

Set `ASSETDESK_INBOUND_URL` to your deployed intake URL and `INBOUND_EMAIL_TOKEN` in that private environment file. Configure a **dedicated mailbox/alias** in your mail server to pipe messages through this command as an unprivileged account. For Postfix, the local alias or pipe transport should execute the wrapper as a restricted mail-delivery user. Test with a staging mailbox before routing live mail. The bridge returns exit code 75 on temporary delivery failure so the MTA can retry, or 65 for invalid/oversized mail; HTTP success means durable acceptance, while processing may still be queued. It uses a 30-second request timeout and a 10 MiB message limit. Retried messages should retain the original `Message-ID`.

A provider's usual parsed-JSON webhook cannot be pointed directly at this raw-message endpoint. Use the provider's authenticated raw-message mode or write an adapter that validates the provider signature and forwards the original MIME. Do not expose the endpoint without its bearer token. Neither `From` headers nor display names prove sender identity: apply spam filtering, SPF/DKIM/DMARC checks, sender restrictions, and recipient filtering in your trusted mail gateway. AssetDesk never grants wiki access based on an email address.

Local sample delivery (no external email is sent):

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

## Administration and validation

The companion listens on port **3000**. `GET /healthz` checks the process; `GET /readyz` verifies the required BookStack integration. Administrative JSON intake is available at `POST /api/tickets` with bearer `ADMIN_TOKEN` and fields `subject`, `from` (an email address string), `text`, and an optional stable RFC Message-ID such as `<unique@example.com>`. Acceptance returns a receipt and `statusUrl`; poll that URL with `ADMIN_TOKEN` to see processing complete or fail. `GET /api/tickets/:key` retrieves the ticket after processing. `GET /api/queue` reports counts, and `POST /api/receipts/:id/retry` retries a failed receipt after fixing its cause. Protect these tokens separately from the email-delivery credential.

```sh
npm test
node --env-file=.env scripts/smoke.mjs
docker compose ps
```

The smoke script exercises the running HTTP intake and real BookStack API. It creates test records, so run it against a development instance.

Optionally provide `SMOKE_OPERATOR_TOKEN_ID` and `SMOKE_OPERATOR_TOKEN_SECRET` for a separate operator account to verify moving a ticket into the Resolved chapter. The intake account deliberately cannot delete/move pages.

To develop the companion outside Docker, keep BookStack/database running and use:

```sh
BOOKSTACK_URL=http://127.0.0.1:6875 node --env-file=.env --watch src/server.js
```

Stop the Compose companion first to avoid a port conflict. Compose uses its own internal BookStack URL. Keep `BOOKSTACK_PUBLIC_URL` equal to BookStack's `APP_URL`; use your real HTTPS URL before deployment. If the BookStack URL changes after records exist, follow BookStack's `bookstack:update-url` procedure.

The SQLite intake queue persists separately from BookStack. Failed remote operations are retried; do not delete the queue when restarting the worker. BookStack API credentials must retain access to the books/assets the integration manages. Use one companion instance per SQLite database. Monitor readiness and failed processing records; backup and restore the queue together with BookStack's MariaDB and `/config` data. Docker named volumes retain data across `docker compose down`; **`docker compose down -v` deletes it**.

## Existing BookStack / production

You can run the companion against an existing instance instead of the bundled database/wiki. In BookStack, create a dedicated integration user and role with **Access system API** and view/create/update rights on shelves, books, chapters, and pages needed by the workflow. Generate an API token in that user's profile. Configure `BOOKSTACK_URL`, `BOOKSTACK_PUBLIC_URL`, `BOOKSTACK_TOKEN_ID`, and `BOOKSTACK_TOKEN_SECRET` in a private environment, and run only the companion. Never give this service a personal administrator token. Restrict the integration's accessible content with BookStack permissions after provisioning.

Before use with real requests, configure HTTPS/reverse proxy and your actual `APP_URL`, mail routing, administrator accounts, backups, and access controls. Tickets can contain private information; keep guest access disabled and restrict who can view ticket and asset books. The included Compose deployment is a local development setup. Inbound mailbox hosting, DNS/MX records, outbound acknowledgements, attachment storage, and production TLS are deployment choices and are not automatically provisioned.

BookStack is an independent GPL-licensed open source project. The integration communicates with its documented REST API and does not modify the BookStack application. See [BookStack documentation](https://www.bookstackapp.com/docs/) and [LinuxServer's BookStack container documentation](https://docs.linuxserver.io/images/docker-bookstack/).
