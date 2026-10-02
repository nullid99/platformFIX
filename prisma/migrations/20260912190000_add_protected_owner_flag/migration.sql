-- An owner flagged here can never have the OWNER role revoked through the app (by anyone,
-- including another owner) — reserved for the platform's actual owner once that person is
-- finally promoted. Nobody has this flag yet. See auth-service.ts#revokeOwnerRole.
ALTER TABLE "User" ADD COLUMN "isProtectedOwner" BOOLEAN NOT NULL DEFAULT false;
