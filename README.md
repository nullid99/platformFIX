# Trading Education Platform

Учебная платформа для практикумов: курсы, группы, задания, проверка ДЗ, записи конференций, личный прогресс и интеграция с Discord.

## Стартовая архитектура

- **Язык:** TypeScript с включённым strict mode.
- **Frontend:** Next.js App Router.
- **Backend:** NestJS REST API.
- **Database:** PostgreSQL.
- **Очереди и кэш:** Redis + BullMQ.
- **Файлы:** S3-compatible storage, предпочтительно Hetzner Object Storage.
- **Видео на первом этапе:** Vimeo с приватным embed.
- **Деплой:** Docker Compose на Hetzner, reverse proxy и TLS через Caddy.
- **Тесты:** Vitest для unit/integration и Playwright для E2E.

## Команды после создания приложений

```text
install       установить зависимости
dev           запустить web, api и worker
lint          проверить ESLint
typecheck     проверить TypeScript
test          запустить unit и integration тесты
test:e2e      запустить браузерные сценарии
build         собрать production-образы
```

Подробные решения находятся в [`docs/architecture.md`](docs/architecture.md), правила разработки — в [`docs/development.md`](docs/development.md).
