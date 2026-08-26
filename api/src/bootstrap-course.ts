import "dotenv/config";
import { AssignmentStatus, LessonType, ModuleAccessStatus, UserRole, UserStatus } from "@/app/generated/prisma/enums";
import { prisma } from "@/app/server/db";

const courseOutline = [
  { position: 0, section: "Welcome", title: "Welcome", description: "Познакомься с форматом практикума и подготовь рабочее пространство.", coverPath: "/welcome-cover.png", unlocked: true, progress: 100, lessons: [{ title: "Знакомство", type: LessonType.VIDEO, description: "Вводный материал и правила работы в практикуме." }] },
  { position: 1, section: "Education", title: "Market Logic", description: "Разбираем логику движения рынка, контекст и последовательность наблюдений.", coverPath: "/market-logic-cover.png", unlocked: true, progress: 56, lessons: [{ title: "Market Logic: базовые принципы", type: LessonType.VIDEO, description: "Основные принципы чтения движения цены." }, { title: "Практика с куратором", type: LessonType.STREAM, description: "Запись практической части с разбором сценариев." }, { title: "Закрепить материал", type: LessonType.ASSIGNMENT, description: "Практическое задание по материалам урока." }, { title: "Q&A по Market Logic", type: LessonType.QA, description: "Ответы на вопросы по блоку." }] },
  { position: 2, section: "Education", title: "Eq Point & Narrative. Storyline & Reversal", description: "Учимся собирать рыночный нарратив и замечать момент смены сценария.", coverPath: "/eq-point-narrative-cover.png", unlocked: false, progress: 0, lessons: [{ title: "Eq Point и narrative", type: LessonType.VIDEO, description: "Ключевые точки и контекст движения." }, { title: "Storyline и reversal", type: LessonType.STREAM, description: "Разбор сценариев на истории." }] },
  { position: 3, section: "Education", title: "Delivery A.B. Part 1&2", description: "Последовательно разбираем delivery и читаем движение цены по этапам.", coverPath: "/delivery-ab-part-12-cover.png", unlocked: false, progress: 0, lessons: [{ title: "Delivery A.B. Part 1", type: LessonType.VIDEO, description: "Первая часть блока delivery." }, { title: "Delivery A.B. Part 2", type: LessonType.VIDEO, description: "Вторая часть блока delivery." }] },
  { position: 4, section: "Education", title: "Delivery A.B. Part 3", description: "Закрепляем модель delivery на истории и готовим переход к практике.", coverPath: "/delivery-ab-part-3-cover.png", unlocked: false, progress: 0, lessons: [{ title: "Delivery A.B. Part 3", type: LessonType.VIDEO, description: "Финальная часть блока delivery." }] },
  { position: 5, section: "Education", title: "Entry Models. Q/A Session", description: "Собираем варианты входа и разбираем вопросы, возникающие во время практики.", coverPath: "/entry-models-qa-cover.png", unlocked: false, progress: 0, lessons: [{ title: "Entry Models", type: LessonType.VIDEO, description: "Модели входа и условия их применения." }, { title: "Q&A Session", type: LessonType.STREAM, description: "Ответы на вопросы участников." }] },
  { position: 6, section: "Q&A", title: "Ответы на вопросы", description: "Ответы куратора на вопросы по урокам и торговой системе.", coverPath: "/qa-cover.png", unlocked: true, progress: 0, lessons: [{ title: "Ответы на вопросы", type: LessonType.QA, description: "Собранные ответы и дополнительные пояснения." }] },
  { position: 7, section: "Practice", title: "Pre session", description: "Подготовь наблюдения и рабочий план перед практической сессией.", coverPath: "/pre-session-cover.jpg", unlocked: true, progress: 0, lessons: [{ title: "Pre session", type: LessonType.ASSIGNMENT, description: "Подготовительная работа перед практикой." }] },
  { position: 8, section: "Practice", title: "Backtest", description: "Проверяем торговую систему на истории и фиксируем повторяющиеся сценарии.", coverPath: "/backtest-performance.png", unlocked: false, progress: 0, lessons: [{ title: "Backtest: что, как, зачем?", type: LessonType.VIDEO, description: "Как проводить backtest и читать результат." }] },
  { position: 9, section: "Practice", title: "Weekly performance review", description: "Подводим итоги недели, смотрим на решения и формируем следующий фокус практики.", coverPath: "/backtest-performance.png", unlocked: false, progress: 0, lessons: [{ title: "Weekly performance review", type: LessonType.ASSIGNMENT, description: "Итоги недели и план следующего цикла." }] },
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

    for (const [index, lessonData] of moduleData.lessons.entries()) {
      const lesson = await prisma.lesson.upsert({
        where: { moduleId_position: { moduleId: courseModule.id, position: index + 1 } },
        update: { title: lessonData.title, type: lessonData.type, description: lessonData.description },
        create: { moduleId: courseModule.id, position: index + 1, title: lessonData.title, type: lessonData.type, description: lessonData.description },
      });

      if (moduleData.position === 1 && index === 1) {
        await prisma.mediaAsset.upsert({
          where: { provider_providerKey_lessonId: { provider: "VIMEO", providerKey: "1197792122", lessonId: lesson.id } },
          update: { practicumId: practicum.id, lessonId: lesson.id, title: "Практика с куратором", durationSec: 4876, kind: "STREAM", status: "PUBLISHED", position: 0, publishedAt: new Date() },
          create: { practicumId: practicum.id, lessonId: lesson.id, provider: "VIMEO", providerKey: "1197792122", title: "Практика с куратором", durationSec: 4876, kind: "STREAM", status: "PUBLISHED", position: 0, publishedAt: new Date() },
        });
      }
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

  const publishedAssignments = await prisma.assignment.count({ where: { status: AssignmentStatus.PUBLISHED, lesson: { module: { practicumId: practicum.id } } } });
  console.log(`Course bootstrap complete: ${courseOutline.length} modules, ${activeStudents.length} students, ${publishedAssignments} published assignments.`);
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
}).finally(async () => {
  await prisma.$disconnect();
});
