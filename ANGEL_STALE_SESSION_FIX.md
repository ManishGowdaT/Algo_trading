# Angel One stale session recovery

## Root cause

BrokerAccount.status survives a Node restart, while activeAccountService stores
verified sessions in memory. Status correctly reports disconnected without that
session, but setup replacement rejected the durable CONNECTED value alone.

## Plan and implementation

1. Permit same-account setup recovery when there is no runtime session.
2. Retain ownership, disabled/connecting account, strategy, position and unresolved
   order checks. Keep connection locking, generation reservation and provider
   identity verification before saving credentials.
3. Reproduce the restart in the HTTP regression test; check exposure rejection,
   rejected MPIN preserving saved setup, successful recovery, and active-session
   replacement rejection.

No database cleanup or credential deletion is needed. Deploy the updated Node
backend, then retry connection. An actually active session still requires an
explicit disconnect. Tests use synthetic accounts and a mocked broker.
