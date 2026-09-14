/*
Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
SPDX-License-Identifier: Apache-2.0
*/

/**
 * Unit tests for the repeat-notification check Lambda handler.
 *
 * The handler's AWS SDK clients (`@aws-sdk/client-cloudwatch`,
 * `@aws-sdk/client-eventbridge`) are lazily required so they can be mocked
 * with jest without needing real AWS calls.
 *
 * @packageDocumentation
 */

const mockCloudWatchSend = jest.fn();
const mockEventBridgeSend = jest.fn();

jest.mock('@aws-sdk/client-cloudwatch', () => ({
    CloudWatchClient: jest.fn().mockImplementation(() => ({ send: mockCloudWatchSend })),
    DescribeAlarmsCommand: jest.fn().mockImplementation((input) => ({ input })),
}));

jest.mock('@aws-sdk/client-eventbridge', () => ({
    EventBridgeClient: jest.fn().mockImplementation(() => ({ send: mockEventBridgeSend })),
    PutEventsCommand: jest.fn().mockImplementation((input) => ({ input })),
}));

export {};

// eslint-disable-next-line @typescript-eslint/no-var-requires
const handler = require('../src/lambda/repeat-notification-node/index');

describe('repeat-notification handler', () => {
    beforeEach(() => {
        mockCloudWatchSend.mockReset();
        mockEventBridgeSend.mockReset();
    });

    test('stops immediately when the repeat budget is already exhausted', async () => {
        const result = await handler.handler({ alarmName: 'l1t-health-svc-availability', remainingRepeats: 0 });
        expect(result).toEqual({ continue: false, remainingRepeats: 0, reason: 'repeat-budget-exhausted' });
        expect(mockCloudWatchSend).not.toHaveBeenCalled();
        expect(mockEventBridgeSend).not.toHaveBeenCalled();
    });

    test('stops when the alarm has returned to OK (resolved)', async () => {
        mockCloudWatchSend.mockResolvedValueOnce({ MetricAlarms: [{ StateValue: 'OK' }] });
        const result = await handler.handler({ alarmName: 'l1t-health-svc-availability', remainingRepeats: 5 });
        expect(result).toEqual({ continue: false, remainingRepeats: 5, reason: 'resolved' });
        expect(mockEventBridgeSend).not.toHaveBeenCalled();
    });

    test('re-emits a synthetic alarm event and decrements the budget when still in ALARM', async () => {
        mockCloudWatchSend.mockResolvedValueOnce({ MetricAlarms: [{ StateValue: 'ALARM' }] });
        mockEventBridgeSend.mockResolvedValueOnce({});

        const result = await handler.handler({ alarmName: 'l1t-health-svc-availability', remainingRepeats: 5 });

        expect(result).toEqual({ continue: true, remainingRepeats: 4 });
        expect(mockEventBridgeSend).toHaveBeenCalledTimes(1);

        const putEventsCall = mockEventBridgeSend.mock.calls[0][0];
        expect(putEventsCall.input.Entries).toHaveLength(1);
        const entry = putEventsCall.input.Entries[0];
        expect(entry.EventBusName).toBe('default');
        expect(entry.Source).toBe('aws.cloudwatch');
        expect(entry.DetailType).toBe('CloudWatch Alarm State Change');

        const detail = JSON.parse(entry.Detail);
        expect(detail.alarmName).toBe('l1t-health-svc-availability');
        expect(detail.state.value).toBe('ALARM');
        expect(typeof detail.state.timestamp).toBe('string');
    });

    test('stops (without crashing) if DescribeAlarms fails, to avoid an unbounded loop', async () => {
        mockCloudWatchSend.mockRejectedValueOnce(new Error('throttled'));
        const result = await handler.handler({ alarmName: 'l1t-health-svc-availability', remainingRepeats: 3 });
        expect(result).toEqual({ continue: false, remainingRepeats: 3, reason: 'describe-alarms-error' });
        expect(mockEventBridgeSend).not.toHaveBeenCalled();
    });

    test('handles CompositeAlarms as a fallback when MetricAlarms is empty', async () => {
        mockCloudWatchSend.mockResolvedValueOnce({ MetricAlarms: [], CompositeAlarms: [{ StateValue: 'ALARM' }] });
        mockEventBridgeSend.mockResolvedValueOnce({});
        const result = await handler.handler({ alarmName: 'composite-alarm', remainingRepeats: 2 });
        expect(result.continue).toBe(true);
    });

    test('treats an alarm that no longer exists as resolved (stateValue null)', async () => {
        mockCloudWatchSend.mockResolvedValueOnce({ MetricAlarms: [], CompositeAlarms: [] });
        const result = await handler.handler({ alarmName: 'deleted-alarm', remainingRepeats: 2 });
        expect(result).toEqual({ continue: false, remainingRepeats: 2, reason: 'resolved' });
    });
});
