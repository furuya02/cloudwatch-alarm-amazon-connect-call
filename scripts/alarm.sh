#!/bin/bash
# 検証用メトリクスを送って Alarm を ALARM にする（OK に戻すには put を止めて 1〜2 分待つ）
# usage: scripts/alarm.sh [value]   既定 1（閾値以上で ALARM）
set -eu
VALUE=${1:-1}
aws cloudwatch put-metric-data --region ap-northeast-1 \
  --namespace CloudWatchAlarmConnectCall --metric-name Trigger --value "$VALUE"
echo "$(date '+%Y-%m-%d %H:%M:%S') put value=$VALUE"
