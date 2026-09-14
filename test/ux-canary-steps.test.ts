/*
Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
SPDX-License-Identifier: Apache-2.0
*/

/**
 * Unit tests for the UX canary's interaction-step executor (`runStep`,
 * `runSteps`).
 *
 * These cover the write-path/transactional extension: a journey page can
 * describe an ordered sequence of click/type/wait/assert steps, run after
 * navigation and before the (optional) content assertion, so the canary can
 * detect failures like "Add to Cart does nothing" or "form submit 500s" —
 * failures a pure navigate-and-assert check can never observe because
 * nothing is ever clicked or submitted.
 *
 * Exercised against a fake Puppeteer `Page` (no real browser/Synthetics
 * runtime), matching the pattern used by the existing `evaluatePageResult`/
 * `isSelectorVisible` tests in this suite.
 *
 * @packageDocumentation
 */

export {};

// eslint-disable-next-line @typescript-eslint/no-var-requires
const handler = require('../src/canaries/ux/nodejs/node_modules/index');
const { runStep, runSteps } = handler.__test__;

/**
 * Minimal fake Puppeteer Page exposing just the methods the step executor
 * calls: waitForSelector, click, type, evaluate (used internally by
 * isSelectorVisible for the `assertVisible` action).
 */
function fakePage(overrides: Partial<Record<string, jest.Mock>> = {}) {
    return {
        waitForSelector: jest.fn().mockResolvedValue(undefined),
        click: jest.fn().mockResolvedValue(undefined),
        type: jest.fn().mockResolvedValue(undefined),
        evaluate: jest.fn().mockResolvedValue(true),
        ...overrides,
    };
}

describe('runStep — click', () => {
    test('waits for the selector to be visible, then clicks it', async () => {
        const p = fakePage();
        await runStep(p, { action: 'click', selector: '.add-to-cart-btn' }, 0);
        expect(p.waitForSelector).toHaveBeenCalledWith('.add-to-cart-btn', { timeout: 10000, visible: true });
        expect(p.click).toHaveBeenCalledWith('.add-to-cart-btn');
    });

    test('respects a custom timeout', async () => {
        const p = fakePage();
        await runStep(p, { action: 'click', selector: '.btn', timeout: 5000 }, 0);
        expect(p.waitForSelector).toHaveBeenCalledWith('.btn', { timeout: 5000, visible: true });
    });

    test('throws a descriptive error identifying the step index and action when the click target never appears', async () => {
        const p = fakePage({ waitForSelector: jest.fn().mockRejectedValue(new Error('timeout')) });
        await expect(runStep(p, { action: 'click', selector: '.missing-btn' }, 2)).rejects.toThrow(
            /step\[2\] click \(\.missing-btn\) failed/,
        );
    });
});

describe('runStep — type', () => {
    test('waits for the selector, then types the configured value with the configured delay', async () => {
        const p = fakePage();
        await runStep(p, { action: 'type', selector: '#search', value: 'puppy', delay: 20 }, 0);
        expect(p.waitForSelector).toHaveBeenCalledWith('#search', { timeout: 10000, visible: true });
        expect(p.type).toHaveBeenCalledWith('#search', 'puppy', { delay: 20 });
    });

    test('defaults to an empty value and zero delay when not specified', async () => {
        const p = fakePage();
        await runStep(p, { action: 'type', selector: '#search' }, 0);
        expect(p.type).toHaveBeenCalledWith('#search', '', { delay: 0 });
    });

    test('throws a descriptive error when the input field never appears', async () => {
        const p = fakePage({ waitForSelector: jest.fn().mockRejectedValue(new Error('timeout')) });
        await expect(runStep(p, { action: 'type', selector: '#missing', value: 'x' }, 1)).rejects.toThrow(
            /step\[1\] type \(#missing\) failed/,
        );
    });
});

describe('runStep — waitForSelector', () => {
    test('waits for the selector without asserting visibility', async () => {
        const p = fakePage();
        await runStep(p, { action: 'waitForSelector', selector: '.cart-badge' }, 0);
        expect(p.waitForSelector).toHaveBeenCalledWith('.cart-badge', { timeout: 10000 });
    });

    test('throws a descriptive timeout error when the selector never appears', async () => {
        const p = fakePage({ waitForSelector: jest.fn().mockRejectedValue(new Error('timeout')) });
        await expect(runStep(p, { action: 'waitForSelector', selector: '.cart-badge', timeout: 3000 }, 0)).rejects.toThrow(
            /step\[0\] waitForSelector \(\.cart-badge\) failed: selector did not appear within 3000ms/,
        );
    });
});

describe('runStep — assertVisible', () => {
    test('passes immediately when the selector is already visible', async () => {
        const p = fakePage({ evaluate: jest.fn().mockResolvedValue(true) });
        await expect(runStep(p, { action: 'assertVisible', selector: '.cart-badge' }, 0)).resolves.toBeUndefined();
    });

    test('throws a descriptive error when the selector never becomes visible within the timeout', async () => {
        const p = fakePage({ evaluate: jest.fn().mockResolvedValue(false) });
        await expect(runStep(p, { action: 'assertVisible', selector: '.cart-badge', timeout: 300 }, 3)).rejects.toThrow(
            /step\[3\] assertVisible \(\.cart-badge\) failed: selector was not visible within 300ms/,
        );
    });

    test('succeeds if the selector becomes visible partway through polling', async () => {
        let calls = 0;
        const p = fakePage({
            evaluate: jest.fn().mockImplementation(async () => {
                calls += 1;
                return calls >= 3;
            }),
        });
        await expect(runStep(p, { action: 'assertVisible', selector: '.cart-badge', timeout: 5000 }, 0)).resolves.toBeUndefined();
        expect(calls).toBeGreaterThanOrEqual(3);
    });
});

describe('runStep — unknown action', () => {
    test('throws a descriptive error rather than silently doing nothing', async () => {
        const p = fakePage();
        await expect(runStep(p, { action: 'hover', selector: '.x' } as any, 0)).rejects.toThrow(
            /step\[0\] hover \(\.x\) failed: unknown step action "hover"/,
        );
    });
});

describe('runSteps — sequencing', () => {
    test('executes steps in order', async () => {
        const order: string[] = [];
        const p = fakePage({
            waitForSelector: jest.fn().mockImplementation(async (sel: string) => {
                order.push(`wait:${sel}`);
            }),
            click: jest.fn().mockImplementation(async (sel: string) => {
                order.push(`click:${sel}`);
            }),
            type: jest.fn().mockImplementation(async (sel: string) => {
                order.push(`type:${sel}`);
            }),
        });

        await runSteps(p, [
            { action: 'click', selector: '.open-search' },
            { action: 'type', selector: '#search', value: 'puppy' },
            { action: 'waitForSelector', selector: '.results' },
        ]);

        expect(order).toEqual(['wait:.open-search', 'click:.open-search', 'wait:#search', 'type:#search', 'wait:.results']);
    });

    test('stops at the first failing step and does not execute later steps (the write-path failure case)', async () => {
        // The real scenario this guards: "Add to Cart" click fails (button
        // never becomes clickable, e.g. because a backend call to price the
        // cart failed and the button stays disabled) — the canary must
        // report exactly that failure, not proceed as if nothing happened.
        const executed: string[] = [];
        const p = fakePage({
            waitForSelector: jest
                .fn()
                .mockResolvedValueOnce(undefined) // first step's wait succeeds
                .mockRejectedValueOnce(new Error('timeout')), // second step's wait fails
            click: jest.fn().mockImplementation(async () => {
                executed.push('click');
            }),
        });

        await expect(
            runSteps(p, [
                { action: 'click', selector: '.add-to-cart-btn' },
                { action: 'click', selector: '.checkout-btn' }, // never reached successfully
                { action: 'waitForSelector', selector: '.order-confirmation' }, // never reached at all
            ]),
        ).rejects.toThrow(/step\[1\] click \(\.checkout-btn\) failed/);

        expect(executed).toEqual(['click']); // only the first click ran
        expect(p.waitForSelector).toHaveBeenCalledTimes(2); // stopped before the third step
    });
});
