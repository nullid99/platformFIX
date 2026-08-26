# Staging на Hetzner

## Изолированный Docker-пакет

Для этого проекта подготовлен отдельный `docker-compose.staging.yml`. Он не изменяет
локальный `docker-compose.yml` и использует свои контейнеры, сеть и тома:

- `fix-platform-staging-web` — Next.js, единственный внешний порт `8082`;
- `fix-platform-staging-api` — NestJS API, доступен только внутри сети Compose;
- `fix-platform-staging-db` — отдельная PostgreSQL 16;
- `fix-platform-staging-db` и `fix-platform-staging-storage` — отдельные Docker volumes.

Dockerfile веба и API запускают сборку из текущего репозитория. Перед запуском на сервере
нужно создать `.env.staging` из `.env.staging.example` и заменить все placeholder-секреты.
Файл `.env.staging` не копируется в Git.

Команды деплоя выполняются только из каталога нового проекта (например,
`/opt/projectfix-education-staging`):

```bash
cp .env.staging.example .env.staging
# отредактировать .env.staging и добавить отдельные секреты
docker compose --env-file .env.staging -f docker-compose.staging.yml up -d --build
docker compose --env-file .env.staging -f docker-compose.staging.yml ps
curl http://127.0.0.1:8082
```

Нельзя выполнять эти команды из `/opt/projectfix-education`, `/opt/projectfix-bot`,
`/root` или `/`. Удалённый сервер и firewall в рамках подготовки не изменяются.

## База данных

Для staging создаётся отдельная PostgreSQL-база и отдельный файл `.env`. Схема переносится миграциями:

```powershell
npx prisma migrate deploy
npx prisma generate
npx prisma migrate status
```

`prisma migrate dev` используется только локально. Перед переносом существующих тестовых данных создаётся `pg_dump`, затем дамп восстанавливается в staging. Cookies, session-токены, секреты и локальная папка `.storage` отдельно не копируются.

В production перед миграцией выполняется резервная копия базы. После миграции проверяются количество пользователей, зачислений, заданий, отправок и состояние миграций.

## IP и устройство

`User`, `Session` и `LoginEvent` уже хранят:

- IP-адрес и его хеш;
- User-Agent браузера;
- название устройства, если оно передано клиентом;
- город/страну, если сервер обогащает адрес геоданными;
- время первого и последнего входа;
- статус сессии и причину отзыва.

Физическое устройство определить нельзя. В интерфейсе показывается технический профиль: ОС/браузер из User-Agent, IP, время и история входов. IP — сигнал риска, а не доказательство передачи аккаунта.

За reverse proxy приложение должно доверять только известному числу прокси. Локально используется `TRUST_PROXY_HOPS=0`; если перед API стоит один Caddy/Nginx, на Hetzner используется `TRUST_PROXY_HOPS=1`. API берёт адрес из `request.ip`, рассчитанного Express, и не доверяет пользовательскому `x-forwarded-for` напрямую.

## Перед командным тестированием

1. Подключить домен и HTTPS.
2. Создать отдельные staging PostgreSQL и Redis.
3. Настроить `.env` на сервере, не помещая его в Git.
4. Перенести приватные файлы в Hetzner Object Storage.
5. Обновить callback URL Discord.
6. Создать резервное копирование базы и проверить восстановление.
7. Создать тестовые приглашения для участников команды.
The public `8082` mapping belongs to the isolated Nginx proxy, not the web
container. Keep the API and web containers unexposed on the Compose network.
After deploying the proxy, create a fresh test login from an external network
and inspect the student's security details: it should contain the public IP
and best-effort country/city. A private, loopback, VPN or anonymized address
may legitimately have no GeoIP result.
