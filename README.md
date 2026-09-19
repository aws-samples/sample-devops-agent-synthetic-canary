<!-- Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved. -->
<!-- SPDX-License-Identifier: MIT-0 -->

# Automated Triage: CloudWatch Synthetics to AWS DevOps Agent

CloudWatch Synthetics runs scripted checks against your application on a
schedule — hitting an API endpoint, or loading a page in a real browser —
to catch things like a service returning errors, a page failing to load,
or a page loading fine but showing an error message instead of real
content. This project wires those checks directly to
[AWS DevOps Agent](https://aws.amazon.com/devops-agent/): the moment a
check fails, an investigation starts automatically. No one has to notice
the outage, open a ticket, or start digging through logs first.

### Use case details

| Information | Details |
|---|---|
| Use case type | Operational / Observability automation |
| Agent type | Single agent (AWS DevOps Agent, invoked via webhook — not built or hosted in this repo) |
| Use case components | AWS CDK constructs, AWS Lambda, CloudWatch Synthetics, CloudWatch Alarms, Amazon EventBridge, Amazon DynamoDB, Amazon SNS, AWS Step Functions |
| Use case vertical | DevOps / Site Reliability Engineering |
| Example complexity | Intermediate |
| SDK used | AWS CDK v2, AWS SDK for JavaScript v3 |

### Prerequisites

| Requirement | Description |
|---|---|
| Node.js 22+ | Runtime for the CDK app and all Lambda handlers |
| AWS CLI | Configured with credentials (`aws configure`) |
| AWS CDK CLI | `npm install -g aws-cdk` (or use the local `npx cdk` from this repo) |
| Target application | Any HTTP(S) application to point the canaries at — this repo ships no demo app; see [Trying it against a real app](#trying-it-against-a-real-app-one-observability-demo) below |
| AWS DevOps Agent | An Agent Space with a generic webhook trigger configured (HMAC signing enabled) — see [Getting a DevOps Agent webhook URL + HMAC secret](#getting-a-devops-agent-webhook-url--hmac-secret) below |
| AWS DevOps Agent account access | The Agent Space needs an IAM role with access to your target app's AWS resources (auto-created or custom) so it can actually investigate once invoked — see [Configuring primary account access](https://docs.aws.amazon.com/devopsagent/latest/userguide/getting-started-with-aws-devops-agent-creating-an-agent-space.html) |

![Architecture diagram: two CloudWatch Synthetics canaries feed per-canary CloudWatch alarms, which route through the account's default EventBridge bus to a webhook Lambda that deduplicates via DynamoDB, signs the payload with a Secrets Manager-held HMAC secret, and POSTs it to AWS DevOps Agent (which delivers findings to Slack natively) — falling back to an SNS invocation-failure alert if the Agent is unreachable. An optional Step Functions workflow (RepeatedNotification) re-checks sustained alarms and re-emits synthetic events back through the same webhook path.](docs/images/architecture.png)

*Editable source: [`docs/diagrams/architecture.drawio`](docs/diagrams/architecture.drawio) — open with [draw.io](https://app.diagrams.net/) or the [draw.io VS Code extension](https://marketplace.visualstudio.com/items?itemName=hediet.vscode-drawio).*

### How it flows

1. **`HealthCanary`** checks the target app's API health on a schedule —
   HTTP status codes, following redirects correctly. **`UxCanary`** goes
   further: it drives a real headless browser through a page journey and
   checks that expected content actually renders.
2. If either canary's `SuccessPercent` drops, its own CloudWatch alarm
   (`HealthAvailabilityAlarm` or `UxAvailabilityAlarm`) fires.
3. The alarm's state-change event lands on the account's default
   **Amazon EventBridge** bus.
4. The **Webhook Lambda** picks it up and checks **Amazon DynamoDB** for
   an existing lock on that canary name — this filters out duplicate or
   repeat alarms for the same incident before anything else happens.
5. If there's no active lock, the Lambda reads the DevOps Agent's webhook
   URL and HMAC secret from **AWS Secrets Manager**, signs the request,
   and sends it — retrying with backoff if the first attempts fail.
6. **AWS DevOps Agent** receives the signed request and starts an
   investigation. This assumes the Agent Space already has account
   access configured to discover your target app's resources (see
   Prerequisites above) — this project only handles getting the alarm
   *to* the Agent, not what the Agent can see once it's investigating.
   The Agent delivers its findings and root-cause analysis through its
   own native Slack integration (no code in this repo).
7. If the Agent can't be reached after all retries, the Webhook Lambda
   publishes to an **Amazon SNS** topic instead, so the failure to invoke
   the Agent doesn't go unnoticed.
8. *(Optional)* If the alarm stays unresolved, **AWS Step Functions**
   (`RepeatedNotification`) periodically re-checks it and re-emits a
   synthetic alarm event back through the same path — reusing the same
   dedup lock, signing, retry, and SNS alert, rather than a separate code
   path.

## Why this exists

Most outside-in monitoring stops at "is the alarm red or green." This project
closes the gap between *detection* and *investigation*:

- **Two canaries, two kinds of checks.** `HealthCanary` checks basic API
  health — HTTP status codes, and it correctly follows redirects so a
  normal CloudFront redirect isn't mistaken for a failure. `UxCanary` goes
  further: it uses a real headless browser to visit pages and check that
  the expected content actually shows up. This catches a common failure a
  status-code check misses entirely — a page that returns a normal HTTP 200
  but shows an error message instead of real content.
- **A secure, reliable path to the Agent.** CloudWatch alarms land on the
  account's default EventBridge bus. A small webhook Lambda picks them up,
  filters out duplicate alarms using a DynamoDB lock, and sends a signed
  request to AWS DevOps Agent — retrying with backoff if the first attempts
  fail. If the Agent still can't be reached, it sends an SNS alert instead
  of failing silently. The Agent's actual findings and root-cause analysis
  are delivered separately, through its own native Slack integration (no
  code needed here) — see
  [`docs/sample-investigation.md`](docs/sample-investigation.md).
- **No hardcoded error messages to match.** The UX canary checks are
  generic: does the expected element show up on the page, and are there
  any network or JS errors. It never looks for a specific app's error
  text, so it works even on error messages it has never seen before.
- **Sustained incidents keep getting surfaced, not just the first occurrence.**
  CloudWatch alarms are edge-triggered — EventBridge only fires on the
  *transition* into ALARM, not on every evaluation while it stays there. The
  optional `RepeatedNotification` construct closes that gap with a Step
  Function that periodically re-checks the alarm and re-invokes the same
  webhook path while the incident remains unresolved.
- **Fewer false alarms from one-off glitches.** Both canaries support
  CloudWatch Synthetics' built-in `maxRetries` setting. A single flaky
  failure — like a slow DNS lookup or one bad response — gets retried
  before it counts against the alarm. That means it never triggers a
  DevOps Agent investigation at all.

## Seeing it work

This pattern was validated end-to-end against a real incident on the
[AWS One Observability Workshop](https://catalog.workshops.aws/observability/en-US)'s
pet adoption sample app — an injected backend failure, detected by the canary, routed through
the alarm → EventBridge → webhook chain, and investigated autonomously by the AWS DevOps Agent.
See [`docs/sample-investigation.md`](docs/sample-investigation.md) for the agent's actual
investigation output (root cause, evidence, and proposed mitigation plan), plus the
complementary invocation-failure alert path.

## Interacting with an in-progress investigation

This pattern is auto-trigger by design — no one has to open the AWS DevOps
Agent and describe the problem for an investigation to start. But "auto-trigger"
only covers *starting* the investigation, not the whole interaction model:
once it's running, an operator can still open the AWS DevOps Agent web app for
that investigation and steer it conversationally — ask it to look at a
different service, request more detail on a specific finding, or redirect the
analysis — the same way they would in any of the Agent's chat-driven workshops.
This project assumes the operator already knows how to do that; it only
automates getting the investigation *started*, not how you interact with the
Agent once you're in the web app.

## What's in this repo

| Path | What it is |
|---|---|
| `lib/constructs/lambda.ts` | `BaseLambdaFunction` — shared Lambda scaffolding (DLQ, X-Ray, log group, least-privilege role) |
| `lib/constructs/canary.ts` | `BaseCanary` — shared Synthetics canary scaffolding (IAM role, artifacts bucket, schedule, X-Ray) |
| `lib/canaries/health-canary.ts` | `HealthCanary` construct |
| `lib/canaries/ux-canary.ts` | `UxCanary` construct |
| `lib/webhook-function.ts` | `WebhookFunction` construct (EventBridge rule + Lambda + IAM) |
| `lib/investigation-locks-table.ts` | `InvestigationLocksTable` construct (DynamoDB dedup table) |
| `lib/repeated-notification.ts` | `RepeatedNotification` construct (Step Function + check Lambda; optional, see [below](#repeated-notification-for-sustained-alarms)) |
| `lib/triage-stack.ts` | Reference stack wiring everything together — copy/adapt, don't depend on as a black box |
| `src/canaries/health/` | Health canary Lambda source (Synthetics `syn-nodejs-puppeteer-11.0` handler) |
| `src/canaries/ux/` | UX canary Lambda source |
| `src/lambda/webhook-node/` | Webhook Lambda source |
| `src/lambda/repeat-notification-node/` | Repeated-notification check Lambda source |
| `test/` | Unit + infra tests for all of the above |

## Quick start

```bash
npm install
npm test        # unit + infra tests, no AWS credentials or Docker required
```

To deploy the reference stack, edit `bin/app.ts` with your target
application's URL(s) and selectors, then:

```bash
npx cdk bootstrap   # once per account/region
npx cdk deploy
```

After deploying, populate the placeholder secret it creates:

```bash
aws secretsmanager put-secret-value \
  --secret-id l1t-devops-agent-webhook \
  --secret-string '{"webhookUrl":"https://...","hmacSecret":"..."}'
```

The webhook Lambda treats a secret whose `webhookUrl` still contains the
literal string `PLACEHOLDER` as "not yet configured" and skips invocation —
so it's safe to deploy before you have real webhook credentials.

Also subscribe an endpoint (email, or any other SNS-supported protocol) to
the invocation-failure topic it creates, so a failure to reach the agent
doesn't go unnoticed:

```bash
aws sns subscribe \
  --topic-arn <the l1t-invocation-failure topic ARN from the stack output/console> \
  --protocol email \
  --notification-endpoint you@example.com
```

SNS requires a one-time click on a confirmation email/link before delivery
starts for that subscription.

### Getting a DevOps Agent webhook URL + HMAC secret

Create an AWS DevOps Agent (Agent Space) and configure a generic webhook
trigger with HMAC signing enabled; the agent gives you the webhook URL and
HMAC secret to use above. See the AWS DevOps Agent documentation for
"Invoking DevOps Agent through Webhook" for the exact console steps — the
webhook Lambda in this repo implements that contract exactly (HMAC-SHA256
over `${timestamp}:${body}`, base64-encoded, sent as the
`x-amzn-event-signature` header alongside `x-amzn-event-timestamp`).

Check the [AWS DevOps Agent supported Regions
page](https://docs.aws.amazon.com/devopsagent/latest/userguide/about-aws-devops-agent-supported-regions.html)
for current Region availability before choosing where to create your Agent
Space — availability has expanded since AWS DevOps Agent's public preview
and some specific features remain Region-limited.

## Configuring the UX canary's journey

The UX canary visits a home page plus any number of additional pages you
configure. Each journey page is:

```ts
{
  name: 'catalog',                 // step name, used in logs and screenshots
  path: '/catalog',                // appended to the base URL
  contentSelector: '.item-card',   // must be present (and the page considered healthy)
  emptyStateSelector: '.empty',    // optional: a valid "no data yet" state, not a failure
  extraQuery: 'category=all',      // optional: extra query string
}
```

Pass an array of these to `UxCanary`'s `journeyPages` prop (or point
`journeyPagesParameterName` at an SSM parameter holding the same JSON, if you
want to update the journey without redeploying).

```ts
new UxCanary(this, 'UxCanary', {
    name: 'l1t-ux-canary',
    runtime: puppeteerRuntime,
    handler: 'index.handler',
    path: '../src/canaries/ux',
    targetUrl: 'https://your-app.example.com',
    keySelector: 'body',
    journeyPages: [
        { name: 'catalog', path: '/catalog', contentSelector: '.item-card', emptyStateSelector: '.empty' },
        { name: 'cart', path: '/cart', contentSelector: '#cart-summary' },
    ],
});
```

### Beyond page loads: checking the write/transactional path with `steps`

A positive content selector and network/JS-error checks verify that a page
*renders* correctly — the read path. Many real outages live on the
write/transactional path instead: the page loads fine, but "Add to Cart"
silently does nothing, or a form submit 500s. A pure navigate-and-assert
check can never observe that, because nothing is ever clicked or submitted.

Add an optional `steps` array to a journey page to describe an ordered
sequence of interactions, run after navigating to `path` and before the
(optional) content assertion:

```ts
{
  name: 'add-to-cart',
  path: '/catalog',
  steps: [
    { action: 'click', selector: '.add-to-cart-btn' },
    { action: 'assertVisible', selector: '.cart-badge' },
  ],
}
```

Supported actions: `click`, `type` (with an optional `value`/`delay`),
`waitForSelector` (DOM presence only), and `assertVisible` (presence *and*
visibility, like the existing error-indicator check). Each accepts an
optional `timeout` (default 10000ms). The first failing step throws
immediately, identifying its index and action (e.g. `step[1] click
(.checkout-btn) failed: ...`), so the investigation gets a precise failure
point rather than "page broke somewhere." The existing network/JS-error
listeners already span the whole page visit — including step execution —
so a click-triggered backend failure is caught by the exact same generic
mechanism that catches load-time failures, with no extra wiring.

`contentSelector` is optional when `steps` ends in its own
`assertVisible`/`waitForSelector` step that already serves as the success
signal; combine both when you want to reach a piece of UI via interaction
and then assert on it separately.

**Not yet included in this project: logging in.** CloudWatch Synthetics
itself supports login flows — entering credentials and submitting a login
form is a documented pattern, see
[Common features for CloudWatch Synthetics canaries](https://docs.aws.amazon.com/AmazonCloudWatch/latest/monitoring/CloudWatch_Synthetics_Canaries_CommonFeatures.html#CloudWatch_Synthetics_Canaries_CommonFeatures_Integrations).
This project just doesn't have a built-in `login` step for that yet. If
your pages sit behind a login wall, you'd follow that same pattern to add
a login step yourself before this pattern can reach them.

## Reducing false positives with `maxRetries`

Both `HealthCanary` and `UxCanary` accept a `maxRetries` property (0-2),
which maps directly to CloudWatch Synthetics' native automatic-retry
support (`Runtime.SYNTHETICS_NODEJS_PUPPETEER_10_0` and newer — this
project's `syn-nodejs-puppeteer-11.0` runtime qualifies). A failed canary
run is retried up to `maxRetries` times before it's reported as a failure,
so a single transient blip (a slow DNS lookup, one flaky network response)
doesn't count against the `SuccessPercent` metric an availability alarm
evaluates — and never reaches DevOps Agent as a false-positive
investigation.

```ts
new HealthCanary(this, 'HealthCanary', {
    // ...
    maxRetries: 1,
});
```

Leave it unset (default `0`) if you'd rather have every failed run count
immediately — useful while you're first validating a canary's checks.

## Repeated notification for sustained alarms

CloudWatch alarms are edge-triggered: EventBridge only receives a "CloudWatch
Alarm State Change" event on the *transition* into ALARM, not on every
evaluation while the alarm remains there. Without anything extra, a
long-running unresolved incident only ever triggers **one** DevOps Agent
investigation, even if it stays broken for hours.

The optional `RepeatedNotification` construct closes this gap, adapting the
pattern from the AWS blog post ["How to enable Amazon CloudWatch Alarms to
send repeated
notifications"](https://aws.amazon.com/blogs/mt/how-to-enable-amazon-cloudwatch-alarms-to-send-repeated-notifications/)
(EventBridge → Step Functions → Lambda, with a Wait/Check/Choice loop) —
adapted to re-invoke the *same* webhook path instead of publishing to SNS:

1. A matching alarm (by name prefix) transitions to ALARM, which starts a
   Step Function via its own EventBridge rule (separate from — but using the
   same alarm-name prefix as — `WebhookFunction`'s rule).
2. The state machine waits `repeatIntervalSeconds` (default 300s), then
   invokes a small check Lambda that calls `DescribeAlarms`.
3. If the alarm is still in `ALARM`, the check Lambda re-emits a synthetic
   "CloudWatch Alarm State Change" event onto the default EventBridge bus —
   identical in shape to a real transition. That event flows through the
   *same* `WebhookFunction` rule, dedup lock, HMAC signing, retry, and
   invocation-failure SNS alert as a genuine occurrence, with zero
   special-casing needed in the webhook Lambda itself.
4. This repeats until the alarm resolves, or `maxRepeats` (default 12, i.e.
   ~1 hour at the default interval) is exhausted.

```ts
new TriageStack(app, 'MyTriageStack', {
    // ...
    repeatedNotification: {
        repeatIntervalSeconds: 300, // should be >= the webhook Lambda's dedupTtlSeconds (default 900s)
                                     // so each repeat actually reaches DevOps Agent again, rather than
                                     // being silently deduplicated by the lock
        maxRepeats: 12,
    },
});
```

Or instantiate `RepeatedNotification` directly if you're not using
`TriageStack` — it only needs the alarm-name prefix your alarms and
`WebhookFunction` already share.

## Trying it against a real app: `one-observability-demo`

This project is intentionally application-agnostic — it doesn't ship or
depend on any particular demo app. To see the whole pattern working
end-to-end against real infrastructure and real failures,
deploy [aws-samples/one-observability-demo](https://github.com/aws-samples/one-observability-demo),
a polyglot pet-adoption microservices app built for the AWS observability
workshop, and point this project's canaries at it:

- `HealthCanary.targetUrlsParameterName` → the app's PetSite URL SSM
  parameter (exported by the app's stacks).
- `UxCanary.targetUrl` → the same PetSite URL.
- `UxCanary.keySelector` → a selector present on the app's home page.
- `UxCanary.journeyPages` → the app's own nav pages (adoption list, food
  shop, etc.), each with its real content selector.

Then break something for real — scale an ECS service to zero, stop an EKS
node group, or introduce an actual code bug — and watch the health canary or
UX canary catch it, the alarm fire, the webhook Lambda dedupe and forward it,
and AWS DevOps Agent produce a root-cause investigation.

`one-observability-demo` is just a reference target for trying this pattern
out — it's not a dependency of this repo.

## Design notes

- **Alarm events always go to the account's default EventBridge bus.**
  That's why `WebhookFunction` listens on the default bus
  (`EventBus.fromEventBusName(..., 'default')`).
- **Deduplication is TTL-based, not distributed-lock-based.** A DynamoDB
  conditional put on `canaryName` with an `expiresAt` TTL attribute is
  sufficient for this use case (bursty repeated ALARM events for the same
  underlying incident) without needing a full distributed lock service.
- **AWS DevOps Agent has its own incident-correlation mechanism.** Its
  triage stage checks every incoming trigger — from webhooks, ServiceNow,
  Datadog, and other sources — against active investigations within a
  ~20-minute look-back window, and decides whether to link it to an
  existing investigation, skip it, or start a new one. Our DynamoDB dedup
  lock works earlier and simpler: it's an exact `canaryName` match that
  decides whether the webhook Lambda calls the Agent at all. That matters
  because `RepeatedNotification` can re-emit the same alarm every
  `repeatIntervalSeconds` while an incident is unresolved — without our
  lock, each of those re-emissions would still reach the Agent and rely on
  its triage window to fold them together, using up a webhook call, HMAC
  signing, and a triage cycle each time. The two work together: ours
  filters out the obvious repeat case before it ever reaches the Agent;
  the Agent's handles the harder job of correlating across different
  alarms and sources.
- **CloudWatch alarms are edge-triggered, not level-triggered.** A sustained
  ALARM state does not re-fire the EventBridge event on every evaluation —
  only the *transition* into ALARM does. The optional `RepeatedNotification`
  construct (see [above](#repeated-notification-for-sustained-alarms)) closes
  this gap by periodically re-checking the alarm and re-invoking the webhook
  path while it remains unresolved.
- **The repeat-check Lambda goes back through EventBridge instead of
  calling the webhook Lambda directly.** This way, every repeat reuses the
  same dedup lock, HMAC signing, retries, and SNS alert as a real alarm —
  with no separate code path to maintain.
- **The UX canary checks for content first, then looks for a visible
  error message as a second signal.** It always checks whether the
  expected content rendered — that's the main check. It also looks for a
  common error indicator (like Bootstrap's `.alert-danger` class), but
  only counts it if it's actually *visible* on the page, not just present
  in the page's HTML. That distinction matters because many web pages
  include a hidden error box on every page load, ready to show only if
  something goes wrong — checking DOM presence alone would falsely flag
  every normal page load as an error.
- **No topology or dependency wiring is done by this project — the AWS
  DevOps Agent discovered it on its own.** Validated against
  [aws-samples/one-observability-demo](https://github.com/aws-samples/one-observability-demo):
  the pet-store app's ECS services, EventBridge rules, DynamoDB tables, and
  X-Ray traces are all standard AWS-native resources, and the Agent built
  an accurate service topology and traced the regression to a specific
  container image without any tagging, dependency manifest, or custom MCP
  server from this repo. If your target app is *not* fully AWS-native
  (custom on-prem components, resources the Agent's IAM role can't see, or
  you want to scope what it can discover), see [Limiting Agent Access in
  an AWS Account](https://docs.aws.amazon.com/devopsagent/latest/userguide/aws-devops-agent-security-limiting-agent-access-in-an-aws-account.html)
  for tag/resource/region-based restriction — that's the mechanism to
  reach for, not something this project builds or requires up front.

## Security

> **Important:** This sample is provided for educational and demonstration
> purposes only. It is not intended for production use without additional
> security review, testing, and hardening.

### Security controls implemented

| Layer | Control | Implementation |
|---|---|---|
| Webhook authenticity | HMAC-SHA256 signing | `WebhookFunction` signs every DevOps Agent request with a secret from AWS Secrets Manager; the agent verifies it on receipt |
| Webhook secret storage | AWS Secrets Manager | Webhook URL + HMAC secret are never stored in code, env vars, or CDK context — only in Secrets Manager, populated post-deploy |
| Least-privilege IAM | Scoped per-construct roles | `BaseLambdaFunction`/`BaseCanary` grant only what each Lambda/canary needs (its own DynamoDB table, its own secret, its own topic) |
| Transport encryption | `enforceSSL: true` | Applied on the SNS topic and the canary artifacts S3 bucket |
| Duplicate/replay suppression | DynamoDB conditional put + TTL | `InvestigationLocksTable` deduplicates concurrent/duplicate ALARM events so the same incident can't fan out into repeated agent invocations |
| DevOps Agent invocation failure visibility | SNS invocation-failure alert | If the DevOps Agent can't be reached after retries, an operator is notified via SNS rather than the failure being silently dropped |
| Dead-letter handling | Lambda DLQ | `BaseLambdaFunction` wires a DLQ for every Lambda so failed async invocations aren't lost |
| Compliance-as-code | cdk-nag (`AwsSolutionsChecks`) | Runs on synth for every construct in this repo; explicit `NagSuppressions` with a documented reason wherever a rule doesn't apply |

### Code scanning

This repo is scanned with GitLab SAST (Semgrep) and GitLab SAST-IaC (KICS)
on every push to `main` (see `.gitlab-ci.yml`). As of the most recent scan:

- **GitLab SAST-IaC (KICS): 0 findings.** No static IaC template files
  (CloudFormation/Terraform/Kubernetes YAML) are committed to this repo —
  infrastructure is defined in CDK TypeScript and synthesized at deploy
  time, so there is nothing for a static IaC template scanner to check.
- **GitLab SAST (Semgrep): 1 finding, accepted as a false positive.**
  `eslint.detect-non-literal-regexp` (CWE-185, Medium) on
  `src/lambda/webhook-node/index.js:117`, where a `RegExp` is built from
  `ALARM_NAME_PREFIX`. This value comes from the `L1T_ALARM_NAME_PREFIX`
  environment variable — deploy-time configuration set by whoever deploys
  the CDK stack, not user or network input — and is passed through
  `.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')` to escape all regex
  metacharacters before being embedded in the pattern. That escaping
  removes the backtracking risk (ReDoS) this rule exists to catch.
- **Dependency version ranges: caret (`^`) ranges used intentionally,
  except `aws-cdk`.** All `@aws-sdk/*` clients, `aws-cdk-lib`,
  `cdk-nag`, and `constructs` use `^` ranges so this sample keeps
  receiving compatible security patches without a manual bump; the
  committed `package-lock.json` still pins exact resolved versions for
  reproducible installs via `npm ci`. The `aws-cdk` **CLI** is pinned to
  an exact version instead, since the CLI needs to match the specific
  library version this repo was tested against — the same split other
  published aws-samples CDK repos use.

### Shared responsibility

This project follows the
[AWS Shared Responsibility Model](https://aws.amazon.com/compliance/shared-responsibility-model/).
AWS is responsible for security **of** the cloud — the underlying Lambda,
CloudWatch Synthetics, EventBridge, DynamoDB, and SNS services. You are
responsible for security **in** the cloud, including:

- Reviewing and scoping IAM roles/policies to your own account's least-privilege requirements before deploying
- Securing the DevOps Agent webhook URL and HMAC secret (stored in AWS Secrets Manager by default; rotate if you suspect exposure)
- Reviewing AI-generated findings and any proposed mitigation before acting on them — this pattern surfaces investigations, it does not auto-remediate anything
- Restricting who can read the DevOps Agent's findings (its own native Slack/console delivery) and who can subscribe to the invocation-failure SNS topic
- Enabling additional controls (VPC endpoints for Lambda, AWS WAF on any public target app, CMK encryption, CloudTrail) as appropriate for your environment
- Reviewing canary journey configuration (`journeyPages`, selectors, target URLs) so canaries don't unintentionally exercise destructive or paid actions against the target app

### Production hardening

For production use beyond this reference pattern, consider:

| Category | Action |
|---|---|
| **Credential rotation** | Configure rotation for the DevOps Agent webhook secret in Secrets Manager |
| **Network isolation** | Run the webhook and repeated-notification Lambdas in a VPC with VPC endpoints for the AWS services they call, if your account's network policy requires it |
| **Audit logging** | Enable AWS CloudTrail for all API calls; use CloudWatch Logs Insights on the webhook/canary Lambda log groups for investigation |
| **Alerting redundancy** | Subscribe more than one endpoint (e.g. email + a paging tool via a Lambda subscriber) to the invocation-failure SNS topic |
| **Monitoring** | Add a CloudWatch dashboard for canary `SuccessPercent`, webhook Lambda error rate, and DynamoDB dedup-table throttling |
| **Agent Space scoping** | This project only gets an alarm to the Agent — how well the Agent can investigate depends on how its Agent Space is scoped. For production, size Agent Space boundaries around a logical application or on-call group (not too narrow, not too broad) — see [Best practices for deploying AWS DevOps Agent in production](https://aws.amazon.com/blogs/devops/best-practices-for-deploying-aws-devops-agent-in-production/). If your target app spans multiple AWS accounts, see [Deploying AWS DevOps Agent in multi-account enterprise environments](https://repost.aws/articles/ARTtouEQz_RIa93Pukuw1zjw/deploying-aws-devops-agent-in-multi-account-enterprise-environments-a-strategy-for-cross-account-root-cause-analysis) for cross-account topology and root-cause analysis patterns |

For how to report a security issue in this project itself (not a finding
from the DevOps Agent), see
[CONTRIBUTING](CONTRIBUTING.md#security-issue-notifications).

## Disclaimer

The examples provided in this repository are for educational purposes only.
They demonstrate a routing pattern (canary → alarm → EventBridge → webhook →
AWS DevOps Agent), not a production-ready application. Findings and
mitigation plans generated by AWS DevOps Agent reflect its analysis at
investigation time based on the data it could access; review them
thoroughly and assess the potential impact before implementing any proposed
change against your own infrastructure.

## License

This project is licensed under the MIT-0 License. See the [LICENSE](LICENSE)
file.
