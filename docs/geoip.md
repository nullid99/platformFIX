# IP и GeoIP

Новые входы сохраняют IP из доверенного серверного request context. Локальные и приватные адреса (`::1`,
`127.0.0.1`, Docker-сети и RFC1918) не отправляются во внешний GeoIP-провайдер.

После фиксации публичного IP приложение выполняет best-effort запрос к `GEOIP_LOOKUP_URL` (по умолчанию
`https://ipwho.is/{ip}`), сохраняет только код страны и город и кэширует результат в памяти на 24 часа.
Недоступность провайдера не блокирует авторизацию. Провайдер можно отключить через `GEOIP_ENABLED=false` или
заменить URL перед коммерческим запуском после проверки его условий и требований к передаче IP третьей стороне.

Старые записи с `::1` не переписываются. Для проверки нужно создать новый вход через публичный адрес Hetzner.
## Staging proxy

On Hetzner, port `8082` is exposed only by the project's Nginx container. The
proxy overwrites `X-Forwarded-For` with its actual peer address before sending
the request to the API; the API trusts exactly one proxy hop. This prevents a
client from spoofing the recorded IP while preserving the public address for
new login/session records. Old loopback (`::1`) or Docker-network records are
not recoverable and are intentionally not backfilled.
