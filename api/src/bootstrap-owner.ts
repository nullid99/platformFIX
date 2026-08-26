import "dotenv/config";
import { IdentityProvider, UserRole, UserStatus } from "@/app/generated/prisma/enums";
import { prisma } from "@/app/server/db";

const confirmation = process.env.BOOTSTRAP_OWNER_CONFIRM;
const configuredProvider = process.env.BOOTSTRAP_OWNER_PROVIDER;
const provider = configuredProvider === IdentityProvider.DISCORD
  ? configuredProvider
  : undefined;
const providerSubject = process.env.BOOTSTRAP_OWNER_SUBJECT?.trim();
const username = process.env.BOOTSTRAP_OWNER_USERNAME?.trim();
const displayName = process.env.BOOTSTRAP_OWNER_DISPLAY_NAME?.trim();

async function bootstrapOwner(): Promise<void> {
  if (confirmation !== "I_UNDERSTAND_OWNER_BOOTSTRAP") {
    throw new Error("Set BOOTSTRAP_OWNER_CONFIRM to the exact confirmation phrase");
  }

  if (!provider || !providerSubject || providerSubject.length > 200) {
    throw new Error("Set BOOTSTRAP_OWNER_PROVIDER=DISCORD and BOOTSTRAP_OWNER_SUBJECT");
  }

  const existingOwner = await prisma.user.findFirst({
    where: { role: UserRole.OWNER },
    select: { id: true },
  });
  if (existingOwner) throw new Error("An owner already exists; bootstrap is disabled");

  const existingIdentity = await prisma.externalIdentity.findUnique({
    where: {
      provider_providerSubject: {
        provider,
        providerSubject,
      },
    },
    select: { id: true },
  });
  if (existingIdentity) throw new Error(`This ${provider} identity is already linked`);

  await prisma.user.create({
    data: {
      role: UserRole.OWNER,
      status: UserStatus.ACTIVE,
      externalIdentities: {
        create: {
          provider,
          providerSubject,
          username,
          displayName,
        },
      },
    },
  });

  console.log("Owner bootstrap completed");
}

bootstrapOwner()
  .catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : "Owner bootstrap failed");
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
