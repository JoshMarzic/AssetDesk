# AssetDesk

AssetDesk is a self-contained IT service desk: **tickets, technicians, knowledge, personnel, hardware, and support history in one application**. It runs as one Docker service and stores its data in SQLite. BookStack and MariaDB are not required by the application.

The home dashboard shows the active queue, unassigned and overdue work, and technician workload. Knowledge categories have their own access controls. Assets include people and equipment, with ticket links in both directions. **Actions** runs templates with approvals, email, API calls, Power Automate flows, manual tasks, and delays. **Workflows** combine those templates and other workflows into reusable sequences.

See [DEPLOYMENT.md](DEPLOYMENT.md) for Docker Desktop installation, upgrades, migration, HTTPS, and mailbox routing.

View the [AssetDesk v0.7 Feature Tour (PDF)](docs/AssetDesk-Feature-Tour.pdf) for 23 pages of screenshots and feature captions using demonstration data. This snapshot predates the executable Actions workflows introduced in v0.8.

## Run locally

Requires Docker with Compose v2 and Node.js 24. Start Docker Desktop using Linux containers, then run:

```sh
git clone https://github.com/JoshMarzic/AssetDesk.git
cd AssetDesk
node scripts/setup.mjs
docker compose up -d --build --wait assetdesk
```

Open `http://localhost:3000` on the computer running Docker. Your private `.env` file contains `DASHBOARD_ADMIN_EMAIL` (initially `admin@assetdesk.local`) and the generated `DASHBOARD_ADMIN_PASSWORD`. These initialize the first administrator; restarting the application or changing the bootstrap variables does not reset an existing account.

Setup generates missing local credentials and preserves existing nonempty values. Keep `.env` private. The Docker `intake` volume retains the complete native database across restarts.

For host development:

```sh
npm ci
node scripts/setup.mjs
node --env-file=.env --watch src/server.js
```

Stop the Compose service first if it already occupies port 3000. When a managed cloud build supplies a proxy CA, use the existing optional BuildKit secret without disabling TLS verification:

```sh
docker build --secret id=proxy_ca,src="$CODEX_PROXY_CERT" -t assetdesk-assetdesk .
docker compose up -d --wait assetdesk
```

## Tickets and technicians

Administrators create named technician accounts in Team and securely share their initial passwords. Dashboard sessions use hashed passwords, HttpOnly cookies, CSRF protection, role checks, and login rate limiting. Technicians work tickets; administrators manage accounts and category access. The application protects its last active administrator.

Tickets are saved locally and open immediately. Set General/Hardware/Software/Network/Access classification, Low/Normal/High/Urgent priority, and a technician assignment. Use **Assign to me**, internal notes, and the shared response library to reduce repetitive work. Statuses are Open, In Progress, Waiting, Resolved, and Closed. Resolving requires a summary; version checks prevent silently overwriting a teammate's changes.

Response templates support `{{requester}}`, `{{technician}}`, `{{ticket_id}}`, and `{{subject}}`. Insert one into an internal note or copy it for your mail client. These actions do not send email. Mark first response only after contacting the requester; it records that action rather than sending a reply.

Use **Tags** on any ticket to add labels such as `VIP`, `needs approval`, or `onboarding`. Type a new tag and press **Enter** to save it immediately, or reuse an existing suggestion. Remove a tag with its remove button. Tags can also be entered while creating a ticket. Names are case-insensitive and allow up to 50 characters. There is no per-ticket tag-count limit; changing tags records an activity entry.

Response and resolution indicators use elapsed wall-clock time from original ticket acceptance. These default targets can be edited in Settings:

| Priority | First response | Resolution |
| --- | --- | --- |
| Low | 24 hours | 120 hours |
| Normal | 8 hours | 72 hours |
| High | 2 hours | 24 hours |
| Urgent | 1 hour | 8 hours |

Waiting does not pause the clock, and reopening retains the original deadlines. Business-hour calendars and automatic escalation are not implemented.

## Native knowledge and category permissions

Select **Knowledge base** to browse categories, search, and read or edit articles without another account or website. The rich editor supports headings, lists, links, tables already present in documents, and code. Native raster images are stored with the application and checked against the parent record's current category permissions.

Administrators create and manage categories:

- **All staff:** signed-in technicians can read the category. Staff editing can be enabled or disabled.
- **Restricted:** choose the named technicians who may read and/or edit its contents. Editors also have read access.
- **Administrators:** always retain access and manage permission grants.

Category permissions apply to the information inside the category, not just its navigation link. Lists, search results, counts, direct article URLs, asset records, and media access are filtered on the server. Moving an article or asset requires edit access to its source and destination categories. Someone without access receives a not-found response rather than a hidden category's content.

The default **General** category holds shared documentation. **Assets** has its own area within the knowledge base, showing native asset records alongside any asset documentation. Additional categories can be created for shared or restricted groups of assets.

## Personnel and equipment assets

Use **Assets** to create and filter personnel, PCs, laptops, servers, printers, network equipment, peripherals, general hardware, and other records. Each has a unique asset ID, name, category, lifecycle status, and notes. Equipment can include serial number, manufacturer, model, department, location, and a linked personnel owner. A personnel record represents a person being supported; it is separate from a technician login.

The inventory is grouped by asset type. Use the **Personnel**, **Hardware**, and **Other** buttons at the top to show one group or combine several. **Hardware** includes all equipment types; expand **Hardware types** to choose specific types, such as personnel and PCs together. **All types** clears the type selection while keeping search and knowledge-category filters. **Clear filters** resets the whole search. Counts include only matching assets you can access, and pagination keeps each type together in a stable order. Your selection remains when you open a record and return to the list.

Below the type controls, **Show asset locations** lists the five named locations with the most matching assets, ordered from largest to smallest count. Expand **More locations** for the remaining locations, a location-list search, and **No location set**. Select several locations to combine them with your asset types, search, and category. **All locations** clears only the location selection. Counts cover every matching page and respect your access permissions; rankings update when you change types, search, or category.

Asset IDs in tickets, such as `LAPTOP-1042`, `PC-17`, or `[asset: YOUR-ID]`, reuse a matching native record or create an unverified record when one does not exist. Configure automatic prefixes through `ASSET_PREFIXES`; prefix matches require a digit to avoid treating ordinary prose as equipment. Explicit `[asset: ...]` references support other identifiers.

You can also link an accessible asset manually from a ticket. The asset's detail page shows every linked ticket, including its subject, status, ticket ID, and date, with a link to the full request. The ticket links back to the asset. Repeated associations do not create duplicates. Category permissions determine which asset information a technician can see or change, including asset links on tickets.

## Actions

Select **Actions → New action** to open the workflow page. Start with a reusable template or build an ordered sequence of steps. Action templates separate the standard process from the details that change: for example, `{{person_name}}`, `{{request_details}}`, and `{{approver_email}}`. The editor highlights variable tokens and lists editable values together, so reviewers can see who the request concerns, what is requested, and who approves it.

Each template has a **title**, a **description**, and a **Technical implementation**. Edit the implementation's step type and fields to define the actual operation. The technical preview shows the SMTP message, HTTP request and JSON payload, assigned task, or wait operation that those fields produce. Variable placeholders stay highlighted in the template, and the run preview shows their substituted values. This view comes from the executable workflow definition, so it stays in sync with what the server executes. Authentication settings and private trigger URLs remain on the server.

| Step | Behavior |
| --- | --- |
| Approval | Emails one recipient a review link, then pauses for an explicit Approve or Reject response. Rejection stops the workflow. |
| Send email | Sends a plain-text message through the configured SMTP service. |
| API call | Calls a server-configured API connection with the selected method, relative path, and JSON body. |
| Power Automate | Sends a JSON payload to a configured HTTP-triggered flow. HTTP acceptance confirms the trigger received the request; the flow continues in Power Automate. |
| Manual task | Waits until the assigned technician completes the work. |
| Delay | Waits for a persisted duration before proceeding. |

**Save as template** stores a standard workflow without executing it. **Start action** validates the variables, snapshots the selected template and values, and starts a run. Later template edits do not change existing runs. Template owners and administrators can edit their templates; run controls also check the current user's permissions. The starter equipment-preparation template works without external integrations.

Run details show progress, waiting steps, outcomes, and an activity history. Approval links expire, can be decided only once, and do not approve anything when simply opened by a browser or mail scanner. Approvers use the review page; ordinary email replies do not approve a request. Runs and wait states survive restarts. An external step interrupted before its outcome is known needs operator attention instead of being silently repeated; check the remote service before retrying it.

Manual tasks and delays work without email or API configuration. Email and approval steps require SMTP settings, and approvals also require the public AssetDesk address. API calls and Power Automate flows require configured connections and permitted account roles. Unconfigured integrations produce a visible blocked state rather than a successful result. See [automation configuration](DEPLOYMENT.md#configure-actions-email-and-api-connections).

## Workflows

Open **Actions → Workflows → New workflow** to combine saved action templates and nested workflows. Give the workflow a title and description, define its editable inputs, and choose a template or workflow for each step. Map the selected item's variables to workflow inputs such as `{{person_name}}` and `{{manager_email}}`, or enter fixed values. Reusing a template in two steps keeps their input values separate.

Drag a step by its handle to change the sequence. Move-up and move-down buttons also support keyboard and touch use. The overview on the right shows step titles connected in order; select a title to jump to that step. Nested workflows retain their own ordered sequence.

An employee onboarding process can be assembled as:

1. **Get approval** — an approval template addressed to `{{manager_email}}`.
2. **Setup standard user** — a nested workflow containing the Active Directory, HR system, and SAP provisioning templates.
3. **Notify IT** — an email template with account information or instructions for additional setup.
4. **Welcome employee** — an email template addressed to the new user's email input.

Configure each provisioning template with your organisation's API connection or Power Automate flow, then test it with development accounts. Starting the workflow captures its referenced definitions and values in one saved run. Every step runs in sequence: pending approval, manual work, or a delay holds later steps; rejection stops the workflow. The run page shows both the workflow overview and the underlying technical operations, with the existing completion, retry, and cancellation controls.

Saved workflows track reference versions. If a referenced template or workflow changes, refresh the references and review its variable mappings before saving and starting a new run. For nested changes, update the innermost affected workflow first, then refresh its parent workflows. Existing runs retain their original snapshot. Workflow owners and administrators can edit or archive workflows. Circular nesting, excessive nesting, and oversized expanded sequences are rejected before execution.

## Ticket reports and CSV export

Select **Reports**, immediately below Actions, to search ticket history. Combine submitted-date ranges, ticket type/category, status, priority, technician, source, requester, and text searches. Advanced filters cover specific ticket fields, notes, linked assets, response/resolution records and SLA outcomes, elapsed minutes, and note/asset counts. The date selector also supports updated, first-response, resolved, and due dates. Date ranges include both selected calendar days in UTC.

Select **Search tickets** to apply the filters. Results show the matching count, support sorting and pagination, and open the existing ticket details. **Export CSV** downloads every matching ticket using the applied search, including results on other pages. Unsubmitted filter edits do not change the export. CSV files use UTF-8, preserve quoted/multiline text, and neutralize spreadsheet formulas in ticket content. Asset filters, counts, and exported details follow the signed-in user's category permissions.

The **Tag** filter matches one complete tag, ignoring case and extra spaces. The general search also finds partial tag names. Report results display ticket tags, and CSV exports include a **Tags** column.

## Settings

Administrators use **Settings** to manage ticket statuses, priorities and SLA targets, ticket categories, and technician accounts. Knowledge categories and their permissions are also accessible from this area. Team remains available for technician management.

Create custom priorities with an urgency rank and response/resolution targets in hours, including fractional hours. Larger ranks appear first when sorting by priority. Editing a target preserves existing ticket deadlines by default. Select **Apply SLA changes to active tickets** to recalculate deadlines for active tickets using that priority, anchored to their original submission time; completed tickets retain their deadlines.

Custom statuses have an Active, Resolved, or Closed behavior. This behavior controls dashboards, overdue checks, required resolution summaries, and reply reopening. Behavior is fixed after creation; display names can be edited. Custom statuses, priorities, and categories can be archived to stop new assignments while retaining their names and history in tickets, Reports, and CSV exports. Default options remain available for email intake. Settings changes require administrator access and reject stale saves instead of replacing another administrator's changes.

## Upgrade and optional legacy import

Existing tickets, accounts, notes, sessions, and saved responses remain in the original SQLite `intake` volume. Back up that volume and private `.env`, then update:

```sh
git pull
node scripts/setup.mjs
docker compose up -d --build --wait assetdesk
```

Existing local asset references and ticket associations are converted into native records automatically. The runtime no longer contacts BookStack, and the old database/wiki containers are not part of the default Compose file. Updating the application does not delete their volumes.

If an earlier installation has knowledge or detailed asset pages in BookStack, keep the original legacy credentials and containers available and explicitly run the one-time importer:

```sh
node scripts/import-bookstack.mjs --container
```

The helper stops AssetDesk, makes a consistent SQLite backup beside its database, imports into the retained volume, and restarts AssetDesk. It passes legacy connection settings through stdin; it does not put credentials into command arguments or application configuration. It is repeatable and skips already imported content, preserving subsequent native edits. See [DEPLOYMENT.md](DEPLOYMENT.md) before stopping any legacy service.

Imported categories are **administrator-only by default** because legacy permissions cannot be translated reliably to named AssetDesk accounts. Review the imported articles, ownership information, images, and links, then grant access in category settings. Ticket mirrors are skipped because native ticket data already exists. Review the import summary for unavailable images or unresolved links and retain the legacy backups until verified.

The isolated `migration/` helper is used only by that explicit command. The server never imports or connects to the legacy client. Fresh installations need no BookStack credentials, services, or migration step.

## Receive email

AssetDesk accepts raw mail but does not poll Microsoft 365, Gmail, or IMAP. Connect a dedicated support address through an MTA delivery pipe or a provider adapter:

```text
POST /api/inbound/email
Authorization: Bearer <INBOUND_EMAIL_TOKEN>
Content-Type: message/rfc822

<complete raw RFC 822/MIME email>
```

The included bridge accepts email on stdin:

```sh
node --env-file=/secure/path/assetdesk-mail.env /path/to/AssetDesk/scripts/forward-email.mjs < message.eml
```

Give that private mail configuration only `INBOUND_EMAIL_TOKEN` and `ASSETDESK_INBOUND_URL`, not full application credentials. Run the bridge as a restricted delivery user. Exit 75 requests retry after temporary failure; exit 65 rejects invalid or oversized mail. Limits are 10 MiB raw mail and 100,000 decoded body characters. Retain the original Message-ID for retries.

Validate provider signatures, sender/recipient restrictions, spam filtering, SPF/DKIM/DMARC at the trusted mail gateway. A From header does not authenticate a person or grant application access. Parsed-JSON provider webhooks need an adapter that preserves the original MIME.

Replies with In-Reply-To or References join an existing ticket when sent by its requester or an address in `SUPPORT_EMAILS`; other senders create separate requests. Requester replies reopen resolved/closed tickets. Subject lines alone do not establish a thread. Duplicate delivery does not duplicate a ticket or note.

## Validation and operations

```sh
npm ci
npm test
npm run test:browser
docker compose ps
curl --fail http://127.0.0.1:3000/readyz
```

Browser tests use Playwright Chromium or a compatible installed browser. See the runner for the executable-path override. Smoke scripts create labeled development data; use a development instance when running them.

`/healthz` checks the process; `/readyz` checks local SQLite readiness. Original bearer-admin intake and receipt endpoints remain available for integration administration. Browser endpoints use the signed-in session and category permissions.

Back up and restore the **SQLite database and private `.env` together**. SQLite includes tickets, accepted mail, accounts, notes, sessions, response templates, categories, permission grants, assets, media, and import mappings. Use a consistent SQLite backup, not a copy of only the main file while its WAL is active. Run one AssetDesk service per SQLite database.

Named volumes survive `docker compose down`. **`docker compose down -v` deletes the native database volume.** Public hosting, HTTPS, external mailbox routing, and backups remain deployment responsibilities. Outgoing email, attachments, invitations/reset emails, and active automations are not supplied by the bundled application.
