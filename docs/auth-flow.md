# Authentication Flow

## Roles

- `OWNER` is an internal platform role. It creates invitations, sees security data for all students, revokes sessions, and can suspend an account.
- `CURATOR` works with assigned students. A curator can see login history only for students linked through `CuratorAssignment`.
- `STUDENT` can access only the practicum and media granted to the account.

The owner role is not shown as an education role in the student interface.

## Invitation

1. The owner or curator creates an invitation with a role, practicum, expiry, and the intended participant's numeric Discord user ID.
   The ID is copied from Discord's developer mode; a display name or username is not accepted.
2. The service stores only a SHA-256 hash of the random token.
3. The raw token is returned once to the server-side caller so it can be sent to the intended person.
4. Discord OAuth must produce the provider subject on the server. A browser-supplied Discord ID is not trusted.
5. The invitation is accepted only when it is pending, unexpired, and the server-side Discord subject exactly matches the ID saved on the invitation.
6. The invitation is marked accepted in a serializable transaction and cannot be used again.

## Discord OAuth

1. The browser starts the flow through the API. The API creates a short-lived challenge, stores only hashes and encrypted values, and sets an HttpOnly state cookie.
2. Discord receives only the requested `identify` scope and returns an authorization code to the configured callback.
3. The API validates the state cookie, consumes the challenge once, exchanges the code server-side, and reads the Discord user identity through the Discord API.
4. The browser never receives the Discord client secret or the provider access token. A user without an existing identity must also present a valid invitation.

## Sessions and devices

- The session token and device token are random opaque values stored in HttpOnly cookies.
- Only hashes are stored in PostgreSQL.
- A student may have two distinct active device keys.
- A third distinct device is stored as `PENDING` for 15 minutes and receives no protected access until the owner or assigned curator approves it. The approver can reject it instead; existing work and history are never deleted.
- IP, User-Agent, approximate location, device name, and timestamps are risk signals, not proof of identity.

## Security signals

- The owner can see the login time, IP address, User-Agent, device name, approximate region, and city when available from the trusted server-side request context.
- A different city, home network, or browser creates a visible risk signal but does not automatically prove account sharing and should not silently block a legitimate student.
- The invitation token is a one-time bearer credential: it remains pending until activation, expires or can be revoked, and is consumed in the same transaction that binds the Discord identity.

## Owner bootstrap

There is no public owner registration. The first owner is created by a controlled deployment/bootstrap command after the Discord identity has been verified manually. The command must be disabled or protected after the first owner exists.
## Device approval policy

The first two distinct device keys for a student may create active sessions. A
new third device never receives protected access immediately: its short-lived
session is stored as `PENDING`, the OAuth callback redirects to
`?auth=device-pending`, and the browser cannot call protected endpoints.

An owner or the curator assigned to that student can approve the pending device
from the student's security details. Approval is rejected if two other active
devices still exist; revoke one first. Rejecting/revoking a pending or active
session is auditable and does not delete the student's work or history.
