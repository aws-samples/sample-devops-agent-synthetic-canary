/*
Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
SPDX-License-Identifier: Apache-2.0
*/

/**
 * CloudWatch Synthetics canary construct base.
 *
 * Creates a CloudWatch Synthetics canary with a least-privilege IAM role,
 * optional S3 artifacts bucket wiring, a configurable schedule, and X-Ray
 * tracing — the shared scaffolding both canaries in this project build on.
 *
 * @packageDocumentation
 */
import { Duration, Stack } from 'aws-cdk-lib';
import { Effect, ManagedPolicy, Policy, PolicyStatement, Role, ServicePrincipal } from 'aws-cdk-lib/aws-iam';
import { RetentionDays } from 'aws-cdk-lib/aws-logs';
import { IBucket } from 'aws-cdk-lib/aws-s3';
import { Canary, Code, ResourceToReplicateTags, Runtime, Schedule, Test } from 'aws-cdk-lib/aws-synthetics';
import { Construct } from 'constructs';
import { NagSuppressions } from 'cdk-nag';

/** Properties for configuring a CloudWatch Synthetics canary. */
export interface BaseCanaryProperties {
    /** S3 bucket for canary artifacts and screenshots */
    artifactsBucket?: IBucket;
    /** Synthetics runtime version */
    runtime: Runtime;
    /** CloudWatch Events schedule expression (default: rate(5 minutes)) */
    scheduleExpression?: string;
    /** Handler function name within the canary code */
    handler: string;
    /** Path to the canary source code directory */
    path: string;
    /** CloudWatch Logs retention period */
    logRetentionDays?: RetentionDays;
    /** Canary name used for CloudWatch identification */
    name: string;
    /**
     * SSM parameter path prefix (no leading slash) the canary is granted read
     * access to (ssm:GetParameter*), e.g. `myapp/`. Required if the canary
     * needs to read any SSM parameter (such as a target URL parameter);
     * omit if the canary is fully configured via inline environment
     * variables.
     */
    ssmParameterPrefix?: string;
    /**
     * Number of times CloudWatch Synthetics automatically retries a failed
     * canary run before reporting the run as failed (0-2). Retrying absorbs
     * transient blips (a single slow DNS lookup, one flaky response) so they
     * don't count toward the SuccessPercent metric an availability alarm
     * evaluates — reducing false-positive alarms/investigations for
     * one-off failures that a second attempt would have passed.
     *
     * Only supported on `Runtime.SYNTHETICS_NODEJS_PUPPETEER_10_0` and newer
     * (this project's `syn-nodejs-puppeteer-11.0` runtime qualifies).
     * Canaries that time out after 10 minutes are automatically limited to
     * one retry regardless of this setting.
     *
     * @default 0 (no automatic retry)
     */
    maxRetries?: number;
}

/** Abstract base class for CloudWatch Synthetics canaries with IAM role creation and schedule configuration. */
export abstract class BaseCanary extends Construct {
    public canary: Canary;
    constructor(scope: Construct, id: string, properties: BaseCanaryProperties) {
        super(scope, id);

        const canaryRole = this.createLambdaRole(properties);
        properties.artifactsBucket?.grantReadWrite(canaryRole);

        this.canary = new Canary(this, `canary-${id}`, {
            canaryName: properties.name,
            runtime: properties.runtime,
            schedule: Schedule.expression(properties.scheduleExpression || 'rate(5 minutes)'),
            test: Test.custom({
                handler: properties.handler,
                code: Code.fromAsset(properties.path),
            }),
            activeTracing: true,
            artifactsBucketLocation: properties.artifactsBucket
                ? {
                      bucket: properties.artifactsBucket,
                      prefix: `canary-${id}`,
                  }
                : undefined,
            environmentVariables: {
                ...this.getEnvironmentVariables(properties),
            },
            provisionedResourceCleanup: true,
            resourcesToReplicateTags: [ResourceToReplicateTags.LAMBDA_FUNCTION],
            artifactsBucketLifecycleRules: [
                {
                    expiration: Duration.days(properties.logRetentionDays?.valueOf() || 30),
                },
            ],
            startAfterCreation: true,
            role: canaryRole,
            maxRetries: properties.maxRetries,
        });

        if (properties.ssmParameterPrefix) {
            const parameterStorePolicy = new Policy(this, `${id}-paramterstore-policy`, {
                statements: [BaseCanary.getDefaultSSMPolicy(this, properties.ssmParameterPrefix)],
                roles: [this.canary.role],
            });

            NagSuppressions.addResourceSuppressions(
                parameterStorePolicy,
                [
                    {
                        id: 'AwsSolutions-IAM5',
                        reason: 'This allows the canary to read parameters for the application and perform multiple actions',
                        appliesTo: [
                            `Resource::arn:aws:ssm:${Stack.of(this).region}:${Stack.of(this).account}:parameter/${BaseCanary.cleanPrefix(
                                properties.ssmParameterPrefix,
                            )}*`,
                        ],
                    },
                ],
                true,
            );
        }

        this.canary.role.addManagedPolicy(ManagedPolicy.fromAwsManagedPolicyName('AWSXRayDaemonWriteAccess'));

        NagSuppressions.addResourceSuppressions(
            this.canary.role,
            [
                {
                    id: 'AwsSolutions-IAM5',
                    reason: 'Suppress wildcard permissions created by the Canary Construct',
                },
                {
                    id: 'AwsSolutions-IAM4',
                    reason: 'XRay managed polices are acceptable',
                },
            ],
            true,
        );
    }

    private static cleanPrefix(prefix: string): string {
        return prefix.startsWith('/') ? prefix.slice(1) : prefix;
    }

    public static getDefaultSSMPolicy(scope: Construct, prefix: string) {
        const cleanPrefix = BaseCanary.cleanPrefix(prefix);
        const readSMParametersPolicy = new PolicyStatement({
            effect: Effect.ALLOW,
            actions: ['ssm:GetParametersByPath', 'ssm:GetParameters', 'ssm:GetParameter'],
            resources: [`arn:aws:ssm:${Stack.of(scope).region}:${Stack.of(scope).account}:parameter/${cleanPrefix}*`],
        });

        return readSMParametersPolicy;
    }

    /**
     * Creates IAM role for the Canary
     */
    private createLambdaRole(properties: BaseCanaryProperties): Role {
        const managedPolicies = [
            'service-role/AWSLambdaBasicExecutionRole',
            'AWSXRayDaemonWriteAccess',
        ];

        const role = new Role(this, 'LambdaRole', {
            assumedBy: new ServicePrincipal('lambda.amazonaws.com'),
            description: `Role for ${properties.name} Canary Lambda function`,
            managedPolicies: managedPolicies.map((policy) => ManagedPolicy.fromAwsManagedPolicyName(policy)),
        });

        const metricPolicy = new Policy(this, 'MetricsDataPolicy', {
            roles: [role],
            statements: [
                new PolicyStatement({
                    effect: Effect.ALLOW,
                    actions: ['cloudwatch:PutMetricData'],
                    resources: ['*'],
                }),
            ],
        });

        NagSuppressions.addResourceSuppressions(
            [metricPolicy],
            [
                {
                    id: 'AwsSolutions-IAM5',
                    reason: 'PutMetricData action allowed for simplicity on wildcard',
                },
            ],
            true,
        );
        return role;
    }

    /**
     * Creates CloudFormation outputs for the canary.
     * Must be implemented by concrete subclasses.
     *
     * @param properties - Canary configuration properties
     */
    abstract createOutputs(properties: BaseCanaryProperties): void;

    /**
     * Returns environment variables for the canary.
     * Must be implemented by concrete subclasses.
     *
     * @param properties - Canary configuration properties
     * @returns Map of environment variable names to values
     */
    abstract getEnvironmentVariables(properties: BaseCanaryProperties): { [key: string]: string } | undefined;
}
