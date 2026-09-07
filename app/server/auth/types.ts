import type {
  IdentityProvider,
  LoginEventOutcome,
  SessionStatus,
  UserRole,
  UserStatus,
} from "@/app/generated/prisma/enums";

export type AuthRequestContext = {
  deviceName?: string;
  userAgent?: string;
  ipAddress?: string;
  countryCode?: string;
  city?: string;
};

export type CreateInvitationInput = AuthRequestContext & {
  actorId: string;
  role: UserRole;
  email?: string;
  expiresInHours?: number;
  targetProvider?: IdentityProvider;
  targetSubject?: string;
  practicumId?: string;
};

export type InvitationCredentials = {
  id: string;
  token: string;
  role: UserRole;
  expiresAt: Date;
  practicumId: string | null;
  emailSent?: boolean;
  emailError?: string;
};

export type AcceptInvitationInput = AuthRequestContext & {
  invitationToken: string;
  provider: IdentityProvider;
  providerSubject: string;
  username?: string;
  displayName?: string;
  avatarUrl?: string;
  deviceKey?: string;
};

export type CreateSessionInput = AuthRequestContext & {
  userId: string;
  provider?: IdentityProvider;
  providerSubject?: string;
  deviceKey?: string;
};

export type LoginWithIdentityInput = AuthRequestContext & {
  provider: IdentityProvider;
  providerSubject: string;
  username?: string;
  displayName?: string;
  avatarUrl?: string;
  deviceKey?: string;
};

export type SessionCredentials = {
  sessionToken: string;
  deviceKey: string;
  sessionId: string;
  status: SessionStatus;
  expiresAt: Date;
  revokedDeviceKeyHash: string | null;
};

export type SecuritySessionRecord = {
  id: string;
  status: SessionStatus;
  deviceName: string | null;
  userAgent: string | null;
  ipAddress: string | null;
  countryCode: string | null;
  city: string | null;
  lastActiveAt: Date;
  expiresAt: Date;
  revokedAt: Date | null;
  createdAt: Date;
};

export type SecurityLoginEventRecord = {
  id: string;
  provider: IdentityProvider | null;
  outcome: LoginEventOutcome;
  deviceName: string | null;
  userAgent: string | null;
  ipAddress: string | null;
  countryCode: string | null;
  city: string | null;
  reasonCode: string | null;
  createdAt: Date;
};

export type StudentSecurityOverview = {
  student: {
    id: string;
    status: UserStatus;
    createdAt: Date;
    identities: Array<{
      provider: IdentityProvider;
      username: string | null;
      displayName: string | null;
    }>;
  };
  sessions: SecuritySessionRecord[];
  loginEvents: SecurityLoginEventRecord[];
};

export type StudentDirectoryRecord = {
  id: string;
  email: string | null;
  status: UserStatus;
  createdAt: Date;
  identities: Array<{
    provider: IdentityProvider;
    username: string | null;
    displayName: string | null;
  }>;
  activeSessionCount: number;
  loginEventCount: number;
  submissionCount: number;
  /** The practicum this student's active enrollment belongs to — null if they have none
    * (e.g. access expired). Lets the roster show/filter which stream a student is actually in. */
  practicum: { id: string; title: string } | null;
  canViewDetails: boolean;
  lastSession: {
    lastActiveAt: Date;
    deviceName: string | null;
    ipAddress: string | null;
    city: string | null;
  } | null;
};

/** A curator or owner in the "Команда" security roster — same shape of security signal as
  * StudentDirectoryRecord, minus the student-only assignment fields. */
export type TeamMemberDirectoryRecord = {
  id: string;
  role: UserRole;
  email: string | null;
  status: UserStatus;
  createdAt: Date;
  identities: Array<{
    provider: IdentityProvider;
    username: string | null;
    displayName: string | null;
  }>;
  activeSessionCount: number;
  loginEventCount: number;
  lastSession: {
    lastActiveAt: Date;
    deviceName: string | null;
    ipAddress: string | null;
    city: string | null;
  } | null;
};
