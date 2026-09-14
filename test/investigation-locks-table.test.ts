/*
Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
SPDX-License-Identifier: Apache-2.0
*/

/**
 * Infrastructure test for the investigation deduplication locks table.
 *
 * Synthesizes the construct in isolation (no Docker / deploy config).
 *
 * @packageDocumentation
 */

import { App, Stack } from 'aws-cdk-lib';
import { Template, Match } from 'aws-cdk-lib/assertions';
import { InvestigationLocksTable } from '../lib/investigation-locks-table';

describe('InvestigationLocksTable', () => {
    test('creates the investigation locks table with TTL on expiresAt', () => {
        const app = new App();
        const stack = new Stack(app, 'DdbTestStack', { env: { account: '123456789012', region: 'us-east-1' } });
        new InvestigationLocksTable(stack, 'Locks');
        const template = Template.fromStack(stack);

        template.hasResourceProperties('AWS::DynamoDB::Table', {
            KeySchema: Match.arrayWith([{ AttributeName: 'canaryName', KeyType: 'HASH' }]),
            TimeToLiveSpecification: { AttributeName: 'expiresAt', Enabled: true },
        });
    });

    test('creates cross-stack exports when exportNamePrefix is provided', () => {
        const app = new App();
        const stack = new Stack(app, 'DdbTestStack2', { env: { account: '123456789012', region: 'us-east-1' } });
        new InvestigationLocksTable(stack, 'Locks', { exportNamePrefix: 'MyApp-InvestigationLocks' });
        const template = Template.fromStack(stack);

        template.hasOutput('*', { Export: { Name: 'MyApp-InvestigationLocks-Arn' } });
        template.hasOutput('*', { Export: { Name: 'MyApp-InvestigationLocks-Name' } });
    });
});

// NOTE: The WebhookFunction extends the NodejsFunction base, which bundles
// the handler with esbuild-in-Docker at synth time. If Docker/esbuild is not
// available in your test environment, a Template.fromStack synth of that
// construct cannot run there. The webhook is therefore validated two ways
// instead:
//   1. Its handler logic — alarm parsing, HMAC signing, retry/backoff,
//      payload — is covered by test/webhook-handler.test.ts (pure, no
//      bundling).
//   2. Its infrastructure (Lambda, default-bus EventBridge rule, IAM, env)
//      is validated at deploy time.
