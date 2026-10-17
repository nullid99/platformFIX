import { Prisma } from "@/app/generated/prisma/client";
import {
  EnrollmentStatus,
  IdentityProvider,
  InvitationStatus,
  LoginEventOutcome,
  NotificationType,
  SessionStatus,
  UserRole,
  UserStatus,
} from "@/app/generated/prisma/enums";
import { prisma } from "@/app/server/db";
import { seedOpenModuleAccess } from "@/app/server/course/module-access";
import { createOpaqueToken, hashOpaqueToken, isOpaqueToken } from "./crypto";
import { hasReachedDeviceLimit } from "./device-policy";
import { enrichAuthRequestContext, normalizeAuthRequestContext } from "./geoip";
import { isDiscordUserId } from "@/app/domain/discord";
import { sendEmailVerificationNotification, sendInvitationNotification } from "@/app/server/notifications/email-service";
import { getActivePracticumId, getWorkingPracticumId } from "@/app/server/course/practicum-service";
import type {
  AcceptInvitationInput,
  AuthRequestContext,
  CreateInvitationInput,
  CreateSessionInput,
  InvitationCredentials,
  LoginWithIdentityInput,
  SessionCredentials,
  StudentDirectoryRecord,
  StudentSecurityOverview,
  TeamMemberDirectoryRecord,
} from "./types";

type DatabaseClient = typeof prisma | Prisma.TransactionClient;

const DEFAULT_INVITATION_HOURS = 7 * 24;
const MAX_INVITATION_HOURS = 30 * 24;
const SESSION_LIFETIME_DAYS = 30;
const PENDING_SESSION_LIFETIME_MINUTES = 15;
const MAX_DEVICES = 2;

/**
 * Local role switching (dev-login) — local development and CI only, never a production build.
 * There used to be a STAGING_DEV_AUTH_ENABLED override; "staging" turned out to be the live site
 * (fix-trading.info), so anyone could log in as the test curator (security review STG-11, 2026-10-17).
 */
export function isLocalTestAuthEnabled(): boolean {
  return process.env.DEV_AUTH_ENABLED === "true" && process.env.NODE_ENV !== "production";
}

export type AuthErrorCode =
  | "FORBIDDEN"
  | "INVALID_INVITATION"
  | "INVITATION_EXPIRED"
  | "INVITATION_BOUND_TO_ANOTHER_ACCOUNT"
  | "ACCOUNT_SUSPENDED"
  | "ROLE_CONFLICT"
  | "SESSION_INVALID"
  | "INVALID_INPUT"
  | "DISCORD_AUTH_FAILED"
  | "AUTH_CONFLICT";

export class AuthServiceError extends Error {
  constructor(
    public readonly code: AuthErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "AuthServiceError";
  }
}

function requireNonEmpty(value: string | undefined, field: string): string {
  const normalized = value?.trim();
  if (!normalized || normalized.length > 200) {
    throw new AuthServiceError("INVALID_INPUT", `${field} is invalid`);
  }

  return normalized;
}

function optionalText(value: string | undefined, maximumLength: number): string | undefined {
  const normalized = value?.trim();
  if (!normalized) return undefined;
  return normalized.slice(0, maximumLength);
}

function optionalEmail(value: string | undefined): string | undefined {
  const normalized = optionalText(value, 320)?.toLowerCase();
  if (!normalized) return undefined;
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalized)) {
    throw new AuthServiceError("INVALID_INPUT", "email is invalid");
  }
  return normalized;
}

function getInvitationExpiry(expiresInHours: number | undefined, now: Date): Date {
  const hours = expiresInHours ?? DEFAULT_INVITATION_HOURS;
  if (!Number.isInteger(hours) || hours < 1 || hours > MAX_INVITATION_HOURS) {
    throw new AuthServiceError("INVALID_INPUT", "Invitation expiry is invalid");
  }

  return new Date(now.getTime() + hours * 60 * 60 * 1000);
}

function getSessionExpiry(now: Date): Date {
  return new Date(now.getTime() + SESSION_LIFETIME_DAYS * 24 * 60 * 60 * 1000);
}

function getPendingSessionExpiry(now: Date): Date {
  return new Date(now.getTime() + PENDING_SESSION_LIFETIME_MINUTES * 60 * 1000);
}

function assertInvitationToken(token: string): string {
  const normalized = token.trim();
  if (!isOpaqueToken(normalized, "invite")) {
    throw new AuthServiceError("INVALID_INVITATION", "Invitation is invalid");
  }

  return normalized;
}

function assertSessionToken(token: string): string {
  const normalized = token.trim();
  if (!isOpaqueToken(normalized, "session")) {
    throw new AuthServiceError("SESSION_INVALID", "Session is invalid");
  }

  return normalized;
}

export class AuthService {
  public async createInvitation(input: CreateInvitationInput): Promise<InvitationCredentials> {
    const requestContext = normalizeAuthRequestContext(input);
    const actor = await prisma.user.findUnique({
      where: { id: input.actorId },
      select: { role: true, status: true },
    });

    if (!actor || (actor.role !== UserRole.OWNER && actor.role !== UserRole.CURATOR) || actor.status !== UserStatus.ACTIVE) {
      throw new AuthServiceError("FORBIDDEN", "Only an active owner or curator can create invitations");
    }

    if (input.targetProvider !== IdentityProvider.DISCORD) {
      throw new AuthServiceError("INVALID_INPUT", "Invitation must be bound to a Discord account");
    }

    const targetSubject = requireNonEmpty(input.targetSubject, "targetSubject");
    if (!isDiscordUserId(targetSubject)) {
      throw new AuthServiceError("INVALID_INPUT", "targetSubject must be a valid Discord user ID");
    }
    const email = optionalEmail(input.email);
    const now = new Date();
    const expiresAt = getInvitationExpiry(input.expiresInHours, now);
    const token = createOpaqueToken("invite");

    // Pinned to a concrete practicum at creation time — not resolved lazily when the invite is
    // accepted. Defaults to the inviting curator's own working practicum (see
    // practicum-service.ts#getWorkingPracticumId) when they didn't pick one explicitly in the UI.
    const practicum = await prisma.practicum.findUnique({
      where: { id: input.practicumId ?? (await getWorkingPracticumId(input.actorId)) ?? "" },
      select: { id: true, title: true },
    });

    if (!practicum) {
      throw new AuthServiceError("INVALID_INPUT", "Practicum does not exist");
    }

    const invitation = await prisma.$transaction(async (tx) => {
      const createdInvitation = await tx.invitation.create({
        data: {
          role: input.role,
          email,
          tokenHash: hashOpaqueToken(token),
          targetProvider: input.targetProvider,
          targetSubject,
          practicumId: practicum.id,
          expiresAt,
          createdById: input.actorId,
        },
        select: {
          id: true,
          role: true,
          expiresAt: true,
          practicumId: true,
        },
      });

      await tx.auditLog.create({
        data: {
          actorId: input.actorId,
          action: "auth.invitation_created",
          objectType: "Invitation",
          objectId: createdInvitation.id,
          ipAddress: optionalText(requestContext.ipAddress, 100),
          userAgent: optionalText(input.userAgent, 500),
          metadata: {
            role: input.role,
            targetProvider: input.targetProvider,
            practicumId: practicum.id,
          },
        },
      });

      return createdInvitation;
    });

    const credentials = {
      ...invitation,
      token,
    };
    const emailResult = email ? await sendInvitationNotification({ to: email, token, expiresAt, role: input.role }) : { sent: false };
    return { ...credentials, emailSent: emailResult.sent, emailError: emailResult.error };
  }

  public async acceptInvitation(input: AcceptInvitationInput): Promise<{
    userId: string;
    role: UserRole;
    session: SessionCredentials;
  }> {
    const invitationToken = assertInvitationToken(input.invitationToken);
    const providerSubject = requireNonEmpty(input.providerSubject, "providerSubject");
    const username = optionalText(input.username, 100);
    const displayName = optionalText(input.displayName, 200);
    const avatarUrl = optionalText(input.avatarUrl, 500);
    const requestContext = await enrichAuthRequestContext(input);

    try {
      return await prisma.$transaction(
        async (tx) => {
          const now = new Date();
          const invitation = await tx.invitation.findUnique({
            where: { tokenHash: hashOpaqueToken(invitationToken) },
          });

          if (!invitation || invitation.status !== InvitationStatus.PENDING) {
            throw new AuthServiceError("INVALID_INVITATION", "Invitation is invalid or already used");
          }

          if (invitation.expiresAt <= now) {
            await tx.invitation.update({
              where: { id: invitation.id },
              data: { status: InvitationStatus.EXPIRED },
            });
            throw new AuthServiceError("INVITATION_EXPIRED", "Invitation has expired");
          }

          // Invitations created before Discord binding was introduced are not
          // allowed to activate accounts: they would still be bearer links.
          if (invitation.targetProvider !== IdentityProvider.DISCORD || !invitation.targetSubject) {
            throw new AuthServiceError("INVALID_INVITATION", "Invitation is not bound to a Discord account");
          }

          if (
            invitation.targetProvider !== input.provider ||
            invitation.targetSubject !== providerSubject
          ) {
            throw new AuthServiceError(
              "INVITATION_BOUND_TO_ANOTHER_ACCOUNT",
              "Invitation is bound to another account",
            );
          }

          const identity = await tx.externalIdentity.findUnique({
            where: {
              provider_providerSubject: {
                provider: input.provider,
                providerSubject,
              },
            },
            include: { user: true },
          });

          let userId: string;
          let userRole: UserRole;

          if (identity) {
            if (
              identity.user.status === UserStatus.SUSPENDED ||
              identity.user.status === UserStatus.DELETED
            ) {
              throw new AuthServiceError("ACCOUNT_SUSPENDED", "Account is not available");
            }

            if (identity.user.role !== invitation.role) {
              throw new AuthServiceError("ROLE_CONFLICT", "Account role cannot be changed by invitation");
            }

            userId = identity.user.id;
            userRole = identity.user.role;

            await tx.user.update({
              where: { id: userId },
              data: { status: UserStatus.ACTIVE, email: identity.user.email ?? invitation.email },
            });
            await tx.externalIdentity.update({
              where: { id: identity.id },
              data: { username, displayName, avatarUrl },
            });
          } else {
            const user = await tx.user.create({
              data: {
                role: invitation.role,
                email: invitation.email,
                status: UserStatus.ACTIVE,
                externalIdentities: {
                  create: {
                    provider: input.provider,
                    providerSubject,
                    username,
                    displayName,
                    avatarUrl,
                  },
                },
              },
              select: { id: true, role: true },
            });

            userId = user.id;
            userRole = user.role;
          }

          const accepted = await tx.invitation.updateMany({
            where: {
              id: invitation.id,
              status: InvitationStatus.PENDING,
            },
            data: {
              status: InvitationStatus.ACCEPTED,
              acceptedAt: now,
              acceptedById: userId,
            },
          });

          if (accepted.count !== 1) {
            throw new AuthServiceError("AUTH_CONFLICT", "Invitation was accepted concurrently");
          }

          // course-service requires an ACTIVE Enrollment for every STUDENT dashboard load
          // ("Student is not enrolled in a practicum") — without this, a student who just
          // accepted an invitation is locked out on their first visit. The invitation UI has
          // no practicum picker today, so practicumId is normally null; fall back to whichever
          // practicum is currently active (the cohort the curator is actually running) —
          // see practicum-service.ts#getActivePracticumId.
          const targetPracticumId = invitation.practicumId ?? (await getActivePracticumId(tx));
          if (userRole === UserRole.STUDENT && targetPracticumId) {
            // A returning student accepting a fresh invite into a different cohort is moving
            // forward, not joining both at once — close out any other still-active enrollment(s)
            // first, so they don't end up double-counted (and double-visible in the curator's
            // per-поток views) across two cohorts simultaneously.
            await tx.enrollment.updateMany({
              where: { studentId: userId, practicumId: { not: targetPracticumId }, status: EnrollmentStatus.ACTIVE },
              data: { status: EnrollmentStatus.COMPLETED },
            });
            const studentEnrollment = await tx.enrollment.upsert({
              where: { studentId_practicumId: { studentId: userId, practicumId: targetPracticumId } },
              update: { status: EnrollmentStatus.ACTIVE },
              create: { studentId: userId, practicumId: targetPracticumId },
              select: { id: true },
            });
            await seedOpenModuleAccess(tx, studentEnrollment.id, targetPracticumId);
          }

          const session = await this.createSessionInTransaction(tx, {
            ...input,
            ...requestContext,
            userId,
            providerSubject,
          });

          return { userId, role: userRole, session };
        },
        { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
      );
    } catch (error) {
      if (error instanceof AuthServiceError) throw error;
      throw new AuthServiceError("AUTH_CONFLICT", "Unable to complete invitation acceptance");
    }
  }

  public async createSession(input: CreateSessionInput): Promise<SessionCredentials> {
    const user = await prisma.user.findUnique({
      where: { id: input.userId },
      select: { role: true, status: true },
    });

    if (!user || user.status !== UserStatus.ACTIVE) {
      throw new AuthServiceError("SESSION_INVALID", "Account is not available");
    }

    const requestContext = await enrichAuthRequestContext(input);

    return prisma.$transaction(
      (tx) => this.createSessionInTransaction(tx, { ...input, ...requestContext }),
      { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
    );
  }

  public async validateSession(sessionToken: string): Promise<{
    sessionId: string;
    userId: string;
    role: UserRole;
    workingPracticumId: string | null;
    profile: {
      email: string | null;
      emailVerifiedAt: Date | null;
      timeZone: string | null;
      displayName: string | null;
      username: string | null;
      avatarUrl: string | null;
      identities: Array<{
        provider: IdentityProvider;
        displayName: string | null;
        username: string | null;
        avatarUrl: string | null;
      }>;
    };
  }> {
    const normalizedToken = assertSessionToken(sessionToken);
    const now = new Date();
    const session = await prisma.session.findUnique({
      where: { tokenHash: hashOpaqueToken(normalizedToken) },
      include: {
        user: {
          select: {
            id: true,
            role: true,
            status: true,
            email: true,
            emailVerifiedAt: true,
            timeZone: true,
            workingPracticumId: true,
            externalIdentities: {
              orderBy: { createdAt: "asc" },
              select: { provider: true, displayName: true, username: true, avatarUrl: true },
            },
          },
        },
      },
    });

    if (
      !session ||
      session.status !== SessionStatus.ACTIVE ||
      session.expiresAt <= now ||
      session.user.status !== UserStatus.ACTIVE
    ) {
      if ((session?.status === SessionStatus.ACTIVE || session?.status === SessionStatus.PENDING) && session.expiresAt <= now) {
        await prisma.session.update({
          where: { id: session.id },
          data: { status: SessionStatus.EXPIRED },
        });
      }

      throw new AuthServiceError("SESSION_INVALID", "Session is invalid or expired");
    }

    await prisma.session.update({
      where: { id: session.id },
      data: { lastActiveAt: now },
    });

    return {
      sessionId: session.id,
      userId: session.user.id,
      role: session.user.role,
      workingPracticumId: session.user.workingPracticumId,
      profile: {
        email: session.user.email,
        emailVerifiedAt: session.user.emailVerifiedAt,
        timeZone: session.user.timeZone,
        displayName: session.user.externalIdentities[0]?.displayName ?? null,
        username: session.user.externalIdentities[0]?.username ?? null,
        avatarUrl: session.user.externalIdentities[0]?.avatarUrl ?? null,
        identities: session.user.externalIdentities,
      },
    };
  }

  public async loginWithIdentity(input: LoginWithIdentityInput): Promise<{
    userId: string;
    role: UserRole;
    session: SessionCredentials;
  }> {
    const providerSubject = requireNonEmpty(input.providerSubject, "providerSubject");
    const identity = await prisma.externalIdentity.findUnique({
      where: {
        provider_providerSubject: {
          provider: input.provider,
          providerSubject,
        },
      },
      select: { id: true, userId: true, user: { select: { role: true, status: true } } },
    });

    if (!identity) {
      throw new AuthServiceError("INVALID_INVITATION", "An invitation is required for first access");
    }

    if (identity.user.status !== UserStatus.ACTIVE) {
      throw new AuthServiceError("ACCOUNT_SUSPENDED", "Account is not available");
    }

    const username = optionalText(input.username, 100);
    const displayName = optionalText(input.displayName, 200);
    const avatarUrl = optionalText(input.avatarUrl, 500);
    if (username !== undefined || displayName !== undefined || avatarUrl !== undefined) {
      await prisma.externalIdentity.update({
        where: { id: identity.id },
        data: { username, displayName, avatarUrl },
      });
    }

    const session = await this.createSession({
      ...input,
      userId: identity.userId,
      providerSubject,
    });

    return { userId: identity.userId, role: identity.user.role, session };
  }

  public async loginWithLocalTestIdentity(
    role: UserRole,
    input: AuthRequestContext & { deviceKey?: string },
  ): Promise<{
    userId: string;
    role: UserRole;
    session: SessionCredentials;
  }> {
    if (!isLocalTestAuthEnabled()) {
      throw new AuthServiceError("FORBIDDEN", "Development authentication is disabled");
    }

    const providerSubject = role === UserRole.CURATOR ? "local-curator" : "local-student";
    const identity = await prisma.externalIdentity.findUnique({
      where: {
        provider_providerSubject: {
          provider: IdentityProvider.LOCAL,
          providerSubject,
        },
      },
      select: { userId: true, user: { select: { role: true, status: true } } },
    });

    if (!identity || identity.user.role !== role || identity.user.status !== UserStatus.ACTIVE) {
      throw new AuthServiceError("INVALID_INPUT", "Local test account is not available");
    }

    const session = await this.createSession({
      ...input,
      userId: identity.userId,
      provider: IdentityProvider.LOCAL,
      providerSubject,
    });

    return { userId: identity.userId, role: identity.user.role, session };
  }

  public async revokeSession(sessionToken: string): Promise<void> {
    const normalizedToken = assertSessionToken(sessionToken);
    await prisma.session.updateMany({
      where: {
        tokenHash: hashOpaqueToken(normalizedToken),
        status: { in: [SessionStatus.ACTIVE, SessionStatus.PENDING] },
      },
      data: {
        status: SessionStatus.REVOKED,
        revokedAt: new Date(),
      },
    });
  }

  public async getStudentSecurityOverview(
    actorId: string,
    studentId: string,
  ): Promise<StudentSecurityOverview> {
    const actor = await prisma.user.findUnique({
      where: { id: actorId },
      select: { role: true, status: true },
    });

    if (
      !actor ||
      (actor.role !== UserRole.CURATOR && actor.role !== UserRole.OWNER) ||
      actor.status !== UserStatus.ACTIVE
    ) {
      throw new AuthServiceError("FORBIDDEN", "Only an active owner or curator can view security data");
    }

    // Any active curator can view any student's security data — students aren't
    // partitioned by curator.

    const student = await prisma.user.findUnique({
      where: { id: studentId },
      select: {
        id: true,
        role: true,
        status: true,
        createdAt: true,
        externalIdentities: {
          select: { provider: true, username: true, displayName: true, avatarUrl: true },
        },
      },
    });

    if (!student || student.role !== UserRole.STUDENT) {
      throw new AuthServiceError("INVALID_INPUT", "Student does not exist");
    }

    return this.buildSecurityOverview(student);
  }

  /**
   * Mirror of getStudentSecurityOverview for a curator's (or owner's) own account — needed so a
   * staff member's device list has somewhere to live once they're no longer listed under
   * "Ученики". Viewing is open to any active curator or owner, same as a student's card; the
   * actions on it (approve/revoke/change role) stay owner-only — see
   * assertCanManageDeviceSecurity and setUserRole.
   */
  public async getTeamMemberSecurityOverview(actorId: string, memberId: string): Promise<StudentSecurityOverview> {
    await this.assertOwnerOrCurator(actorId);

    const member = await prisma.user.findUnique({
      where: { id: memberId },
      select: {
        id: true,
        role: true,
        status: true,
        createdAt: true,
        externalIdentities: {
          select: { provider: true, username: true, displayName: true, avatarUrl: true },
        },
      },
    });

    if (!member || (member.role !== UserRole.CURATOR && member.role !== UserRole.OWNER)) {
      throw new AuthServiceError("INVALID_INPUT", "Team member does not exist");
    }

    return this.buildSecurityOverview(member);
  }

  private async buildSecurityOverview(user: {
    id: string;
    status: UserStatus;
    createdAt: Date;
    externalIdentities: Array<{ provider: IdentityProvider; username: string | null; displayName: string | null; avatarUrl: string | null }>;
  }): Promise<StudentSecurityOverview> {
    // Keep the security view truthful even when no request has touched an
    // expired session recently. Expiry is enforced on every protected request,
    // but this page is also an audit surface and must not show stale devices as
    // active or pending.
    const now = new Date();
    await prisma.session.updateMany({
      where: {
        userId: user.id,
        status: { in: [SessionStatus.ACTIVE, SessionStatus.PENDING] },
        expiresAt: { lte: now },
      },
      data: { status: SessionStatus.EXPIRED },
    });

    const [sessions, loginEvents] = await Promise.all([
      prisma.session.findMany({
        where: { userId: user.id },
        orderBy: { createdAt: "desc" },
        take: 50,
        select: {
          id: true,
          status: true,
          deviceName: true,
          userAgent: true,
          ipAddress: true,
          countryCode: true,
          city: true,
          lastActiveAt: true,
          expiresAt: true,
          revokedAt: true,
          createdAt: true,
        },
      }),
      prisma.loginEvent.findMany({
        where: { userId: user.id },
        orderBy: { createdAt: "desc" },
        take: 100,
        select: {
          id: true,
          provider: true,
          outcome: true,
          deviceName: true,
          userAgent: true,
          ipAddress: true,
          countryCode: true,
          city: true,
          reasonCode: true,
          createdAt: true,
        },
      }),
    ]);

    return {
      student: {
        id: user.id,
        status: user.status,
        createdAt: user.createdAt,
        identities: user.externalIdentities,
      },
      sessions,
      loginEvents,
    };
  }

  /** Roster of curator and owner accounts and their device/session signal, visible to any active
    * curator or owner — the staff-side counterpart to getStudentDirectory, needed once a tester
    * (or anyone) is promoted to curator/owner and stops appearing under "Ученики". Includes OWNER
    * alongside CURATOR — getTeamMemberSecurityOverview/assertCanManageDeviceSecurity already
    * accept an owner as a target here, this list just has to actually surface them. */
  public async getTeamDirectory(actorId: string): Promise<TeamMemberDirectoryRecord[]> {
    await this.assertOwnerOrCurator(actorId);

    const now = new Date();
    const members = await prisma.user.findMany({
      where: { role: { in: [UserRole.CURATOR, UserRole.OWNER] }, status: { not: UserStatus.DELETED } },
      orderBy: { createdAt: "desc" },
      select: {
        id: true,
        role: true,
        isProtectedOwner: true,
        email: true,
        status: true,
        createdAt: true,
        externalIdentities: {
          select: { provider: true, username: true, displayName: true, avatarUrl: true },
        },
        sessions: {
          where: { status: SessionStatus.ACTIVE, expiresAt: { gt: now } },
          orderBy: { lastActiveAt: "desc" },
          take: 1,
          select: { lastActiveAt: true, deviceName: true, ipAddress: true, countryCode: true, city: true },
        },
        _count: {
          select: {
            sessions: { where: { status: SessionStatus.ACTIVE, expiresAt: { gt: now } } },
            loginEvents: true,
          },
        },
      },
    });

    return members.map((member) => ({
      id: member.id,
      role: member.role,
      isProtectedOwner: member.isProtectedOwner,
      email: member.email,
      status: member.status,
      createdAt: member.createdAt,
      identities: member.externalIdentities,
      activeSessionCount: member._count.sessions,
      loginEventCount: member._count.loginEvents,
      lastSession: member.sessions[0] ?? null,
    }));
  }

  /**
   * Owner-only student <-> curator role switch, for test accounts that need to move back and
   * forth without a fresh Discord identity each time (a real invitation only ever sets a role
   * once). Does the same bookkeeping accept-invitation/promotion would:
   *  - to CURATOR: drops the Enrollment — a curator doesn't have student-side data.
   *  - to STUDENT: enrolls in the active practicum and seeds default-open module access, exactly
   *    like a fresh invitation accept.
   * Deliberately can't target or produce OWNER — that's a manual, one-off change.
   */
  public async setUserRole(actorId: string, targetId: string, nextRole: "STUDENT" | "CURATOR"): Promise<{ id: string; role: UserRole }> {
    await this.assertOwner(actorId);

    const target = await prisma.user.findUnique({ where: { id: targetId }, select: { id: true, role: true, status: true } });
    if (!target || target.status === UserStatus.DELETED) {
      throw new AuthServiceError("INVALID_INPUT", "Account does not exist");
    }
    if (target.role !== UserRole.STUDENT && target.role !== UserRole.CURATOR) {
      throw new AuthServiceError("INVALID_INPUT", "Only a student or curator role can be changed here");
    }

    const targetRole = nextRole === "CURATOR" ? UserRole.CURATOR : UserRole.STUDENT;
    if (target.role === targetRole) return { id: target.id, role: target.role };

    return prisma.$transaction(async (tx) => {
      await tx.user.update({ where: { id: targetId }, data: { role: targetRole } });

      if (targetRole === UserRole.CURATOR) {
        await tx.enrollment.deleteMany({ where: { studentId: targetId } });
      } else {
        const practicumId = await getWorkingPracticumId(actorId, tx);
        if (practicumId) {
          const enrollment = await tx.enrollment.upsert({
            where: { studentId_practicumId: { studentId: targetId, practicumId } },
            update: { status: EnrollmentStatus.ACTIVE },
            create: { studentId: targetId, practicumId, status: EnrollmentStatus.ACTIVE },
            select: { id: true },
          });
          await seedOpenModuleAccess(tx, enrollment.id, practicumId);
        }
      }

      await tx.auditLog.create({
        data: {
          actorId,
          action: "security.user_role_changed",
          objectType: "User",
          objectId: targetId,
          metadata: { from: target.role, to: targetRole },
        },
      });

      return { id: targetId, role: targetRole };
    });
  }

  /**
   * Owner-only. Promotes an existing curator to a full, undifferentiated OWNER — no separate
   * tier, same powers as any other owner. Only CURATOR → OWNER (not STUDENT directly), same
   * reasoning as setUserRole above: a curator already has no enrollment/module-access rows to
   * clean up or seed either way.
   */
  public async grantOwnerRole(actorId: string, targetId: string): Promise<{ id: string; role: UserRole }> {
    await this.assertOwner(actorId);
    const target = await prisma.user.findUnique({ where: { id: targetId }, select: { id: true, role: true, status: true } });
    if (!target || target.status === UserStatus.DELETED) throw new AuthServiceError("INVALID_INPUT", "Аккаунт не найден");
    if (target.role !== UserRole.CURATOR) throw new AuthServiceError("INVALID_INPUT", "Овнером можно сделать только куратора");

    return prisma.$transaction(async (tx) => {
      await tx.user.update({ where: { id: targetId }, data: { role: UserRole.OWNER } });
      await tx.auditLog.create({
        data: { actorId, action: "security.owner_granted", objectType: "User", objectId: targetId },
      });
      return { id: targetId, role: UserRole.OWNER };
    });
  }

  /**
   * Owner-only. Demotes another owner back to curator — three guards, all deliberate:
   *  - never the actor's own role (ask a different owner instead, so nobody locks themselves
   *    out of "Команда" by mistake);
   *  - never an account with isProtectedOwner set (reserved for the platform's actual owner —
   *    see schema.prisma; that one can only be changed by hand in the database, by design, not
   *    through this feature, no matter who's asking);
   *  - never the last remaining owner, protected or not — the app would otherwise have no way
   *    to grant OWNER back to anyone.
   */
  public async revokeOwnerRole(actorId: string, targetId: string): Promise<{ id: string; role: UserRole }> {
    await this.assertOwner(actorId);
    if (actorId === targetId) throw new AuthServiceError("INVALID_INPUT", "Нельзя снять роль Овнера с самого себя — попросите другого Овнера");
    const target = await prisma.user.findUnique({ where: { id: targetId }, select: { id: true, role: true, status: true, isProtectedOwner: true } });
    if (!target || target.status === UserStatus.DELETED) throw new AuthServiceError("INVALID_INPUT", "Аккаунт не найден");
    if (target.role !== UserRole.OWNER) throw new AuthServiceError("INVALID_INPUT", "Этот аккаунт не Овнер");
    if (target.isProtectedOwner) throw new AuthServiceError("FORBIDDEN", "Этот Овнер защищён — роль нельзя снять через интерфейс");
    const ownerCount = await prisma.user.count({ where: { role: UserRole.OWNER, status: { not: UserStatus.DELETED } } });
    if (ownerCount <= 1) throw new AuthServiceError("INVALID_INPUT", "Должен остаться хотя бы один Овнер");

    return prisma.$transaction(async (tx) => {
      await tx.user.update({ where: { id: targetId }, data: { role: UserRole.CURATOR } });
      await tx.auditLog.create({
        data: { actorId, action: "security.owner_revoked", objectType: "User", objectId: targetId },
      });
      return { id: targetId, role: UserRole.CURATOR };
    });
  }

  public async getStudentDirectory(actorId: string, options?: { practicumId?: string }): Promise<StudentDirectoryRecord[]> {
    const actor = await prisma.user.findUnique({
      where: { id: actorId },
      select: { role: true, status: true },
    });

    if (
      !actor ||
      (actor.role !== UserRole.CURATOR && actor.role !== UserRole.OWNER) ||
      actor.status !== UserStatus.ACTIVE
    ) {
      throw new AuthServiceError("FORBIDDEN", "Only an active owner or curator can view students");
    }

    const now = new Date();
    // Same "active, unexpired" test course-service.ts#getForUser uses to resolve a student's own
    // practicum — keeps the badge/filter here consistent with what the student's own dashboard shows.
    const activeEnrollmentFilter = { status: EnrollmentStatus.ACTIVE, OR: [{ accessUntil: null }, { accessUntil: { gt: now } }] };
    const students = await prisma.user.findMany({
      where: {
        role: UserRole.STUDENT,
        status: { not: UserStatus.DELETED },
        // Omitting practicumId (the "Все потоки" view) keeps the historical behaviour: every
        // student ever enrolled, so a former student who reaches out can still be found.
        ...(options?.practicumId ? { enrollments: { some: { practicumId: options.practicumId, ...activeEnrollmentFilter } } } : {}),
      },
      orderBy: { createdAt: "desc" },
      select: {
        id: true,
        email: true,
        status: true,
        createdAt: true,
        isAdvanced: true,
        externalIdentities: {
          select: { provider: true, username: true, displayName: true, avatarUrl: true },
        },
        enrollments: {
          // When filtering by a specific "Поток", show that practicum's enrollment on the card —
          // a student can hold more than one active enrollment at once (e.g. re-enrolled into a
          // newer cohort), and picking the oldest one regardless of the filter made the badge
          // contradict the selected "Поток" (looked like the filter wasn't working).
          where: options?.practicumId ? { practicumId: options.practicumId, ...activeEnrollmentFilter } : activeEnrollmentFilter,
          orderBy: { createdAt: "asc" },
          take: 1,
          select: { practicum: { select: { id: true, title: true } } },
        },
        sessions: {
          where: { status: SessionStatus.ACTIVE, expiresAt: { gt: now } },
          orderBy: { lastActiveAt: "desc" },
          take: 1,
          select: { lastActiveAt: true, deviceName: true, ipAddress: true, countryCode: true, city: true },
        },
        _count: {
          select: {
            sessions: { where: { status: SessionStatus.ACTIVE, expiresAt: { gt: now } } },
            loginEvents: true,
            submissions: true,
          },
        },
      },
    });

    return students.map((student) => ({
      id: student.id,
      email: student.email,
      status: student.status,
      createdAt: student.createdAt,
      identities: student.externalIdentities,
      // student.sessions is capped at 1 (it only fetches the most recent session for
      // `lastSession` preview below) — the true active-device count comes from the
      // separately filtered _count, not this array's length.
      activeSessionCount: student._count.sessions,
      loginEventCount: student._count.loginEvents,
      submissionCount: student._count.submissions,
      practicum: student.enrollments[0]?.practicum ?? null,
      canViewDetails: true,
      isAdvanced: student.isAdvanced,
      lastSession: student.sessions[0] ?? null,
    }));
  }

  /**
   * Curator-granted, per-person (not per-enrollment — see the schema comment on User.isAdvanced)
   * — flips the third "Advanced" Module.section track and MediaAudience.ADVANCED recordings on
   * or off for this student. Toggled from the student's own card in "Ученики".
   */
  public async setStudentAdvanced(actorId: string, studentId: string, isAdvanced: boolean): Promise<boolean> {
    const actor = await prisma.user.findUnique({ where: { id: actorId }, select: { role: true, status: true } });
    if (!actor || actor.status !== UserStatus.ACTIVE || (actor.role !== UserRole.CURATOR && actor.role !== UserRole.OWNER)) {
      throw new AuthServiceError("FORBIDDEN", "Only an active owner or curator can edit students");
    }
    await this.assertStudentTarget(studentId);
    const student = await prisma.user.update({ where: { id: studentId }, data: { isAdvanced }, select: { isAdvanced: true } });
    return student.isAdvanced;
  }

  public async updateStudentEmail(actorId: string, studentId: string, rawEmail: string): Promise<string | null> {
    const actor = await prisma.user.findUnique({ where: { id: actorId }, select: { role: true, status: true } });
    if (!actor || actor.status !== UserStatus.ACTIVE || (actor.role !== UserRole.CURATOR && actor.role !== UserRole.OWNER)) {
      throw new AuthServiceError("FORBIDDEN", "Only an active owner or curator can edit students");
    }
    const normalized = rawEmail.trim() ? optionalEmail(rawEmail) : null;
    // Check before the write — it used to update first and throw after, leaving e.g. the owner's
    // email changed behind a 400 (security review STG-2/3, 2026-10-17).
    await this.assertStudentTarget(studentId);
    try {
      const student = await prisma.user.update({ where: { id: studentId }, data: { email: normalized }, select: { email: true } });
      return student.email;
    } catch (error) {
      if (error instanceof AuthServiceError) throw error;
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") throw new AuthServiceError("INVALID_INPUT", "This email is already used");
      throw new AuthServiceError("INVALID_INPUT", "Student email could not be updated");
    }
  }

  /** "Часовой пояс" in Профиль — an IANA zone name, or null for "Автоматически (по браузеру)". */
  public async updateOwnTimeZone(actorId: string, rawTimeZone: string | null): Promise<{ timeZone: string | null }> {
    const timeZone = rawTimeZone?.trim() || null;
    if (timeZone) {
      let valid = timeZone.length <= 64;
      try { new Intl.DateTimeFormat("en-US", { timeZone }).format(new Date()); } catch { valid = false; }
      if (!valid) throw new AuthServiceError("INVALID_INPUT", "Неизвестный часовой пояс");
    }
    const actor = await prisma.user.findUnique({ where: { id: actorId }, select: { status: true } });
    if (!actor || actor.status !== UserStatus.ACTIVE) throw new AuthServiceError("FORBIDDEN", "Account is not active");
    return prisma.user.update({ where: { id: actorId }, data: { timeZone }, select: { timeZone: true } });
  }

  public async updateOwnEmail(actorId: string, rawEmail: string): Promise<{ email: string | null; emailVerifiedAt: Date | null; verificationSent: boolean }> {
    const actor = await prisma.user.findUnique({ where: { id: actorId }, select: { status: true, email: true, emailVerifiedAt: true } });
    if (!actor || actor.status !== UserStatus.ACTIVE) {
      throw new AuthServiceError("FORBIDDEN", "Only an active account can edit its profile");
    }

    const normalized = rawEmail.trim() ? optionalEmail(rawEmail) : null;
    const keepVerification = normalized !== null && normalized === actor.email && actor.emailVerifiedAt !== null;
    const verificationToken = normalized && !keepVerification ? createOpaqueToken("email") : null;
    const now = new Date();
    try {
      const profile = await prisma.$transaction(async (tx) => {
        await tx.emailVerificationToken.updateMany({
          where: { userId: actorId, usedAt: null },
          data: { usedAt: now },
        });
        const updated = await tx.user.update({
          where: { id: actorId },
          data: {
            email: normalized,
            // A changed address must be verified again before it is used as a trusted contact.
            emailVerifiedAt: keepVerification ? actor.emailVerifiedAt : null,
          },
          select: { email: true, emailVerifiedAt: true },
        });
        if (verificationToken && updated.email) {
          await tx.emailVerificationToken.create({
            data: {
              userId: actorId,
              email: updated.email,
              tokenHash: hashOpaqueToken(verificationToken),
              expiresAt: new Date(now.getTime() + 24 * 60 * 60 * 1000),
            },
          });
        }
        return updated;
      });
      const verificationSent = profile.email && verificationToken
        ? await sendEmailVerificationNotification({ to: profile.email, token: verificationToken })
        : false;
      return { ...profile, verificationSent };
    } catch (error) {
      if (error instanceof AuthServiceError) throw error;
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
        throw new AuthServiceError("INVALID_INPUT", "This email is already used");
      }
      throw new AuthServiceError("INVALID_INPUT", "Email could not be updated");
    }
  }

  public async verifyEmail(rawToken: string): Promise<{ email: string; emailVerifiedAt: Date }> {
    const token = rawToken.trim();
    if (!isOpaqueToken(token, "email")) throw new AuthServiceError("INVALID_INPUT", "Email verification link is invalid");
    const now = new Date();
    try {
      return await prisma.$transaction(async (tx) => {
        const stored = await tx.emailVerificationToken.findUnique({ where: { tokenHash: hashOpaqueToken(token) } });
        if (!stored || stored.usedAt || stored.expiresAt <= now) {
          throw new AuthServiceError("INVALID_INPUT", "Email verification link is expired or already used");
        }
        const consumed = await tx.emailVerificationToken.updateMany({
          where: { id: stored.id, usedAt: null, expiresAt: { gt: now } },
          data: { usedAt: now },
        });
        if (consumed.count !== 1) throw new AuthServiceError("INVALID_INPUT", "Email verification link is expired or already used");
        const verifiedAt = now;
        const updated = await tx.user.updateMany({
          where: { id: stored.userId, status: UserStatus.ACTIVE, email: stored.email },
          data: { emailVerifiedAt: verifiedAt },
        });
        if (updated.count !== 1) throw new AuthServiceError("INVALID_INPUT", "Email verification link is no longer valid");
        return { email: stored.email, emailVerifiedAt: verifiedAt };
      }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
    } catch (error) {
      if (error instanceof AuthServiceError) throw error;
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2034") {
        throw new AuthServiceError("AUTH_CONFLICT", "Email verification was already processed");
      }
      throw new AuthServiceError("INVALID_INPUT", "Email verification failed");
    }
  }

  public async revokeUserSessions(actorId: string, userId: string, reason: string): Promise<number> {
    await this.assertOwner(actorId);
    await this.assertDeviceTargetExists(userId);
    const normalizedReason = requireNonEmpty(reason, "reason");

    return prisma.$transaction(async (tx) => {
      const result = await tx.session.updateMany({
        where: { userId, status: { in: [SessionStatus.ACTIVE, SessionStatus.PENDING] } },
        data: { status: SessionStatus.REVOKED, revokedAt: new Date() },
      });

      await tx.auditLog.create({
        data: {
          actorId,
          action: "security.user_sessions_revoked",
          objectType: "User",
          objectId: userId,
          metadata: { reason: normalizedReason, revokedCount: result.count },
        },
      });

      return result.count;
    });
  }

  public async revokeUserSession(actorId: string, userId: string, sessionId: string, reason: string): Promise<void> {
    await this.assertCanManageDeviceSecurity(actorId, userId);
    const normalizedReason = requireNonEmpty(reason, "reason");
    await prisma.$transaction(async (tx) => {
      const result = await tx.session.updateMany({
        where: { id: sessionId, userId, status: { in: [SessionStatus.ACTIVE, SessionStatus.PENDING] } },
        data: { status: SessionStatus.REVOKED, revokedAt: new Date() },
      });
      if (result.count !== 1) throw new AuthServiceError("INVALID_INPUT", "Session does not exist or is already closed");
      await tx.auditLog.create({
        data: { actorId, action: "security.user_session_revoked", objectType: "Session", objectId: sessionId, metadata: { userId, reason: normalizedReason } },
      });
    });
  }

  public async approveUserSession(actorId: string, userId: string, sessionId: string, reason: string): Promise<void> {
    await this.assertCanManageDeviceSecurity(actorId, userId);
    const normalizedReason = requireNonEmpty(reason, "reason");

    await prisma.$transaction(async (tx) => {
      const targetUser = await tx.user.findUnique({ where: { id: userId }, select: { status: true } });
      if (!targetUser || targetUser.status !== UserStatus.ACTIVE) {
        throw new AuthServiceError("INVALID_INPUT", "Account is not active");
      }

      const pending = await tx.session.findUnique({
        where: { id: sessionId },
        select: { status: true, expiresAt: true, userId: true },
      });
      if (!pending || pending.userId !== userId || pending.status !== SessionStatus.PENDING || pending.expiresAt <= new Date()) {
        throw new AuthServiceError("INVALID_INPUT", "Pending device session does not exist or has expired");
      }

      const activeSessions = await tx.session.findMany({
        where: { userId, status: SessionStatus.ACTIVE, expiresAt: { gt: new Date() } },
        select: { id: true, deviceKeyHash: true },
      });
      const incoming = await tx.session.findUnique({ where: { id: sessionId }, select: { deviceKeyHash: true } });
      if (!incoming?.deviceKeyHash || hasReachedDeviceLimit(activeSessions, incoming.deviceKeyHash, MAX_DEVICES)) {
        throw new AuthServiceError("AUTH_CONFLICT", "The account already has the maximum number of active devices");
      }

      const updated = await tx.session.updateMany({
        where: { id: sessionId, userId, status: SessionStatus.PENDING, expiresAt: { gt: new Date() } },
        data: { status: SessionStatus.ACTIVE, expiresAt: getSessionExpiry(new Date()), lastActiveAt: new Date() },
      });
      if (updated.count !== 1) throw new AuthServiceError("AUTH_CONFLICT", "Device approval changed concurrently");
      await tx.auditLog.create({
        data: { actorId, action: "security.user_session_approved", objectType: "Session", objectId: sessionId, metadata: { userId, reason: normalizedReason } },
      });
    }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
  }

  public async suspendUser(actorId: string, userId: string, reason: string): Promise<void> {
    await this.assertOwner(actorId);
    await this.assertStudentTarget(userId);
    const normalizedReason = requireNonEmpty(reason, "reason");

    await prisma.$transaction(async (tx) => {
      await tx.user.update({
        where: { id: userId },
        data: { status: UserStatus.SUSPENDED },
      });

      await tx.session.updateMany({
        where: { userId, status: { in: [SessionStatus.ACTIVE, SessionStatus.PENDING] } },
        data: { status: SessionStatus.REVOKED, revokedAt: new Date() },
      });

      await tx.auditLog.create({
        data: {
          actorId,
          action: "security.user_suspended",
          objectType: "User",
          objectId: userId,
          metadata: { reason: normalizedReason },
        },
      });
    });
  }

  /**
   * Owner or curator — permanently erases a student and everything tied to them (ДЗ,
   * submissions/feedback, discussion threads, stream chat messages, sessions, login history).
   * Unlike suspendUser this is not reversible, so the caller is expected to have confirmed with
   * the actual human first (a confirm dialog on the client) — there's no server-side "are you
   * sure" step.
   *
   * Most of the schema cascades or SetNulls automatically once the User row is gone, but three
   * FKs are `onDelete: Restrict` and reachable from a student's own data: DiscussionMessage.author
   * and StreamMessage.author (a student's own messages), and SubmissionAttachment.file (files a
   * student uploaded to their own ДЗ, referenced via StoredFile which cascades off the same User
   * row). Rather than rely on how Postgres orders cascades across multiple FK paths converging on
   * one row in a single statement, those three are deleted explicitly first — by the time
   * user.delete() runs, nothing is left that could hit a Restrict.
   */
  public async deleteStudent(actorId: string, studentId: string): Promise<void> {
    const actor = await prisma.user.findUnique({ where: { id: actorId }, select: { role: true, status: true } });
    if (!actor || actor.status !== UserStatus.ACTIVE || (actor.role !== UserRole.CURATOR && actor.role !== UserRole.OWNER)) {
      throw new AuthServiceError("FORBIDDEN", "Only an active owner or curator can delete a student");
    }

    const student = await prisma.user.findUnique({
      where: { id: studentId },
      select: {
        role: true,
        email: true,
        externalIdentities: { orderBy: { createdAt: "asc" }, take: 1, select: { displayName: true, username: true } },
      },
    });
    if (!student || student.role !== UserRole.STUDENT) {
      throw new AuthServiceError("INVALID_INPUT", "Student does not exist");
    }
    const label = student.externalIdentities[0]?.displayName ?? student.externalIdentities[0]?.username ?? student.email ?? studentId;

    await prisma.$transaction(async (tx) => {
      await tx.discussionMessage.deleteMany({ where: { authorId: studentId } });
      await tx.streamMessage.deleteMany({ where: { authorId: studentId } });
      await tx.submissionAttachment.deleteMany({ where: { file: { ownerId: studentId } } });

      await tx.user.delete({ where: { id: studentId } });

      // objectId is a plain string, not an FK — safe to record after the row is gone. The
      // metadata snapshot exists precisely because it won't be, so this stays traceable.
      await tx.auditLog.create({
        data: {
          actorId,
          action: "security.student_deleted",
          objectType: "User",
          objectId: studentId,
          metadata: { label, email: student.email },
        },
      });
    });
  }

  public async recordLoginEvent(input: {
    userId?: string;
    provider?: IdentityProvider;
    providerSubject?: string;
    outcome: LoginEventOutcome;
    reasonCode?: string;
  } & AuthRequestContext): Promise<void> {
    const requestContext = normalizeAuthRequestContext(input);
    await prisma.loginEvent.create({
      data: {
        userId: input.userId,
        provider: input.provider,
        providerSubject: input.providerSubject,
        outcome: input.outcome,
        reasonCode: optionalText(input.reasonCode, 100),
        deviceName: optionalText(input.deviceName, 100),
        userAgent: optionalText(input.userAgent, 500),
        ipAddress: optionalText(requestContext.ipAddress, 100),
        countryCode: optionalText(requestContext.countryCode, 10),
        city: optionalText(requestContext.city, 100),
        ipHash: requestContext.ipAddress ? hashOpaqueToken(requestContext.ipAddress) : undefined,
      },
    });
  }

  private async assertOwner(actorId: string): Promise<void> {
    const actor = await prisma.user.findUnique({
      where: { id: actorId },
      select: { role: true, status: true },
    });

    if (!actor || actor.role !== UserRole.OWNER || actor.status !== UserStatus.ACTIVE) {
      throw new AuthServiceError("FORBIDDEN", "Only the active owner can perform this action");
    }
  }

  private async assertOwnerOrCurator(actorId: string): Promise<void> {
    const actor = await prisma.user.findUnique({
      where: { id: actorId },
      select: { role: true, status: true },
    });

    if (!actor || actor.status !== UserStatus.ACTIVE || (actor.role !== UserRole.OWNER && actor.role !== UserRole.CURATOR)) {
      throw new AuthServiceError("FORBIDDEN", "Only an active owner or curator can perform this action");
    }
  }

  /**
   * Gates device management (approve / revoke one session): a student's devices are manageable
   * by any active curator or owner, same as before. A curator's or owner's own devices are staff
   * security — only the owner may touch those, never a peer curator. Without this split, once a
   * tester's account is promoted to curator (see practicum-admin-service.ts-adjacent role
   * changes), a legitimate third-device approval would have nobody left who could grant it.
   */
  private async assertCanManageDeviceSecurity(actorId: string, targetId: string): Promise<void> {
    const [actor, target] = await Promise.all([
      prisma.user.findUnique({
        where: { id: actorId },
        select: { role: true, status: true },
      }),
      prisma.user.findUnique({
        where: { id: targetId },
        select: { role: true, status: true },
      }),
    ]);
    if (!actor || actor.status !== UserStatus.ACTIVE || (actor.role !== UserRole.OWNER && actor.role !== UserRole.CURATOR)) {
      throw new AuthServiceError("FORBIDDEN", "Only an active owner or curator can manage devices");
    }
    if (!target || target.status === UserStatus.DELETED) {
      throw new AuthServiceError("INVALID_INPUT", "Account does not exist");
    }
    if (target.role !== UserRole.STUDENT && actor.role !== UserRole.OWNER) {
      throw new AuthServiceError("FORBIDDEN", "Only the active owner can manage a staff member's devices");
    }
  }

  private async assertStudentTarget(studentId: string): Promise<void> {
    const student = await prisma.user.findUnique({
      where: { id: studentId },
      select: { role: true, status: true },
    });

    if (!student || student.role !== UserRole.STUDENT || student.status === UserStatus.DELETED) {
      throw new AuthServiceError("INVALID_INPUT", "Student does not exist");
    }
  }

  /** Bulk "revoke all sessions" is already owner-gated at the controller — any active account
    * (student or staff) is a valid target, unlike the single-session approve/revoke split above. */
  private async assertDeviceTargetExists(userId: string): Promise<void> {
    const target = await prisma.user.findUnique({ where: { id: userId }, select: { status: true } });
    if (!target || target.status === UserStatus.DELETED) {
      throw new AuthServiceError("INVALID_INPUT", "Account does not exist");
    }
  }

  /**
   * Mirrors the "active sessions have different network signatures" heuristic the curator's
   * student-security tab already computes client-side (unusualActivity in page.tsx), but
   * server-side and event-driven — so every active curator/owner hears about it via the
   * notification bell instead of only finding out by opening that student's profile. Fires once,
   * exactly on the login that actually tips the account into that state — a student who's already
   * flagged doesn't generate a fresh alert on every subsequent login from the same second device.
   */
  private async flagUnusualAccessIfNew(
    tx: DatabaseClient,
    studentId: string,
    priorSessions: ReadonlyArray<{ countryCode: string | null; city: string | null; ipAddress: string | null }>,
    newSession: { countryCode: string | null; city: string | null; ipAddress: string | null },
  ): Promise<void> {
    const signatureOf = (session: { countryCode: string | null; city: string | null; ipAddress: string | null }) => session.countryCode ?? session.city ?? session.ipAddress;
    const newSignature = signatureOf(newSession);
    if (!newSignature) return;
    const priorSignatures = new Set(priorSessions.map(signatureOf).filter((value): value is string => Boolean(value)));
    if (priorSignatures.size > 1) return; // already flagged on an earlier login
    if (new Set([...priorSignatures, newSignature]).size <= 1) return; // still consistent

    const student = await tx.user.findUnique({ where: { id: studentId }, select: { role: true } });
    if (student?.role !== UserRole.STUDENT) return;

    const recipientIds = (await tx.user.findMany({
      where: { role: { in: [UserRole.CURATOR, UserRole.OWNER] }, status: UserStatus.ACTIVE },
      select: { id: true },
    })).map((staff) => staff.id);
    if (recipientIds.length === 0) return;

    const identity = await tx.externalIdentity.findFirst({ where: { userId: studentId }, select: { displayName: true, username: true } });
    const studentLabel = identity?.displayName ?? identity?.username ?? "Ученик";

    await tx.notification.createMany({
      data: recipientIds.map((userId) => ({
        userId,
        type: NotificationType.SECURITY_ALERT,
        title: `Подозрительный вход: ${studentLabel}`,
        body: "Активные сессии этого ученика используют разные сетевые признаки — проверьте вкладку «Безопасность» в его профиле.",
        entityId: studentId,
      })),
    });
  }

  private async createSessionInTransaction(
    tx: DatabaseClient,
    input: CreateSessionInput,
  ): Promise<SessionCredentials> {
    const now = new Date();
    const sessionToken = createOpaqueToken("session");
    const deviceKey = input.deviceKey && isOpaqueToken(input.deviceKey, "device")
      ? input.deviceKey
      : createOpaqueToken("device");
    const deviceKeyHash = hashOpaqueToken(deviceKey);
    const activeSessions = await tx.session.findMany({
      where: {
        userId: input.userId,
        status: SessionStatus.ACTIVE,
        expiresAt: { gt: now },
      },
      select: { id: true, deviceKeyHash: true, countryCode: true, city: true, ipAddress: true },
    });

    const existingDevice = activeSessions.some((session) => session.deviceKeyHash === deviceKeyHash);
    // The 2-device cap exists to stop a paid student seat being shared around — it isn't a
    // meaningful protection for staff, who legitimately run several browsers/profiles at once
    // (testing both the student and curator side, home vs. work, etc.) and have nobody but the
    // owner who could ever approve a 3rd device for them anyway. So it only applies to students;
    // curators and owners get unlimited devices.
    const actor = await tx.user.findUnique({ where: { id: input.userId }, select: { role: true } });
    // Local test identities are also deliberately exempt from device approval. They are
    // available only through the guarded dev-login endpoint and must allow a developer to
    // switch between the student and curator flows freely.
    const requiresApproval = input.provider !== IdentityProvider.LOCAL
      && actor?.role === UserRole.STUDENT
      && !existingDevice
      && hasReachedDeviceLimit(activeSessions, deviceKeyHash, MAX_DEVICES);

    // A repeated OAuth attempt from the same pending device replaces the old
    // pending session, but never revokes an already approved device.
    await tx.session.updateMany({
      where: { userId: input.userId, status: SessionStatus.PENDING, deviceKeyHash },
      data: { status: SessionStatus.REVOKED, revokedAt: now },
    });

    if (existingDevice) {
      await tx.session.updateMany({
        where: { userId: input.userId, status: SessionStatus.ACTIVE, deviceKeyHash },
        data: { status: SessionStatus.REVOKED, revokedAt: now },
      });
    }

    const sessionStatus = requiresApproval ? SessionStatus.PENDING : SessionStatus.ACTIVE;

    const session = await tx.session.create({
      data: {
        userId: input.userId,
        tokenHash: hashOpaqueToken(sessionToken),
        deviceKeyHash,
        status: sessionStatus,
        deviceName: optionalText(input.deviceName, 100),
        userAgent: optionalText(input.userAgent, 500),
        ipAddress: optionalText(input.ipAddress, 100),
        ipHash: input.ipAddress ? hashOpaqueToken(input.ipAddress) : undefined,
        countryCode: optionalText(input.countryCode, 10),
        city: optionalText(input.city, 100),
        expiresAt: requiresApproval ? getPendingSessionExpiry(now) : getSessionExpiry(now),
      },
      select: { id: true, status: true, expiresAt: true },
    });

    await tx.loginEvent.create({
      data: {
        userId: input.userId,
        provider: input.provider,
        providerSubject: input.providerSubject,
        outcome: requiresApproval ? LoginEventOutcome.BLOCKED : LoginEventOutcome.SUCCESS,
        deviceName: optionalText(input.deviceName, 100),
        userAgent: optionalText(input.userAgent, 500),
        ipAddress: optionalText(input.ipAddress, 100),
        ipHash: input.ipAddress ? hashOpaqueToken(input.ipAddress) : undefined,
        countryCode: optionalText(input.countryCode, 10),
        city: optionalText(input.city, 100),
        reasonCode: requiresApproval ? "DEVICE_APPROVAL_REQUIRED" : undefined,
      },
    });

    if (!requiresApproval) {
      await this.flagUnusualAccessIfNew(tx, input.userId, activeSessions, {
        countryCode: optionalText(input.countryCode, 10) ?? null,
        city: optionalText(input.city, 100) ?? null,
        ipAddress: optionalText(input.ipAddress, 100) ?? null,
      });
    }

    return {
      sessionToken,
      deviceKey,
      sessionId: session.id,
      status: session.status,
      expiresAt: session.expiresAt,
      revokedDeviceKeyHash: null,
    };
  }
}

export const authService = new AuthService();
