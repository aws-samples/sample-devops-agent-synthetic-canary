/*
Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
SPDX-License-Identifier: Apache-2.0
*/

/**
 * Investigation deduplication table.
 *
 * A small DynamoDB table used by the webhook Lambda to deduplicate
 * in-progress investigations: partition key `canaryName`, with a TTL on
 * `expiresAt` that self-cleans expired locks (default 15-minute dedup
 * window, configurable by the webhook Lambda's `dedupTtlSeconds` property).
 *
 * @packageDocumentation
 */
import { CfnOutput, RemovalPolicy } from 'aws-cdk-lib';
import { AttributeType, Table } from 'aws-cdk-lib/aws-dynamodb';
import { Construct } from 'constructs';
import { NagSuppressions } from 'cdk-nag';

/** Properties for the investigation locks table. */
export interface InvestigationLocksTableProperties {
    /**
     * Optional CloudFormation export name prefix for the table ARN/name
     * outputs, useful for cross-stack references. If omitted, no exports
     * are created.
     */
    exportNamePrefix?: string;
}

/** DynamoDB table used to deduplicate in-progress investigations. */
export class InvestigationLocksTable extends Construct {
    public readonly table: Table;

    constructor(scope: Construct, id: string, properties: InvestigationLocksTableProperties = {}) {
        super(scope, id);

        this.table = new Table(this, 'Table', {
            partitionKey: {
                name: 'canaryName',
                type: AttributeType.STRING,
            },
            timeToLiveAttribute: 'expiresAt',
            removalPolicy: RemovalPolicy.DESTROY,
        });

        NagSuppressions.addResourceSuppressions(
            this.table,
            [
                {
                    id: 'AwsSolutions-DDB3',
                    reason: 'Point-in-time Recovery not required for this table',
                },
            ],
            true,
        );

        if (properties.exportNamePrefix) {
            new CfnOutput(this, 'TableArn', {
                value: this.table.tableArn,
                exportName: `${properties.exportNamePrefix}-Arn`,
                description: 'ARN of the DynamoDB table for investigation deduplication',
            });

            new CfnOutput(this, 'TableName', {
                value: this.table.tableName,
                exportName: `${properties.exportNamePrefix}-Name`,
                description: 'Name of the DynamoDB table for investigation deduplication',
            });
        }
    }
}
