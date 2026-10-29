# Deploy and test AssetDesk

## Get the code

Clone the repository or download its source archive:

```sh
git clone https://github.com/JoshMarzic/AssetDesk.git
cd AssetDesk
```

The repository excludes the development `.env`, dependencies, and database data. Each fresh installation generates its own credentials.

Prerequisites: **Docker Engine/Desktop, Docker Compose v2, Node.js 24, and npm**. Run the following commands in a Bash-compatible terminal from the extracted `AssetDesk` directory.

## Test on your computer

```sh
npm ci
node scripts/setup.mjs
docker compose up -d --wait db bookstack
node scripts/bootstrap-bookstack.mjs
docker compose up -d --build --wait assetdesk
npm test
node --env-file=.env scripts/smoke.mjs
docker compose ps
```

The bootstrap is for this pinned development stack. All three services should be healthy, the unit tests should pass, and the smoke test should print `PASS`. The smoke test creates labeled example tickets and assets in BookStack, without sending external email. It exercises the real HTTP intake and BookStack API.

On **the computer running Docker**, open `http://localhost:6875` in your browser. Sign in with `admin@admin.com` and the generated `BOOKSTACK_ADMIN_PASSWORD` from your private `.env` file. Do not use the stock BookStack password after running the development bootstrap.

Go to the **IT Help Desk** shelf. Its **Tickets** book contains Open, In Progress, and Resolved chapters; the **Assets** book contains ownership and equipment records. Open an asset and select Edit to enter an owner and location. Existing assets should have a unique `Asset ID` page tag, for example `LAPTOP-1042`.

To deliver your own sample email without an email server:

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

After a few seconds, refresh the Tickets and Assets books. Expect one ticket linked to `LAPTOP-1042`; a missing asset is created automatically. Delivering exactly the same message again should not create another ticket. Use a different Message-ID for a new issue mentioning the same asset, and confirm that it reuses the existing asset and preserves your ownership edits.

BookStack in a remote cloud workspace is not automatically reachable through your laptop's `localhost`. Run the source locally to test in your browser, or deploy it on a server. For a server you already access with SSH, a temporary tunnel is possible with `ssh -L 6875:127.0.0.1:6875 user@your-server` when BookStack is configured with the default local URL. This does not imply that the managed development workspace offers SSH access.

## Deploy on a Linux server with HTTPS

This example uses one server with Docker, Compose v2, Node.js 24/npm, and **Caddy installed on the host**. It is a deployment recipe; only the local Docker stack has been validated in this workspace.

1. Point `helpdesk.example.com` to the server's public IP. Allow inbound TCP ports 80 and 443. Keep the database and intake ports private. Replace the example hostname throughout these instructions.
2. Copy/extract the source to `/opt/assetdesk` and run:

   ```sh
   cd /opt/assetdesk
   npm ci
   node scripts/setup.mjs
   ```

3. Before starting BookStack for the first time, edit the private `.env` file and set:

   ```dotenv
   BOOKSTACK_PUBLIC_URL=https://helpdesk.example.com
   ```

   Leave the Compose internal `BOOKSTACK_URL` routing unchanged. Do not copy the workspace's development credentials. For an existing installation whose public URL changes, follow BookStack's `bookstack:update-url` procedure before using links created with the new URL.

4. Start the database and BookStack:

   ```sh
   docker compose up -d --wait db bookstack
   ```

5. Put this site in the host's `/etc/caddy/Caddyfile`, then reload Caddy. Public DNS and inbound ports 80/443 must be working for certificate issuance.

   ```caddyfile
   helpdesk.example.com {
       reverse_proxy 127.0.0.1:6875
   }
   ```

   ```sh
   sudo systemctl reload caddy
   ```

   This assumes Caddy is a host service. `127.0.0.1` inside a separate proxy container would refer to that container, so a containerized proxy requires a different network configuration.

6. Restrict initial access to yourself while completing first-run setup. For production, use native BookStack administration instead of the development bootstrap. On a brand-new BookStack database the initial login is `admin@admin.com` / `password`: **change that password immediately**, configure your real administrator account, and keep guest access disabled. The generated `BOOKSTACK_ADMIN_PASSWORD` in `.env` is only applied by the development bootstrap; it is not applied automatically by Compose.
7. In BookStack, create a dedicated **AssetDesk integration** role and user. Grant Access system API and view/create/update permissions on shelves, books, chapters, and pages needed by the workflow. Provisioning needs permission to create the help desk organization. The intake account does not need user administration, settings, or deletion rights. Create an API token for that user and securely replace the generated placeholders in `.env`:

   ```dotenv
   BOOKSTACK_TOKEN_ID=<token ID from BookStack>
   BOOKSTACK_TOKEN_SECRET=<token secret from BookStack>
   ```

   Restrict accessible content after provisioning as appropriate. Human agents who move tickets between chapters need BookStack's source page update/delete and destination page-create permissions.

8. Start the intake companion and verify it:

   ```sh
   docker compose up -d --build --wait assetdesk
   docker compose ps
   curl --fail http://127.0.0.1:3000/readyz
   ```

   Expect `{"status":"ready"}`. Run the unit tests with `npm test`. Use the sample delivery above for a staging ticket. The smoke script defaults to a local BookStack public URL; on this HTTPS installation use:

   ```sh
   SMOKE_BOOKSTACK_URL=https://helpdesk.example.com node --env-file=.env scripts/smoke.mjs
   ```

## Connect an actual mailbox

The service accepts email but does not poll Microsoft 365, Gmail, or an IMAP mailbox. Connect a dedicated support address through your mail server or a provider adapter.

For an MTA that can deliver mail to a pipe, configure it to run this command as a restricted delivery user, with the full raw message on stdin:

```sh
node --env-file=/secure/path/assetdesk-mail.env /opt/assetdesk/scripts/forward-email.mjs
```

The private mail configuration needs only `INBOUND_EMAIL_TOKEN` and `ASSETDESK_INBOUND_URL`; do not give a mail-delivery user access to the full application `.env`. If the MTA is on the same host, the intake URL is `http://127.0.0.1:3000/api/inbound/email`.

For a gateway on another host, add an HTTPS intake hostname to DNS and Caddy, exposing only the inbound route:

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

Set its private `ASSETDESK_INBOUND_URL` to `https://intake.example.com/api/inbound/email`. The gateway must send raw RFC 822/MIME using `Content-Type: message/rfc822` and `Authorization: Bearer <INBOUND_EMAIL_TOKEN>`. A provider's parsed-JSON webhook requires an adapter; it cannot be pointed directly at this endpoint. Configure trusted sender/recipient filtering and email authentication at the gateway. See README.md for threading and input limits.

## Restart, troubleshoot, and retain data

```sh
docker compose up -d --wait
docker compose ps
docker compose logs --tail=100 assetdesk bookstack
curl --fail http://127.0.0.1:3000/readyz
```

Keep the private `.env` and back up all three Docker volumes: `database` (MariaDB), `bookstack` (BookStack files), and `intake` (the SQLite email queue). Use database-aware backups and a consistent queue backup. Use one companion instance per queue. `docker compose down` retains volumes; **`docker compose down -v` deletes data**. Refresh expiring API tokens through native BookStack administration.

The bundled stack does not provision external mailbox hosting, attachments, outgoing acknowledgements, or a public server. These remain separate deployment configuration choices.
