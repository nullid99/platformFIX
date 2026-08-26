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
  assignedCurator: { id: string; name: string } | null;
  /** Whether the current curator/owner already has this student assigned. */
  isAssignedToActor: boolean;
  /** Owners may reassign a student; curators may claim only unassigned students. */
  canClaim: boolean;
  /** Only an active owner can transfer a student to another curator. */
  canTransfer: boolean;
  canViewDetails: boolean;
  lastSession: {
    lastActiveAt: Date;
    deviceName: string | null;
    ipAddress: string | null;
    city: string | null;
  } | null;
};

export type CuratorDirectoryRecord = {
  id: string;
  name: string;
  email: string | null;
};
