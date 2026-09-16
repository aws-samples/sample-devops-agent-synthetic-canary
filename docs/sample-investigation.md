# Sample: AWS DevOps Agent Investigation Output

> Captured from a live investigation triggered by this project's routing path (canary → alarm →
> EventBridge → webhook Lambda → AWS DevOps Agent), running against the
> [AWS One Observability Workshop](https://catalog.workshops.aws/observability/en-US) pet
> adoption sample app as the validation target. Service names, endpoints, and resource naming
> below are as documented in that public workshop, not sensitive. Account ID, IAM role ARNs,
> and the operator alias have been redacted since those are specific to the AWS account used
> for this validation run, not part of the workshop itself.
>
> This is the AWS DevOps Agent's own reasoning output — not a canned or scripted report. The
> content below is a faithful transcript of the real investigation, reformatted for readability.
> If a screenshot of the AWS DevOps Agent console is added later, it belongs alongside this file
> under `docs/images/` and can be referenced with standard markdown image syntax:
> `![AWS DevOps Agent investigation summary](images/devops-agent-investigation.png)`.

---

## Incident: PetSite "Add to cart" flow broken — `l1t-cart-canary` failing

**Status:** complete &nbsp;&nbsp; **Severity:** high

### Incident

The `l1t-cart-canary` Synthetics canary (PetSite FoodService page,
`https://<cloudfront-distribution>.cloudfront.net/FoodService`) failed every run since
~12:08 UTC with `Add to cart button was not found on the page` (SuccessPercent 100 → 0),
firing alarm `l1t-health-l1t-cart-canary-availability`. The page shell loaded (cart count and
`/api/cart` calls succeeded) but zero product cards rendered, so there was no add-to-cart
button to click.

### Root cause

A regressed `petfood-rs:latest` container image (digest `sha256:87dd0a6c…`, pushed 12:00:51 UTC)
returned HTTP 500 from the `list_foods` handler on `GET /api/foods`. A manual
`ecs update-service --force-new-deployment` at 12:08:27 UTC recycled the `petfood-rs` ECS tasks
onto it — the task definition pinned the image only to the mutable `:latest` tag with no digest,
so the routine redeploy silently picked up the unvetted build. With `/api/foods` failing, the
FoodService page rendered no products and no Add-to-cart button.

Ruled out: capacity/scale-to-zero (targets 2/2 healthy), frontend timeout (page + cart calls
returned 200), canary drift, empty catalog or broken config (DynamoDB table `ACTIVE` with data,
SSM config parameter correct and unchanged).

**Contributing factor:** the unpinned `:latest` image reference.

### Mitigation (proposed by the agent, validated, not auto-executed)

Roll `petfood-rs` back to the prior known-good image by digest (still present in ECR, just
untagged): register a new ECS task-definition revision pinning the app container to that
digest, then update the service. Durable fix: pin the app image by digest or an immutable
per-build tag instead of `:latest`, going forward.

### Findings & evidence (as surfaced by the agent)

| Type | Finding |
|---|---|
| root cause | Regressed `petfood-rs:latest` image pushed 12:00:51 UTC, activated by the 12:08 redeploy |
| cause | Manual `force-new-deployment` at 12:08:27 UTC activated the broken image |
| cause | `petfood-rs` `GET /api/foods` returns HTTP 500 → FoodService page renders no products |
| symptom | PetSite "Add to cart" button missing — add-to-cart flow broken, 12:08 UTC → ongoing |
| observation | X-Ray traces show `fault: true` in the `list_foods` handler, pervasive across all pet types |
| observation | ECR: new `petfood-rs:latest` digest pushed 12:00:51 UTC; prior known-good digest still present, untagged |
| observation | Frontend logs: `HttpRequestException 500` from `petfood-rs`, zero occurrences in the pre-incident baseline |
| observation | Config, data, and IAM ruled out — the app's DynamoDB table and SSM-resolved config were healthy; the fault was isolated to the new image's code |
| gap | Canary S3 artifact bucket: agent's role could list objects but not `GetObject` — screenshots/HAR files couldn't be read directly; investigation pivoted to CloudWatch Logs + X-Ray |
| gap | SSM `GetParametersByPath` on the app's config path denied to the agent's role — couldn't fully confirm runtime config resolution (left as an open hypothesis, later ruled out via a different evidence path) |
| gap | EKS `kubectl` access denied — frontend pod state inspected via ALB target-group health + logs instead |

### Agent's investigation steps (all completed)

1. Analyze canary config & failure artifacts — confirmed `/api/foods` faults → no products → no button
2. Check ECS/EKS/ALB runtime state — all services and the frontend target group healthy; found the 12:08 redeploy
3. Find changes around the 12:08 UTC onset — only change found: the manual force-new-deployment
4. Inspect application logs — frontend `/api/foods` calls hang, then HTTP 500 starting 12:11
5. Check the `list_foods` datastore/config dependency — data & config healthy, ruled out as cause
6. Validate and propose the image rollback — digest-pinned rollback plan delivered, 0 policy violations

### Mitigation plan detail (as generated by the agent)

The agent's plan was structured in five phases — **prepare** (back up the current task
definition and service config), **pre-validate** (confirm baseline state and that the
rollback image digest still exists in ECR), **apply** (register a digest-pinned task
definition revision and update the service), **post-validate** (confirm the rollout completed
and the canary alarm returns to OK), and **rollback** (revert to the prior revision if the new
one fails to stabilize) — each with the exact AWS CLI commands to run, plus a closing "code
change specification" recommending the task definition permanently reference the app image
by immutable digest instead of `:latest`, with acceptance criteria for that change.

---

## Invocation-failure path: what happens when the Agent can't be reached

The routing path also handles the complementary failure mode — the AWS DevOps Agent webhook
itself being unreachable — separately from a completed investigation. In that case the webhook
Lambda exhausts its retries (3 attempts, exponential backoff) and publishes an alert instead of
silently dropping the alarm:

```
L1 automated triage could not invoke the AWS DevOps Agent for canary "l1t-cart-canary"
after 3 attempts. The Agent did not run and no investigation was started.
Last error: Webhook request timed out.
```

This was validated live: the webhook secret was pointed at a deliberately unreachable endpoint,
a real canary alarm transition was forced, and the alert above was confirmed delivered.
Routine findings/RCA delivery (the transcript above) and this invocation-failure alert are
deliberately two different channels — see the architecture diagram in the main
[README](../README.md) for how they're wired.

## Notes for readers of this sample

- All timestamps, digests, and resource names above come from the real investigation transcript,
  lightly reformatted for readability. Nothing about the pet store app's architecture is
  hidden — it matches the public [One Observability Workshop](https://catalog.workshops.aws/observability/en-US) design.
- What's redacted (`<...>` placeholders, or removed entirely): the CloudFront distribution ID,
  the operator's IAM role ARN and alias, and the agent's internal execution-role name — these
  are specific to the AWS account used to run this validation, not part of the workshop.
