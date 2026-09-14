/*
Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
SPDX-License-Identifier: Apache-2.0
*/

/**
 * Browser (UX) Canary construct.
 *
 * A Puppeteer Synthetics canary that visits a home page plus a configurable
 * journey of additional pages. For each page it watches network responses
 * (>=400) and uncaught JS errors, and asserts that the page's real content
 * rendered (not just that the page shell/structural chrome loaded) —
 * catching failures that are rendered server-side as a normal 200 page with
 * an error message in place of real content, which no HTTP-status check
 * alone can detect. A secondary, non-authoritative generic error-indicator
 * check (Bootstrap's `.alert-danger` convention by default) adds
 * corroborating evidence without depending on any application-specific
 * error text. Independently deployable and separable from the routing path;
 * its failure drives an availability alarm.
 *
 * @packageDocumentation
 */
import { Construct } from 'constructs';
import { BaseCanary, BaseCanaryProperties } from '../constructs/canary';

/**
 * A single interaction step run against a journey page, after navigation and
 * before the (optional) content assertion. Lets a journey page exercise the
 * write/transactional path (e.g. "Add to Cart", form submit) rather than
 * only the read path (does the page render). The generic network/JS-error
 * listeners already span step execution, so a click-triggered backend
 * failure is caught by the same mechanism that catches load-time failures.
 *
 * Not supported: authentication/session flows (login forms, MFA, cookie
 * persistence across canary runs) — see the project README.
 */
export interface JourneyStep {
    /** The interaction to perform. */
    action: 'click' | 'type' | 'waitForSelector' | 'assertVisible';
    /** CSS selector the action targets. Required for all current actions. */
    selector: string;
    /** Text to type. Only used by the `type` action. */
    value?: string;
    /** Per-character typing delay in ms. Only used by the `type` action. */
    delay?: number;
    /** Step timeout in ms (default: 10000). */
    timeout?: number;
}

/** A single page to visit as part of the browser journey. */
export interface JourneyPage {
    /** Step name, used for logging and the executeStep label. */
    name: string;
    /** Path appended to the base URL, e.g. /some/page. */
    path: string;
    /**
     * CSS selector that must be present when the page is healthy. Optional
     * when {@link steps} ends in its own `assertVisible`/`waitForSelector`
     * step that already serves as the success signal.
     */
    contentSelector?: string;
    /** Optional selector marking a valid, non-error empty state (e.g. "No data available"). */
    emptyStateSelector?: string;
    /** Optional extra query-string fragment appended to the page URL. */
    extraQuery?: string;
    /**
     * Optional ordered sequence of interaction steps (click, type, wait,
     * assert) run after navigating to {@link path} and before the content
     * assertion. Use this to exercise write-path/transactional flows (add
     * to cart, submit a form) that a pure navigate-and-assert check cannot
     * observe.
     */
    steps?: JourneyStep[];
}

/** Properties for the UX (browser) canary. */
export interface UxCanaryProperties extends BaseCanaryProperties {
    /** Inline page URL (takes precedence over the SSM parameter). */
    targetUrl?: string;
    /** SSM parameter name holding the page URL. */
    targetUrlParameterName?: string;
    /** CSS selector of a key UI element to verify on the home page (default: body). */
    keySelector?: string;
    /** Soft page-load budget in ms (logged; default 10000). */
    maxLoadMs?: number;
    /** Optional userId (or similar) query parameter appended to journey page URLs. */
    userId?: string;
    /** Secondary generic error-indicator CSS selector (default: .alert-danger). */
    errorSelector?: string;
    /**
     * The user journey pages to visit, beyond the home page. Passed inline as
     * environment variable JSON. Prefer {@link journeyPagesParameterName} if
     * the definition is large or you want to update it without redeploying.
     */
    journeyPages?: JourneyPage[];
    /** SSM parameter name holding the journey pages definition as JSON. */
    journeyPagesParameterName?: string;
}

/** Browser-based canary for page-load/UI health. */
export class UxCanary extends BaseCanary {
    constructor(scope: Construct, id: string, properties: UxCanaryProperties) {
        super(scope, id, properties);
    }

    createOutputs(): void {}

    getEnvironmentVariables(properties: UxCanaryProperties): { [key: string]: string } | undefined {
        const env: { [key: string]: string } = {};
        if (properties.targetUrl) {
            env.L1T_UX_URL = properties.targetUrl;
        }
        if (properties.targetUrlParameterName) {
            env.L1T_UX_URL_PARAMETER_NAME = properties.targetUrlParameterName;
        }
        if (properties.keySelector) {
            env.L1T_UX_KEY_SELECTOR = properties.keySelector;
        }
        if (properties.userId) {
            env.L1T_UX_USER_ID = properties.userId;
        }
        if (properties.errorSelector) {
            env.L1T_UX_ERROR_SELECTOR = properties.errorSelector;
        }
        if (properties.journeyPages) {
            env.L1T_UX_JOURNEY_PAGES = JSON.stringify(properties.journeyPages);
        }
        if (properties.journeyPagesParameterName) {
            env.L1T_UX_JOURNEY_PAGES_PARAMETER_NAME = properties.journeyPagesParameterName;
        }
        env.L1T_UX_MAX_LOAD_MS = String(properties.maxLoadMs ?? 10000);
        return env;
    }
}
