/*
Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
SPDX-License-Identifier: Apache-2.0
*/

/**
 * Lambda function construct base.
 *
 * Provides an abstract base class for creating Lambda functions with
 * consistent configuration and best practices for observability, security,
 * and performance (DLQ, X-Ray tracing, structured log group, least-privilege
 * IAM role scaffolding).
 *
 * @packageDocumentation
 */

import { Runtime, Function, ILayerVersion, Architecture, Tracing } from 'aws-cdk-lib/aws-lambda';
import { BundlingOptions, NodejsFunction } from 'aws-cdk-lib/aws-lambda-nodejs';
import { LogGroup, RetentionDays } from 'aws-cdk-lib/aws-logs';
import { Rule, Schedule } from 'aws-cdk-lib/aws-events';
import { LambdaFunction } from 'aws-cdk-lib/aws-events-targets';
import { Construct } from 'constructs';
import { IVpc, ISecurityGroup, SubnetSelection } from 'aws-cdk-lib/aws-ec2';
import { ManagedPolicy, Role, ServicePrincipal } from 'aws-cdk-lib/aws-iam';
import { Queue } from 'aws-cdk-lib/aws-sqs';
import { Duration, RemovalPolicy } from 'aws-cdk-lib';

/** Returns the ADOT OpenTelemetry Node.js Lambda layer ARN for the given region. */
export function getOpenTelemetryNodeJSLayerArn(region: string): string {
    const layerMappings: Record<string, { account: string; version: string }> = {
        'us-east-1': { account: '615299751070', version: '8' },
        'us-east-2': { account: '615299751070', version: '8' },
        'us-west-1': { account: '615299751070', version: '8' },
        'us-west-2': { account: '615299751070', version: '8' },
        'af-south-1': { account: '904233096616', version: '8' },
        'ap-east-1': { account: '888577020596', version: '8' },
        'ap-south-2': { account: '796973505492', version: '6' },
        'ap-southeast-3': { account: '039612877180', version: '8' },
        'ap-southeast-4': { account: '713881805771', version: '8' },
        'ap-southeast-5': { account: '152034782359', version: '1' },
        'ap-southeast-7': { account: '980416031188', version: '1' },
        'ap-south-1': { account: '615299751070', version: '8' },
        'ap-northeast-3': { account: '615299751070', version: '8' },
        'ap-northeast-2': { account: '615299751070', version: '8' },
        'ap-southeast-1': { account: '615299751070', version: '8' },
        'ap-southeast-2': { account: '615299751070', version: '8' },
        'ap-northeast-1': { account: '615299751070', version: '8' },
        'ca-central-1': { account: '615299751070', version: '8' },
        'ca-west-1': { account: '595944127152', version: '1' },
        'eu-central-1': { account: '615299751070', version: '8' },
        'eu-west-1': { account: '615299751070', version: '8' },
        'eu-west-2': { account: '615299751070', version: '8' },
        'eu-south-1': { account: '257394471194', version: '8' },
        'eu-west-3': { account: '615299751070', version: '8' },
        'eu-south-2': { account: '490004653786', version: '8' },
        'eu-north-1': { account: '615299751070', version: '8' },
        'eu-central-2': { account: '156041407956', version: '8' },
        'il-central-1': { account: '746669239226', version: '8' },
        'me-south-1': { account: '980921751758', version: '8' },
        'me-central-1': { account: '739275441131', version: '8' },
        'sa-east-1': { account: '615299751070', version: '8' },
        'mx-central-1': { account: '610118373846', version: '1' },
    };

    const mapping = layerMappings[region];
    if (!mapping) {
        throw new Error(`OpenTelemetry NodeJS layer not available in region: ${region}`);
    }

    return `arn:aws:lambda:${region}:${mapping.account}:layer:AWSOpenTelemetryDistroJs:${mapping.version}`;
}

/**
 * Gets the Lambda Insights layer ARN for the specified region.
 * @param region - AWS region
 * @returns Complete ARN for the Lambda Insights layer
 */
export function getLambdaInsightsLayerArn(region: string): string {
    const layerMappings: Record<string, { account: string; version: string; partition?: string }> = {
        'us-east-1': { account: '580247275435', version: '56' },
        'us-east-2': { account: '580247275435', version: '56' },
        'us-west-1': { account: '580247275435', version: '56' },
        'us-west-2': { account: '580247275435', version: '56' },
        'af-south-1': { account: '012438385374', version: '47' },
        'ap-southeast-7': { account: '761018874580', version: '3' },
        'ap-east-1': { account: '519774774795', version: '47' },
        'ap-south-2': { account: '891564319516', version: '29' },
        'ap-southeast-3': { account: '439286490199', version: '33' },
        'ap-southeast-5': { account: '590183865173', version: '4' },
        'ap-southeast-4': { account: '158895979263', version: '24' },
        'ap-south-1': { account: '580247275435', version: '54' },
        'ap-northeast-3': { account: '194566237122', version: '37' },
        'ap-northeast-2': { account: '580247275435', version: '55' },
        'ap-southeast-1': { account: '580247275435', version: '56' },
        'ap-southeast-2': { account: '580247275435', version: '56' },
        'ap-northeast-1': { account: '580247275435', version: '83' },
        'ca-central-1': { account: '580247275435', version: '55' },
        'ca-west-1': { account: '946466191631', version: '16' },
        'cn-north-1': { account: '488211338238', version: '46', partition: 'aws-cn' },
        'cn-northwest-1': { account: '488211338238', version: '46', partition: 'aws-cn' },
        'eu-central-1': { account: '580247275435', version: '56' },
        'eu-west-1': { account: '580247275435', version: '56' },
        'eu-west-2': { account: '580247275435', version: '56' },
        'eu-south-1': { account: '339249233099', version: '47' },
        'eu-west-3': { account: '580247275435', version: '55' },
        'eu-south-2': { account: '352183217350', version: '31' },
        'eu-north-1': { account: '580247275435', version: '53' },
        'eu-central-2': { account: '033019950311', version: '30' },
        'il-central-1': { account: '459530977127', version: '23' },
        'mx-central-1': { account: '879381266642', version: '3' },
        'me-south-1': { account: '285320876703', version: '47' },
        'me-central-1': { account: '732604637566', version: '30' },
        'sa-east-1': { account: '580247275435', version: '55' },
        'us-gov-east-1': { account: '122132214140', version: '24', partition: 'aws-us-gov' },
        'us-gov-west-1': { account: '751350123760', version: '24', partition: 'aws-us-gov' },
    };

    const mapping = layerMappings[region];
    if (!mapping) {
        throw new Error(`Lambda Insights layer not available in region: ${region}`);
    }

    const partition = mapping.partition || 'aws';
    return `arn:${partition}:lambda:${region}:${mapping.account}:layer:LambdaInsightsExtension:${mapping.version}`;
}

/**
 * Properties for configuring a base Lambda function.
 */
export interface BaseLambdaFunctionProperties {
    /** Unique name for the Lambda function */
    name: string;
    /** Runtime environment for the function */
    runtime: Runtime;
    /** Path to the dependencies lock file (for Node.js functions) */
    depsLockFilePath?: string;
    /** Entry point file for the function code */
    entry: string;
    /** Memory allocation for the function in MB */
    memorySize: number;
    /** Handler method name within the entry file */
    handler?: string;
    /** Log retention period for CloudWatch logs */
    logRetentionDays?: RetentionDays;
    /** Description of the function's purpose */
    description?: string;
    /**
     * The schedule expression for a periodic invocation
     * @default 'rate(5 minute)'
     */
    scheduleExpression?: string;
    /**
     * Whether to enable the EventBridge schedule
     * @default false
     */
    enableSchedule?: boolean;
    /** Lambda Timeout */
    timeout?: Duration;
    /** VPC for the Lambda function */
    vpc?: IVpc;
    /** VPC subnets for the Lambda function */
    vpcSubnets?: SubnetSelection;
    /** Security groups for the Lambda function */
    securityGroups?: ISecurityGroup[];
}

/**
 * Abstract base class for Lambda functions used by this project.
 *
 * Provides a common foundation for creating Lambda functions with
 * consistent configuration, observability features, and security
 * best practices. Concrete implementations must provide specific
 * permissions, environment variables, and bundling configurations.
 */
export abstract class BaseLambdaFunction extends Construct {
    /** The Lambda function instance */
    public function: Function;

    /**
     * Creates a new Lambda function.
     *
     * @param scope - The parent construct
     * @param id - The construct identifier
     * @param properties - Configuration properties for the function
     * @throws Error if the runtime is not supported
     */
    constructor(scope: Construct, id: string, properties: BaseLambdaFunctionProperties) {
        super(scope, id);

        const logGroup = new LogGroup(this, 'LogGroup', {
            retention: properties.logRetentionDays ?? RetentionDays.ONE_DAY,
            removalPolicy: RemovalPolicy.DESTROY,
        });

        const role = this.createLambdaRole(properties);

        if (!properties.runtime.name.startsWith('nodejs')) {
            throw new Error(`Runtime ${properties.runtime.name} not supported (this project only builds Node.js Lambdas)`);
        }
        if (!properties.handler) {
            throw new Error('Handler must be specified for Node.js functions');
        }

        this.function = new NodejsFunction(this, `${properties.name}-function`, {
            functionName: properties.name,
            runtime: properties.runtime,
            architecture: Architecture.X86_64,
            depsLockFilePath: properties.depsLockFilePath,
            entry: properties.entry,
            handler: properties.handler,
            memorySize: properties.memorySize,
            logGroup: logGroup,
            layers: this.getLayers(properties),
            environment: this.getEnvironmentVariables(properties),
            bundling: this.getBundling(properties),
            deadLetterQueueEnabled: true,
            deadLetterQueue: new Queue(this, 'DeadLetterQueue', {
                queueName: `${properties.name}-dlq`,
                enforceSSL: true,
            }),
            timeout: properties.timeout || Duration.seconds(30),
            role: role,
            vpc: properties.vpc,
            vpcSubnets: properties.vpcSubnets,
            securityGroups: properties.securityGroups,
            tracing: Tracing.ACTIVE,
        });

        if (properties.enableSchedule && properties.scheduleExpression) {
            this.scheduleFunction(properties.scheduleExpression);
        }

        this.addFunctionPermissions(properties);
    }

    /**
     * Creates IAM role for Lambda function with VPC permissions if needed
     */
    private createLambdaRole(properties: BaseLambdaFunctionProperties): Role {
        const managedPolicies = ['service-role/AWSLambdaBasicExecutionRole'];

        // Add VPC execution role if VPC is specified
        if (properties.vpc) {
            managedPolicies.push('service-role/AWSLambdaVPCAccessExecutionRole');
        }

        return new Role(this, 'LambdaRole', {
            assumedBy: new ServicePrincipal('lambda.amazonaws.com'),
            description: `Role for ${properties.name} Lambda function`,
            managedPolicies: managedPolicies.map((policy) => ManagedPolicy.fromAwsManagedPolicyName(policy)),
        });
    }

    /**
     * Use EventBridge to schedule the function execution using the specified
     * schedule expression.
     * @param scheduleExpression
     */
    scheduleFunction(scheduleExpression: string) {
        const rule = new Rule(this, 'ScheduleRule', {
            schedule: Schedule.expression(scheduleExpression),
        });

        rule.addTarget(new LambdaFunction(this.function));
    }

    /**
     * Adds IAM permissions required by the Lambda function.
     * Must be implemented by concrete subclasses.
     *
     * @param properties - Function configuration properties
     */
    abstract addFunctionPermissions(properties: BaseLambdaFunctionProperties): void;

    /**
     * Creates CloudFormation outputs for the Lambda function.
     * Must be implemented by concrete subclasses.
     *
     * @param properties - Function configuration properties
     */
    abstract createOutputs(properties: BaseLambdaFunctionProperties): void;

    /**
     * Returns environment variables for the Lambda function.
     * Must be implemented by concrete subclasses.
     *
     * @param properties - Function configuration properties
     * @returns Map of environment variable names to values
     */
    abstract getEnvironmentVariables(properties: BaseLambdaFunctionProperties): { [key: string]: string } | undefined;

    /**
     * Returns Lambda layers to be attached to the function.
     * Must be implemented by concrete subclasses.
     *
     * @param properties - Function configuration properties
     * @returns Array of Lambda layer versions
     */
    abstract getLayers(properties: BaseLambdaFunctionProperties): ILayerVersion[];

    /**
     * Returns bundling options for the Lambda function code.
     * Must be implemented by concrete subclasses.
     *
     * @param properties - Function configuration properties
     * @returns Bundling configuration options
     */
    abstract getBundling(properties: BaseLambdaFunctionProperties): BundlingOptions;
}
