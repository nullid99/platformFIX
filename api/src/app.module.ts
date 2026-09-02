import { Module } from "@nestjs/common";
import { AuthController } from "./auth/auth.controller";
import { DiscordController } from "./auth/discord.controller";
import { SecurityController } from "./security/security.controller";
import { AssignmentsController, ReviewController } from "./assignments/assignments.controller";
import { CourseController } from "./course/course.controller";
import { FilesController } from "./files/files.controller";
import { DiscussionsController } from "./discussions/discussions.controller";
import { ScheduleController } from "./schedule/schedule.controller";
import { ScheduleReminderNotifier } from "./schedule/schedule-reminder-notifier";
import { StreamsController } from "./streams/streams.controller";
import { StreamsGateway } from "./streams/streams.gateway";
import { StreamLiveNotifier } from "./streams/stream-live-notifier";
import { NotificationsController } from "./notifications/notifications.controller";

@Module({
  controllers: [AuthController, DiscordController, SecurityController, AssignmentsController, ReviewController, CourseController, FilesController, DiscussionsController, ScheduleController, StreamsController, NotificationsController],
  providers: [StreamsGateway, StreamLiveNotifier, ScheduleReminderNotifier],
})
export class AppModule {}
