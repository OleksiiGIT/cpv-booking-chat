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
| Service | Purpose |
|---|---|
| **Lambda** | Runs each bot handler as a serverless function triggered by webhooks |
| **API Gateway (HTTP API)** | Exposes HTTPS endpoints that Telegram / WhatsApp POST webhooks to |
| **Lambda Layers** | Packages the shared `BookingService` so both handlers share one copy |
| **DynamoDB** | Conversation state, user profiles, and advance booking watchlist |
| **Secrets Manager** | Stores the OWA session cookie, canary token, and bot tokens securely |
| **CloudWatch Logs** | Automatic log aggregation for all Lambda invocations |

### Why Lambda + API Gateway over EC2/ECS?
- Both Telegram (`setWebhook`) and WhatsApp (Meta Cloud API) push updates via **HTTP POST webhooks** — Lambda handles these natively with zero idle cost.
- No always-on server needed; scales to zero between bookings.
- Deploying a new bot client is a new Lambda function with zero infrastructure change.

### Optional / Later
| Service | Purpose |
|---|---|
| **SQS** | Decouple webhook receipt from processing if latency becomes an issue |
| **EventBridge Scheduler** | Hourly watchlist poller + booking reminders before appointment |
| **SES** | Send email booking confirmations as a fallback |
| **SSM Parameter Store** | Lightweight alternative to Secrets Manager for non-sensitive config |
| **SNS** | Fan-out notifications to multiple channels (Telegram + WhatsApp) simultaneously |

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
│   │   │   ├── bot.ts               # Telegram bot setup (telegraf)
│   │   │   └── handlers.ts          # conversation flow using BookingService
│   │   └── whatsapp/
│   │       ├── bot.ts               # WhatsApp webhook setup (whatsapp-cloud-api / twilio)
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

getAvailableSlots(date: DateTime): Promise<DateTime[]>
createAppointment(slot: DateTime, customerData: AppointmentCustomer): Promise<AppointmentResponse>
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
5. If the slot was not booked within a configurable window (e.g. 3 days after becoming bookable), notify the user that it was missed.

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
new NodejsFunction(this, 'TelegramHandler', { entry: 'src/lambda/telegram.handler.ts' });
new NodejsFunction(this, 'WhatsAppHandler', { entry: 'src/lambda/whatsapp.handler.ts' });
new NodejsFunction(this, 'WatchlistPoller', { entry: 'src/lambda/watchlist.handler.ts' });
new HttpApi(this, 'BookingBotApi');
new Table(this, 'SessionTable', { partitionKey: { name: 'pk', type: AttributeType.STRING } });
new Schedule(this, 'WatchlistSchedule', { schedule: Schedule.rate(Duration.hours(1)) });
```

---

## 9. Next Steps (ordered)

### Phase 1 — Refactor + CLI Client (no new infrastructure)
- [ ] Extract `BookingService` from `index.ts` into `src/services/booking.service.ts`
- [ ] Move hardcoded config (serviceId, staffIds, timeZone) to `src/config/bookings.config.ts`
- [ ] Move current `src/index.ts` to `src/clients/cli/index.ts`
- [ ] Extract prompt interactions into `src/clients/cli/prompts.ts`
- [ ] Create `src/clients/cli/profile.ts` — reads/writes `~/.cpv-booking/profile.json` for local user profile storage (onboarding on first run, reused on subsequent runs)
- [ ] Update `package.json` `dev` script to point to `src/clients/cli/index.ts`
- [ ] CLI watchlist: store wanted slots in `~/.cpv-booking/watchlist.json` and check them on each run

### Phase 2 — User Profile Storage (DynamoDB, shared by bot clients)
- [ ] Design DynamoDB table schema (single-table design — sessions + profiles + watchlist)
- [ ] Create `src/services/user.service.ts` with `getProfile`, `saveProfile`, `deleteProfile`
- [ ] Build onboarding conversation flow (collect name, email, phone, membership number)
- [ ] Add GDPR consent step and `/delete` command
- [ ] Replace hardcoded `customerData` from `test.data.ts` with `userService.getProfile(userId)`

### Phase 3 — Telegram Bot
- [ ] Install `telegraf` (Telegram bot framework for Node.js/TypeScript)
- [ ] Implement conversation flow in `src/clients/telegram/handlers.ts`
  - Step 0: onboarding if no profile exists
  - Step 1: ask for date
  - Step 2: show available slots (or offer watchlist if date > 2 weeks out)
  - Step 3: confirm booking
- [ ] Add `TELEGRAM_BOT_TOKEN` to `.env` / Secrets Manager
- [ ] Write `src/lambda/telegram.handler.ts` Lambda entry point
- [ ] Test locally with `telegraf` polling mode

### Phase 4 — WhatsApp Bot
- [ ] Choose provider: **Meta Cloud API** (free, official) or **Twilio** (easier setup)
- [ ] Implement same conversation flow in `src/clients/whatsapp/handlers.ts`
- [ ] Write `src/lambda/whatsapp.handler.ts` Lambda entry point
- [ ] Register webhook URL with Meta / Twilio

### Phase 5 — Advance Booking Watchlist (bots)
- [ ] Create `src/services/watchlist.service.ts` with `addToWatchlist`, `getWatchlist`, `removeFromWatchlist`
- [ ] Write `src/lambda/watchlist.handler.ts` — hourly EventBridge-triggered poller
  - Query all `pending` watchlist entries where `wantedDate <= today + 14 days`
  - Attempt `getAvailableSlots` → if slot free, call `createAppointment`
  - Notify user of success or unavailability
- [ ] Add "notify only" option — user can opt out of auto-booking and just get alerted
- [ ] Wire watchlist offer into bot handlers when user picks a date > 2 weeks out

### Phase 6 — Session State
- [ ] Install `@aws-sdk/client-dynamodb` + `@aws-sdk/lib-dynamodb`
- [ ] Create `src/services/session.service.ts` to get/set/clear conversation state
- [ ] Wire session service into both bot handlers

### Phase 7 — AWS Deployment
- [ ] Install AWS CDK: `pnpm add -D aws-cdk-lib constructs`
- [ ] Write `infrastructure/stacks/booking-bot-stack.ts`
  - Lambda functions (Telegram + WhatsApp handlers + WatchlistPoller)
  - API Gateway HTTP API
  - DynamoDB table (single-table)
  - EventBridge hourly schedule for watchlist
  - Secrets Manager references
- [ ] `cdk deploy`
- [ ] Register Telegram webhook: `setWebhook` → API Gateway URL
- [ ] Register WhatsApp webhook in Meta Developer Console

### Phase 8 — Hardening
- [ ] Move OWA cookie + canary token to Secrets Manager (rotate when expired)
- [ ] Add CloudWatch alarms for Lambda errors
- [ ] Add input validation for date and slot selection
- [ ] Handle edge cases: no slots available, booking conflict, API timeout, watchlist slot missed

---

## 10. Key Dependencies to Add

| Package | Purpose |
|---|---|
| `telegraf` | Telegram bot framework |
| `@aws-sdk/client-dynamodb` | DynamoDB for sessions, user profiles, watchlist |
| `@aws-sdk/lib-dynamodb` | DynamoDB document client (easier API) |
| `@aws-sdk/client-secrets-manager` | Read secrets at runtime |
| `aws-cdk-lib` | Infrastructure as Code |
| `aws-lambda` | Lambda handler types |
| `@types/aws-lambda` | TypeScript types for Lambda |


## Overview

Refactor the current CLI proof-of-concept into a reusable **BookingService** shared by
independent bot clients for **Telegram** and **WhatsApp**, hosted on **AWS**.

---

## 1. Target Architecture

```
┌─────────────────────────────────────────────────────────┐
│                        AWS Cloud                        │
│                                                         │
│  API Gateway (HTTPS endpoints)                          │
│    │                                                    │
│    ├── POST /telegram   ──►  Lambda: TelegramHandler    │
│    └── POST /whatsapp   ──►  Lambda: WhatsAppHandler    │
│              │                       │                  │
│              └──────────┬────────────┘                  │
│                         ▼                               │
│               Lambda Layer: BookingService              │
│                   (shared business logic)               │
│                         │                               │
│                         ▼                               │
│            Microsoft Bookings API (external)            │
│                                                         │
│  DynamoDB  ◄──── conversation state (userId → step)    │
│  Secrets Manager ◄─── OWA cookie, canary, tokens       │
│  CloudWatch Logs ◄─── all Lambda output                │
└─────────────────────────────────────────────────────────┘
```

---

## 2. Recommended AWS Services

### Core
| Service | Purpose |
|---|---|
| **Lambda** | Runs each bot handler as a serverless function triggered by webhooks |
| **API Gateway (HTTP API)** | Exposes HTTPS endpoints that Telegram / WhatsApp POST webhooks to |
| **Lambda Layers** | Packages the shared `BookingService` so both handlers share one copy |
| **DynamoDB** | Stores per-user conversation state (current step, selected date, selected slot) |
| **Secrets Manager** | Stores the OWA session cookie, canary token, and bot tokens securely |
| **CloudWatch Logs** | Automatic log aggregation for all Lambda invocations |

### Why Lambda + API Gateway over EC2/ECS?
- Both Telegram (`setWebhook`) and WhatsApp (Meta Cloud API) push updates via **HTTP POST webhooks** — Lambda handles these natively with zero idle cost.
- No always-on server needed; scales to zero between bookings.
- Deploying a new bot client is a new Lambda function with zero infrastructure change.

### Optional / Later
| Service | Purpose |
|---|---|
| **SQS** | Decouple webhook receipt from processing if latency becomes an issue |
| **EventBridge Scheduler** | Send booking reminders at a scheduled time before appointment |
| **SES** | Send email booking confirmations as a fallback |
| **SSM Parameter Store** | Lightweight alternative to Secrets Manager for non-sensitive config |

---

## 3. Proposed File Structure

```
cpv-booking-chat/
├── src/
│   ├── services/
│   │   └── booking.service.ts       # extracted from index.ts — pure async functions, no I/O
│   ├── clients/
│   │   ├── telegram/
│   │   │   ├── bot.ts               # Telegram bot setup (telegraf)
│   │   │   └── handlers.ts          # conversation flow using BookingService
│   │   └── whatsapp/
│   │       ├── bot.ts               # WhatsApp webhook setup (whatsapp-cloud-api / twilio)
│   │       └── handlers.ts          # conversation flow using BookingService
│   ├── lambda/
│   │   ├── telegram.handler.ts      # Lambda entry point for Telegram webhook
│   │   └── whatsapp.handler.ts      # Lambda entry point for WhatsApp webhook
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

getAvailableSlots(date: DateTime): Promise<DateTime[]>
createAppointment(slot: DateTime, customerData: AppointmentCustomer): Promise<AppointmentResponse>
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

## 6. Infrastructure as Code — AWS CDK

Use the **AWS CDK (TypeScript)** to define the entire stack:

```typescript
// infrastructure/stacks/booking-bot-stack.ts
new NodejsFunction(this, 'TelegramHandler', { entry: 'src/lambda/telegram.handler.ts' });
new NodejsFunction(this, 'WhatsAppHandler', { entry: 'src/lambda/whatsapp.handler.ts' });
new HttpApi(this, 'BookingBotApi');
new Table(this, 'SessionTable', { partitionKey: { name: 'pk', type: AttributeType.STRING } });
```

---

## 7. Next Steps (ordered)

### Phase 1 — Refactor (no new infrastructure)
- [ ] Extract `BookingService` from `index.ts` into `src/services/booking.service.ts`
- [ ] Move hardcoded config (serviceId, staffIds, timeZone) to `src/config/bookings.config.ts`
- [ ] Keep `index.ts` as a thin CLI client that calls `BookingService` (smoke-test tool)

### Phase 2 — Telegram Bot
- [ ] Install `telegraf` (Telegram bot framework for Node.js/TypeScript)
- [ ] Implement conversation flow in `src/clients/telegram/handlers.ts`
  - Step 1: ask for date
  - Step 2: show available slots
  - Step 3: confirm booking
- [ ] Add `TELEGRAM_BOT_TOKEN` to `.env` / Secrets Manager
- [ ] Write `src/lambda/telegram.handler.ts` Lambda entry point
- [ ] Test locally with `telegraf` polling mode

### Phase 3 — WhatsApp Bot
- [ ] Choose provider: **Meta Cloud API** (free, official) or **Twilio** (easier setup)
- [ ] Implement same conversation flow in `src/clients/whatsapp/handlers.ts`
- [ ] Write `src/lambda/whatsapp.handler.ts` Lambda entry point
- [ ] Register webhook URL with Meta / Twilio

### Phase 4 — Session State
- [ ] Install `@aws-sdk/client-dynamodb` + `@aws-sdk/lib-dynamodb`
- [ ] Create `src/services/session.service.ts` to get/set/clear conversation state
- [ ] Wire session service into both bot handlers

### Phase 5 — AWS Deployment
- [ ] Install AWS CDK: `pnpm add -D aws-cdk-lib constructs`
- [ ] Write `infrastructure/stacks/booking-bot-stack.ts`
  - Lambda functions (Telegram + WhatsApp handlers)
  - API Gateway HTTP API
  - DynamoDB table
  - Secrets Manager references
- [ ] `cdk deploy`
- [ ] Register Telegram webhook: `setWebhook` → API Gateway URL
- [ ] Register WhatsApp webhook in Meta Developer Console

### Phase 6 — Hardening
- [ ] Move OWA cookie + canary token to Secrets Manager (rotate when expired)
- [ ] Add CloudWatch alarms for Lambda errors
- [ ] Add input validation for date and slot selection
- [ ] Handle edge cases: no slots available, booking conflict, API timeout

---

## 8. Key Dependencies to Add

| Package | Purpose |
|---|---|
| `telegraf` | Telegram bot framework |
| `@aws-sdk/client-dynamodb` | DynamoDB session storage |
| `@aws-sdk/lib-dynamodb` | DynamoDB document client (easier API) |
| `@aws-sdk/client-secrets-manager` | Read secrets at runtime |
| `aws-cdk-lib` | Infrastructure as Code |
| `aws-lambda` | Lambda handler types |
| `@types/aws-lambda` | TypeScript types for Lambda |
