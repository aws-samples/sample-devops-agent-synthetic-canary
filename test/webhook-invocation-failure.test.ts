/*
Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
SPDX-License-Identifier: Apache-2.0
*/

/**
 * Unit tests for the webhook Lambda's SNS invocation-failure alert.
 *
 * `publishInvocationFailure` fires only when all DevOps Agent webhook
 * retries are exhausted (the Agent never ran) — a distinct failure mode
 * from a completed investigation's findings, which the DevOps Agent
 * delivers itself via its native Slack integration when it does run. See
 * docs/sample-investigation.md for a live-validated example of this alert.
 *
 * The handler's `@aws-sdk/client-sns` client is lazily required so it can
 * be mocked with jest without needing real AWS calls, following the same
 * pattern as test/repeat-notification-handler.test.ts.
 *
 * @packageDocumentation
 */

const mockSnsSend = jest.fn();

jest.mock('@aws-sdk/client-sns', () => ({
    SNSClient: jest.fn().mockImplementation(() => ({ send: mockSnsSend })),
    PublishCommand: jest.fn().mockImplementation((input) => ({ input })),
}));

export {};

// eslint-disable-next-line @typescript-eslint/no-var-requires
const handler = require('../src/lambda/webhook-node/index');
const { publishInvocationFailure } = handler.__test__;

describe('publishInvocationFailure', () => {
    beforeEach(() => {
        mockSnsSend.mockReset();
    });

    test('publishes a subject and message naming the canary and last error', async () => {
        mockSnsSend.mockResolvedValueOnce({});

        await publishInvocationFailure('arn:aws:sns:us-east-1:123456789012:l1t-invocation-failure', 'l1t-cart-canary', 'Webhook request timed out');

        expect(mockSnsSend).toHaveBeenCalledTimes(1);
        const publishCall = mockSnsSend.mock.calls[0][0];
        expect(publishCall.input.TopicArn).toBe('arn:aws:sns:us-east-1:123456789012:l1t-invocation-failure');
        expect(publishCall.input.Subject).toContain('l1t-cart-canary');
        expect(publishCall.input.Message).toContain('l1t-cart-canary');
        expect(publishCall.input.Message).toContain('Webhook request timed out');
        expect(publishCall.input.Message).toContain('3 attempts');
    });

    test('falls back to "unknown" when no last error is provided', async () => {
        mockSnsSend.mockResolvedValueOnce({});

        await publishInvocationFailure('arn:aws:sns:us-east-1:123456789012:l1t-invocation-failure', 'l1t-health-canary', null);

        const publishCall = mockSnsSend.mock.calls[0][0];
        expect(publishCall.input.Message).toContain('unknown');
    });

    test('skips publishing (and does not throw) when no topic ARN is configured', async () => {
        await publishInvocationFailure('', 'l1t-cart-canary', 'some error');

        expect(mockSnsSend).not.toHaveBeenCalled();
    });

    test('does not throw when the SNS publish itself fails', async () => {
        mockSnsSend.mockRejectedValueOnce(new Error('Throttled'));

        await expect(
            publishInvocationFailure('arn:aws:sns:us-east-1:123456789012:l1t-invocation-failure', 'l1t-cart-canary', 'timeout'),
        ).resolves.toBeUndefined();
    });
});
