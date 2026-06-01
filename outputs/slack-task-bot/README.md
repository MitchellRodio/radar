# Whop CSM Slack Task Bot MVP

Slack Bolt + TypeScript MVP for capturing customer requests from 100+ customer Slack channels and managing them from Slack.

## What It Does

- Creates a request when someone mentions the bot in a channel or thread.
- Replies in-thread with `Request created: #123`.
- Assigns the request to the channel's default CSM owner.
- Lets CSMs view and manage their assigned open requests with `/my-requests`.
- Lets admins view all open requests with `/all-requests`.
- Supports status updates, custom statuses, due dates, blockers, internal notes, reassignment, and requester notifications.
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

## Request Types

The bot detects request type using conservative keyword matching and defaults to `Other` when confidence is low.

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
- Advanced AI classification

Future custom-command support can build on the same modal pattern used by `/request`: store a command definition with field configs, render those fields in a Slack modal, then map the submitted values into a normal request record.
