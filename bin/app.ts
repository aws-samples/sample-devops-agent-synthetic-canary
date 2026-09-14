#!/usr/bin/env node
/*
Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
SPDX-License-Identifier: Apache-2.0
*/

/**
 * Example CDK app entry point.
 *
 * Deploys the reference {@link TriageStack} pointed at whatever endpoints
 * you configure below. Edit the properties to match your application before
 * deploying, or copy the constructs into your own CDK app instead of using
 * this entry point directly.
 *
 * @packageDocumentation
 */
import 'source-map-support/register';
import { App, Aspects } from 'aws-cdk-lib';
import { AwsSolutionsChecks } from 'cdk-nag';
import { TriageStack } from '../lib/triage-stack';

const app = new App();

new TriageStack(app, 'SyntheticCanaryToDevOpsAgent', {
    // A concrete account/region is required so region-specific Lambda layer
    // ARNs (Lambda Insights, ADOT) can be resolved at synth time. cdk synth
    // populates these from your current AWS credentials/profile.
    env: {
        account: process.env.CDK_DEFAULT_ACCOUNT,
        region: process.env.CDK_DEFAULT_REGION,
    },
    // Uncomment and configure to enable each canary. See README.md for the
    // full list of properties and how to point this at your application.
    //
    // health: {
    //     targetUrls: 'https://your-app.example.com/health',
    //     requestTimeoutMs: 30000,
    // },
    // ux: {
    //     targetUrl: 'https://your-app.example.com',
    //     keySelector: 'body',
    //     journeyPages: [
    //         { name: 'catalog', path: '/catalog', contentSelector: '.item', emptyStateSelector: '.empty-state' },
    //     ],
    // },
});

Aspects.of(app).add(new AwsSolutionsChecks({ verbose: true }));
