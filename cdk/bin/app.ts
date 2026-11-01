import { App } from 'aws-cdk-lib'
import { AlarmCallStack } from '../lib/stack'

const app = new App()
// Connect インスタンスは東京リージョンに作る（既定で日本へ発信できるリージョン）
new AlarmCallStack(app, 'CloudWatchAlarmAmazonConnectCall', {
  env: { account: process.env.CDK_DEFAULT_ACCOUNT, region: 'ap-northeast-1' },
})
