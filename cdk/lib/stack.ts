// CloudWatch Alarm が ALARM になったら Amazon Connect から携帯に電話をかける
//   Alarm → SNS → Lambda → StartOutboundVoiceContact → 着信（出ない運用。発信番号で気づく）
//   Connect インスタンス・米国番号・フローまで含めて CDK で作り、destroy で日額課金が止まるようにする
import { CfnOutput, Duration, Fn, RemovalPolicy, Stack, StackProps, Tags } from 'aws-cdk-lib'
import * as cloudwatch from 'aws-cdk-lib/aws-cloudwatch'
import * as cwActions from 'aws-cdk-lib/aws-cloudwatch-actions'
import * as connect from 'aws-cdk-lib/aws-connect'
import * as iam from 'aws-cdk-lib/aws-iam'
import * as lambda from 'aws-cdk-lib/aws-lambda'
import { NodejsFunction } from 'aws-cdk-lib/aws-lambda-nodejs'
import * as logs from 'aws-cdk-lib/aws-logs'
import * as sns from 'aws-cdk-lib/aws-sns'
import * as subs from 'aws-cdk-lib/aws-sns-subscriptions'
import { Construct } from 'constructs'

const PROJECT = 'cloudwatch-alarm-amazon-connect-call'
// 検証用 Alarm のカスタムメトリクス（put-metric-data で ALARM / OK を切り替える）
const METRIC_NAMESPACE = 'CloudWatchAlarmConnectCall'
const METRIC_NAME = 'Trigger'

export class AlarmCallStack extends Stack {
  constructor(scope: Construct, id: string, props?: StackProps) {
    super(scope, id, props)

    Tags.of(this).add('Project', PROJECT)

    // 着信先（E.164、複数可）。cdk.json の context か -c destinations=+8190...,+8180... で渡す
    const ctx = this.node.tryGetContext('destinations')
    const destinations: string[] = Array.isArray(ctx) ? ctx : String(ctx ?? '').split(',').map((s) => s.trim()).filter(Boolean)
    // cdk.json のプレースホルダー（+8190XXXXXXXX）のまま deploy しないよう、E.164 の形式を確認する
    if (destinations.length === 0 || destinations.some((d) => !/^\+[1-9]\d{1,14}$/.test(d))) {
      throw new Error(`context "destinations" must be E.164 numbers (comma separated), e.g. -c destinations=+8190xxxxxxxx  got: ${destinations.join(',')}`)
    }

    // ---------- Amazon Connect ----------

    // インスタンスのエイリアスはグローバル一意なのでサフィックスを付ける
    // 上限 45 文字（PROJECT 名 + アカウント ID だと 49 文字で deploy が止まる）ので短縮名を使う
    const suffix = this.node.tryGetContext('bucket_suffix') ?? this.account
    const instance = new connect.CfnInstance(this, 'Instance', {
      instanceAlias: `cw-alarm-connect-call-${suffix}`,
      identityManagementType: 'CONNECT_MANAGED',
      // 受けないので着信は閉じる。発信だけ有効
      attributes: { inboundCalls: false, outboundCalls: true },
    })

    // 発信元の米国番号（ID 書類不要で取得できる）
    const phoneNumber = new connect.CfnPhoneNumber(this, 'PhoneNumber', {
      targetArn: instance.attrArn,
      countryCode: 'US',
      type: 'DID',
      description: `${PROJECT} outbound caller id`,
    })

    // フローは context "flow" で切り替える（既定 disconnect）
    //   disconnect: 切断だけ（出ない運用）
    //   probe:      約 45 秒の読み上げの後に切断（誰が応答したかの切り分け用）
    //   message:    アラート名と状態を 3 回読み上げて切断（留守電に残す。接続後 60 秒以内に収める）
    const flowMode = this.node.tryGetContext('flow') ?? 'disconnect'
    if (!['disconnect', 'probe', 'message'].includes(flowMode)) {
      throw new Error(`context "flow" must be disconnect | probe | message  got: ${flowMode}`)
    }
    const disconnectId = 'a0000000-0000-0000-0000-000000000001'
    const messageId = 'a0000000-0000-0000-0000-000000000002'
    const texts: Record<string, string> = {
      probe: Array.from({ length: 10 }, (_, i) => `This is a test call from Amazon Connect. Probe message ${i + 1}.`).join(' '),
      // 1 回目は留守電の応答メッセージ（約 11 秒）に重なって消えるので、同じ文を 3 回繰り返す
      message: Array.from({ length: 3 }, () =>
        'This is an automated call from Amazon CloudWatch. Alarm $.Attributes.AlarmName is now in state $.Attributes.NewStateValue. Please check the console.',
      ).join(' '),
    }
    const disconnect = { Identifier: disconnectId, Type: 'DisconnectParticipant', Transitions: {}, Parameters: {} }
    const message = {
      Identifier: messageId,
      Type: 'MessageParticipant',
      Parameters: { Text: texts[flowMode] },
      Transitions: { NextAction: disconnectId, Errors: [{ NextAction: disconnectId, ErrorType: 'NoMatchingError' }] },
    }
    const flow = new connect.CfnContactFlow(this, 'ContactFlow', {
      instanceArn: instance.attrArn,
      name: `${PROJECT}-disconnect`,
      type: 'CONTACT_FLOW',
      content: JSON.stringify({
        Version: '2019-10-30',
        StartAction: flowMode === 'disconnect' ? disconnectId : messageId,
        Actions: flowMode === 'disconnect' ? [disconnect] : [message, disconnect],
      }),
    })

    // ---------- SNS → Lambda ----------

    const topic = new sns.Topic(this, 'Topic', { topicName: PROJECT })

    const fn = new NodejsFunction(this, 'Notifier', {
      functionName: `${PROJECT}-notifier`,
      entry: 'lambda/index.ts',
      runtime: lambda.Runtime.NODEJS_22_X,
      timeout: Duration.seconds(30),
      logGroup: new logs.LogGroup(this, 'NotifierLogs', {
        logGroupName: `/aws/lambda/${PROJECT}-notifier`,
        retention: logs.RetentionDays.ONE_WEEK,
        removalPolicy: RemovalPolicy.DESTROY,
      }),
      environment: {
        INSTANCE_ID: instance.attrId,
        // フロー ID は ARN の「/contact-flow/」より後ろ。ARN はデプロイ時に決まるトークンなので Fn で切る（JS の split は効かない）
        CONTACT_FLOW_ID: Fn.select(1, Fn.split('/contact-flow/', flow.attrContactFlowArn)),
        SOURCE_PHONE_NUMBER: phoneNumber.attrAddress,
        DESTINATION_PHONE_NUMBERS: destinations.join(','),
      },
    })
    fn.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ['connect:StartOutboundVoiceContact'],
        resources: [`${instance.attrArn}/contact/*`],
      }),
    )
    topic.addSubscription(new subs.LambdaSubscription(fn))

    // ---------- 検証用 Alarm ----------

    const alarm = new cloudwatch.Alarm(this, 'Alarm', {
      alarmName: `${PROJECT}-test`,
      metric: new cloudwatch.Metric({
        namespace: METRIC_NAMESPACE,
        metricName: METRIC_NAME,
        statistic: 'Maximum',
        period: Duration.minutes(1),
      }),
      threshold: 1,
      comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
      evaluationPeriods: 1,
      // データが途切れたら OK に戻す（put を止めれば OK）
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
    })
    // ALARM のときだけ電話。OK 復帰で鳴ると区別できないので okAction は付けない
    alarm.addAlarmAction(new cwActions.SnsAction(topic))

    new CfnOutput(this, 'SourcePhoneNumber', { value: phoneNumber.attrAddress, description: '周知する発信番号' })
    new CfnOutput(this, 'Destinations', { value: destinations.join(',') })
    new CfnOutput(this, 'AlarmName', { value: alarm.alarmName })
    new CfnOutput(this, 'TopicArn', { value: topic.topicArn })
    new CfnOutput(this, 'ConnectInstanceId', { value: instance.attrId })
  }
}
