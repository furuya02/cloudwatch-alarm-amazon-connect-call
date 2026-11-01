#!/bin/bash
# 直近の発信を一覧し、接続後の秒数（通話料の対象）が 60 秒以内かを確認する
# usage: scripts/contacts.sh [days]   既定 7 日
set -eu
DAYS=${1:-7}
REGION=ap-northeast-1
STACK=CloudWatchAlarmAmazonConnectCall
INSTANCE_ID=$(aws cloudformation describe-stacks --region $REGION --stack-name $STACK \
  --query 'Stacks[0].Outputs[?OutputKey==`ConnectInstanceId`].OutputValue' --output text)
START=$(date -u -v-${DAYS}d '+%Y-%m-%dT%H:%M:%SZ' 2>/dev/null || date -u -d "$DAYS days ago" '+%Y-%m-%dT%H:%M:%SZ')
END=$(date -u '+%Y-%m-%dT%H:%M:%SZ')

IDS=$(aws connect search-contacts --region $REGION --instance-id "$INSTANCE_ID" \
  --time-range "{\"Type\":\"INITIATION_TIMESTAMP\",\"StartTime\":\"$START\",\"EndTime\":\"$END\"}" \
  --sort '{"FieldName":"INITIATION_TIMESTAMP","Order":"ASCENDING"}' \
  --query 'Contacts[].Id' --output text)

printf '%-20s %-12s %-12s %6s %6s  %s\n' INITIATED CONNECTED DISCONNECTED RING TALK REASON
for ID in $IDS; do
  aws connect describe-contact --region $REGION --instance-id "$INSTANCE_ID" --contact-id "$ID" \
    --query 'Contact.[InitiationTimestamp,ConnectedToSystemTimestamp,DisconnectTimestamp,DisconnectReason]' --output json
done | python3 -c '
import sys, json, re
from datetime import datetime
dash = "-"
def ts(s):
    return datetime.fromisoformat(s) if s else None
for init, conn, disc, reason in (json.loads(x) for x in re.findall(r"\[.*?\]", sys.stdin.read(), re.S)):
    i, c, d = ts(init), ts(conn), ts(disc)
    if not c:
        print(f"{i:%Y-%m-%d %H:%M:%S} {dash:<12} {d:%H:%M:%S} {dash:>6} {0:>6}  {reason} (not answered)")
        continue
    ring, talk = (c - i).total_seconds(), (d - c).total_seconds()
    mark = " <- over 60s (2 min billed)" if talk > 60 else ""
    print(f"{i:%Y-%m-%d %H:%M:%S} {c:%H:%M:%S}     {d:%H:%M:%S}     {ring:6.0f} {talk:6.0f}  {reason}{mark}")
'
