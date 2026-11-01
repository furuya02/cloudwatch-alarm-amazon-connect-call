#!/bin/bash
# Alarm の状態と直近の Lambda ログを表示する（着信までの遅延を計るため）
set -eu
PROJECT=cloudwatch-alarm-amazon-connect-call
aws cloudwatch describe-alarms --region ap-northeast-1 --alarm-names "$PROJECT-test" \
  --query 'MetricAlarms[0].[StateValue,StateUpdatedTimestamp]' --output text
aws logs tail "/aws/lambda/$PROJECT-notifier" --region ap-northeast-1 --since 15m --format short
