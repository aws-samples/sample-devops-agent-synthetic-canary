/*
Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
SPDX-License-Identifier: Apache-2.0
*/

/**
 * Example stack wiring the full pattern together:
 *
 *   HealthCanary / UxCanary --(SuccessPercent alarm)--> EventBridge (default bus)
 *     --> WebhookFunction --(HMAC-signed POST)--> AWS DevOps Agent (primary; also posts
 *                                                  findings to Slack natively, console-configured)
 *                          --(invocation failure, all retries exhausted)--> SNS
 *
 * This is a reference wiring, not a required entry point — copy and adapt it
 * (or wire the constructs directly in your own stack) rather than depending
 * on this class as a black box.
 *
 * @packageDocumentation
 */
import { Stack, StackProps, Duration } from 'aws-cdk-lib';
import { ComparisonOperator, TreatMissingData } from 'aws-cdk-lib/aws-cloudwatch';
import { Runtime as CanaryRuntime, RuntimeFamily } from 'aws-cdk-lib/aws-synthetics';
import { Runtime } from 'aws-cdk-lib/aws-lambda';
import { Secret } from 'aws-cdk-lib/aws-secretsmanager';
import { Bucket } from 'aws-cdk-lib/aws-s3';
import { Topic } from 'aws-cdk-lib/aws-sns';
import { NagSuppressions } from 'cdk-nag';
import { Construct } from 'constructs';
import { HealthCanary } from './canaries/health-canary';
import { UxCanary, JourneyPage } from './canaries/ux-canary';
import { InvestigationLocksTable } from './investigation-locks-table';
import { RepeatedNotification } from './repeated-notification';
import { WebhookFunction } from './webhook-function';

/** Properties for {@link TriageStack}. */
export interface TriageStackProps extends StackProps {
    /**
     * Alarm-name prefix used for every alarm this stack creates and for the
     * EventBridge routing filter. Default: `l1t-health-`.
     */
    alarmNamePrefix?: string;
    /** Health canary configuration. Omit to skip creating a health canary. */
    health?: {
        targetUrls?: string;
        targetUrlsParameterName?: string;
        credentialsSecretArn?: string;
        requestTimeoutMs?: number;
        scheduleExpression?: string;
        ssmParameterPrefix?: string;
        /** Automatic canary-run retries on failure (0-2). See {@link BaseCanaryProperties.maxRetries}. */
        maxRetries?: number;
    };
    /** UX canary configuration. Omit to skip creating a UX canary. */
    ux?: {
        targetUrl?: string;
        targetUrlParameterName?: string;
        keySelector?: string;
        errorSelector?: string;
        userId?: string;
        journeyPages?: JourneyPage[];
        journeyPagesParameterName?: string;
        scheduleExpression?: string;
        ssmParameterPrefix?: string;
        /** Automatic canary-run retries on failure (0-2). See {@link BaseCanaryProperties.maxRetries}. */
        maxRetries?: number;
    };
    /** Dedup window for the webhook Lambda, in seconds (default 900). */
    dedupTtlSeconds?: number;
    /**
     * Enable periodic re-notification while an alarm remains in a sustained
     * ALARM state. CloudWatch alarms are edge-triggered — EventBridge only
     * receives an event on the *transition* into ALARM, not on every
     * evaluation while it remains there — so without this, a long-running
     * unresolved incident only ever triggers one DevOps Agent investigation.
     * Omit to skip creating the repeated-notification Step Function.
     */
    repeatedNotification?: {
        /** Seconds to wait between re-checks (default 300 = 5 minutes). */
        repeatIntervalSeconds?: number;
        /** Maximum number of repeat notifications before giving up (default 12, i.e. ~1 hour at the default interval). */
        maxRepeats?: number;
    };
}

/** Reference stack wiring canaries, alarms, EventBridge routing, and the webhook Lambda together. */
export class TriageStack extends Stack {
    constructor(scope: Construct, id: string, props: TriageStackProps = {}) {
        super(scope, id, props);

        const alarmNamePrefix = props.alarmNamePrefix ?? 'l1t-health-';
        const artifactsBucket = new Bucket(this, 'CanaryArtifacts', {
            enforceSSL: true,
        });

        NagSuppressions.addResourceSuppressions(artifactsBucket, [
            {
                id: 'AwsSolutions-S1',
                reason: 'Canary artifacts bucket (screenshots/HAR files); server access logging is not required for this reference example',
            },
        ]);

        const puppeteerRuntime = new CanaryRuntime('syn-nodejs-puppeteer-11.0', RuntimeFamily.NODEJS);

        if (props.health) {
            const healthCanary = new HealthCanary(this, 'HealthCanary', {
                name: 'l1t-health-canary',
                runtime: puppeteerRuntime,
                scheduleExpression: props.health.scheduleExpression ?? 'rate(5 minutes)',
                handler: 'index.handler',
                path: 'src/canaries/health',
                artifactsBucket,
                ssmParameterPrefix: props.health.ssmParameterPrefix,
                targetUrls: props.health.targetUrls,
                targetUrlsParameterName: props.health.targetUrlsParameterName,
                credentialsSecretArn: props.health.credentialsSecretArn,
                requestTimeoutMs: props.health.requestTimeoutMs,
                maxRetries: props.health.maxRetries,
            });

            healthCanary.canary.metricSuccessPercent({ statistic: 'Average' }).createAlarm(this, 'HealthAvailabilityAlarm', {
                alarmName: `${alarmNamePrefix}l1t-health-canary-availability`,
                threshold: 100,
                comparisonOperator: ComparisonOperator.LESS_THAN_THRESHOLD,
                evaluationPeriods: 1,
                treatMissingData: TreatMissingData.NOT_BREACHING,
            });
        }

        if (props.ux) {
            const uxCanary = new UxCanary(this, 'UxCanary', {
                name: 'l1t-ux-canary',
                runtime: puppeteerRuntime,
                scheduleExpression: props.ux.scheduleExpression ?? 'rate(5 minutes)',
                handler: 'index.handler',
                path: 'src/canaries/ux',
                artifactsBucket,
                ssmParameterPrefix: props.ux.ssmParameterPrefix,
                targetUrl: props.ux.targetUrl,
                targetUrlParameterName: props.ux.targetUrlParameterName,
                keySelector: props.ux.keySelector,
                errorSelector: props.ux.errorSelector,
                userId: props.ux.userId,
                journeyPages: props.ux.journeyPages,
                journeyPagesParameterName: props.ux.journeyPagesParameterName,
                maxRetries: props.ux.maxRetries,
            });

            uxCanary.canary.metricSuccessPercent({ statistic: 'Average' }).createAlarm(this, 'UxAvailabilityAlarm', {
                alarmName: `${alarmNamePrefix}l1t-ux-canary-availability`,
                threshold: 100,
                comparisonOperator: ComparisonOperator.LESS_THAN_THRESHOLD,
                evaluationPeriods: 1,
                treatMissingData: TreatMissingData.NOT_BREACHING,
            });
        }

        const locks = new InvestigationLocksTable(this, 'InvestigationLocks');

        // Placeholder secret — populate the real value (webhookUrl +
        // hmacSecret for DevOps Agent) after deploying.
        const devopsWebhookSecret = new Secret(this, 'DevOpsAgentWebhookSecret', {
            secretName: 'l1t-devops-agent-webhook',
            description: 'AWS DevOps Agent webhook URL + HMAC secret. Populate after deploy: { "webhookUrl": "...", "hmacSecret": "..." }',
            secretStringValue: undefined,
        });

        NagSuppressions.addResourceSuppressions(
            [devopsWebhookSecret],
            [{ id: 'AwsSolutions-SMG4', reason: 'Third-party webhook credentials; automatic rotation does not apply' }],
            true,
        );

        // Invocation-failure alert channel: notified only when all 3
        // DevOps Agent webhook retries are exhausted (the Agent never ran).
        // Routine findings/RCA delivery is handled separately by the DevOps
        // Agent's own native Slack integration (console-configured, no code
        // here) — see docs/sample-investigation.md. An operator subscribes
        // an email (or other SNS-supported endpoint) after deploying.
        const invocationFailureTopic = new Topic(this, 'InvocationFailureTopic', {
            topicName: 'l1t-invocation-failure',
            displayName: 'Automated Triage: DevOps Agent invocation failure',
            enforceSSL: true,
        });

        const webhookFunction = new WebhookFunction(this, 'WebhookFunction', {
            name: 'l1t-webhook-node',
            runtime: Runtime.NODEJS_22_X,
            entry: 'src/lambda/webhook-node/index.js',
            handler: 'handler',
            memorySize: 256,
            // 60s, not 30s: up to 3 webhook attempts at a 10s connect
            // timeout each, plus 1s/2s/4s exponential backoff between
            // attempts, is ~37s worst case when the DevOps Agent endpoint is
            // unreachable. A 30s timeout was observed (via a live
            // invocation-failure drill in the sibling validation project)
            // to kill the function mid-retry before it could ever publish
            // the SNS alert.
            timeout: Duration.seconds(60),
            locksTable: locks.table,
            devopsWebhookSecret,
            invocationFailureTopic,
            dedupTtlSeconds: props.dedupTtlSeconds,
            alarmNamePrefix,
        });

        NagSuppressions.addResourceSuppressions(
            webhookFunction,
            [
                {
                    id: 'AwsSolutions-IAM4',
                    reason: 'AWSLambdaBasicExecutionRole is the standard baseline execution policy for Lambda CloudWatch Logs access',
                    appliesTo: ['Policy::arn:<AWS::Partition>:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole'],
                },
                {
                    id: 'AwsSolutions-IAM5',
                    reason: 'The DLQ send-message grant CDK generates automatically for deadLetterQueueEnabled is scoped to the DLQ resource; no unscoped wildcard is added by this construct',
                },
                {
                    id: 'AwsSolutions-L1',
                    reason: 'NODEJS_22_X is the current supported Node.js runtime at the time this reference stack was authored; update as newer runtimes become available',
                },
            ],
            true,
        );

        if (props.repeatedNotification) {
            const repeatedNotification = new RepeatedNotification(this, 'RepeatedNotification', {
                alarmNamePrefix,
                repeatIntervalSeconds: props.repeatedNotification.repeatIntervalSeconds,
                maxRepeats: props.repeatedNotification.maxRepeats,
            });

            NagSuppressions.addResourceSuppressions(
                repeatedNotification.checkFunction,
                [
                    {
                        id: 'AwsSolutions-IAM4',
                        reason: 'AWSLambdaBasicExecutionRole is the standard baseline execution policy for Lambda CloudWatch Logs access',
                        appliesTo: ['Policy::arn:<AWS::Partition>:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole'],
                    },
                    {
                        id: 'AwsSolutions-L1',
                        reason: 'NODEJS_22_X is the current supported Node.js runtime at the time this reference stack was authored; update as newer runtimes become available',
                    },
                ],
                true,
            );
        }
    }
}
