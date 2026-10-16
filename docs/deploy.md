# Деплой на staging — процесс

Этот файл описывает *как* катить код на staging. Конкретные данные для подключения
(адрес сервера, путь к SSH-ключу) в этот файл специально не входят — они лежат в
`docs/deploy-access.local.md`, который в git не попадает (см. `.gitignore`). Если
этого файла нет (новая машина, первая сессия) — спросить у пользователя адрес и
ключ, не изобретать/не угадывать.

## Общая модель

- Staging — отдельный от продакшена набор Docker-контейнеров на одном Hetzner-сервере
  (`docker-compose.staging.yml`, детали — в `docs/hetzner-staging.md`).
- Деплой = собрать образы `api`/`web` из **текущего рабочего каталога** и перезапустить
  контейнеры. Коммит в git для этого не обязателен — здесь принято катить рабочую
  копию как есть, а коммитить уже готовые, устоявшиеся куски работы отдельно, реже.
- На Windows/Git Bash `rsync` не установлен — вместо него используется `tar` + `scp` +
  `ssh` (распаковка на месте, поверх уже развёрнутого каталога на сервере).
- `.env.staging` и другие секреты на сервере никогда не перезаписываются — они
  исключены из архива ниже, поэтому распаковка их не трогает.
- Применение миграций БД не отдельный шаг — `Dockerfile.api` запускает
  `prisma migrate deploy` в CMD-команде контейнера при каждом старте. Пересборка +
  перезапуск `api` автоматически подтягивает новые миграции.

## Рецепт (копировать как есть, только подставить хост/ключ из `deploy-access.local.md`)

```bash
# 1. Упаковать рабочую копию (список исключений специально соответствует тому,
#    что не должно уезжать на сервер: секреты, зависимости, служебные файлы)
cd /c/Users/testuser/Desktop/platform
tar -czf /tmp/staging-deploy.tar.gz \
  --exclude='.git' --exclude='.git-empty-backup' --exclude='.github' \
  --exclude='node_modules' --exclude='.next' --exclude='dist' \
  --exclude='.env' --exclude='.env.staging' --exclude='.env.*.local' \
  --exclude='.storage' --exclude='releases' --exclude='backups' \
  --exclude='*.log' --exclude='tsconfig.tsbuildinfo' \
  --exclude='.claude' --exclude='.cursor' --exclude='.agents' \
  --exclude='test-results' --exclude='playwright-report' --exclude='e2e/.auth' \
  --exclude='*.tar.gz' --exclude='image*.png' --exclude='image*.jpg' --exclude='Untitled' \
  .

# 2. Залить и распаковать на сервере (KEY и HOST — из deploy-access.local.md)
scp -i ~/.ssh/$KEY -o ConnectTimeout=15 /tmp/staging-deploy.tar.gz $HOST:/tmp/staging-deploy.tar.gz
ssh -i ~/.ssh/$KEY -o ConnectTimeout=15 $HOST \
  "cd $REMOTE_DIR && tar -xzf /tmp/staging-deploy.tar.gz && rm /tmp/staging-deploy.tar.gz"

# 3. Если правка меняет схему БД (новая миграция) — бэкап ПЕРЕД пересборкой
ssh -i ~/.ssh/$KEY -o ConnectTimeout=15 $HOST \
  "cd $REMOTE_DIR && docker compose --env-file .env.staging -f docker-compose.staging.yml exec -T db \
   pg_dump -U fix_app_staging fix_platform_staging > /tmp/staging-backup-\$(date +%Y%m%d-%H%M%S).sql"

# 4. Пересобрать и перезапустить api+web (миграции применятся автоматически при старте api)
ssh -i ~/.ssh/$KEY -o ConnectTimeout=15 $HOST \
  "cd $REMOTE_DIR && docker compose --env-file .env.staging -f docker-compose.staging.yml up -d --build api web"
```

Тайпчек (`npx tsc --noEmit -p .`) и по возможности `npx eslint <изменённые файлы>` —
**до** упаковки архива, не после.

## Проверка после деплоя

```bash
# Статус миграций — должно быть "Database schema is up to date!"
ssh -i ~/.ssh/$KEY $HOST "cd $REMOTE_DIR && docker compose --env-file .env.staging -f docker-compose.staging.yml exec -T api npx prisma migrate status"

# Последние логи api — смотреть на ошибки при старте
ssh -i ~/.ssh/$KEY $HOST "cd $REMOTE_DIR && docker compose --env-file .env.staging -f docker-compose.staging.yml logs api --tail 20"
```

Дальше — живая проверка в браузере (см. ниже), а не только "деплой прошёл без ошибок".

## Живая проверка через браузер (claude-in-chrome)

Не ограничиваться статическими скриншотами от пользователя — открывать staging
самому и проверять руками. Порядок действий:

1. Загрузить инструменты одним вызовом ToolSearch:
   `select:mcp__claude-in-chrome__tabs_context_mcp,mcp__claude-in-chrome__navigate,mcp__claude-in-chrome__computer,mcp__claude-in-chrome__read_page,mcp__claude-in-chrome__tabs_create_mcp,mcp__claude-in-chrome__tabs_close_mcp,mcp__claude-in-chrome__javascript_tool`
2. Заходить на `https://fix-trading.info`. Порты `:8082` и `:8443` с 2026-10-16 слушают
   только `127.0.0.1` (правило общего хоста: наружу только 80/443 через Caddy) — снаружи их
   больше нет, с сервера они доступны как раньше.
3. Для точечной проверки (например, "точно ли элемент по центру", "точно ли API
   отдаёт нужный порядок") использовать `javascript_tool` и читать
   `getBoundingClientRect()`/сам ответ API напрямую, а не только визуально
   сравнивать скриншоты — так находятся вещи вроде "текст обрезается ровно после
   разделителя" или "порядок в JSON уже правильный, скриншот просто старый".
4. Закрывать за собой вкладки, которые сам открыл (`tabs_close_mcp`).

### Вход как тестовый пользователь

- На staging есть dev-login (`/api/auth/dev-login`), но он **включается только на
  хосте, начинающемся с `staging.`** (или `localhost`/`127.0.0.1`) — на голом IP
  форма входа его не показывает. Заходить через TLS-домен, не через IP.
- Кнопки на `/auth` — "Войти как куратор" / "Войти как ученик". **Ролью OWNER
  залогиниться через dev-login нельзя вообще** — `parseRole` на бэкенде явно
  разрешает только STUDENT/CURATOR. Это осознанное ограничение (см.
  `api/src/auth/auth.controller.ts` и комментарий про "один-единственный ручной
  апгрейд" в `auth-service.ts#setUserRole`).
  Если нужно проверить что-то видимое только Овнеру — либо попросить пользователя
  проверить самому под реальным аккаунтом, либо явно спросить разрешения на
  временную ручную правку роли в БД (и вернуть обратно после проверки) — не делать
  это самовольно.
- Переключатель "Ученик"/"Куратор" внизу меню (РЕЖИМ ПРОСМОТРА) иногда разлогинивал
  до `/auth` вместо переключения контекста в этой же сессии — если это произошло,
  просто заново нажать нужную кнопку входа на `/auth`, не пытаться чинить сам
  переключатель.

## Известные мелочи, которые не являются багом

- При архивации `tar` может ругаться `timestamp ... is in the future` — это
  рассинхрон часов локальной машины и сервера на десятки секунд, безвредно,
  архив собирается нормально.
- SSH/SCP-команды к серверу иногда блокируются классификатором Claude Code как
  потенциально рискованные (credential exploration/production deploy) — это
  штатное поведение самой площадки, не ошибка сервера. При блокировке — не
  обходить её, а либо перефразировать команду (например, без лишнего pipe), либо
  прямо спросить пользователя, разрешает ли он это действие.
