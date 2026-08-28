import "dotenv/config";
import { AssignmentStatus, ModuleAccessStatus, UserRole, UserStatus } from "@/app/generated/prisma/enums";
import { prisma } from "@/app/server/db";

const courseOutline = [
  { position: 0, section: "Welcome", title: "Welcome", description: "Познакомься с форматом практикума и подготовь рабочее пространство.", coverPath: "/welcome-cover.png", unlocked: true, progress: 100 },
  { position: 1, section: "Education", title: "Market Logic", description: "Разбираем логику движения рынка, контекст и последовательность наблюдений.", coverPath: "/market-logic-cover.png", unlocked: true, progress: 56, stream: { providerKey: "1197792122", title: "Практика с куратором", durationSec: 4876 } },
  { position: 2, section: "Education", title: "Eq Point & Narrative. Storyline & Reversal", description: "Учимся собирать рыночный нарратив и замечать момент смены сценария.", coverPath: "/eq-point-narrative-cover.png", unlocked: false, progress: 0 },
  { position: 3, section: "Education", title: "Delivery A.B. Part 1&2", description: "Последовательно разбираем delivery и читаем движение цены по этапам.", coverPath: "/delivery-ab-part-12-cover.png", unlocked: false, progress: 0 },
  { position: 4, section: "Education", title: "Delivery A.B. Part 3", description: "Закрепляем модель delivery на истории и готовим переход к практике.", coverPath: "/delivery-ab-part-3-cover.png", unlocked: false, progress: 0 },
  { position: 5, section: "Education", title: "Entry Models. Q/A Session", description: "Собираем варианты входа и разбираем вопросы, возникающие во время практики.", coverPath: "/entry-models-qa-cover.png", unlocked: false, progress: 0 },
  { position: 6, section: "Q&A", title: "Ответы на вопросы", description: "Ответы куратора на вопросы по урокам и торговой системе.", coverPath: "/qa-cover.png", unlocked: true, progress: 0 },
  { position: 7, section: "Practice", title: "Pre session", description: "Подготовь наблюдения и рабочий план перед практической сессией.", coverPath: "/pre-session-cover.jpg", unlocked: true, progress: 0 },
  { position: 8, section: "Practice", title: "Backtest", description: "Проверяем торговую систему на истории и фиксируем повторяющиеся сценарии.", coverPath: "/backtest-performance.png", unlocked: false, progress: 0 },
  { position: 9, section: "Practice", title: "Weekly performance review", description: "Подводим итоги недели, смотрим на решения и формируем следующий фокус практики.", coverPath: "/backtest-performance.png", unlocked: false, progress: 0 },
] as const;

async function main(): Promise<void> {
  const existingPracticum = await prisma.practicum.findFirst({ orderBy: { createdAt: "asc" } });
  const practicum = existingPracticum ?? await prisma.practicum.create({ data: { title: "Practicum 04", description: "Учебный поток практикума." } });

  for (const moduleData of courseOutline) {
    const courseModule = await prisma.module.upsert({
      where: { practicumId_position: { practicumId: practicum.id, position: moduleData.position } },
      update: { title: moduleData.title, description: moduleData.description, section: moduleData.section, coverPath: moduleData.coverPath },
      create: { practicumId: practicum.id, position: moduleData.position, title: moduleData.title, description: moduleData.description, section: moduleData.section, coverPath: moduleData.coverPath },
    });

    if ("stream" in moduleData) {
      const stream = moduleData.stream;
      await prisma.mediaAsset.upsert({
        where: { provider_providerKey_moduleId: { provider: "VIMEO", providerKey: stream.providerKey, moduleId: courseModule.id } },
        update: { practicumId: practicum.id, moduleId: courseModule.id, title: stream.title, durationSec: stream.durationSec, kind: "STREAM", status: "PUBLISHED", position: 0, publishedAt: new Date() },
        create: { practicumId: practicum.id, moduleId: courseModule.id, provider: "VIMEO", providerKey: stream.providerKey, title: stream.title, durationSec: stream.durationSec, kind: "STREAM", status: "PUBLISHED", position: 0, publishedAt: new Date() },
      });
    }
  }

  const activeStudents = await prisma.user.findMany({ where: { role: UserRole.STUDENT, status: UserStatus.ACTIVE }, select: { id: true } });
  const modules = await prisma.module.findMany({ where: { practicumId: practicum.id }, orderBy: { position: "asc" }, select: { id: true, position: true } });

  for (const student of activeStudents) {
    const enrollment = await prisma.enrollment.upsert({
      where: { studentId_practicumId: { studentId: student.id, practicumId: practicum.id } },
      update: { status: "ACTIVE" },
      create: { studentId: student.id, practicumId: practicum.id, status: "ACTIVE" },
    });

    for (const moduleData of courseOutline) {
      const dbModule = modules.find((item) => item.position === moduleData.position);
      if (!dbModule) continue;
      const status = moduleData.unlocked ? (moduleData.progress === 100 ? ModuleAccessStatus.COMPLETED : ModuleAccessStatus.UNLOCKED) : ModuleAccessStatus.LOCKED;
      const existingAccess = await prisma.enrollmentModuleAccess.findUnique({ where: { enrollmentId_moduleId: { enrollmentId: enrollment.id, moduleId: dbModule.id } }, select: { id: true } });
      if (!existingAccess) {
        await prisma.enrollmentModuleAccess.create({
          data: { enrollmentId: enrollment.id, moduleId: dbModule.id, status, progress: moduleData.progress, unlockedAt: moduleData.unlocked ? new Date() : null, completedAt: status === ModuleAccessStatus.COMPLETED ? new Date() : null },
        });
      }
    }
  }

  const publishedAssignments = await prisma.assignment.count({ where: { status: AssignmentStatus.PUBLISHED, module: { practicumId: practicum.id } } });
  console.log(`Course bootstrap complete: ${courseOutline.length} modules, ${activeStudents.length} students, ${publishedAssignments} published assignments.`);
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
}).finally(async () => {
  await prisma.$disconnect();
});
