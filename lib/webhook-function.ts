/*
Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
SPDX-License-Identifier: Apache-2.0
*/

/**
 * Webhook Lambda construct.
 *
 * Receives CloudWatch alarm state-change events (routed by an EventBridge
 * rule on the default bus, filtered by alarm name prefix), deduplicates via
 * a DynamoDB locks table, and invokes AWS DevOps Agent by POSTing an
 * HMAC-signed webhook. Publishes an SNS notification on retry exhaustion
 * (invocation failure only — routine findings/RCA are delivered separately
 * by the DevOps Agent's own native Slack integration, configured
 * out-of-band in the AWS DevOps Agent console; see
 * docs/sample-investigation.md).
 *
 * Extends {@link BaseLambdaFunction} to inherit DLQ, structured logging,
 * and X-Ray tracing.
 *
 * @packageDocumentation
 */
import { Stack } from 'aws-cdk-lib';
import { Rule } from 'aws-cdk-lib/aws-events';
import { LambdaFunction } from 'aws-cdk-lib/aws-events-targets';
import { EventBus } from 'aws-cdk-lib/aws-events';
import { Effect, Policy, PolicyStatement } from 'aws-cdk-lib/aws-iam';
import { ILayerVersion, LayerVersion } from 'aws-cdk-lib/aws-lambda';
import { ITable } from 'aws-cdk-lib/aws-dynamodb';
import { ISecret } from 'aws-cdk-lib/aws-secretsmanager';
import { ITopic } from 'aws-cdk-lib/aws-sns';
import { Queue } from 'aws-cdk-lib/aws-sqs';
import { BundlingOptions } from 'aws-cdk-lib/aws-lambda-nodejs';
import { NagSuppressions } from 'cdk-nag';
import { Construct } from 'constructs';
import {
    BaseLambdaFunction,
    BaseLambdaFunctionProperties,
    getOpenTelemetryNodeJSLayerArn,
    getLambdaInsightsLayerArn,
} from './constructs/lambda';

/** Properties for the webhook Lambda. */
export interface WebhookFunctionProperties extends BaseLambdaFunctionProperties {
    /** DynamoDB dedup/locks table (PK canaryName, TTL expiresAt). */
    locksTable: ITable;
    /** Secret holding { webhookUrl, hmacSecret } for the DevOps Agent webhook. */
    devopsWebhookSecret: ISecret;
    /** SNS topic notified when all DevOps Agent invocation retries are exhausted (invocation-failure alert, not a findings channel). */
    invocationFailureTopic: ITopic;
    /** Dedup window in seconds (default 900). */
    dedupTtlSeconds?: number;
    /**
     * Alarm name prefix this Lambda is routed for. Must match the prefix
     * used in the EventBridge rule's alarmName filter and in each alarm's
     * name (e.g. `<prefix><name>-availability`). Default: `l1t-health-`.
     */
    alarmNamePrefix?: string;
}

/**
 * Webhook Lambda that routes health-check alarms to the DevOps Agent.
 */
export class WebhookFunction extends BaseLambdaFunction {
    constructor(scope: Construct, id: string, properties: WebhookFunctionProperties) {
        super(scope, id, properties);

        const alarmNamePrefix = properties.alarmNamePrefix ?? 'l1t-health-';

        // EventBridge rule on the DEFAULT bus — CloudWatch delivers alarm
        // state-change events to the account default bus, not custom buses.
        const defaultBus = EventBus.fromEventBusName(this, 'DefaultEventBus', 'default');

        const routingDlq = new Queue(this, 'AlarmRoutingDLQ', {
            queueName: `${properties.name}-routing-dlq`,
            enforceSSL: true,
        });

        new Rule(this, 'AlarmStateChangeRule', {
            eventBus: defaultBus,
            description: 'Routes automated-triage alarm ALARM-state changes to the webhook Lambda',
            eventPattern: {
                source: ['aws.cloudwatch'],
                detailType: ['CloudWatch Alarm State Change'],
                detail: {
                    alarmName: [{ prefix: alarmNamePrefix }],
                    state: { value: ['ALARM'] },
                },
            },
            targets: [new LambdaFunction(this.function, { deadLetterQueue: routingDlq })],
        });

        NagSuppressions.addResourceSuppressions(
            routingDlq,
            [{ id: 'AwsSolutions-SQS3', reason: 'This queue is itself a dead-letter queue for EventBridge target failures' }],
            true,
        );
    }

    addFunctionPermissions(properties: BaseLambdaFunctionProperties): void {
        const props = properties as WebhookFunctionProperties;
        const policy = new Policy(this, 'WebhookPolicy', {
            roles: [this.function.role!],
            statements: [
                // Dedup table: conditional put.
                new PolicyStatement({
                    effect: Effect.ALLOW,
                    actions: ['dynamodb:PutItem', 'dynamodb:GetItem'],
                    resources: [props.locksTable.tableArn],
                }),
                // Read the DevOps Agent webhook secret (scoped to ARN).
                new PolicyStatement({
                    effect: Effect.ALLOW,
                    actions: ['secretsmanager:GetSecretValue'],
                    resources: [props.devopsWebhookSecret.secretArn],
                }),
                // Publish invocation-failure alerts (scoped to the topic ARN).
                new PolicyStatement({
                    effect: Effect.ALLOW,
                    actions: ['sns:Publish'],
                    resources: [props.invocationFailureTopic.topicArn],
                }),
                new PolicyStatement({
                    effect: Effect.ALLOW,
                    actions: ['xray:PutTraceSegments', 'xray:PutTelemetryRecords'],
                    resources: ['*'],
                }),
            ],
        });

        NagSuppressions.addResourceSuppressions(
            policy,
            [
                {
                    id: 'AwsSolutions-IAM5',
                    reason: 'X-Ray requires wildcard; Secrets Manager ARNs carry a required trailing suffix wildcard',
                },
            ],
            true,
        );
    }

    createOutputs(): void {}

    getEnvironmentVariables(properties: BaseLambdaFunctionProperties): { [key: string]: string } | undefined {
        const props = properties as WebhookFunctionProperties;
        return {
            L1T_LOCKS_TABLE_NAME: props.locksTable.tableName,
            L1T_DEVOPS_WEBHOOK_SECRET_ARN: props.devopsWebhookSecret.secretArn,
            L1T_INVOCATION_FAILURE_TOPIC_ARN: props.invocationFailureTopic.topicArn,
            L1T_DEDUP_TTL_SECONDS: String(props.dedupTtlSeconds ?? 900),
            L1T_ALARM_NAME_PREFIX: props.alarmNamePrefix ?? 'l1t-health-',
            AWS_NODEJS_CONNECTION_REUSE_ENABLED: '1',
        };
    }

    getLayers(_properties: BaseLambdaFunctionProperties): ILayerVersion[] {
        return [
            LayerVersion.fromLayerVersionArn(this, 'LambdaInsightsLayer', getLambdaInsightsLayerArn(Stack.of(this).region)),
            LayerVersion.fromLayerVersionArn(
                this,
                'OpenTelemetryLayer',
                getOpenTelemetryNodeJSLayerArn(Stack.of(this).region),
            ),
        ];
    }

    getBundling(_properties: BaseLambdaFunctionProperties): BundlingOptions {
        return {
            // Bundle the AWS SDK v3 clients directly via esbuild rather than
            // listing them under `nodeModules` — the latter forces an `npm
            // install` into the staging directory on every synth, which is
            // unnecessary for these pure-JS packages and is slow (or flaky)
            // whenever the npm registry is slow to respond.
            externalModules: [],
        };
    }
}
