# Pact Slack End-to-End Test Checklist

This document defines the canonical QA scenarios for Pact's Slack integration.
Run `node tests/slack-e2e-runner.js` to execute the automated subset.
Manual steps are marked **[MANUAL]**.

---

## Setup: Test Workspace

Before running tests, ensure the following are configured:

| Env Var | Purpose |
|---------|---------|
| `SLACK_TEST_WORKSPACE_ID` | Team ID of the QA workspace (e.g. `T0XXXXXX`) |
| `SLACK_TEST_BOT_TOKEN` | Bot user token for the Pact app in the QA workspace |
| `SLACK_TEST_USER_1_TOKEN` | User OAuth token for test user 1 (to simulate user-sent slash commands) |
| `SLACK_TEST_USER_1_ID` | Slack user ID of test user 1 |
| `SLACK_TEST_USER_2_ID` | Slack user ID of test user 2 |
| `SLACK_TEST_CHANNEL_ID` | A public/private channel where both users are members |
| `SLACK_TEST_DM_CHANNEL_ID` | The DM channel ID between user 1 and user 2 |
| `SLACK_TEST_BOT_DM_CHANNEL_ID` | The DM channel ID between user 1 and the Pact bot |
| `SLACK_TEST_GROUP_DM_CHANNEL_ID` | A group DM with 3+ people |

Store these in the isolated QA environment. **Never mix QA credentials with Production.**

---

## How to Create the QA Workspace

1. Go to [slack.com/create](https://slack.com/create) and create a new workspace named **"Pact QA"**
2. Create two additional user accounts (use email aliases or separate emails)
3. Install the Pact Slack app using the OAuth URL from the production Pact app
4. Note the workspace ID from **Settings → About this workspace** or via `auth.test` API call
5. Create a test channel (e.g. `#qa-testing`)
6. Create a group DM with the bot + user 1 + user 2

---

## Automated Tests (run via `slack-e2e-runner.js`)

These tests work by sending signed HTTP requests to the Pact server, simulating exactly
what Slack sends for each slash command scenario. No real Slack workspace required.

### `/pact` Command

| # | Scenario | Input | Expected Response | Status |
|---|----------|-------|-------------------|--------|
| A1 | 2-person DM, valid text + date | `channel_id=D...` peer DM | Proposal block with Accept/Decline buttons | Auto |
| A2 | Bot DM (user ↔ Pact bot) | `channel_id=D...` bot's own DM | "Open a DM with a teammate..." | Auto |
| A3 | Public channel | `channel_id=C...` | "Pacts work in DMs for now..." | Auto |
| A4 | Group DM (mpim) | `channel_id=G...` | "Pacts work in DMs for now..." | Auto |
| A5 | 2-person DM, no text | `channel_id=D...` text="" | Usage instructions block | Auto |
| A6 | 2-person DM, text but no date | `channel_id=D...` text="Write the report" | "When should X be done by?" prompt | Auto |

### `/pacts` Command

| # | Scenario | Input | Expected Response | Status |
|---|----------|-------|-------------------|--------|
| B1 | DM with active pacts | `channel_id=D...` (has pacts) | Block list of active pacts | Auto |
| B2 | DM with no pacts | `channel_id=D...` (empty) | "No active pacts..." message | Auto |
| B3 | Channel (any) | `channel_id=C...` | Shows pacts for that channel (empty) | Auto |

### `/done` Command

| # | Scenario | Input | Expected Response | Status |
|---|----------|-------|-------------------|--------|
| C1 | No active pacts | `channel_id=D...` text="" | "No active pacts to complete" | Auto |
| C2 | With active pacts | `channel_id=D...` text="" | Interactive pact selector | Auto |
| C3 | Specific pact ID | `channel_id=D...` text="1" | Complete pact #1 if authorized | Auto |

---

## Manual Tests

These require an actual Slack workspace and human interaction.

### OAuth Install Flow

| # | Scenario | Steps | Expected |
|---|----------|-------|---------|
| D1 | Fresh install | Visit makepact.co → "Add to Slack" | OAuth consent screen → workspace picker → post-install DM from Pact bot |
| D2 | Post-install deep link | Complete install | Bot DMs user with welcome message; amber CTA; secondary "Visit makepact.co" link |
| D3 | Re-install same workspace | Install again | No duplicate data; token refreshed |

### Real Slack Interaction Tests

| # | Scenario | Steps | Expected |
|---|----------|-------|---------|
| E1 | `/pact` in 2-person DM (real workspace) | User 1 opens DM with User 2, types `/pact Finish the report by Friday 5pm` | Proposal block appears visible to BOTH users |
| E2 | Accept pact proposal | User 2 clicks "✅ Accept Pact" | Confirmation message shows pact created with both @mentions |
| E3 | Decline pact proposal | User 2 clicks "✗ Decline" | Declined message shown |
| E4 | `/pacts` shows created pact | User 1 types `/pacts` in same DM | Pact appears in list |
| E5 | `/done` completes pact | User 1 types `/done` | Selector shows pact; user selects; "🎉 Pact completed" visible to both |
| E6 | Daily digest fires | Wait for 9am ET or trigger manually | Bot DMs each user with active pacts; correct format (made/assigned/overdue sections) |
| E7 | Auto-reminder 24hr before due | Create pact due tomorrow | Bot DM reminder fires ~24hr before |
| E8 | Conversational DM "hi" | User DMs the Pact bot "hi" | Onboarding/status response |
| E9 | Conversational DM "my pacts" | User DMs "my pacts" | Sectioned list of made/assigned/overdue |
| E10 | Conversational DM "I need X by Friday" | User DMs natural language | Parse + confirm prompt |

### Bot DM (user ↔ Pact bot)

| # | Scenario | Expected |
|---|----------|---------|
| F1 | `/pact` in bot DM | "Open a DM with a teammate to create a pact with them." |
| F2 | `/pacts` in bot DM | List of user's pacts across all channels |
| F3 | `/done` in bot DM | Selector with user's active pacts |

---

## Definition of Done

A deployment is ready to ship when:

- [ ] All automated tests pass (`node tests/slack-e2e-runner.js`)
- [ ] E1–E5 manually verified in the QA workspace
- [ ] Daily digest verified (or confirmed working from logs)
- [ ] OAuth install flow works end-to-end (D1–D2)

**Never mark an engineering task complete without running the automated suite first.**

---

## Notes

- The automated runner tests **server logic** by simulating signed Slack payloads.
  It does not test the Slack API or UI rendering — that's what the manual tests cover.
- `channel_id` prefix determines routing: `D` = DM, `C` = channel, `G` = group/mpim.
- The test runner uses a separate test database user/pacts to avoid polluting production data.
  Always set `NODE_ENV=test` when running against production server URL.
