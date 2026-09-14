/*
Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
SPDX-License-Identifier: Apache-2.0
*/

/**
 * Health Check Canary construct.
 *
 * CloudWatch Synthetics canary that performs outside-in API health checks
 * against every configured target URL on a schedule. It is a detection
 * entry point: canary failures drive the `SuccessPercent` metric that an
 * availability alarm evaluates, which in turn triggers the automated
 * investigation flow.
 *
 * Extends {@link BaseCanary} to reuse the shared IAM role, S3 artifacts
 * bucket, schedule, and X-Ray tracing, adding only:
 *
 *  - parameterized target URLs (inline list or an SSM parameter), and
 *  - optional Secrets Manager read access for auth credentials, scoped to a
 *    single secret ARN (least-privilege).
 *
 * All inputs are deploy-time parameters so the canary can be pointed at any
 * application's endpoints without modifying source.
 *
 * @packageDocumentation
 */
import { Effect, Policy, PolicyStatement } from 'aws-cdk-lib/aws-iam';
import { Construct } from 'constructs';
import { NagSuppressions } from 'cdk-nag';
import { BaseCanary, BaseCanaryProperties } from '../constructs/canary';

/** Properties for the health-check canary. */
export interface HealthCanaryProperties extends BaseCanaryProperties {
    /**
     * Comma-separated list of target health-check URLs. Takes precedence over
     * {@link targetUrlsParameterName} when both are provided.
     */
    targetUrls?: string;
    /** SSM parameter name holding a comma-separated list of target URLs. */
    targetUrlsParameterName?: string;
    /**
     * Secrets Manager ARN for auth credentials the canary retrieves before
     * performing health checks. Optional — omit for unauthenticated endpoints.
     */
    credentialsSecretArn?: string;
    /** Per-request timeout in milliseconds (default: 30000). */
    requestTimeoutMs?: number;
}

/**
 * Synthetics canary that health-checks configured API endpoints for
 * automated triage detection.
 */
export class HealthCanary extends BaseCanary {
    constructor(scope: Construct, id: string, properties: HealthCanaryProperties) {
        super(scope, id, properties);

        this.grantCredentialAccess(properties);
    }

    /**
     * Grant the canary read access to the credentials secret, scoped to the
     * specific ARN (no wildcards).
     */
    private grantCredentialAccess(properties: HealthCanaryProperties): void {
        if (!properties.credentialsSecretArn) {
            return;
        }

        const secretPolicy = new Policy(this, 'CredentialsSecretPolicy', {
            roles: [this.canary.role],
            statements: [
                new PolicyStatement({
                    effect: Effect.ALLOW,
                    actions: ['secretsmanager:GetSecretValue'],
                    resources: [properties.credentialsSecretArn],
                }),
            ],
        });

        // Secrets Manager appends a random 6-character suffix to secret ARNs;
        // a trailing wildcard on the provided ARN is the documented way to
        // reference it and is scoped to this single secret.
        NagSuppressions.addResourceSuppressions(
            secretPolicy,
            [
                {
                    id: 'AwsSolutions-IAM5',
                    reason: 'Scoped to a single Secrets Manager secret ARN; the trailing suffix wildcard is required by Secrets Manager ARN semantics',
                },
            ],
            true,
        );
    }

    createOutputs(): void {}

    getEnvironmentVariables(properties: HealthCanaryProperties): { [key: string]: string } | undefined {
        const env: { [key: string]: string } = {};

        if (properties.targetUrls) {
            env.L1T_TARGET_URLS = properties.targetUrls;
        }
        if (properties.targetUrlsParameterName) {
            env.L1T_TARGET_URLS_PARAMETER_NAME = properties.targetUrlsParameterName;
        }
        if (properties.credentialsSecretArn) {
            env.L1T_CREDENTIALS_SECRET_ARN = properties.credentialsSecretArn;
        }
        env.L1T_REQUEST_TIMEOUT_MS = String(properties.requestTimeoutMs ?? 30000);

        return env;
    }
}
