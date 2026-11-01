// SNS 経由で CloudWatch Alarm の通知を受け、ALARM のときだけ全員に同時に電話をかける
import { ConnectClient, StartOutboundVoiceContactCommand } from '@aws-sdk/client-connect'
import type { SNSEvent } from 'aws-lambda'

const connect = new ConnectClient({})
const { INSTANCE_ID, CONTACT_FLOW_ID, SOURCE_PHONE_NUMBER, DESTINATION_PHONE_NUMBERS } = process.env

export const handler = async (event: SNSEvent) => {
  for (const record of event.Records) {
    const msg = JSON.parse(record.Sns.Message)
    console.log(JSON.stringify({ alarm: msg.AlarmName, state: msg.NewStateValue, time: msg.StateChangeTime }))
    if (msg.NewStateValue !== 'ALARM') continue

    const destinations = DESTINATION_PHONE_NUMBERS!.split(',')
    const results = await Promise.allSettled(
      destinations.map((destination) =>
        connect.send(
          new StartOutboundVoiceContactCommand({
            InstanceId: INSTANCE_ID,
            ContactFlowId: CONTACT_FLOW_ID,
            SourcePhoneNumber: SOURCE_PHONE_NUMBER,
            DestinationPhoneNumber: destination,
            // 出ない運用では使わないが、フローを育てるときのために Alarm 名と状態は渡しておく
            Attributes: { AlarmName: msg.AlarmName, NewStateValue: msg.NewStateValue },
          }),
        ),
      ),
    )
    results.forEach((r, i) =>
      console.log(
        JSON.stringify(
          r.status === 'fulfilled'
            ? { destination: destinations[i], contactId: r.value.ContactId }
            : { destination: destinations[i], error: String(r.reason) },
        ),
      ),
    )
  }
}
