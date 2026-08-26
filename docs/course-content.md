# Course Content

## Source of truth

The course outline is stored in PostgreSQL in `Practicum`, `Module`, `Lesson`, and `MediaAsset`.
The development bootstrap is idempotent:

```powershell
npm run api:bootstrap-course
```

It creates or updates the current Practicum 04 outline, keeps existing assignments, attaches the Vimeo recording to the Market Logic lesson, and creates module access records for active students.

## API

`GET /api/course` requires an active session.

- Students receive only modules available in their active enrollment. Locked modules keep their card metadata, but their lessons, media, and assignments are omitted.
- Curators and owners can inspect the full course structure.
- Vimeo assets are returned as player URLs generated on the server from the stored provider key.
- The API checks the enrollment and access status on every request; the client cannot unlock content by changing local state.

## Access model

`EnrollmentModuleAccess` stores the module state for a specific student enrollment:

- `LOCKED` — metadata only;
- `UNLOCKED` — lessons and attached materials are available;
- `COMPLETED` — available and completed by the student.

The curator access-management screen still needs to be moved from local preview state to the protected API. That is the next step before treating module unlocking as production-ready.
