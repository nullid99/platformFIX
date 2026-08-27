import { Prisma } from "@/app/generated/prisma/client";
import {
  IdentityProvider,
  InvitationStatus,
  LoginEventOutcome,
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
import type {
  AcceptInvitationInput,
  AuthRequestContext,
  CreateInvitationInput,
  CreateSessionInput,
  InvitationCredentials,
  LoginWithIdentityInput,
  SessionCredentials,
  CuratorDirectoryRecord,
  StudentDirectoryRecord,
  StudentSecurityOverview,
} from "./types";

type DatabaseClient = typeof prisma | Prisma.TransactionClient;

const DEFAULT_INVITATION_HOURS = 7 * 24;
const MAX_INVITATION_HOURS = 30 * 24;
const SESSION_LIFETIME_DAYS = 30;
const PENDING_SESSION_LIFETIME_MINUTES = 15;
const MAX_DEVICES = 2;

/** Local role switching is opt-in on production-like staging only. */
export function isLocalTestAuthEnabled(): boolean {
  return process.env.DEV_AUTH_ENABLED === "true"
    && (process.env.NODE_ENV !== "production" || process.env.STAGING_DEV_AUTH_ENABLED === "true");
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

    if (input.practicumId) {
      const practicum = await prisma.practicum.findUnique({
        where: { id: input.practicumId },
        select: { id: true },
      });

      if (!practicum) {
        throw new AuthServiceError("INVALID_INPUT", "Practicum does not exist");
      }
    }

    const invitation = await prisma.$transaction(async (tx) => {
      const createdInvitation = await tx.invitation.create({
        data: {
          role: input.role,
          email,
          tokenHash: hashOpaqueToken(token),
          targetProvider: input.targetProvider,
          targetSubject,
          practicumId: input.practicumId,
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
            practicumId: input.practicumId,
          },
        },
      });

      return createdInvitation;
    });

    const credentials = {
      ...invitation,
      token,
    };
    const emailSent = email ? await sendInvitationNotification({ to: email, token, expiresAt, role: input.role }) : false;
    return { ...credentials, emailSent };
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

          // A student with no CuratorAssignment row falls through discussion routing
          // as an unassigned (curatorId: null) thread, which only an OWNER can see.
          // Default the inviting curator as the assignment so new students are never orphaned.
          if (userRole === UserRole.STUDENT && invitation.createdById) {
            const inviter = await tx.user.findUnique({
              where: { id: invitation.createdById },
              select: { role: true, status: true },
            });
            if (inviter && inviter.status === UserStatus.ACTIVE && (inviter.role === UserRole.CURATOR || inviter.role === UserRole.OWNER)) {
              await tx.curatorAssignment.upsert({
                where: { curatorId_studentId: { curatorId: invitation.createdById, studentId: userId } },
                update: {},
                create: { curatorId: invitation.createdById, studentId: userId },
              });
            }
          }

          // course-service requires an ACTIVE Enrollment for every STUDENT dashboard load
          // ("Student is not enrolled in a practicum") — without this, a student who just
          // accepted an invitation is locked out on their first visit. The invitation UI has
          // no practicum picker today, so practicumId is normally null; fall back to the
          // earliest-created practicum, mirroring the same default course-service.ts#getForUser
          // already uses for curators/owners with no explicit practicum context.
          const targetPracticumId = invitation.practicumId ?? (await tx.practicum.findFirst({ orderBy: { createdAt: "asc" }, select: { id: true } }))?.id;
          if (userRole === UserRole.STUDENT && targetPracticumId) {
            const studentEnrollment = await tx.enrollment.upsert({
              where: { studentId_practicumId: { studentId: userId, practicumId: targetPracticumId } },
              update: {},
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
    profile: {
      email: string | null;
      emailVerifiedAt: Date | null;
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
      profile: {
        email: session.user.email,
        emailVerifiedAt: session.user.emailVerifiedAt,
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

    if (role === UserRole.CURATOR) {
      const localStudent = await prisma.user.findFirst({
        where: {
          role: UserRole.STUDENT,
          status: UserStatus.ACTIVE,
          externalIdentities: { some: { provider: IdentityProvider.LOCAL, providerSubject: "local-student" } },
        },
        select: { id: true },
      });
      if (localStudent) {
        await prisma.curatorAssignment.upsert({
          where: { curatorId_studentId: { curatorId: identity.userId, studentId: localStudent.id } },
          update: {},
          create: { curatorId: identity.userId, studentId: localStudent.id },
        });
      }
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

    // Any active curator can view any student's security data — curators are no longer
    // partitioned by CuratorAssignment (that field now only records who a student's
    // discussions default to when unclaimed, not who may see or act on them).

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

    // Keep the security view truthful even when no request has touched an
    // expired session recently. Expiry is enforced on every protected request,
    // but this page is also an audit surface and must not show stale devices as
    // active or pending.
    const now = new Date();
    await prisma.session.updateMany({
      where: {
        userId: studentId,
        status: { in: [SessionStatus.ACTIVE, SessionStatus.PENDING] },
        expiresAt: { lte: now },
      },
      data: { status: SessionStatus.EXPIRED },
    });

    const [sessions, loginEvents] = await Promise.all([
      prisma.session.findMany({
        where: { userId: studentId },
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
        where: { userId: studentId },
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
        id: student.id,
        status: student.status,
        createdAt: student.createdAt,
        identities: student.externalIdentities,
      },
      sessions,
      loginEvents,
    };
  }

  public async getStudentDirectory(actorId: string): Promise<StudentDirectoryRecord[]> {
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
    const students = await prisma.user.findMany({
      where: {
        role: UserRole.STUDENT,
        status: { not: UserStatus.DELETED },
        // Curators can see the cohort roster so an unassigned student can be
        // claimed from the same screen. Security details remain restricted by
        // `canViewDetails` and getStudentSecurityOverview below.
      },
      orderBy: { createdAt: "desc" },
      select: {
        id: true,
        email: true,
        status: true,
        createdAt: true,
        externalIdentities: {
          select: { provider: true, username: true, displayName: true, avatarUrl: true },
        },
        studentAssignments: {
          orderBy: { createdAt: "asc" },
          take: 1,
          select: {
            curator: {
              select: {
                id: true,
                email: true,
                externalIdentities: {
                  orderBy: { createdAt: "asc" },
                  take: 1,
                  select: { displayName: true, username: true },
                },
              },
            },
          },
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

    return students.map((student) => {
      const assignedCurator = student.studentAssignments[0]?.curator ?? null;
      const isAssignedToActor = assignedCurator?.id === actorId;

      return {
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
      assignedCurator: assignedCurator
        ? {
            id: assignedCurator.id,
            name: assignedCurator.externalIdentities[0]?.displayName
              ?? assignedCurator.externalIdentities[0]?.username
              ?? assignedCurator.email
              ?? "Куратор",
          }
        : null,
      isAssignedToActor,
      canClaim: actor.role === UserRole.OWNER || assignedCurator === null,
      canTransfer: actor.role === UserRole.OWNER,
      // Every active curator can see every student's details — CuratorAssignment is no
      // longer a visibility partition, just the default "who this student's discussions
      // route to" record (see discussion-service.ts).
      canViewDetails: true,
      lastSession: student.sessions[0] ?? null,
      };
    });
  }

  public async getCuratorDirectory(actorId: string): Promise<CuratorDirectoryRecord[]> {
    await this.assertOwner(actorId);

    const curators = await prisma.user.findMany({
      where: { role: UserRole.CURATOR, status: UserStatus.ACTIVE },
      orderBy: { createdAt: "asc" },
      select: {
        id: true,
        email: true,
        externalIdentities: {
          orderBy: { createdAt: "asc" },
          take: 1,
          select: { displayName: true, username: true },
        },
      },
    });

    return curators.map((curator) => ({
      id: curator.id,
      email: curator.email,
      name: curator.externalIdentities[0]?.displayName
        ?? curator.externalIdentities[0]?.username
        ?? curator.email
        ?? "Куратор",
    }));
  }

  public async transferStudent(actorId: string, studentId: string, targetCuratorId: string) {
    await this.assertOwner(actorId);
    const normalizedStudentId = requireNonEmpty(studentId, "studentId");
    const normalizedTargetCuratorId = requireNonEmpty(targetCuratorId, "curatorId");

    try {
      return await prisma.$transaction(async (tx) => {
        const [student, targetCurator, currentAssignments] = await Promise.all([
          tx.user.findUnique({ where: { id: normalizedStudentId }, select: { id: true, role: true, status: true } }),
          tx.user.findUnique({ where: { id: normalizedTargetCuratorId }, select: { id: true, role: true, status: true } }),
          tx.curatorAssignment.findMany({ where: { studentId: normalizedStudentId }, orderBy: { createdAt: "asc" }, select: { curatorId: true } }),
        ]);

        if (!student || student.role !== UserRole.STUDENT || student.status === UserStatus.DELETED) {
          throw new AuthServiceError("INVALID_INPUT", "Student does not exist");
        }
        if (!targetCurator || targetCurator.role !== UserRole.CURATOR || targetCurator.status !== UserStatus.ACTIVE) {
          throw new AuthServiceError("INVALID_INPUT", "Target curator is not active");
        }

        const previousCuratorId = currentAssignments[0]?.curatorId ?? null;
        if (previousCuratorId === normalizedTargetCuratorId && currentAssignments.length === 1) {
          return { studentId: normalizedStudentId, curatorId: normalizedTargetCuratorId, previousCuratorId, changed: false };
        }

        await tx.curatorAssignment.deleteMany({ where: { studentId: normalizedStudentId } });
        await tx.curatorAssignment.create({ data: { curatorId: normalizedTargetCuratorId, studentId: normalizedStudentId } });
        await tx.auditLog.create({
          data: {
            actorId,
            action: "security.student_transferred",
            objectType: "User",
            objectId: normalizedStudentId,
            metadata: { previousCuratorId, targetCuratorId: normalizedTargetCuratorId },
          },
        });

        return { studentId: normalizedStudentId, curatorId: normalizedTargetCuratorId, previousCuratorId, changed: true };
      }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
    } catch (error) {
      if (error instanceof AuthServiceError) throw error;
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2034") {
        throw new AuthServiceError("AUTH_CONFLICT", "Student assignment changed concurrently. Refresh and try again");
      }
      throw error;
    }
  }

  public async claimStudent(actorId: string, studentId: string) {
    const actor = await prisma.user.findUnique({ where: { id: actorId }, select: { id: true, role: true, status: true } });
    if (!actor || actor.status !== UserStatus.ACTIVE || (actor.role !== UserRole.CURATOR && actor.role !== UserRole.OWNER)) {
      throw new AuthServiceError("FORBIDDEN", "Only an active owner or curator can claim a student");
    }

    try {
      return await prisma.$transaction(async (tx) => {
        const student = await tx.user.findUnique({ where: { id: studentId }, select: { id: true, role: true, status: true } });
        if (!student || student.role !== UserRole.STUDENT || student.status === UserStatus.DELETED) {
          throw new AuthServiceError("INVALID_INPUT", "Student does not exist");
        }

        const current = await tx.curatorAssignment.findMany({
          where: { studentId },
          orderBy: { createdAt: "asc" },
          select: { id: true, curatorId: true },
        });
        const occupiedByAnother = current.some((assignment) => assignment.curatorId !== actorId);
        if (occupiedByAnother && actor.role !== UserRole.OWNER) {
          throw new AuthServiceError("AUTH_CONFLICT", "Student is already assigned to another curator");
        }

        if (actor.role === UserRole.OWNER && occupiedByAnother) {
          await tx.curatorAssignment.deleteMany({ where: { studentId } });
        }

        await tx.curatorAssignment.upsert({
          where: { curatorId_studentId: { curatorId: actorId, studentId } },
          update: {},
          create: { curatorId: actorId, studentId },
        });

        return { studentId, curatorId: actorId, reassigned: occupiedByAnother };
      }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
    } catch (error) {
      if (error instanceof AuthServiceError) throw error;
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2034") {
        throw new AuthServiceError("AUTH_CONFLICT", "Student was claimed by another curator. Refresh and try again");
      }
      throw error;
    }
  }

  public async updateStudentEmail(actorId: string, studentId: string, rawEmail: string): Promise<string | null> {
    const actor = await prisma.user.findUnique({ where: { id: actorId }, select: { role: true, status: true } });
    if (!actor || actor.status !== UserStatus.ACTIVE || (actor.role !== UserRole.CURATOR && actor.role !== UserRole.OWNER)) {
      throw new AuthServiceError("FORBIDDEN", "Only an active owner or curator can edit students");
    }
    const normalized = rawEmail.trim() ? optionalEmail(rawEmail) : null;
    try {
      const student = await prisma.user.update({ where: { id: studentId }, data: { email: normalized }, select: { email: true, role: true } });
      if (student.role !== UserRole.STUDENT) throw new AuthServiceError("INVALID_INPUT", "User is not a student");
      return student.email;
    } catch (error) {
      if (error instanceof AuthServiceError) throw error;
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") throw new AuthServiceError("INVALID_INPUT", "This email is already used");
      throw new AuthServiceError("INVALID_INPUT", "Student email could not be updated");
    }
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
    await this.assertStudentTarget(userId);
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
    await this.assertCanManageStudentSecurity(actorId, userId);
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
    await this.assertCanManageStudentSecurity(actorId, userId);
    const normalizedReason = requireNonEmpty(reason, "reason");

    await prisma.$transaction(async (tx) => {
      const student = await tx.user.findUnique({ where: { id: userId }, select: { status: true } });
      if (!student || student.status !== UserStatus.ACTIVE) {
        throw new AuthServiceError("INVALID_INPUT", "Student account is not active");
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
        throw new AuthServiceError("AUTH_CONFLICT", "The student already has the maximum number of active devices");
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

  private async assertCanManageStudentSecurity(actorId: string, studentId: string): Promise<void> {
    const [actor, student] = await Promise.all([
      prisma.user.findUnique({
        where: { id: actorId },
        select: { role: true, status: true },
      }),
      prisma.user.findUnique({
        where: { id: studentId },
        select: { role: true, status: true },
      }),
    ]);
    if (!actor || actor.status !== UserStatus.ACTIVE || (actor.role !== UserRole.OWNER && actor.role !== UserRole.CURATOR)) {
      throw new AuthServiceError("FORBIDDEN", "Only an active owner or curator can manage student devices");
    }
    if (!student || student.role !== UserRole.STUDENT || student.status === UserStatus.DELETED) {
      throw new AuthServiceError("INVALID_INPUT", "Student does not exist");
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
      select: { id: true, deviceKeyHash: true },
    });

    const existingDevice = activeSessions.some((session) => session.deviceKeyHash === deviceKeyHash);
    // Local test identities are deliberately exempt from device approval. They
    // are available only through the guarded dev-login endpoint and must allow
    // a developer to switch between the student and curator flows freely.
    // Real Discord sessions still use the normal device limit.
    const requiresApproval = input.provider !== IdentityProvider.LOCAL
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
