# Pact — Slack App Directory Submission Package

> **Status:** Ready for submission
> **Updated:** May 13, 2026
> **App URL:** https://makepact.co
> **Support email:** hello@makepact.co

---

## 1. Listing Copy

### Short Description (140 char max)

```
Pact turns Slack promises into tracked commitments. Two-way accountability, reminders, and follow-through — all without leaving Slack.
```
*(134 characters)*

### Long Description (1000 char max)

```
Pact makes commitments real. When someone says "I'll send that by Friday" in Slack, those words usually disappear. Pact captures them.

Create a pact with /pact, by reacting to any message with 🤝, or by DMing the bot. Both parties get notified. Both are accountable. Reminders fire automatically — before and after the due date — so nothing slips through the cracks.

What makes Pact different: accountability flows both ways. Counterparties can propose new due dates. Creators accept, decline, or counter-propose. No one-sided deadline extensions. Both sides own the commitment.

Track your streak, see your completion rate, spot overdue patterns — all from the App Home. Teams with 3+ users see a workspace pulse.

Every workspace gets AI commitment detection, recurring pacts, tracker sync with Linear/Notion/Asana, and the weekly standup digest for free.
```
*(893 characters)*

### Feature Bullets (8–10 items)

- **🤝 Emoji creation** — React to any message with 🤝 to instantly create a pact from it
- **Two-way accountability** — Both creator and counterparty are notified and tracked
- **Smart reminders** — Automatic nudges before and after due dates; escalates if ignored
- **Counterparty reschedule** — Either party can propose a new date; creator accepts/declines/counters
- **App Home dashboard** — Streak counter, sparkline trend, personal stats, team pulse
- **Bulk actions** — Complete or snooze multiple overdue pacts at once from App Home
- **Recurring pacts** — Daily, weekly, biweekly, or monthly repetition with auto-spawn on complete
- **Weekly standup digest** — Auto-generated commitment summary delivered on your schedule
- **AI commitment detection** — Pact spots promises in channel conversation and offers to track them
- **Tracker sync** — Sync pacts with Linear, Notion, or Asana

### Categories

- Productivity
- Project Management
- Communication

### Pricing

**Free forever**
- Unlimited active pacts per workspace
- Core commands: `/pact`, `/pacts`, `/done`, `/pact extend`, `/pact edit`
- Automatic reminders and due-date nudges
- Counterparty accountability (both parties notified)
- 🤝 emoji reaction creation
- App Home with streak and personal stats

- AI commitment detection in channels
- AI commitment detection in channels
- Recurring pacts (daily / weekly / biweekly / monthly)
- Weekly standup digest
- Bulk complete and bulk snooze from App Home
- Counterparty reschedule proposals with accept/decline/counter flow
- Tracker sync: Linear, Notion, Asana
- Workflow Builder steps (`pact_create`, `pact_summary`)
- Team pulse (workspace-wide stats for 3+ users)
- Priority support

---

## 2. OAuth Scope Justification

Slack reviewers reject apps for over-scoping. One line per scope explaining necessity.

| Scope | Why it's required |
|-------|------------------|
| `reactions:read` | Detects 🤝 emoji reactions on messages to create pacts without a slash command |
| `channels:history` | Reads messages in public channels for 🤝 reactions and AI commitment detection; scoped to channels Pact is invited to |
| `groups:history` | Same as above for private channels where Pact has been invited |
| `mpim:history` | Required to detect 🤝 reactions in multi-party DMs |
| `im:history` | Reads DM messages for AI commitment detection and `/done` context inference when user interacts with Pact in DM |
| `chat:write` | Posts pact confirmations, reminders, and DM nudges on behalf of the bot |
| `users:read` | Fetches display names and timezone data for readable notifications and timezone-aware reminder delivery |
| `im:write` | Opens DM channels to send reminders and notifications to individual users |
| `team:read` | Reads workspace name and domain for installation records and multi-workspace disambiguation |
| `workflow.steps:execute` | Executes Workflow Builder steps (`pact_create`, `pact_summary`) when triggered by user-built workflows |

**Scopes we intentionally do NOT request:**
- `channels:read` / `groups:read` — not needed; we use `team.id` from events, not channel lists
- `users:read.email` — we never collect email addresses
- `files:read` / `files:write` — Pact does not handle files
- `admin.*` — Pact requires no admin privileges

---

## 3. Security Review Answers

Slack's standard security questionnaire pre-answered for reviewers.

### Data Retention
- **Pact records** (commitment text, due dates, status, Slack user IDs) are retained for the lifetime of the installation. When a workspace uninstalls Pact, data is retained for 30 days then deleted on request.
- **Website analytics** (anonymized IP hash, page path, UTM params) are retained for 90 days then purged.
- **Bot tokens** are deleted immediately when a workspace uninstalls.
- No backup retention beyond the hosting provider's standard 7-day automated backups (Neon / Render).

### Encryption at Rest and in Transit
- **In transit:** All traffic is TLS 1.2+ via Render's managed TLS (Let's Encrypt). No unencrypted HTTP is accepted in production.
- **At rest:** Database hosted on Neon (PostgreSQL); Neon encrypts volumes at rest using AES-256. Slack bot tokens are additionally encrypted at the application layer using AES-256-GCM before being stored in the database.

### Employee Access
- Database access requires SSH key authentication to the Render environment; only Polsia engineering has access.
- No third-party support tooling with access to raw customer data.
- Access logs maintained via Render's audit trail.

### Incident Response
- Security incidents are triaged within 24 hours of detection.
- Affected workspace admins are notified by email within 72 hours of a confirmed breach, consistent with GDPR Article 33 timelines.
- Contact: hello@makepact.co

### GDPR / CCPA Stance
- **GDPR:** Pact is a data processor acting on behalf of workspace admins (data controllers). We process only the minimum data necessary to deliver the service. Users can request access, correction, deletion, or portability of their data by emailing hello@makepact.co. We respond within 30 days.
- **CCPA:** We do not sell personal information. California residents have the right to know what data we collect and request deletion. Same contact: hello@makepact.co.
- No cross-context behavioral advertising. No data sold to data brokers.

### Sub-Processors

| Sub-Processor | Purpose | Data Shared | Region |
|--------------|---------|-------------|--------|
| **Neon** | Managed PostgreSQL database | All pact data, user IDs, workspace metadata | US (AWS us-east-1) |
| **Render** | Application hosting | Application logs, env vars (tokens encrypted) | US (Oregon) |
| **OpenAI** | AI commitment detection; `/done` context inference | Message snippets from channels where Pact is active; no storage by Pact after inference | US |

**Not a sub-processor:** Slack itself (they are a platform provider and independent data controller).

---

## 4. Support URL

**Support contact:** [hello@makepact.co](mailto:hello@makepact.co)

This address is live. Responses within 5 business days.

**Support URL for Slack directory form:** `mailto:hello@makepact.co`

*(If Slack requires a URL rather than mailto, use https://makepact.co — the homepage has the contact email in the footer. Alternatively, a `/support` page can be added on request.)*

---

## 5. Screenshot Shot List

Slack App Directory requires **1280×800** (standard) or **2560×1600** (2x retina). Minimum 3 screenshots, max 5. Recommended: 5.

| # | Title | UI State | Where to Capture | Priority |
|---|-------|----------|-----------------|----------|
| 1 | **Your commitments at a glance** | App Home tab open — streak badge (🔥 N-day streak), 4-week sparkline, "Promises I owe" list with at least 2 active pacts + 1 overdue row with days-overdue badge | Slack desktop, App Home tab | Must-have |
| 2 | **Create a pact in seconds** | `/pact` modal open with description field filled ("Review the Q3 roadmap"), due date set to next Friday, counterparty field populated | Slack desktop, modal overlay | Must-have |
| 3 | **Two-way accountability in DMs** | Reminder DM from Pact bot showing an overdue pact with ✅ Mark done / ⏭ Snooze / 📅 Extend buttons | Slack desktop, DM with Pact | Must-have |
| 4 | **Emoji creation** | Public channel message visible, 🤝 reaction count on a message, and either the "Create a pact?" ephemeral prompt or the pact creation modal triggered | Slack desktop, channel view | Recommended |
| 5 | **Reschedule flow** | Counterparty DM showing "New date proposed: Jun 5" with Accept / Decline / Counter-propose buttons, plus creator's Home Tab showing "Pending reschedule proposal" row | Slack desktop, DM view | Recommended |

**Dimensions:** Capture at 1280×800 (or 2x: 2560×1600 for Retina/HiDPI screens)
**Format:** PNG preferred. No JPG compression artifacts on text.
**Rules:** No third-party brand logos visible. Real data is fine (use test workspace).

---

## 6. Submission Checklist

Run through this in order before clicking Submit in the Slack App Config.

### Pre-Submission (15 min)

- [ ] **App name:** "Pact" — confirm no trademark conflict in Slack directory search
- [ ] **App icon:** 512×512 PNG, no text, no rounded corners (Slack applies its own mask)
  - Current: `public/logo-512.png` — verify it looks good at 512px with Slack's circular mask
- [ ] **Short description** (140 char): paste from Section 1 above ✓
- [ ] **Long description** (1000 char): paste from Section 1 above ✓
- [ ] **Categories selected:** Productivity, Project Management, Communication ✓
- [ ] **Privacy Policy URL:** `https://makepact.co/privacy` — confirm returns 200 ✓
- [ ] **Terms of Service URL:** `https://makepact.co/terms` — confirm returns 200 ✓
- [ ] **Support URL / email:** `hello@makepact.co` ✓
- [ ] **Website URL:** `https://makepact.co` ✓

### Scopes & Permissions

- [ ] Review OAuth scopes in Slack App Config match the justification table in Section 2
- [ ] Confirm no `admin.*` scopes are requested
- [ ] Confirm no `users:read.email` scope is requested

### Screenshots

- [ ] Capture 5 screenshots per the shot list in Section 5
- [ ] Verify dimensions: 1280×800 or 2560×1600
- [ ] Verify format: PNG
- [ ] Upload in order: Home Tab → Create Modal → Reminder DM → Emoji → Reschedule

### Security Questionnaire (if asked)

- [ ] Data retention: use answers from Section 3 above
- [ ] Encryption: TLS 1.2+ in transit, AES-256 at rest + AES-256-GCM for tokens
- [ ] Sub-processors: Neon, Render, OpenAI
- [ ] GDPR/CCPA: no data sold, deletion requests honored at hello@makepact.co

### Final Checks

- [ ] Install Pact in a fresh test workspace and run through: `/pact`, `/pacts`, `/done`, 🤝 reaction
- [ ] Verify App Home loads correctly for a new user
- [ ] Confirm `/privacy` and `/terms` pages load at the makepact.co domain
- [ ] Submit for review

### Post-Submission

- [ ] Slack review typically takes 1–5 business days
- [ ] Watch hello@makepact.co for reviewer questions
- [ ] Common rejection reasons: missing privacy policy (✓ done), over-scoped permissions (✓ reviewed), broken install flow (✓ test before submit)

---

*Generated: May 13, 2026. Update the "Last updated" dates on privacy.html and terms.html if significant policy changes are made before submission.*
