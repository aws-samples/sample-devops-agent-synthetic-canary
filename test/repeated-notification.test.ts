/*
Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
SPDX-License-Identifier: Apache-2.0
*/

/**
 * Infrastructure tests for the {@link RepeatedNotification} construct.
 *
 * Synthesizes the construct in isolation (no Docker required — the check
 * Lambda is bundled via the esbuild devDependency) and asserts the EventBridge
 * rule, Step Function, and check Lambda are wired correctly.
 *
 * @packageDocumentation
 */

import { App, Stack } from 'aws-cdk-lib';
import { Template, Match } from 'aws-cdk-lib/assertions';
import { RepeatedNotification } from '../lib/repeated-notification';

function synthTemplate(overrides: Partial<{ repeatIntervalSeconds: number; maxRepeats: number }> = {}): Template {
    const app = new App();
    const stack = new Stack(app, 'TestStack', { env: { account: '123456789012', region: 'us-east-1' } });
    new RepeatedNotification(stack, 'RepeatedNotification', {
        alarmNamePrefix: 'l1t-health-',
        ...overrides,
    });
    return Template.fromStack(stack);
}

describe('RepeatedNotification', () => {
    let template: Template;

    beforeAll(() => {
        template = synthTemplate();
    });

    test('creates exactly one EventBridge rule matching the alarm-name prefix and ALARM state', () => {
        template.resourceCountIs('AWS::Events::Rule', 1);
        template.hasResourceProperties('AWS::Events::Rule', {
            EventPattern: Match.objectLike({
                source: ['aws.cloudwatch'],
                'detail-type': ['CloudWatch Alarm State Change'],
                detail: Match.objectLike({
                    alarmName: [{ prefix: 'l1t-health-' }],
                    state: { value: ['ALARM'] },
                }),
            }),
        });
    });

    test('creates a Step Functions state machine as the rule target', () => {
        template.resourceCountIs('AWS::StepFunctions::StateMachine', 1);
        template.hasResourceProperties('AWS::Events::Rule', {
            Targets: Match.arrayWith([
                Match.objectLike({
                    Arn: Match.objectLike({ Ref: Match.stringLikeRegexp('RepeatedNotificationStateMachine') }),
                }),
            ]),
        });
    });

    test('creates the check Lambda function', () => {
        template.resourceCountIs('AWS::Lambda::Function', 1);
        template.hasResourceProperties('AWS::Lambda::Function', {
            FunctionName: 'RepeatedNotification-repeat-check',
            Runtime: 'nodejs22.x',
        });
    });

    test('grants the check Lambda cloudwatch:DescribeAlarms and events:PutEvents scoped to the default bus', () => {
        template.hasResourceProperties('AWS::IAM::Policy', {
            PolicyDocument: Match.objectLike({
                Statement: Match.arrayWith([
                    Match.objectLike({ Action: 'cloudwatch:DescribeAlarms', Effect: 'Allow', Resource: '*' }),
                    Match.objectLike({
                        Action: 'events:PutEvents',
                        Effect: 'Allow',
                        Resource: 'arn:aws:events:us-east-1:123456789012:event-bus/default',
                    }),
                ]),
            }),
        });
    });

    test('respects a custom maxRepeats/repeatIntervalSeconds by scaling the state machine timeout', () => {
        // The Step Functions L2 construct's `timeout` prop is not surfaced as
        // a direct AWS::StepFunctions::StateMachine CloudFormation property —
        // it is embedded as the top-level `TimeoutSeconds` field inside the
        // synthesized Amazon States Language definition (`DefinitionString`).
        function timeoutSecondsOf(template: Template): number {
            const sm: any = Object.values(template.findResources('AWS::StepFunctions::StateMachine'))[0];
            const definitionString = sm.Properties.DefinitionString;
            // Fn::Join["", [...]] — the literal string fragments contain the
            // ASL JSON text with Ref/Fn::GetAtt tokens spliced in between;
            // extract the top-level TimeoutSeconds field via regex rather
            // than reconstructing the full (invalid, token-interrupted) JSON.
            const fragments = definitionString['Fn::Join'][1] as unknown[];
            const joined = fragments.filter((f) => typeof f === 'string').join('');
            const match = joined.match(/"TimeoutSeconds":\s*(\d+)/);
            if (!match) {
                throw new Error(`TimeoutSeconds not found in state machine definition: ${joined}`);
            }
            return Number(match[1]);
        }

        const defaultTemplate = synthTemplate();
        const customTemplate = synthTemplate({ repeatIntervalSeconds: 60, maxRepeats: 2 });

        // default: (300 + 30) * (12 + 1) = 4290; custom: (60 + 30) * (2 + 1) = 270
        expect(timeoutSecondsOf(defaultTemplate)).toBe(4290);
        expect(timeoutSecondsOf(customTemplate)).toBe(270);
    });
});
