import {
    aws_ec2 as ec2,
    aws_iam as iam,
    aws_lambda as lambda,
    aws_lambda_event_sources as eventSource,
    aws_rds as rds,
    aws_sns as sns,
    aws_sqs as sqs,
    aws_ssm as ssm,
    custom_resources as custom,
    Duration
} from 'aws-cdk-lib';
import {Construct} from "constructs";
import * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager';
import {getLambdaCodePath} from './utils'
import {RetentionDays} from "aws-cdk-lib/aws-logs";

export class DataCollectionBuild extends Construct {
    dbWriterFnModuleName: string;
    public readonly databaseCredentialsSecret: secretsmanager.Secret;
    public readonly vpc:ec2.Vpc;
    public readonly usageDB: rds.DatabaseInstance;
    public readonly queue: sqs.Queue;

    constructor(scope: Construct, id: string, dbWriterFnModuleName: string) {
        super(scope, id);
        this.dbWriterFnModuleName = dbWriterFnModuleName;
        this.vpc = new ec2.Vpc(this, 'AuxiliaryComponentsVPC', {
            natGateways: 1,
            subnetConfiguration: [
                {
                    cidrMask: 24,
                    name: 'public',
                    subnetType: ec2.SubnetType.PUBLIC,
                },
                {
                    cidrMask: 24,
                    name: 'Private',
                    subnetType: ec2.SubnetType.PRIVATE_ISOLATED,
                },
            ],
        });

        this.databaseCredentialsSecret = new secretsmanager.Secret(this, 'UsageDBCredentialsSecret', {
            secretName: 'usage-db-credentials',
            generateSecretString: {
                secretStringTemplate: JSON.stringify({
                    username: 'postgres',
                }),
                excludePunctuation: true,
                includeSpace: false,
                generateStringKey: 'password'
            }
        });

        const ssm_key = new ssm.StringParameter(this, 'UsageDBCredentialsArn', {
            parameterName: 'usage-credentials-arn',
            stringValue: this.databaseCredentialsSecret.secretArn,
        });

        const dbSecGroup = new ec2.SecurityGroup(this, 'UsageDBSecGroup', {
            vpc: this.vpc,
            description: 'Security group for light usage db',
            allowAllOutbound: true,
        });
        dbSecGroup.addIngressRule(ec2.Peer.anyIpv4(), ec2.Port.tcp(54600))

        this.usageDB = new rds.DatabaseInstance(scope, 'lightUsageDB', {
            engine: rds.DatabaseInstanceEngine.POSTGRES,
            vpc: this.vpc,
            vpcSubnets: {subnetType: ec2.SubnetType.PRIVATE_ISOLATED},
            instanceType: ec2.InstanceType.of(
                ec2.InstanceClass.T4G,
                ec2.InstanceSize.MICRO,
            ),
            multiAz: false,
            allowMajorVersionUpgrade: true,
            backupRetention: Duration.days(2),
            securityGroups: [dbSecGroup],
            maxAllocatedStorage: 1,
            credentials: rds.Credentials.fromSecret(this.databaseCredentialsSecret)
        });

        this.queue = new sqs.Queue(this, 'LightBehaviorQueue')
        const notifies = new sns.Topic(this, 'dbFailNotifier')

        const dbWriterSecGrp = new ec2.SecurityGroup(this, 'DBWriterSecurityGroup', {
            vpc: this.vpc,
            allowAllOutbound: false,
        });
        const dbWriterFn = new lambda.DockerImageFunction(this, 'DBWriterFn', {
            description: 'Writes light trigger action and time to Postgres db',
            code: lambda.DockerImageCode.fromImageAsset(
                getLambdaCodePath(this.dbWriterFnModuleName)
            ),
            environment: {
                'DB_CREDENTIALS': ssm_key.parameterName,
                'WRITE_QUEUE_URL': this.queue.queueName,
            },
            architecture: lambda.Architecture.ARM_64,
            vpc: this.vpc,
            vpcSubnets: this.vpc.selectSubnets({
                subnetType: ec2.SubnetType.PRIVATE_ISOLATED,
            }),
            securityGroups: [dbWriterSecGrp],
            },
        );

        dbWriterFn.addToRolePolicy(new iam.PolicyStatement({
            actions:['sqs:ReceiveMessage', 'sqs:DeleteMessage', 'sqs:GetQueueUrl'],
            resources:[this.queue.queueArn,]
        }));

        const sqsInvoke = new eventSource.SqsEventSource(this.queue);
        dbWriterFn.addEventSource(sqsInvoke);

        dbWriterFn.addToRolePolicy(new iam.PolicyStatement({
            actions: ['ssm:GetParameter',],
            resources: [ssm_key.parameterArn,]
        }));

        const dbInitializerFn = new lambda.DockerImageFunction(this, 'DBInitializerFn', {
            description: 'Creates table in db upon deployment then self deletes',
            code: lambda.DockerImageCode.fromImageAsset(
                getLambdaCodePath('dbInitializerFn')
            ),
            environment: {'DB_CREDENTIALS': ssm_key.parameterName},
            architecture: lambda.Architecture.ARM_64,
            vpc: this.vpc,
            vpcSubnets: this.vpc.selectSubnets({
                subnetType: ec2.SubnetType.PRIVATE_ISOLATED,
            }),
            securityGroups: [dbWriterSecGrp],
            role: dbWriterFn.role // should probably give the function its own role
        });

        const provider = new custom.Provider(this, 'CustomeResourceProvider-Initializer', {
            onEventHandler: dbInitializerFn,
            logRetention: RetentionDays.ONE_DAY
        });
        new custom.AwsCustomResource(this, 'CustomResource-Initializer', {
            onCreate: {
                service: dbInitializerFn.functionName,
                action: 'InvokeFunction',
                physicalResourceId: {
                    id: 'invocation upon creation'
                }
            },
            role: dbWriterFn.role
        })
    }
}