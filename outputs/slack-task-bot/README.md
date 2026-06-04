# Whop CSM Slack Task Bot MVP

Slack Bolt + TypeScript MVP for capturing customer requests from 100+ customer Slack channels and managing them from Slack.

## What It Does

- Creates a request when someone mentions the bot in a channel or thread.
- Sends the requester a private DM with the request title and live status.
- Assigns the request to the channel's default CSM owner.
- Lets CSMs view and manage their assigned open requests with `/my-requests`.
- Lets admins view all open requests with `/all-requests`.
- Supports status updates, custom statuses, due dates, blockers, internal notes, reassignment, and requester notifications.
- Lets CSMs push a request back to the requester when more information is needed.
- Always notifies the requester in the original thread when a request is marked `Done`.
- Sends daily DM reminders to the owner for due-today or overdue requests that are not done.

## Stack

- Node.js + TypeScript
- Slack Bolt
- Prisma ORM
- PostgreSQL

## Project Structure

```text
.
├── prisma
│   ├── migrations/20260531000000_init/migration.sql
│   ├── schema.prisma
│   └── seed.ts
├── src
│   ├── actions/registerActions.ts
│   ├── commands/registerCommands.ts
│   ├── jobs/reminders.ts
│   ├── lib
│   ├── services
│   ├── slack
│   └── index.ts
├── .env.example
├── package.json
└── tsconfig.json
```

## Slack App Setup

Create a Slack app at [api.slack.com/apps](https://api.slack.com/apps).

For local development, enable Socket Mode and create an app-level token with:

- `connections:write`

Bot token scopes:

- `app_mentions:read`
- `channels:history`
- `channels:read`
- `chat:write`
- `commands`
- `groups:history`
- `groups:read`
- `im:write`
- `users:read`

Event subscriptions:

- `app_mention`

Slash commands:

- `/my-requests`
- `/all-requests`
- `/request`
- `/request-map-channel`
- `/request-reassign`
- `/request-help`

Interactive components must be enabled.

## Environment

```bash
cp .env.example .env
```

Fill in:

- `DATABASE_URL`
- `SLACK_BOT_TOKEN`
- `SLACK_SIGNING_SECRET`
- `SLACK_APP_TOKEN`
- `ADMIN_SLACK_USER_IDS`
- `OPENAI_API_KEY` or save the key from `/dashboard/settings`

Optional:

- `OPENAI_MODEL` defaults to `gpt-5-nano`

In Render, you can add `OPENAI_API_KEY` under the `whop-slack-task-bot` service's **Environment** tab, or paste the key into `/dashboard/settings`. Locally, put the same key in `.env`.

For Socket Mode local development:

```env
SLACK_SOCKET_MODE="true"
```

For HTTP deployments behind a public URL, set:

```env
SLACK_SOCKET_MODE="false"
PORT="3000"
```

## Run Locally

```bash
docker compose up -d
npm install
npm run prisma:generate
npm run prisma:migrate
npm run prisma:seed
npm run dev
```

## Deploy On Render

This repo includes `render.yaml`, which creates:

- A PostgreSQL database
- A Node worker service running the Slack bot in Socket Mode

Socket Mode is intentional for the MVP because Slack can reach the bot without exposing a public request URL.

Steps:

1. Push this folder to a GitHub repo.
2. In Render, choose **New > Blueprint** and select the repo.
3. Add these secret environment variables when prompted:

```env
SLACK_BOT_TOKEN="xoxb-..."
SLACK_SIGNING_SECRET="..."
SLACK_APP_TOKEN="xapp-..."
ADMIN_SLACK_USER_IDS="U123ADMIN,U456ADMIN"
```

Render injects `DATABASE_URL` from the managed Postgres database. On deploy, the service runs Prisma migrations before starting the bot.

## Deploy With Docker

The included `Dockerfile` works for platforms such as Fly.io, Railway, ECS, or any container host.

Required runtime env vars:

```env
DATABASE_URL="postgresql://..."
SLACK_BOT_TOKEN="xoxb-..."
SLACK_SIGNING_SECRET="..."
SLACK_APP_TOKEN="xapp-..."
SLACK_SOCKET_MODE="true"
ADMIN_SLACK_USER_IDS="U123ADMIN"
REMINDER_INTERVAL_MINUTES="60"
```

## Commands

### `/my-requests`

Shows open requests assigned to the logged-in CSM.

### `/all-requests`

Admin-only view of all open requests.

### `/request`

Opens a Slack modal to create a request from the current channel. Text after the command is optional and pre-fills the request details field.

Example:

```text
/request
/request I need a checkout link for $10,000 Splitit
```

The modal captures title, request details, request type, optional due date, and optional blocker. App mentions are still the preferred customer submission path because they preserve the original Slack thread reference.

### `/request-map-channel <channel_id> <@csm|user_id>`

Admin-only. Maps a Slack channel to its default CSM owner.

Example:

```text
/request-map-channel C123456 <@U123456>
```

### `/request-reassign <request_id> <@csm|user_id>`

Admin-only slash command for reassignment. CSMs can reassign from the request detail modal.

Example:

```text
/request-reassign 123 <@U123456>
```

### `/request-help`

Shows command help.

## Request Types And Flexible Metadata

The bot uses OpenAI to classify and enrich requests when an OpenAI API key is saved from the dashboard or `OPENAI_API_KEY` is set. If the key is missing or OpenAI fails, it falls back to conservative keyword matching. Request type is only a broad grouping for common workflows, not a complete taxonomy. Every request stores flexible metadata so random one-off asks can be tracked without adding a new enum or migration:

- `aiTags`
- `intent`
- `extractedFields`
- `suggestedNextStep`
- `confidence`

- Checkout link
- Splitit whitelist
- Refund payment
- Bug report
- Enhancement request
- KYC/KYB
- Payment issue
- Account settings
- Other

## Statuses

Default statuses:

- Submitted
- In Progress
- Done

Custom statuses are stored as `CUSTOM` plus `customStatus`, for example:

- Waiting on customer
- Waiting on engineering
- Waiting on docs
- Blocked by missing info

## Notes And Notifications

Internal notes are stored in the database and shown only in the request detail modal. They are not posted in the customer channel.

Status changes do not automatically notify the requester except for `Done`. CSMs can use `Notify requester` in the request detail modal to post the current status in the original thread.

## Reminder Behavior

The in-process reminder job runs every `REMINDER_INTERVAL_MINUTES`.

- If a request is due today and not done, the owner gets a DM.
- If a request is overdue and not done, the owner gets one DM per day.

For production, run only one bot worker with the reminder job enabled, or move reminders to a dedicated scheduler.

## MVP Boundaries

This intentionally does not include:

- Priorities
- SLA tracking
- Escalation flows
- Watchers
- Internal team ownership

Future custom-command support can build on the same modal pattern used by `/request`: store a command definition with field configs, render those fields in a Slack modal, then map the submitted values into a normal request record.

## Dashboard

When `SLACK_SOCKET_MODE` is `true`, the app also serves a lightweight admin dashboard:

```text
https://your-service.onrender.com/dashboard
```

Set `DASHBOARD_ADMIN_TOKEN` for dashboard access. If it is not set, the app falls back to the first Slack user ID in `ADMIN_SLACK_USER_IDS`.

The dashboard currently supports:

- Metrics, channel management, and settings pages
- Syncing public/private Slack channels and channel members the bot can see
- Viewing all known channels
- Assigning channel ownership from each channel's synced member list
- Uploading an OpenAI API key from the dashboard
- Configuring the Splitit agent executor webhook
- Assigning channel-scoped member roles: `ADMIN`, `CSM`, `SALES_REP`, `REQUESTER`
- Viewing basic open/total request counts per channel
- Viewing immediate request counts by status, request type, channel, and recent activity

## Splitit Whitelist Agent

Splitit whitelist requests include a `Queue Splitit agent` button in the request detail view.

The first version is intentionally controlled:

- The CSM must click the button to approve the automation.
- The bot extracts the target customer email from the request.
- The worker queues a `SplititAutomationJob`.
- The script sent to the executor is:
  - `Mitchell Rodio`
  - `Merchant`
  - `Whop.com mitchell.rodio@whop.com`
  - `Please whitelist, I understand the risks <customer email>`
- The worker updates the request status as queued, waiting on Splitit, blocked, or done.

To connect the real Splitit chat automation, set `SPLITIT_AGENT_WEBHOOK_URL` in Render or in dashboard settings. The bot will POST:

```json
{
  "jobId": "job_id",
  "requestId": 123,
  "targetEmail": "customer@example.com",
  "messages": ["Mitchell Rodio", "Merchant", "Whop.com mitchell.rodio@whop.com", "Please whitelist, I understand the risks customer@example.com"],
  "conversationPlan": [
    { "step": "SENT_NAME", "waitFor": "Splitit chat is open and asks who is chatting or requests a name", "send": "Mitchell Rodio" },
    { "step": "SENT_ROLE", "waitFor": "Splitit asks for account type, role, or whether this is merchant/customer", "send": "Merchant" },
    { "step": "SENT_STORE_AND_EMAIL", "waitFor": "Splitit asks for store name and/or merchant account email", "send": "Whop.com mitchell.rodio@whop.com" },
    { "step": "SENT_WHITELIST_REQUEST", "waitFor": "Splitit asks how it can help or is ready for the whitelist request", "send": "Please whitelist, I understand the risks customer@example.com" }
  ],
  "action": "run_script",
  "splititUrl": "https://splitit.com"
}
```

The executor should open `https://splitit.com`, click the chat in the bottom-right corner, then use `conversationPlan` step-by-step. It should wait for the prompt described by `waitFor`, send only that step's `send` value, wait for the next prompt, and continue. It should not dump all messages at once.

The executor should return:

```json
{ "status": "waiting", "response": "Submitted to Splitit.", "sentMessages": ["Mitchell Rodio", "Merchant"] }
```

or:

```json
{ "status": "done", "response": "Whitelisted successfully." }
```

If no executor webhook is configured, the job blocks cleanly and DMs the owner with the exact script that is ready to send.

The `/dashboard/splitit` page shows all Splitit automation chats, records every agent/Splitit/CSM/system message, and lets an admin manually send a message into a live chat through the executor webhook.
It also includes cleanup controls to delete one chat, clear off/done agents, or clear all Splitit chat records.

## Splitit Browser Executor

The companion browser executor lives in `outputs/splitit-agent`.

It is a Playwright service that:

- opens `https://splitit.com`
- clicks the bottom-right chat launcher
- waits for the chat prompt to appear/change
- sends each `conversationPlan` value one at a time
- keeps a persistent browser profile under `/data`
- exposes `/sessions/:jobId` so a live Chromium session can be watched from the dashboard

Deploy it as a separate Render web service with:

- root directory: `outputs/splitit-agent`
- Dockerfile: `Dockerfile`
- env var: `SPLITIT_AGENT_SECRET`
- persistent disk mounted at `/data`

After deploying, set the Radar dashboard Splitit agent settings to:

```text
Executor webhook URL: https://your-splitit-agent-service.onrender.com/splitit/execute
Webhook secret: same value as SPLITIT_AGENT_SECRET
```
