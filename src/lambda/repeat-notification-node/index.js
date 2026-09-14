/*
Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
SPDX-License-Identifier: Apache-2.0
*/

/**
 * Repeat-notification check Lambda.
 *
 * CloudWatch alarms are edge-triggered: EventBridge only receives a
 * "CloudWatch Alarm State Change" event on the *transition* into ALARM, not
 * on every evaluation while the alarm remains in that state. Left alone, a
 * long-running unresolved incident only ever triggers one investigation.
 *
 * This Lambda is invoked repeatedly by a Step Function state machine
 * (`RepeatedNotification`, see `lib/repeated-notification.ts`) on a timer.
 * Each invocation:
 *
 *   1. Calls `DescribeAlarms` for the alarm named in the input.
 *   2. If the alarm is no longer in ALARM state, or the repeat budget is
 *      exhausted, tells the state machine to stop.
 *   3. Otherwise, re-emits a synthetic "CloudWatch Alarm State Change" event
 *      onto the account default EventBridge bus — identical in shape to a
 *      real alarm transition, so it flows through the *same* webhook Lambda
 *      rule, dedup lock, HMAC signing, retry, and Slack-fallback logic as a
 *      fresh occurrence, without any special-casing in that Lambda.
 *
 * Re-notification only actually reaches AWS DevOps Agent again once the
 * webhook Lambda's dedup lock (keyed by the derived canary/source name) has
 * expired — by default the repeat interval is configured to match the
 * dedup TTL for this reason. See `lib/repeated-notification.ts` for how the
 * two are kept in sync.
 *
 * Input (from the Step Function state):
 *   { alarmName: string, remainingRepeats: number }
 *
 * Output:
 *   { continue: boolean, remainingRepeats: number, reason: (string|undefined) }
 */

'use strict';

let _cloudwatch;
let _DescribeAlarmsCommand;
let _eventbridge;
let _PutEventsCommand;

function cloudwatchClient() {
    if (!_cloudwatch) {
        const { CloudWatchClient, DescribeAlarmsCommand } = require('@aws-sdk/client-cloudwatch');
        _DescribeAlarmsCommand = DescribeAlarmsCommand;
        _cloudwatch = new CloudWatchClient({});
    }
    return _cloudwatch;
}

function eventBridgeClient() {
    if (!_eventbridge) {
        const { EventBridgeClient, PutEventsCommand } = require('@aws-sdk/client-eventbridge');
        _PutEventsCommand = PutEventsCommand;
        _eventbridge = new EventBridgeClient({});
    }
    return _eventbridge;
}

/** Simple structured logger. */
function log(level, message, extra) {
    console.log(JSON.stringify({ level, message, ...extra }));
}

/**
 * Look up the current state of an alarm.
 *
 * @param {string} alarmName
 * @returns {Promise<string|null>} the alarm's StateValue, or null if not found
 */
async function describeAlarmState(alarmName) {
    const client = cloudwatchClient();
    const resp = await client.send(new _DescribeAlarmsCommand({ AlarmNames: [alarmName] }));
    const alarm = (resp.MetricAlarms || [])[0] || (resp.CompositeAlarms || [])[0];
    return alarm ? alarm.StateValue : null;
}

/**
 * Re-emit a synthetic CloudWatch Alarm State Change event onto the default
 * EventBridge bus, identical in shape to a real alarm transition.
 *
 * @param {string} alarmName
 */
async function emitSyntheticAlarmEvent(alarmName) {
    const client = eventBridgeClient();
    const now = new Date().toISOString();
    await client.send(
        new _PutEventsCommand({
            Entries: [
                {
                    EventBusName: 'default',
                    Source: 'aws.cloudwatch',
                    DetailType: 'CloudWatch Alarm State Change',
                    Time: new Date(),
                    Detail: JSON.stringify({
                        alarmName,
                        state: {
                            value: 'ALARM',
                            timestamp: now,
                            reason: 'Repeated notification: alarm remains in ALARM state',
                        },
                    }),
                },
            ],
        }),
    );
}

/**
 * Lambda entry point, invoked by the RepeatedNotification state machine.
 *
 * @param {{alarmName: string, remainingRepeats: number}} event
 */
exports.handler = async (event) => {
    const { alarmName, remainingRepeats } = event;
    log('info', 'Checking alarm for repeated notification', { alarmName, remainingRepeats });

    if (typeof remainingRepeats !== 'number' || remainingRepeats <= 0) {
        log('info', 'Repeat budget exhausted; stopping', { alarmName, remainingRepeats });
        return { continue: false, remainingRepeats: 0, reason: 'repeat-budget-exhausted' };
    }

    let stateValue;
    try {
        stateValue = await describeAlarmState(alarmName);
    } catch (e) {
        log('error', 'DescribeAlarms failed; stopping to avoid an unbounded loop', { alarmName, error: e.message });
        return { continue: false, remainingRepeats, reason: 'describe-alarms-error' };
    }

    if (stateValue !== 'ALARM') {
        log('info', 'Alarm is no longer in ALARM state; stopping', { alarmName, stateValue });
        return { continue: false, remainingRepeats, reason: 'resolved' };
    }

    await emitSyntheticAlarmEvent(alarmName);
    log('info', 'Re-emitted synthetic alarm event for repeated notification', { alarmName, remainingRepeats: remainingRepeats - 1 });

    return { continue: true, remainingRepeats: remainingRepeats - 1 };
};

// Exported for unit testing.
exports.__test__ = {
    describeAlarmState,
    emitSyntheticAlarmEvent,
};
