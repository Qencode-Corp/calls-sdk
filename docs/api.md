# Qencode Calls API reference

Everything your backend needs. Apps never call these endpoints except the stats one, which
the SDK calls for you with the participant credential.

Base URL: `https://api.qencode.com`. Authentication for the project endpoints is a project
JWT from `POST /v1/access_token/{api_key}`, sent as `Authorization: Bearer <token>`.

| Endpoint | Auth | Purpose |
|---|---|---|
| `POST /v1/access_token/{api_key}` | none | Project JWT, valid 24 h |
| `POST /v1/calls` | project JWT | Create a call |
| `POST /v1/calls/{id}/tokens` | project JWT | Mint one participant credential |
| `GET /v1/calls/{id}` | project JWT | Status, participants, latest quality summary |
| `DELETE /v1/calls/{id}` | project JWT | End the call for everyone |
| `POST /v1/calls/{id}/stats` | participant credential | Quality samples; the SDK posts these every 5 s |
| webhooks to `callback_url` | signed by Qencode | Lifecycle events |

## Create a call

```http
POST /v1/calls
{"callback_url": "https://example.com/hooks/calls"}   // all fields optional
```

```json
{"call": {"id": "…", "room_name": "call-…", "status": "created",
          "signaling_url": "wss://…", "regions": [{"name": "eu-central", "url": "wss://…"}],
          "max_participants": 2, "created_at": "2026-09-08 12:00:00"}}
```

A call holds two humans. `DELETE` ends it; an empty call closes on its own after five minutes.

## Mint a credential

```http
POST /v1/calls/{id}/tokens
{"identity": "alice", "name": "Alice", "role": "A", "can_publish": true, "ttl": 600}
```

`identity` is required, 1 to 64 characters, unique within the call and opaque to Qencode.
`ttl` is 60 to 86400 seconds, default 600. Pass the response to your app **unchanged**; it is
the SDK's only input:

```json
{"token": "eyJ…", "url": "wss://…", "regions": [{"name": "eu-central", "url": "wss://…"}],
 "identity": "alice", "room_name": "call-…", "expires_at": "2026-09-08 12:10:00", "call_id": "…"}
```

A connected call outlives its credential; only a fresh `connect()` needs a valid one. The SDK
raises `credentialExpiring` two minutes ahead so your app can fetch a new one.

## Webhooks

Posted to the call's `callback_url` as JSON:

```json
{"type": "call_event", "data": {"call_id": "…", "event": "participant_joined",
 "room_name": "call-…", "participant": {"identity": "alice", "name": "Alice"}, "timestamp": "…"}}
```

Events: `room_started`, `participant_joined`, `participant_left`, `room_finished`.

## Stats

The SDK posts batches of quality snapshots with the participant credential. Fields include
round trip to the media node, jitter buffer, encode and decode times, frame rate, bitrate,
loss, freezes, transport (`udp`, `tcp`, `relay-udp`, `relay-tcp`), codec, region and node.
Nothing identifying the user is sent; the identity is your opaque string. Turn it off per
call with the `telemetry` option.

Three optional columns are reserved for an app's own measured glass-to-glass latency over its
window, in milliseconds: `g2g_p50`, `g2g_p95` and `g2g_samples`. The SDK fills them from the
`telemetryExtra` option when the app supplies them; any other app field is kept in `extra`.
