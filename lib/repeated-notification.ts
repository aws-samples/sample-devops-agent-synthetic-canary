/*
Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
SPDX-License-Identifier: Apache-2.0
*/

/**
 * Repeated notification for sustained (non-transitioning) alarms.
 *
 * CloudWatch alarms are edge-triggered: EventBridge only receives a
 * "CloudWatch Alarm State Change" event on the *transition* into ALARM, not
 * on every evaluation while the alarm remains there. Left alone, this means
 * a long-running unresolved incident only ever triggers one webhook
 * invocation / one DevOps Agent investigation, even if it stays broken for
 * hours.
 *
 * This construct closes that gap, adapting the pattern from the AWS blog
 * post "How to enable Amazon CloudWatch Alarms to send repeated
 * notifications" (EventBridge → Step Functions → Lambda, with a
 * Wait/Check/Choice loop) — but instead of re-publishing to SNS, the check
 * Lambda re-emits a synthetic "CloudWatch Alarm State Change" event onto the
 * default EventBridge bus. That event flows through the exact same
 * `WebhookFunction` rule, dedup lock, HMAC signing, retry, and Slack
 * fallback as a genuine alarm transition — no special-casing needed in the
 * webhook Lambda itself.
 *
 * Architecture:
 *
 *   Alarm --(ALARM transition)--> EventBridge rule --> Step Function
 *                                                          |
 *                                            +-- Wait(interval) <--+
 *                                            |                     |
 *                                            v                     |
 *                                    Lambda: DescribeAlarms --------+ (still ALARM, repeats remain)
 *                                            |
 *                                            v
 *                              still ALARM? emit synthetic event --> WebhookFunction rule (re-investigates)
 *                              resolved / repeats exhausted? --> Succeed (stop)
 *
 * @packageDocumentation
 */
import { Duration, Stack } from 'aws-cdk-lib';
import { EventBus, Rule } from 'aws-cdk-lib/aws-events';
import { SfnStateMachine } from 'aws-cdk-lib/aws-events-targets';
import { Effect, Policy, PolicyStatement } from 'aws-cdk-lib/aws-iam';
import { Runtime } from 'aws-cdk-lib/aws-lambda';
import { NodejsFunction } from 'aws-cdk-lib/aws-lambda-nodejs';
import { LogGroup, RetentionDays } from 'aws-cdk-lib/aws-logs';
import { Choice, Condition, DefinitionBody, LogLevel, Pass, StateMachine, Succeed, Wait, WaitTime } from 'aws-cdk-lib/aws-stepfunctions';
import { LambdaInvoke } from 'aws-cdk-lib/aws-stepfunctions-tasks';
import { RemovalPolicy } from 'aws-cdk-lib';
import { Construct } from 'constructs';
import { NagSuppressions } from 'cdk-nag';

/** Properties for {@link RepeatedNotification}. */
export interface RepeatedNotificationProperties {
    /**
     * Alarm-name prefix to match — must be the same prefix used for the
     * alarms and for {@link WebhookFunctionProperties.alarmNamePrefix},
     * e.g. `l1t-health-`.
     */
    alarmNamePrefix: string;
    /**
     * Seconds to wait between re-checks (default 300 = 5 minutes). Set this
     * to be greater than or equal to the webhook Lambda's dedup TTL
     * (`dedupTtlSeconds`, default 900s) so each repeat actually reaches
     * AWS DevOps Agent again rather than being silently deduplicated —
     * or intentionally set it lower if you only want the *log evidence* of
     * repeated checks without a new investigation on every one.
     */
    repeatIntervalSeconds?: number;
    /** Maximum number of repeat notifications before giving up (default 12). */
    maxRepeats?: number;
}

/** Step Function that re-notifies while a matching alarm remains in ALARM. */
export class RepeatedNotification extends Construct {
    public readonly stateMachine: StateMachine;
    public readonly checkFunction: NodejsFunction;

    constructor(scope: Construct, id: string, properties: RepeatedNotificationProperties) {
        super(scope, id);

        const repeatIntervalSeconds = properties.repeatIntervalSeconds ?? 300;
        const maxRepeats = properties.maxRepeats ?? 12;

        const logGroup = new LogGroup(this, 'CheckFunctionLogGroup', {
            retention: RetentionDays.ONE_DAY,
            removalPolicy: RemovalPolicy.DESTROY,
        });

        this.checkFunction = new NodejsFunction(this, 'CheckFunction', {
            functionName: `${id}-repeat-check`,
            runtime: Runtime.NODEJS_22_X,
            entry: 'src/lambda/repeat-notification-node/index.js',
            handler: 'handler',
            memorySize: 256,
            timeout: Duration.seconds(30),
            logGroup,
            bundling: {
                // Bundle the AWS SDK v3 clients directly via esbuild rather
                // than listing them under `nodeModules` — the latter forces
                // an `npm install` into the staging directory on every
                // synth, which is unnecessary for these pure-JS packages and
                // is slow (or flaky) whenever the npm registry is slow to
                // respond.
                externalModules: [],
            },
        });

        const checkPolicy = new Policy(this, 'CheckFunctionPolicy', {
            roles: [this.checkFunction.role!],
            statements: [
                new PolicyStatement({
                    effect: Effect.ALLOW,
                    actions: ['cloudwatch:DescribeAlarms'],
                    resources: ['*'],
                }),
                new PolicyStatement({
                    effect: Effect.ALLOW,
                    actions: ['events:PutEvents'],
                    resources: [`arn:aws:events:${Stack.of(this).region}:${Stack.of(this).account}:event-bus/default`],
                }),
            ],
        });

        NagSuppressions.addResourceSuppressions(
            checkPolicy,
            [
                {
                    id: 'AwsSolutions-IAM5',
                    reason: 'cloudwatch:DescribeAlarms has no resource-level ARN support and must be called with a wildcard resource; events:PutEvents is scoped to the default bus ARN',
                    appliesTo: ['Resource::*'],
                },
            ],
            true,
        );

        // Wait -> check -> choice(continue? back to Wait : stop) loop.
        const waitState = new Wait(this, 'WaitBetweenChecks', {
            time: WaitTime.duration(Duration.seconds(repeatIntervalSeconds)),
        });

        const checkTask = new LambdaInvoke(this, 'CheckAlarmState', {
            lambdaFunction: this.checkFunction,
            payload: undefined, // pass the whole state through
            payloadResponseOnly: true,
        });

        const stop = new Succeed(this, 'Stop');

        const choice = new Choice(this, 'StillInAlarm?')
            .when(Condition.booleanEquals('$.continue', true), waitState)
            .otherwise(stop);

        waitState.next(checkTask);
        checkTask.next(choice);

        // Seed the initial state from the EventBridge event: alarmName from
        // the event detail, remainingRepeats from the configured budget.
        const seed = new Pass(this, 'SeedState', {
            parameters: {
                'alarmName.$': '$.detail.alarmName',
                remainingRepeats: maxRepeats,
            },
        });
        seed.next(waitState);

        const smLogGroup = new LogGroup(this, 'StateMachineLogGroup', {
            retention: RetentionDays.ONE_DAY,
            removalPolicy: RemovalPolicy.DESTROY,
        });

        this.stateMachine = new StateMachine(this, 'StateMachine', {
            definitionBody: DefinitionBody.fromChainable(seed),
            timeout: Duration.seconds((repeatIntervalSeconds + 30) * (maxRepeats + 1)),
            logs: {
                destination: smLogGroup,
                level: LogLevel.ERROR,
            },
        });

        NagSuppressions.addResourceSuppressions(
            this.stateMachine,
            [
                {
                    id: 'AwsSolutions-IAM5',
                    reason: 'Step Functions X-Ray/CloudWatch Logs delivery role permissions are created and scoped by the CDK L2 construct itself',
                },
            ],
            true,
        );

        const defaultBus = EventBus.fromEventBusName(this, 'DefaultEventBus', 'default');

        new Rule(this, 'AlarmTransitionRule', {
            eventBus: defaultBus,
            description: 'Starts the repeated-notification state machine when a matching alarm transitions to ALARM',
            eventPattern: {
                source: ['aws.cloudwatch'],
                detailType: ['CloudWatch Alarm State Change'],
                detail: {
                    alarmName: [{ prefix: properties.alarmNamePrefix }],
                    state: { value: ['ALARM'] },
                },
            },
            targets: [new SfnStateMachine(this.stateMachine)],
        });
    }
}
