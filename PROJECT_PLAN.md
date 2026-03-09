# CPV Booking Chat — Project Plan

## Overview

Refactor the current CLI proof-of-concept into a reusable **BookingService** shared by
independent clients: a **CLI desktop client** (the current implementation, promoted to a
first-class client), and bot clients for **Telegram** and **WhatsApp**, hosted on **AWS**.

---

## 1. Target Architecture

```
┌──────────────────────────────────────────────────────────────┐
│                         AWS Cloud                            │
│                                                              │
│  API Gateway (HTTPS endpoints)                               │
│    │                                                         │
│    ├── POST /telegram   ──►  Lambda: TelegramHandler         │
│    └── POST /whatsapp   ──►  Lambda: WhatsAppHandler         │
│              │                       │                       │
│              └──────────┬────────────┘                       │
│                         ▼                                    │
│               Lambda Layer: BookingService                   │
│                   (shared business logic)                    │
│                         │                                    │
│                         ▼                                    │
│            Microsoft Bookings API (external)                 │
│                                                              │
│  DynamoDB                                                    │
│    ├── conversation state  (userId → step)                   │
│    ├── user profiles       (userId → personal data)          │
│    └── watchlist           (userId → wanted slots)           │
│                                                              │
│  EventBridge Scheduler ──► Lambda: WatchlistPoller           │
│    (runs every hour, checks if slots became bookable)        │
│                                                              │
│  Secrets Manager ◄─── OWA cookie, canary, tokens            │
│  CloudWatch Logs ◄─── all Lambda output                     │
└──────────────────────────────────────────────────────────────┘

  Local machine (CLI client — no AWS required)
  ┌──────────────────────────────────────────┐
  │  pnpm dev  →  src/clients/cli/index.ts   │
  │       │                                  │
  │       ▼                                  │
  │  BookingService  (same as Lambda layer)  │
  │       │                                  │
  │       ▼                                  │
  │  Microsoft Bookings API (external)       │
  │                                          │
  │  User profile stored in local            │
  │  ~/.cpv-booking/profile.json             │
  └──────────────────────────────────────────┘
```

---

## 2. Recommended AWS Services

### Core

| Service                    | Purpose                                                              |
|----------------------------|----------------------------------------------------------------------|
| **Lambda**                 | Runs each bot handler as a serverless function triggered by webhooks |
| **API Gateway (HTTP API)** | Exposes HTTPS endpoints that Telegram / WhatsApp POST webhooks to    |
| **Lambda Layers**          | Packages the shared `BookingService` so both handlers share one copy |
| **DynamoDB**               | Conversation state, user profiles, and advance booking watchlist     |
| **Secrets Manager**        | Stores the OWA session cookie, canary token, and bot tokens securely |
| **CloudWatch Logs**        | Automatic log aggregation for all Lambda invocations                 |

### Why Lambda + API Gateway over EC2/ECS?

- Both Telegram (`setWebhook`) and WhatsApp (Meta Cloud API) push updates via **HTTP POST webhooks** — Lambda handles
  these natively with zero idle cost.
- No always-on server needed; scales to zero between bookings.
- Deploying a new bot client is a new Lambda function with zero infrastructure change.

### Optional / Later

| Service                   | Purpose                                                                         |
|---------------------------|---------------------------------------------------------------------------------|
| **SQS**                   | Decouple webhook receipt from processing if latency becomes an issue            |
| **EventBridge Scheduler** | Hourly watchlist poller + booking reminders before appointment                  |
| **SES**                   | Send email booking confirmations as a fallback                                  |
| **SSM Parameter Store**   | Lightweight alternative to Secrets Manager for non-sensitive config             |
| **SNS**                   | Fan-out notifications to multiple channels (Telegram + WhatsApp) simultaneously |

---

## 3. Proposed File Structure

```
cpv-booking-chat/
├── src/
│   ├── services/
│   │   ├── booking.service.ts       # extracted from index.ts — pure async functions, no I/O
│   │   ├── session.service.ts       # get/set/clear conversation state in DynamoDB
│   │   ├── user.service.ts          # CRUD for user profiles in DynamoDB
│   │   └── watchlist.service.ts     # add/remove/poll wanted slots in DynamoDB
│   ├── clients/
│   │   ├── cli/
│   │   │   ├── index.ts             # entry point — promoted from current src/index.ts
│   │   │   ├── prompts.ts           # all prompt-sync interactions (date, slot, profile)
│   │   │   └── profile.ts           # read/write ~/.cpv-booking/profile.json
│   │   ├── telegram/
│   │   │   ├── bot.ts               # Telegram bot dbSetup (telegraf)
│   │   │   └── handlers.ts          # conversation flow using BookingService
│   │   └── whatsapp/
│   │       ├── bot.ts               # WhatsApp webhook dbSetup (whatsapp-cloud-api / twilio)
│   │       └── handlers.ts          # conversation flow using BookingService
│   ├── lambda/
│   │   ├── telegram.handler.ts      # Lambda entry point for Telegram webhook
│   │   ├── whatsapp.handler.ts      # Lambda entry point for WhatsApp webhook
│   │   └── watchlist.handler.ts     # Lambda entry point for EventBridge watchlist poller
│   ├── config/
│   │   └── bookings.config.ts       # service IDs, staff IDs, time zones — no hardcoding
│   ├── types.ts
│   └── test.data.ts
├── infrastructure/                  # AWS CDK stack (TypeScript)
│   ├── app.ts
│   └── stacks/
│       └── booking-bot-stack.ts
├── PROJECT_PLAN.md
├── package.json
└── tsconfig.json
```

---

## 4. BookingService Interface (proposed)

Extract all Microsoft Bookings API logic from `index.ts` into pure async functions:

```typescript
// src/services/booking.service.ts

getAvailableSlots(date
:
DateTime
):
Promise<DateTime[]>
createAppointment(slot
:
DateTime, customerData
:
AppointmentCustomer
):
Promise<AppointmentResponse>
```

No `prompt`, no `console.log`, no `process.exit` — the service only talks to the API.
Each bot client is responsible for its own I/O and conversation state.

---

## 5. Conversation State in DynamoDB

Each user interaction is stateful across multiple messages. DynamoDB stores:

```
PK: "telegram#<chatId>"  or  "whatsapp#<phoneNumber>"
{
  step: "awaiting_date" | "awaiting_slot" | "confirming" | "done",
  selectedDate: "2026-03-10",
  selectedSlot: "10:00",
  ttl: <unix timestamp + 30 minutes>
}
```

TTL ensures stale sessions are automatically cleaned up.

---

## 6. User Profile Storage

Personal data currently hardcoded in `src/test.data.ts` (`customerData`) must be stored
per user in DynamoDB and collected once during a first-run onboarding flow.

### DynamoDB user profile record

```
PK: "profile#telegram#<chatId>"  or  "profile#whatsapp#<phoneNumber>"
{
  name:             "Oleksii Matiunin",
  emailAddress:     "user@example.com",
  phone:            "07xxxxxxxxx",
  membershipNumber: "6080",
  timeZone:         "GMT Standard Time",
  location: {
    displayName: "78 Curzon street",
    address: { street: "78 Curzon street", type: "Other" }
  },
  createdAt: "2026-03-03T00:00:00Z",
  updatedAt: "2026-03-03T00:00:00Z"
}
```

### Onboarding flow (first use)

1. Bot detects no profile exists for the user.
2. Asks for: full name → email → phone → membership number → address.
3. Saves profile to DynamoDB.
4. All subsequent bookings use the stored profile — no re-entry needed.
5. User can update their profile at any time with a `/profile` command.

> ⚠️ **GDPR note:** Personal data must only be stored with explicit user consent.
> Add a consent step at the start of onboarding and provide a `/delete` command
> that purges all stored data for that user.

---

## 7. Advance Booking Watchlist (2-Week Restriction)

Microsoft Bookings only allows bookings up to **2 weeks in advance** from today.
Users who want a slot further ahead need a watchlist mechanism.

### How it works

1. User requests a date beyond the 2-week window.
2. Bot offers to **add it to their watchlist** instead of booking immediately.
3. An **EventBridge Scheduler** triggers the `WatchlistPoller` Lambda **every hour**.
4. The poller checks each watchlist entry — if `wantedDate <= today + 14 days`:
    - Calls `getAvailableSlots(wantedDate)`.
    - If the wanted slot is available → **auto-books** it using the stored user profile.
    - Sends the user a **confirmation notification** via Telegram / WhatsApp.
    - If not available → optionally notify the user so they can choose a different slot.
5. If the slot was not booked within a configurable window (e.g. 3 days after becoming bookable), notify the user that
   it was missed.

### DynamoDB watchlist record

```
PK: "watchlist#telegram#<chatId>"
SK: "2026-04-15#10:00"           ← wantedDate#wantedTime (sort key enables range queries)
{
  wantedDate:  "2026-04-15",
  wantedTime:  "10:00",
  addedAt:     "2026-03-03T00:00:00Z",
  notifyOnly:  false,             ← true = notify but don't auto-book
  status:      "pending" | "booked" | "missed" | "cancelled"
}
```

### Notification channels

- **Telegram:** send message via `telegraf`
- **WhatsApp:** send template message via Meta Cloud API
- **Email (optional):** SES fallback using the stored `emailAddress`

---

## 8. Infrastructure as Code — AWS CDK

Use the **AWS CDK (TypeScript)** to define the entire stack:

```typescript
// infrastructure/stacks/booking-bot-stack.ts
new NodejsFunction(this, 'TelegramHandler', {entry: 'src/lambda/telegram.handler.ts'});
new NodejsFunction(this, 'WhatsAppHandler', {entry: 'src/lambda/whatsapp.handler.ts'});
new NodejsFunction(this, 'WatchlistPoller', {entry: 'src/lambda/watchlist.handler.ts'});
new HttpApi(this, 'BookingBotApi');
new Table(this, 'SessionTable', {partitionKey: {name: 'pk', type: AttributeType.STRING}});
new Schedule(this, 'WatchlistSchedule', {schedule: Schedule.rate(Duration.hours(1))});
```

---

## 9. Next Steps (ordered)

### Phase 1 — Refactor + CLI Client ✅

- [x] Extract `BookingService` from `index.ts` into `src/services/booking.service.ts`
- [x] Move hardcoded config (serviceId, staffIds, timeZone) to `src/config/bookings.config.ts`
- [x] Move current `src/index.ts` to `src/clients/cli/index.ts`
- [x] Extract prompt interactions into `src/clients/cli/prompts.ts`
- [x] Create `src/clients/cli/profile.ts` — reads/writes `~/.cpv-booking/profile.json` for local user profile storage (
  onboarding on first run, reused on subsequent runs)
- [x] Update `package.json` `dev` script to point to `src/clients/cli/index.ts`
- [x] CLI watchlist: store wanted slots in `~/.cpv-booking/watchlist.json` and check them on each run

### Phase 2 — User Profile Storage (DynamoDB, shared by bot clients) ✅

- [x] Design DynamoDB table schema (single-table design — sessions + profiles + watchlist)
- [x] Create `src/db/dynamo.ts` — DynamoDB DocumentClient singleton (uses `DYNAMODB_ENDPOINT` for local)
- [x] Create `src/db/dbSetup.ts` — one-time table creation script (`pnpm dbSetup:db`)
- [x] Create `src/services/user.service.ts` with `getProfile`, `saveProfile`, `deleteProfile`
- [x] Update `src/services/watchlist.service.ts` — replaced file I/O with DynamoDB
- [x] Update `src/services/profile.service.ts` — storage removed, keeps only `profileToCustomer`
- [x] Replace hardcoded `customerData` from `test.data.ts` with `user.service.getProfile(userId)`

### Phase 3 — Telegram Bot

- [x] Install `telegraf` (Telegram bot framework for Node.js/TypeScript)
- [x] Create `src/services/session.service.ts` — get/set/clear conversation state in DynamoDB (TTL 30 min)
- [x] Implement conversation flow in `src/clients/telegram/handlers.ts`
    - Step 0: onboarding if no profile exists (`/start` command)
    - Step 1: ask for date
    - Step 2: show available slots (or offer watchlist if date > 2 weeks out)
    - Step 3: confirm booking
    - `/profile` — view/update stored profile
    - `/delete` — GDPR purge of all user data
- [x] Add `TELEGRAM_BOT_TOKEN` to `.env`
- [x] Write `src/lambda/telegram.handler.ts` Lambda entry point
- [x] Test end-to-end locally with `telegraf` polling mode (long-polling, no webhook needed)

### Phase 4 — MVP Deployment 🚀

> **Milestone:** fully working booking flow for both CLI and Telegram, running in production on AWS.

- [x] Install AWS CDK: `pnpm add -D aws-cdk-lib constructs`
- [x] Write `infrastructure/stacks/booking-bot-stack.ts` (MVP scope):
    - `NodejsFunction` — Telegram handler Lambda
    - `HttpApi` (API Gateway) — single POST `/telegram` route
    - `Table` — DynamoDB single-table (sessions + profiles + watchlist)
    - `Secret` — OWA cookie, canary token, and `TELEGRAM_BOT_TOKEN` in Secrets Manager
- [x] Add `DYNAMODB_TABLE_NAME` and AWS credentials to production environment / GitHub secrets
- [x] `cdk deploy`
- [x] Register Telegram webhook: `setWebhook` → API Gateway URL
- [x] Smoke-test the full booking flow end-to-end via Telegram in production

---

> ✅ **MVP complete.** CLI and Telegram booking are live. Everything below extends the platform.

---

### Phase 5 — WhatsApp Bot ✅

- [x] Choose provider: **Meta Cloud API** (free, official)
- [x] Implement same conversation flow in `src/clients/whatsapp/handlers.ts` (reuse session + user services)
- [x] Write `src/clients/whatsapp/bot.ts` — WhatsApp Cloud API client (sendText, sendButtons, sendList)
- [x] Write `src/clients/whatsapp/server.ts` — local dev webhook server (use with ngrok)
- [x] Write `src/lambda/whatsapp.handler.ts` Lambda entry point (GET verification + POST messages)
- [x] Add `WHATSAPP_TOKEN` / `WHATSAPP_PHONE_NUMBER_ID` / `WHATSAPP_VERIFY_TOKEN` to `secrets-setup.ts`
- [x] Add `WhatsAppHandler` Lambda + GET+POST `/whatsapp` routes to CDK stack (`infrastructure/app.ts`)
- [x] Add `dev:whatsapp` script to `package.json` (local server on port 3001, expose via ngrok)
- [x] Register webhook URL with Meta Developer Console after `cdk deploy`

### Phase 6 — Advance Booking Watchlist (bots)

- [ ] Extend `src/services/watchlist.service.ts` with `addToWatchlist`, `getWatchlist`, `removeFromWatchlist`
- [ ] Write `src/lambda/watchlist.handler.ts` — hourly EventBridge-triggered poller
    - Query all `pending` watchlist entries where `wantedDate <= today + 14 days`
    - Attempt `getAvailableSlots` → if slot free, call `createAppointment`
    - Notify user of success or unavailability via Telegram / WhatsApp
- [ ] Add "notify only" option — user can opt out of auto-booking and just get alerted
- [ ] Wire watchlist offer into both bot handlers when user picks a date > 2 weeks out
- [ ] Extend `infrastructure/stacks/booking-bot-stack.ts`:
    - `NodejsFunction` — WhatsApp handler Lambda + POST `/whatsapp` route
    - `NodejsFunction` — WatchlistPoller Lambda
    - `Schedule` (EventBridge) — hourly trigger for WatchlistPoller
- [ ] `cdk deploy`
- [ ] Register WhatsApp webhook in Meta Developer Console

### Phase 7 — Hardening

- [ ] Add CloudWatch alarms for Lambda errors and DynamoDB throttles
- [ ] Add input validation for date and slot selection across all clients
- [ ] Handle edge cases: no slots available, booking conflict, API timeout, watchlist slot missed

### Phase 8 — Booking Cancellation

- [ ] Add `cancelAppointment(appointmentId)` to `BookingService` — calls Microsoft Bookings API to cancel
- [ ] Store `appointmentId` (returned by `createAppointment`) in DynamoDB on the booking record so it can be referenced
  later
- [ ] Extend `src/services/booking-record.service.ts` — CRUD for booking records in DynamoDB
  (`PK: "booking#<userId>", SK: <appointmentId>`)
- [ ] Add `/cancel` command to the Telegram bot — lists the user's upcoming bookings and lets them pick one to cancel
- [ ] Add cancellation step to the CLI client (`prompts.ts`)
- [ ] Send a cancellation confirmation message to the user after successful cancellation
- [ ] Mark the booking record status as `"cancelled"` in DynamoDB; do not delete (history / audit trail)

### Phase 9 — Opponent Details in Booking

- [ ] Extend the conversation flow in both CLI and Telegram: after slot confirmation, ask for the **opponent's name**
  and
  **opponent's email** and **opponent's phone**
- [ ] Store opponent details (`opponentName`, `opponentEmail`, `opponentPhone`) on the DynamoDB booking record (in
  `booking-record.service.ts`)
- [ ] ⚠️ **Outlook constraint:** the `opponentName` field sent to the Microsoft Bookings API must **always be an empty
  string** — Outlook does not support later changes to this field. Opponent identity is managed exclusively in DynamoDB.
- [ ] Include opponent details in booking confirmation messages sent to the booking person

### Phase 10 — Notifications for Booking Person & Opponent

- [ ] Create `src/services/notification.service.ts` — central hub for dispatching notifications across channels
  (Telegram message, WhatsApp template, SES email)
- [ ] After a booking is confirmed, send a confirmation message to the booking person via their preferred channel
- [ ] Send a notification email (SES) to the opponent's email address with full booking details (date, time, location,
  booking person's name and contact)
- [ ] On booking **cancellation**, send cancellation notifications to both the booking person and the opponent
- [ ] Hook `notification.service.ts` into the watchlist poller: notify on auto-book success, slot unavailability, and
  missed watchlist entries
- [ ] Add `src/lambda/notification.handler.ts` if async fan-out via SQS/SNS is needed at scale

### Phase 11 — Contact Preferences & Notification Settings

- [ ] Extend the user profile DynamoDB schema with a `contactPreferences` object:
  ```typescript
  contactPreferences: {
    allowNotifications: boolean;   // master switch — blocks all bot-initiated messages when false
    // future: allowEmail, allowSms, ...
  }
  ```
- [ ] In `notification.service.ts`, check `allowNotifications` before sending any message to a user; skip silently if
  disabled
- [ ] Extend the `/profile` command (Telegram) to display and toggle notification preferences
- [ ] Add a dedicated `/notifications` command (or inline keyboard shortcut) as a convenience alias for managing
  notification settings
- [ ] Update the onboarding flow to ask the user for their notification preference (default: `true`) and record explicit
  consent

### Phase 12 — Calendar Integration

- [ ] Extend the user profile DynamoDB schema with a `calendarIntegration` object:
  ```typescript
  calendarIntegration: {
    enabled: boolean;                           // master switch — off by default
    provider: "google" | "apple" | "ics" | null;
    // provider-specific OAuth tokens stored separately (DynamoDB or Secrets Manager, per user)
  }
  ```
- [ ] Extend the `/profile` command (Telegram) to configure calendar integration (provider + enable/disable)
- [ ] After a booking is confirmed, if `calendarIntegration.enabled`:
    - Generate an `.ics` file (iCalendar format) for the appointment using the `ics` package
    - Send the `.ics` file / a "Add to Calendar" link to the user via their notification channel
    - For `provider: "google"`: use the Google Calendar API (OAuth 2.0 flow) to create the event directly in the user's
      calendar
- [ ] On booking **cancellation**, send a calendar removal event (`.ics` with `METHOD:CANCEL`) or delete the Google
  Calendar event via API
- [ ] Store OAuth 2.0 tokens per user in DynamoDB (encrypted) or Secrets Manager; handle token refresh
- [ ] Add calendar-integration CDK resources: Lambda environment variables, IAM roles for Secrets Manager access

### Phase 13 — Opponent Change

- [ ] Add `/change-opponent` command to the Telegram bot — allows the booking creator to update the opponent on an
  existing booking
- [ ] Look up the existing booking record in DynamoDB via `booking-record.service.ts` (list upcoming bookings, let user
  pick one)
- [ ] Update `opponentName` and `opponentEmail` on the DynamoDB booking record only
- [ ] ⚠️ **Outlook constraint:** do **NOT** call the Microsoft Bookings API to update the appointment — Outlook does not
  support editing attendee details after creation. The `opponentName` sent to the API at booking time is always empty
  (see Phase 10).
- [ ] Notify the **new opponent** (email via SES) with the booking details
- [ ] Notify the **old opponent** (if a previous email was stored) that they have been removed from the booking
- [ ] Send a confirmation to the booking person that the opponent has been successfully updated

---

## 10. Key Dependencies to Add

| Package                           | Phase   | Purpose                                                  |
|-----------------------------------|---------|----------------------------------------------------------|
| `telegraf`                        | 3 (MVP) | Telegram bot framework                                   |
| `@aws-sdk/client-dynamodb`        | 3 (MVP) | DynamoDB for sessions, user profiles, watchlist          |
| `@aws-sdk/lib-dynamodb`           | 3 (MVP) | DynamoDB document client (easier API)                    |
| `aws-cdk-lib`                     | 4 (MVP) | Infrastructure as Code — CDK stack                       |
| `constructs`                      | 4 (MVP) | CDK constructs peer dependency                           |
| `@aws-sdk/client-secrets-manager` | 4 (MVP) | Read OWA cookie, canary token, and bot tokens at runtime |
| `aws-lambda`                      | 4 (MVP) | Lambda handler types                                     |
| `@types/aws-lambda`               | 4 (MVP) | TypeScript types for Lambda                              |
| `whatsapp-cloud-api` / `twilio`   | 5       | WhatsApp messaging provider                              |
| `@aws-sdk/client-ses`             | 11      | Send email notifications to booking person and opponent  |
| `ics`                             | 13      | Generate `.ics` (iCalendar) files for calendar invites   |
| `googleapis`                      | 13      | Google Calendar API — create/delete events via OAuth 2.0 |